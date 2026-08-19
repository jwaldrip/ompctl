/**
 * Steering a live terminal session, from the wire.
 *
 * The property under test is routing with a refusal that names itself. A
 * `session_prompt` may only reach the one socket that registered that session,
 * a client without prompt scope may not send one at all, and a session no TUI
 * registered has to come back as `tui_unreachable` rather than as silence --
 * silence is what a phone cannot tell apart from a daemon that dropped the
 * instruction, and it is the exact failure this frame exists to avoid.
 *
 * The negative assertions are paired with their positives on purpose: "the TUI
 * received nothing" is also what a broken send path looks like, so each refusal
 * test is followed by the same setup succeeding. A `ping`/`pong` barrier is what
 * makes the negatives real: frames on one socket are ordered, so a pong proves
 * everything the daemon was going to push before it has already been pushed.
 *
 * Nothing here sleeps.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const SIGNAL_DEADLINE_MS = 3000;

const SESSION = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const OTHER_SESSION = "019feebf-6449-7000-9474-a2ae1f871930";

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];
const gateways: Gateway[] = [];
const sockets: SocketClient[] = [];
const scratchDirs: string[] = [];

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

interface Harness {
  port: number;
  pair(name: string, scopes: string[]): Promise<string>;
}

async function harness(): Promise<Harness> {
  const path = `/tmp/ompd-tui-steer-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: createFakeHost().factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    approvalTimeoutMs: 500,
    spawnHost: hosts.spawn,
    events,
  });
  sups.push(sup);

  // A real index, over empty session and presence roots. The rows are beside
  // the point here -- what matters is that the `sessions` ask succeeds, the
  // way it does on any daemon the CLI started, because that ask is what
  // subscribes a socket to activity.
  const sessionsRoot = mkdtempSync(join(tmpdir(), "ompd-tui-steer-sessions-"));
  const runRoot = mkdtempSync(join(tmpdir(), "ompd-tui-steer-run-"));
  scratchDirs.push(sessionsRoot, runRoot);
  const sessionIndex = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
  gateways.push(gw);
  const port = await gw.listen();

  return {
    port,
    pair: async (name, scopes) => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: `pk_${name}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
  };
}

async function openSocket(port: number, token: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
  const opened = Promise.withResolvers<boolean>();
  const frames: ServerFrame[] = [];
  let cursor = 0;
  let pending: { check: () => boolean; settle: () => void; timer: Timer } | null = null;

  const drain = (): void => {
    if (!pending?.check()) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.settle();
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
      let found: ServerFrame | null = null;
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = {
        // The cursor steps past frames that do not match, so a later `next`
        // cannot re-match a frame an earlier one already consumed.
        check: () => {
          while (cursor < frames.length) {
            const frame = frames[cursor];
            cursor += 1;
            if (frame && match(frame)) {
              found = frame;
              return true;
            }
          }
          return false;
        },
        settle: () => {
          if (found) settled.resolve(found);
        },
        timer,
      };
      drain();
      return settled.promise;
    },
    close: () => ws.close(),
  };
  sockets.push(client);
  return client;
}

/** A registered live TUI, exactly as the omp bridge extension registers one. */
async function registerTui(port: number, token: string, sessionId: string): Promise<SocketClient> {
  const tui = await openSocket(port, token);
  await tui.next(f => f.t === "hello", "hello on the TUI socket");
  tui.send({ t: "tui_register", sessionId, cwd: "/work/ompd", title: "steering", pid: process.pid });
  await barrier(tui, `registration of ${sessionId}`);
  return tui;
}

/**
 * Round-trip a ping. Frames on one socket are ordered, so a pong proves every
 * frame sent before it has been handled and anything the daemon meant to push
 * in that window has already been pushed.
 */
async function barrier(sock: SocketClient, label: string): Promise<void> {
  sock.send({ t: "ping" });
  await sock.next(f => f.t === "pong", `pong barrier: ${label}`);
}

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close();
  while (gateways.length) await gateways.pop()?.close();
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
  while (scratchDirs.length) rmSync(scratchDirs.pop() ?? "", { recursive: true, force: true });
});

