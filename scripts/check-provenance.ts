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
import { existsSync, readFileSync } from "node:fs";

/**
 * The identifiers that must never appear, supplied from outside this repository.
 *
 * They used to live here as a literal array, reasoning that the audit and its
 * pattern should travel together so a reviewer sees both at once. That is sound
 * for a private repo and precisely wrong for a public one: the list is a roster
 * of family, client, and vendor names, so publishing it leaks exactly what it
 * exists to keep out. The old version even had to exclude itself from its own
 * sweep to stay green, which is the tell -- a checker that must skip a file to
 * pass is describing a real hit.
 *
 * So the list is an input now. `OMPCTL_PROVENANCE_TERMS` holds it directly
 * (newline or comma separated), or `OMPCTL_PROVENANCE_TERMS_FILE` points at a
 * file. Locally that file lives outside any checkout; in CI it is a secret.
 *
 * Absent or empty is a hard failure, never an empty pattern: a sweep for nothing
 * matches nothing and would report a clean tree for every repository on earth.
 */
function loadTerms(): string[] {
  const inline = process.env.OMPCTL_PROVENANCE_TERMS;
  const path = process.env.OMPCTL_PROVENANCE_TERMS_FILE;
  let raw: string;
  if (inline !== undefined && inline.trim().length > 0) {
    raw = inline;
  } else if (path !== undefined && path.trim().length > 0) {
    if (!existsSync(path)) {
      console.error(`  FAIL OMPCTL_PROVENANCE_TERMS_FILE points at a missing file: ${path}`);
      process.exit(2);
    }
    raw = readFileSync(path, "utf8");
  } else {
    console.error("  FAIL no terms supplied; set OMPCTL_PROVENANCE_TERMS or OMPCTL_PROVENANCE_TERMS_FILE");
    console.error("       refusing to sweep for an empty pattern, which would pass against anything");
    process.exit(2);
  }

  const terms = raw
    .split(/[\n,]/)
    .map(t => t.trim())
    .filter(t => t.length > 0);
  if (terms.length === 0) {
    console.error("  FAIL the supplied term list is empty after parsing");
    process.exit(2);
  }
  // A stray metacharacter would silently change what the sweep matches.
  const bad = terms.filter(t => /[\\^$.*+?()[\]{}|]/.test(t));
  if (bad.length > 0) {
    console.error(`  FAIL ${bad.length} term(s) contain regex metacharacters; supply plain literals`);
    process.exit(2);
  }
  return terms;
}

const TERMS = loadTerms();

const PATTERN = TERMS.join("|");

/** Batched well under the argument limit; the exact size is not load-bearing. */
const BATCH = 250;

/**
 * A shallow checkout makes this audit meaningless: `actions/checkout` defaults to
 * depth 1, so `rev-list --all` returns a single commit and the sweep passes while
 * covering nothing. Any real history is far above this, so a count below it means
 * the checkout, not the repository, is what is clean.
 */
const MIN_REVS = 20;

interface Failure {
  readonly reason: string;
}

function git(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.error !== undefined) throw new Error(`git ${args[0]} could not run: ${r.error.message}`);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

/**
 * The revisions this run is answerable for: the checked-out tree, plus the
 * commits this branch adds on top of its base.
 *
 * It used to be `rev-list --all`, and that is a guard that fails the wrong
 * person. `actions/checkout` fetches with `fetch-depth: 0`, so every remote ref
 * the fetch brought down is reachable, and one contaminated branch turned every
 * other PR's run red -- for content that branch's author could see and this
 * one's author could not. A check that fails PR B because of branch A gets
 * ignored, and an ignored guard is worth nothing.
 *
 * So the scope is what this PR actually put there. The base is
 * `OMPCTL_PROVENANCE_BASE`, else the pull request's own base branch from
 * `GITHUB_BASE_REF`, else `origin/main`, else `main`. HEAD is always included,
 * because the tree being merged is the thing that matters most and a branch
 * with no commits of its own must still be swept.
 *
 * Note what this does NOT do: it does not exclude a path, and it does not
 * weaken a term. Everything this branch introduces is still swept, and main's
 * own runs still sweep main. What is gone is one branch's history landing in
 * another branch's result.
 */
