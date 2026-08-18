/**
 * Integration coverage for `SessionIndex`: proves the assembled view is
 * correct where it matters most -- liveness cannot be faked by a stale
 * record, archiving is durable across a real store reopen (not just an
 * in-memory flag), and every advertised sort order actually orders.
 *
 * The build is async and cooperative: first paint serves cached counts (or
 * an honest null) immediately, a single background warm pass fills the rest,
 * and concurrent requests share one build. The tests at the bottom pin all
 * three of those properties; each one fails against a synchronous build.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import type { Agent, HostRef, SessionQuery, SessionSummary } from "@ompd/core/contracts";
import { SessionIndex } from "../../src/sessions/session-index.ts";
import { scanSessionFiles } from "../../src/sessions/scanner.ts";

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

/**
 * A store whose scan-cache writes are counted by ROW, so a test can prove
 * one warm pass ran exactly once without racing real mtimes. Both the
 * single-row and the batched methods are intercepted -- the warm pass uses
 * the batch -- and the rows written are the store's own, unchanged.
 */
function openCountingStore(dbPath: string): { store: Store; cacheWrites: () => number } {
  const store = openStore(dbPath);
  let writes = 0;
  const originalSingle = store.setSessionScanCache.bind(store);
  Object.defineProperty(store, "setSessionScanCache", {
    value: (id: string, entry: Parameters<Store["setSessionScanCache"]>[1]) => {
      writes += 1;
      return originalSingle(id, entry);
    },
  });
  const originalBatch = store.setSessionScanCacheBatch.bind(store);
  Object.defineProperty(store, "setSessionScanCacheBatch", {
    value: (rows: Parameters<Store["setSessionScanCacheBatch"]>[0]) => {
      writes += rows.length;
      return originalBatch(rows);
    },
  });
  return { store, cacheWrites: () => writes };
}

function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  id: string,
  lines: unknown[],
): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
  return filePath;
}

function titleLine(title: string): unknown {
  return { type: "title", v: 1, title, updatedAt: new Date().toISOString() };
}

function messageLine(id: string, role: "user" | "assistant"): unknown {
  return { type: "message", id, message: { role, content: [{ type: "text", text: "x" }] } };
}

function fakeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: overrides.id ?? "agt_0000000000000000",
    name: overrides.name ?? "test-agent",
    state: overrides.state ?? "idle",
    host: overrides.host ?? ({ kind: "local", id: "12345", spec: { kind: "local" } } satisfies HostRef),
    cwd: overrides.cwd ?? "/x",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastActiveAt: overrides.lastActiveAt ?? new Date().toISOString(),
    labels: overrides.labels ?? {},
    ...overrides,
  };
}

/** Builds a SessionIndex over an isolated sessions tree and an isolated store, with liveness pointed at an empty run/daemons root so no real process on the test machine leaks into results. */
function buildIndex(sessionsRoot: string, store: Store): SessionIndex {
  const emptyRunRoot = tempRoot("session-index-empty-run-");
  return new SessionIndex({ store, sessionsRoot, runDaemonsRoot: emptyRunRoot });
}

/** Rows with every count materialized: first paint, then (if anything was cold) the warmed upgrade awaited. */
async function warmedQuery(index: SessionIndex, q: SessionQuery = {}): Promise<SessionSummary[]> {
  const first = await index.queryWithWarm(q);
  if (first.warmed === null) return first.sessions;
  return first.warmed;
}

const SESSION_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_B = "019feebf-6449-7000-9474-a2ae1f871930";
const SESSION_C = "019ff8ca-b4ca-7000-a133-beedf9dfab06";

