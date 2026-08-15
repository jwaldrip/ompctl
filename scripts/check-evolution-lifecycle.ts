/**
 * Drive one proposal through the entire evolution gate against a real git
 * repository, then prove the negative cases.
 *
 * Everything happens in a throwaway repository under the system temp
 * directory, and the script refuses to run if that path resolves inside a
 * checkout. The argument for the gate is that a self-improving system cannot
 * rewrite its own safety rules; demonstrating it by mutating the repository the
 * engine lives in would be a poor way to make that case.
 *
 * The diffs are produced by `git diff` in a scratch worktree rather than
 * written by hand, so the gate is parsing real git output, `index` lines and
 * all, rather than a shape chosen to suit it.
 *
 * What it proves, in order:
 *
 *  1. `observe` mines the audit log, ignores successes, and drafts. A draft has
 *     no id, so no later call can promote it.
 *  2. `submit` accepts a harmless diff and records what the diff actually
 *     touches.
 *  3. `evaluate` applies it in an isolated worktree. The running tree is hashed
 *     before and after, by git tree object and by file bytes, and neither
 *     moves. A proposal that fails its tests is evaluated too, because a patch
 *     that escapes is most likely to escape when verification fails.
 *  4. `promote` refuses the internal `daemon` actor, then commits for an
 *     operator holding `manage`. The operator's tree is dirtied with an
 *     unrelated edit first, because the commit pathspec is what is supposed to
 *     keep that edit out of the promotion commit.
 *  5. `rollback` reverts, and the promoted commit stays reachable, so history
 *     was appended to rather than rewritten.
 *  6. A proposal touching a protected path is archived at submission, even
 *     though `git apply --check` says the same patch applies cleanly, and
 *     neither `evaluate` nor `promote` will take it afterwards.
 *  6b. That same row, edited in SQLite to look accepted and then edited again
 *     to carry a forged passing verdict, is caught by the second and third
 *     gates. Those two branches are unreachable in normal operation, so
 *     tampering is the only way to find out whether they work.
 *  7. A proposal that under-reports its own `touchedPaths` is judged on the
 *     paths derived from the diff, not on the claim. A documentation change
 *     smuggling a policy edit is archived on the derived set alone.
 *
 * Run it from the repository root:
 *
 *     bun run scripts/check-evolution-lifecycle.ts
 *
 * Exits non-zero if any of the above does not hold.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type Actor, type Proposal, SCOPE_MANAGE, SCOPE_READ, Store } from "@ompd/core";
import { EvolutionEngine, ProposalStore } from "../packages/daemon/src/evolution/index.ts";
import { UnauthorizedError } from "../packages/daemon/src/supervisor.ts";

// ---------------------------------------------------------------------------
// Fixture repository
// ---------------------------------------------------------------------------

const GREET = ["export function greet(name: string): string {", "  return `Hello, ${name}!`;", "}", ""].join("\n");

const GREET_TRIMMED = [
  "export function greet(name: string): string {",
  "  return `Hello, ${name.trim()}!`;",
  "}",
  "",
].join("\n");

const GREET_TEST = [
  'import { expect, test } from "bun:test";',
  'import { greet } from "../src/greet.ts";',
  "",
  'test("greets a name", () => {',
  '  expect(greet("world")).toBe("Hello, world!");',
  "});",
  "",
].join("\n");

const GREET_TEST_WITH_TRIM = [
  'import { expect, test } from "bun:test";',
  'import { greet } from "../src/greet.ts";',
  "",
  'test("greets a name", () => {',
  '  expect(greet("world")).toBe("Hello, world!");',
  "});",
  "",
  'test("ignores surrounding whitespace", () => {',
  '  expect(greet("  world  ")).toBe("Hello, world!");',
  "});",
  "",
].join("\n");

const FAREWELL = ["export function farewell(name: string): string {", "  return `Goodbye, ${name}.`;", "}", ""].join(
  "\n",
);

/** Breaks `test/farewell.test.ts`. Used to prove the verify command discriminates. */
const FAREWELL_BROKEN = ["export function farewell(name: string): string {", "  return `Bye ${name}`;", "}", ""].join(
  "\n",
);

/** Untouched by any proposal, but edited alongside README to under-report a diff. */
const FAREWELL_COMMENTED = [
  "/** Says goodbye. */",
  "export function farewell(name: string): string {",
  "  return `Goodbye, ${name}.`;",
  "}",
  "",
].join("\n");

