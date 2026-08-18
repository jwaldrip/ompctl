/**
 * The `session_takeover` and `session_resume` frames from the wire: the
 * sealed-socket road a hub-relayed phone takes to open a session, which
 * cannot reach `POST /v1/sessions/:id/takeover` at all because the relay
 * carries frames only, never daemon HTTP paths. Everything the route
 * enforces must hold here, plus the checks only this path needs: the
 * caller's cwd/pid echo is verified against the daemon's own index, and an
 * already-held session answers idempotently instead of spawning a second
 * writer on one transcript.
 *
 * The fixtures follow gateway-sessions-ws.test.ts (session files on disk, a
 * client presence record whose pid is this very test process) with one
 * addition: the flattened directory names are computed with the real
 * encoder, so the index decodes every row's cwd back with confidence and
 * the frames have a truthful value to echo. The TUI leg follows
 * gateway-sessions.test.ts: a paired tunnel that registers, answers the
 * takeover command, and echoes ACP JSON-RPC. Every wait is on an arriving
 * frame or a resolved signal, never on a clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
import { encodeSessionDirName } from "../src/sessions/cwd-codec.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

/**
 * Deadline for waiting on a frame that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 3000;

const SESSION_LIVE = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_DORMANT = "019feebf-6449-7000-9474-a2ae1f871930";
const SESSION_UNKNOWN = "019fff0f-0000-7000-0000-00000000dead";

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
): void {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const line = JSON.stringify({ type: "title", v: 1, title, updatedAt: new Date().toISOString() });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, `${line}\n`);
  // Explicit, deterministic mtime, so ordering never depends on the
  // filesystem clock landing two writes on the same tick under load.
  utimesSync(filePath, mtime, mtime);
}

/**
 * A client presence record naming SESSION_LIVE, with this test process as its
 * pid: `listLiveClientPresences` verifies the pid against the real process
 * table, and the only pid a test can guarantee is alive without spawning
 * anything is its own.
 */
function writeLiveTuiPresence(runRoot: string, projectDir: string): void {
  const clientsDir = join(runRoot, "hash1", "clients");
  mkdirSync(clientsDir, { recursive: true });
  writeFileSync(
    join(clientsDir, "live.json"),
    JSON.stringify({ pid: process.pid, id: "live", projectDir, sessionId: SESSION_LIVE }),
  );
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  /** Bypasses JSON encoding, so a test can put garbage on the wire. */
  sendRaw(raw: string): void;
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
    sendRaw: raw => ws.send(raw),
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

/** The TUI side of a takeover: a paired tunnel that registered its session. */
interface TuiLeg {
  /** Resolves once the daemon commands the takeover. */
  requested: { promise: Promise<void> };
  deliver(raw: string): void;
}

/**
 * A registered live TUI over a paired tunnel, echoing every JSON-RPC request
 * back with an empty result: enough ACP for `initialize` and `session/load`
 * to succeed without standing in for the model.
 */
async function registerTui(h: Harness, sessionId: string, cwd: string, pid: number): Promise<TuiLeg> {
  const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
  const requested = Promise.withResolvers<void>();
  let deliver: ((raw: string) => void) | undefined;
  const tunnel = h.gateway.acceptTunnelSession(token, raw => {
    const frame = JSON.parse(raw) as { t?: string; raw?: unknown };
    if (frame.t === "tui_takeover") {
      requested.resolve();
      return;
    }
    if (frame.t !== "tui_acp" || typeof frame.raw !== "string") return;
    const rpc = JSON.parse(frame.raw) as { id?: unknown };
    if (typeof rpc !== "object" || rpc === null || !("id" in rpc)) return;
    deliver?.(
      JSON.stringify({
        t: "tui_acp",
        sessionId,
        raw: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} }),
      }),
    );
  });
  if (!tunnel.ok) throw new Error(`could not open paired TUI tunnel: ${tunnel.reason}`);
  deliver = tunnel.deliver;
  deliver(JSON.stringify({ t: "tui_register", sessionId, cwd, title: "Live terminal", pid }));
  return { requested, deliver };
}

