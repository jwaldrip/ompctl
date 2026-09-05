import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("D7/D8: resumed session answers history with old turns, and replay from seq 0 contains exactly one user chunk plus new assistant chunks", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-hist-db-"));
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

  const sessionsRoot = mkdtempSync(join(tmpdir(), "gw-hist-sess-"));
  scratchDirs.push(sessionsRoot);
  const sessionIndex = new SessionIndex({ store, sessionsRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
  gateways.push(gw);
  const port = await gw.listen();

  // Create pairing token
  const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "hist-dev", publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const pairJson: unknown = await pairRes.json();
  if (!pairJson || typeof pairJson !== "object" || !("code" in pairJson) || typeof pairJson.code !== "string") {
    throw new Error("pair response carried no code");
  }
  const token = gw.approvePairing(pairJson.code, [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);

  const actor: Actor = {
    deviceId: "dev_test_hist",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device-hist",
    publicKey: "pk_test_hist",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });

  // Write session file with two older turns
  const sessionId = "019feebf-7000-7000-8000-0000000000d7";
  const groupDir = join(sessionsRoot, "-base");
  mkdirSync(groupDir, { recursive: true });
  const sessionFile = join(groupDir, `2026-08-10T00-00-00-000Z_${sessionId}.jsonl`);

  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "d7 session", updatedAt: "2026-08-10T10:00:00.000Z" }),
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-08-10T10:00:00.000Z", cwd: "/work" }),
    // Turn 1 (old)
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-10T10:01:00.000Z",
      message: { id: "msg_old_1", role: "user", content: "old turn 1" },
    }),
    // Turn 2 (old)
    JSON.stringify({
      type: "message",
      timestamp: "2026-08-10T10:02:00.000Z",
      message: { id: "msg_old_2", role: "user", content: "old turn 2" },
    }),
  ];
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);

  // Configure fake-host to replay transcript chunks during session/load (simulating real omp acp load replay)
  fake.replayOnLoad([
    { sessionUpdate: "session_info_update", title: "d7 session" },
    { sessionUpdate: "agent_thought_chunk", messageId: "m_old", content: { type: "text", text: "old thought" } },
    { sessionUpdate: "agent_message_chunk", messageId: "m_old", content: { type: "text", text: "old reply" } },
  ]);

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  // Resume the session (creates agent with createdAt = now)
  client.send({ t: "session_resume", sessionId, cwd: "/work" });
  const opened = await client.next(f => f.t === "session_opened", "session_opened");
  if (opened.t !== "session_opened") throw new Error("expected session_opened");
  const agentId = opened.agentId;

  // Attach to agent
  client.send({ t: "attach", agentId });
  client.send({ t: "ping" });
  await client.next(f => f.t === "pong", "pong after attach");

  // Send a new prompt post-resume
  fake.onPrompt(() => {
    fake.emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "new assistant reply" },
      messageId: "asst_new_1",
    });
    return { stopReason: "end_turn" };
  });

  client.send({ t: "prompt", agentId, text: "post resume turn 3" });
  await client.next(
    f => f.t === "update" && (f.update as { sessionUpdate?: string })?.sessionUpdate === "user_message_chunk",
    "user_message_chunk",
  );
  await client.next(
    f => f.t === "update" && (f.update as { sessionUpdate?: string })?.sessionUpdate === "agent_message_chunk",
    "agent_message_chunk",
  );

  // Append post-resume turn to session file
  const postResumeTimestamp = new Date(Date.now() + 1000).toISOString();
  const postResumeLine = JSON.stringify({
    type: "message",
    timestamp: postResumeTimestamp,
    message: { id: "msg_post_resume", role: "user", content: "post resume turn 3" },
  });
  writeFileSync(sessionFile, `${lines.join("\n")}\n${postResumeLine}\n`);

  // Request session_history for the agent
  client.send({ t: "session_history", agentId, sessionId });
  const hist = await client.next(f => f.t === "session_history", "session_history");
  if (hist.t !== "session_history") throw new Error("expected session_history");

  // 1. History returns exactly the two older turns
  expect(hist.entries).toHaveLength(2);
  expect(hist.entries.map(e => (e.kind === "user" ? e.text : ""))).toEqual(["old turn 1", "old turn 2"]);

  // 2. Replay from seq 0 contains:
  // - state updates from loadSession (session_info_update)
  // - exactly one user_message_chunk for "post resume turn 3"
  // - new turn's assistant chunk ("new assistant reply")
  // and ZERO transcript chunks from the old session/load replay!
  const updates = store.updatesSince(agentId, 0);
  const transcriptUpdates = updates.filter(u => {
    const kind = (u.payload as { sessionUpdate?: string })?.sessionUpdate;
    return kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk";
  });
  expect(transcriptUpdates).toHaveLength(2);
  expect((transcriptUpdates[0]!.payload as { sessionUpdate: string }).sessionUpdate).toBe("user_message_chunk");
  expect((transcriptUpdates[0]!.payload as { content: { text: string } }).content.text).toBe("post resume turn 3");
  expect((transcriptUpdates[1]!.payload as { sessionUpdate: string }).sessionUpdate).toBe("agent_message_chunk");
  expect((transcriptUpdates[1]!.payload as { content: { text: string } }).content.text).toBe("new assistant reply");

  client.close();
});

