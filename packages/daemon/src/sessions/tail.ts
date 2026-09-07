/**
 * The last few turns of one session file, read from the end -- and, page by
 * page, all the way back to its first if a client keeps asking. Each answer
 * carries the byte offset the next older page starts from, so a phone can
 * walk a whole terminal conversation backwards one screenful at a time
 * without the daemon ever reading the file forward.
 *
 * A phone tapping a live terminal session has no agent row to attach to and
 * no update stream to replay, so the only place its history exists is the
 * session's own JSONL on disk. Those files reach tens of megabytes here (the
 * largest on this machine is 117.6MB), and the turns worth showing are the
 * last handful, so this reader walks backwards from EOF in fixed chunks and
 * stops the moment it has enough. Reading forward to find the end would cost
 * the whole file for a screenful of text -- the exact expense `scanner.ts`
 * exists to avoid everywhere else.
 *
 * Three budgets, all enforced: at most `TAIL_MAX_MESSAGES` turns, at most
 * `TAIL_MAX_BYTES` of file read, and at most `TAIL_MAX_TEXT_BYTES` of words
 * per turn. Whichever is reached first ends the read, and `truncated` says so
 * rather than presenting a partial tail as the whole conversation.
 *
 * Cooperative, like the counter: the event loop is handed on once per chunk
 * read, so a tail request cannot stall HTTP routes, websocket pings, or relay
 * acks even against a pathological file whose last megabyte is one line.
 *
 * Lines become turns through `scanner.ts`'s `parseTurnLine` -- the same
 * parser the message count uses -- so a tail can never disagree with the
 * count beside it about what a message is. What it adds is text extraction,
 * which counting deliberately does not pay for; see `tailText`.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SessionHistoryToolKind, SessionHistoryToolStatus, TranscriptTailEntry } from "@ompd/core/contracts";
import { COUNT_CHUNK_BYTES, parseToolResultLine, parseTurnLine, type SessionTurnLine } from "./scanner.ts";

/**
 * Turns returned when a caller names no limit. Around a screenful on a
 * phone: enough to show what the session has been doing without turning the
 * first paint of a transcript into a scroll marathon.
 */
export const TAIL_DEFAULT_MESSAGES = 30;

/**
 * Hard ceiling on turns, whatever a client asks for. With the per-turn text
 * cap below, one frame still carries a page a phone can render, and the byte
 * budgets below bound what filling it can cost.
 */
export const TAIL_MAX_MESSAGES = 100;

/**
 * One leg of the walk, in bytes: how far the reader looks for words before it
 * collects a full page of them, and how far it gathers neighbours once the
 * first turn lands. Measured against real sessions here: words sit megabytes
 * behind EOF on tool-heavy files, so a shorter leg reports conversations as
 * empty.
 */
export const TAIL_SOFT_MAX_BYTES = 1024 * 1024;

/**
 * Ceiling on the whole walk, in bytes. Reached only when a session has said
 * nothing for megabytes; bounded so a pathological file is expensive, never
 * fatal.
 */
export const TAIL_HARD_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Cap on one turn's text. A pasted stack trace or a 200KB file dump is one
 * line in the file, and a transcript whose first row is a wall of it is not
 * a transcript a phone can read.
 */
export const TAIL_MAX_TEXT_BYTES = 8 * 1024;

/** Appended to a turn whose text hit `TAIL_MAX_TEXT_BYTES`. */
export const TAIL_TEXT_CUT_MARK = "\u2026";

export interface SessionTailResult {
  /** Oldest first, so a client appends live activity below without reordering. */
  entries: TranscriptTailEntry[];
  /** Kept for one release alongside entries for backward compatibility. */
  messages: TranscriptTailEntry[];
  /** True when older turns exist past these, or a byte budget ended the read with file behind it. */
  truncated: boolean;
  /** Bytes actually read. The measurable proof a big file did not cost its size. */
  bytesRead: number;
  /**
   * The byte offset the next older page starts from, or null when the walk
   * reached the start of the file (or the cursor named nothing behind it).
   *
   * A cursor, not a promise of words: a page can come back empty with a
   * non-null cursor, because a run of tool traffic says nothing and the walk
   * stopped at its budget mid-run. The caller keeps paging from the cursor;
   * stopping at the first empty page would strand a reader with megabytes of
   * conversation still behind it. Session files only grow at the end, so an
   * offset from an earlier page stays valid under a live session's appends.
   */
  nextCursor: number | null;
}