function scopeRevs(repo: string): { revs: string[]; base: string | undefined } {
  const candidates = [
    process.env.OMPCTL_PROVENANCE_BASE,
    process.env.GITHUB_BASE_REF === undefined ? undefined : `origin/${process.env.GITHUB_BASE_REF}`,
    "origin/main",
    "main",
  ].filter((c): c is string => c !== undefined && c.length > 0);

  for (const base of candidates) {
    if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`], repo).status !== 0) continue;
    const r = git(["rev-list", "HEAD", "--not", base], repo);
    if (r.status !== 0) continue;
    const own = r.stdout.split("\n").filter(l => l.length > 0);
    const head = git(["rev-parse", "HEAD"], repo).stdout.trim();
    return { revs: own.includes(head) ? own : [head, ...own], base };
  }

  // No base to compare against: sweep this branch's own history rather than
  // every ref. A clone with no `main` is a local checkout, not a pull request.
  const r = git(["rev-list", "HEAD"], repo);
  if (r.status !== 0) throw new Error(`rev-list failed in ${repo}: ${r.stderr.trim()}`);
  return { revs: r.stdout.split("\n").filter(l => l.length > 0), base: undefined };
}

/** Every rev in the repository, used only for the shallow-checkout floor and the proof mirror. */
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
    // No pathspec exclusion. The terms live outside the checkout, so nothing
    // tracked here must be skipped to stay green -- and a checker that has to skip
    // a file to pass was describing a real hit.
    const r = git(["grep", "-l", "-I", "-i", "-E", PATTERN, ...batch, "--", "."], repo);
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

// The floor stays measured against the whole repository, because what it
// detects is a shallow checkout: a depth-1 fetch makes any sweep vacuous no
// matter how it is scoped. The sweep itself runs on the scoped set.
const all = revs(repo);
if (all.length < MIN_REVS) {
  console.error(
    `  FAIL only ${all.length} rev(s) visible; expected at least ${MIN_REVS}. ` +
      "This is a shallow checkout, so the sweep would prove nothing. " +
      "Use actions/checkout with fetch-depth: 0.",
  );
  process.exit(1);
}

const scope = scopeRevs(repo);
console.log(
  scope.base === undefined
    ? `  ok   ${all.length} revs reachable; sweeping this branch's own ${scope.revs.length}, no base ref to compare against`
    : `  ok   ${all.length} revs reachable; sweeping the ${scope.revs.length} this branch adds over ${scope.base}`,
);

const { hits, failures } = sweep(repo, scope.revs);
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

/**
 * Hits already published that cannot be removed without rewriting public history,
 * which is a human's decision rather than this script's.
 *
 * A baseline is how a guard rots into decoration, so it is exact rather than a
 * pattern: one `<commit>:<path>` per line, holding commit ids and a path, never a
 * term. Two rules keep it honest. Any hit outside it fails, so new contamination
 * is still caught. And any entry that no longer hits also fails, so the file
 * cannot outlive what it describes.
 */
function loadBaseline(): Set<string> {
  const path = "scripts/provenance-baseline.txt";
  if (!existsSync(path)) return new Set();
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map(l => l.replace(/#.*$/, "").trim())
      .filter(l => l.length > 0),
  );
}

const baseline = loadBaseline();
const unexpected = hits.filter(h => !baseline.has(h));
const stale = [...baseline].filter(b => !hits.includes(b));

if (baseline.size > 0) {
  console.log(
    `\n  NOTE ${baseline.size} acknowledged hit(s) in already-published history; ` +
      "removing them needs a history rewrite and a force-push",
  );
}

if (stale.length > 0) {
  console.error(`\n  FAIL ${stale.length} baseline entr(ies) no longer match; the baseline is stale:`);
  for (const s of stale.slice(0, 5)) console.error(`       ${s}`);
  console.error("       remove them, or the file claims an exposure that is gone");
  process.exit(1);
}

if (unexpected.length > 0) {
  const paths = new Map<string, number>();
  for (const line of unexpected) {
    const path = line.slice(line.indexOf(":") + 1);
    paths.set(path, (paths.get(path) ?? 0) + 1);
  }
  console.error(`\n  FAIL ${unexpected.length} unacknowledged hit(s) across ${paths.size} path(s):`);
  for (const [path, count] of [...paths].sort((a, b) => b[1] - a[1])) {
    console.error(`       ${String(count).padStart(5)} commits  ${path}`);
  }
  process.exit(1);
}

console.log(
  baseline.size > 0
    ? "\nProvenance holds: no NEW private identifier is reachable; only the acknowledged history remains."
    : "\nProvenance clean: no private identifier is reachable from any ref.",
);