interface Harness {
  port: number;
  gateway: Gateway;
  store: Store;
  fake: FakeHostController;
  /** Real temp directory the live session's flattened name decodes back to. */
  liveDir: string;
  /** Real temp directory the dormant session's flattened name decodes back to. */
  dormantDir: string;
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(): Promise<Harness> {
  const dbPath = join(tempDir("gw-open-db-"), "ompd.db");
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

  const sessionsRoot = tempDir("gw-open-tree-");
  const runRoot = tempDir("gw-open-run-");
  const liveDir = tempDir("gw-open-live-proj-");
  const dormantDir = tempDir("gw-open-dormant-proj-");
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

  const mtimeBase = new Date("2026-08-13T00:00:00.000Z").getTime();
  // The flattened names are the ones OMP itself would write for these real
  // directories, so the index decodes both rows' cwd back with confidence
  // and a frame has the exact value the daemon expects to see echoed.
  writeSessionFile(
    sessionsRoot,
    encodeSessionDirName(liveDir),
    "2026-08-10T00-00-00-000Z",
    SESSION_LIVE,
    "held by a TUI",
    new Date(mtimeBase),
  );
  writeSessionFile(
    sessionsRoot,
    encodeSessionDirName(dormantDir),
    "2026-08-12T00-00-00-000Z",
    SESSION_DORMANT,
    "on disk only",
    new Date(mtimeBase + 1000),
  );
  writeLiveTuiPresence(runRoot, liveDir);

  return {
    port,
    gateway: gw,
    store,
    fake,
    liveDir,
    dormantDir,
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

function isOpenedFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "session_opened" }> {
  return frame.t === "session_opened";
}

/** The phone-side takeover request for the live row, echoing its own values. */
function takeoverRequest(h: Harness, overrides: { cwd?: string; pid?: number; sessionId?: string } = {}): ClientFrame {
  return {
    t: "session_takeover",
    sessionId: overrides.sessionId ?? SESSION_LIVE,
    cwd: overrides.cwd ?? h.liveDir,
    pid: overrides.pid ?? process.pid,
  };
}

describe("the session_takeover websocket frame", () => {
  test("takes a live-tui session over and answers session_opened through the supervisor's takeover path", async () => {
    const h = await harness();
    const tui = await registerTui(h, SESSION_LIVE, h.liveDir, process.pid);
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send(takeoverRequest(h));
    await tui.requested.promise;
    tui.deliver(JSON.stringify({ t: "tui_acp_ready", sessionId: SESSION_LIVE }));

    const reply = await phone.next(isOpenedFrame, "session_opened frame");
    if (!isOpenedFrame(reply)) throw new Error("expected a session_opened frame");
    expect(reply.sessionId).toBe(SESSION_LIVE);
    expect(reply.agentId).toMatch(/^agt_/);

    // The supervisor's takeover path is what ran, not a spawn-and-load: only
    // `takeOverTuiSession` binds the agent to the `tui:` host key and writes
    // the `takeover: "live-tui"` audit detail.
    const agent = h.store.getAgent(reply.agentId);
    expect(agent?.host.id).toBe(`tui:${SESSION_LIVE}`);
    expect(agent?.acpSessionId).toBe(SESSION_LIVE);
    const created = h.store
      .listAudit(50)
      .find(entry => entry.action === "agent.create" && entry.agentId === reply.agentId);
    expect(created?.detail).toMatchObject({ takeover: "live-tui", sessionId: SESSION_LIVE });
    phone.close();
  });

  test("taking over the same session twice answers the same agent id and creates no second agent", async () => {
    const h = await harness();
    const tui = await registerTui(h, SESSION_LIVE, h.liveDir, process.pid);
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send(takeoverRequest(h));
    await tui.requested.promise;
    tui.deliver(JSON.stringify({ t: "tui_acp_ready", sessionId: SESSION_LIVE }));
    const first = await phone.next(isOpenedFrame, "first session_opened frame");
    if (!isOpenedFrame(first)) throw new Error("expected a session_opened frame");

    // The index now reports the session as held by the first agent, so the
    // second tap must be answered with that same agent rather than refused
    // or fulfilled by a second holder.
    phone.send(takeoverRequest(h));
    const second = await phone.next(isOpenedFrame, "idempotent session_opened frame");
    if (!isOpenedFrame(second)) throw new Error("expected a session_opened frame");

    expect(second.agentId).toBe(first.agentId);
    expect(h.store.listAgents().filter(a => a.acpSessionId === SESSION_LIVE)).toHaveLength(1);
    phone.close();
  });

  test("refuses a cwd that disagrees with the index, naming both, and creates nothing", async () => {
    const h = await harness();
    await registerTui(h, SESSION_LIVE, h.liveDir, process.pid);
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send(takeoverRequest(h, { cwd: "/definitely-not-the-live-dir" }));
    const reply = await phone.next(f => f.t === "error", "cwd mismatch refusal");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("cwd_mismatch");
    expect(reply.message).toContain(h.liveDir);
    expect(reply.message).toContain("/definitely-not-the-live-dir");
    // The refusal is the whole answer: no agent row, no session/load, and
    // the TUI leg was never commanded to hand anything over.
    expect(h.store.listAgents()).toEqual([]);
    expect(h.fake.loads).toEqual([]);
    expect(phone.frames.some(isOpenedFrame)).toBe(false);
    phone.close();
  });

  test("refuses a pid that disagrees with the index, naming both, and creates nothing", async () => {
    const h = await harness();
    await registerTui(h, SESSION_LIVE, h.liveDir, process.pid);
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send(takeoverRequest(h, { pid: process.pid + 1 }));
    const reply = await phone.next(f => f.t === "error", "pid mismatch refusal");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("pid_mismatch");
    expect(reply.message).toContain(String(process.pid));
    expect(reply.message).toContain(String(process.pid + 1));
    expect(h.store.listAgents()).toEqual([]);
    expect(h.fake.loads).toEqual([]);
    phone.close();
  });

  test("refuses an unknown session id on both frames and creates nothing", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send(takeoverRequest(h, { sessionId: SESSION_UNKNOWN }));
    const takeoverReply = await phone.next(f => f.t === "error", "unknown session takeover refusal");
    phone.send({ t: "session_resume", sessionId: SESSION_UNKNOWN, cwd: h.dormantDir });
    const resumeReply = await phone.next(f => f.t === "error", "unknown session resume refusal");

    for (const reply of [takeoverReply, resumeReply]) {
      if (reply.t !== "error") throw new Error("expected an error frame");
      expect(reply.code).toBe("unknown_session");
      expect(reply.message).toContain(SESSION_UNKNOWN);
    }
    expect(h.store.listAgents()).toEqual([]);
    expect(h.fake.loads).toEqual([]);
    phone.close();
  });

  test("refuses a client without the manage scope the HTTP takeover requires", async () => {
    const h = await harness();
    await registerTui(h, SESSION_LIVE, h.liveDir, process.pid);
    const token = await h.pair([SCOPE_READ, SCOPE_PROMPT]); // can watch and type, not take over
    const phone = await h.connect(token);

    phone.send(takeoverRequest(h));
    const takeoverReply = await phone.next(f => f.t === "error", "takeover scope refusal");
    phone.send({ t: "session_resume", sessionId: SESSION_DORMANT, cwd: h.dormantDir });
    const resumeReply = await phone.next(f => f.t === "error", "resume scope refusal");

    for (const reply of [takeoverReply, resumeReply]) {
      if (reply.t !== "error") throw new Error("expected an error frame");
      expect(reply.code).toBe("unauthorized");
      expect(reply.message).toContain("manage scope");
    }
    expect(h.store.listAgents()).toEqual([]);
    expect(h.fake.loads).toEqual([]);
    phone.close();
  });

  test("refuses a takeover of a session the index no longer reports live-tui", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    // A row that was live when the phone listed it can be dormant by the tap
    // (the pid died in between); the honest answer names what it is now.
    phone.send(takeoverRequest(h, { sessionId: SESSION_DORMANT, cwd: h.dormantDir }));
    const reply = await phone.next(f => f.t === "error", "not_live_tui refusal");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("not_live_tui");
    expect(reply.message).toContain("dormant");
    expect(h.store.listAgents()).toEqual([]);
    phone.close();
  });

  test("refuses malformed frames instead of coercing them", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    // Untyped on purpose: a non-integer pid is a value the contract refuses
    // to express, and `sendRaw` exists exactly for putting those on the wire.
    phone.sendRaw(JSON.stringify({ t: "session_takeover", sessionId: SESSION_LIVE, cwd: h.liveDir, pid: "4242" }));
    const reply = await phone.next(f => f.t === "error", "bad frame refusal");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("bad_frame");
    expect(h.store.listAgents()).toEqual([]);
    phone.close();
  });
});