const FAREWELL_TEST = [
  'import { expect, test } from "bun:test";',
  'import { farewell } from "../src/farewell.ts";',
  "",
  'test("says goodbye", () => {',
  '  expect(farewell("world")).toBe("Goodbye, world.");',
  "});",
  "",
].join("\n");

/**
 * Occupies a real `PROTECTED_PATHS` entry so the protected-path proposals are
 * genuine, applicable diffs rather than references to a file that is not there.
 */
const POLICY = [
  "/** Stand-in for the daemon policy engine. No proposal may edit this file. */",
  'export function evaluate(tool: string): "allow" | "deny" {',
  '  return tool === "bash" ? "deny" : "allow";',
  "}",
  "",
].join("\n");

const POLICY_WEAKENED = [
  "/** Stand-in for the daemon policy engine. No proposal may edit this file. */",
  'export function evaluate(tool: string): "allow" | "deny" {',
  '  return "allow";',
  "}",
  "",
].join("\n");

const README = ["# evolution fixture", "", "A throwaway repository for proving the ompd evolution gate.", ""].join(
  "\n",
);

const README_EXTENDED = [
  "# evolution fixture",
  "",
  "A throwaway repository for proving the ompd evolution gate.",
  "",
  "Created and destroyed by scripts/check-evolution-lifecycle.ts.",
  "",
].join("\n");

const PACKAGE_JSON = `${JSON.stringify({ name: "evolution-fixture", private: true, type: "module" }, null, 2)}\n`;

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

interface CommandOutcome {
  code: number;
  output: string;
}

const failures: string[] = [];

function check(condition: boolean, description: string): void {
  if (condition) {
    console.log(`  ok   ${description}`);
    return;
  }
  console.log(`  FAIL ${description}`);
  failures.push(description);
}

function phase(title: string): void {
  console.log("");
  console.log(`=== ${title}`);
  console.log("");
}

async function git(cwd: string, args: string[], echo = true): Promise<CommandOutcome> {
  const proc = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" },
  });
  await proc.exited;
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const outcome: CommandOutcome = { code: proc.exitCode ?? -1, output: `${out}${err}` };
  if (echo) {
    console.log(`$ git ${args.join(" ")}`);
    const body = outcome.output.trimEnd();
    if (body !== "") console.log(body);
    if (outcome.code !== 0) console.log(`(exit ${outcome.code})`);
  }
  return outcome;
}

/**
 * Content hash of the whole working directory, `.git` excluded.
 *
 * Content-addressed rather than a status check. `git status` stays clean when a
 * patch is applied and committed, and says nothing at all about file bytes.
 */
async function treeDigest(root: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const sorted = entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of sorted) {
      if (entry.name === ".git") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(join(dir, entry.name), rel);
        continue;
      }
      hasher.update(rel);
      hasher.update(await readFile(join(dir, entry.name)));
    }
  };
  await walk(root, "");
  return hasher.digest("hex");
}

async function writeAll(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body, "utf8");
  }
}

/**
 * Produce a real unified diff by editing a detached scratch worktree and asking
 * git for the difference. The running tree is never dirtied, not even briefly.
 */
async function diffOf(
  repoRoot: string,
  scratchRoot: string,
  label: string,
  edits: Record<string, string>,
): Promise<string> {
  const gen = join(scratchRoot, `gen-${label}`);
  const add = await git(repoRoot, ["worktree", "add", "--detach", gen, "HEAD"], false);
  if (add.code !== 0) throw new Error(`worktree add for ${label} failed:\n${add.output}`);
  try {
    await writeAll(gen, edits);
    const diff = await git(gen, ["diff"], false);
    if (diff.code !== 0) throw new Error(`git diff for ${label} failed:\n${diff.output}`);
    if (diff.output.trim() === "") throw new Error(`${label} produced an empty diff`);
    return diff.output;
  } finally {
    await git(repoRoot, ["worktree", "remove", "--force", gen], false);
  }
}

