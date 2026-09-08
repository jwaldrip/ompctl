/**
 * Tests for session subagent transcripts on disk and over the wire.
 *
 * Exercises:
 * (a) listing returns regular .jsonl transcripts newest first with id, byteSize,
 *     hasReport for sibling .md, and ignores logs, md files, and subdirectories;
 * (b) a session with no directory lists empty;
 * (c) session_tail with subagent returns the subagent transcript and echoes subagent,
 *     while plain session_tail still returns the parent session entries;
 * (d) subagent "../x" and "" are refused bad_frame, unknown stem is refused not_found;
 * (e) missing read scope is refused unauthorized for session_subagents.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientFrame, DefaultPolicy, SCOPE_PROMPT, SCOPE_READ, type ServerFrame, Store } from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { listSubagentTranscripts, subagentDirFor, subagentTranscriptPath } from "../src/sessions/subagents.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

const SESSION = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_EMPTY = "019fee60-2c7a-7000-9fd5-7439c7bf3000";

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function turn(role: "user" | "assistant", text: string, at = "2026-08-13T00:00:00.000Z"): unknown {
  return { type: "message", id: `m-${text}`, timestamp: at, message: { role, content: [{ type: "text", text }] } };
}

function writeSessionFile(sessionsRoot: string, flattenedDir: string, id: string, lines: unknown[]): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `2026-08-10T00-00-00-000Z_${id}.jsonl`);
  writeFileSync(filePath, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
  const mtime = new Date("2026-08-13T00:00:00.000Z");
  utimesSync(filePath, mtime, mtime);
  return filePath;
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  sendRaw(raw: string): void;
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

async function connect(port: number, token: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
  const opened = Promise.withResolvers<boolean>();
  const frames: ServerFrame[] = [];
  let cursor = 0;
  let pending: { check: () => boolean; settle: (frame: ServerFrame | null) => void; timer: Timer } | null = null;

  const drain = (): void => {
    if (!pending) return;
    if (!pending.check()) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.settle(frames[cursor - 1] ?? null);
  };

  ws.addEventListener("open", () => opened.resolve(true));
  ws.addEventListener("error", () => opened.resolve(false));
  ws.addEventListener("close", () => opened.resolve(false));
  ws.addEventListener("message", event => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
    drain();
  });

  if (!(await opened.promise)) throw new Error("expected the websocket to open");

  return {
    frames,
    send: frame => ws.send(JSON.stringify(frame)),
    sendRaw: raw => ws.send(raw),
    next: (match, label) => {
      const settled = Promise.withResolvers<ServerFrame>();
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, 5000);
      pending = {
        check: () => {
          while (cursor < frames.length) {
            const frame = frames[cursor];
            cursor += 1;
            if (frame && match(frame)) return true;
          }
          return false;
        },
        settle: frame => {
          if (frame) settled.resolve(frame);
        },
        timer,
      };
      drain();
      return settled.promise;
    },
    close: () => ws.close(),
  };
}

interface Harness {
  port: number;
  sessionsRoot: string;
  parentFilePath: string;
  emptyFilePath: string;
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(): Promise<Harness> {
  const dbPath = join(tempDir("gw-subagent-db-"), "ompd.db");
  paths.push(dbPath);
  const store = new Store(dbPath);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const sessionsRoot = tempDir("gw-subagent-tree-");
  const runRoot = tempDir("gw-subagent-run-");
  const sessionIndex = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    sessionIndex,
  });
  gateways.push(gw);
  const port = await gw.listen();

  // Write parent session file.
  const parentFilePath = writeSessionFile(sessionsRoot, "-work", SESSION, [
    { type: "title", v: 1, title: "parent session" },
    { type: "session", version: 3, id: SESSION, timestamp: "t", cwd: "/work" },
    turn("user", "parent question", "2026-08-10T00:00:01.000Z"),
    turn("assistant", "parent answer", "2026-08-10T00:00:02.000Z"),
  ]);

  // Write second session file with no subagents directory.
  const emptyFilePath = writeSessionFile(sessionsRoot, "-work", SESSION_EMPTY, [
    { type: "title", v: 1, title: "empty session" },
    { type: "session", version: 3, id: SESSION_EMPTY, timestamp: "t", cwd: "/work" },
    turn("user", "lonely question", "2026-08-10T00:00:01.000Z"),
  ]);

  // Create subagents directory for parent session.
  const subDir = subagentDirFor(parentFilePath);
  mkdirSync(subDir, { recursive: true });

  // 1. Older subagent transcript: OldAgent.jsonl
  const oldPath = join(subDir, "OldAgent.jsonl");
  writeFileSync(
    oldPath,
    [
      JSON.stringify({ type: "title", v: 1, title: "old subagent" }),
      JSON.stringify({ type: "session", version: 3, id: "sub-old-id", timestamp: "t", cwd: "/work" }),
      JSON.stringify(turn("user", "old task", "2026-08-11T00:00:01.000Z")),
      JSON.stringify(turn("assistant", "old answer", "2026-08-11T00:00:02.000Z")),
    ].join("\n") + "\n",
  );
  const oldMtime = new Date("2026-08-11T12:00:00.000Z");
  utimesSync(oldPath, oldMtime, oldMtime);

  // 2. Newer subagent transcript: NewAgent.jsonl with sibling report NewAgent.md
  const newPath = join(subDir, "NewAgent.jsonl");
  writeFileSync(
    newPath,
    [
      JSON.stringify({ type: "title", v: 1, title: "new subagent" }),
      JSON.stringify({ type: "session", version: 3, id: "sub-new-id", timestamp: "t", cwd: "/work" }),
      JSON.stringify(turn("user", "new task", "2026-08-12T00:00:01.000Z")),
      JSON.stringify(turn("assistant", "new answer", "2026-08-12T00:00:02.000Z")),
    ].join("\n") + "\n",
  );
  const newMtime = new Date("2026-08-12T12:00:00.000Z");
  utimesSync(newPath, newMtime, newMtime);

  const reportPath = join(subDir, "NewAgent.md");
  writeFileSync(reportPath, "# Report for NewAgent\nFinished successfully.\n");
  utimesSync(reportPath, newMtime, newMtime);

  // 3. Noise files that must be ignored: log file, non-subagent md file, nested directory
  const logPath = join(subDir, "123.bash.log");
  writeFileSync(logPath, "some log output\n");

  const otherMdPath = join(subDir, "notes.md");
  writeFileSync(otherMdPath, "random notes\n");

  const nestedSubDir = join(subDir, "nested-dir");
  mkdirSync(nestedSubDir, { recursive: true });
  writeFileSync(join(nestedSubDir, "Nested.jsonl"), "nested\n");

  return {
    port,
    sessionsRoot,
    parentFilePath,
    emptyFilePath,
    pair: async scopes => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    connect: token => connect(port, token),
  };
}

function isSubagentsFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "session_subagents" }> {
  return frame.t === "session_subagents";
}

function isTailFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "session_tail" }> {
  return frame.t === "session_tail";
}

describe("subagent transcripts on disk", () => {
  test("(a) listing returns the two .jsonl transcripts newest first with id, byteSize, hasReport true for sibling .md, and ignores logs, md, and subdirectories", async () => {
    const h = await harness();
    const list = await listSubagentTranscripts(h.parentFilePath);

    expect(list.length).toBe(2);

    // Newest first
    const [first, second] = list;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("expected two transcripts");

    // Newest first
    expect(first.name).toBe("NewAgent");
    expect(first.id).toBe("sub-new-id");
    expect(first.hasReport).toBe(true);
    expect(first.byteSize).toBeGreaterThan(0);
    expect(first.updatedAt).toBe("2026-08-12T12:00:00.000Z");

    // Older second
    expect(second.name).toBe("OldAgent");
    expect(second.id).toBe("sub-old-id");
    expect(second.hasReport).toBe(false);
    expect(second.byteSize).toBeGreaterThan(0);
    expect(second.updatedAt).toBe("2026-08-11T12:00:00.000Z");
    // subagentTranscriptPath resolution
    const resolvedNew = subagentTranscriptPath(h.parentFilePath, "NewAgent");
    expect(resolvedNew.ok).toBe(true);
    if (resolvedNew.ok) {
      expect(resolvedNew.path.endsWith("NewAgent.jsonl")).toBe(true);
    }
  });

  test("(b) a session with no directory lists []", async () => {
    const h = await harness();
    const list = await listSubagentTranscripts(h.emptyFilePath);
    expect(list).toEqual([]);
  });

  test("(f) a transcript's state is what its tail records prove: done, idle, running, stalled", async () => {
    // Record shapes as OMP writes them, measured on 2026-09-08: the exit
    // record is `{type:"custom",customType:"session_exit"}`; a yield is an
    // assistant `toolCall` named `yield` that no `toolResult` follows; a
    // working tool call is answered by a `toolResult` with its `toolCallId`.
    const sessionsRoot = tempDir("sub-state-");
    const parent = writeSessionFile(sessionsRoot, "-x", SESSION, [turn("user", "hi")]);
    const dir = subagentDirFor(parent);
    mkdirSync(dir, { recursive: true });
    const header = [
      { type: "title", v: 1, title: "", updatedAt: "2026-09-08T00:00:00.000Z" },
      { type: "session", version: 3, id: "sub-id", timestamp: "t", cwd: "/x" },
    ];
    const call = (name: string, id: string): unknown => ({
      type: "message",
      id: `a-${id}`,
      timestamp: "2026-09-08T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
    });
    const answer = (id: string): unknown => ({
      type: "message",
      id: `r-${id}`,
      timestamp: "2026-09-08T00:00:02.000Z",
      message: { role: "toolResult", toolCallId: id, toolName: "x", content: [{ type: "text", text: "ok" }] },
    });
    const exit = { type: "custom", customType: "session_exit", data: { reason: "dispose", kind: "normal" } };
    const now = Date.parse("2026-09-08T12:00:00.000Z");
    const write = (name: string, records: unknown[], mtimeMs: number): void => {
      const path = join(dir, `${name}.jsonl`);
      writeFileSync(path, `${records.map(r => JSON.stringify(r)).join("\n")}\n`);
      utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
    };
    // Done: exited after yielding, the ordinary end of a reaped subagent.
    write("Done", [...header, call("yield", "c1"), exit], now - 3_600_000);
    // Idle: the yield call is the last record, not exited, however long
    // ago; a parked agent is revivable, so its age proves nothing.
    write("Idle", [...header, call("bash", "c1"), answer("c1"), call("yield", "c2")], now - 3_600_000);
    // Sent back to work after a yield: the last call is no longer yield.
    write("Revived", [...header, call("yield", "c1"), answer("c1"), call("edit", "c2"), answer("c2")], now - 10_000);
    // Running: mid-tool, written seconds ago.
    write("Running", [...header, call("bash", "c1")], now - 10_000);
    // Stalled: mid-tool and silent for longer than the stall window.
    write("Stalled", [...header, call("bash", "c1")], now - 10 * 60_000);

    const byName = new Map((await listSubagentTranscripts(parent, now)).map(t => [t.name, t.state]));
    expect(byName.get("Done")).toBe("done");
    expect(byName.get("Idle")).toBe("idle");
    expect(byName.get("Revived")).toBe("running");
    expect(byName.get("Running")).toBe("running");
    expect(byName.get("Stalled")).toBe("stalled");
  });
});

describe("subagent transcripts over websocket", () => {
  test("(a) session_subagents returns the transcripts newest first", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    socket.send({ t: "session_subagents", sessionId: SESSION });
    const reply = await socket.next(isSubagentsFrame, "session_subagents frame");
    if (!isSubagentsFrame(reply)) throw new Error("expected session_subagents frame");

    expect(reply.sessionId).toBe(SESSION);
    expect(reply.subagents.length).toBe(2);
    const [subFirst, subSecond] = reply.subagents;
    expect(subFirst).toBeDefined();
    expect(subSecond).toBeDefined();
    if (!subFirst || !subSecond) throw new Error("expected two subagents");
    expect(subFirst.name).toBe("NewAgent");
    expect(subFirst.id).toBe("sub-new-id");
    expect(subFirst.hasReport).toBe(true);
    expect(subSecond.name).toBe("OldAgent");
    expect(subSecond.id).toBe("sub-old-id");
    expect(subSecond.hasReport).toBe(false);
    socket.close();
  });

  test("(b) session_subagents for a session with no directory lists []", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    socket.send({ t: "session_subagents", sessionId: SESSION_EMPTY });
    const reply = await socket.next(isSubagentsFrame, "session_subagents empty frame");
    if (!isSubagentsFrame(reply)) throw new Error("expected session_subagents frame");

    expect(reply.sessionId).toBe(SESSION_EMPTY);
    expect(reply.subagents).toEqual([]);
    socket.close();
  });

  test("(c) session_tail with subagent returns that transcript entries and echoes subagent, and plain session_tail returns parent entries", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    // Subagent tail
    socket.send({ t: "session_tail", sessionId: SESSION, subagent: "NewAgent" });
    const subTail = await socket.next(isTailFrame, "session_tail subagent frame");
    if (!isTailFrame(subTail)) throw new Error("expected session_tail frame");

    expect(subTail.sessionId).toBe(SESSION);
    expect(subTail.subagent).toBe("NewAgent");
    expect(subTail.messages.some(m => m.text === "new task")).toBe(true);
    expect(subTail.messages.some(m => m.text === "new answer")).toBe(true);
    expect(subTail.messages.some(m => m.text === "parent question")).toBe(false);

    // Plain session tail without subagent
    socket.send({ t: "session_tail", sessionId: SESSION });
    const parentTail = await socket.next(f => isTailFrame(f) && f.subagent === undefined, "session_tail parent frame");
    if (!isTailFrame(parentTail)) throw new Error("expected session_tail frame");

    expect(parentTail.sessionId).toBe(SESSION);
    expect(parentTail.subagent).toBeUndefined();
    expect(parentTail.messages.some(m => m.text === "parent question")).toBe(true);
    expect(parentTail.messages.some(m => m.text === "parent answer")).toBe(true);
    expect(parentTail.messages.some(m => m.text === "new task")).toBe(false);

    socket.close();
  });

  test("(d) subagent '../x' and '' are refused bad_frame, unknown stem is refused not_found", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    socket.send({ t: "session_tail", sessionId: SESSION, subagent: "../x" });
    const badTraversal = await socket.next(f => f.t === "error", "bad_frame traversal error");
    expect(badTraversal.t === "error" ? badTraversal.code : "").toBe("bad_frame");

    socket.send({ t: "session_tail", sessionId: SESSION, subagent: "" });
    const badEmpty = await socket.next(f => f.t === "error", "bad_frame empty error");
    expect(badEmpty.t === "error" ? badEmpty.code : "").toBe("bad_frame");

    socket.send({ t: "session_tail", sessionId: SESSION, subagent: "NonExistent" });
    const notFound = await socket.next(f => f.t === "error", "not_found error");
    expect(notFound.t === "error" ? notFound.code : "").toBe("not_found");

    socket.close();
  });

  test("(e) read scope missing is refused unauthorized for session_subagents", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_PROMPT]); // prompt scope only, no read scope
    const socket = await h.connect(token);

    socket.send({ t: "session_subagents", sessionId: SESSION });
    const reply = await socket.next(f => f.t === "error", "unauthorized error");
    if (reply.t !== "error") throw new Error("expected error frame");

    expect(reply.code).toBe("unauthorized");
    expect(reply.message).toContain("read scope");
    socket.close();
  });
});

afterEach(async () => {
  for (const gw of gateways.splice(0)) await gw.close();
  for (const store of stores.splice(0)) store.close();
});

process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
