/**
 * The `session_tail` websocket frame from the wire.
 *
 * A hub-relayed phone has no road to a transcript route: the hub tunnels
 * exactly one request shape, a webhook fire, and none is wired for anything
 * a transcript could ride. So this frame is not a convenience beside a route:
 * it is the only road a session's own transcript can take to the surface the
 * operator is looking at. Everything that makes it safe therefore has to hold
 * here -- the read gate, the refusal of an id this machine holds no file for,
 * the feature-off answer -- because there is no stronger door beside it.
 *
 * The fixtures follow gateway-sessions-ws.test.ts: real session files on disk
 * under a temp sessions root, and a socket helper whose every wait is on an
 * arriving frame rather than on a clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentId,
  type ClientFrame,
  DefaultPolicy,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
} from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { TAIL_SOFT_MAX_BYTES } from "../src/sessions/tail.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

/** Deadline for a frame that should already be on its way; it never elapses on a passing run. */
const SIGNAL_DEADLINE_MS = 5000;

const SESSION = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_BIG = "019feebf-6449-7000-9474-a2ae1f871930";
const HISTORY_AGENT = "agt_history0000001" as AgentId;

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
  /** Bypasses JSON encoding, so a test can put a shape the contract refuses on the wire. */
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
      }, SIGNAL_DEADLINE_MS);
      pending = {
        // The cursor steps past frames that do not match, so a later `next`
        // cannot re-match one an earlier call already stepped over.
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
  /** Size of the deliberately oversized session file, for cost assertions. */
  bigBytes: number;
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(opts: { withSessionIndex?: boolean } = {}): Promise<Harness> {
  const withSessionIndex = opts.withSessionIndex ?? true;
  const dbPath = join(tempDir("gw-tail-db-"), "ompd.db");
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

  const sessionsRoot = tempDir("gw-tail-tree-");
  const runRoot = tempDir("gw-tail-run-");
  const sessionIndex = withSessionIndex
    ? new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot })
    : undefined;

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    ...(sessionIndex ? { sessionIndex } : {}),
  });
  gateways.push(gw);
  const port = await gw.listen();

  writeSessionFile(sessionsRoot, "-work", SESSION, [
    { type: "title", v: 1, title: "the session" },
    { type: "session", version: 3, id: SESSION, timestamp: "t", cwd: "/work" },
    turn("user", "one", "2026-08-13T00:00:01.000Z"),
    { type: "model_change", id: "mc", model: "m" },
    turn("assistant", "two", "2026-08-13T00:00:02.000Z"),
    {
      type: "message",
      id: "tr",
      timestamp: "2026-08-13T00:00:03.000Z",
      message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "clean" }] },
    },
    {
      type: "message",
      id: "tc",
      timestamp: "2026-08-13T00:00:04.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "not words" },
          { type: "toolCall", toolName: "bash", input: {} },
        ],
      },
    },
    turn("user", "three", "2026-08-13T00:00:05.000Z"),
  ]);
  store.upsertAgent({
    id: HISTORY_AGENT,
    name: "history",
    state: "stopped",
    acpSessionId: SESSION,
    host: { kind: "local", id: "dead", spec: { kind: "local" } },
    cwd: "/work",
    createdAt: "2026-08-13T00:00:00.000Z",
    lastActiveAt: "2026-08-13T00:00:05.000Z",
    labels: {},
  });

  // A session far larger than a tail, whose newest turn is at the very end:
  // the phone must get that turn without the daemon reading megabytes.
  const noise: unknown[] = [];
  const filler = "x".repeat(4096);
  for (let i = 0; i < 800; i++) {
    noise.push({
      type: "message",
      id: `t${i}`,
      timestamp: "2026-08-13T00:00:00.000Z",
      message: { role: "toolResult", toolCallId: `x${i}`, toolName: "read", content: [{ type: "text", text: filler }] },
    });
  }
  const bigPath = writeSessionFile(sessionsRoot, "-big", SESSION_BIG, [
    { type: "title", v: 1, title: "the long one" },
    turn("user", "buried"),
    ...noise,
    turn("assistant", "the last word", "2026-08-13T09:00:00.000Z"),
  ]);

  return {
    port,
    bigBytes: statSync(bigPath).size,
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

function isTailFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "session_tail" }> {
  return frame.t === "session_tail";
}

function isHistoryFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "session_history" }> {
  return frame.t === "session_history";
}