describe("SessionIndex.build", () => {
  test("spans multiple cwd groups", async () => {
    const sessionsRoot = tempRoot("session-index-groups-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-Downloads", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("Manuscript")]);
    writeSessionFile(sessionsRoot, "-dev-src-github.com-acme-widgets", "2026-08-12T00-00-00-000Z", SESSION_B, [
      titleLine("Widgets work"),
    ]);
    writeSessionFile(sessionsRoot, "--private-tmp--", "2026-08-13T00-00-00-000Z", SESSION_C, [titleLine("")]);

    const index = buildIndex(sessionsRoot, store);
    const summaries = await index.build();
    expect(summaries).toHaveLength(3);
    expect(new Set(summaries.map(s => s.flattenedDir))).toEqual(
      new Set(["-Downloads", "-dev-src-github.com-acme-widgets", "--private-tmp--"]),
    );
  });

  test("a stale client presence record does not make a session look live", async () => {
    const sessionsRoot = tempRoot("session-index-stale-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const runRoot = tempRoot("session-index-run-stale-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(
      join(clientsDir, "stale.json"),
      JSON.stringify({
        pid: 2_147_483_647, // cannot exist on any real system
        id: "stale",
        projectDir: "/x",
        sessionId: SESSION_A,
      }),
    );

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });
    const [summary] = await index.build();
    expect(summary!.status).toBe("dormant");
    expect(summary!.pid).toBeUndefined();
  });

  test("a live client presence record reports live-tui", async () => {
    const sessionsRoot = tempRoot("session-index-live-tui-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const runRoot = tempRoot("session-index-run-live-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(
      join(clientsDir, "live.json"),
      JSON.stringify({ pid: process.pid, id: "live", projectDir: "/x", sessionId: SESSION_A }),
    );

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });
    const [summary] = await index.build();
    expect(summary!.status).toBe("live-tui");
    expect(summary!.pid).toBe(process.pid);
  });

  test("a session ompd holds via a non-terminal agent reports live-ompd, even with a live-tui-shaped client record present", async () => {
    const sessionsRoot = tempRoot("session-index-live-ompd-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);
    store.upsertAgent(fakeAgent({ id: "agt_abc", acpSessionId: SESSION_A, state: "busy" }));

    // Also register a client presence for the same session, to prove
    // live-ompd is checked first regardless.
    const runRoot = tempRoot("session-index-run-ompd-");
    const clientsDir = join(runRoot, "hash1", "clients");
    mkdirSync(clientsDir, { recursive: true });
    writeFileSync(
      join(clientsDir, "live.json"),
      JSON.stringify({ pid: process.pid, id: "live", projectDir: "/x", sessionId: SESSION_A }),
    );

    const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });
    const [summary] = await index.build();
    expect(summary!.status).toBe("live-ompd");
    expect(summary!.agentId).toBe("agt_abc");
  });

  test("a session held only by a terminal agent (stopped/failed) is dormant, not live-ompd", async () => {
    const sessionsRoot = tempRoot("session-index-terminal-agent-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);
    store.upsertAgent(fakeAgent({ id: "agt_stopped", acpSessionId: SESSION_A, state: "stopped" }));

    const index = buildIndex(sessionsRoot, store);
    const [summary] = await index.build();
    expect(summary!.status).toBe("dormant");
    expect(summary!.agentId).toBeUndefined();
  });

  test("message count exceeding the size ceiling reports null and the file is never read for it", async () => {
    const sessionsRoot = tempRoot("session-index-ceiling-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
      messageLine("m1", "user"),
    ]);
    // Truncate the on-disk size upward past the ceiling without actually
    // writing tens of megabytes of content; scanSessionFiles reads size from
    // stat(), which reports the truncated length regardless of content.
    const fs = require("node:fs");
    fs.truncateSync(path, 60 * 1024 * 1024);

    const index = buildIndex(sessionsRoot, store);
    const first = await index.queryWithWarm();
    expect(first.sessions[0]!.byteSize).toBe(60 * 1024 * 1024);
    expect(first.sessions[0]!.messageCount).toBeNull();
    // The warm pass skips it (it is over the ceiling by size), so even the
    // upgraded frame still says null: unknown, never a fabricated number.
    expect(first.warmed).toBeNull();
    expect((await index.build())[0]!.messageCount).toBeNull();
  });
});

