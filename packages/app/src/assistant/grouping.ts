/**
 * Pure grouping and noise reduction for transcript tool runs.
 *
 * In active agent sessions, repetitive read/search calls and bookkeeping operations
 * (todo, memory updates) clutter the transcript. This module groups consecutive
 * read-only operations into single summaries ("Read 3 files", "Searched 4 times")
 * and hides bookkeeping chatter behind an expandable row by default.
 *
 * Streaming safety: any run that is still in progress remains expanded so an
 * operator watching the live turn sees the active card.
 */

import type { Entry, ToolEntry, ToolKind, ToolStatus } from "../session/model.ts";

export type ToolGroupKind = "read" | "search" | "fetch" | "bookkeeping";

export interface ToolGroupEntry {
  readonly kind: "tool_group";
  readonly id: string;
  readonly groupKind: ToolGroupKind;
  readonly title: string;
  readonly entries: readonly ToolEntry[];
  readonly status: ToolStatus;
  readonly expandedDefault: boolean;
}

export type GroupedEntry = Entry | ToolGroupEntry;

/**
 * Tools whose primary effect is state management or memory inspection
 * rather than project work (reading, editing, compiling, testing).
 *
 * In active agent turns, bookkeeping calls like `todo`, `retain`, and `recall`
 * generate status chatter that buries real actions. Grouping and muting them
 * keeps the working transcript legible while keeping the audit log accessible.
 */
export const BOOKKEEPING_TOOLS: Readonly<Record<string, true>> = {
  todo: true,
  retain: true,
  recall: true,
  memory_edit: true,
  update_notes: true,
  goal: true,
  init_experiment: true,
  log_experiment: true,
};

/**
 * Read-only tool kinds that can collapse into grouped summaries when
 * executed consecutively.
 */
export const READ_ONLY_TOOL_KINDS: Readonly<Partial<Record<ToolKind, true>>> = {
  read: true,
  search: true,
  fetch: true,
};

/** Check whether a tool call is state or memory bookkeeping. */
export function isBookkeepingTool(entry: ToolEntry): boolean {
  const title = entry.title.trim().toLowerCase();
  for (const tool of Object.keys(BOOKKEEPING_TOOLS)) {
    if (
      title === tool ||
      title.startsWith(`${tool}:`) ||
      title.startsWith(`${tool} `) ||
      title.startsWith(`${tool}(`)
    ) {
      return true;
    }
  }
  if (typeof entry.input === "object" && entry.input !== null) {
    const toolName = Reflect.get(entry.input, "tool") ?? Reflect.get(entry.input, "name");
    if (typeof toolName === "string" && toolName.toLowerCase() in BOOKKEEPING_TOOLS) {
      return true;
    }
  }
  return false;
}

/** Check whether an entry is a read-only tool kind and not bookkeeping. */
export function isReadOnlyTool(entry: ToolEntry): boolean {
  return READ_ONLY_TOOL_KINDS[entry.toolKind] === true && !isBookkeepingTool(entry);
}

/** Compute the worst (most severe) status across a run of tool entries. */
export function worstToolStatus(entries: readonly ToolEntry[]): ToolStatus {
  if (entries.some(e => e.status === "failed")) return "failed";
  if (entries.some(e => e.status === "in_progress")) return "in_progress";
  if (entries.some(e => e.status === "pending")) return "pending";
  return "completed";
}

function summaryForRun(kind: ToolGroupKind, count: number): string {
  switch (kind) {
    case "read":
      return count === 1 ? "Read 1 file" : `Read ${count} files`;
    case "search":
      return count === 1 ? "Searched 1 time" : `Searched ${count} times`;
    case "fetch":
      return count === 1 ? "Fetched 1 resource" : `Fetched ${count} resources`;
    case "bookkeeping":
      return count === 1 ? "1 bookkeeping call" : `${count} bookkeeping calls`;
  }
}

/**
 * Pure function over the entry list that:
 *  - Collapses runs of two or more consecutive read-only tools of the same kind.
 *  - Groups bookkeeping tools into a single muted row hidden by default.
 *  - Leaves everything else untouched.
 *  - Ensures runs with an in-progress member stay expanded for streaming safety.
 */
export function groupEntries(entries: readonly (Entry | ToolGroupEntry)[]): readonly GroupedEntry[] {
  const result: GroupedEntry[] = [];
  const len = entries.length;
  let i = 0;

  while (i < len) {
    const item = entries[i]!;

    // Already grouped or non-tool entry passes through unchanged
    if (item.kind !== "tool") {
      result.push(item);
      i++;
      continue;
    }

    const firstTool = item as ToolEntry;

    // 1. Bookkeeping run (collapses 1 or more consecutive bookkeeping calls)
    if (isBookkeepingTool(firstTool)) {
      const run: ToolEntry[] = [firstTool];
      let j = i + 1;
      while (j < len) {
        const next = entries[j]!;
        if (next.kind === "tool" && isBookkeepingTool(next as ToolEntry)) {
          run.push(next as ToolEntry);
          j++;
        } else {
          break;
        }
      }

      const inProgress = run[run.length - 1]?.status === "in_progress" || run.some(e => e.status === "in_progress");
      result.push({
        kind: "tool_group",
        id: `group-bookkeeping-${run[0]!.id}`,
        groupKind: "bookkeeping",
        title: summaryForRun("bookkeeping", run.length),
        entries: run,
        status: worstToolStatus(run),
        expandedDefault: inProgress,
      });
      i = j;
      continue;
    }

    // 2. Read-only tool run (collapses runs of 2 or more consecutive calls of same kind)
    if (isReadOnlyTool(firstTool)) {
      const targetKind = firstTool.toolKind;
      const groupKind: ToolGroupKind = targetKind === "read" ? "read" : targetKind === "search" ? "search" : "fetch";
      const run: ToolEntry[] = [firstTool];
      let j = i + 1;
      while (j < len) {
        const next = entries[j]!;
        if (
          next.kind === "tool" &&
          (next as ToolEntry).toolKind === targetKind &&
          !isBookkeepingTool(next as ToolEntry)
        ) {
          run.push(next as ToolEntry);
          j++;
        } else {
          break;
        }
      }

      if (run.length >= 2) {
        const inProgress = run[run.length - 1]?.status === "in_progress" || run.some(e => e.status === "in_progress");
        result.push({
          kind: "tool_group",
          id: `group-${groupKind}-${run[0]!.id}`,
          groupKind,
          title: summaryForRun(groupKind, run.length),
          entries: run,
          status: worstToolStatus(run),
          expandedDefault: inProgress,
        });
        i = j;
        continue;
      }

      // Single read-only tool is untouched
      result.push(firstTool);
      i++;
      continue;
    }

    // 3. Other tool calls (execute, edit, move, delete, etc.)
    result.push(firstTool);
    i++;
  }

  return result;
}