export interface SessionTailOptions {
  /** Requested turns, clamped to `[1, TAIL_MAX_MESSAGES]`. Absent means `TAIL_DEFAULT_MESSAGES`. */
  limit?: number;
  /**
   * Byte offset to read backwards from: the `nextCursor` an earlier page
   * returned. Absent means the end of the file, which serves the newest
   * turns. The same two-leg budgets bound every page, so paging a big file
   * costs its pages, never its size.
   */
  cursor?: number;
  /** One leg of the walk. Overridden by tests that need a budget smaller than a fixture. */
  softMaxBytes?: number;
  /** Ceiling on the whole walk, however little it has found. */
  hardMaxBytes?: number;
}

/**
 * The words a turn actually said.
 *
 * Structural on purpose, and deliberately the same discipline
 * `omp-extension`'s `assistantText` arrived at against real omp output: a
 * message's content is an array of blocks, and only a `type: "text"` block
 * with non-empty text is words. A `toolCall` block is the agent reaching for
 * a tool and a `thinking` block is not what it said, so neither may ever
 * surface as a turn's text.
 *
 * One shape `assistantText` never has to handle appears throughout real
 * files: `content` as a bare string, which is how some typed user turns are
 * written (46 of 3828 message lines in a 21MB session here). Dropping those
 * would leave the tail showing an assistant talking to itself, so a string
 * content is its own text. Role attribution never consults the content shape
 * for exactly that reason: it comes from the line's own `message.role`.
 * Anything else says nothing, and a turn that says nothing is not rendered.
 */
export function tailText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type !== "text") continue;
    if (typeof candidate.text !== "string" || candidate.text.length === 0) continue;
    parts.push(candidate.text);
  }
  return parts.join("\n");
}

export function toolKind(name: string): SessionHistoryToolKind {
  const lower = name.toLowerCase();
  if (lower === "bash" || lower === "exec" || lower === "execute" || lower === "eval") return "execute";
  if (lower === "read" || lower === "read_file" || lower === "view") return "read";
  if (lower === "write" || lower === "edit" || lower === "patch") return "edit";
  if (lower === "glob" || lower === "grep" || lower === "search" || lower === "find") return "search";
  if (lower === "fetch" || lower === "curl" || lower === "download") return "fetch";
  if (lower === "mv" || lower === "move") return "move";
  if (lower === "rm" || lower === "delete") return "delete";
  if (lower === "think" || lower === "reason") return "think";
  for (const kind of ["think", "read", "execute", "search", "edit", "fetch", "move", "delete"] as const) {
    if (lower.includes(kind)) return kind;
  }
  return "other";
}

export function locationsOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const row = input as Record<string, unknown>;
  const values = [row.path, row.file_path, row.file, row.cwd];
  const paths: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  if (Array.isArray(row.paths)) {
    for (const item of row.paths) {
      if (typeof item === "string" && item.length > 0) paths.push(item);
    }
  }
  if (Array.isArray(row.files)) {
    for (const item of row.files) {
      if (typeof item === "string" && item.length > 0) paths.push(item);
    }
  }
  return paths;
}

function locationsFromDetails(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const row = details as Record<string, unknown>;
  const paths: string[] = [];
  if (typeof row.path === "string" && row.path.length > 0) paths.push(row.path);
  if (typeof row.resolvedPath === "string" && row.resolvedPath.length > 0) paths.push(row.resolvedPath);
  if (Array.isArray(row.files)) {
    for (const item of row.files) {
      if (typeof item === "string" && item.length > 0) paths.push(item);
    }
  }
  if (Array.isArray(row.locations)) {
    for (const item of row.locations) {
      if (typeof item === "string" && item.length > 0) paths.push(item);
      else if (typeof item === "object" && item !== null && typeof (item as { path?: unknown }).path === "string") {
        paths.push((item as { path: string }).path);
      }
    }
  }
  return paths;
}

