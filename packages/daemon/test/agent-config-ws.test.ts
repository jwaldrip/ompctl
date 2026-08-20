/**
 * The `agent_config_read`/`agent_config_write` websocket frames from the wire:
 * the sealed-socket road an agent's mode takes to a hub-relayed phone, which
 * cannot reach `GET/POST /v1/agents/:id/config` at all. Everything the HTTP
 * route enforces must hold here too -- read to look, prompt to change, a
 * refusal for a mode the session never offered -- or the frame would be a
 * weaker door beside a strong one, and the phone is the client that can only
 * use the frame.
 *
 * Every mode assertion is paired with one on the far side of the wire, through
 * `fake.modeOf`. "The reply looked right" and "the agent actually moved" are
 * different claims, and a refusal that changed the mode anyway would satisfy
 * the first: only the pair distinguishes enforcement from breakage.
 *
 * The socket helper follows sync-settings-ws.test.ts: every wait is on an
 * arriving frame, never on a clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type Agent,
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
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const sockets: Array<{ close(): void }> = [];

/**
 * Deadline for waiting on a frame that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 *
 * A real timer rather than a controlled clock, because every wait in this file
 * is on a real websocket carried by a real server: fake timers would freeze
 * the I/O the assertions are made of, leaving nothing to advance toward.
 */
const SIGNAL_DEADLINE_MS = 3000;