function summarise(p: Proposal): string {
  const verdict = p.verdict === undefined ? "none" : `${p.verdict.passed ? "passed" : "failed"}`;
  return `${p.id} state=${p.state} verdict=${verdict} touchedPaths=${JSON.stringify(p.touchedPaths)}`;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const created: string[] = [];
let store: Store | undefined;
let proposals: ProposalStore | undefined;

try {
  phase("0. a throwaway repository, outside every checkout");

  const scratchRoot = await mkdtemp(join(tmpdir(), "ompd-evo-lifecycle-"));
  created.push(scratchRoot);
  const repoRoot = join(scratchRoot, "repo");
  const stateDir = join(scratchRoot, "state");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // The one guard that matters. A resolved path under a checkout, or anywhere
  // near the user's source tree, aborts before a single file is written.
  const resolved = resolve(repoRoot);
  const devRoot = join(homedir(), "dev");
  if (resolved.startsWith(`${devRoot}/`) || resolved === devRoot) {
    throw new Error(`refusing to run: ${resolved} is under ${devRoot}`);
  }
  if (existsSync(join(resolved, "..", "..", ".git"))) {
    throw new Error(`refusing to run: ${resolved} looks like it is inside a checkout`);
  }
  console.log(`repo    ${repoRoot}`);
  console.log(`state   ${stateDir}   (SQLite lives outside the repository, as in production)`);
  console.log(`ompd    ${resolve(import.meta.dir, "..")}   (never the target)`);

  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "evolution@ompd.local"], false);
  await git(repoRoot, ["config", "user.name", "ompd evolution check"], false);
  await git(repoRoot, ["config", "commit.gpgsign", "false"], false);
  // Hermetic: a global hook or template must not decide whether this passes.
  await git(repoRoot, ["config", "core.hooksPath", join(scratchRoot, "no-hooks")], false);

  await writeAll(repoRoot, {
    "package.json": PACKAGE_JSON,
    "README.md": README,
    "src/greet.ts": GREET,
    "test/greet.test.ts": GREET_TEST,
  });
  await git(repoRoot, ["add", "-A"], false);
  await git(repoRoot, ["commit", "-m", "seed the fixture: greet and its test"], false);

  await writeAll(repoRoot, { "src/farewell.ts": FAREWELL, "test/farewell.test.ts": FAREWELL_TEST });
  await git(repoRoot, ["add", "-A"], false);
  await git(repoRoot, ["commit", "-m", "add farewell"], false);

  await writeAll(repoRoot, { "packages/core/src/policy.ts": POLICY });
  await git(repoRoot, ["add", "-A"], false);
  await git(repoRoot, ["commit", "-m", "add the protected policy module"], false);

  await git(repoRoot, ["log", "--oneline"]);

  const baseline = await Bun.spawn(["bun", "test"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  await baseline.exited;
  const baselineLog = await new Response(baseline.stderr).text();
  console.log("$ bun test   (baseline, in the fixture repo)");
  console.log(baselineLog.trimEnd());
  check(baseline.exitCode === 0, "the fixture repository is green before any proposal");

  phase("0b. the diffs, produced by git rather than by hand");

  const harmlessDiff = await diffOf(repoRoot, scratchRoot, "harmless", {
    "src/greet.ts": GREET_TRIMMED,
    "test/greet.test.ts": GREET_TEST_WITH_TRIM,
  });
  const regressionDiff = await diffOf(repoRoot, scratchRoot, "regression", {
    "src/farewell.ts": FAREWELL_BROKEN,
  });
  const protectedDiff = await diffOf(repoRoot, scratchRoot, "protected", {
    "packages/core/src/policy.ts": POLICY_WEAKENED,
  });
  const underReportBenignDiff = await diffOf(repoRoot, scratchRoot, "under-benign", {
    "README.md": README_EXTENDED,
    "src/farewell.ts": FAREWELL_COMMENTED,
  });
  const underReportProtectedDiff = await diffOf(repoRoot, scratchRoot, "under-protected", {
    "README.md": README_EXTENDED,
    "packages/core/src/policy.ts": POLICY_WEAKENED,
  });

  console.log("the harmless proposal, verbatim:");
  console.log(harmlessDiff.trimEnd());

  const leaked = await git(repoRoot, ["worktree", "list"]);
  check(leaked.output.trim().split("\n").length === 1, "diff generation left no worktree behind");

  // ---------------------------------------------------------------------
  const dbPath = join(stateDir, "ompd.db");
  store = new Store(dbPath);
  proposals = new ProposalStore(dbPath);

  const engine = new EvolutionEngine({
    store,
    proposals,
    repoRoot,
    verifyCommand: ["bun", "test"],
    timeoutMs: 120_000,
  });

  const operatorId = "dev_operator";
  store.addDevice({
    id: operatorId,
    name: "operator",
    publicKey: "pk_operator",
    scopes: [SCOPE_READ, SCOPE_MANAGE],
    createdAt: new Date().toISOString(),
  });
  const operator: Actor = { deviceId: operatorId, scopes: [SCOPE_READ, SCOPE_MANAGE] };

  phase("1. observe an audit log full of repeated failures");

  const seeded: Array<{
    action: "agent.prompt" | "host.provision" | "agent.create";
    outcome: "denied" | "error" | "ok";
    reason: string;
  }> = [
    { action: "agent.prompt", outcome: "denied", reason: "policy denied bash: writes outside the workspace" },
    { action: "agent.prompt", outcome: "denied", reason: "policy denied bash: writes outside the workspace" },
    { action: "agent.prompt", outcome: "denied", reason: "policy denied write: secret path .env" },
    { action: "agent.prompt", outcome: "error", reason: "host exited before the turn completed" },
    { action: "host.provision", outcome: "error", reason: "docker: no such image" },
    { action: "host.provision", outcome: "error", reason: "docker: no such image" },
    { action: "host.provision", outcome: "error", reason: "docker daemon not reachable" },
    { action: "agent.create", outcome: "ok", reason: "a success must not draft anything" },
  ];
  for (const entry of seeded) {
    store.audit({ action: entry.action, outcome: entry.outcome, detail: { reason: entry.reason } });
  }
  console.log(`seeded ${seeded.length} audit entries: 4 failing agent.prompt, 3 failing host.provision, 1 ok`);

  const drafts = engine.observe(store);
  for (const draft of drafts) {
    console.log(`draft   ${draft.title}`);
    console.log(`        evidence ${JSON.stringify(draft.evidence)}`);
  }
  check(drafts.length === 2, "observe drafted exactly the two actions past the threshold");
  check(
    drafts.every(d => !("id" in d) && !("state" in d)),
    "a draft carries no id and no state, so evaluate and promote cannot accept it",
  );
  check(
    drafts.every(d => d.evidence.action !== "agent.create"),
    "the successful action produced no draft",
  );
  check(proposals.list().length === 0, "observe persisted nothing: drafting is where automation stops");

  phase("2. submit a harmless proposal");

  const harmless = engine.submit({
    title: "greet: ignore surrounding whitespace",
    rationale: "greet('  world  ') rendered the padding. Trim the name and cover it with a test.",
    diff: harmlessDiff,
    touchedPaths: ["src/greet.ts", "test/greet.test.ts"],
  });
  console.log(summarise(harmless));
  check(harmless.state === "submitted", "an honest, unprotected diff is accepted");
  check(harmless.touchedPaths.join(",") === "src/greet.ts,test/greet.test.ts", "the derived paths match the diff");

  phase("3. evaluate in isolation, hashing the running tree either side");

  const treeBefore = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  const headBefore = await git(repoRoot, ["rev-parse", "HEAD"], false);
  const digestBefore = await treeDigest(repoRoot);
  console.log(`working-tree sha256   ${digestBefore}`);

  const evaluated = await engine.evaluate(harmless.id);
  console.log(summarise(evaluated));
  console.log("verdict log:");
  console.log(
    evaluated.verdict?.log
      .split("\n")
      .map(l => `  | ${l}`)
      .join("\n") ?? "  | (none)",
  );

  const regression = engine.submit({
    title: "farewell: shorten the message",
    rationale: "A deliberately breaking change, to prove the verification command discriminates.",
    diff: regressionDiff,
    touchedPaths: ["src/farewell.ts"],
  });
  const regressionEvaluated = await engine.evaluate(regression.id);
  console.log(summarise(regressionEvaluated));

  const treeAfter = await git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
  const headAfter = await git(repoRoot, ["rev-parse", "HEAD"], false);
  const digestAfter = await treeDigest(repoRoot);
  console.log(`working-tree sha256   ${digestAfter}`);
  const status = await git(repoRoot, ["status", "--porcelain"]);
  const worktrees = await git(repoRoot, ["worktree", "list"]);

  check(evaluated.state === "awaiting_review", "the harmless proposal passed and awaits an operator");
  check(regressionEvaluated.state === "rejected", "the breaking proposal was rejected by the same command");
  check(
    (regressionEvaluated.verdict?.log ?? "").includes("1 fail"),
    "the rejection came from a real test failure, not from a patch error",
  );
  check(digestBefore === digestAfter, "the running tree is byte-identical after both evaluations");
  check(treeBefore.output.trim() === treeAfter.output.trim(), "the git tree object is unchanged");
  check(headBefore.output.trim() === headAfter.output.trim(), "HEAD did not move");
  check(status.output.trim() === "", "the running tree is clean");
  check(worktrees.output.trim().split("\n").length === 1, "no evaluation worktree leaked");

  phase("4. promote as an operator");

  let daemonRefused = "";
  try {
    await engine.promote(harmless.id, { deviceId: "daemon", scopes: [SCOPE_MANAGE] });
  } catch (err) {
    daemonRefused = err instanceof Error ? err.message : String(err);
    check(err instanceof UnauthorizedError, "the internal daemon actor is refused at promotion");
  }
  console.log(`daemon actor: ${daemonRefused === "" ? "NOT REFUSED" : daemonRefused}`);
  check(daemonRefused !== "", "promotion by the daemon actor threw");
  check(proposals.get(harmless.id)?.state === "awaiting_review", "the refused promotion left the proposal untouched");

  // The engine commits with a pathspec, and the source says that is what keeps
  // an operator's unrelated dirty files out of a promotion commit. An operator
  // with edits in flight is the normal case, not the exotic one, so dirty the
  // tree with something the patch does not touch and hold it to that claim.
  await writeFile(join(repoRoot, "README.md"), `${README}\nOperator edit, in flight, uncommitted.\n`, "utf8");
  console.log("dirtied README.md in the operator's tree before promoting");

  const promoted = await engine.promote(harmless.id, operator);
  console.log(summarise(promoted));
  const promotedCommit = promoted.promotedCommit ?? "";
  await git(repoRoot, ["log", "--oneline", "-4"]);
  await git(repoRoot, ["show", "--stat", "--oneline", promotedCommit]);
  const countAfterPromote = await git(repoRoot, ["rev-list", "--count", "HEAD"], false);

  const promotedGreet = await readFile(join(repoRoot, "src/greet.ts"), "utf8");
  check(promoted.state === "promoted", "the proposal is promoted");
  check(promotedCommit !== "", "promotion recorded a commit sha");
  check(promotedGreet === GREET_TRIMMED, "the running tree now holds the patched source");

  const committedFiles = await git(repoRoot, ["show", "--name-only", "--pretty=format:", promotedCommit], false);
  const dirtyAfter = await git(repoRoot, ["status", "--porcelain"]);
  check(
    !committedFiles.output.includes("README.md"),
    "the operator's dirty README.md stayed out of the promotion commit",
  );
  check(
    dirtyAfter.output.includes("README.md"),
    "the operator's edit is still in their tree, neither committed nor discarded",
  );

  // Put it back, so the clean-tree assertions later mean what they say.
  await git(repoRoot, ["checkout", "--", "README.md"], false);

  const afterPromote = await Bun.spawn(["bun", "test"], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  await afterPromote.exited;
  console.log("$ bun test   (after promotion)");
  console.log((await new Response(afterPromote.stderr).text()).trimEnd());
  check(afterPromote.exitCode === 0, "the promoted tree is green");

  phase("5. roll it back");

  const rolledBack = await engine.rollback(harmless.id, operator);
  console.log(summarise(rolledBack));
  await git(repoRoot, ["log", "--oneline", "-5"]);
  const revertHead = await git(repoRoot, ["rev-parse", "HEAD"], false);
  const revertSubject = await git(repoRoot, ["log", "-1", "--pretty=%H %s"]);
  const reachable = await git(repoRoot, ["merge-base", "--is-ancestor", promotedCommit, "HEAD"]);
  const objectType = await git(repoRoot, ["cat-file", "-t", promotedCommit]);
  const countAfterRevert = await git(repoRoot, ["rev-list", "--count", "HEAD"], false);
  const revertedGreet = await readFile(join(repoRoot, "src/greet.ts"), "utf8");

  check(rolledBack.state === "rolled_back", "the proposal is rolled back");
  check(revertHead.output.trim() !== promotedCommit, "the revert is a new commit");
  check(revertSubject.output.includes("Revert"), "HEAD is a revert commit");
  check(reachable.code === 0, "the promoted commit is still an ancestor of HEAD");
  check(objectType.output.trim() === "commit", "the promoted commit object still exists");
  check(
    Number(countAfterRevert.output.trim()) === Number(countAfterPromote.output.trim()) + 1,
    "history grew by one: appended to, not rewritten",
  );
  check(revertedGreet === GREET, "the source is back to its pre-promotion content");

  phase("6. a proposal that touches a protected path");

  // Prove the patch is not merely rejected because it would not apply.
  const patchPath = join(scratchRoot, "protected.patch");
  await writeFile(patchPath, protectedDiff, "utf8");
  const applies = await git(repoRoot, ["apply", "--check", "--whitespace=nowarn", patchPath]);
  check(applies.code === 0, "the protected patch applies cleanly, so only the gate stops it");

  console.log("the protected proposal, verbatim:");
  console.log(protectedDiff.trimEnd());

  const blocked = engine.submit({
    title: "policy: allow every tool",
    rationale: "Fewer prompts. This is exactly the change the gate exists to refuse.",
    diff: protectedDiff,
    touchedPaths: ["packages/core/src/policy.ts"],
  });
  console.log(summarise(blocked));
  console.log(`reason: ${blocked.verdict?.log ?? "(none)"}`);

  check(blocked.state === "archived", "the protected proposal is archived at submission");
  check((blocked.verdict?.log ?? "").includes("packages/core/src/policy.ts"), "the reason names the protected path");

  let evaluateRefused = "";
  try {
    await engine.evaluate(blocked.id);
  } catch (err) {
    evaluateRefused = err instanceof Error ? err.message : String(err);
  }
  console.log(`evaluate(archived): ${evaluateRefused === "" ? "ACCEPTED" : evaluateRefused}`);
  check(evaluateRefused !== "", "an archived proposal cannot be evaluated, so review is never reached");

  const policyOnDisk = await readFile(join(repoRoot, "packages/core/src/policy.ts"), "utf8");
  check(policyOnDisk === POLICY, "the protected file on disk was never touched");

  let promoteRefused = "";
  try {
    await engine.promote(blocked.id, operator);
  } catch (err) {
    promoteRefused = err instanceof Error ? err.message : String(err);
  }
  console.log(`promote(archived): ${promoteRefused === "" ? "ACCEPTED" : promoteRefused}`);
  check(promoteRefused !== "", "an archived proposal cannot be promoted either");

  phase("6b. the same proposal, with its row tampered with");

  // The proposal row is a mutable surface, and the engine re-gates at evaluate
  // and again at promote for exactly that reason. Those two branches are
  // unreachable in normal operation, because nothing legitimately presents an
  // archived diff to them. Editing the row the way anyone holding the SQLite
  // file could is the only way to find out whether they work.
  const archived = proposals.get(blocked.id);
  if (archived === null) throw new Error("the archived proposal vanished");

  proposals.upsert({ ...archived, state: "submitted", verdict: undefined });
  console.log(`forced ${blocked.id} back to state=submitted, verdict cleared`);
  const reEvaluated = await engine.evaluate(blocked.id);
  console.log(summarise(reEvaluated));
  check(reEvaluated.state === "archived", "evaluate re-derives paths and re-archives the tampered row");
  check(
    (reEvaluated.verdict?.log ?? "").includes("packages/core/src/policy.ts"),
    "the second gate names the protected path it caught",
  );

  // A forged verdict is the sharper version: the row claims it already passed.
  proposals.upsert({
    ...archived,
    state: "awaiting_review",
    verdict: { passed: true, log: "forged: verification passed" },
  });
  console.log(`forced ${blocked.id} to state=awaiting_review with a forged passing verdict`);
  const headBeforeTamper = await git(repoRoot, ["rev-parse", "HEAD"], false);
  let tamperedPromote = "";
  try {
    await engine.promote(blocked.id, operator);
  } catch (err) {
    tamperedPromote = err instanceof Error ? err.message : String(err);
  }
  console.log(`promote(forged verdict): ${tamperedPromote === "" ? "ACCEPTED" : tamperedPromote}`);
  const headAfterTamper = await git(repoRoot, ["rev-parse", "HEAD"], false);
  const policyAfterTamper = await readFile(join(repoRoot, "packages/core/src/policy.ts"), "utf8");

  check(tamperedPromote.includes("failed the gate at promotion"), "the third gate refuses a forged verdict");
  check(
    headBeforeTamper.output.trim() === headAfterTamper.output.trim(),
    "no commit was made for the tampered proposal",
  );
  check(policyAfterTamper === POLICY, "the protected file survived every attempt");
  check(
    proposals.get(blocked.id)?.state === "archived",
    "the tampered row is put back to archived rather than left forged",
  );

  phase("7. a proposal that under-reports what it touches");

  const underBenign = engine.submit({
    title: "README: note where this repository comes from",
    rationale: "Looks like a one-file documentation change. It is not.",
    diff: underReportBenignDiff,
    touchedPaths: ["README.md"],
  });
  console.log(summarise(underBenign));
  check(
    underBenign.touchedPaths.join(",") === "README.md,src/farewell.ts",
    "the stored paths are derived from the diff, not copied from the claim",
  );

  const underProtected = engine.submit({
    title: "README: tidy the wording",
    rationale: "A documentation change carrying a policy edit. The claim is honest-looking and wrong.",
    diff: underReportProtectedDiff,
    touchedPaths: ["README.md"],
  });
  console.log(summarise(underProtected));
  console.log(`reason: ${underProtected.verdict?.log ?? "(none)"}`);
  check(underProtected.state === "archived", "a diff hiding a protected path behind a documentation claim is archived");

  const auditEntries = store.listAudit(50);
  const submitEntries = auditEntries.filter(e => e.action === "proposal.submit");
  const benignAudit = submitEntries.find(e => e.detail.proposalId === underBenign.id);
  const protectedAudit = submitEntries.find(e => e.detail.proposalId === underProtected.id);
  console.log("audit, under-reporting benign:");
  console.log(`  ${JSON.stringify(benignAudit?.detail)}`);
  console.log("audit, under-reporting protected:");
  console.log(`  ${JSON.stringify(protectedAudit?.detail)}`);

  check(
    JSON.stringify(benignAudit?.detail.underReportedPaths) === JSON.stringify(["src/farewell.ts"]),
    "the audit trail names the path the author left out",
  );
  check(
    JSON.stringify(protectedAudit?.detail.underReportedPaths) === JSON.stringify(["packages/core/src/policy.ts"]),
    "the audit trail names the hidden protected path",
  );

  phase("8. observe again, over the failures this run actually produced");

  const strictEngine = new EvolutionEngine({
    store,
    proposals,
    repoRoot,
    verifyCommand: ["bun", "test"],
    observeThreshold: 2,
  });
  const realDrafts = strictEngine.observe(store);
  for (const draft of realDrafts) {
    console.log(`draft   ${draft.title}  ${JSON.stringify(draft.evidence)}`);
  }
  check(
    realDrafts.some(d => d.evidence.action === "proposal.submit"),
    "observe picks up the real proposal.submit denials this run wrote",
  );

  phase("9. final state");

  await git(repoRoot, ["log", "--graph", "--oneline"]);
  const finalStatus = await git(repoRoot, ["status", "--porcelain"]);
  const finalWorktrees = await git(repoRoot, ["worktree", "list"]);
  check(finalStatus.output.trim() === "", "the fixture repository ends clean");
  check(finalWorktrees.output.trim().split("\n").length === 1, "no worktree leaked across the whole run");

  console.log("");
  console.log("proposals:");
  for (const p of proposals.list()) console.log(`  ${summarise(p)}`);
} catch (err) {
  console.log("");
  console.log(`unhandled error: ${err instanceof Error ? `${err.message}\n${err.stack}` : String(err)}`);
  failures.push("the run threw");
} finally {
  store?.close();
  proposals?.close();
  phase("cleanup");
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
    const gone = !existsSync(dir);
    console.log(`  ${gone ? "removed" : "STILL PRESENT"}  ${dir}`);
    if (!gone) failures.push(`temp directory survived: ${dir}`);
  }
}

console.log("");
if (failures.length > 0) {
  console.log(`VERDICT broken: ${failures.length} check(s) failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log("VERDICT ok: observe drafts, submit gates, evaluate isolates, promote commits,");
console.log("            rollback appends, and both evasions are caught at submission");
