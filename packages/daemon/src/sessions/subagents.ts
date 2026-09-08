/**
 * Subagent transcripts for a session on disk.
 *
 * OMP writes each subagent's transcript to disk beside the parent's:
 * `<sessionsRoot>/<group>/<stamp>_<parentSessionId>/<Name>.jsonl`,
 * with the subagent's final report as `<Name>.md` beside it and tool logs
 * in the same directory.
 *
 * For terminal sessions and dormant ones, these files are the only record
 * of subagents that exists on this machine: the daemon's live roster carries
 * subagents only for agents ompd itself spawned.
 */

import type { Dirent, Stats } from "node:fs";
import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SubagentTranscript } from "@ompd/core";

/**
 * Bounded read on the file head: the first few KB are enough to read the
 * display title record and the following session record containing the
 * subagent's own session id.
 */
const SUBAGENT_HEADER_BYTES = 16_384;

/**
 * Result of resolving a subagent transcript file path.
 */
export type SubagentPathResult =
  | { ok: true; path: string }
  | { ok: false; code: "bad_frame" | "not_found"; message: string };

/**
 * The directory OMP allocates for a session's subagents and tool logs,
 * located directly beside the session's JSONL transcript.
 *
 * For `/path/to/sessions/<stamp>_<id>.jsonl`, the directory is
 * `/path/to/sessions/<stamp>_<id>`.
 */
export function subagentDirFor(sessionFilePath: string): string {
  const dir = dirname(sessionFilePath);
  const base = sessionFilePath.endsWith(".jsonl") ? basename(sessionFilePath, ".jsonl") : basename(sessionFilePath);
  return join(dir, base);
}

/**
 * Read the bounded JSONL head to recover the subagent's own session id
 * from its `session` record. Returns null if absent, unreadable, or malformed.
 */
async function readSubagentSessionId(filePath: string): Promise<string | null> {
  try {
    const text = await Bun.file(filePath).slice(0, SUBAGENT_HEADER_BYTES).text();
    for (const line of text.split("\n")) {
      if (line.length === 0) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; id?: unknown };
        if (record.type === "session" && typeof record.id === "string" && record.id.length > 0) {
          return record.id;
        }
      } catch {
        // A cut or malformed line does not invalidate other records.
      }
    }
  } catch {
    // Unreadable transcript leaves id as null.
  }
  return null;
}

/**
 * Enumerate all subagent transcripts for a session, ordered newest first.
 *
 * Reads the session's sibling subagent directory non-recursively, keeping
 * only regular `*.jsonl` files directly inside. For each, reads the bounded
 * header to extract the subagent session id and checks for a sibling `<stem>.md`
 * report file.
 *
 * A missing or unreadable directory returns an empty list, never an error.
 */
export async function listSubagentTranscripts(sessionFilePath: string): Promise<SubagentTranscript[]> {
  const dir = subagentDirFor(sessionFilePath);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Missing directory means an empty list, not an error.
    return [];
  }

  const transcripts: SubagentTranscript[] = [];

  for (const entry of entries) {
    if (!entry.name.endsWith(".jsonl")) continue;
    if (entry.name.startsWith(".")) continue;
    const name = entry.name.slice(0, -".jsonl".length);
    if (name.length === 0) continue;

    const fullPath = join(dir, entry.name);
    let st: Stats;
    try {
      st = await stat(fullPath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }

    let hasReport = false;
    try {
      const reportStat = statSync(join(dir, `${name}.md`));
      hasReport = reportStat.isFile();
    } catch {
      hasReport = false;
    }

    const id = await readSubagentSessionId(fullPath);

    transcripts.push({
      name,
      id,
      updatedAt: st.mtime.toISOString(),
      byteSize: st.size,
      hasReport,
    });
  }

  // Newest first by mtime ISO.
  transcripts.sort((a, b) => {
    const cmp = b.updatedAt.localeCompare(a.updatedAt);
    if (cmp !== 0) return cmp;
    return a.name.localeCompare(b.name);
  });

  return transcripts;
}

/**
 * Validate a subagent name and resolve its transcript path.
 *
 * Enforces that `name` is a plain file stem: it cannot be empty, start with a
 * dot, or contain slashes, backslashes, or parent traversal ("..").
 *
 * Refuses invalid stems with `bad_frame` and missing files with `not_found`.
 */
export function subagentTranscriptPath(sessionFilePath: string, name: string): SubagentPathResult {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("..") ||
    name.includes("\0")
  ) {
    return {
      ok: false,
      code: "bad_frame",
      message: "subagent must be a plain file stem",
    };
  }

  const dir = subagentDirFor(sessionFilePath);
  const target = join(dir, `${name}.jsonl`);
  try {
    const st = statSync(target);
    if (!st.isFile()) {
      return {
        ok: false,
        code: "not_found",
        message: `no subagent transcript "${name}" for session`,
      };
    }
  } catch {
    return {
      ok: false,
      code: "not_found",
      message: `no subagent transcript "${name}" for session`,
    };
  }

  return { ok: true, path: target };
}
