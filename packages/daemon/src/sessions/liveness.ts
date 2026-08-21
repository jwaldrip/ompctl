/**
 * Cross-references OMP's per-project client presence registry
 * (`~/.omp/run/daemons/<hash>/clients/<pid>-<uuid>.json`) against real
 * process liveness, so a record left behind by a process that crashed
 * without cleaning up its own file can never make a session look live.
 *
 * The registry is upstream's own mechanism (`registerDaemonProjectPresence`
 * in `packages/coding-agent/src/launch/presence.ts`), used here read-only.
 * `getDaemonRuntimeDir` is called with an arbitrary project directory purely
 * to recover its parent -- the `run/daemons` root that holds every project's
 * hash directory -- through the same XDG/profile-aware resolution upstream
 * itself uses, rather than reimplementing that resolution and risking it
 * drifting out of sync.
 */

import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getDaemonRuntimeDir } from "@oh-my-pi/pi-utils";

export interface ClientPresenceRecord {
  pid: number;
  id: string;
  projectDir: string;
  /** The session this client currently holds, when it has one open. */
  sessionId?: string;
  title?: string;
  /** When this client registered, i.e. the presence file's own mtime: it is written once at process start and never rewritten. */
  registeredAtMs: number;
}

/** Where every project's client presence directory lives, i.e. `~/.omp/run/daemons`. */
export function runDaemonsRoot(): string {
  return dirname(getDaemonRuntimeDir(process.cwd()));
}

/**
 * Whether `pid` names a process that is still running.
 *
 * Signal 0 sends nothing; the kernel only reports whether the pid exists and
 * is reachable, so this never affects the target process. `EPERM` (exists,
 * owned by someone else) still counts as alive -- a single-user daemon has no
 * other explanation for that error than a live process it does not own.
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Every client presence record across every project's runtime directory,
 * with dead pids already excluded. A record that fails to parse (mid-write,
 * or from an OMP version whose shape has since changed) is dropped rather
 * than treated as evidence of anything -- it proves nothing about liveness
 * either way.
 */
export async function listLiveClientPresences(root: string = runDaemonsRoot()): Promise<ClientPresenceRecord[]> {
  let projectHashDirs: string[];
  try {
    projectHashDirs = (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }

  const out: ClientPresenceRecord[] = [];
  for (const projectHash of projectHashDirs) {
    const clientsDir = join(root, projectHash, "clients");
    let fileNames: string[];
    try {
      fileNames = (await readdir(clientsDir, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
        .map(entry => entry.name);
    } catch {
      continue;
    }

    for (const fileName of fileNames) {
      const presencePath = join(clientsDir, fileName);
      let record: ClientPresenceRecord;
      let registeredAtMs: number;
      try {
        record = JSON.parse(await Bun.file(presencePath).text());
        registeredAtMs = (await stat(presencePath)).mtimeMs;
      } catch {
        continue;
      }
      if (typeof record.pid !== "number" || !isPidAlive(record.pid)) continue;
      out.push({ ...record, registeredAtMs });
    }
  }
  return out;
}
