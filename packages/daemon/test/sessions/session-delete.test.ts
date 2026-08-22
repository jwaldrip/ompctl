/**
 * Deleting a session, which is the one thing this catalog does that cannot be
 * undone. `session-index.test.ts` pins the opposite guarantee next door
 * ("archiving never deletes the session file"), and these tests are what stop
 * the two from ever being the same operation.
 *
 * Every case here checks disk, not a return value: a result saying `deleted`
 * while the transcript is still there would be the exact defect worth
 * catching, and the same in reverse for a refusal that removed something
 * anyway.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import type { Agent, HostRef } from "@ompd/core/contracts";
import { SessionIndex } from "../../src/sessions/session-index.ts";

const scratch: string[] = [];
const openStores: Store[] = [];

const SESSION_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_B = "019feebf-6449-7000-9474-a2ae1f871930";
const SESSION_C = "019ff8ca-b4ca-7000-a133-beedf9dfab06";

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

function writeSessionFile(sessionsRoot: string, flattenedDir: string, timestamp: string, id: string): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${timestamp}_${id}.jsonl`);
  writeFileSync(filePath, `${JSON.stringify({ type: "title", v: 1, title: `session ${id}` })}\n`);
  return filePath;
}

/**
 * The per-session artifact directory real OMP writes beside a transcript:
 * same name, `.jsonl` dropped, holding the session's subagent transcripts.
 * Verified against this machine's own sessions root, where every recent
 * session has one.
 */
function writeArtifactDir(transcriptPath: string): string {
  const dir = transcriptPath.slice(0, -".jsonl".length);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "__advisor.jsonl"), `${JSON.stringify({ type: "title", v: 1, title: "sub" })}\n`);
  return dir;
}

function fakeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agt_0000000000000000",
    name: "test-agent",
    state: "idle",
    host: { kind: "local", id: "12345", spec: { kind: "local" } } satisfies HostRef,
    cwd: "/x",
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    labels: {},
    ...overrides,
  };
}

/** Liveness pointed at an empty run/daemons root, so no real process on this machine leaks into a result. */
function buildIndex(sessionsRoot: string, store: Store, runDaemonsRoot?: string): SessionIndex {
  return new SessionIndex({
    store,
    sessionsRoot,
    runDaemonsRoot: runDaemonsRoot ?? tempRoot("session-delete-empty-run-"),
  });
}

/** A client presence record naming `sessionId`, with this process as its pid: the only pid a test can guarantee `listLiveClientPresences` will find alive. */
function writeLiveTuiPresence(runRoot: string, sessionId: string): void {
  const clientsDir = join(runRoot, "hash1", "clients");
  mkdirSync(clientsDir, { recursive: true });
  writeFileSync(
    join(clientsDir, "live.json"),
    JSON.stringify({ pid: process.pid, id: "live", projectDir: "/x", sessionId }),
  );
}