function extractToolOutput(content: unknown, details: unknown): string | null {
  if (typeof content === "string" && content.length > 0) return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string" && block.length > 0) {
        parts.push(block);
      } else if (typeof block === "object" && block !== null) {
        const item = block as Record<string, unknown>;
        if (typeof item.text === "string" && item.text.length > 0) {
          parts.push(item.text);
        }
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  if (typeof details === "object" && details !== null) {
    const row = details as Record<string, unknown>;
    if (typeof row.displayContent === "string" && row.displayContent.length > 0) {
      return row.displayContent;
    }
    if (typeof row.output === "string" && row.output.length > 0) {
      return row.output;
    }
  }
  return null;
}

interface PendingToolResult {
  status: SessionHistoryToolStatus;
  output: string | null;
  locations: string[];
}

function extractTurnEntries(
  turn: SessionTurnLine,
  pendingToolResults: Map<string, PendingToolResult>,
): TranscriptTailEntry[] {
  const at = turn.at;
  if (turn.role === "user") {
    const text = tailText(turn.content);
    if (text === "") return [];
    return [{ kind: "text", role: "user", text: capText(text, TAIL_MAX_TEXT_BYTES), at }];
  }

  if (typeof turn.content === "string") {
    if (turn.content.length === 0) return [];
    return [{ kind: "text", role: "assistant", text: capText(turn.content, TAIL_MAX_TEXT_BYTES), at }];
  }

  if (!Array.isArray(turn.content)) return [];

  const entries: TranscriptTailEntry[] = [];
  const textParts: string[] = [];

  const flushText = () => {
    if (textParts.length > 0) {
      const text = textParts.join("\n");
      textParts.length = 0;
      if (text.length > 0) {
        entries.push({ kind: "text", role: "assistant", text: capText(text, TAIL_MAX_TEXT_BYTES), at });
      }
    }
  };

  for (const block of turn.content) {
    if (block === null || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    const type = typeof item.type === "string" ? item.type : "";

    if (type === "text") {
      if (typeof item.text === "string" && item.text.length > 0) {
        textParts.push(item.text);
      }
      continue;
    }

    flushText();

    if (type === "thinking") {
      const rawThinking =
        typeof item.thinking === "string" ? item.thinking : typeof item.text === "string" ? item.text : "";
      if (rawThinking.length > 0) {
        entries.push({ kind: "thinking", text: capText(rawThinking, TAIL_MAX_TEXT_BYTES), at });
      }
      continue;
    }

    if (type === "toolCall") {
      const id =
        (typeof item.id === "string" && item.id.length > 0 ? item.id : "") ||
        (typeof item.toolCallId === "string" && item.toolCallId.length > 0 ? item.toolCallId : "");
      const name =
        (typeof item.name === "string" && item.name.length > 0 ? item.name : "") ||
        (typeof item.toolName === "string" && item.toolName.length > 0 ? item.toolName : id);
      const tKind = toolKind(name);
      const callLocations = locationsOf(item.arguments ?? item.input);
      const result = id ? pendingToolResults.get(id) : undefined;
      if (id) pendingToolResults.delete(id);
      const status: SessionHistoryToolStatus = result?.status ?? "pending";
      const output = result?.output ?? null;
      const combinedLocations = Array.from(new Set([...callLocations, ...(result?.locations ?? [])]));
      entries.push({
        kind: "tool",
        id: id || `tool-${entries.length}`,
        title: name || id,
        toolKind: tKind,
        status,
        output,
        locations: combinedLocations,
        at,
        text: output ?? name ?? id,
      });
    }
  }

  flushText();
  return entries;
}

/** Hand the event loop to whatever else is waiting, exactly as the index's cooperative counting does. Microtasks do not qualify. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * `text` cut to at most `maxBytes` of UTF-8, on a character boundary, with
 * the cut marked. Measured in bytes rather than characters because the frame
 * budget is bytes, and cutting a buffer blind would split a multi-byte
 * character into a replacement char.
 */
function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const bytes = Buffer.from(text, "utf8");
  let end = maxBytes;
  // Back off a continuation byte so the cut lands between characters.
  while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--;
  return bytes.subarray(0, end).toString("utf8") + TAIL_TEXT_CUT_MARK;
}