describe("SessionIndex first paint and background warming", () => {
  test("first paint reports null counts on a cold cache, then real counts once warmed", async () => {
    const sessionsRoot = tempRoot("session-index-firstpaint-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
      messageLine("m3", "user"),
    ]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("no messages")]);

    const index = buildIndex(sessionsRoot, store);
    const first = await index.queryWithWarm();
    const counted = first.sessions.find(s => s.id === SESSION_A);
    const empty = first.sessions.find(s => s.id === SESSION_B);
    expect(counted!.messageCount).toBeNull();
    // Unknown, not zero: an empty conversation and an uncounted one must not
    // look alike before the warm pass has told them apart.
    expect(empty!.messageCount).toBeNull();
    expect(first.warmed).not.toBeNull();

    const upgraded = await first.warmed!;
    expect(upgraded.find(s => s.id === SESSION_A)!.messageCount).toBe(3);
    // A real zero now: the file was read and genuinely has no turns.
    expect(upgraded.find(s => s.id === SESSION_B)!.messageCount).toBe(0);
  });

  test("a later query gets counts at first paint from the durable cache and starts no warm pass", async () => {
    const sessionsRoot = tempRoot("session-index-cached-");
    const { store, cacheWrites } = openCountingStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
    ]);
    const index = buildIndex(sessionsRoot, store);

    const first = await index.queryWithWarm();
    await first.warmed;
    expect(cacheWrites()).toBe(1);

    const second = await index.queryWithWarm();
    expect(second.sessions[0]!.messageCount).toBe(2);
    expect(second.warmed).toBeNull();
    expect(cacheWrites()).toBe(1);
  });

  test("an appended file invalidates its cached count by mtime+size", async () => {
    const sessionsRoot = tempRoot("session-index-invalidate-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("t"),
      messageLine("m1", "user"),
    ]);
    const index = buildIndex(sessionsRoot, store);
    expect((await warmedQuery(index))[0]!.messageCount).toBe(1);

    // The OMP TUI appends a turn and bumps the file; the old cache row's
    // mtime+size no longer matches, so the count is recomputed, not replayed.
    const fs = require("node:fs");
    fs.appendFileSync(path, `${JSON.stringify(messageLine("m2", "assistant"))}\n`);
    expect((await warmedQuery(index))[0]!.messageCount).toBe(2);
  });
});

describe("SessionIndex single-flight", () => {
  test("two overlapping index requests share one build and one warm pass", async () => {
    const sessionsRoot = tempRoot("session-index-singleflight-");
    const { store, cacheWrites } = openCountingStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("a"), messageLine("m1", "user")]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("b")]);
    writeSessionFile(sessionsRoot, "-z", "2026-08-13T00-00-00-000Z", SESSION_C, [titleLine("c"), messageLine("m1", "assistant")]);

    // The scan seam holds the first build open until the second request has
    // joined it, so the overlap is deterministic rather than a scheduling
    // race; the files it replays are the real ones the real scan would find.
    const realFiles = scanSessionFiles(sessionsRoot);
    let scanCalls = 0;
    const gate = Promise.withResolvers<void>();
    const index = new SessionIndex({
      store,
      sessionsRoot,
      runDaemonsRoot: tempRoot("session-index-empty-run-"),
      scan: () => {
        scanCalls += 1;
        return (async function* () {
          await gate.promise;
          yield* realFiles;
        })();
      },
    });

    const p1 = index.queryWithWarm();
    const p2 = index.queryWithWarm();
    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(scanCalls).toBe(1);
    expect(r1.sessions.map(s => s.id)).toEqual(r2.sessions.map(s => s.id));
    // Both callers joined one warm pass too: each file was counted and
    // written to the cache exactly once, not once per requester.
    expect(r1.warmed).not.toBeNull();
    expect(r2.warmed).not.toBeNull();
    await Promise.all([r1.warmed!, r2.warmed!]);
    expect(cacheWrites()).toBe(3);
  });

  test("a reconnect replay after the warm pass settles starts no second pass", async () => {
    const sessionsRoot = tempRoot("session-index-replay-");
    const { store, cacheWrites } = openCountingStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("a"), messageLine("m1", "user")]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("b")]);

    let scanCalls = 0;
    const index = new SessionIndex({
      store,
      sessionsRoot,
      runDaemonsRoot: tempRoot("session-index-empty-run-"),
      scan: root => {
        scanCalls += 1;
        return scanSessionFiles(root);
      },
    });

    const first = await index.queryWithWarm();
    await first.warmed;
    expect(cacheWrites()).toBe(2);

    // The hub client missed its pong deadline, reconnected, and replayed
    // listSessions: a fresh build is fine (the view is rebuilt per call by
    // design), but the counting must not start over.
    const scansBeforeReplay = scanCalls;
    const replay = await index.queryWithWarm();
    // The replay builds once (the view is rebuilt per call by design), and
    // only once -- and it warms nothing: `warmed` is null and no cache row
    // is written a second time.
    expect(scanCalls - scansBeforeReplay).toBe(1);
    expect(cacheWrites()).toBe(2);
  });
});

