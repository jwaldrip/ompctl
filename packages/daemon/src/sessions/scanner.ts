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

import { closeSync, openSync, readdirSync, readSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
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
  /** Exact cwd from the session header, or null when the bounded header is absent or malformed. */
  cwd: string | null;
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

interface SessionHeader {
  title: string;
  cwd: string | null;
}

/**
 * Read the bounded JSONL header. OMP records the display title first and the
 * exact cwd in the following `session` row, so the index never needs to
 * reverse the intentionally lossy flattened directory name by walking disk.
 */
async function readSessionHeader(path: string, maxBytes = 65_536): Promise<SessionHeader> {
  const header: SessionHeader = { title: "", cwd: null };
  try {
    const text = await Bun.file(path).slice(0, maxBytes).text();
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; title?: unknown; cwd?: unknown };
        if (header.title.length === 0 && typeof record.title === "string") header.title = record.title;
        if (record.type === "session" && typeof record.cwd === "string") header.cwd = record.cwd;
        if (header.title.length > 0 && header.cwd !== null) break;
      } catch {
        // A malformed row proves nothing about the other bounded header rows.
      }
    }
  } catch {
    // One unreadable transcript cannot fail the whole catalog.
  }
  return header;
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
export async function* scanSessionFilesIter(
  sessionsRoot: string | undefined = getSessionsDir(),
): AsyncGenerator<RawSessionFile> {
  let groupDirs: string[];
  try {
    groupDirs = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return;
  }

  for (const flattenedDir of groupDirs) {
    const groupPath = join(sessionsRoot, flattenedDir);
    let fileNames: string[];
    try {
      fileNames = (await readdir(groupPath, { withFileTypes: true }))
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
        const fileStat = await stat(filePath);
        mtimeMs = fileStat.mtimeMs;
        sizeBytes = fileStat.size;
      } catch {
        continue; // Vanished between readdir and stat.
      }
      const header = await readSessionHeader(filePath);
      yield {
        id,
        path: filePath,
        flattenedDir,
        createdAt: isoFromFilenameTimestamp(tsRaw),
        title: header.title,
        cwd: header.cwd,
        mtimeMs,
        sizeBytes,
      };
    }
  }
}

/** The whole scan in one array; `SessionIndex` streams the iterator instead so it can yield. */
export async function scanSessionFiles(sessionsRoot?: string): Promise<RawSessionFile[]> {
  const files: RawSessionFile[] = [];
  for await (const file of scanSessionFilesIter(sessionsRoot)) files.push(file);
  return files;
}

/**
 * The path of one session's file, by id, or undefined when this machine holds
 * none.
 *
 * A targeted walk rather than a scan, because resolving one id through the
 * assembled index costs the whole tree: measured on this machine's real
 * sessions (538 files across 181 group directories), a `SessionIndex` build
 * took 2.9s while this walk takes 4 to 6ms, because it opens nothing, stats
 * nothing, reads no titles, and verifies no liveness. A phone tapping a
 * session and waiting three seconds for its transcript is the difference.
 *
 * One `yield` per group directory, matching this module's other cooperative
 * form, so even a tree with thousands of groups stays interruptible. The path
 * is always `sessionsRoot` plus entries this function itself enumerated, and
 * the filename must match the same naming scheme the scan trusts, so an id
 * arriving from a client cannot steer the result outside the configured root.
 */
export function* findSessionFileIter(
  sessionId: string,
  sessionsRoot: string | undefined = getSessionsDir(),
): Generator<void, string | undefined> {
  const suffix = `_${sessionId}.jsonl`;
  let groupDirs: string[];
  try {
    groupDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return undefined; // No root, no sessions: the same degradation the scan makes.
  }
  for (const flattenedDir of groupDirs) {
    let fileNames: string[];
    try {
      fileNames = readdirSync(join(sessionsRoot, flattenedDir), { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name);
    } catch {
      yield; // Vanished mid-walk; still a step's worth of work done.
      continue;
    }
    for (const fileName of fileNames) {
      if (!fileName.endsWith(suffix)) continue;
      if (!SESSION_FILE_RE.test(fileName)) continue; // Not this naming scheme; never a session this daemon serves.
      return join(sessionsRoot, flattenedDir, fileName);
    }
    yield; // One cooperative step per group directory.
  }
  return undefined;
}

/** The lookup in one synchronous call, for callers that cannot yield. */
export function findSessionFile(sessionId: string, sessionsRoot?: string): string | undefined {
  const steps = findSessionFileIter(sessionId, sessionsRoot);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
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
 * One conversation turn, as a session file line carried it: `type:
 * "message"` whose `message.role` is "user" or "assistant". `content` is
 * handed on untouched because the two readers want different things from it
 * -- counting wants only that the turn exists, while the tail reader wants
 * the words -- and flattening it here would make every count pay for text
 * extraction across 150MB of transcripts.
 */
export interface SessionTurnLine {
  role: "user" | "assistant";
  /** Exactly what the line's `message.content` was: a block array, or a bare string for some typed user turns. */
  content: unknown;
  /** The line's own ISO timestamp, or "" when it carried none. */
  at: string;
}

/**
 * The one place a session file line becomes a turn, shared by the counter
 * here and by `readSessionTail`.
 *
 * Tool results, thinking deltas, and bookkeeping events (`model_change`,
 * `title_change`, `custom`, `credential_pin`, ...) are not turns, so the
 * count reflects the conversation a person would recognize rather than every
 * JSONL line the session ever wrote -- and, for the same reason, the tail
 * never renders a tool result as if the operator or the agent had said it.
 * A second parser beside this one is how the two would drift into disagreeing
 * about what a message is.
 */
export function parseTurnLine(text: string): SessionTurnLine | null {
  if (text === "") return null; // Empty line, the old split-and-skip rule.
  let parsed: { type?: unknown; timestamp?: unknown; message?: { role?: unknown; content?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // Malformed line: skipped, never fatal.
  }
  if (parsed.type !== "message") return null;
  const role = parsed.message?.role;
  if (role !== "user" && role !== "assistant") return null;
  return {
    role,
    content: parsed.message?.content,
    at: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
  };
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
class TurnCounter {
  #carry: Buffer[] = [];
  #count = 0;

  push(chunk: Uint8Array): void {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let lineStart = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] !== 0x0a) continue;
      const text =
        this.#carry.length > 0
          ? Buffer.concat([...this.#carry, bytes.subarray(lineStart, i)]).toString("utf8")
          : bytes.toString("utf8", lineStart, i);
      this.#carry = [];
      if (parseTurnLine(text) !== null) this.#count++;
      lineStart = i + 1;
    }
    if (lineStart < bytes.length) {
      this.#carry.push(Buffer.from(bytes.subarray(lineStart)));
    }
  }

  finish(): number {
    if (this.#carry.length > 0 && parseTurnLine(Buffer.concat(this.#carry).toString("utf8")) !== null) {
      this.#count++;
    }
    return this.#count;
  }
}

export function* countMessagesChunks(fd: number): Generator<void, number> {
  const chunk = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
  const counter = new TurnCounter();
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
    counter.push(chunk.subarray(0, bytesRead));
    yield; // One chunk per cooperative step.
  }
  return counter.finish();
}

/** Count turns without opening or reading the transcript on the daemon's event-loop thread. */
export async function countMessagesAsync(path: string): Promise<number> {
  try {
    const counter = new TurnCounter();
    for await (const chunk of Bun.file(path).stream()) counter.push(chunk);
    return counter.finish();
  } catch {
    return 0;
  }
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