describe("the structured session history websocket frame", () => {
  test("returns thinking, tools and text for the requested agent session only", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));
    socket.send({ t: "session_history", agentId: HISTORY_AGENT, sessionId: SESSION });
    const reply = await socket.next(isHistoryFrame, "structured history frame");
    if (!isHistoryFrame(reply)) throw new Error("expected session_history");
    expect(reply.agentId).toBe(HISTORY_AGENT);
    expect(reply.entries.some(entry => entry.kind === "user" && entry.text === "one")).toBe(true);
    expect(reply.entries.some(entry => entry.kind === "assistant" && entry.text === "two")).toBe(true);
    expect(reply.nextBefore).toBeNull();
    socket.close();
  });

  test("refuses missing read scope and agent/session mismatch", async () => {
    const h = await harness();
    const noRead = await h.connect(await h.pair([SCOPE_PROMPT]));
    noRead.send({ t: "session_history", agentId: HISTORY_AGENT, sessionId: SESSION });
    const scope = await noRead.next(frame => frame.t === "error", "history scope refusal");
    expect(scope.t === "error" ? scope.code : "").toBe("unauthorized");
    noRead.close();

    const reader = await h.connect(await h.pair([SCOPE_READ]));
    reader.send({ t: "session_history", agentId: HISTORY_AGENT, sessionId: SESSION_BIG });
    const mismatch = await reader.next(frame => frame.t === "error", "history identity refusal");
    expect(mismatch.t === "error" ? mismatch.code : "").toBe("unknown_session");
    reader.close();
  });
});

