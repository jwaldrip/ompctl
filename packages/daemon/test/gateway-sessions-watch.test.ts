/**
 * The watcher-driven `sessions` push: a session file appearing on disk
 * reaches the socket that asked for the index, reaches nobody else, and a
 * burst of writes lands as one push, not one frame per write.
 *
 * Everything here is real: a real gateway on a real port, a real
 * `SessionIndex` over a real sessions root on this disk, and the same
 * `node:fs` recursive watch the daemon ships with. The only thing borrowed
 * is the fake agent host every gateway test already uses, because spawning
 * agents has nothing to do with the filesystem-to-socket path under test.
 *
 * These tests also run in CI on Linux, where Bun delivers the same events
 * (verified on Bun 1.3.14 there): creates, appends, and files inside
 * directories created after the watch started.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientFrame,
  DefaultPolicy,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
} from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { SESSION_WATCH_QUIET_MS, SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

/**
 * Deadline for waiting on a frame that should already be on its way. The
 * push path this file drives carries a real debounce plus a real index
 * build, so the deadline has room for both; it never elapses on a passing
 * run and exists so a missing frame fails with the name of what was
 * expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 5000;

const SESSION_BASE = "019feebf-6449-7000-9474-a2ae1f871930";
const SESSION_LATE = "019feeca-7b2d-7000-8a44-1c9de2f60417";

/** Five distinct burst ids, `i` in 0..4, all matching the session filename scheme. */
function burstId(i: number): string {
  return `019feed0-0000-7000-8000-${String(i).padStart(12, "0")}`;
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeSessionFile(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  id: string,
  title: string,
  mtime: Date,
  cwd = "/work",
): void {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const line = JSON.stringify({ type: "title", v: 1, title, updatedAt: new Date().toISOString() });
  const sessionLine = JSON.stringify({ type: "session", version: 3, id, timestamp: "t", cwd });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, `${line}\n${sessionLine}\n`);
  // Explicit, deterministic mtime, so ordering never depends on the
  // filesystem clock landing two writes on the same tick under load.
  utimesSync(filePath, mtime, mtime);
}

function seedPath(sessionsRoot: string): string {
  return join(sessionsRoot, "-base", `2026-08-10T00-00-00-000Z_${SESSION_BASE}.jsonl`);
}

