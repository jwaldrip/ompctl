/**
 * A bare `omp` terminal's session is the transcript it holds open, read
 * from its descriptor table, not a guess from mtimes.
 *
 * Observed on the operator's Mac on 2026-09-08: 18 live terminals, 9 of
 * them shown dormant, his own session among them, because the inference
 * from mtimes fails whenever a second file in the project is touched after
 * the terminal registered (a second terminal there, or this daemon opening
 * a dormant session there from a phone). Every one of the 18 held exactly
 * its own transcript open. These tests drive the reading through the test
 * seam and prove the catalogue follows it: first the inference (the reading
 * is taken in the background, never on the request path), then the
 * terminal's own answer, pushed through `watch` the moment it lands.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "@ompd/core";
import { encodeSessionDirName } from "../../src/sessions/cwd-codec.ts";
import { parseLsofFields } from "../../src/sessions/open-session-files.ts";
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

function buildProjectFixture(): { home: string; projectDir: string; flattenedDir: string } {
  const home = tempRoot("session-index-open-home-");
  const projectDir = join(home, "proj");
  mkdirSync(projectDir, { recursive: true });
  const flattenedDir = encodeSessionDirName(projectDir, home, tmpdir());
  return { home, projectDir, flattenedDir };
}

function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  id: string,
  cwd: string,
  mtime: Date,
): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  const records = [titleLine(id.slice(0, 4)), { type: "session", version: 3, id, timestamp: "t", cwd }];
  writeFileSync(filePath, `${records.map(line => JSON.stringify(line)).join("\n")}\n`);
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

/** A bare presence, as upstream writes it: pid, id, projectDir, and nothing naming a session. */
function writeBarePresence(
  clientsDir: string,
  name: string,
  pid: number,
  projectDir: string,
  registeredAt: Date,
): void {
  mkdirSync(clientsDir, { recursive: true });
  const path = join(clientsDir, `${name}.json`);
  writeFileSync(path, JSON.stringify({ pid, id: name, projectDir }));
  utimesSync(path, registeredAt, registeredAt);
}

/** The next change the index reports through `watch`, whatever carries it. */
function nextChange(index: SessionIndex): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const handle = index.watch(() => {
    handle?.stop();
    resolve();
  });
  if (handle === null) throw new Error("sessions root missing; watch refused");
  return promise;
}

const SESSION_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_B = "019feebf-6449-7000-9474-a2ae1f871930";

const T0 = new Date("2026-08-11T00:00:00.000Z");
const AFTER_T0 = new Date("2026-08-11T00:00:05.000Z");
const LATER_T0 = new Date("2026-08-11T00:00:06.000Z");

