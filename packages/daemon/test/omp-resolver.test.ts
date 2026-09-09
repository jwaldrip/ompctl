/**
 * Tests for omp executable resolution order:
 * 1. Operator's configured ompPath wins.
 * 2. Real omp on PATH wins over bundled.
 * 3. Bundled copy is used when neither configured nor PATH omp exists.
 * 4. Refusal when nothing resolves.
 * 5. Refusal when bundled copy faces ~/.omp from a conflicting major version.
 */

import { describe, expect, test } from "bun:test";
import {
  BUNDLED_OMP_MAJOR_VERSION,
  BUNDLED_OMP_VERSION,
  OmpResolutionError,
  resolveOmp,
} from "../src/omp-resolver.ts";

describe("omp-resolver", () => {
  const BUNDLED_PATH = "/mock/repo/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js";

  test("configured path wins over PATH and bundled", () => {
    const res = resolveOmp({
      configuredPath: "/custom/bin/omp",
      envPath: "/usr/local/bin:/usr/bin",
      execDir: "/mock/bin",
      repoRoot: "/mock/repo",
      existsSync: (path: string) => [
        "/custom/bin/omp",
        "/usr/local/bin/omp",
        BUNDLED_PATH,
      ].includes(path),
      isExecutable: () => true,
      readVersion: (path: string) => (path === "/custom/bin/omp" ? "19.0.0" : "18.1.13"),
      readOmpMajorVersion: () => null,
    });

    expect(res).toEqual({
      path: "/custom/bin/omp",
      source: "configured",
      version: "19.0.0",
    });
  });

  test("PATH wins over bundled when configured path is absent", () => {
    const res = resolveOmp({
      configuredPath: undefined,
      envPath: "/usr/local/bin:/usr/bin",
      execDir: "/mock/bin",
      repoRoot: "/mock/repo",
      existsSync: (path: string) => [
        "/usr/local/bin/omp",
        BUNDLED_PATH,
      ].includes(path),
      isExecutable: () => true,
      readVersion: (path: string) => (path === "/usr/local/bin/omp" ? "18.1.13" : BUNDLED_OMP_VERSION),
      readOmpMajorVersion: () => null,
    });

    expect(res).toEqual({
      path: "/usr/local/bin/omp",
      source: "path",
      version: "18.1.13",
    });
  });

  test("PATH wins over bundled when configured path is the legacy bare 'omp'", () => {
    const res = resolveOmp({
      configuredPath: "omp",
      envPath: "/usr/local/bin:/usr/bin",
      execDir: "/mock/bin",
      repoRoot: "/mock/repo",
      existsSync: (path: string) => [
        "/usr/local/bin/omp",
        BUNDLED_PATH,
      ].includes(path),
      isExecutable: () => true,
      readVersion: (path: string) => (path === "/usr/local/bin/omp" ? "18.1.13" : BUNDLED_OMP_VERSION),
      readOmpMajorVersion: () => null,
    });

    expect(res).toEqual({
      path: "/usr/local/bin/omp",
      source: "path",
      version: "18.1.13",
    });
  });

  test("bundled copy is selected when configured and PATH are absent", () => {
    const res = resolveOmp({
      configuredPath: undefined,
      envPath: "/usr/local/bin:/usr/bin",
      execDir: "/mock/bin",
      repoRoot: "/mock/repo",
      existsSync: (path: string) => path === BUNDLED_PATH,
      isExecutable: () => true,
      readVersion: () => BUNDLED_OMP_VERSION,
      readOmpMajorVersion: () => null,
    });

    expect(res).toEqual({
      path: BUNDLED_PATH,
      source: "bundled",
      version: BUNDLED_OMP_VERSION,
    });
  });

  test("refusal names what was missing when nothing resolves", () => {
    expect(() => {
      resolveOmp({
        configuredPath: undefined,
        envPath: "/usr/local/bin:/usr/bin",
        execDir: "/mock/bin",
        repoRoot: "/mock/repo",
        existsSync: () => false,
        isExecutable: () => false,
        readVersion: () => null,
        readOmpMajorVersion: () => null,
      });
    }).toThrow(OmpResolutionError);

    try {
      resolveOmp({
        configuredPath: undefined,
        envPath: "/usr/local/bin:/usr/bin",
        execDir: "/mock/bin",
        repoRoot: "/mock/repo",
        existsSync: () => false,
        isExecutable: () => false,
        readVersion: () => null,
        readOmpMajorVersion: () => null,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(OmpResolutionError);
      const msg = (err as Error).message;
      expect(msg).toContain("no configured ompPath");
      expect(msg).toContain("omp not found on PATH");
      expect(msg).toContain("no bundled copy found");
    }
  });

  test("refusal when configured path does not exist", () => {
    expect(() => {
      resolveOmp({
        configuredPath: "/missing/omp",
        existsSync: () => false,
        isExecutable: () => false,
        readVersion: () => null,
        readOmpMajorVersion: () => null,
      });
    }).toThrow(/configured ompPath "\/missing\/omp" does not exist/);
  });

  test("refusal when bundled copy faces ~/.omp from a conflicting major version", () => {
    expect(() => {
      resolveOmp({
        configuredPath: undefined,
        envPath: "/usr/local/bin",
        execDir: "/mock/bin",
        repoRoot: "/mock/repo",
        existsSync: (path: string) => path === BUNDLED_PATH,
        isExecutable: () => true,
        readVersion: () => BUNDLED_OMP_VERSION,
        readOmpMajorVersion: () => 18,
      });
    }).toThrow(/refusing to use bundled omp/i);

    try {
      resolveOmp({
        configuredPath: undefined,
        envPath: "/usr/local/bin",
        execDir: "/mock/bin",
        repoRoot: "/mock/repo",
        existsSync: (path: string) => path === BUNDLED_PATH,
        isExecutable: () => true,
        readVersion: () => BUNDLED_OMP_VERSION,
        readOmpMajorVersion: () => 18,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(OmpResolutionError);
      const msg = (err as Error).message;
      expect(msg).toContain("written by omp version 18");
      expect(msg).toContain("bundled omp (17.3.4)");
      expect(msg).toContain("different major version risks");
    }
  });

  test("bundled copy is permitted when ~/.omp matches major version or is clean", () => {
    const res = resolveOmp({
      configuredPath: undefined,
      envPath: "/usr/local/bin",
      execDir: "/mock/bin",
      repoRoot: "/mock/repo",
      existsSync: (path: string) => path === BUNDLED_PATH,
      isExecutable: () => true,
      readVersion: () => BUNDLED_OMP_VERSION,
      readOmpMajorVersion: () => BUNDLED_OMP_MAJOR_VERSION,
    });

    expect(res.source).toBe("bundled");
    expect(res.version).toBe(BUNDLED_OMP_VERSION);
  });
});
