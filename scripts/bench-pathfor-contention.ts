/**
 * Why `pathFor` is fast in isolation and slow when a person actually taps.
 *
 * The walk yields the event loop once per group directory. On an idle loop
 * that is free. But the moment a client lists sessions, `SessionIndex` starts
 * a background warm pass that also yields, repeatedly, and every one of
 * `pathFor`'s turns then queues behind a slice of it. The tap that matters
 * lands in exactly that window: the fleet list is what the operator sees
 * first, and the row they press is on it.
 *
 * Reads only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core/store";
import { SessionIndex } from "../packages/daemon/src/sessions/session-index.ts";

const SAMPLES = 9;
const pct = (a: readonly number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;

async function sample(index: SessionIndex, ids: readonly string[]): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const id = ids[i % ids.length];
    if (id === undefined) continue;
    const started = performance.now();
    await index.pathFor(id);
    times.push(performance.now() - started);
  }
  return times;
}

const dir = mkdtempSync(join(tmpdir(), "ompd-contend-"));
try {
  const root = join(homedir(), ".omp", "agent", "sessions");

  // Fresh store per case, so one case's warmed count cache cannot shorten the
  // next case's warm pass and flatter the result.
  const idle = new SessionIndex({ store: new Store(join(dir, "a.sqlite")), sessionsRoot: root });
  const rows = await idle.query({ includeArchived: true });
  if (rows.length === 0) {
    console.log("no sessions on this machine; nothing to measure");
  } else {
    const ids = rows.map(r => r.id);
    // Case 1: the loop has nothing else on it. Wait for the warm pass the
    // query above kicked off to finish before measuring.
    await new Promise<void>(r => setTimeout(r, 4_000));
    const quiet = await sample(idle, ids);

    // Case 2: measured while a warm pass is genuinely in flight, which is what
    // a tap right after the list lands actually hits.
    const busyIndex = new SessionIndex({ store: new Store(join(dir, "b.sqlite")), sessionsRoot: root });
    const warming = busyIndex.query({ includeArchived: true });
    const busy = await sample(busyIndex, ids);
    await warming;

    const show = (label: string, t: readonly number[]) =>
      console.log(
        `${label.padEnd(26)} p50 ${pct(t, 0.5).toFixed(1).padStart(7)} ms   min ${Math.min(...t)
          .toFixed(1)
          .padStart(7)}   max ${Math.max(...t).toFixed(1).padStart(7)}`,
      );
    console.log(`corpus: ${rows.length} sessions\n`);
    show("idle event loop", quiet);
    show("warm pass in flight", busy);
    console.log(`\ncontention multiple: ${(pct(busy, 0.5) / Math.max(pct(quiet, 0.5), 0.001)).toFixed(0)}x`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
