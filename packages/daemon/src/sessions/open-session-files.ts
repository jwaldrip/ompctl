/**
 * Which session transcript each live `omp` terminal holds open.
 *
 * The presence registry names a process and its project directory and
 * nothing else: upstream's `registerDaemonProjectPresence` writes
 * `{ pid, id, projectDir }`, on its main today as in every build that has
 * shipped. So "which session is that terminal in" has no answer in the
 * registry, and inferring it from mtimes fails the moment a second file in
 * the same project is touched after the terminal registered: a second
 * terminal in the project, or this daemon opening a dormant session there
 * from a phone. Measured on the operator's Mac on 2026-09-08: 18 live
 * terminals, 8 shown live, 9 shown dormant, the operator's own session
 * among them.
 *
 * The terminal itself knows. `omp` opens its transcript when the session
 * starts and holds the descriptor for the life of the process (every one of
 * the 18 held exactly its own `<stamp>_<id>.jsonl`, plus nested subagent
 * transcripts under that file's directory, which the catalog does not list
 * and which therefore never match a catalogued path). Reading that
 * descriptor table is the one honest mapping from a pid to a session, and
 * it is what this module does: `/proc/<pid>/fd` on Linux, one batched
 * `lsof` on macOS (418ms for 18 pids, measured), nothing elsewhere.
 *
 * Only `.jsonl` paths come back, resolved, so the caller matches them by
 * equality against the catalogue's own resolved paths. A pid that holds no
 * transcript, has exited, or belongs to another user is simply absent.
 */

import { readdir, readlink } from "node:fs/promises";
import { resolve } from "node:path";

export type OpenSessionFilesLookup = (pids: readonly number[]) => Promise<Map<number, string[]>>;

const TRANSCRIPT_SUFFIX = ".jsonl";

async function linuxOpenFiles(pids: readonly number[]): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const pid of pids) {
    const fdDir = `/proc/${pid}/fd`;
    let names: string[];
    try {
      names = await readdir(fdDir);
    } catch {
      continue; // Gone, or not ours to read.
    }
    const paths: string[] = [];
    for (const name of names) {
      let target: string;
      try {
        target = await readlink(`${fdDir}/${name}`);
      } catch {
        continue;
      }
      if (target.endsWith(TRANSCRIPT_SUFFIX)) paths.push(resolve(target));
    }
    if (paths.length > 0) out.set(pid, paths);
  }
  return out;
}

/**
 * `lsof -F` field output: one record per line, first character the field
 * letter. `p` opens a process, `n` names a file. Exported for the parser's
 * own test; the process-spawning wrapper below is what the daemon uses.
 */
export function parseLsofFields(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  let pid: number | null = null;
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      pid = Number.parseInt(value, 10);
      if (!Number.isInteger(pid)) pid = null;
    } else if (field === "n" && pid !== null && value.endsWith(TRANSCRIPT_SUFFIX)) {
      const paths = out.get(pid);
      const path = resolve(value);
      if (paths === undefined) out.set(pid, [path]);
      else paths.push(path);
    }
  }
  return out;
}

async function darwinOpenFiles(pids: readonly number[]): Promise<Map<number, string[]>> {
  if (pids.length === 0) return new Map();
  // -a: AND the selectors. -p: these pids only. -w: no warnings. -n/-P/-l:
  // no host, port, or user lookups, each of which can stall. -F: one field
  // per line. lsof exits 1 when any selected pid has already gone, with the
  // rest still reported, so the exit code is not a failure signal here.
  const proc = Bun.spawn(["lsof", "-a", "-p", pids.join(","), "-w", "-n", "-P", "-l", "-Fpn"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return parseLsofFields(text);
}

/** The platform's lookup, or one that answers nothing where no reading exists. */
export const openSessionFiles: OpenSessionFilesLookup =
  process.platform === "linux"
    ? linuxOpenFiles
    : process.platform === "darwin"
      ? darwinOpenFiles
      : async () => new Map();