/** How far a backward read got. Written by the generator so the caller can report exact cost after stopping early. */
interface TailProgress {
  /** Bytes actually read from the file. */
  read: number;
  /** Start offset of the lowest line produced, including the line currently being handed over. Zero means the walk reached the start of the file. */
  unread: number;
}

/**
 * The backward-reading core: complete lines from `start` downwards, newest
 * first, with `null` marking each chunk boundary so the caller can hand over
 * the event loop exactly once per unit of real I/O.
 *
 * `start` is the end of the file for a newest-tail read, or a page cursor
 * for an older one; nothing else differs, because a page is the same walk
 * begun partway through the file. Splitting at 0x0a bytes and decoding each
 * line separately is byte-for-byte equivalent to decoding the whole file and
 * splitting the text, for the same reason the forward counter relies on:
 * 0x0a never appears inside a UTF-8 multi-byte sequence. `pending` holds the
 * bytes of the one line still unresolved below what has been read, so a line
 * spanning many chunks is concatenated once, at its newline, rather than
 * recopied per chunk.
 */
function* linesFromEnd(
  fd: number,
  start: number,
  maxBytes: number,
  progress: TailProgress,
): Generator<string | null, void> {
  const chunk = Buffer.allocUnsafe(COUNT_CHUNK_BYTES);
  let position = start;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  progress.unread = position;

  while (position > 0 && progress.read < maxBytes) {
    const want = Math.min(COUNT_CHUNK_BYTES, position, maxBytes - progress.read);
    const at = position - want;
    let bytesRead: number;
    try {
      bytesRead = readSync(fd, chunk, 0, want, at);
    } catch {
      return; // Unreadable mid-read: whatever was produced stands, the rest stays unread.
    }
    if (bytesRead === 0) break;
    position -= bytesRead;
    progress.read += bytesRead;

    // Walk this chunk's newlines from the top down. Each one closes the line
    // above it, whose bytes are this chunk's slice plus anything pending from
    // chunks already read below.
    let lineEnd = bytesRead;
    for (let i = bytesRead - 1; i >= 0; i--) {
      if (chunk[i] !== 0x0a) continue;
      // Everything from this newline up has been produced, so the unread
      // remainder is exactly the bytes below it. Recorded before the yield
      // so a caller capturing the cursor while holding this line reads the
      // boundary of THIS line, not of the one before it.
      progress.unread = position + i;
      const head = chunk.subarray(i + 1, lineEnd);
      yield pendingLength > 0 ? Buffer.concat([head, ...pending]).toString("utf8") : head.toString("utf8");
      pending = [];
      pendingLength = 0;
      lineEnd = i;
    }
    if (lineEnd > 0) {
      // Bytes above the chunk's lowest newline belong to a line continuing
      // below this chunk; a copy, because the chunk buffer is reused.
      const head = Buffer.from(chunk.subarray(0, lineEnd));
      pending.unshift(head);
      pendingLength += head.length;
    }
    yield null; // One cooperative step per chunk.
  }

  // A file that does not begin with a newline ends this walk with one
  // unterminated line at offset 0. That is a real line, and the forward
  // counter counts its counterpart, so it is produced here too. The offset
  // is recorded before the yield for the same reason as every other line.
  if (position === 0 && pendingLength > 0) {
    progress.unread = 0;
    yield Buffer.concat(pending).toString("utf8");
  }
}