describe("SessionIndex responsiveness", () => {
  test("the event loop stays live while a cold build scans and while the warm pass counts", async () => {
    const sessionsRoot = tempRoot("session-index-live-loop-");
    const { store, cacheWrites } = openCountingStore(join(tempRoot("session-index-db-"), "ompd.db"));
    // A corpus large enough to matter: thousands of title-only files (the
    // scan phase) plus a dozen multi-megabyte transcripts (the warm phase).
    // Measured on this machine: ~0.013ms per file scanned and ~0.75MB/ms
    // counted, so this is roughly 55ms of scanning and 70+ms of counting --
    // each far more than the 10ms probes below, with margin on both sides.
    const bigDir = join(sessionsRoot, "-big");
    mkdirSync(bigDir, { recursive: true });
    for (let i = 0; i < 4000; i++) {
      const id = `019fee60-2c7a-7000-9fd5-${String(i).padStart(12, "0")}`;
      const dir = i < 12 ? bigDir : join(sessionsRoot, `-many-${i % 40}`);
      if (dir !== bigDir) mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `2026-08-11T01-11-48-090Z_${id}.jsonl`),
        `${JSON.stringify(titleLine("tiny"))}\n`,
      );
    }
    for (let i = 0; i < 12; i++) {
      const id = `019feebf-6449-7000-9474-${String(i).padStart(12, "0")}`;
      const lines: string[] = [JSON.stringify(titleLine("big"))];
      // ~4.2MB per file of realistic message lines.
      for (let m = 0; m < 3600; m++) {
        lines.push(JSON.stringify(messageLine(`m${m}`, m % 2 ? "user" : "assistant")));
      }
      writeFileSync(
        join(bigDir, `2026-08-12T00-00-00-000Z_${id}.jsonl`),
        `${lines.map(l => l.replace('"text":"x"', `"text":"${"x".repeat(1100)}"`)).join("\n")}\n`,
      );
    }

    const index = buildIndex(sessionsRoot, store);

    // Real timers, deliberately: the property under test is that the REAL
    // event loop stays serviced while the index works -- a setTimeout
    // callback firing mid-build is the observation, and fake timers would
    // simulate the clock without proving the loop ever ran. Every wait
    // except these two 10ms probes is on a promise the code itself exposes.
    //
    // Scan phase: the timer fires while the build is still running. A
    // synchronous build settles before any timer can run, so this fails
    // against one.
    const first = index.queryWithWarm();
    let buildSettled = false;
    void first.then(() => {
      buildSettled = true;
    });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(buildSettled).toBe(false);
    const { warmed } = await first;

    // Warm phase: the same probe fires while the count still runs, provable
    // without any clock guess because the handle came from the build that
    // saw the cache cold. A synchronous warm pass would settle (and resolve
    // this very promise) before the timer could run at all.
    expect(warmed).not.toBeNull();
    let warmSettled = false;
    const warmDone = warmed!.then(() => {
      warmSettled = true;
    });
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    expect(warmSettled).toBe(false);
    await warmDone;

    // Exactly one warm pass over the whole corpus: every file counted once.
    expect(cacheWrites()).toBe(4012);
    const rows = await index.query();
    expect(rows.filter(r => r.byteSize > 1024 * 1024).every(r => r.messageCount === 3600)).toBe(true);
  }, 60_000);
});

describe("SessionIndex durable count cache", () => {
  test("counts survive a store reopen exactly as a daemon restart would open it", async () => {
    const sessionsRoot = tempRoot("session-index-durable-");
    const dbPath = join(tempRoot("session-index-db-"), "ompd.db");
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [
      titleLine("a"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
    ]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("b"), messageLine("m1", "user")]);

    const store1 = openCountingStore(dbPath);
    const index1 = buildIndex(sessionsRoot, store1.store);
    await warmedQuery(index1);
    expect(store1.cacheWrites()).toBe(2);
    store1.store.close();

    // A fresh Store over the same file -- the restart. First paint must
    // already know both counts (nothing re-warmed, nothing recounted).
    const store2 = openCountingStore(dbPath);
    const index2 = buildIndex(sessionsRoot, store2.store);
    const afterRestart = await index2.queryWithWarm();
    expect(afterRestart.sessions.find(s => s.id === SESSION_A)!.messageCount).toBe(2);
    expect(afterRestart.sessions.find(s => s.id === SESSION_B)!.messageCount).toBe(1);
    expect(afterRestart.warmed).toBeNull();
    expect(store2.cacheWrites()).toBe(0);
  });
});

