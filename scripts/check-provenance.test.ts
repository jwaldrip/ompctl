/**
 * The sweep must answer for this PR and only this PR.
 *
 * The regression this file exists for is not hypothetical: `rev-list --all`
 * plus `actions/checkout` at `fetch-depth: 0` made one contaminated branch turn
 * every other pull request red, for content that PR's author could not see and
 * could not remove. A guard that fails the wrong person gets ignored.
 *
 * So there are two assertions and they are a pair. A hit reachable only from an
 * unrelated remote ref must not fail this run, and the same hit in HEAD must.
 * Either one alone is satisfiable by a broken checker: the first by a checker
 * that detects nothing, the second by the checker we already had.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "check-provenance.ts");
const TERM = "acme-internal-codename";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): void {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if ((r.status ?? 1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/**
 * A repository deep enough to clear the shallow-checkout floor, with `main`,
 * a feature branch, and a remote-tracking ref standing in for another PR.
 */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "provenance-scope-"));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.test");
  git(dir, "config", "user.name", "Test");
  git(dir, "commit", "-q", "--allow-empty", "-m", "root");
  // The floor is a real check, so the fixture has to be a real history.
  for (let i = 0; i < 25; i += 1) git(dir, "commit", "-q", "--allow-empty", "-m", `filler ${i}`);
  return dir;
}

function commitFile(dir: string, name: string, body: string, message: string): void {
  writeFileSync(join(dir, name), body);
  git(dir, "add", name);
  git(dir, "commit", "-q", "-m", message);
}

function run(dir: string): { status: number; out: string } {
  const r = spawnSync("bun", [SCRIPT], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, OMPCTL_PROVENANCE_TERMS: TERM, OMPCTL_PROVENANCE_BASE: "main" },
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("the sweep's scope", () => {
  test("a hit reachable only from an unrelated ref does not fail this branch", () => {
    const dir = repo();

    // Another PR's branch, contaminated, published as a remote-tracking ref
    // exactly as `fetch-depth: 0` would leave it.
    git(dir, "checkout", "-q", "-b", "other");
    commitFile(dir, "theirs.md", `a note about ${TERM}\n`, "theirs: contaminated");
    git(dir, "update-ref", "refs/remotes/origin/other", "HEAD");
    git(dir, "checkout", "-q", "main");
    git(dir, "branch", "-q", "-D", "other");

    // This PR, clean.
    git(dir, "checkout", "-q", "-b", "mine");
    commitFile(dir, "mine.md", "nothing private here\n", "mine: clean");

    const result = run(dir);
    expect(result.out).toContain("sweeping the");
    expect(result.status).toBe(0);
  });

  test("the same hit in this branch's own tree fails", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "mine");
    commitFile(dir, "mine.md", `a note about ${TERM}\n`, "mine: contaminated");

    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.out).toContain("unacknowledged hit");
    expect(result.out).toContain("mine.md");
  });

  test("a hit this branch introduced and then deleted still fails, because the commit carries it", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "mine");
    commitFile(dir, "mine.md", `a note about ${TERM}\n`, "mine: contaminated");
    rmSync(join(dir, "mine.md"));
    git(dir, "commit", "-q", "-am", "mine: removed it from the tree");

    // Deleting the file is not removing the content: the earlier commit in this
    // branch's own range still holds it, and this branch is answerable for it.
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.out).toContain("mine.md");
  });

  test("a branch identical to its base inherits the base's hits rather than failing on them", () => {
    const dir = repo();
    commitFile(dir, "main.md", `a note about ${TERM}\n`, "main: contaminated");
    // `mine` == `main`, so this branch introduced nothing and touched nothing.
    // HEAD is still swept -- the hit is found -- and then attributed to the
    // base, which is where the run that must fail on it lives.
    git(dir, "checkout", "-q", "-b", "mine");

    const result = run(dir);
    expect(result.out).toContain("main.md");
    expect(result.out).toContain("belong to that branch's own run");
    expect(result.status).toBe(0);
  });

  test("a hit already in the base, in a file this branch never touched, does not fail this branch", () => {
    const dir = repo();
    commitFile(dir, "theirs.md", `a note about ${TERM}\n`, "main: contaminated before this branch existed");
    git(dir, "checkout", "-q", "-b", "mine");
    commitFile(dir, "mine.md", "nothing private here\n", "mine: clean");

    // The base's own run still fails on `theirs.md`. This branch cannot fix it
    // and must not be blocked by it.
    const result = run(dir);
    expect(result.out).toContain("belong to that branch's own run");
    expect(result.status).toBe(0);
  });

  test("touching an already-dirty file makes the hit this branch's own", () => {
    const dir = repo();
    commitFile(dir, "theirs.md", `a note about ${TERM}\n`, "main: contaminated");
    git(dir, "checkout", "-q", "-b", "mine");
    commitFile(dir, "theirs.md", `a note about ${TERM}, now edited here\n`, "mine: edited it");

    // Inheritance is by untouched path, not by term. Edit the file and the hit
    // is yours, which is what stops this from hiding a new hit added to a file
    // that already had one.
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.out).toContain("theirs.md");
  });
});
