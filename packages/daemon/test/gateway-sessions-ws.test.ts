/**
 * The `sessions` websocket frame from the wire: the sealed-socket road the
 * session index takes to a hub-relayed phone, which cannot reach the HTTP
 * route at all. Everything the HTTP route enforces must hold here too -- the
 * read scope, the feature-off answer, the refusal of malformed queries -- or
 * the frame would be a weaker door beside a strong one, and the phone is the
 * client that can only use the weak one.
 *
 * The fixtures follow gateway-sessions.test.ts: session files on disk, plus a
 * client presence record whose pid is this very test process, which is the
 * honest way to make a live-tui row without spawning anything. The socket
 * helper follows gateway.test.ts: every wait is on an arriving frame, never
 * on a clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientFrame, DefaultPolicy, SCOPE_PROMPT, SCOPE_READ, type ServerFrame, Store } from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

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
function writeLiveTuiPresence(runRoot: string): void {
  const clientsDir = join(runRoot, "hash1", "clients");
  mkdirSync(clientsDir, { recursive: true });
  writeFileSync(
    join(clientsDir, "live.json"),
    JSON.stringify({ pid: process.pid, id: "live", projectDir: tempDir("gw-ws-proj-"), sessionId: SESSION_LIVE }),
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

interface Harness {
  port: number;
  gateway: Gateway;
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(opts: { withSessionIndex?: boolean } = {}): Promise<Harness> {
  const withSessionIndex = opts.withSessionIndex ?? true;
  const dbPath = join(tempDir("gw-ws-sessions-db-"), "ompd.db");
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

  const sessionsRoot = tempDir("gw-ws-sessions-tree-");
  const runRoot = tempDir("gw-ws-sessions-run-");
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

  const mtimeBase = new Date("2026-08-13T00:00:00.000Z").getTime();
  // The live one is the older file on purpose: if the row still comes back
  // live-tui, it is because the presence record said so, not because a
  // default recency sort happened to put it first.
  writeSessionFile(
    sessionsRoot,
    "-live",
    "2026-08-10T00-00-00-000Z",
    SESSION_LIVE,
    "held by a TUI",
    new Date(mtimeBase),
  );
  writeSessionFile(
    sessionsRoot,
    "-dormant",
    "2026-08-12T00-00-00-000Z",
    SESSION_DORMANT,
    "on disk only",
    new Date(mtimeBase + 1000),
  );
  if (withSessionIndex) writeLiveTuiPresence(runRoot);

  return {
    port,
    gateway: gw,
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

function isSessionsFrame(frame: ServerFrame): frame is Extract<ServerFrame, { t: "sessions" }> {
  return frame.t === "sessions";
}

describe("the sessions websocket frame", () => {
  test("answers a read-scoped client with live-tui and dormant rows over the socket", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "sessions" });
    const reply = await socket.next(isSessionsFrame, "sessions frame");
    if (!isSessionsFrame(reply)) throw new Error("expected a sessions frame");

    expect(reply.sessions.map(s => [s.id, s.status])).toEqual([
      [SESSION_DORMANT, "dormant"],
      [SESSION_LIVE, "live-tui"],
    ]);
    // The live row carries the presence's pid, which is what a phone taps
    // through to when it asks the daemon to take a TUI session over.
    const live = reply.sessions.find(s => s.id === SESSION_LIVE);
    expect(live?.pid).toBe(process.pid);
    socket.close();
  });

  test("refuses a client without the read scope", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_PROMPT]); // holds prompt, not read
    const socket = await h.connect(token);

    socket.send({ t: "sessions" });
    const reply = await socket.next(f => f.t === "error", "scope refusal error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("unauthorized");
    expect(reply.message).toContain("read scope");
    // The refusal is the whole answer: the handler is synchronous, so by the
    // time the error has arrived, a wrongly-granted index would have too.
    expect(socket.frames.some(isSessionsFrame)).toBe(false);
    socket.close();
  });

  test("refuses a malformed query instead of coercing it", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);
    // Untyped on purpose: the whole point is putting a value on the wire
    // that the contract refuses to express. `sendRaw` exists for exactly
    // this; `send` would have rejected it at compile time.
    socket.sendRaw(JSON.stringify({ t: "sessions", query: { sort: "not-a-real-key" } }));
    const reply = await socket.next(f => f.t === "error", "bad query error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("bad_query");
    expect(reply.message).toContain("unknown sort");
    expect(socket.frames.some(isSessionsFrame)).toBe(false);
    socket.close();
  });

  test("refuses a query whose shape the contract does not allow, rather than repairing it", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    // A bare string where the contract wants an array could be silently
    // wrapped into a one-element filter; refusing it is the honest answer,
    // and it is what the HTTP route's own parser would do with nonsense.
    socket.sendRaw(JSON.stringify({ t: "sessions", query: { status: "dormant" } }));
    const reply = await socket.next(f => f.t === "error", "shape error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    expect(reply.code).toBe("bad_query");
    expect(socket.frames.some(isSessionsFrame)).toBe(false);
    socket.close();
  });

  test("runs the query server-side: a status filter narrows the frame to matching rows", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "sessions", query: { status: ["dormant"] } });
    const reply = await socket.next(isSessionsFrame, "filtered sessions frame");
    if (!isSessionsFrame(reply)) throw new Error("expected a sessions frame");

    expect(reply.sessions.map(s => s.id)).toEqual([SESSION_DORMANT]);
    socket.close();
  });

  test("answers only the socket that asked, not every connected client", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const asker = await h.connect(token);
    const bystander = await h.connect(token);
    asker.send({ t: "sessions" });
    const reply = await asker.next(isSessionsFrame, "sessions frame for the asker");
    if (!isSessionsFrame(reply)) throw new Error("expected a sessions frame");
    expect(reply.sessions.length).toBe(2);

    // The bystander's frame list is complete for everything the daemon sent
    // it (hello at open, nothing since). One refresh on one phone must not
    // push the index at every other client on the daemon.
    expect(bystander.frames.filter(f => f.t !== "hello")).toEqual([]);
    asker.close();
    bystander.close();
  });

  test("reports the feature off when no SessionIndex is wired in", async () => {
    const h = await harness({ withSessionIndex: false });
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);
    socket.send({ t: "sessions" });
    const reply = await socket.next(f => f.t === "error", "sessions_unavailable error");
    if (reply.t !== "error") throw new Error("expected an error frame");

    socket.close();
  });
});

/**
 * The first-paint contract over the wire: a cold daemon answers the
 * `sessions` frame immediately with every row and null counts, then sends
 * exactly one upgraded frame once the background warm pass has counted --
 * and the daemon stays healthily answerable while that pass runs, which is
 * the acceptance bar the whole cooperative rewrite exists to meet.
 */
