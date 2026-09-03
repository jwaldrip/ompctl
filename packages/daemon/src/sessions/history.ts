import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { SessionHistoryEntry, SessionHistoryToolKind, SessionHistoryToolStatus } from "@ompd/core/contracts";

export const HISTORY_DEFAULT_TURNS = 30;
export const HISTORY_MAX_TURNS = 100;
// Below the one-megabyte websocket ceiling after JSON framing and metadata.
export const HISTORY_MAX_BYTES = 512 * 1024;
const HISTORY_MAX_ENTRY_BYTES = 128 * 1024;

export interface SessionHistoryOptions {
  before?: number;
  limit?: number;
  maxBytes?: number;
}

export interface SessionHistoryResult {
  entries: SessionHistoryEntry[];
  nextBefore: number | null;
  bytesRead: number;
}

interface LineRecord {
  start: number;
  text: string;
}

/**
 * Read one page backwards without materialising an unbounded session file.
 * `before` is the start offset returned by the next-newer page; clients treat
 * it as opaque. The selected line range is replayed oldest-first.
 */
export async function readSessionHistory(
  path: string,
  options: SessionHistoryOptions = {},
): Promise<SessionHistoryResult> {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return { entries: [], nextBefore: null, bytesRead: 0 };
  }

  try {
    const size = fstatSync(fd).size;
    const before = Math.max(0, Math.min(size, options.before ?? size));
    if (before === 0) return { entries: [], nextBefore: null, bytesRead: 0 };
    const maxBytes = Math.max(1, Math.min(HISTORY_MAX_BYTES, options.maxBytes ?? HISTORY_MAX_BYTES));
    const start = Math.max(0, before - maxBytes);
    const buffer = Buffer.allocUnsafe(before - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const slice = buffer.subarray(0, bytesRead);
    const lines = recordsOf(slice, start, start > 0, before === size);
    const limit = Math.max(1, Math.min(HISTORY_MAX_TURNS, options.limit ?? HISTORY_DEFAULT_TURNS));

    let turns = 0;
    let first = lines.length;
    for (let index = lines.length - 1; index >= 0; index--) {
      const record = lines[index];
      if (record === undefined) continue;
      first = index;
      if (isConversationTurn(record.text)) turns += 1;
      if (turns >= limit) break;
    }
    if (first === lines.length) return { entries: [], nextBefore: start > 0 ? start : null, bytesRead };

    const selected = lines.slice(first);
    const entries = parseHistory(selected);
    const earliest = selected[0]?.start ?? start;
    return { entries, nextBefore: earliest > 0 ? earliest : null, bytesRead };
  } finally {
    closeSync(fd);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

function recordsOf(
  buffer: Buffer,
  absoluteStart: number,
  discardLeadingPartial: boolean,
  includeTrailingPartial: boolean,
): LineRecord[] {
  const records: LineRecord[] = [];
  let lineStart = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) continue;
    if (!(discardLeadingPartial && lineStart === 0)) {
      records.push({ start: absoluteStart + lineStart, text: buffer.subarray(lineStart, index).toString("utf8") });
    }
    lineStart = index + 1;
  }
  if (includeTrailingPartial && lineStart < buffer.length && !(discardLeadingPartial && lineStart === 0)) {
    records.push({ start: absoluteStart + lineStart, text: buffer.subarray(lineStart).toString("utf8") });
  }
  return records;
}

function parsedLine(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isConversationTurn(text: string): boolean {
  const row = parsedLine(text);
  if (row?.type !== "message") return false;
  const message = objectField(row, "message");
  const role = message?.role;
  return role === "user" || role === "assistant";
}

function parseHistory(lines: LineRecord[]): SessionHistoryEntry[] {
  const entries: SessionHistoryEntry[] = [];
  const tools = new Map<string, number>();
  for (const line of lines) {
    const row = parsedLine(line.text);
    if (row?.type !== "message") continue;
    const message = objectField(row, "message");
    if (message === null) continue;
    const role = stringField(message, "role");
    const at = stringField(row, "timestamp") ?? "";
    const messageId = stringField(row, "id") ?? `history-${line.start}`;

    if (role === "user") {
      const text = capText(textOf(message.content));
      if (text.length > 0) entries.push({ kind: "user", id: messageId, text, at });
      continue;
    }
    if (role === "assistant") {
      const content = message.content;
      if (typeof content === "string") {
        pushAssistant(entries, messageId, capText(content), false, at);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const item = block as Record<string, unknown>;
        const type = stringField(item, "type");
        if (type === "thinking") {
          pushAssistant(
            entries,
            messageId,
            capText(stringField(item, "thinking") ?? stringField(item, "text") ?? ""),
            true,
            at,
          );
          continue;
        }
        if (type === "text") {
          pushAssistant(entries, messageId, capText(stringField(item, "text") ?? ""), false, at);
          continue;
        }
        if (type === "toolCall") {
          const id = stringField(item, "id") ?? `${messageId}:tool:${tools.size}`;
          const tool: SessionHistoryEntry = {
            kind: "tool",
            id,
            toolKind: toolKind(stringField(item, "name") ?? ""),
            title: stringField(item, "name") ?? id,
            status: "pending",
            input: item.arguments ?? null,
            output: null,
            locations: locationsOf(item.arguments),
            at,
          };
          tools.set(id, entries.length);
          entries.push(tool);
        }
      }
      continue;
    }
    if (role === "toolResult") {
      const id = stringField(message, "toolCallId") ?? stringField(row, "toolCallId");
      if (id === null) continue;
      const output = capText(textOf(message.content));
      const status: SessionHistoryToolStatus = message.isError === true ? "failed" : "completed";
      const index = tools.get(id);
      if (index !== undefined) {
        const before = entries[index];
        if (before?.kind === "tool") entries[index] = { ...before, status, output: output || null };
      } else {
        entries.push({
          kind: "tool",
          id,
          toolKind: "other",
          title: stringField(message, "toolName") ?? id,
          status,
          input: null,
          output: output || null,
          locations: [],
          at,
        });
      }
    }
  }
  return entries;
}

function pushAssistant(entries: SessionHistoryEntry[], id: string, text: string, thought: boolean, at: string): void {
  if (text.length === 0) return;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry?.kind !== "assistant" || entry.id !== id || entry.thought !== thought) continue;
    entries[index] = { ...entry, text: capText(entry.text + text) };
    return;
  }
  entries.push({ kind: "assistant", id, text, thought, at });
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return typeof field === "object" && field !== null ? (field as Record<string, unknown>) : null;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const item = block as Record<string, unknown>;
    const type = stringField(item, "type");
    if (type === "text" && typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function capText(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= HISTORY_MAX_ENTRY_BYTES) return text;
  return `${bytes.subarray(0, HISTORY_MAX_ENTRY_BYTES).toString("utf8")}…`;
}

function toolKind(name: string): SessionHistoryToolKind {
  const lower = name.toLowerCase();
  for (const kind of ["think", "read", "execute", "search", "edit", "fetch", "move", "delete"] as const) {
    if (lower.includes(kind)) return kind;
  }
  return "other";
}

function locationsOf(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const row = input as Record<string, unknown>;
  const values = [row.path, row.file_path, row.file, row.cwd];
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}
