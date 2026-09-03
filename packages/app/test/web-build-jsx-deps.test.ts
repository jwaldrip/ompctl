/**
 * The production web build must parse dependencies that ship JSX in `.js`
 * files. The gate runs in its own process because Vite owns a process-global
 * esbuild service that unrelated render tests can otherwise stop mid-build.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const APP_ROOT = join(import.meta.dir, "..");

describe("the web build and untranspiled JSX dependencies", () => {
  test("the QR dependency parses, is emitted as JavaScript, and fails precisely without its transform", async () => {
    const run = Bun.spawn({
      cmd: ["bun", "scripts/check-web-build-jsx-deps.ts"],
      cwd: APP_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  }, 60_000);
});
