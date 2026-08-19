/**
 * Where the session index actually spends its time on this machine's real
 * corpus, phase by phase, outside the daemon so a slow phase cannot take the
 * daemon down while it is being measured.
 *
 * The synthetic corpus used to develop the non-blocking build reported a
 * 227ms first paint over 14GB, while the operator's own tree still wedges the
 * daemon. One of the two is not measuring what the other is, and this says
 * which.
 *
 * Usage: bun run scripts/probe-index-phases.ts [sessionsRoot]
 */

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import { scanSessionFiles } from "../packages/daemon/src/sessions/scanner.ts";
import { SessionIndex } from "../packages/daemon/src/sessions/session-index.ts";

const root = process.argv[2] ?? join(homedir(), ".omp/agent/sessions");
const store = new Store(join(mkdtempSync(join(tmpdir(), "idx-probe-")), "probe.db"));

function ms(t0: number): string {
  return `${(performance.now() - t0).toFixed(0)}ms`;
}

const t0 = performance.now();
const files = scanSessionFiles(root);
console.log(`  scan: ${files.length} files in ${ms(t0)}`);
const under = files.filter(f => f.sizeBytes <= 50 * 1024 * 1024);
const bytes = under.reduce((sum, f) => sum + f.sizeBytes, 0);
console.log(`  countable: ${under.length} files, ${(bytes / 1e9).toFixed(2)} GB under the ceiling`);

const index = new SessionIndex({ store, sessionsRoot: root });

const t1 = performance.now();
const first = await index.queryWithWarm({});
console.log(`  first paint: ${first.sessions.length} rows in ${ms(t1)}`);
const withCounts = first.sessions.filter(r => r.messageCount !== null).length;
console.log(`  rows with counts at first paint: ${withCounts}`);

if (first.warmed) {
  const t2 = performance.now();
  const warmed = await first.warmed;
  console.log(`  warm pass: ${warmed.length} rows in ${ms(t2)}`);
  console.log(`  rows with counts after warm: ${warmed.filter(r => r.messageCount !== null).length}`);
} else {
  console.log("  warm pass: nothing needed warming");
}
