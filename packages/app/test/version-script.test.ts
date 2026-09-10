import { describe, expect, test } from "bun:test";

const repoRoot = `${import.meta.dir}/../../..`;
const script = `${import.meta.dir}/../scripts/lib/version.sh`;

async function runVersion(env: Record<string, string | undefined>) {
  const child = Bun.spawn(["/bin/bash", script, "--build-number"], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
}

describe("release build number resolution", () => {
  test("uses the full checkout's Git commit count", async () => {
    const expected = Bun.spawnSync(["git", "rev-list", "--count", "HEAD"], { cwd: repoRoot }).stdout.toString().trim();
    const result = await runVersion({
      ...process.env,
      OMPD_BUILD_NUMBER: "",
      OMPD_VERSION_CODE: "",
    });
    expect(result).toEqual({ stdout: expected, stderr: "", exitCode: 0 });
  });

  test("rejects an invalid explicit build number instead of reusing a floor", async () => {
    const result = await runVersion({
      ...process.env,
      OMPD_BUILD_NUMBER: "not-a-number",
      OMPD_VERSION_NAME: "0.1.0",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Build number must be a positive integer");
  });

  test("fails when neither Git history nor an explicit build number is available", async () => {
    const result = await runVersion({
      PATH: "/nonexistent",
      HOME: process.env.HOME,
      OMPD_BUILD_NUMBER: "",
      OMPD_VERSION_CODE: "",
      OMPD_VERSION_NAME: "0.1.0",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("git is unavailable");
  });
});
