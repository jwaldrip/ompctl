/**
 * Image budgets on the wire, from the side of a phone that ignores them.
 *
 * The app measures a picked image before it builds a frame, but a phone is a
 * peer on this socket rather than a trusted client, so the daemon has to
 * enforce the same budgets against a frame nobody in this repo composed. The
 * two roads a prompt takes are covered here because they refuse in different
 * code: `prompt` runs a turn on an agent this daemon owns, `session_prompt`
 * forwards a steer to whichever terminal registered the session.
 *
 * Every refusal is asserted twice over: the named error frame, and the fact
 * that nothing reached the far side. Only the second half distinguishes
 * enforcement from breakage, because an error frame is also what a crashed
 * host, a dropped frame, or a refusal issued after the agent already acted
 * would look like. For `prompt` the far side is the ACP peer, so the
 * assertion is on the prompts the fake host received; for `session_prompt` it
 * is the registered terminal, so the assertion is on its frames after a
 * barrier that proves the daemon had already handled the frame.
 *
 * The accepted case is here for the same reason: budgets that refuse
 * everything would pass every refusal test in this file.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Agent,
  type ClientFrame,
  DefaultPolicy,
  MAX_PROMPT_IMAGE_BASE64_CHARS,
  PROMPT_IMAGE_REFUSAL_REASONS,
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
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

/**
 * Deadline for waiting on a signal that should already be on its way. Not a
 * sleep and not a guess at a race: nothing here waits for it to elapse, and
 * on a passing run it never does. It exists so a frame that never arrives
 * fails with the name of what was expected instead of hanging the suite.
 */
const SIGNAL_DEADLINE_MS = 3000;

const SESSION = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";

/** A one-pixel PNG, so the accepted case carries something a decoder would take. */
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** One character past the per-image ceiling, which is the whole point of it. */
const OVERSIZED = "A".repeat(MAX_PROMPT_IMAGE_BASE64_CHARS + 1);

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
  store: Store;
  fake: FakeHostController;
  pair(name: string, scopes: string[]): Promise<string>;
  agent(token: string, name: string): Promise<Agent>;
}

async function harness(): Promise<Harness> {
  const path = `/tmp/ompd-prompt-attachments-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    approvalTimeoutMs: 500,
    spawnHost: hosts.spawn,
    events,
  });
  sups.push(sup);

  // A real index over empty roots, for the same reason `tui-steer.test.ts`
  // builds one: the rows are beside the point, but a socket that cannot ask
  // for sessions is not the socket a terminal registers on.
  const sessionsRoot = mkdtempSync(join(tmpdir(), "ompd-prompt-attachments-sessions-"));
  const runRoot = mkdtempSync(join(tmpdir(), "ompd-prompt-attachments-run-"));
  scratchDirs.push(sessionsRoot, runRoot);
  const sessionIndex = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  return {
    port,
    store,
    fake,
    pair: async (name, scopes) => {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: `pk_${name}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    agent: async (token, name) => {
      const res = await fetch(`${base}/v1/agents`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name, cwd: "/work" }),
      });
      if (res.status !== 201) throw new Error(`agent creation failed with ${res.status}`);
      const body = (await res.json()) as { agent: Agent };
      return body.agent;
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
        // The cursor steps past frames that did not match, so a later `next`
        // cannot re-match one an earlier call already consumed.
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

/**
 * Round-trip a ping. Frames on one socket are ordered, so a pong proves the
 * daemon has already handled everything sent before it, which is what turns
 * "nothing arrived" from a race into an assertion.
 */
async function barrier(sock: SocketClient, label: string): Promise<void> {
  sock.send({ t: "ping" });
  await sock.next(f => f.t === "pong", `pong barrier: ${label}`);
}

/** A registered live TUI, exactly as the omp bridge extension registers one. */
async function registerTui(port: number, token: string): Promise<SocketClient> {
  const tui = await openSocket(port, token);
  await tui.next(f => f.t === "hello", "hello on the TUI socket");
  tui.send({ t: "tui_register", sessionId: SESSION, cwd: "/work/ompd", title: "attachments", pid: process.pid });
  await barrier(tui, `registration of ${SESSION}`);
  return tui;
}

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close();
  while (gateways.length) await gateways.pop()?.close();
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
  while (scratchDirs.length) rmSync(scratchDirs.pop() ?? "", { recursive: true, force: true });
});

