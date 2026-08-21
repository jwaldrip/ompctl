/**
 * Coverage for the presence-inference fallback in `SessionIndex.build()`: a
 * bare `omp` TUI run by a build that predates presence carrying `sessionId`
 * still surfaces as `live-tui`, provided exactly one session file in its
 * project directory was written since it registered. Ambiguity resolves to
 * `dormant` rather than a guess, and an explicit `sessionId` is never routed
 * through the inference path at all.
 *
 * Project directories are real, on-disk fixture paths (not hand-typed
 * flattened names): `decodeSessionDirName` walks the filesystem under its
 * `homeDir`, so a made-up name like `-x` decodes to `unknown/no_match` on any
 * machine that doesn't happen to have that exact directory, which is exactly
 * how the inference filter is meant to fail closed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import { encodeSessionDirName } from "../../src/sessions/cwd-codec.ts";
import { SessionIndex } from "../../src/sessions/session-index.ts";

const scratch: string[] = [];
const openStores: Store[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function openStore(dbPath: string): Store {
  const store = new Store(dbPath);
  openStores.push(store);
  return store;
}

function titleLine(title: string): unknown {
  return { type: "title", v: 1, title, updatedAt: new Date().toISOString() };
}

/** A real project directory and the same flattened grouping key OMP writes beside its JSONL header. */
function buildProjectFixture(): { home: string; projectDir: string; flattenedDir: string } {
  const home = tempRoot("session-index-infer-home-");
  const projectDir = join(home, "proj");
  mkdirSync(projectDir, { recursive: true });
  const flattenedDir = encodeSessionDirName(projectDir, home, tmpdir());
  return { home, projectDir, flattenedDir };
}

/** Writes a session file and sets its mtime explicitly, so ordering relative to a presence file's registeredAtMs never depends on wall-clock write speed. */
function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  id: string,
  cwd: string,
  lines: unknown[],
  mtime: Date,
): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  const [title, ...rest] = lines;
  const records = [title, { type: "session", version: 3, id, timestamp: "t", cwd }, ...rest];
  writeFileSync(filePath, `${records.map(line => JSON.stringify(line)).join("\n")}\n`);
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

/** Writes a bare (no sessionId) presence record and sets its file mtime, which liveness.ts reads back as `registeredAtMs`. */
function writeBarePresence(clientsDir: string, name: string, projectDir: string, registeredAt: Date): void {
  mkdirSync(clientsDir, { recursive: true });
  const path = join(clientsDir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ pid: process.pid, id: name, projectDir }));
  utimesSync(path, registeredAt, registeredAt);
}

const SESSION_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_B = "019feebf-6449-7000-9474-a2ae1f871930";
const SESSION_C = "019ff8ca-b4ca-7000-a133-beedf9dfab06";

const T0 = new Date("2026-08-11T00:00:00.000Z");
const AFTER_T0 = new Date("2026-08-11T00:00:05.000Z");
const LATER_T0 = new Date("2026-08-11T00:00:06.000Z");
const BEFORE_T0 = new Date("2026-08-10T23:59:55.000Z");

describe("SessionIndex inferred live-tui", () => {
  test("exactly one unclaimed candidate in the project directory becomes live-tui with the presence's pid", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-infer-one-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-05-000Z",
      SESSION_A,
      projectDir,
      [titleLine("t")],
      AFTER_T0,
    );

    const runRoot = tempRoot("session-index-run-infer-one-");
    writeBarePresence(join(runRoot, "hash1", "clients"), "bare", projectDir, T0);

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot, homeDir: home, tmpDir: tmpdir() });
    const [summary] = await index.build();
    expect(summary!.status).toBe("live-tui");
    expect(summary!.pid).toBe(process.pid);
  });

  test("two candidates in the same project directory both stay dormant", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-infer-two-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-05-000Z",
      SESSION_A,
      projectDir,
      [titleLine("a")],
      AFTER_T0,
    );
    writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-06-000Z",
      SESSION_B,
      projectDir,
      [titleLine("b")],
      LATER_T0,
    );

    const runRoot = tempRoot("session-index-run-infer-two-");
    writeBarePresence(join(runRoot, "hash1", "clients"), "bare", projectDir, T0);

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot, homeDir: home, tmpDir: tmpdir() });
    const summaries = await index.build();
    expect(summaries).toHaveLength(2);
    for (const summary of summaries) {
      expect(summary.status).toBe("dormant");
      expect(summary.pid).toBeUndefined();
    }
  });

  test("a candidate older than the presence's registration is not inferred, leaving it dormant", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-infer-stale-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-10T23-59-55-000Z",
      SESSION_A,
      projectDir,
      [titleLine("t")],
      BEFORE_T0,
    );

    const runRoot = tempRoot("session-index-run-infer-stale-");
    writeBarePresence(join(runRoot, "hash1", "clients"), "bare", projectDir, T0);

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot, homeDir: home, tmpDir: tmpdir() });
    const [summary] = await index.build();
    expect(summary!.status).toBe("dormant");
    expect(summary!.pid).toBeUndefined();
  });

  test("a presence carrying an explicit sessionId still maps by id even when a newer unclaimed file exists in the same project", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-infer-explicit-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-05-000Z",
      SESSION_A,
      projectDir,
      [titleLine("explicit")],
      AFTER_T0,
    );
    // A second, newer file in the same project that no presence claims at
    // all: it must not be swept up by the explicit client's registration.
    writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-06-000Z",
      SESSION_C,
      projectDir,
      [titleLine("unrelated")],
      LATER_T0,
    );

    const runRoot = tempRoot("session-index-run-infer-explicit-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    const path = join(clientsDir, "explicit.json");
    writeFileSync(path, JSON.stringify({ pid: process.pid, id: "explicit", projectDir, sessionId: SESSION_A }));
    utimesSync(path, T0, T0);

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot, homeDir: home, tmpDir: tmpdir() });
    const summaries = await index.build();
    const explicit = summaries.find(s => s.id === SESSION_A);
    const unrelated = summaries.find(s => s.id === SESSION_C);
    expect(explicit!.status).toBe("live-tui");
    expect(explicit!.pid).toBe(process.pid);
    // Not claimed by anything: no bare presence exists to infer from, so it
    // stays dormant rather than being pulled in by the explicit match.
    expect(unrelated!.status).toBe("dormant");
    expect(unrelated!.pid).toBeUndefined();
  });
});

afterEach(() => {
  for (const store of openStores.splice(0)) {
    try {
      store.close();
    } catch {
      // Already closed by the test.
    }
  }
});

process.on("exit", () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});