describe("a terminal's session is the transcript it holds open", () => {
  test("names the session where the mtime inference cannot, and ignores the nested subagent transcript", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-open-one-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const pathA = writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-05-000Z",
      SESSION_A,
      projectDir,
      AFTER_T0,
    );
    // A second file written after the terminal registered: the shape a
    // dormant session this daemon opened and closed from a phone leaves.
    writeSessionFile(sessionsRoot, flattenedDir, "2026-08-11T00-00-06-000Z", SESSION_B, projectDir, LATER_T0);
    const runRoot = tempRoot("session-index-run-open-one-");
    writeBarePresence(join(runRoot, "hash1", "clients"), "bare", process.pid, projectDir, T0);

    const reading = Promise.withResolvers<Map<number, string[]>>();
    const index = new SessionIndex({
      store,
      sessionsRoot,
      runDaemonsRoot: runRoot,
      homeDir: home,
      tmpDir: tmpdir(),
      openSessionFiles: () => reading.promise,
    });
    const changed = nextChange(index);

    // Before the reading lands: two candidates, so the inference declines
    // both, exactly as it did before there was a reading to wait for.
    const first = await index.build();
    expect(first.map(s => s.status)).toEqual(["dormant", "dormant"]);

    reading.resolve(
      new Map([[process.pid, [pathA, join(dirname(pathA), `2026-08-11T00-00-05-000Z_${SESSION_A}`, "scout.jsonl")]]]),
    );
    await changed;

    const second = await index.build();
    const a = second.find(s => s.id === SESSION_A);
    const b = second.find(s => s.id === SESSION_B);
    expect(a?.status).toBe("live-tui");
    expect(a?.pid).toBe(process.pid);
    expect(b?.status).toBe("dormant");
    expect(b?.pid).toBeUndefined();
  });

  test("two terminals in one project are each live on their own transcript", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-open-two-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const pathA = writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-05-000Z",
      SESSION_A,
      projectDir,
      AFTER_T0,
    );
    const pathB = writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-06-000Z",
      SESSION_B,
      projectDir,
      LATER_T0,
    );
    const runRoot = tempRoot("session-index-run-open-two-");
    // Two processes that are alive for the whole test: this one and its parent.
    writeBarePresence(join(runRoot, "hash1", "clients"), "one", process.pid, projectDir, T0);
    writeBarePresence(join(runRoot, "hash1", "clients"), "two", process.ppid, projectDir, T0);

    const index = new SessionIndex({
      store,
      sessionsRoot,
      runDaemonsRoot: runRoot,
      homeDir: home,
      tmpDir: tmpdir(),
      openSessionFiles: async () =>
        new Map([
          [process.pid, [pathA]],
          [process.ppid, [pathB]],
        ]),
    });
    const changed = nextChange(index);
    await index.build();
    await changed;

    const rows = await index.build();
    const a = rows.find(s => s.id === SESSION_A);
    const b = rows.find(s => s.id === SESSION_B);
    expect(a?.status).toBe("live-tui");
    expect(a?.pid).toBe(process.pid);
    expect(b?.status).toBe("live-tui");
    expect(b?.pid).toBe(process.ppid);
  });

  test("a reading past its TTL is re-taken, so the catalogue follows a terminal that resumed another session", async () => {
    const { home, projectDir, flattenedDir } = buildProjectFixture();
    const sessionsRoot = tempRoot("session-index-open-ttl-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const pathA = writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-05-000Z",
      SESSION_A,
      projectDir,
      AFTER_T0,
    );
    const pathB = writeSessionFile(
      sessionsRoot,
      flattenedDir,
      "2026-08-11T00-00-06-000Z",
      SESSION_B,
      projectDir,
      LATER_T0,
    );
    const runRoot = tempRoot("session-index-run-open-ttl-");
    writeBarePresence(join(runRoot, "hash1", "clients"), "bare", process.pid, projectDir, T0);

    let open = pathA;
    const index = new SessionIndex({
      store,
      sessionsRoot,
      runDaemonsRoot: runRoot,
      homeDir: home,
      tmpDir: tmpdir(),
      openFilesTtlMs: 0,
      openSessionFiles: async () => new Map([[process.pid, [open]]]),
    });

    let changed = nextChange(index);
    await index.build();
    await changed;
    const onA = await index.build();
    expect(onA.find(s => s.id === SESSION_A)?.status).toBe("live-tui");
    expect(onA.find(s => s.id === SESSION_B)?.status).toBe("dormant");

    // The terminal `/resume`d B. The build above already scheduled a
    // re-read (TTL 0), but it read A; the next build's re-read sees B.
    open = pathB;
    changed = nextChange(index);
    await index.build();
    await changed;
    const onB = await index.build();
    expect(onB.find(s => s.id === SESSION_A)?.status).toBe("dormant");
    expect(onB.find(s => s.id === SESSION_B)?.status).toBe("live-tui");
    expect(onB.find(s => s.id === SESSION_B)?.pid).toBe(process.pid);
  });
});

describe("parseLsofFields", () => {
  test("keeps only the transcript paths, per pid, from lsof's field output", () => {
    const text = [
      "p74205",
      "fcwd",
      "n/Users/op/dev/src/github.com/op/alpha",
      "f12",
      "n/Users/op/.omp/agent/sessions/-dev-alpha/2026-09-05T18-52-55-959Z_01a072ea.jsonl",
      "f13",
      "n/Users/op/.omp/agent/sessions/-dev-alpha/2026-09-05T18-52-55-959Z_01a072ea/scout.jsonl",
      "f14",
      "n/dev/ttys004",
      "p12794",
      "f9",
      "n/Users/op/.omp/agent/sessions/-dev-beta/2026-08-19T04-51-23-945Z_01a0185c.jsonl",
      "",
    ].join("\n");
    const out = parseLsofFields(text);
    expect([...out.keys()]).toEqual([74205, 12794]);
    expect(out.get(74205)).toEqual([
      "/Users/op/.omp/agent/sessions/-dev-alpha/2026-09-05T18-52-55-959Z_01a072ea.jsonl",
      "/Users/op/.omp/agent/sessions/-dev-alpha/2026-09-05T18-52-55-959Z_01a072ea/scout.jsonl",
    ]);
    expect(out.get(12794)).toEqual(["/Users/op/.omp/agent/sessions/-dev-beta/2026-08-19T04-51-23-945Z_01a0185c.jsonl"]);
  });
});

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
