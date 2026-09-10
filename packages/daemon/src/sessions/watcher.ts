/**
 * The sessions-root watcher behind the gateway's live session list: turns
 * "a session file appeared, changed, or went away on disk" into one
 * debounced notification, so a socket that asked for the index once keeps
 * receiving refreshed `sessions` frames without asking again.
 *
 * node:fs recursive watches miss or collapse nested events on macOS. This
 * watcher holds one root watch to discover cwd-group directories and one
 * non-recursive watch per group for session-file changes. Creating or
 * removing a group also arms a refresh, so a session file written before
 * its child watch is attached still lands in the next scan.
 *
 * The real sessions root is measured in hundreds of group directories,
 * within the process limits on both supported platforms. Correctness here
 * outranks saving handles with a recursive watch that drops updates.
 *
 * Debounce, not filtering, is what keeps a working agent from becoming a
 * frame per append: an append legitimately changes a row (lastActivityAt,
 * byteSize), so dropping append events outright would silently freeze the
 * list during exactly the session a person is watching. The quiet window
 * below folds a burst into one notification instead, and the max-wait cap
 * keeps a never-quiet tree from starving the watcher.
 */

import type { FSWatcher } from "node:fs";
import { readdirSync, statSync, watch } from "node:fs";
import { basename, join } from "node:path";
import { SESSION_FILE_RE } from "./scanner.ts";

/**
 * Quiet window that folds one burst of filesystem events into a single
 * notification. A writing agent fires an event per append; the interesting
 * change is the session appearing or its row moving, which happens once per
 * burst, so the notification waits for this much silence before firing.
 */
export const SESSION_WATCH_QUIET_MS = 400;

/**
 * The longest a continuously busy tree can hold a notification back. A pure
 * trailing edge would starve under an agent that appends without ever going
 * quiet, which is precisely when someone is watching the list, so after this
 * much continuous activity the notification fires mid-burst.
 */
export const SESSION_WATCH_MAX_WAIT_MS = 5000;
export const SESSION_WATCH_RECONCILE_MS = 1000;

export interface SessionWatchOptions {
  /** Override of the quiet window, for tests driving real timers. */
  quietMs?: number;
  /** Override of the max-wait cap, for tests driving real timers. */
  maxWaitMs?: number;
  /** Override of the session-file reconciliation interval. */
  reconcileMs?: number;
  /** Override of node:fs watch for deterministic missed-event tests. */
  watchFactory?: (path: string, listener: (eventType: string, filename: string | Buffer | null) => void) => FSWatcher;
  /**
   * Watcher failure report. The watcher stops itself after raising one: a
   * dead watch is a pull-only daemon (every `sessions` ask still rebuilds
   * from disk), which is a degradation to report, not a loop to retry
   * blind.
   */
  onError?: (err: unknown) => void;
}

/** A running watch over the sessions root. `stop` is idempotent. */
export interface SessionWatch {
  stop(): void;
}
interface DirectoryFingerprint {
  directoryMtimeMs: number;
  sessionCount: number;
  totalBytes: number;
  latestSessionMtimeMs: number;
}

function sameFingerprint(left: DirectoryFingerprint | undefined, right: DirectoryFingerprint): boolean {
  return (
    left !== undefined &&
    left.directoryMtimeMs === right.directoryMtimeMs &&
    left.sessionCount === right.sessionCount &&
    left.totalBytes === right.totalBytes &&
    left.latestSessionMtimeMs === right.latestSessionMtimeMs
  );
}

/**
 * Watch `sessionsRoot` and its current group directories, and call `onChanged`
 * once per debounced burst of session-file events. Returns null when the root
 * is missing or is not a directory: a machine that has never run OMP has nothing to watch,
 * and a watcher over a missing directory would be a standing error rather
 * than a feature. The first session run creates the root, and the next
 * `watch` call after that finds it, so callers retry rather than cache the
 * null.
 */
