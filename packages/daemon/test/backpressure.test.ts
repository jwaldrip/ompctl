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
  closed: Promise<{ code: number; reason: string }>;
  close(): void;
}

async function connect(port: number, token: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
  const opened = Promise.withResolvers<boolean>();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
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
  ws.addEventListener("close", event => closed.resolve({ code: event.code, reason: event.reason }));
  ws.addEventListener("message", event => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
    drain();
  });

  if (!(await opened.promise)) throw new Error("expected websocket to open");

  return {
    frames,
    send: frame => ws.send(JSON.stringify(frame)),
    closed: closed.promise,
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

test("backpressure: when socket buffer exceeds cap, socket is closed with 1013 backpressure and audited", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-bp-db-"));
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

  // Low buffer cap for test: 64 KiB
  const TEST_CAP = 64 * 1024;
  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    maxSocketBufferBytes: TEST_CAP,
  });
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
    deviceId: "dev_test_bp",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device-bp",
    publicKey: "pk_test_bp",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });
  const agentDir = mkdtempSync(join(tmpdir(), "agent-bp-cwd-"));
  scratchDirs.push(agentDir);
  const agent = await sup.createAgent({ name: "bp-agent", cwd: agentDir }, actor);

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  // Attach to agent and flush queue via ping/pong
  client.send({ t: "attach", agentId: agent.id });
  client.send({ t: "ping" });
  await client.next(f => f.t === "pong", "pong after attach");

  // Stream far more than any kernel can absorb. The client lives on this same
  // event loop, so nothing drains while this loop runs; the socket's own
  // buffer only grows once the kernel's send buffer is full, and a Linux
  // loopback autotunes that buffer to several megabytes where macOS stops
  // well under one. 640 KiB crossed the cap on a Mac and never on the CI
  // runner; 32 MiB crosses it everywhere.
  const chunk = "A".repeat(256 * 1024);
  for (let i = 0; i < 128; i++) {
    fake.emitUpdate(agent.acpSessionId!, { chunk, i });
  }

  // Await the close event from the server
  const closeEvent = await client.closed;
  expect(closeEvent.code).toBe(1013);
  expect(closeEvent.reason).toBe("backpressure");

  // Verify audit log
  const audit = store.listAudit(10);
  const bpAudit = audit.find(entry => entry.action === "socket.backpressure");
  expect(bpAudit).toBeDefined();
  expect(bpAudit?.outcome).toBe("error");
  expect(bpAudit?.detail).toMatchObject({
    code: 1013,
    reason: "backpressure",
    limit: TEST_CAP,
  });
});

test("D1: backpressure on tunnel-backed socket closes virtual session with 1013 and invokes onClose", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-bp-tunnel-db-"));
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

  const TEST_CAP = 1024; // 1 KiB
  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    maxSocketBufferBytes: TEST_CAP,
  });
  gateways.push(gw);
  const port = await gw.listen();

  // Create pairing token
  const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "tunnel-dev", publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const pairJson: unknown = await pairRes.json();
  if (!pairJson || typeof pairJson !== "object" || !("code" in pairJson) || typeof pairJson.code !== "string") {
    throw new Error("pair response carried no code");
  }
  const token = gw.approvePairing(pairJson.code, [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);

  const actor: Actor = {
    deviceId: "dev_tunnel_bp",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device-tunnel-bp",
    publicKey: "pk_tunnel_bp",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });
  const agentDir = mkdtempSync(join(tmpdir(), "agent-tunnel-bp-cwd-"));
  scratchDirs.push(agentDir);
  const agent = await sup.createAgent({ name: "tunnel-bp-agent", cwd: agentDir }, actor);

  // Accept a tunnel session where getBufferedAmount reports exceeding the cap
  const tunnelState: { closedWith: { code: number; reason: string } | null } = { closedWith: null };
  const tunnelDelivered: string[] = [];
  const bufferedReported = 2048; // Exceeds TEST_CAP (1024)

  const session = gw.acceptTunnelSession(
    token,
    raw => tunnelDelivered.push(raw),
    () => bufferedReported,
    (code, reason) => {
      tunnelState.closedWith = { code: code ?? 0, reason: reason ?? "" };
    },
  );

  if (!session.ok) throw new Error("tunnel session was refused");

  // Deliver attach frame from client
  session.deliver(JSON.stringify({ t: "attach", agentId: agent.id } satisfies ClientFrame));

  // Deliver an update: gateway will check getBufferedAmount (2048 > 1024), close with 1013, and audit
  fake.emitUpdate(agent.acpSessionId!, { text: "update" });

  expect(tunnelState.closedWith?.code).toBe(1013);
  expect(tunnelState.closedWith?.reason).toBe("backpressure");

  const audit = store.listAudit(5);
  const bpAudit = audit.find(e => e.action === "socket.backpressure");
  expect(bpAudit).toBeDefined();
  expect(bpAudit?.outcome).toBe("error");
  expect(bpAudit?.detail).toMatchObject({
    code: 1013,
    reason: "backpressure",
    limit: TEST_CAP,
  });
});