describe("session_prompt", () => {
  test("reaches the socket that registered the session, as a tui_steer", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    app.send({ t: "session_prompt", sessionId: SESSION, text: "look at the failing test" });

    const steer = await tui.next(f => f.t === "tui_steer", "tui_steer on the registered socket");
    expect(steer).toEqual({
      t: "tui_steer",
      sessionId: SESSION,
      text: "look at the failing test",
      deliverAs: "steer",
    });
  });

  test("carries the delivery mode the client asked for", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    app.send({ t: "session_prompt", sessionId: SESSION, text: "after this turn", deliverAs: "followUp" });

    const steer = await tui.next(f => f.t === "tui_steer", "tui_steer with followUp delivery");
    expect(steer).toMatchObject({ deliverAs: "followUp" });
  });

  test("a session no TUI registered is refused with tui_unreachable, and nothing is sent", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    app.send({ t: "session_prompt", sessionId: OTHER_SESSION, text: "nobody owns this" });

    const error = await app.next(f => f.t === "error", "refusal for an unregistered session");
    expect(error).toMatchObject({ t: "error", code: "tui_unreachable" });
    expect(error).toMatchObject({ message: expect.stringContaining(OTHER_SESSION) });

    // And the registered TUI was not steered by a prompt addressed elsewhere.
    // The barrier is what makes this an assertion rather than a race.
    await barrier(tui, "nothing pushed to the wrong session's TUI");
    expect(tui.frames.filter(f => f.t === "tui_steer")).toEqual([]);
  });

  test("a client without prompt scope is refused, and the TUI is sent nothing", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const reader = await h.pair("read-only-phone", [SCOPE_READ]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, reader);
    app.send({ t: "session_prompt", sessionId: SESSION, text: "not allowed to say this" });

    const error = await app.next(f => f.t === "error", "refusal for a socket without prompt scope");
    expect(error).toMatchObject({ t: "error", code: "unauthorized" });

    await barrier(tui, "nothing pushed for an unauthorized prompt");
    expect(tui.frames.filter(f => f.t === "tui_steer")).toEqual([]);
  });

  test("an empty text is refused as a bad frame", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    app.send({ t: "session_prompt", sessionId: SESSION, text: "" });

    const error = await app.next(f => f.t === "error", "refusal for an empty prompt");
    expect(error).toMatchObject({ t: "error", code: "bad_frame" });
    await barrier(tui, "nothing pushed for an empty prompt");
    expect(tui.frames.filter(f => f.t === "tui_steer")).toEqual([]);
  });
});

describe("tui_activity", () => {
  test("reaches a client that asked for the session index", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    // The index ask is the subscription: a socket that listed sessions is
    // watching those rows, so the daemon pushes it a terminal turn as it
    // happens.
    app.send({ t: "sessions" });
    await app.next(f => f.t === "sessions", "the index answer that arms watching");

    tui.send({ t: "tui_activity", sessionId: SESSION, kind: "turn_start" });
    tui.send({ t: "tui_activity", sessionId: SESSION, kind: "assistant_text", text: "reading the test" });
    tui.send({ t: "tui_activity", sessionId: SESSION, kind: "turn_end" });

    const start = await app.next(f => f.t === "tui_activity", "turn_start forwarded");
    expect(start).toEqual({ t: "tui_activity", sessionId: SESSION, kind: "turn_start" });
    const text = await app.next(f => f.t === "tui_activity", "assistant_text forwarded");
    expect(text).toEqual({
      t: "tui_activity",
      sessionId: SESSION,
      kind: "assistant_text",
      text: "reading the test",
    });
    const end = await app.next(f => f.t === "tui_activity", "turn_end forwarded");
    expect(end).toEqual({ t: "tui_activity", sessionId: SESSION, kind: "turn_end" });
  });

  test("is not pushed to a client that never asked for the index", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    await app.next(f => f.t === "hello", "hello on the app socket");
    tui.send({ t: "tui_activity", sessionId: SESSION, kind: "turn_start" });

    await barrier(tui, "activity handled");
    await barrier(app, "nothing pushed to an unsubscribed socket");
    expect(app.frames.filter(f => f.t === "tui_activity")).toEqual([]);
  });

  test("a socket with no registration cannot report activity for a session", async () => {
    const h = await harness();
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);

    const app = await openSocket(h.port, phone);
    app.send({ t: "tui_activity", sessionId: SESSION, kind: "turn_start" });

    const error = await app.next(f => f.t === "error", "refusal for activity without a registration");
    expect(error).toMatchObject({ t: "error", code: "bad_frame" });
  });

  test("an unknown activity kind is refused rather than forwarded", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator, SESSION);

    const app = await openSocket(h.port, phone);
    app.send({ t: "sessions" });
    await app.next(f => f.t === "sessions", "the index answer that arms watching");

    // Not expressible through `ClientFrame`, which is the point: this is what
    // a hostile or merely outdated client puts on the wire.
    tui.send({ t: "tui_activity", sessionId: SESSION, kind: "keystrokes" } as unknown as ClientFrame);

    const error = await tui.next(f => f.t === "error", "refusal for an unknown activity kind");
    expect(error).toMatchObject({ t: "error", code: "bad_frame" });
    await barrier(app, "nothing forwarded for a refused activity kind");
    expect(app.frames.filter(f => f.t === "tui_activity")).toEqual([]);
  });
});