/** One real transcript turn appended to the seed file, the way a working agent writes. */
function appendTurn(sessionsRoot: string, n: number): void {
  appendFileSync(
    seedPath(sessionsRoot),
    `${JSON.stringify({ type: "message", timestamp: "2026-08-15T00:00:00.000Z", message: { role: "user", content: `turn ${n}` } })}\n`,
  );
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  /** Resolve with the next frame matching `match`, driven by arrival. */
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

  const client: SocketClient = {
    frames,
    send: frame => ws.send(JSON.stringify(frame)),
    next: (match, label) => {
      const settled = Promise.withResolvers<ServerFrame>();
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = {
        // The cursor advances past frames that do not match, so a later
        // `next` never re-matches a frame an earlier one already stepped over.
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
  return client;
}

interface Harness {
  port: number;
  gateway: Gateway;
  sup: Supervisor;
  hosts: HostRegistry;
  sessionsRoot: string;
  /** Read scope alone by default; the delete case below needs manage too. */
  pair(scopes?: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(): Promise<Harness> {
  const dbPath = join(tempDir("gw-watch-db-"), "ompd.db");
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

  const sessionsRoot = tempDir("gw-watch-tree-");
  const runRoot = tempDir("gw-watch-run-");
  const sessionIndex = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
  gateways.push(gw);
  const port = await gw.listen();

  // One seed session, present before any socket exists, so the frames below
  // have a stable "already known" row to contrast with the new ones.
  writeSessionFile(
    sessionsRoot,
    "-base",
    "2026-08-10T00-00-00-000Z",
    SESSION_BASE,
    "the seed session",
    new Date("2026-08-10T00:00:00.000Z"),
  );

  return {
    port,
    gateway: gw,
    sup,
    hosts,
    sessionsRoot,
    pair: async (scopes = [SCOPE_READ]) => {
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

function isSessionsFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "sessions" }> {
  return frame.t === "sessions";
}

/**
 * Real wall-clock waits, used only for the two negative assertions ("no
 * frame reaches a socket that never asked", "no second push follows the
 * burst"): absence has no event to await, and fake timers cannot drive the
 * real filesystem events and real socket delivery this file exists to
 * exercise. Every positive wait goes through `next`, which resolves on the
 * frame itself.
 */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

describe("the watcher-driven sessions push", () => {
  test("a session file appearing on disk reaches the socket that asked, and no socket that never asked", async () => {
    const h = await harness();
    const token = await h.pair();
    const asked = await h.connect(token);
    const silent = await h.connect(token);

    asked.send({ t: "sessions" });
    // Drain the ask's own answer, so any later `sessions` frame on this
    // socket can only be a watcher push.
    await asked.next(isSessionsFrame, "the ask's first paint");

    // The never-asked socket is connected, served, and read-scoped: a pong
    // proves the daemon is talking to it, so the assertion below measures
    // the push gate, not a dead socket.
    silent.send({ t: "ping" });
    await silent.next(f => f.t === "pong", "pong");
    writeSessionFile(
      h.sessionsRoot,
      "-late",
      "2026-08-14T00-00-00-000Z",
      SESSION_LATE,
      "appeared later",
      new Date("2026-08-14T00:00:00.000Z"),
    );

    const pushed = await asked.next(
      f => isSessionsFrame(f) && f.sessions.some(s => s.id === SESSION_LATE),
      "a push carrying the new session",
    );
    expect(
      isSessionsFrame(pushed) && pushed.sessions.some(s => s.id === SESSION_LATE && s.title === "appeared later"),
    ).toBe(true);

    // A wrongly-broadcast push would have been sent in the same synchronous
    // fan-out as the frame `asked` just received; a margin wider than the
    // debounce window settles any such straggler.
    await sleep(SESSION_WATCH_QUIET_MS + 200);
    expect(silent.frames.filter(isSessionsFrame)).toHaveLength(0);
  });

  test("a burst of writes lands as one push, not one frame per write", async () => {
    const h = await harness();
    const token = await h.pair();
    const asked = await h.connect(token);
    asked.send({ t: "sessions" });

    // Wait out the ask's own first paint and its warm upgrade, so the count
    // below measures only frames the watcher produced.
    await asked.next(
      f => isSessionsFrame(f) && f.sessions.some(s => s.id === SESSION_BASE && typeof s.messageCount === "number"),
      "the ask's warm upgrade",
    );
    const baseline = asked.frames.filter(isSessionsFrame).length;

    // One agent-shaped burst: five session files appearing over a few
    // hundred milliseconds while the seed transcript is appended to. The
    // gaps are wide enough that the platform delivers each write as its own
    // event (macOS FSEvents coalesces same-tick writes, which would make a
    // broken debounce look coalesced for free) and narrow enough that the
    // whole burst still falls inside one debounce window. Every write is an
    // event; none of them may cost its own frame.
    for (let i = 0; i < 5; i++) {
      writeSessionFile(
        h.sessionsRoot,
        "-burst",
        `2026-08-15T00-00-0${i}-000Z`,
        burstId(i),
        `burst session ${i}`,
        new Date(`2026-08-15T00:00:0${i}.000Z`),
      );
      appendTurn(h.sessionsRoot, i);
      await sleep(30);
    }

    const last = burstId(4);
    await asked.next(f => isSessionsFrame(f) && f.sessions.some(s => s.id === last), "the pushed first paint");
    await asked.next(
      f => isSessionsFrame(f) && f.sessions.some(s => s.id === last && typeof s.messageCount === "number"),
      "the pushed warm upgrade",
    );
    // A second, uncoalesced notification would land within this margin.
    await sleep(SESSION_WATCH_QUIET_MS + 200);

    const pushedFrames = asked.frames.filter(isSessionsFrame).length - baseline;
    // Exactly the two frames one push produces: first paint, then the warm
    // upgrade. One frame per write would be ten or more here.
    expect(pushedFrames).toBe(2);
  });

  test("a session deleted through the daemon pushes the new index, so the fleet updates with no manual refresh", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const asked = await h.connect(token);

    asked.send({ t: "sessions" });
    // Drain the ask's own answer, so any later `sessions` frame on this
    // socket can only be a watcher push.
    await asked.next(f => isSessionsFrame(f) && f.sessions.some(s => s.id === SESSION_BASE), "the ask's first paint");

    // The real deletion path, not an `rmSync` standing in for it: the whole
    // question is whether what the daemon does to the file produces the
    // watcher event, and a test that removed the file itself would answer a
    // different question.
    asked.send({ t: "session_delete", sessionIds: [SESSION_BASE] });
    const answered = await asked.next(f => f.t === "sessions_deleted", "the delete's own answer");
    if (answered.t !== "sessions_deleted") throw new Error("expected a sessions_deleted frame");
    expect(answered.results).toEqual([{ sessionId: SESSION_BASE, deleted: true }]);

    // The push. Distinguishable from the delete's own answer by frame type,
    // and from the first paint by content: the deleted row is gone from it.
    const pushed = await asked.next(
      f => isSessionsFrame(f) && !f.sessions.some(s => s.id === SESSION_BASE),
      "a push carrying the index without the deleted session",
    );
    expect(isSessionsFrame(pushed) && pushed.sessions).toEqual([]);
  });
});

test("session gone while attached: when session file disappears, emits error session_gone to attached sockets once", async () => {
  const h = await harness();
  const token = await h.pair([SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE]);
  const client = await h.connect(token);

  // Resume the seed session so an agent holds it
  client.send({ t: "session_resume", sessionId: SESSION_BASE, cwd: "/work" });
  const opened = await client.next(f => f.t === "session_opened", "session_opened");
  if (opened.t !== "session_opened") throw new Error("expected session_opened");
  const agentId = opened.agentId;

  // Attach to the agent and flush via ping/pong
  client.send({ t: "attach", agentId });
  client.send({ t: "ping" });
  await client.next(f => f.t === "pong", "pong after attach");

  // Remove the session file from disk
  rmSync(seedPath(h.sessionsRoot));

  // The sessions watcher observes the file disappearance and emits error code: "session_gone"
  const gone = await client.next(f => f.t === "error" && f.code === "session_gone", "session_gone error");
  expect(gone).toMatchObject({
    t: "error",
    code: "session_gone",
    sessionId: SESSION_BASE,
    agentId,
  });

  // Write another session file to trigger another watcher notification
  writeSessionFile(h.sessionsRoot, "-burst", "2026-08-16T00-00-00-000Z", burstId(0), "burst session", new Date());
  await sleep(SESSION_WATCH_QUIET_MS + 200);

  // Assert session_gone was emitted only once
  const goneFrames = client.frames.filter(f => f.t === "error" && f.code === "session_gone");
  expect(goneFrames).toHaveLength(1);
});

afterEach(async () => {
  while (gateways.length) await gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
});

process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