/**
 * One page of turns from the session file at `path`, read backwards.
 *
 * With no cursor the page starts at the end of the file and serves the
 * newest turns; with the `nextCursor` of an earlier page it serves the next
 * older turns. Either way the walk has two legs, because one budget cannot
 * serve both jobs. Looking for words is the first leg: a session that ended
 * in a long run of tool traffic has none for megabytes, and stopping at the
 * soft budget there is what makes a tail come back empty on a session the
 * operator plainly conversed in. Collecting them is the second: once a turn
 * is in hand, the reader spends at most one more soft budget gathering its
 * neighbours. The hard ceiling bounds the pair, so the pathological case is
 * expensive but never unbounded.
 *
 * The cursor for the next page is the boundary beneath the oldest turn this
 * page sent, and the two directions it is chosen from differ deliberately.
 * When the limit ends the walk, the extra turn that proved `truncated` was
 * read but never sent, so the cursor must sit above it to let the next page
 * send it; when a budget ends the walk, every line below the cursor already
 * proved silent, so the cursor sits beneath all of them and the next page
 * never pays for them again.
 *
 * A file that cannot be opened or read answers with an empty tail rather than
 * throwing: one unreadable session must cost that session's screen, not the
 * socket serving it.
 */
export async function readSessionTail(path: string, opts: SessionTailOptions = {}): Promise<SessionTailResult> {
  const limit = Math.max(1, Math.min(Math.trunc(opts.limit ?? TAIL_DEFAULT_MESSAGES), TAIL_MAX_MESSAGES));
  const softMaxBytes = Math.max(1, opts.softMaxBytes ?? TAIL_SOFT_MAX_BYTES);
  const hardMaxBytes = Math.max(softMaxBytes, opts.hardMaxBytes ?? TAIL_HARD_MAX_BYTES);

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { entries: [], messages: [], truncated: false, bytesRead: 0, nextCursor: null };
  }
  try {
    const size = fstatSync(fd).size;
    const start = opts.cursor === undefined ? size : Math.min(Math.max(Math.trunc(opts.cursor), 0), size);
    if (opts.cursor !== undefined && start >= size) {
      return { entries: [], messages: [], truncated: false, bytesRead: 0, nextCursor: null };
    }
    const progress: TailProgress = { read: 0, unread: 0 };
    const newestFirst: TranscriptTailEntry[] = [];
    const pendingToolResults = new Map<string, PendingToolResult>();
    let older = false;
    let stopAt: number | null = null;
    let pageBoundary = start;

    for (const line of linesFromEnd(fd, start, hardMaxBytes, progress)) {
      if (line === null) {
        await yieldToEventLoop();
        if (stopAt !== null && progress.read >= stopAt) break;
        continue;
      }

      const toolResult = parseToolResultLine(line);
      if (toolResult !== null && toolResult.toolCallId.length > 0) {
        const rawOutput = extractToolOutput(toolResult.content, toolResult.details);
        const output = rawOutput !== null ? capText(rawOutput, TAIL_MAX_TEXT_BYTES) : null;
        const status: SessionHistoryToolStatus = toolResult.isError ? "failed" : "completed";
        const locations = locationsFromDetails(toolResult.details);
        pendingToolResults.set(toolResult.toolCallId, { status, output, locations });
        continue;
      }

      const turn = parseTurnLine(line);
      if (turn === null) continue;

      const turnEntries = extractTurnEntries(turn, pendingToolResults);
      if (turnEntries.length === 0) continue;

      if (newestFirst.length >= limit) {
        older = true;
        break;
      }

      for (let i = turnEntries.length - 1; i >= 0; i--) {
        if (newestFirst.length === limit) {
          older = true;
          break;
        }
        newestFirst.push(turnEntries[i]!);
      }

      pageBoundary = progress.unread;
      stopAt ??= progress.read + softMaxBytes;

      if (older) break;
    }

    const nextCursor = older ? pageBoundary : progress.unread > 0 ? progress.unread : null;
    const entries = newestFirst.reverse();
    return {
      entries,
      messages: entries,
      truncated: older || progress.unread > 0,
      bytesRead: progress.read,
      nextCursor,
    };
  } finally {
    closeSync(fd);
  }
}
