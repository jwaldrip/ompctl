/**
 * What the gateway pays before it reads a single byte of a session.
 *
 * Every `session_history` and `session_tail` frame begins with
 * `index.pathFor(sessionId)`, so whatever that costs is on the critical path of
 * every session open and every "load earlier" press. Reads only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core/store";
import { SessionIndex } from "../packages/daemon/src/sessions/session-index.ts";

const SAMPLES = 12;

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const storeDir = mkdtempSync(join(tmpdir(), "ompd-pathfor-"));
try {
  const store = new Store(join(storeDir, "state.sqlite"));
  const root = join(homedir(), ".omp", "agent", "sessions");
  const index = new SessionIndex({ store, sessionsRoot: root });

  // A real id from the real corpus, so the lookup walks what a real open walks.
  const built = await index.query({ includeArchived: true });
  if (built.length === 0) {
    console.log("no sessions on this machine; nothing to measure");
  } else {
    const first = built[0]?.id ?? "";
    const middle = built[Math.floor(built.length / 2)]?.id ?? "";
    const last = built.at(-1)?.id ?? "";
    const absent = "00000000-0000-0000-0000-000000000000";

    console.log(`corpus: ${built.length} sessions\n`);
    console.log(["case", "p50ms", "min", "max"].map(h => h.padStart(12)).join(""));
    for (const [label, id] of [
      ["first row", first],
      ["middle row", middle],
      ["last row", last],
      ["absent id", absent],
    ] as const) {
      const times: number[] = [];
      await index.pathFor(id);
      for (let i = 0; i < SAMPLES; i += 1) {
        const started = performance.now();
        await index.pathFor(id);
        times.push(performance.now() - started);
      }
      console.log(
        [
          label.padEnd(12),
          percentile(times, 0.5).toFixed(2),
          Math.min(...times).toFixed(2),
          Math.max(...times).toFixed(2),
        ]
          .map((c, i) => (i === 0 ? c : c.padStart(12)))
          .join(""),
      );
    }

    // And the index build itself, which the fleet list pays once per pairing
    // and which `pathFor` deliberately avoids.
    const buildTimes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      await index.query({ includeArchived: true });
      buildTimes.push(performance.now() - started);
    }
    console.log(`\nindex.query p50: ${percentile(buildTimes, 0.5).toFixed(2)} ms`);
  }
  store.close();
} finally {
  rmSync(storeDir, { recursive: true, force: true });
}
