import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Actor,
  type ClientFrame,
  DefaultPolicy,
  SCOPE_APPROVE,
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

const SIGNAL_DEADLINE_MS = 5000;

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

async function connect(port: number, token: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
  const opened = Promise.withResolvers<boolean>();
  const frames: ServerFrame[] = [];
  let cursor = 0;
  let pending: { check: () => boolean; settle: (frame: ServerFrame) => void; timer: Timer } | null = null;

  const drain = (): void => {
    if (!pending) return;
    if (!pending.check()) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
  };

  ws.addEventListener("open", () => opened.resolve(true));
  ws.addEventListener("error", () => opened.resolve(false));
  ws.addEventListener("close", () => opened.resolve(false));
  ws.addEventListener("message", event => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
    drain();
  });

  if (!(await opened.promise)) throw new Error("expected websocket to open");

  return {
    frames,
    send: frame => ws.send(JSON.stringify(frame)),
    next: (match, label) => {
      const settled = Promise.withResolvers<ServerFrame>();
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = {
        check: () => {
          while (cursor < frames.length) {
            const frame = frames[cursor];
            cursor += 1;
            if (frame && match(frame)) {
              settled.resolve(frame);
              return true;
            }
          }
          return false;
        },
        settle: (frame: ServerFrame) => settled.resolve(frame),
        timer,
      };
      drain();
      return settled.promise;
    },
    close: () => ws.close(),
  };
}

const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

afterEach(async () => {
  for (const gw of gateways) await gw.close();
  gateways.length = 0;
  for (const s of stores) s.close();
  stores.length = 0;
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
});

test("prompt while busy: second prompt is refused with agent_busy, updates still arrive, state goes idle once, third succeeds", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-busy-db-"));
  scratchDirs.push(dbDir);
  const store = new Store(join(dbDir, "ompd.db"));
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

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts });
  gateways.push(gw);
  const port = await gw.listen();

  const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "operator-dev", publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const pairJson: unknown = await pairRes.json();
  if (!pairJson || typeof pairJson !== "object" || !("code" in pairJson) || typeof pairJson.code !== "string") {
    throw new Error("pair response carried no code");
  }
  const token = gw.approvePairing(pairJson.code, [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);

  const actor: Actor = {
    deviceId: "dev_test",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device",
    publicKey: "pk_test",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });
  const agentDir = mkdtempSync(join(tmpdir(), "agent-cwd-"));
  scratchDirs.push(agentDir);
  const agent = await sup.createAgent({ name: "busy-agent", cwd: agentDir }, actor);

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  client.send({ t: "attach", agentId: agent.id });

  // Control prompt 1 resolution
  const firstTurnSettled = Promise.withResolvers<{ stopReason: string }>();
  let promptCalls = 0;
  fake.onPrompt(() => {
    promptCalls += 1;
    if (promptCalls === 1) return firstTurnSettled.promise;
    return { stopReason: "end_turn" };
  });

  // Track state transitions through onAgentsChanged
  const idleStatesObserved: number[] = [];
  events.onAgentsChanged = agents => {
    const matched = agents.find(a => a.id === agent.id);
    if (matched?.state === "idle") {
      idleStatesObserved.push(Date.now());
    }
  };

  // 1. Send first prompt
  client.send({ t: "prompt", agentId: agent.id, text: "turn 1" });

  // Wait until fake host receives prompt 1
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (fake.prompts.length >= 1) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  expect(store.getAgent(agent.id)?.state).toBe("busy");

  // 2. Send second prompt while first is still in flight
  client.send({ t: "prompt", agentId: agent.id, text: "turn 2" });

  // The second prompt must be refused with code: "agent_busy"
  const busyFrame = await client.next(f => f.t === "error" && f.code === "agent_busy", "agent_busy error");
  expect(busyFrame).toMatchObject({
    t: "error",
    code: "agent_busy",
    agentId: agent.id,
  });

  // First turn should still be in flight; emit update
  fake.emitUpdate(fake.sessions[0]!, { text: "chunk 1" });
  const updateFrame = await client.next(
    f => f.t === "update" && (f.update as { text?: string })?.text === "chunk 1",
    "turn 1 update",
  );
  expect(updateFrame).toBeDefined();

  // Agent must still be busy; no idle states should have been emitted yet
  expect(store.getAgent(agent.id)?.state).toBe("busy");
  expect(idleStatesObserved).toHaveLength(0);

  // 3. Complete turn 1
  firstTurnSettled.resolve({ stopReason: "end_turn" });

  // State should now become idle
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (store.getAgent(agent.id)?.state === "idle") {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  expect(store.getAgent(agent.id)?.state).toBe("idle");
  expect(idleStatesObserved.length).toBeGreaterThanOrEqual(1);

  // 4. Send third prompt now that turn 1 is settled; it should succeed
  client.send({ t: "prompt", agentId: agent.id, text: "turn 3" });

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (promptCalls >= 2) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  expect(promptCalls).toBe(2);

  client.close();
});

