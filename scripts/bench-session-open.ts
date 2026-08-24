/**
 * The tap that actually matters: the first one, right after the fleet list
 * lands.
 *
 * Earlier passes measured `pathFor` in a tight loop and reported a p50 that
 * hid the only sample a person experiences. A phone connects, asks for the
 * session index, sees rows, and presses one. That press is the FIRST lookup
 * after the query, and it is the one this measures -- one sample per trial,
 * fresh store per trial so no cache from the previous trial flatters it.
 *
 * Reads only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core/store";
import { readSessionHistory } from "../packages/daemon/src/sessions/history.ts";
import { SessionIndex } from "../packages/daemon/src/sessions/session-index.ts";

const TRIALS = 8;
const pct = (a: readonly number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
const show = (label: string, t: readonly number[]) =>
  console.log(
    `${label.padEnd(34)} p50 ${pct(t, 0.5).toFixed(1).padStart(7)}   min ${Math.min(...t)
      .toFixed(1)
      .padStart(7)}   max ${Math.max(...t)
      .toFixed(1)
      .padStart(7)}   (ms)`,
  );

const dir = mkdtempSync(join(tmpdir(), "ompd-firsttap-"));
try {
  const root = join(homedir(), ".omp", "agent", "sessions");
  const pathFirst: number[] = [];
  const pathSecond: number[] = [];
  const openTotal: number[] = [];
  let corpus = 0;
  let picked = "";

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const store = new Store(join(dir, `t${trial}.sqlite`));
    const index = new SessionIndex({ store, sessionsRoot: root });
    const rows = await index.query({ includeArchived: true });
    if (rows.length === 0) break;
    corpus = rows.length;
    // The row a person is most likely to press: the top of the default sort.
    const id = rows[0]?.id ?? "";
    picked = id;

    // Exactly what the gateway does for a `session_history` frame, in order.
    const t0 = performance.now();
    const path = await index.pathFor(id);
    const t1 = performance.now();
    if (path !== undefined) await readSessionHistory(path);
    const t2 = performance.now();

    pathFirst.push(t1 - t0);
    openTotal.push(t2 - t0);

    // The same lookup again, immediately: what a "load earlier" press pays.
    const t3 = performance.now();
    await index.pathFor(id);
    pathSecond.push(performance.now() - t3);

    store.close();
  }

  if (corpus === 0) {
    console.log("no sessions on this machine; nothing to measure");
  } else {
    console.log(`corpus: ${corpus} sessions, ${TRIALS} trials, one sample each\n`);
    show("pathFor, FIRST after index query", pathFirst);
    show("pathFor, second (load earlier)", pathSecond);
    show("pathFor + first history page", openTotal);
    console.log(`\nsession sampled: ${picked}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
