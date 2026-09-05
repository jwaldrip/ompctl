import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
import { SessionIndex } from "../src/sessions/index.ts";
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

test("subject-bearing error: resuming unknown session id carries sessionId in error frame", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-subj-db-"));
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

  const sessionsRoot = mkdtempSync(join(tmpdir(), "gw-subj-sessions-"));
  scratchDirs.push(sessionsRoot);
  const sessionIndex = new SessionIndex({ store, sessionsRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
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

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  const unknownSessionId = "019feebf-unknown-session-12345";
  client.send({
    t: "session_resume",
    sessionId: unknownSessionId,
    cwd: "/tmp/fake-cwd",
  });

  const errorFrame = await client.next(f => f.t === "error", "error frame");
  if (errorFrame.t !== "error") throw new Error("expected error frame");
  expect(errorFrame.code).toBe("unknown_session");
  // Pre-fix: sessionId was omitted (undefined)!
  expect(errorFrame.sessionId).toBe(unknownSessionId);

  client.close();
});

test("subject-bearing error: session_prompt to unknown session carries sessionId in error frame", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-subj-db2-"));
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

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  const unknownSessionId = "019feebf-unknown-prompt-session";
  client.send({
    t: "session_prompt",
    sessionId: unknownSessionId,
    text: "hello",
  });

  const errorFrame = await client.next(f => f.t === "error", "error frame");
  if (errorFrame.t !== "error") throw new Error("expected error frame");
  expect(errorFrame.code).toBe("tui_unreachable");
  expect(errorFrame.sessionId).toBe(unknownSessionId);

  client.close();
});

test("subject-bearing error: session_tail to unknown session carries sessionId in error frame", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-subj-db3-"));
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

  const sessionsRoot = mkdtempSync(join(tmpdir(), "gw-subj-sessions3-"));
  scratchDirs.push(sessionsRoot);
  const sessionIndex = new SessionIndex({ store, sessionsRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
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

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  const unknownSessionId = "019feebf-unknown-tail-session";
  client.send({
    t: "session_tail",
    sessionId: unknownSessionId,
  });

  const errorFrame = await client.next(f => f.t === "error", "error frame");
  if (errorFrame.t !== "error") throw new Error("expected error frame");
  expect(errorFrame.code).toBe("unknown_session");
  expect(errorFrame.sessionId).toBe(unknownSessionId);

  client.close();
});