describe("the sessions frame's first paint, upgrade, and liveness", () => {
  /** The same harness shape, over a corpus the test owns: sessions with real message lines, a cold store. */
  async function corpusHarness(): Promise<Harness & { sessionsRoot: string }> {
    const dbPath = join(tempDir("gw-ws-corpus-db-"), "ompd.db");
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

    const sessionsRoot = tempDir("gw-ws-corpus-tree-");
    const runRoot = tempDir("gw-ws-corpus-run-");
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
    return {
      port,
      gateway: gw,
      sessionsRoot,
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

  function writeCountedSessionFile(sessionsRoot: string, id: string, turns: number, pad = 1): void {
    const groupDir = join(sessionsRoot, "-corpus");
    mkdirSync(groupDir, { recursive: true });
    const lines: string[] = [JSON.stringify({ type: "title", v: 1, title: `s ${id}`, updatedAt: "t" })];
    for (let i = 0; i < turns; i++) {
      lines.push(
        JSON.stringify({
          type: "message",
          id: `m${i}`,
          message: { role: i % 2 ? "user" : "assistant", content: [{ type: "text", text: "x".repeat(pad) }] },
        }),
      );
    }
    writeFileSync(join(groupDir, `2026-08-12T00-00-00-000Z_${id}.jsonl`), `${lines.join("\n")}\n`);
  }

  test("first frame paints null counts, the second carries the real ones", async () => {
    const h = await corpusHarness();
    writeCountedSessionFile(h.sessionsRoot, "aaaaaaaa-0000-7000-0000-000000000001", 2);
    writeCountedSessionFile(h.sessionsRoot, "aaaaaaaa-0000-7000-0000-000000000002", 0);
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);

    socket.send({ t: "sessions" });
    const first = await socket.next(isSessionsFrame, "first-paint sessions frame");
    if (!isSessionsFrame(first)) throw new Error("expected a sessions frame");
    // Every row present immediately; unknown counts are null, never 0.
    expect(first.sessions).toHaveLength(2);
    expect(first.sessions.every(s => s.messageCount === null)).toBe(true);

    const upgraded = await socket.next(isSessionsFrame, "upgraded sessions frame");
    if (!isSessionsFrame(upgraded)) throw new Error("expected a sessions frame");
    const byId = new Map(upgraded.sessions.map(s => [s.id, s.messageCount]));
    expect(byId.get("aaaaaaaa-0000-7000-0000-000000000001")).toBe(2);
    // A real zero: this file was read and genuinely has no turns.
    expect(byId.get("aaaaaaaa-0000-7000-0000-000000000002")).toBe(0);

    // Exactly one upgrade, and nothing further after it.
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    expect(socket.frames.filter(isSessionsFrame)).toHaveLength(2);
    socket.close();
  });

  test("/v1/health keeps being served while the index scans and counts", async () => {
    const h = await corpusHarness();
    // One transcript too large to count in a single event-loop slice. Size
    // matters more than file count: the warm pass already yields between
    // files, so only an indivisible count inside one file can hold the loop,
    // which is the shape that wedged the daemon.
    writeCountedSessionFile(h.sessionsRoot, "aaaaaaaa-0000-7000-0000-000000000001", 20_000, 1100);
    const token = await h.pair([SCOPE_READ]);
    const socket = await h.connect(token);
    const healthUrl = `http://127.0.0.1:${h.port}/v1/health`;

    const probeHealth = async (): Promise<number> => {
      const started = performance.now();
      const res = await fetch(healthUrl);
      await res.arrayBuffer();
      expect(res.status).toBe(200);
      return performance.now() - started;
    };

    // Control, measured on this machine with the daemon idle: the assertion
    // below is relative to this, because a shared runner's absolute latency
    // is not a property of this daemon.
    const idle: number[] = [];
    for (let i = 0; i < 5; i++) idle.push(await probeHealth());
    idle.sort((a, b) => a - b);
    const baselineMs = idle[2] ?? 0;

    // Probing starts before the request and runs to the upgraded frame, so
    // it covers the scan and the count. The counting overlaps first paint, so
    // a loop that started after that frame would measure a finished build.
    let working = true;
    const probing = (async (): Promise<{ worst: number; probes: number }> => {
      let worst = 0;
      let probes = 0;
      while (working) {
        worst = Math.max(worst, await probeHealth());
        probes += 1;
      }
      return { worst, probes };
    })();

    socket.send({ t: "sessions" });
    const first = await socket.next(isSessionsFrame, "first-paint sessions frame");
    expect(isSessionsFrame(first) && first.sessions.every(s => s.messageCount === null)).toBe(true);
    const upgraded = await socket.next(isSessionsFrame, "upgraded sessions frame");
    working = false;
    const { worst, probes } = await probing;

    // The count really did run inside the probed window.
    expect(isSessionsFrame(upgraded) && upgraded.sessions.every(s => s.messageCount === 20_000)).toBe(true);
    expect(probes).toBeGreaterThan(3);
    // A count that holds the loop parks every probe that lands inside it, so
    // the worst answer rises to the length of the stall. The floor keeps a
    // sub-millisecond baseline from making this unsatisfiable.
    expect(worst).toBeLessThan(Math.max(baselineMs * 10, 15));
    socket.close();
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
