/**
 * The sessions-root watcher behind the gateway's live session list: turns
 * "a session file appeared, changed, or went away on disk" into one
 * debounced notification, so a socket that asked for the index once keeps
 * receiving refreshed `sessions` frames without asking again.
 *
 * node:fs `watch` with `recursive: true` is the whole mechanism, verified
 * on both platforms this daemon's tests run on (macOS locally, Linux in
 * CI, Bun 1.3.14 on each): it reports events for files inside directories
 * created after the watch started, which is exactly how a new project's
 * first session arrives, and it reports appends to existing files, which
 * is how an active session's lastActivity row moves. One handle for the
 * whole tree matters here: this machine's real sessions root holds ~190
 * cwd-group directories, and a per-directory fanout would spend a file
 * descriptor on each of them for as long as the daemon lives.
 *
 * Debounce, not filtering, is what keeps a working agent from becoming a
 * frame per append: an append legitimately changes a row (lastActivityAt,
 * byteSize), so dropping append events outright would silently freeze the
 * list during exactly the session a person is watching. The quiet window
 * below folds a burst into one notification instead, and the max-wait cap
 * keeps a never-quiet tree from starving the watcher.
 */

import type { FSWatcher } from "node:fs";
import { statSync, watch } from "node:fs";
import { basename, join, sep } from "node:path";
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

export interface SessionWatchOptions {
  /** Override of the quiet window, for tests driving real timers. */
  quietMs?: number;
  /** Override of the max-wait cap, for tests driving real timers. */
  maxWaitMs?: number;
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

/**
 * Watch `sessionsRoot` recursively and call `onChanged` once per debounced
 * burst of session-file events. Returns null when the root is missing or is
 * not a directory: a machine that has never run OMP has nothing to watch,
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
  let timer: Timer | null = null;
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

  const fsWatcher: FSWatcher = watch(sessionsRoot, { recursive: true }, (_event, filename) => {
    if (typeof filename !== "string") {
      // A platform that reports no filename still reported a change inside
      // this tree; refusing to arm here would turn a naming gap into a
      // silent list. The debounce keeps the cost of that honesty bounded.
      arm();
      return;
    }
    if (filename.includes(sep)) {
      // An entry inside a group directory: only a session file can change
      // the catalog, so editor temp files and Finder droppings cost nothing
      // here.
      if (SESSION_FILE_RE.test(basename(filename))) arm();
      return;
    }
    // A root-level entry. A group directory appearing is how a new
    // project's sessions arrive, and a file created inside a just-created
    // directory does not reliably report under its own name (verified
    // against macOS FSEvents), so the directory event itself must arm. The
    // stat tells a group directory from junk at the root, so droppings
    // still cost nothing.
    try {
      if (statSync(join(sessionsRoot, filename)).isDirectory()) arm();
    } catch {
      // Vanished between the event and the stat: it reported a departure,
      // and departures inside group directories report under their own
      // names, which the branch above already arms on.
    }
  });
  fsWatcher.on("error", err => {
    opts.onError?.(err);
    stop();
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    fsWatcher.close();
  }

  return { stop };
}