describe("SessionIndex.delete removes the session from disk", () => {
  test("the transcript, its artifact directory, and both store rows are gone", async () => {
    const sessionsRoot = tempRoot("session-delete-happy-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    const artifacts = writeArtifactDir(path);

    const index = buildIndex(sessionsRoot, store);
    // Both rows this store keeps about a session, populated the way the
    // daemon populates them: an operator archived it, and a warm pass
    // counted it. A delete that left either behind would leave the session
    // half-remembered by a machine whose disk no longer has it.
    index.archive(SESSION_A);
    store.setSessionScanCache(SESSION_A, { mtimeMs: 1, sizeBytes: 2, messageCount: 42 });
    expect(store.listArchivedSessionIds().has(SESSION_A)).toBe(true);
    expect(store.getSessionScanCache(SESSION_A)).not.toBeNull();

    expect(await index.delete([SESSION_A])).toEqual([{ sessionId: SESSION_A, deleted: true }]);

    expect(existsSync(path)).toBe(false);
    expect(existsSync(artifacts)).toBe(false);
    expect(store.listArchivedSessionIds().has(SESSION_A)).toBe(false);
    expect(store.getSessionScanCache(SESSION_A)).toBeNull();
    // And the catalog no longer carries it, which is what a phone sees.
    expect(await index.query({ includeArchived: true })).toEqual([]);
  });

  test("a session with no artifact directory deletes cleanly rather than failing on the absence", async () => {
    const sessionsRoot = tempRoot("session-delete-bare-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);

    const index = buildIndex(sessionsRoot, store);
    expect(await index.delete([SESSION_A])).toEqual([{ sessionId: SESSION_A, deleted: true }]);
    expect(existsSync(path)).toBe(false);
  });

  test("only the named session goes: a sibling in the same group directory survives", async () => {
    const sessionsRoot = tempRoot("session-delete-sibling-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const doomed = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    const keeper = writeSessionFile(sessionsRoot, "-x", "2026-08-12T00-00-00-000Z", SESSION_B);
    const keeperArtifacts = writeArtifactDir(keeper);

    const index = buildIndex(sessionsRoot, store);
    await index.delete([SESSION_A]);

    expect(existsSync(doomed)).toBe(false);
    expect(existsSync(keeper)).toBe(true);
    expect(existsSync(keeperArtifacts)).toBe(true);
  });
});

describe("SessionIndex.delete refuses what it must not destroy", () => {
  test("a live-tui session is refused by name and its file survives", async () => {
    const sessionsRoot = tempRoot("session-delete-live-tui-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    const artifacts = writeArtifactDir(path);
    const runRoot = tempRoot("session-delete-run-live-");
    writeLiveTuiPresence(runRoot, SESSION_A);

    const index = buildIndex(sessionsRoot, store, runRoot);
    // The premise, checked rather than assumed: a presence file that failed
    // to make this row live would make the refusal below vacuous.
    expect((await index.build())[0]?.status).toBe("live-tui");

    expect(await index.delete([SESSION_A])).toEqual([{ sessionId: SESSION_A, deleted: false, refusal: "live" }]);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(artifacts)).toBe(true);
  });

  test("a live-ompd session is refused by name and its file survives", async () => {
    const sessionsRoot = tempRoot("session-delete-live-ompd-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    store.upsertAgent(fakeAgent({ id: "agt_busy", acpSessionId: SESSION_A, state: "busy" }));

    const index = buildIndex(sessionsRoot, store);
    expect((await index.build())[0]?.status).toBe("live-ompd");

    expect(await index.delete([SESSION_A])).toEqual([{ sessionId: SESSION_A, deleted: false, refusal: "live" }]);
    expect(existsSync(path)).toBe(true);
  });

  test("a session held only by a stopped agent is deletable: dormant is not live", async () => {
    const sessionsRoot = tempRoot("session-delete-stopped-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    store.upsertAgent(fakeAgent({ id: "agt_stopped", acpSessionId: SESSION_A, state: "stopped" }));

    const index = buildIndex(sessionsRoot, store);
    expect(await index.delete([SESSION_A])).toEqual([{ sessionId: SESSION_A, deleted: true }]);
    expect(existsSync(path)).toBe(false);
  });

  test("an unknown id is refused rather than silently reported as deleted", async () => {
    const sessionsRoot = tempRoot("session-delete-unknown-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);

    const index = buildIndex(sessionsRoot, store);
    expect(await index.delete([SESSION_C])).toEqual([{ sessionId: SESSION_C, deleted: false, refusal: "not_found" }]);
  });

  test("an archived session's mark alone does not make it deletable when a process holds it", async () => {
    // Archived outranks live in the catalog's own status ranking, which is
    // exactly why liveness is decided from the agent roster here rather than
    // read off the row's `status`: an archived row whose agent is still busy
    // must not be deletable.
    const sessionsRoot = tempRoot("session-delete-archived-live-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    store.upsertAgent(fakeAgent({ id: "agt_busy", acpSessionId: SESSION_A, state: "busy" }));

    const index = buildIndex(sessionsRoot, store);
    index.archive(SESSION_A);

    expect(await index.delete([SESSION_A])).toEqual([{ sessionId: SESSION_A, deleted: false, refusal: "live" }]);
    expect(existsSync(path)).toBe(true);
  });
});

describe("SessionIndex.delete answers for every id in a batch", () => {
  test("a mixed batch reports one outcome per id and deletes exactly the deletable ones", async () => {
    const sessionsRoot = tempRoot("session-delete-batch-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const dormant = writeSessionFile(sessionsRoot, "-a", "2026-08-11T01-11-48-090Z", SESSION_A);
    const live = writeSessionFile(sessionsRoot, "-b", "2026-08-12T00-00-00-000Z", SESSION_B);
    store.upsertAgent(fakeAgent({ id: "agt_busy", acpSessionId: SESSION_B, state: "busy" }));

    const index = buildIndex(sessionsRoot, store);
    // Deliberately ordered live-then-dormant-then-unknown, so a batch that
    // abandoned the rest on the first refusal would leave the dormant file
    // on disk and be caught here rather than passing by luck of ordering.
    const results = await index.delete([SESSION_B, SESSION_A, SESSION_C]);

    expect(results).toEqual([
      { sessionId: SESSION_B, deleted: false, refusal: "live" },
      { sessionId: SESSION_A, deleted: true },
      { sessionId: SESSION_C, deleted: false, refusal: "not_found" },
    ]);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dormant)).toBe(false);
  });

  test("an empty list deletes nothing and says nothing, rather than walking the tree", async () => {
    const sessionsRoot = tempRoot("session-delete-empty-");
    const store = openStore(join(tempRoot("session-delete-db-"), "ompd.db"));
    const path = writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);

    const index = buildIndex(sessionsRoot, store);
    expect(await index.delete([])).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });
});

afterEach(() => {
  while (openStores.length) openStores.pop()?.close();
  while (scratch.length) rmSync(scratch.pop() ?? "", { recursive: true, force: true });
});
