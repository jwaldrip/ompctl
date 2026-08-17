/**
 * Prove no private identifier is reachable from any ref in this repository.
 *
 * This exists because the obvious one-liner is unsafe at scale:
 *
 *     git grep -l -I -i -E '<pattern>' $(git rev-list --all)
 *
 * Every rev becomes an argv entry. At about 25k commits that exceeds the OS
 * argument limit and git dies with `Argument list too long`. If stderr is
 * discarded, or the exit code is read from a pipeline whose last stage succeeded,
 * the run prints no hits and reads exactly like a clean repository. That happened
 * while auditing a sibling repo here: a sweep reported zero hits from a command
 * that never executed.
 *
 * So this script:
 *
 *  - batches revs so the command always runs;
 *  - treats ANY git failure as a failed audit rather than as an absence of hits;
 *  - refuses to report success unless the pattern is proven to still match
 *    something, so a broken regex cannot pass as a clean tree.
 *
 * Usage:
 *   bun run scripts/check-provenance.ts
 *   bun run scripts/check-provenance.ts --prove-against <path-to-contaminated.git>
 *
 * `--prove-against` runs the same pattern over a known-contaminated mirror and
 * requires hits there. Without it the script still self-checks the pattern
 * against a synthetic string, which catches a mangled regex but not a regex that
 * merely stopped matching real historical content.
 */
import { spawnSync } from "node:child_process";

/**
 * The identifiers that must never appear. Kept here rather than in a workflow so
 * the audit and its pattern travel together and a reviewer sees both at once.
 */
const TERMS = [
  "waldrip family",
  "waldrip-net",
  "monarch",
  "jillian",
  "decklan",
  "phoneware",
  "netsapiens",
  "autotask",
  "peplink",
  "starlink",
  "reinventtelecom",
  "gigsmart",
  "clerk-chat",
] as const;

const PATTERN = TERMS.join("|");

/** Batched well under the argument limit; the exact size is not load-bearing. */
const BATCH = 250;

interface Failure {
  readonly reason: string;
}

function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) throw new Error(`git ${args[0]} could not run: ${r.error.message}`);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

function revs(repo: string): string[] {
  const r = git(["rev-list", "--all"], repo);
  if (r.status !== 0) throw new Error(`rev-list failed in ${repo}: ${r.stderr.trim()}`);
  return r.stdout.split("\n").filter(l => l.length > 0);
}

/**
 * Every hit line, as `<sha>:<path>`.
 *
 * `git grep` exits 1 when a batch simply has no match, which is not an error.
 * Anything else is: an unreadable object or a bad pattern must fail the audit
 * rather than quietly contribute zero hits.
 */
function sweep(repo: string, all: string[]): { hits: string[]; failures: Failure[] } {
  const hits: string[] = [];
  const failures: Failure[] = [];
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const r = git(["grep", "-l", "-I", "-i", "-E", PATTERN, ...batch], repo);
    if (r.status === 0) {
      hits.push(...r.stdout.split("\n").filter(l => l.length > 0));
    } else if (r.status !== 1 || r.stderr.trim().length > 0) {
      failures.push({ reason: `batch at ${i}: status ${r.status}: ${r.stderr.trim().slice(0, 200)}` });
    }
  }
  return { hits, failures };
}

/** A mangled pattern must not be able to pass as a clean repository. */
function patternMatchesSynthetic(): boolean {
  const re = new RegExp(PATTERN, "i");
  return TERMS.every(t => re.test(`prefix ${t} suffix`));
}

const repo = process.cwd();
const proveIdx = process.argv.indexOf("--prove-against");
const proveAgainst = proveIdx >= 0 ? process.argv[proveIdx + 1] : undefined;

console.log(`  pattern covers ${TERMS.length} terms`);
if (!patternMatchesSynthetic()) {
  console.error("  FAIL the pattern does not match its own terms; the audit would be vacuous");
  process.exit(1);
}
console.log("  ok   pattern matches every term it declares");

const all = revs(repo);
console.log(`  ok   ${all.length} revs, swept in batches of ${BATCH}`);

const { hits, failures } = sweep(repo, all);
if (failures.length > 0) {
  console.error(`  FAIL ${failures.length} batch(es) did not run; this is NOT a clean result`);
  for (const f of failures.slice(0, 5)) console.error(`       ${f.reason}`);
  process.exit(1);
}

if (proveAgainst !== undefined) {
  const mirrorRevs = revs(proveAgainst);
  const mirror = sweep(proveAgainst, mirrorRevs);
  if (mirror.failures.length > 0) {
    console.error(`  FAIL the proof sweep itself did not run: ${mirror.failures[0]?.reason}`);
    process.exit(1);
  }
  if (mirror.hits.length === 0) {
    console.error(`  FAIL ${proveAgainst} produced no hits, so a clean result here proves nothing`);
    process.exit(1);
  }
  console.log(`  ok   proof mirror still yields ${mirror.hits.length} hits, so the sweep can detect contamination`);
}

if (hits.length > 0) {
  const paths = new Map<string, number>();
  for (const line of hits) {
    const path = line.slice(line.indexOf(":") + 1);
    paths.set(path, (paths.get(path) ?? 0) + 1);
  }
  console.error(`\n  FAIL ${hits.length} hit(s) across ${paths.size} path(s):`);
  for (const [path, count] of [...paths].sort((a, b) => b[1] - a[1])) {
    console.error(`       ${String(count).padStart(5)} commits  ${path}`);
  }
  process.exit(1);
}

console.log("\nProvenance clean: no private identifier is reachable from any ref.");