describe("the session tail websocket frame", () => {
  test("answers a read-scoped client with the session's own turns, oldest first", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "session_tail", sessionId: SESSION });
    const reply = await socket.next(isTailFrame, "session tail frame");
    if (!isTailFrame(reply)) throw new Error("expected a session_tail frame");

    expect(reply.sessionId).toBe(SESSION);
    // Only words, and only from the two speakers: the tool result carried a
    // text block and the last assistant turn carried thinking plus a tool
    // call, and neither is anybody's words.
    expect(reply.messages).toEqual([
      { role: "user", text: "one", at: "2026-08-13T00:00:01.000Z" },
      { role: "assistant", text: "two", at: "2026-08-13T00:00:02.000Z" },
      { role: "user", text: "three", at: "2026-08-13T00:00:05.000Z" },
    ]);
    expect(reply.truncated).toBe(false);
    socket.close();
  });

  test("honours a limit and reports that older turns were dropped", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "session_tail", sessionId: SESSION, limit: 1 });
    const reply = await socket.next(isTailFrame, "session tail frame");
    if (!isTailFrame(reply)) throw new Error("expected a session_tail frame");

    expect(reply.messages.map(m => m.text)).toEqual(["three"]);
    expect(reply.truncated).toBe(true);
    socket.close();
  });

  test("a session far larger than its tail still answers, with the newest turn", async () => {
    const h = await harness();
    expect(h.bigBytes).toBeGreaterThan(TAIL_SOFT_MAX_BYTES * 3);
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "session_tail", sessionId: SESSION_BIG, limit: 1 });
    const reply = await socket.next(isTailFrame, "session tail frame");
    if (!isTailFrame(reply)) throw new Error("expected a session_tail frame");

    expect(reply.messages).toEqual([{ role: "assistant", text: "the last word", at: "2026-08-13T09:00:00.000Z" }]);
    expect(reply.truncated).toBe(true);
    socket.close();
  });

  test("answers only the socket that asked, never every watcher", async () => {
    // A transcript is not activity: `tui_activity` fans out to every socket
    // watching the index, and a tail that copied that would put one
    // operator's words on every other device paired to this daemon.
    const h = await harness();
    const asking = await h.connect(await h.pair([SCOPE_READ]));
    const other = await h.connect(await h.pair([SCOPE_READ]));

    asking.send({ t: "session_tail", sessionId: SESSION });
    await asking.next(isTailFrame, "session tail frame");

    // A round trip on the other socket, so "nothing arrived" is a fact about
    // a socket the daemon has demonstrably served since, not a race.
    other.send({ t: "ping" });
    await other.next(f => f.t === "pong", "pong on the second socket");
    expect(other.frames.some(isTailFrame)).toBe(false);

    asking.close();
    other.close();
  });

  test("refuses a client without the read scope, and sends no transcript", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_PROMPT]); // holds prompt, not read
    const socket = await h.connect(token);

    socket.send({ t: "session_tail", sessionId: SESSION });
    const reply = await socket.next(f => f.t === "error", "scope refusal error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("unauthorized");
    expect(reply.message).toContain("read scope");
    // The refusal is the whole answer: the gate is synchronous, so by the time
    // it has arrived a wrongly-granted tail would have too.
    expect(socket.frames.some(isTailFrame)).toBe(false);
    socket.close();
  });

  test("refuses an id this machine holds no session for, rather than reading a path from the wire", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "session_tail", sessionId: "019fffff-0000-7000-8000-000000000000" });
    const reply = await socket.next(f => f.t === "error", "unknown session error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("unknown_session");
    expect(socket.frames.some(isTailFrame)).toBe(false);
    socket.close();
  });

  test("refuses a malformed frame instead of coercing it", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    // Untyped on purpose: a limit the contract cannot express must be refused
    // rather than rounded into one it can.
    socket.sendRaw(JSON.stringify({ t: "session_tail", sessionId: SESSION, limit: -3 }));
    const bad = await socket.next(f => f.t === "error", "bad frame error");
    if (bad.t !== "error") throw new Error("expected an error frame");
    expect(bad.code).toBe("bad_frame");

    socket.sendRaw(JSON.stringify({ t: "session_tail", sessionId: "" }));
    const empty = await socket.next(f => f.t === "error", "empty id error");
    if (empty.t !== "error") throw new Error("expected an error frame");
    expect(empty.code).toBe("bad_frame");

    expect(socket.frames.some(isTailFrame)).toBe(false);
    socket.close();
  });

  test("a daemon with no session index says so rather than pretending the session is empty", async () => {
    const h = await harness({ withSessionIndex: false });
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "session_tail", sessionId: SESSION });
    const reply = await socket.next(f => f.t === "error", "feature-off error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("sessions_unavailable");
    expect(socket.frames.some(isTailFrame)).toBe(false);
    socket.close();
  });

  test("a cursor pages the same session backwards, one page per ask, to the start of the file", async () => {
    // The whole point of the frame carrying a cursor: a live terminal session
    // has no agent row, so this is the only road older turns can travel, and
    // the operator must be able to walk the conversation rather than see its
    // last screenful and a dead end.
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    const texts: string[] = [];
    let cursor: number | undefined;
    const cursors: (number | null)[] = [];
    for (let page = 0; page < 4; page++) {
      socket.send({ t: "session_tail", sessionId: SESSION, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
      const reply = await socket.next(isTailFrame, `session tail page ${page}`);
      if (!isTailFrame(reply)) throw new Error("expected a session_tail frame");
      // The echo is what lets a client match an answer to the ask it made.
      expect(reply.cursor).toBe(cursor);
      texts.push(...reply.messages.map(m => m.text));
      cursors.push(reply.nextCursor);
      if (reply.nextCursor === null) break;
      cursor = reply.nextCursor;
    }

    // Newest first by page, oldest first within each, and every turn of the
    // file arrives exactly once.
    expect(texts).toEqual(["three", "two", "one"]);
    expect(cursors.at(-1)).toBeNull();
    socket.close();
  });

  test("a cursor past the end of the file answers exhausted rather than the newest turns again", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    socket.send({ t: "session_tail", sessionId: SESSION, cursor: 50_000_000 });
    const reply = await socket.next(isTailFrame, "session tail frame");
    if (!isTailFrame(reply)) throw new Error("expected a session_tail frame");

    expect(reply.messages).toEqual([]);
    expect(reply.nextCursor).toBeNull();
    expect(reply.truncated).toBe(false);
    socket.close();
  });

  test("a cursor the contract cannot express is refused rather than coerced", async () => {
    const h = await harness();
    const socket = await h.connect(await h.pair([SCOPE_READ]));

    // Untyped on purpose: a negative offset and a fractional one are both
    // shapes a byte cursor cannot mean, and rounding either would page from
    // somewhere the client never named.
    socket.sendRaw(JSON.stringify({ t: "session_tail", sessionId: SESSION, cursor: -1 }));
    const negative = await socket.next(f => f.t === "error", "negative cursor error");
    expect(negative.t === "error" ? negative.code : "").toBe("bad_frame");

    socket.sendRaw(JSON.stringify({ t: "session_tail", sessionId: SESSION, cursor: 12.5 }));
    const fractional = await socket.next(f => f.t === "error", "fractional cursor error");
    expect(fractional.t === "error" ? fractional.code : "").toBe("bad_frame");

    expect(socket.frames.some(isTailFrame)).toBe(false);
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
