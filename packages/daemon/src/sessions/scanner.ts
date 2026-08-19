/**
 * Filesystem-derived catalog of every OMP session file ever written on this
 * machine, complete where ACP's `session/list` caps at 50.
 *
 * Deliberately cheap per file: the session id and creation time come from the
 * filename alone (no I/O), the title comes from the first line of the JSONL
 * (a bounded, small read regardless of how large the file has grown since),
 * and byte size/mtime come from a single `stat`. Only the message count needs
 * a full read of the file; see `countMessages` and its cache in
 * `session-index.ts`, which is the expensive operation this module otherwise
 * avoids entirely.
 *
 * Nothing here ever materialises a whole file: counting streams in
 * fixed-size chunks (`countMessagesChunks`) and the scan yields per file
 * (`scanSessionFilesIter`), so a cooperative caller can keep the event loop
 * served while both run.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

/** `<ISO-with-dashes-for-colons>_<uuid>.jsonl`, e.g. `2026-08-11T01-11-48-090Z_019fee60-2c7a-7000-9fd5-7439c7bf3dd2.jsonl`. */
const SESSION_FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-f-]{36})\.jsonl$/;

export interface RawSessionFile {
  id: string;
  path: string;
  flattenedDir: string;
  /** ISO timestamp, reconstructed from the filename. */
  createdAt: string;
  title: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * Above this, `countMessages` is not called at all and a session reports a
 * null message count instead. Cost is linear in bytes: this machine's real
 * session tree measured roughly 0.78MB/ms on a warm page cache (a 29.8MB
 * file cost 38.4ms; 151.7MB total cost 245.8ms across 308 files). 50MB is
 * comfortably above every real file observed here while capping any single
 * pathological transcript's contribution to a build at roughly 65ms even at
 * that rate -- and a cold read from a slower disk could still be several
 * times that. Nothing prevents a transcript from reaching hundreds of
 * megabytes, and a background index build stalling on one such file is
 * indistinguishable, to an operator, from the session list being broken; an
 * honest null in one row is the same trade this package already makes for a
 * cwd it cannot decode with confidence.
 */
export const MESSAGE_COUNT_SIZE_CEILING_BYTES = 50 * 1024 * 1024;

/** "2026-08-11T01-11-48-090Z" -> "2026-08-11T01:11:48.090Z". The filename form dashes out `:` and `.` because both are awkward in a path segment on at least one platform this tool supports. */
function isoFromFilenameTimestamp(raw: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(raw);
  if (!match) return raw;
  const [, date, hh, mm, ss, ms] = match;
  return `${date}T${hh}:${mm}:${ss}.${ms}Z`;
}

/**
 * Read only the first line of a file, bounded to `maxBytes` regardless of the
 * file's total size. A session file can grow past ten megabytes; loading the
 * whole thing to read a title that lives in its first 200 bytes is exactly
 * the I/O this scanner exists to avoid.
 */
function readFirstLine(path: string, maxBytes = 65_536): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const chunkSize = 4096;
    const chunk = Buffer.alloc(chunkSize);
    const collected: Buffer[] = [];
    let collectedLength = 0;
    let position = 0;
    while (collectedLength < maxBytes) {
      const bytesRead = readSync(fd, chunk, 0, chunkSize, position);
      if (bytesRead === 0) break;
      const newlineIdx = chunk.subarray(0, bytesRead).indexOf(0x0a);
      if (newlineIdx !== -1) {
        collected.push(chunk.subarray(0, newlineIdx));
        return Buffer.concat(collected).toString("utf8");
      }
      collected.push(Buffer.from(chunk.subarray(0, bytesRead)));
      collectedLength += bytesRead;
      position += bytesRead;
    }
    return collectedLength > 0 ? Buffer.concat(collected).toString("utf8") : null;
  } finally {
    closeSync(fd);
  }
}

/** The header line's `title`, or "" for a malformed, absent, or genuinely empty header. Never throws: a scan of 305 files cannot fail wholesale because one has a corrupt first line. */
function extractTitle(firstLine: string | null): string {
  if (!firstLine) return "";
  try {
    const parsed = JSON.parse(firstLine) as { title?: unknown };
    if (typeof parsed.title === "string") return parsed.title;
  } catch {
    // Malformed header; an empty title is the honest answer, not a thrown scan.
  }
  return "";
}

/**
 * Every session file across every cwd-group directory under `sessionsRoot`,
 * one `yield` per file, so a cooperative caller can service the event loop
 * between files -- an operator's real tree is ~1900 files, and each file
 * costs a `stat` plus a title read even before any counting. A missing or
 * unreadable root, or a group directory that vanishes mid-scan, degrades
 * that entry to "no sessions" rather than failing the whole scan -- the
 * filesystem can change under a background index build at any time.
 */
