/**
 * Where `pathFor`'s milliseconds actually go: the directory scan, or the event
 * loop turn it takes between every directory.
 *
 * Reads only. This exists to separate two costs that a single wall-clock
 * number cannot, which is the difference between fixing the scan and fixing
 * the scheduling.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findSessionFile, findSessionFileIter } from "../packages/daemon/src/sessions/scanner.ts";

const root = join(homedir(), ".omp", "agent", "sessions");
const groups = readdirSync(root, { withFileTypes: true })
  .filter(e => e.isDirectory())
  .map(e => e.name);

/** A real id whose group sits late in readdir order: the worst realistic case. */
let lateId: string | null = null;
let lateIdx = -1;
for (let i = groups.length - 1; i >= 0 && lateId === null; i -= 1) {
  const dir = groups[i];
  if (dir === undefined) continue;
  for (const f of readdirSync(join(root, dir))) {
    const m = /_([0-9a-f-]{36})\.jsonl$/.exec(f);
    if (m?.[1] !== undefined) {
      lateId = m[1];
      lateIdx = i;
      break;
    }
  }
}
if (lateId === null) {
  console.log("no sessions on this machine; nothing to measure");
  process.exit(0);
}
const id = lateId;

const pct = (a: readonly number[], p: number) => [...a].sort((x, y) => x - y)[Math.floor(a.length * p)] ?? 0;
const time = (fn: () => unknown, n = 15) => {
  const t: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = performance.now();
    fn();
    t.push(performance.now() - s);
  }
  return +pct(t, 0.5).toFixed(3);
};
const timeAsync = async (fn: () => Promise<unknown>, n = 15) => {
  const t: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = performance.now();
    await fn();
    t.push(performance.now() - s);
  }
  return +pct(t, 0.5).toFixed(3);
};

const drive = async (every: number): Promise<string | undefined> => {
  const steps = findSessionFileIter(id, root);
  let step = steps.next();
  let n = 0;
  while (!step.done) {
    n += 1;
    if (n % every === 0) await new Promise<void>(r => setImmediate(r));
    step = steps.next();
  }
  return step.value;
};

const path = findSessionFile(id, root);

console.log({
  groupDirs: groups.length,
  lateGroupIndex: lateIdx,
  // The scan with no yields at all: pure readdir cost.
  syncScanMs: time(() => findSessionFile(id, root)),
  // Exactly what `pathFor` does today: one event loop turn per directory.
  yieldPerDirMs: await timeAsync(() => drive(1)),
  yieldPer16Ms: await timeAsync(() => drive(16)),
  yieldPer32Ms: await timeAsync(() => drive(32)),
  // What a cache hit would cost instead of the whole walk.
  cacheHitExistsSyncMs: path === undefined ? null : time(() => existsSync(path), 300),
  // The floor: that many bare event loop turns and nothing else.
  bareYieldsMs: await timeAsync(async () => {
    for (let i = 0; i < groups.length; i += 1) await new Promise<void>(r => setImmediate(r));
  }),
});
