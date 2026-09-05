import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertCompletePackagePlan,
  PACKAGE_TEST_SUITES,
  runPackageSuites,
  UNIT_TEST_EXCLUSIONS,
} from "./run-package-tests.ts";

describe("the package test process boundary", () => {
  test("accounts for every workspace exactly once", () => {
    assertCompletePackagePlan(resolve(import.meta.dir, ".."));
    const ids = PACKAGE_TEST_SUITES.map(suite => suite.id);
    expect(ids).toEqual(["acp", "app", "cli", "core", "daemon", "hub", "omp-extension", "tunnel", "scripts"]);
    expect(UNIT_TEST_EXCLUSIONS).toEqual(["e2e", "site"]);
  });

  test("a failed child keeps later suites visible and makes the aggregate fail", async () => {
    const started: string[] = [];
    let message = "";
    try {
      await runPackageSuites(
        [
          { id: "first", command: ["bun", "test", "first"] },
          { id: "broken", command: ["bun", "test", "broken"] },
          { id: "last", command: ["bun", "test", "last"] },
        ],
        async suite => {
          started.push(suite.id);
          return suite.id === "broken" ? 17 : 0;
        },
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(started).toEqual(["first", "broken", "last"]);
    expect(message).toContain("broken (exit 17)");
  });

  test("an injected child-process failure fails closed", async () => {
    let message = "";
    try {
      await runPackageSuites([{ id: "injected-failure", command: ["bun", "-e", "process.exit(23)"] }]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("injected-failure (exit 23)");
  });

  test("a newly-testable excluded package makes the plan fail instead of silently skipping it", () => {
    const root = mkdtempSync(join(tmpdir(), "package-test-plan-"));
    try {
      for (const name of ["acp", "app", "cli", "core", "daemon", "e2e", "hub", "omp-extension", "site", "tunnel"]) {
        const dir = join(root, "packages", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ scripts: name === "site" ? { test: "bun test" } : {} }),
        );
      }
      expect(() => assertCompletePackagePlan(root)).toThrow("site now has a unit-test contract");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