export function* scanSessionFilesIter(sessionsRoot: string | undefined = getSessionsDir()): Generator<RawSessionFile> {
  let groupDirs: string[];
  try {
    groupDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return;
  }

  for (const flattenedDir of groupDirs) {
    const groupPath = join(sessionsRoot, flattenedDir);
    let fileNames: string[];
    try {
      fileNames = readdirSync(groupPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(entry => entry.name);
    } catch {
      continue;
    }

    for (const fileName of fileNames) {
      const match = SESSION_FILE_RE.exec(fileName);
      if (!match) continue; // Not this naming scheme; skip rather than guess at an id.
      const [, tsRaw, id] = match;
      if (!tsRaw || !id) continue;
      const filePath = join(groupPath, fileName);
      let mtimeMs: number;
      let sizeBytes: number;
      try {
        const stat = statSync(filePath);
        mtimeMs = stat.mtimeMs;
        sizeBytes = stat.size;
      } catch {
        continue; // Vanished between readdir and stat.
      }
      yield {
        id,
        path: filePath,
        flattenedDir,
        createdAt: isoFromFilenameTimestamp(tsRaw),
        title: extractTitle(readFirstLine(filePath)),
        mtimeMs,
        sizeBytes,
      };
    }
  }
}

/** The whole scan in one array; `SessionIndex` streams the iterator instead so it can yield. */
export function scanSessionFiles(sessionsRoot?: string): RawSessionFile[] {
  return [...scanSessionFilesIter(sessionsRoot)];
}

/**
 * Read buffer size for streamed counting. Measured here on a 97.6MB fixture
 * of realistic message lines: 16KiB chunks counted 0.64MB/ms, 64KiB 0.75,
 * 256KiB 0.77, 1MiB 0.78 -- a whole-file readFileSync+split manages 1.63
 * only by holding the entire decoded text and every line at once, which is
 * exactly what this module must not do. 64KiB sits within 5% of the plateau
 * while keeping the fixed buffer small enough to stay cache-resident.
 */
export const COUNT_CHUNK_BYTES = 64 * 1024;

/**
 * Whether one complete line counts as a conversation turn: `type:
 * "message"` whose `message.role` is "user" or "assistant". Tool results,
 * thinking deltas, and bookkeeping events (`model_change`, `title_change`,
 * `custom`, `credential_pin`, ...) are excluded so the count reflects turns
 * a person would recognize as the conversation, not every JSONL line the
 * session ever wrote.
 */
function countsAsTurn(text: string): boolean {
  if (text === "") return false; // Empty line, the old split-and-skip rule.
  let parsed: { type?: unknown; message?: { role?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return false; // Malformed line: skipped, never fatal.
  }
  if (parsed.type === "message") {
    const role = parsed.message?.role;
    return role === "user" || role === "assistant";
  }
  return false;
}

/**
 * The counting core: `type: "message"` turns in a session file, streamed in
 * `COUNT_CHUNK_BYTES` reads. Each `next()` processes one chunk and yields,
 * so a cooperative driver can hand the event loop to HTTP routes, websocket
 * pings, and relay acks between chunks without the count ever blocking them;
 * the drained (never-awaited) form is plain `countMessages`. Returns the
 * count via the generator's return value.
 *
 * The whole file is still read -- unavoidable, since messages are
 * interleaved with tool calls and thinking blocks throughout, not confined
 * to a prefix -- but never materialised: one fixed chunk buffer, one line at
 * a time, and a carry list holding only the bytes of the single line still
 * unterminated at a chunk boundary. Splitting at 0x0a bytes and decoding
 * each line separately is byte-for-byte equivalent to decoding the whole
 * file and splitting the text on "\n": 0x0a never appears inside a UTF-8
 * multi-byte sequence, so the split points are identical, and a line's bytes
 * decode to the same string in isolation as they do in place.
 *
 * Measured on this machine's real session tree (308 files, 151.7MB total,
 * largest single file 29.8MB): `scanSessionFiles` alone (metadata plus a
 * bounded title read) took 78ms cold; a full cold counting pass over every
 * file added 245.8ms on top of that (38.4ms of it the 29.8MB file alone).
 * See `SessionIndex`'s mtime+size cache in `@ompd/core`'s
 * `session_scan_cache` table, which makes every build after the first one a
 * cache hit for message counts instead of a re-read.
 */
export function* countMessagesChunks(fd: number): Generator<void, number> {
  const chunk = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
  // Bytes of the line still unterminated at the end of the last chunk. A
  // list, not one Buffer: a pathological single line spanning many chunks
  // must concatenate once at its newline, not copy its whole prefix every
  // chunk.
  let carry: Buffer[] = [];
  let count = 0;
  let position = 0;
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, chunk, 0, COUNT_CHUNK_BYTES, position);
    } catch {
      return 0; // Unreadable mid-read: the same zero the whole-file read used to give.
    }
    if (bytesRead === 0) break;
    position += bytesRead;

    let lineStart = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (chunk[i] !== 0x0a) continue;
      const text =
        carry.length > 0
          ? Buffer.concat([...carry, chunk.subarray(lineStart, i)]).toString("utf8")
          : chunk.toString("utf8", lineStart, i);
      carry = [];
      if (countsAsTurn(text)) count++;
      lineStart = i + 1;
    }
    if (lineStart < bytesRead) {
      carry.push(Buffer.from(chunk.subarray(lineStart, bytesRead)));
    }
    yield; // One chunk per cooperative step.
  }
  // The trailing line after the last newline, if any: the old whole-file
  // split counted it too, so it is counted here as well.
  if (carry.length > 0 && countsAsTurn(Buffer.concat(carry).toString("utf8"))) count++;
  return count;
}

/**
 * Count conversation turns in a session file in one synchronous call, for
 * callers that cannot yield (see `SessionIndex`'s warm pass for the
 * cooperative form). Streams in chunks exactly like the async path -- the
 * only difference is that this drains the generator without ever letting the
 * event loop run. A file that cannot be opened or read counts 0, never
 * throws: one corrupt file must not fail a scan of thousands.
 */
export function countMessages(path: string): number {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return 0;
  }
  try {
    const steps = countMessagesChunks(fd);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
  } finally {
    closeSync(fd);
  }
}