describe("the session_resume websocket frame", () => {
  test("resumes a dormant session and answers session_opened with the loaded id", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send({ t: "session_resume", sessionId: SESSION_DORMANT, cwd: h.dormantDir });
    const reply = await phone.next(isOpenedFrame, "session_opened frame for resume");
    if (!isOpenedFrame(reply)) throw new Error("expected a session_opened frame");

    expect(reply.sessionId).toBe(SESSION_DORMANT);
    // `resumeAgent` loaded the exact session id it was given, minting no new
    // one, and the agent row points at it.
    expect(h.fake.loads).toEqual([SESSION_DORMANT]);
    const agent = h.store.getAgent(reply.agentId);
    expect(agent?.acpSessionId).toBe(SESSION_DORMANT);
    phone.close();
  });

  test("resuming the held session again answers the same agent id and loads nothing a second time", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send({ t: "session_resume", sessionId: SESSION_DORMANT, cwd: h.dormantDir });
    const first = await phone.next(isOpenedFrame, "first session_opened frame");
    if (!isOpenedFrame(first)) throw new Error("expected a session_opened frame");

    phone.send({ t: "session_resume", sessionId: SESSION_DORMANT, cwd: h.dormantDir });
    const second = await phone.next(isOpenedFrame, "idempotent session_opened frame");
    if (!isOpenedFrame(second)) throw new Error("expected a session_opened frame");

    expect(second.agentId).toBe(first.agentId);
    expect(h.fake.loads).toEqual([SESSION_DORMANT]);
    expect(h.store.listAgents().filter(a => a.acpSessionId === SESSION_DORMANT)).toHaveLength(1);
    phone.close();
  });

  test("refuses a cwd that disagrees with the index and loads nothing", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    phone.send({ t: "session_resume", sessionId: SESSION_DORMANT, cwd: "/somewhere-else" });
    const reply = await phone.next(f => f.t === "error", "resume cwd mismatch refusal");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("cwd_mismatch");
    expect(reply.message).toContain(h.dormantDir);
    expect(h.fake.loads).toEqual([]);
    expect(h.store.listAgents()).toEqual([]);
    phone.close();
  });

  test("refuses a resume of a session a live TUI holds, naming the hazard", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_MANAGE]);
    const phone = await h.connect(token);

    // Resuming a session live in a terminal is the two-writers-on-one-file
    // corruption the supervisor documents; the frame must refuse it with the
    // status that makes the cause legible.
    phone.send({ t: "session_resume", sessionId: SESSION_LIVE, cwd: h.liveDir });
    const reply = await phone.next(f => f.t === "error", "not_dormant refusal");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("not_dormant");
    expect(reply.message).toContain("live-tui");
    expect(h.fake.loads).toEqual([]);
    expect(h.store.listAgents()).toEqual([]);
    phone.close();
  });
});

afterEach(async () => {
  while (gateways.length) await gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});

process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