describe("prompt images on the agent socket", () => {
  test("an image over the ceiling is refused by name and never reaches the host", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await h.agent(operator, "worker");
    const sock = await openSocket(h.port, operator);
    await sock.next(f => f.t === "hello", "hello");

    sock.send({
      t: "prompt",
      agentId: agent.id,
      text: "look at this",
      images: [{ data: OVERSIZED, mimeType: "image/png" }],
    });

    const error = await sock.next(f => f.t === "error", "the size refusal");
    expect(error).toMatchObject({
      t: "error",
      agentId: agent.id,
      code: "attachment_too_large",
      message: PROMPT_IMAGE_REFUSAL_REASONS.too_large,
    });
    // The half that matters: the turn never started. An error frame alone is
    // also what a refusal issued after the agent already read the image would
    // look like.
    await barrier(sock, "nothing sent to the host");
    expect(h.fake.prompts).toEqual([]);
  });

  test("more images than a prompt allows is refused by name and never reaches the host", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await h.agent(operator, "worker");
    const sock = await openSocket(h.port, operator);
    await sock.next(f => f.t === "hello", "hello");

    sock.send({
      t: "prompt",
      agentId: agent.id,
      text: "five is too many",
      images: Array.from({ length: 5 }, () => ({ data: TINY_PNG, mimeType: "image/png" })),
    });

    const error = await sock.next(f => f.t === "error", "the count refusal");
    expect(error).toMatchObject({
      t: "error",
      agentId: agent.id,
      code: "attachment_too_many",
      message: PROMPT_IMAGE_REFUSAL_REASONS.too_many,
    });
    await barrier(sock, "nothing sent to the host");
    expect(h.fake.prompts).toEqual([]);
  });

  test("a format the agent cannot read is refused by name and never reaches the host", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await h.agent(operator, "worker");
    const sock = await openSocket(h.port, operator);
    await sock.next(f => f.t === "hello", "hello");

    sock.send({
      t: "prompt",
      agentId: agent.id,
      text: "a bitmap",
      images: [{ data: TINY_PNG, mimeType: "image/bmp" }],
    });

    const error = await sock.next(f => f.t === "error", "the format refusal");
    expect(error).toMatchObject({
      t: "error",
      agentId: agent.id,
      code: "attachment_bad_mime",
      message: PROMPT_IMAGE_REFUSAL_REASONS.bad_mime,
    });
    await barrier(sock, "nothing sent to the host");
    expect(h.fake.prompts).toEqual([]);
  });

  test("an image inside the budget does reach the host, as an image block", async () => {
    const h = await harness();
    const operator = await h.pair("laptop", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const agent = await h.agent(operator, "worker");
    const sock = await openSocket(h.port, operator);
    await sock.next(f => f.t === "hello", "hello");

    // The socket does not await the turn, so the arrival is the signal.
    const arrived = Promise.withResolvers<void>();
    h.fake.onPrompt(() => {
      arrived.resolve();
      return { stopReason: "end_turn" };
    });

    sock.send({
      t: "prompt",
      agentId: agent.id,
      text: "what is in this",
      images: [{ data: TINY_PNG, mimeType: "image/png" }],
    });
    await arrived.promise;

    expect(h.fake.prompts).toHaveLength(1);
    expect(h.fake.prompts[0]?.blocks).toEqual([
      { type: "text", text: "what is in this" },
      { type: "image", data: TINY_PNG, mimeType: "image/png" },
    ]);
  });
});

describe("prompt images on the terminal socket", () => {
  test("an image over the ceiling is refused by name and the terminal is steered with nothing", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator);

    const app = await openSocket(h.port, phone);
    app.send({
      t: "session_prompt",
      sessionId: SESSION,
      text: "look at this",
      images: [{ data: OVERSIZED, mimeType: "image/png" }],
    });

    const error = await app.next(f => f.t === "error", "the size refusal");
    expect(error).toMatchObject({
      t: "error",
      code: "attachment_too_large",
      message: PROMPT_IMAGE_REFUSAL_REASONS.too_large,
    });
    await barrier(tui, "nothing steered for an oversized image");
    expect(tui.frames.filter(f => f.t === "tui_steer")).toEqual([]);

    // Recorded, so the attempts worth reading about are not the unlogged ones.
    const records = h.store.listAudit(20).filter(entry => entry.action === "session.prompt");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "denied", detail: { reason: "attachment_too_large" } });
  });

  test("more images than a prompt allows is refused by name and the terminal is steered with nothing", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator);

    const app = await openSocket(h.port, phone);
    app.send({
      t: "session_prompt",
      sessionId: SESSION,
      text: "five is too many",
      images: Array.from({ length: 5 }, () => ({ data: TINY_PNG, mimeType: "image/png" })),
    });

    const error = await app.next(f => f.t === "error", "the count refusal");
    expect(error).toMatchObject({ t: "error", code: "attachment_too_many" });
    await barrier(tui, "nothing steered for too many images");
    expect(tui.frames.filter(f => f.t === "tui_steer")).toEqual([]);
  });

  test("a format the agent cannot read is refused by name and the terminal is steered with nothing", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator);

    const app = await openSocket(h.port, phone);
    app.send({
      t: "session_prompt",
      sessionId: SESSION,
      text: "a bitmap",
      images: [{ data: TINY_PNG, mimeType: "image/bmp" }],
    });

    const error = await app.next(f => f.t === "error", "the format refusal");
    expect(error).toMatchObject({ t: "error", code: "attachment_bad_mime" });
    await barrier(tui, "nothing steered for an unreadable format");
    expect(tui.frames.filter(f => f.t === "tui_steer")).toEqual([]);
  });

  test("an image inside the budget is steered to the terminal that owns the session", async () => {
    const h = await harness();
    const operator = await h.pair("terminal", [SCOPE_READ, SCOPE_MANAGE, SCOPE_PROMPT]);
    const phone = await h.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const tui = await registerTui(h.port, operator);

    const app = await openSocket(h.port, phone);
    app.send({
      t: "session_prompt",
      sessionId: SESSION,
      text: "what is in this",
      images: [{ data: TINY_PNG, mimeType: "image/png" }],
    });

    const steer = await tui.next(f => f.t === "tui_steer", "the steer carrying the image");
    expect(steer).toMatchObject({
      t: "tui_steer",
      sessionId: SESSION,
      text: "what is in this",
      images: [{ data: TINY_PNG, mimeType: "image/png" }],
    });
  });
});
