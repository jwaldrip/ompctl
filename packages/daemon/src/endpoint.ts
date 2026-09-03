/**
 * Where a daemon records the address it is actually serving.
 *
 * Runtime state, not configuration: written at `listen` and removed at `stop`,
 * the way a pid file is. It exists because a daemon started with `--port 0`,
 * or with a `--port` that never reached the config file, is otherwise
 * unfindable by the next command someone types. A file left behind by a
 * daemon that was killed points at a dead port, which is the right failure:
 * the next command reports "not running" instead of silently talking to
 * whatever else has since taken that port from the config file.
 *
 * A leaf module rather than a corner of `daemon.ts`, because the pre-start
 * guard in `tunnel/sole-daemon.ts` reads this file before the composition
 * root has been built, and importing the composition root from there would
 * be a cycle.
 */

import { join } from "node:path";

export function endpointPath(home: string): string {
  return join(home, "endpoint");
}