test("D7/D8: fresh agent created via agent_create answers empty first page for session_history and replay starts with user chunk", async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "gw-hist-fresh-db-"));
  scratchDirs.push(dbDir);
  const store = new Store(join(dbDir, "ompd.db"));
  stores.push(store);

  const freshSessionId = "019feebf-7000-7000-8000-0000000000f2";
  const fake = createFakeHost({ nextSessionId: () => freshSessionId });
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const sessionsRoot = mkdtempSync(join(tmpdir(), "gw-hist-fresh-sess-"));
  scratchDirs.push(sessionsRoot);
  const sessionIndex = new SessionIndex({ store, sessionsRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
  gateways.push(gw);
  const port = await gw.listen();

  const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "fresh-dev", publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const pairJson: unknown = await pairRes.json();
  if (!pairJson || typeof pairJson !== "object" || !("code" in pairJson) || typeof pairJson.code !== "string") {
    throw new Error("pair response carried no code");
  }
  const token = gw.approvePairing(pairJson.code, [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);

  const actor: Actor = {
    deviceId: "dev_test_fresh",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };
  store.addDevice({
    id: actor.deviceId,
    name: "test-device-fresh",
    publicKey: "pk_test_fresh",
    scopes: actor.scopes,
    createdAt: new Date().toISOString(),
  });

  const agent = await sup.createAgent({ name: "fresh-agent", cwd: "/work" }, actor);
  const sessionId = agent.acpSessionId!;

  // Write session file containing turns created under this fresh agent (timestamp >= agent.createdAt)
  const groupDir = join(sessionsRoot, "-base");
  mkdirSync(groupDir, { recursive: true });
  const sessionFile = join(groupDir, `2026-08-10T00-00-00-000Z_${sessionId}.jsonl`);
  const turnTime = new Date(new Date(agent.createdAt).getTime() + 1000).toISOString();
  const fileLines = [
    JSON.stringify({ type: "title", v: 1, title: "fresh session", updatedAt: turnTime }),
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: turnTime, cwd: "/work" }),
    JSON.stringify({
      type: "message",
      timestamp: turnTime,
      message: { id: "msg_fresh_1", role: "user", content: "fresh turn 1" },
    }),
  ];
  writeFileSync(sessionFile, `${fileLines.join("\n")}\n`);

  const client = await connect(port, token);
  await client.next(f => f.t === "hello", "hello");

  // Attach to fresh agent
  client.send({ t: "attach", agentId: agent.id });
  client.send({ t: "ping" });
  await client.next(f => f.t === "pong", "pong after attach");

  // Send a prompt
  fake.onPrompt(() => {
    fake.emitUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "fresh assistant reply" },
      messageId: "asst_fresh_1",
    });
    return { stopReason: "end_turn" };
  });

  client.send({ t: "prompt", agentId: agent.id, text: "fresh prompt 1" });
  await client.next(
    f => f.t === "update" && (f.update as { sessionUpdate?: string })?.sessionUpdate === "user_message_chunk",
    "user_message_chunk",
  );

  // 1. Session history is empty for fresh agent
  client.send({ t: "session_history", agentId: agent.id, sessionId });
  const hist = await client.next(f => f.t === "session_history", "session_history");
  if (hist.t !== "session_history") throw new Error("expected session_history");
  expect(hist.entries).toEqual([]);

  // 2. First transcript update in replay is the user chunk
  const updates = store.updatesSince(agent.id, 0);
  const transcriptUpdates = updates.filter(u => {
    const kind = (u.payload as { sessionUpdate?: string })?.sessionUpdate;
    return kind === "user_message_chunk" || kind === "agent_message_chunk" || kind === "agent_thought_chunk";
  });
  expect(transcriptUpdates.length).toBeGreaterThanOrEqual(1);
  const first = transcriptUpdates[0]!.payload as { sessionUpdate: string; content: { text: string } };
  expect(first.sessionUpdate).toBe("user_message_chunk");
  expect(first.content.text).toBe("fresh prompt 1");

  client.close();
});