test("cancel works mid-turn on busy agent and returns to idle", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-busy-cancel-db-"));
  scratchDirs.push(dbDir);
  const store = new Store(join(dbDir, "ompd.db"));
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

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts });
  gateways.push(gw);
  const port = await gw.listen();

  const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "operator-dev", publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const pairJson: unknown = await pairRes.json();
  if (!pairJson || typeof pairJson !== "object" || !("code" in pairJson) || typeof pairJson.code !== "string") {
    throw new Error("pair response carried no code");
  }
  const token = gw.approvePairing(pairJson.code, [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);

  const actor: Actor = {
    deviceId: "dev_test_cancel",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device-cancel",
    publicKey: "pk_test_cancel",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });
  const agentDir = mkdtempSync(join(tmpdir(), "agent-cancel-cwd-"));
  scratchDirs.push(agentDir);
  const agent = await sup.createAgent({ name: "busy-cancel-agent", cwd: agentDir }, actor);

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  let promptCalls = 0;
  fake.onPrompt(() => {
    promptCalls += 1;
    // Return pending promise so it stays in flight until cancelled
    return new Promise(() => {});
  });

  client.send({ t: "prompt", agentId: agent.id, text: "long turn" });

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (fake.prompts.length >= 1) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  expect(store.getAgent(agent.id)?.state).toBe("busy");

  // Send cancel mid-turn
  client.send({ t: "cancel", agentId: agent.id });

  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (fake.cancels.length >= 1) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });

  // Fake host settles in-flight on cancel
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (store.getAgent(agent.id)?.state === "idle") {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  expect(store.getAgent(agent.id)?.state).toBe("idle");

  // Now a subsequent prompt succeeds
  fake.onPrompt(() => {
    promptCalls += 1;
    return { stopReason: "end_turn" };
  });

  client.send({ t: "prompt", agentId: agent.id, text: "after cancel" });
  await new Promise<void>(resolve => {
    const check = setInterval(() => {
      if (promptCalls >= 2) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });
  expect(promptCalls).toBe(2);

  client.close();
});

test("D4: if onAgentsChanged or audit throws when entering busy, in-flight turn is cleared so subsequent prompt is not blocked", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-busy-d4-db-"));
  scratchDirs.push(dbDir);
  const store = new Store(join(dbDir, "ompd.db"));
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

  const actor: Actor = {
    deviceId: "dev_test_d4",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device-d4",
    publicKey: "pk_test_d4",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });
  const agentDir = mkdtempSync(join(tmpdir(), "agent-d4-cwd-"));
  scratchDirs.push(agentDir);
  const agent = await sup.createAgent({ name: "busy-d4-agent", cwd: agentDir }, actor);

  // Configure onAgentsChanged to throw once on next state change
  let shouldThrow = true;
  events.onAgentsChanged = () => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error("listener exploded");
    }
  };

  // First prompt throws during #setState
  await expect(sup.prompt(agent.id, "turn 1", actor)).rejects.toThrow("listener exploded");

  // Subsequent prompt must NOT be refused as agent_busy!
  await expect(sup.prompt(agent.id, "turn 2", actor)).resolves.toBeDefined();
});