export function watchSessionFiles(
  sessionsRoot: string,
  onChanged: () => void,
  opts: SessionWatchOptions = {},
): SessionWatch | null {
  try {
    if (!statSync(sessionsRoot).isDirectory()) return null;
  } catch {
    return null;
  }

  const quietMs = opts.quietMs ?? SESSION_WATCH_QUIET_MS;
  const maxWaitMs = opts.maxWaitMs ?? SESSION_WATCH_MAX_WAIT_MS;
  const reconcileMs = opts.reconcileMs ?? SESSION_WATCH_RECONCILE_MS;
  const watchPath = opts.watchFactory ?? ((path, listener) => watch(path, listener));
  let timer: Timer | null = null;
  let reconcileTimer: Timer | null = null;
  let firstPendingAt: number | undefined;
  let stopped = false;

  const arm = (): void => {
    if (stopped) return;
    // The clock the max-wait cap measures starts at the first event of a
    // burst, not at each re-arm: otherwise every arriving event would reset
    // both edges and a busy tree would never notify at all.
    firstPendingAt ??= Date.now();
    if (timer !== null) clearTimeout(timer);
    const heldFor = Date.now() - firstPendingAt;
    const delay = Math.max(0, Math.min(quietMs, maxWaitMs - heldFor));
    timer = setTimeout(() => {
      timer = null;
      firstPendingAt = undefined;
      onChanged();
    }, delay);
  };

  const directoryWatchers = new Map<string, FSWatcher>();
  const directoryFingerprints = new Map<string, DirectoryFingerprint>();
  let rootWatcher: FSWatcher | null = null;

  const fail = (err: unknown): void => {
    if (stopped) return;
    opts.onError?.(err);
    stop();
  };

  const watchDirectory = (name: string): boolean => {
    if (stopped || directoryWatchers.has(name)) return false;
    const path = join(sessionsRoot, name);
    let watcher: FSWatcher;
    try {
      watcher = watchPath(path, (_event, filename) => {
        if (typeof filename !== "string" || SESSION_FILE_RE.test(basename(filename))) arm();
      });
    } catch (err) {
      try {
        if (!statSync(path).isDirectory()) return false;
      } catch {
        return false;
      }
      throw err;
    }
    watcher.on("error", err => {
      if (stopped) return;
      try {
        if (!statSync(path).isDirectory()) {
          watcher.close();
          directoryWatchers.delete(name);
          arm();
          return;
        }
      } catch {
        watcher.close();
        directoryWatchers.delete(name);
        arm();
        return;
      }
      fail(err);
    });
    directoryWatchers.set(name, watcher);
    return true;
  };

  function* reconcileDirectories(): Generator<void, boolean> {
    if (stopped) return false;
    const live = new Set<string>();
    let changed = false;
    let units = 0;
    for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(sessionsRoot, entry.name);
      let fingerprint: DirectoryFingerprint;
      try {
        const directoryMtimeMs = statSync(path).mtimeMs;
        let sessionCount = 0;
        let totalBytes = 0;
        let latestSessionMtimeMs = 0;
        for (const file of readdirSync(path, { withFileTypes: true })) {
          if (!file.isFile() || !SESSION_FILE_RE.test(file.name)) continue;
          const metadata = statSync(join(path, file.name));
          sessionCount += 1;
          totalBytes += metadata.size;
          latestSessionMtimeMs = Math.max(latestSessionMtimeMs, metadata.mtimeMs);
          units += 1;
          if (units >= 8) {
            units = 0;
            yield;
            if (stopped) return false;
          }
        }
        fingerprint = { directoryMtimeMs, sessionCount, totalBytes, latestSessionMtimeMs };
      } catch {
        continue;
      }
      live.add(entry.name);
      if (watchDirectory(entry.name) || !sameFingerprint(directoryFingerprints.get(entry.name), fingerprint))
        changed = true;
      directoryFingerprints.set(entry.name, fingerprint);
      units += 1;
      if (units >= 8) {
        units = 0;
        yield;
        if (stopped) return false;
      }
    }
    for (const [name, watcher] of directoryWatchers) {
      if (live.has(name)) continue;
      watcher.close();
      directoryWatchers.delete(name);
      changed = true;
    }
    for (const name of directoryFingerprints.keys()) {
      if (live.has(name)) continue;
      directoryFingerprints.delete(name);
      changed = true;
    }
    return changed;
  }

  const reconcileCooperatively = async (): Promise<boolean> => {
    const work = reconcileDirectories();
    let step = work.next();
    while (!step.done) {
      await Bun.sleep(0);
      step = work.next();
    }
    return step.value;
  };

  let reconcileInFlight = false;
  let reconcileAgain = false;
  const requestReconcile = (): void => {
    if (stopped) return;
    if (reconcileInFlight) {
      reconcileAgain = true;
      return;
    }
    reconcileInFlight = true;
    void (async () => {
      try {
        do {
          reconcileAgain = false;
          if (await reconcileCooperatively()) arm();
        } while (reconcileAgain && !stopped);
      } catch (err) {
        fail(err);
      } finally {
        reconcileInFlight = false;
      }
    })();
  };

  try {
    rootWatcher = watchPath(sessionsRoot, (_event, filename) => {
      if (stopped) return;
      if (typeof filename !== "string") arm();
      requestReconcile();
    });
    rootWatcher.on("error", fail);
    requestReconcile();
    reconcileTimer = setInterval(requestReconcile, reconcileMs);
  } catch (err) {
    rootWatcher?.close();
    for (const watcher of directoryWatchers.values()) watcher.close();
    opts.onError?.(err);
    return null;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (reconcileTimer !== null) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    rootWatcher?.close();
    rootWatcher = null;
    for (const watcher of directoryWatchers.values()) watcher.close();
    directoryWatchers.clear();
  }

  return { stop };
}
