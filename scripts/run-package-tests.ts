#!/usr/bin/env bun
/**
 * Run every unit-test contract in a fresh Bun process.
 *
 * `bun test packages/...` put unrelated package suites in one JS realm. App
 * happy-dom registrations, RNW module mocks, and Paper's stylesheet then leaked
 * into daemon/core tests that create real child processes. This runner keeps
 * package-level contracts intact while putting the process boundary where the
 * suites need it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PackageTestSuite {
  id: string;
  command: readonly string[];
}

/** The two workspaces with no generic unit-test contract. */
export const UNIT_TEST_EXCLUSIONS = ["e2e", "site"] as const;

/**
 * Each command is the existing test contract for one package, or the existing
 * root `bun test packages/<name>` contract where that package has no script.
 * Packages run sequentially because their suites create processes, sockets, and
 * temporary repositories. Daemon test files have isolated temp roots and ports,
 * so a four-worker pool keeps their module globals fresh without oversubscribing
 * the two-core CI runner or exhausting Bun's IPC descriptors.
 */
export const PACKAGE_TEST_SUITES: readonly PackageTestSuite[] = [
  { id: "acp", command: ["bun", "test", "packages/acp"] },
  { id: "app", command: ["bun", "--cwd", "packages/app", "test"] },
  { id: "cli", command: ["bun", "test", "packages/cli"] },
  { id: "core", command: ["bun", "test", "packages/core"] },
  { id: "daemon", command: ["bun", "test", "--parallel=4", "packages/daemon"] },
  { id: "hub", command: ["bun", "test", "packages/hub"] },
  { id: "omp-extension", command: ["bun", "test", "packages/omp-extension"] },
  { id: "tunnel", command: ["bun", "test", "packages/tunnel"] },
  { id: "web", command: ["bun", "--cwd", "packages/web", "test"] },
  { id: "scripts", command: ["bun", "test", "scripts"] },
];

export function assertCompletePackagePlan(projectRoot: string, suites = PACKAGE_TEST_SUITES): void {
  const ids = suites.map(suite => suite.id);
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate package test suite: ${ids.join(", ")}`);

  const packages = readdirSync(join(projectRoot, "packages"), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(projectRoot, "packages", entry.name, "package.json")))
    .map(entry => entry.name)
    .sort();
  const accountedFor = [...ids.filter(id => id !== "scripts"), ...UNIT_TEST_EXCLUSIONS].sort();
  if (packages.join(",") !== accountedFor.join(",")) {
    throw new Error(
      `package test plan is incomplete: packages=${packages.join(",")} accounted=${accountedFor.join(",")}`,
    );
  }

  for (const excluded of UNIT_TEST_EXCLUSIONS) {
    const manifest = JSON.parse(readFileSync(join(projectRoot, "packages", excluded, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    if (manifest.scripts?.test !== undefined) {
      throw new Error(`${excluded} now has a unit-test contract and must leave UNIT_TEST_EXCLUSIONS`);
    }
  }
}

export async function runPackageSuites(
  suites: readonly PackageTestSuite[] = PACKAGE_TEST_SUITES,
  run: (suite: PackageTestSuite) => Promise<number> = async suite => {
    console.log(`\n[test] ${suite.id}: ${suite.command.join(" ")}`);
    return Bun.spawn({ cmd: [...suite.command], stdout: "inherit", stderr: "inherit" }).exited;
  },
): Promise<void> {
  const failed: string[] = [];
  for (const suite of suites) {
    const exitCode = await run(suite);
    if (exitCode !== 0) failed.push(`${suite.id} (exit ${exitCode})`);
  }
  if (failed.length > 0) throw new Error(`package test suites failed: ${failed.join(", ")}`);
}

if (import.meta.main) {
  const projectRoot = resolve(import.meta.dirname, "..");
  assertCompletePackagePlan(projectRoot);
  await runPackageSuites();
}
