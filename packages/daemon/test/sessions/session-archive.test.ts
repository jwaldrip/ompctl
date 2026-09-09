import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
const SESSION_LIVE = "019ff8cb-5555-7000-8888-beedf9dfab99";
const SESSION_BAD = "00000000-0000-0000-0000-000000000000";

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

function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  timestamp: string,
  id: string,
  messages: Array<Record<string, unknown>> = [],
): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${timestamp}_${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: `session ${id}` }),
    JSON.stringify({ type: "session", v: 1, id, cwd: "/test" }),
    ...messages.map(m => JSON.stringify(m)),
  ];
  writeFileSync(filePath, lines.join("\n") + "\n");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(timestamp);
  const mtime = match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : new Date(timestamp);
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

function writeReportFile(transcriptPath: string, subagentName = "reviewer"): string {
  const dir = transcriptPath.slice(0, -".jsonl".length);
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, `${subagentName}.md`);
  writeFileSync(reportPath, "# Report\nSummary of findings.\n");
  return reportPath;
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

afterEach(() => {
  for (const store of openStores) store.close();
  openStores.length = 0;
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  scratch.length = 0;
});

describe("session archive", () => {
  test("archiving a set returns per-id outcomes", async () => {
    const sessionsRoot = tempRoot("session-archive-batch-");
    const store = openStore(join(tempRoot("session-archive-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B);

    const index = new SessionIndex({ store, sessionsRoot });
    const results = await index.archive([SESSION_A, SESSION_B]);

    expect(results).toEqual([
      { sessionId: SESSION_A, ok: true, archived: true },
      { sessionId: SESSION_B, ok: true, archived: true },
    ]);
  });

  test("a bad id and a live session both refuse by name while their siblings still succeed", async () => {
    const sessionsRoot = tempRoot("session-archive-refusals-");
    const store = openStore(join(tempRoot("session-archive-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_LIVE);
    writeSessionFile(sessionsRoot, "-z", "2026-08-13T00-00-00-000Z", SESSION_C);

    // Register SESSION_LIVE as held by a live supervised agent
    store.upsertAgent(fakeAgent({ id: "agt_live", acpSessionId: SESSION_LIVE, state: "busy" }));

    const index = new SessionIndex({ store, sessionsRoot });
    const results = await index.archive([SESSION_A, SESSION_BAD, SESSION_LIVE, SESSION_C]);

    expect(results).toEqual([
      { sessionId: SESSION_A, ok: true, archived: true },
      { sessionId: SESSION_BAD, ok: false, refusal: "not_found" },
      { sessionId: SESSION_LIVE, ok: false, refusal: "live" },
      { sessionId: SESSION_C, ok: true, archived: true },
    ]);
  });

  test("archived rows are absent from a default listing and present when explicitly asked for", async () => {
    const sessionsRoot = tempRoot("session-archive-visibility-");
    const store = openStore(join(tempRoot("session-archive-db-"), "ompd.db"));
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B);

    const index = new SessionIndex({ store, sessionsRoot });
    await index.archive([SESSION_A]);

    const defaultList = await index.query();
    expect(defaultList.map(s => s.id)).toEqual([SESSION_B]);

    const fullList = await index.query({ includeArchived: true });
    expect(new Set(fullList.map(s => s.id))).toEqual(new Set([SESSION_A, SESSION_B]));
  });

  test("the state survives a restart of the index", async () => {
    const sessionsRoot = tempRoot("session-archive-restart-");
    const dbPath = join(tempRoot("session-archive-db-"), "ompd.db");
    const store1 = openStore(dbPath);
    writeSessionFile(sessionsRoot, "-x", "2026-08-11T01-11-48-090Z", SESSION_A);
    writeSessionFile(sessionsRoot, "-y", "2026-08-12T00-00-00-000Z", SESSION_B);

    const index1 = new SessionIndex({ store: store1, sessionsRoot });
    await index1.archive([SESSION_A]);
    store1.close();

    // Reopen store from disk exactly as daemon restart does
    const store2 = openStore(dbPath);
    const index2 = new SessionIndex({ store: store2, sessionsRoot });

    const defaultList = await index2.query();
    expect(defaultList.map(s => s.id)).toEqual([SESSION_B]);

    const withArchived = await index2.query({ includeArchived: true });
    const rowA = withArchived.find(s => s.id === SESSION_A);
    expect(rowA).toBeDefined();
    expect(rowA!.archived).toBe(true);
    expect(rowA!.status).toBe("archived");
  });

  test("the ephemeral suggestion selects what you say it selects and spares a live two-message session", async () => {
    const sessionsRoot = tempRoot("session-archive-ephemeral-");
    const store = openStore(join(tempRoot("session-archive-db-"), "ompd.db"));

    // 1. Dormant session with 0 messages, old enough -> candidate
    const session0Msg = "019fee00-0000-7000-0000-000000000001";
    writeSessionFile(sessionsRoot, "-a", "2026-08-01T01-00-00-000Z", session0Msg, []);

    // 2. Dormant session with 2 messages, old enough, no report -> candidate
    const session2Msg = "019fee00-0000-7000-0000-000000000002";
    writeSessionFile(sessionsRoot, "-b", "2026-08-01T02-00-00-000Z", session2Msg, [
      { type: "message", message: { role: "user", content: "hello" } },
      { type: "message", message: { role: "assistant", content: "hi" } },
    ]);

    // 3. Live session with 2 messages -> SPARED (not candidate)
    const sessionLive2Msg = "019fee00-0000-7000-0000-000000000003";
    writeSessionFile(sessionsRoot, "-c", "2026-08-01T03-00-00-000Z", sessionLive2Msg, [
      { type: "message", message: { role: "user", content: "work on bug" } },
      { type: "message", message: { role: "assistant", content: "investigating" } },
    ]);
    store.upsertAgent(fakeAgent({ id: "agt_live_2msg", acpSessionId: sessionLive2Msg, state: "busy" }));

    // 4. Dormant session with 3 messages -> SPARED (not candidate)
    const session3Msg = "019fee00-0000-7000-0000-000000000004";
    writeSessionFile(sessionsRoot, "-d", "2026-08-01T04-00-00-000Z", session3Msg, [
      { type: "message", message: { role: "user", content: "first" } },
      { type: "message", message: { role: "assistant", content: "second" } },
      { type: "message", message: { role: "user", content: "third" } },
    ]);

    // 5. Dormant session with 2 messages but has a <Name>.md report -> SPARED
    const sessionWithReport = "019fee00-0000-7000-0000-000000000005";
    const pathWithReport = writeSessionFile(sessionsRoot, "-e", "2026-08-01T05-00-00-000Z", sessionWithReport, [
      { type: "message", message: { role: "user", content: "run scout" } },
      { type: "message", message: { role: "assistant", content: "scouting" } },
    ]);
    writeReportFile(pathWithReport, "scout");

    const index = new SessionIndex({ store, sessionsRoot });
    const suggested = await index.suggestEphemeral({
      minAgeMs: 3600_000,
      now: new Date("2026-08-02T00:00:00.000Z").getTime(),
    });

    expect(suggested).toContain(session0Msg);
    expect(suggested).toContain(session2Msg);
    expect(suggested).not.toContain(sessionLive2Msg);
    expect(suggested).not.toContain(session3Msg);
    expect(suggested).not.toContain(sessionWithReport);
    expect(suggested).toHaveLength(2);
  });
});