interface Socket {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

async function daemon() {
  const path = `/tmp/ompd-agent-config-ws-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const events = new GatewayEvents();
  // The same wrapping the daemon does, for the same reason gateway.test.ts
  // gives: the supervisor spawns through the registry so the registry indexes
  // the session, and the gateway reads config from that index. Without it
  // these frames have nothing to answer from.
  const hosts = new HostRegistry({ spawn: fake.factory });
  const gateway = new Gateway({
    store,
    supervisor: new Supervisor({ store, policy: new DefaultPolicy(), spawnHost: hosts.spawn, events }),
    events,
    port: 0,
    sessions: hosts,
  });
  gateways.push(gateway);
  const port = await gateway.listen();
  const base = `http://127.0.0.1:${port}`;

  const pair = async (name: string, scopes: string[]) => {
    const paired = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, publicKey: name }),
    });
    // Narrowed rather than asserted: this is a response body, and a pairing
    // route that answered with something else must fail here by name instead
    // of handing `undefined` to `approvePairing` as if it were a code.
    const body: unknown = await paired.json();
    if (typeof body !== "object" || body === null || !("code" in body) || typeof body.code !== "string") {
      throw new Error("pair response carried no code");
    }
    return gateway.approvePairing(body.code, scopes);
  };

  /** Over HTTP, which is also how a client learns an agent id. */
  const createAgent = async (token: string, name: string): Promise<Agent> => {
    const created = await fetch(`${base}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name, cwd: "/work" }),
    });
    if (created.status !== 201) throw new Error(`agent creation failed with ${created.status}`);
    const body: unknown = await created.json();
    if (typeof body !== "object" || body === null || !("agent" in body)) {
      throw new Error("agent creation response carried no agent");
    }
    // The daemon's own route shape, checked as far as a test needs: the id and
    // session are read off it, and both are asserted against the wire below.
    return body.agent as Agent;
  };

  const connect = async (token: string): Promise<Socket> => {
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

    const client: Socket = {
      frames,
      send: (frame: ClientFrame) => ws.send(JSON.stringify(frame)),
      next: (match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame> => {
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
    sockets.push(client);
    return client;
  };

  return { fake, pair, createAgent, connect };
}

function isAgentConfig(frame: ServerFrame): boolean {
  return frame.t === "agent_config";
}

function isRefusal(frame: ServerFrame, code: string): boolean {
  return frame.t === "error" && frame.code === code;
}

/**
 * Round-trip a ping so a "nothing arrived" assertion is made after the daemon
 * has demonstrably finished with everything sent before it. Without this the
 * absence proves only that the test ran faster than the socket.
 */
async function barrier(socket: Socket, label: string): Promise<void> {
  socket.send({ t: "ping" });
  await socket.next(frame => frame.t === "pong", `pong barrier: ${label}`);
}

/** The mode selector out of a config frame, by the id the daemon keys it on. */
function modeIn(frame: ServerFrame): string | undefined {
  if (frame.t !== "agent_config") throw new Error(`expected an agent_config frame, got ${frame.t}`);
  return frame.configOptions.find(option => option.id === "mode")?.currentValue;
}

describe("the agent config websocket frames", () => {
  test("a read-scoped phone is answered with the agent's whole config block", async () => {
    const target = await daemon();
    const agent = await target.createAgent(await target.pair("laptop", [SCOPE_MANAGE]), "worker");
    const reader = await target.connect(await target.pair("phone", [SCOPE_READ]));

    reader.send({ t: "agent_config_read", agentId: agent.id });
    const answer = await reader.next(isAgentConfig, "agent_config frame");
    if (answer.t !== "agent_config") throw new Error("expected an agent_config frame");

    expect(answer.agentId).toBe(agent.id);
    expect(modeIn(answer)).toBe("default");
    // The whole block the HTTP route returns, not just the mode: a client
    // rendering the model selector needs the option the daemon holds for it,
    // and a frame that carried only the mode would quietly be a lesser
    // surface than the route it exists to replace.
    expect(answer.configOptions.map(option => option.id)).toEqual(["mode", "model"]);
  });

  test("a prompt-scoped phone changes the mode and is answered with the read-back", async () => {
    const target = await daemon();
    const agent = await target.createAgent(await target.pair("laptop", [SCOPE_MANAGE]), "worker");
    const watcher = await target.connect(await target.pair("watcher", [SCOPE_READ]));
    const prompter = await target.connect(await target.pair("prompter", [SCOPE_PROMPT]));

    prompter.send({ t: "agent_config_write", agentId: agent.id, modeId: "plan" });
    const answer = await prompter.next(isAgentConfig, "agent_config frame after the write");
    expect(modeIn(answer)).toBe("plan");

    // The assertion on the far side of the wire: the reply is worth nothing
    // unless the agent actually moved.
    expect(target.fake.modeOf(agent.acpSessionId ?? "")).toBe("plan");

    // Sent to the asking socket only. A config is the answer to a request,
    // and a device that asked for nothing must not be told what another
    // device just did.
    await barrier(watcher, "watcher drain after another socket's write");
    expect(watcher.frames.filter(isAgentConfig)).toHaveLength(0);

    // The read-back on a second socket, not the echo on the first: what the
    // session holds is what every other client will be told.
    watcher.send({ t: "agent_config_read", agentId: agent.id });
    const confirmed = await watcher.next(isAgentConfig, "agent_config frame on the watching socket");
    expect(modeIn(confirmed)).toBe("plan");
  });

  test("refusals are named: read to ask, prompt to change", async () => {
    const target = await daemon();
    const agent = await target.createAgent(await target.pair("laptop", [SCOPE_MANAGE]), "worker");
    const reader = await target.connect(await target.pair("phone", [SCOPE_READ]));
    const prompter = await target.connect(await target.pair("prompt-only", [SCOPE_PROMPT]));

    // `plan` is the read-only mode, so moving off it widens what the agent may
    // do, and a device that can only watch must not be able to authorise that.
    reader.send({ t: "agent_config_write", agentId: agent.id, modeId: "plan" });
    const writeRefusal = await reader.next(frame => isRefusal(frame, "unauthorized"), "unauthorized on the write");
    expect(writeRefusal.t).toBe("error");
    expect(target.fake.modeOf(agent.acpSessionId ?? "")).toBe("default");

    // The mirror image, because an unchanged mode is also what a broken write
    // path looks like: the same socket's read still works, so the refusal was
    // the scope gate and not the frame going nowhere.
    reader.send({ t: "agent_config_read", agentId: agent.id });
    expect(modeIn(await reader.next(isAgentConfig, "agent_config after the refused write"))).toBe("default");

    // Prompt does not imply read: the ask itself is watching, and the door
    // says so rather than answering with a config this device may not see.
    prompter.send({ t: "agent_config_read", agentId: agent.id });
    const readRefusal = await prompter.next(frame => isRefusal(frame, "unauthorized"), "unauthorized on the read");
    expect(readRefusal.t).toBe("error");
  });

  test("an unknown agent is named, on either frame, and the socket survives it", async () => {
    const target = await daemon();
    const phone = await target.connect(await target.pair("phone", [SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "agent_config_read", agentId: "agt_0000000000000000" });
    const readRefusal = await phone.next(frame => isRefusal(frame, "unknown_agent"), "unknown_agent on the read");
    expect(readRefusal.t).toBe("error");

    phone.send({ t: "agent_config_write", agentId: "agt_0000000000000000", modeId: "plan" });
    const writeRefusal = await phone.next(frame => isRefusal(frame, "unknown_agent"), "unknown_agent on the write");
    expect(writeRefusal.t).toBe("error");

    // A stale row on a phone is the ordinary way this happens, so the answer
    // has to be an answer: named, and on a socket still able to ask again.
    await barrier(phone, "after the unknown-agent refusals");
  });

  test("a mode the session never offered is refused before it reaches the agent", async () => {
    const target = await daemon();
    const agent = await target.createAgent(await target.pair("laptop", [SCOPE_MANAGE]), "worker");
    const prompter = await target.connect(await target.pair("prompter", [SCOPE_PROMPT]));

    prompter.send({ t: "agent_config_write", agentId: agent.id, modeId: "yolo" });
    const refusal = await prompter.next(frame => isRefusal(frame, "unknown_mode"), "unknown_mode error");
    expect(refusal.t).toBe("error");
    expect(target.fake.modeOf(agent.acpSessionId ?? "")).toBe("default");

    // The wire is not a place to assume the contract held either: an empty
    // modeId is a bad_frame, not a guess at what was meant.
    prompter.send({ t: "agent_config_write", agentId: agent.id, modeId: "" });
    const shapeRefusal = await prompter.next(frame => isRefusal(frame, "bad_frame"), "bad_frame error");
    expect(shapeRefusal.t).toBe("error");
    expect(target.fake.modeOf(agent.acpSessionId ?? "")).toBe("default");
  });

  test("the write is one-shot: a reconnect neither replays it nor applies it twice", async () => {
    const target = await daemon();
    const agent = await target.createAgent(await target.pair("laptop", [SCOPE_MANAGE]), "worker");
    const token = await target.pair("phone", [SCOPE_READ, SCOPE_PROMPT]);
    const first = await target.connect(token);

    first.send({ t: "agent_config_write", agentId: agent.id, modeId: "plan" });
    expect(modeIn(await first.next(isAgentConfig, "agent_config frame after the write"))).toBe("plan");
    first.close();

    // The same device comes back, which is the moment a replayed instruction
    // would land. The daemon keeps no record of the write to replay: the fresh
    // socket is told hello and nothing else, and the mode is what that single
    // write left. The client half of one-shot, not re-sending the frame after
    // a drop, lives in OmpdClient rather than here.
    const second = await target.connect(token);
    await second.next(frame => frame.t === "hello", "hello on the reconnected socket");
    await barrier(second, "reconnect drain");
    expect(second.frames.filter(isAgentConfig)).toHaveLength(0);
    expect(target.fake.modeOf(agent.acpSessionId ?? "")).toBe("plan");

    // And the mode is still readable over the new socket, so "nothing was
    // replayed" is not "the surface stopped working".
    second.send({ t: "agent_config_read", agentId: agent.id });
    expect(modeIn(await second.next(isAgentConfig, "agent_config on the reconnected socket"))).toBe("plan");
  });
});

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close();
  while (gateways.length) await gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});