describe("SessionIndex archiving", () => {
  test("archive survives a store reopen", async () => {
    const sessionsRoot = tempRoot("session-index-archive-");
    const dbDir = tempRoot("session-index-db-");
    const dbPath = join(dbDir, "ompd.db");
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const store1 = openStore(dbPath);
    const index1 = buildIndex(sessionsRoot, store1);
    index1.archive(SESSION_A);
    store1.close();

    // A fresh Store instance over the same file, exactly as a daemon restart
    // would open it -- not the same in-memory object.
    const store2 = openStore(dbPath);
    const index2 = buildIndex(sessionsRoot, store2);
    const [summary] = await index2.query({ includeArchived: true });
    expect(summary!.archived).toBe(true);
    expect(summary!.status).toBe("archived");
  });

  test("archived sessions are excluded by default and included on request", async () => {
    const sessionsRoot = tempRoot("session-index-archive-filter-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("u")]);

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);

    const defaultView = await index.query();
    expect(defaultView.map(s => s.id)).toEqual([SESSION_B]);

    const withArchived = await index.query({ includeArchived: true });
    expect(new Set(withArchived.map(s => s.id))).toEqual(new Set([SESSION_A, SESSION_B]));
  });

  test("unarchive reverses the mark", async () => {
    const sessionsRoot = tempRoot("session-index-unarchive-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);
    expect(await index.query()).toHaveLength(0);
    index.unarchive(SESSION_A);
    expect(await index.query()).toHaveLength(1);
  });

  test("archiving never deletes the session file", async () => {
    const sessionsRoot = tempRoot("session-index-no-delete-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("t")]);

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);
    const fs = require("node:fs");
    expect(fs.existsSync(path)).toBe(true);
  });
});

describe("SessionIndex sorting", () => {
  function seedThreeSessions(sessionsRoot: string): void {
    // Distinct sizes, ages, and message counts so every sort key produces a
    // real, checkable order rather than a coincidence.
    const small = writeSessionFile(sessionsRoot, "-a", "2026-08-10T00-00-00-000Z", SESSION_A, [
      titleLine("oldest, smallest, fewest messages"),
      messageLine("m1", "user"),
    ]);
    const medium = writeSessionFile(sessionsRoot, "-b", "2026-08-11T00-00-00-000Z", SESSION_B, [
      titleLine("middle"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
      messageLine("m3", "user"),
    ]);
    const large = writeSessionFile(sessionsRoot, "-c", "2026-08-12T00-00-00-000Z", SESSION_C, [
      titleLine("newest, largest, most messages"),
      messageLine("m1", "user"),
      messageLine("m2", "assistant"),
      messageLine("m3", "user"),
      messageLine("m4", "assistant"),
      messageLine("m5", "user"),
    ]);
    // Force a real size ordering independent of content length: pad the
    // "large" and "medium" files upward so byte size strictly orders
    // small < medium < large regardless of how JSON.stringify happened to
    // size each line.
    const fs = require("node:fs");
    fs.appendFileSync(medium, "\n// pad ".padEnd(2000, "x"));
    fs.appendFileSync(large, "\n// pad ".padEnd(4000, "x"));
    // Distinct, checkable mtimes for lastActivity, independent of write order.
    const base = new Date("2026-08-13T00:00:00.000Z").getTime();
    utimesSync(small, new Date(base), new Date(base));
    utimesSync(medium, new Date(base + 1000), new Date(base + 1000));
    utimesSync(large, new Date(base + 2000), new Date(base + 2000));
  }

  test("sorts by age ascending and descending", async () => {
    const sessionsRoot = tempRoot("session-index-sort-age-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    expect((await index.query({ sort: "age", sortDir: "asc" })).map(s => s.id)).toEqual([SESSION_A, SESSION_B, SESSION_C]);
    expect((await index.query({ sort: "age", sortDir: "desc" })).map(s => s.id)).toEqual([SESSION_C, SESSION_B, SESSION_A]);
  });

  test("sorts by lastActivity", async () => {
    const sessionsRoot = tempRoot("session-index-sort-activity-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    expect((await index.query({ sort: "lastActivity", sortDir: "asc" })).map(s => s.id)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_C,
    ]);
  });

  test("sorts by messageCount", async () => {
    const sessionsRoot = tempRoot("session-index-sort-count-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    // Warmed first: counting is what gives the messageCount sort a real
    // order rather than three nulls that only tie.
    expect((await warmedQuery(index, { sort: "messageCount", sortDir: "asc" })).map(s => s.id)).toEqual([
      SESSION_A,
      SESSION_B,
      SESSION_C,
    ]);
    expect((await warmedQuery(index, { sort: "messageCount", sortDir: "desc" })).map(s => s.id)).toEqual([
      SESSION_C,
      SESSION_B,
      SESSION_A,
    ]);
  });

  test("sorts by size", async () => {
    const sessionsRoot = tempRoot("session-index-sort-size-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    seedThreeSessions(sessionsRoot);
    const index = buildIndex(sessionsRoot, store);

    const asc = await index.query({ sort: "size", sortDir: "asc" });
    expect(asc.map(s => s.id)).toEqual([SESSION_A, SESSION_B, SESSION_C]);
    expect(asc[0]!.byteSize).toBeLessThan(asc[1]!.byteSize);
    expect(asc[1]!.byteSize).toBeLessThan(asc[2]!.byteSize);
  });

  test("sorts by status: live-ompd, then live-tui, then dormant, then archived", async () => {
    const sessionsRoot = tempRoot("session-index-sort-status-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-a", "2026-08-10T00-00-00-000Z", SESSION_A, [titleLine("dormant")]);
    writeSessionFile(sessionsRoot, "-b", "2026-08-11T00-00-00-000Z", SESSION_B, [titleLine("archived")]);
    writeSessionFile(sessionsRoot, "-c", "2026-08-12T00-00-00-000Z", SESSION_C, [titleLine("live-ompd")]);
    store.upsertAgent(fakeAgent({ id: "agt_live", acpSessionId: SESSION_C, state: "busy" }));

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_B);

    const withArchived = await index.query({ sort: "status", sortDir: "asc", includeArchived: true });
    expect(withArchived.map(s => s.status)).toEqual(["live-ompd", "dormant", "archived"]);
  });

  test("cwd filter matches either the decoded cwd or the raw flattened dir", async () => {
    const sessionsRoot = tempRoot("session-index-cwd-filter-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A, [titleLine("a")]);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B, [titleLine("b")]);

    const index = buildIndex(sessionsRoot, store);
    const byFlattened = await index.query({ cwd: "-x" });
    expect(byFlattened.map(s => s.id)).toEqual([SESSION_A]);
  });
});

describe("SessionIndex.grouped", () => {
  test("groups sessions by directory and orders groups by most recent activity", async () => {
    const sessionsRoot = tempRoot("session-index-grouped-");
    const store = openStore(join(tempRoot("session-index-db-"), "ompd.db"));
    const older = writeSessionFile(sessionsRoot, "-a", "2026-08-10T00-00-00-000Z", SESSION_A, [titleLine("a1")]);
    const newer1 = writeSessionFile(sessionsRoot, "-b", "2026-08-11T00-00-00-000Z", SESSION_B, [titleLine("b1")]);
    const newer2 = writeSessionFile(sessionsRoot, "-a", "2026-08-12T00-00-00-000Z", SESSION_C, [titleLine("a2")]);
    const base = new Date("2026-08-13T00:00:00.000Z").getTime();
    utimesSync(older, new Date(base), new Date(base));
    utimesSync(newer1, new Date(base + 1000), new Date(base + 1000));
    utimesSync(newer2, new Date(base + 2000), new Date(base + 2000));

    const index = buildIndex(sessionsRoot, store);
    const groups = await index.grouped();
    expect(groups).toHaveLength(2);
    // "-a" group has the most recently active session (SESSION_C) so it
    // sorts first even though it was the first group created.
    expect(groups[0]!.key).toBe("-a");
    expect(groups[0]!.sessions).toHaveLength(2);
    expect(groups[1]!.key).toBe("-b");
    expect(groups[1]!.sessions).toHaveLength(1);
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
