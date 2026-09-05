/**
 * The collab guest leg, from two ends.
 *
 * The unit end covers the pure pieces: link parsing (the whole grammar the
 * host can print) and the stream mapper (collab frames to the ACP update
 * payloads the phone renders, including the double-render guard and the
 * reconnect dedupe).
 *
 * The socket end runs the real gateway with a real registered TUI leg, a
 * real Bun websocket relay, and a scripted host that seals its frames with
 * the room key through the same codec the guest leg uses. Nothing between
 * the phone socket and the relay is faked: `collab_open` walks the bridge
 * round trip, the join walks the relay handshake, and prompts arrive at the
 * host as sealed envelopes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientFrame,
  COLLAB_REFUSAL_REASONS,
  DefaultPolicy,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
} from "@ompd/core";
import type { ServerWebSocket } from "bun";
import { importRoomKey, open, packEnvelope, seal, unpackEnvelope } from "../src/collab/guest-codec.ts";
import type { CollabGuestFrame, CollabHostFrame } from "../src/collab/guest-frames.ts";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../src/collab/guest-frames.ts";
import { parseCollabLink } from "../src/collab/guest-link.ts";
import { CollabStreamMapper } from "../src/collab/guest-mapper.ts";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { encodeSessionDirName } from "../src/sessions/cwd-codec.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

/**
 * Deadline for waiting on a frame that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 5000;

const SESSION_LIVE = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";

const scratchDirs: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const relays: RelayRoom[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const relay of relays.splice(0)) relay.close();
  for (const gateway of gateways.splice(0)) void gateway.close();
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit: link parsing
// ---------------------------------------------------------------------------

function roomMaterial(): { roomId: string; key: Uint8Array; token: Uint8Array } {
  const bytes = new Uint8Array(48);
  crypto.getRandomValues(bytes);
  return {
    roomId: Buffer.from(crypto.getRandomValues(new Uint8Array(12)))
      .toString("base64url")
      .slice(0, 16),
    key: bytes.slice(0, 32),
    token: bytes.slice(32),
  };
}

describe("parseCollabLink", () => {
  test("splits a full local link into relay, room, key, and write token", () => {
    const { roomId, key, token } = roomMaterial();
    const secret = Buffer.concat([key, token]).toString("base64url");
    const parsed = parseCollabLink(`ws://127.0.0.1:7475/r/${roomId}.${secret}`);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.wsUrl).toBe(`ws://127.0.0.1:7475/r/${roomId}`);
    expect(parsed.roomId).toBe(roomId);
    expect(Buffer.from(parsed.key).equals(key)).toBe(true);
    expect(parsed.writeToken !== undefined && Buffer.from(parsed.writeToken).equals(token)).toBe(true);
  });

  test("a bare 32-byte secret is a view link: same key, no write token", () => {
    const { roomId, key } = roomMaterial();
    const parsed = parseCollabLink(`ws://localhost:9000/r/${roomId}.${Buffer.from(key).toString("base64url")}`);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.writeToken).toBeUndefined();
    expect(Buffer.from(parsed.key).equals(key)).toBe(true);
  });

  test("the legacy hash form and the percent-mangled form both parse", () => {
    const { roomId, key, token } = roomMaterial();
    const secret = Buffer.concat([key, token]).toString("base64url");
    const legacy = parseCollabLink(`wss://relay.example.com/r/${roomId}#${secret}`);
    if ("error" in legacy) throw new Error(legacy.error);
    expect(legacy.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
    const mangled = parseCollabLink(`wss://relay.example.com/r/${roomId}%23${secret}`);
    if ("error" in mangled) throw new Error(mangled.error);
    expect(mangled.wsUrl).toBe(legacy.wsUrl);
  });

  test("a bare link resolves against the default public relay", () => {
    const { roomId, key, token } = roomMaterial();
    const secret = Buffer.concat([key, token]).toString("base64url");
    const parsed = parseCollabLink(`${roomId}.${secret}`);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.wsUrl).toBe(`wss://my.omp.sh/r/${roomId}`);
  });

  test("an http wrapper recurses into the link in its fragment", () => {
    const { roomId, key } = roomMaterial();
    const inner = `relay.example.com/r/${roomId}.${Buffer.from(key).toString("base64url")}`;
    const parsed = parseCollabLink(`https://web.example.com/collab/#${inner}`);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.wsUrl).toBe(`wss://relay.example.com/r/${roomId}`);
  });

  test("a secret of the wrong length is refused, not guessed at", () => {
    const { roomId } = roomMaterial();
    const short = Buffer.from("toolongtobeakeybutnot48").toString("base64url");
    const parsed = parseCollabLink(`ws://127.0.0.1:7475/r/${roomId}.${short}`);
    expect("error" in parsed).toBe(true);
  });

  test("a link without a room path is refused", () => {
    const parsed = parseCollabLink("ws://127.0.0.1:7475/nothing-here");
    expect("error" in parsed).toBe(true);
  });

  test("plain ws off localhost is refused", () => {
    const { roomId, key } = roomMaterial();
    const secret = Buffer.from(key).toString("base64url");
    const parsed = parseCollabLink(`ws://relay.example.com/r/${roomId}.${secret}`);
    expect("error" in parsed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: stream mapper
// ---------------------------------------------------------------------------

const HOST_STATE = {
  isStreaming: false,
  queuedMessageCount: 0,
  cwd: "/tmp/host",
  participants: [{ name: "host", role: "host" as const }],
};

function assistantMessage(text: string): {
  role: "assistant";
  content: Array<{ type: "text"; text: string }>;
  model: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  };
  stopReason: string;
  timestamp: number;
} {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    model: "test/model",
    usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function userEntry(
  id: string,
  text: string,
): {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: { role: "user"; content: string; timestamp: number };
} {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-20T00:00:00.000Z",
    message: { role: "user", content: text, timestamp: Date.now() },
  };
}

function assistantEntry(
  id: string,
  text: string,
): {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: ReturnType<typeof assistantMessage>;
} {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-08-20T00:00:00.000Z",
    message: assistantMessage(text),
  };
}

describe("CollabStreamMapper", () => {
  test("backfills a snapshot into user chunks, assistant chunks, and tool cards", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    const welcome = mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 3,
      agents: [],
    });
    expect(welcome.snapshotFinal).toBeUndefined();
    expect(welcome.entryCount).toBe(3);

    const chunk = mapper.mapFrame({
      t: "snapshot-chunk",
      final: true,
      entries: [
        userEntry("e1", "please look"),
        {
          ...assistantEntry("e2", "reading it now"),
          message: {
            ...assistantMessage("reading it now"),
            content: [
              { type: "text", text: "reading it now" },
              { type: "toolCall", id: "tc1", name: "Read", arguments: { path: "/w/a.txt" } },
            ],
          },
        },
        {
          type: "message",
          id: "e3",
          parentId: null,
          timestamp: "2026-08-20T00:00:01.000Z",
          message: {
            role: "toolResult",
            toolCallId: "tc1",
            toolName: "Read",
            content: [{ type: "text", text: "file body" }],
            isError: false,
            timestamp: Date.now(),
          },
        },
      ],
    });
    expect(chunk.snapshotFinal).toBe(true);
    const kinds = chunk.updates.map(update => (update as { sessionUpdate: string }).sessionUpdate);
    expect(kinds).toEqual(["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update"]);
    const tool = chunk.updates[2] as { toolCallId: string; kind: string; rawInput: unknown; status: string };
    expect(tool.toolCallId).toBe("tc1");
    expect(tool.kind).toBe("read");
    expect(tool.rawInput).toEqual({ path: "/w/a.txt" });
    const result = chunk.updates[3] as { status: string; rawOutput: { content: Array<{ type: "string" | "text" }> } };
    expect(result.status).toBe("completed");
  });

  test("streams a live assistant message as growing deltas, one row per message", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [],
    });
    const first = mapper.mapFrame({
      t: "event",
      event: {
        type: "message_update",
        message: { ...assistantMessage("hel"), content: [{ type: "text", text: "hel" }] },
      },
    });
    const second = mapper.mapFrame({
      t: "event",
      event: {
        type: "message_update",
        message: { ...assistantMessage("hello world"), content: [{ type: "text", text: "hello world" }] },
      },
    });
    const texts = [...first.updates, ...second.updates].map(
      update => (update as { content?: { text?: string } }).content?.text ?? "",
    );
    expect(texts).toEqual(["hel", "lo world"]);
    // One stable messageId across both updates: the phone's reducer appends
    // to the same row instead of opening a new one per delta.
    const ids = [...first.updates, ...second.updates].map(update => (update as { messageId?: string }).messageId);
    expect(ids[0]).toBe(ids[1]);
  });

  test("a second assistant message gets a fresh messageId and its own row", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [],
    });
    const one = mapper.mapFrame({
      t: "event",
      event: {
        type: "message_start",
        message: { ...assistantMessage("first"), content: [{ type: "text", text: "first" }] },
      },
    });
    const two = mapper.mapFrame({
      t: "event",
      event: {
        type: "message_start",
        message: { ...assistantMessage("second"), content: [{ type: "text", text: "second" }] },
      },
    });
    const firstId = (one.updates[0] as { messageId: string }).messageId;
    const secondId = (two.updates[0] as { messageId: string }).messageId;
    expect(firstId).not.toBe(secondId);
  });

  test("tool execution events announce and settle a card even with no message block seen", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [],
    });
    const started = mapper.mapFrame({
      t: "event",
      event: { type: "tool_execution_start", toolCallId: "t9", toolName: "bash", args: { command: "ls" } },
    });
    const ended = mapper.mapFrame({
      t: "event",
      event: { type: "tool_execution_end", toolCallId: "t9", toolName: "bash", result: "a\nb", isError: false },
    });
    const announce = started.updates[0] as { sessionUpdate: string; kind: string; status: string };
    expect(announce.sessionUpdate).toBe("tool_call");
    expect(announce.kind).toBe("execute");
    expect(announce.status).toBe("in_progress");
    const settle = ended.updates[0] as {
      sessionUpdate: string;
      status: string;
      rawOutput: { content: Array<{ type: string; text: string }> };
    };
    expect(settle.sessionUpdate).toBe("tool_call_update");
    expect(settle.status).toBe("completed");
    expect(settle.rawOutput.content[0]?.text).toBe("a\nb");
  });

  test("this leg's own collab prompt maps without prefix; another guest's is named", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [],
    });
    const own = mapper.mapFrame({
      t: "entry",
      entry: {
        type: "custom_message",
        id: "c1",
        parentId: null,
        timestamp: "2026-08-20T00:00:02.000Z",
        customType: "collab-prompt",
        content: "from the phone",
        details: { from: "ompd" },
        display: true,
      },
    });
    expect(own.updates).toEqual([
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "from the phone" },
        messageId: "c1",
      },
    ]);
    const other = mapper.mapFrame({
      t: "entry",
      entry: {
        type: "custom_message",
        id: "c2",
        parentId: null,
        timestamp: "2026-08-20T00:00:03.000Z",
        customType: "collab-prompt",
        content: "from another guest",
        details: { from: "laptop" },
        display: true,
      },
    });
    const chunk = other.updates[0] as { content: { text: string } };
    expect(chunk.content.text).toBe("[laptop] from another guest");
  });

  test("live assistant and toolResult entries are suppressed; live user entries render", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [],
    });
    // The operator typed at the host terminal: no event stream carries it.
    const typed = mapper.mapFrame({ t: "entry", entry: userEntry("u1", "operator typed") });
    expect((typed.updates[0] as { content: { text: string } }).content.text).toBe("operator typed");
    // The streamed assistant message lands as its durable entry: already
    // rendered from events, so it must not render again.
    const landed = mapper.mapFrame({ t: "entry", entry: assistantEntry("a1", "already streamed") });
    expect(landed.updates).toEqual([]);
  });

  test("a reconnect's resnapshot of the same entries appends nothing", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 1,
      agents: [],
    });
    const first = mapper.mapFrame({ t: "snapshot-chunk", final: true, entries: [userEntry("e1", "once")] });
    expect(first.updates.length).toBe(1);
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 1,
      agents: [],
    });
    const again = mapper.mapFrame({ t: "snapshot-chunk", final: true, entries: [userEntry("e1", "once")] });
    expect(again.updates).toEqual([]);
  });

  test("state frames carry footer info and context usage", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    const mapped = mapper.mapFrame({
      t: "state",
      state: {
        ...HOST_STATE,
        sessionName: "scratch work",
        model: { id: "m1", name: "Model One", provider: "p", contextWindow: 200_000 },
        contextUsage: { tokens: 20_000, contextWindow: 200_000, percent: 10 },
      },
    });
    const info = mapped.updates[0] as { sessionUpdate: string; title?: string; model?: string };
    expect(info.sessionUpdate).toBe("session_info_update");
    expect(info.title).toBe("scratch work");
    expect(info.model).toBe("Model One");
    const usage = mapped.updates[1] as { sessionUpdate: string; used: number; size?: number };
    expect(usage.sessionUpdate).toBe("usage_update");
    expect(usage.used).toBe(20_000);
    expect(usage.size).toBe(200_000);
    expect(mapped.state?.isStreaming).toBe(false);
  });

  test("a state frame forwards the host's thinking level, and says nothing when it has none", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    const reported = mapper.mapFrame({ t: "state", state: { ...HOST_STATE, thinkingLevel: "high" } });
    expect(reported.updates[0]).toMatchObject({ sessionUpdate: "session_info_update", thinkingLevel: "high" });

    // A host that reports none must not have one invented for it: the app's
    // info reducer keeps whatever it last knew, and undefined is the only
    // honest way to say "this frame carried no answer".
    const silent = mapper.mapFrame({ t: "state", state: { ...HOST_STATE, isStreaming: true } });
    // Named, as every other assertion in this describe names it: the mapper's
    // return type is deliberately `unknown[]`, so a test reads one update
    // through a stated shape rather than asserting inside the access.
    const info = silent.updates[0] as { sessionUpdate: string; thinkingLevel?: string };
    expect(info.sessionUpdate).toBe("session_info_update");
    expect(info.thinkingLevel).toBeUndefined();
  });

  /**
   * One finished tool call, mapped the way a room actually delivers it: the
   * start frame announces the card, so the end frame's updates are the
   * settle and whatever else that result publishes. Announcing here rather
   * than letting the end frame do it keeps every index below meaningful.
   */
  function endToolCall(toolName: string, result: unknown, isError = false): unknown[] {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "event",
      event: { type: "tool_execution_start", toolCallId: "tc", toolName, args: {} },
    });
    return mapper.mapFrame({
      t: "event",
      event: { type: "tool_execution_end", toolCallId: "tc", toolName, result, isError },
    }).updates;
  }

  test("a finished todo tool call publishes the session's todo list, phases and blockers intact", () => {
    // The todo tool's own return shape, as omp 18.0.3 builds it:
    // `details.phases[] = { name, tasks: [{ content, status, blocker? }] }`.
    const updates = endToolCall("todo", {
      details: {
        phases: [
          {
            name: "Audit",
            tasks: [
              { content: "Trace the contracts", status: "completed" },
              { content: "Read the reducer", status: "in_progress" },
            ],
          },
          {
            name: "Build",
            tasks: [
              { content: "Wire the panel", status: "blocked", blocker: "waiting on the loading fix" },
              { content: "Add a third rail", status: "abandoned" },
              { content: "Ship it", status: "pending" },
            ],
          },
        ],
      },
    });

    // The tool card still settles: the plan is an addition, not a diversion.
    expect(updates[0]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
    // Every phase name and both of the states omp's own ACP emitter folds
    // away survive, which is the entire reason this path exists.
    expect(updates[1]).toEqual({
      sessionUpdate: "plan",
      entries: [
        { content: "Trace the contracts", priority: "medium", status: "completed", phase: "Audit" },
        { content: "Read the reducer", priority: "medium", status: "in_progress", phase: "Audit" },
        {
          content: "Wire the panel",
          priority: "medium",
          status: "blocked",
          phase: "Build",
          blocker: "waiting on the loading fix",
        },
        { content: "Add a third rail", priority: "medium", status: "abandoned", phase: "Build" },
        { content: "Ship it", priority: "medium", status: "pending", phase: "Build" },
      ],
    });
  });

  test("clearing the todos publishes an empty list rather than leaving the last one on screen", () => {
    expect(endToolCall("todo", { details: { phases: [] } })[1]).toEqual({ sessionUpdate: "plan", entries: [] });
  });

  test("a todo call that failed, and any other tool, publish no plan at all", () => {
    const phases = [{ name: "P", tasks: [{ content: "x", status: "pending" }] }];
    expect(endToolCall("todo", { details: { phases } }, true)).toHaveLength(1);
    expect(endToolCall("bash", "ok")).toHaveLength(1);
    // A todo result whose shape the host changed under us is not a cleared
    // list: publishing an empty plan for it would wipe a live todo list on
    // every phone watching, so it publishes nothing.
    expect(endToolCall("todo", { ok: true })).toHaveLength(1);
  });

  test("one malformed task is dropped; the rest of the operator's list still publishes", () => {
    const updates = endToolCall("todo", {
      details: {
        phases: [
          { tasks: [{ content: "", status: "pending" }, { status: "pending" }, "not an object"] },
          { name: "Real", tasks: [{ content: "Keep this", status: "notastatus" }] },
          // No `tasks` at all: skipped rather than treated as empty.
          { name: "Bare" },
        ],
      },
    });
    // An unknown status falls back to pending, the same fallback the app's
    // reducer makes, rather than dropping the operator's task over it.
    expect(updates[1]).toEqual({
      sessionUpdate: "plan",
      entries: [{ content: "Keep this", priority: "medium", status: "pending", phase: "Real" }],
    });
  });

  test("a runaway plan is published up to the host's own array limit, not unbounded", () => {
    // 300 tasks in one phase: past the 256 the host's own first shrink tier
    // would have applied, so this leg publishes no more than the producer
    // would have sent had the frame needed shrinking.
    const tasks = Array.from({ length: 300 }, (_, index) => ({ content: `task ${index}`, status: "pending" }));
    const updates = endToolCall("todo", { details: { phases: [{ name: "Long", tasks }] } });
    const plan = updates[1] as { sessionUpdate: string; entries: Array<{ content: string }> };
    expect(plan.sessionUpdate).toBe("plan");
    expect(plan.entries).toHaveLength(256);
    // Truncated from the end, so the todos the operator is working on survive.
    expect(plan.entries[0]?.content).toBe("task 0");
    expect(plan.entries[255]?.content).toBe("task 255");
  });

  test("a blocker on a task that is not blocked is dropped, never shown as a live obstruction", () => {
    const updates = endToolCall("todo", {
      details: {
        phases: [{ name: "P", tasks: [{ content: "Unblocked now", status: "in_progress", blocker: "stale" }] }],
      },
    });
    expect(updates[1]).toEqual({
      sessionUpdate: "plan",
      entries: [{ content: "Unblocked now", priority: "medium", status: "in_progress", phase: "P" }],
    });
  });

  test("usage accumulates across assistant messages for the agent row", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 2,
      agents: [],
    });
    mapper.mapFrame({
      t: "snapshot-chunk",
      final: true,
      entries: [assistantEntry("a1", "one"), assistantEntry("a2", "two")],
    });
    expect(mapper.metrics()).toEqual({ usedTokens: 30, costAmount: 0.002 });
  });

  test("the welcome registry and agents frames map, and an invalid payload maps nothing", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    const welcome = mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [
        {
          id: "Main",
          displayName: "primary",
          kind: "main",
          status: "running",
          hasSessionFile: true,
          createdAt: 1,
          lastActivity: 2,
        },
      ],
    });
    expect(welcome.agents).toHaveLength(1);

    const broadcast = mapper.mapFrame({
      t: "agents",
      agents: [
        {
          id: "Main",
          displayName: "primary",
          kind: "main",
          status: "idle",
          hasSessionFile: true,
          createdAt: 1,
          lastActivity: 3,
        },
        {
          id: "Scout",
          displayName: "Policy Scout",
          kind: "sub",
          parentId: "Main",
          status: "running",
          hasSessionFile: false,
          createdAt: 2,
          lastActivity: 3,
        },
      ],
    });
    expect(broadcast.agents).toHaveLength(2);

    // One bad entry voids the payload, never half of it. Cast: the type
    // system knows "sleeping" is not a status, which is the point of
    // sending it as wire garbage.
    const invalid = mapper.mapFrame({
      t: "agents",
      agents: [
        {
          id: "Main",
          displayName: "primary",
          kind: "main",
          status: "sleeping",
          hasSessionFile: true,
          createdAt: 1,
          lastActivity: 3,
        },
      ] as unknown as never,
    });
    expect(invalid.agents).toBeUndefined();
    const notAnArray = mapper.mapFrame({ t: "agents", agents: "Main" as unknown as never });
    expect(notAnArray.agents).toBeUndefined();
  });

  test("mid-stream duplication: streaming two chunks then reconnecting with finished entry yields exactly one assistant entry", () => {
    const mapper = new CollabStreamMapper({ ownName: "ompd" });
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 0,
      agents: [],
    });

    // Stream chunk 1
    const chunk1 = mapper.mapFrame({
      t: "event",
      event: {
        type: "message_update",
        message: { ...assistantMessage("hel"), content: [{ type: "text", text: "hel" }] },
      },
    });
    expect(chunk1.updates).toHaveLength(1);
    expect((chunk1.updates[0] as { content: { text: string } }).content.text).toBe("hel");
    const msgId1 = (chunk1.updates[0] as { messageId: string }).messageId;

    // Stream chunk 2
    const chunk2 = mapper.mapFrame({
      t: "event",
      event: {
        type: "message_update",
        message: { ...assistantMessage("hello"), content: [{ type: "text", text: "hello" }] },
      },
    });
    expect(chunk2.updates).toHaveLength(1);
    expect((chunk2.updates[0] as { content: { text: string } }).content.text).toBe("lo");
    const msgId2 = (chunk2.updates[0] as { messageId: string }).messageId;
    expect(msgId1).toBe(msgId2);

    // Connection drops and reconnects: welcome, then snapshot-chunk with finished entry
    mapper.mapFrame({
      t: "welcome",
      proto: 3,
      header: { type: "session", id: "s1", timestamp: "t", cwd: "/w" },
      state: HOST_STATE,
      entryCount: 1,
      agents: [],
    });

    const replayed = mapper.mapFrame({
      t: "snapshot-chunk",
      final: true,
      entries: [assistantEntry("a1", "hello world")],
    });

    // Replay should emit only the unstreamed remainder, sharing msgId1
    expect(replayed.updates).toHaveLength(1);
    expect((replayed.updates[0] as { content: { text: string } }).content.text).toBe(" world");
    expect((replayed.updates[0] as { messageId: string }).messageId).toBe(msgId1);

    // Total chunks emitted across both phases share msgId1, producing exactly one assistant entry
    const allChunks = [...chunk1.updates, ...chunk2.updates, ...replayed.updates];
    const messageIds = allChunks.map(u => (u as { messageId: string }).messageId);
    expect(new Set(messageIds).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The scripted relay room
// ---------------------------------------------------------------------------

/**
 * A real websocket relay room and its scripted host. The guest connects as a
 * guest; this side plays the authoritative host, sealing frames with the room
 * key through the same codec the guest leg uses, so the seal, envelope, and
 * handshake are exercised for real.
 */
class RelayRoom {
  readonly roomId: string;
  readonly key: Uint8Array;
  readonly token: Uint8Array;
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #cryptoKey: Promise<CryptoKey>;
  #guest: ServerWebSocket<unknown> | null = null;
  /** Every guest frame the room decrypted, in arrival order. */
  readonly received: CollabGuestFrame[] = [];
  readonly #onHello: (room: RelayRoom, hello: CollabGuestFrame) => void;

  constructor(onHello: (room: RelayRoom, hello: CollabGuestFrame) => void) {
    const material = roomMaterial();
    this.roomId = material.roomId;
    this.key = material.key;
    this.token = material.token;
    this.#onHello = onHello;
    this.#cryptoKey = importRoomKey(this.key);
    const self = this;
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname !== `/r/${self.roomId}`) return new Response("not found", { status: 404 });
        if (server.upgrade(req, { data: { roomId: self.roomId } })) return;
        return new Response("upgrade failed", { status: 500 });
      },
      websocket: {
        open(ws) {
          self.#guest = ws;
        },
        async message(_ws, message) {
          if (typeof message === "string") return;
          const bytes = new Uint8Array(message);
          const envelope = unpackEnvelope(bytes);
          if (envelope === null) return;
          const frame = (await open(await self.#cryptoKey, envelope.payload)) as unknown as CollabGuestFrame;
          self.received.push(frame);
          if (frame.t === "hello") self.#onHello(self, frame);
        },
        close() {
          self.#guest = null;
        },
      },
    });
  }

  get port(): number {
    const port = this.#server.port;
    if (port === undefined) throw new Error("the test relay did not bind a port");
    return port;
  }

  /** The full-control link for this room, as the host would print it. */
  fullLink(): string {
    return `ws://127.0.0.1:${this.port}/r/${this.roomId}.${Buffer.concat([this.key, this.token]).toString("base64url")}`;
  }

  /** The view-only strength of the same room. */
  viewLink(): string {
    return `ws://127.0.0.1:${this.port}/r/${this.roomId}.${Buffer.from(this.key).toString("base64url")}`;
  }

  async send(frame: CollabHostFrame): Promise<void> {
    const guest = this.#guest;
    if (guest === null) throw new Error("relay room has no guest connected");
    guest.send(packEnvelope(1, await seal(await this.#cryptoKey, frame)));
  }

  /** Abrupt transport kill, as a dying relay process produces. */
  terminateGuest(): void {
    this.#guest?.terminate();
  }

  /** Relay-level room death: the fatal close code guests never retry. */
  closeGuestAsRoomClosed(): void {
    this.#guest?.close(4001, "room closed");
  }

  close(): void {
    this.#guest?.terminate();
    this.#server.stop(true);
  }
}

/** The scripted host's welcome plus a two-entry back-transcript. */
async function hostWelcomeWithTranscript(room: RelayRoom): Promise<void> {
  await room.send({
    t: "welcome",
    proto: 3,
    header: {
      type: "session",
      id: SESSION_LIVE,
      title: "held by a TUI",
      timestamp: "2026-08-10T00:00:00.000Z",
      cwd: "/host",
    },
    state: { ...HOST_STATE, isStreaming: false, sessionName: "held by a TUI" },
    entryCount: 2,
    readOnly: false,
    agents: [],
  });
  await room.send({
    t: "snapshot-chunk",
    final: true,
    entries: [userEntry("back-1", "what is in this repo"), assistantEntry("back-2", "a daemon and a phone app")],
  });
}

// ---------------------------------------------------------------------------
// Socket harness
// ---------------------------------------------------------------------------

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

interface BridgeLeg {
  /** Every frame the daemon sent down the bridge socket, in order. */
  frames: Array<Record<string, unknown>>;
  deliver(frame: ClientFrame): void;
}

interface Harness {
  port: number;
  gateway: Gateway;
  store: Store;
  liveDir: string;
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
  registerBridge(): Promise<BridgeLeg>;
}

async function harness(): Promise<Harness> {
  const dbPath = join(tempDir("cg-db-"), "ompd.db");
  const store = new Store(dbPath);
  stores.push(store);

  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: createFakeHost().factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const sessionsRoot = tempDir("cg-tree-");
  const runRoot = tempDir("cg-run-");
  const liveDir = tempDir("cg-live-proj-");
  const sessionIndex = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts, sessionIndex });
  gateways.push(gw);
  const port = await gw.listen();

  // A real session file, so the index classifies SESSION_LIVE as existing.
  const groupDir = join(sessionsRoot, encodeSessionDirName(liveDir));
  mkdirSync(groupDir, { recursive: true });
  writeFileSync(
    join(groupDir, `2026-08-10T00-00-00-000Z_${SESSION_LIVE}.jsonl`),
    `${JSON.stringify({ type: "title", v: 1, title: "held by a TUI", updatedAt: new Date().toISOString() })}\n${JSON.stringify({ type: "session", version: 3, id: SESSION_LIVE, timestamp: "t", cwd: liveDir })}\n`,
  );

  return {
    port,
    gateway: gw,
    store,
    liveDir,
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
    registerBridge: async () => {
      const token = await pairDevice(port, gw, "bridge-device");
      const frames: Array<Record<string, unknown>> = [];
      const tunnel = gw.acceptTunnelSession(token, raw => {
        frames.push(JSON.parse(raw) as Record<string, unknown>);
      });
      if (!tunnel.ok) throw new Error(`could not open paired bridge tunnel: ${tunnel.reason}`);
      // The bridge is the hosting terminal's own control socket: it must
      // register the session before the daemon will address it.
      tunnel.deliver(
        JSON.stringify({
          t: "tui_register",
          sessionId: SESSION_LIVE,
          cwd: liveDir,
          title: "held by a TUI",
          pid: process.pid,
        }),
      );
      return {
        frames,
        deliver: frame => tunnel.deliver(JSON.stringify(frame)),
      };
    },
  };
}

/** Pair one named device and return its token. */
async function pairDevice(port: number, gw: Gateway, name: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const body = (await res.json()) as { code?: unknown };
  if (typeof body.code !== "string") throw new Error("pair response carried no code");
  return gw.approvePairing(body.code, [SCOPE_READ, SCOPE_MANAGE]);
}

// ---------------------------------------------------------------------------
// Socket: the guest leg end to end
// ---------------------------------------------------------------------------

function isCollabOpened(frame: ServerFrame): frame is Extract<ServerFrame, { t: "collab_opened" }> {
  return frame.t === "collab_opened";
}

function isErrorWithCode(code: string): (frame: ServerFrame) => boolean {
  return frame => frame.t === "error" && frame.code === code;
}

describe("collab guest legs over the gateway socket", () => {
  test("joins a hosted session, replays its transcript, steers it, and leaves cleanly", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      await hostWelcomeWithTranscript(r);
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });

    // The daemon asks the hosting terminal for a room on its own relay.
    const openAsk = await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_open");
    expect(openAsk.relayUrl).toBe(`ws://127.0.0.1:${h.port}`);
    bridge.deliver({
      t: "tui_collab_opened",
      sessionId: SESSION_LIVE,
      requestId: openAsk.requestId as string,
      link: room.fullLink(),
      viewLink: room.viewLink(),
      writable: true,
    });

    const opened = openedFrame(await phone.next(isCollabOpened, "collab_opened"));
    expect(opened.agentId).toMatch(/^agt_/);
    expect(opened.readOnly).toBe(false);

    // The host saw a full-control hello carrying the write token.
    const hello = room.received.find(frame => frame.t === "hello");
    expect(hello).toBeDefined();
    if (hello?.t !== "hello") throw new Error("expected a hello frame");
    expect(hello.writeToken).toBe(Buffer.from(room.token).toString("base64url"));

    // The back-transcript is in the update log: attach replays it.
    phone.send({ t: "attach", agentId: opened.agentId, sinceSeq: 0 });
    const userChunk = await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("what is in this repo"),
      "replayed user chunk",
    );
    expect(userChunk.t).toBe("update");
    await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("a daemon and a phone app"),
      "replayed assistant chunk",
    );

    // A prompt rides the sealed room frame; the answer streams back as deltas.
    phone.send({ t: "prompt", agentId: opened.agentId, text: "say collab works" });
    const prompt = await waitUntil(() => room.received.find(frame => frame.t === "prompt"));
    if (prompt?.t !== "prompt") throw new Error("expected a prompt frame at the host");
    expect(prompt.text).toBe("say collab works");

    await room.send({
      t: "event",
      event: {
        type: "message_start",
        message: { ...assistantMessage("col"), content: [{ type: "text", text: "col" }] },
      },
    });
    await room.send({
      t: "event",
      event: {
        type: "message_update",
        message: { ...assistantMessage("collab answer"), content: [{ type: "text", text: "collab answer" }] },
      },
    });
    const first = await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes('"col"'),
      "first streamed delta",
    );
    void first;
    await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("lab answer"),
      "second streamed delta",
    );

    // Leaving ends the leg, settles the row, and releases the bridge's room.
    phone.send({ t: "collab_leave", sessionId: SESSION_LIVE });
    await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_close");
    const stopped = await phone.next(
      frame =>
        frame.t === "agents" && frame.agents.some(agent => agent.id === opened.agentId && agent.state === "stopped"),
      "agent row settled to stopped",
    );
    void stopped;
    room.close();
  });

  test("the room's agent registry reaches the phone as Agent Hub rows and settles with the leg", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      await r.send({
        t: "welcome",
        proto: 3,
        header: { type: "session", id: SESSION_LIVE, title: "held by a TUI", timestamp: "t", cwd: "/host" },
        state: { ...HOST_STATE, isStreaming: false },
        entryCount: 0,
        readOnly: false,
        agents: [
          {
            id: "Main",
            displayName: "primary",
            kind: "main",
            status: "running",
            hasSessionFile: true,
            createdAt: 1_000,
            lastActivity: 2_000,
          },
        ],
      });
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });
    const openAsk = await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_open");
    bridge.deliver({
      t: "tui_collab_opened",
      sessionId: SESSION_LIVE,
      requestId: openAsk.requestId as string,
      link: room.fullLink(),
      viewLink: room.viewLink(),
      writable: true,
    });
    const opened = openedFrame(await phone.next(isCollabOpened, "collab_opened"));

    // Roster pushes reach attached sockets only, the same choke point every
    // other agents change rides, so the phone attaches first.
    phone.send({ t: "attach", agentId: opened.agentId, sinceSeq: 0 });

    // A registry change in the room becomes a roster push naming the sub,
    // parented under the guest agent, with the wire's epoch-millisecond
    // dates carried into the row's ISO fields.
    await room.send({
      t: "agents",
      agents: [
        {
          id: "Main",
          displayName: "primary",
          kind: "main",
          status: "running",
          hasSessionFile: true,
          createdAt: 1_000,
          lastActivity: 4_000,
        },
        {
          id: "Scout",
          displayName: "Policy Scout",
          kind: "sub",
          parentId: "Main",
          status: "running",
          hasSessionFile: false,
          createdAt: 1_500,
          lastActivity: 3_500,
        },
        {
          id: "Reviewer",
          displayName: "Review",
          kind: "sub",
          parentId: "Scout",
          status: "running",
          hasSessionFile: false,
          createdAt: 2_500,
          lastActivity: 3_000,
        },
      ],
    });
    const roster = await phone.next(
      frame => frame.t === "agents" && frame.agents.some(agent => agent.parentAgentId === opened.agentId),
      "subagent roster push",
    );
    if (roster.t !== "agents") throw new Error("expected an agents frame");
    const scout = roster.agents.find(agent => agent.parentAgentId === opened.agentId);
    expect(scout).toMatchObject({
      id: `${opened.agentId}:sub:Scout`,
      name: "Policy Scout",
      state: "busy",
      createdAt: "1970-01-01T00:00:01.500Z",
      lastActiveAt: "1970-01-01T00:00:03.500Z",
    });
    expect(scout?.labels.source).toBe("omp-subagent");
    // A sub of a sub nests under its own parent, not the guest row.
    const reviewer = roster.agents.find(agent => agent.parentAgentId === scout?.id);
    expect(reviewer).toMatchObject({ name: "Review", state: "busy" });

    // A registry id the host stops reporting settles in place, not vanishes.
    await room.send({
      t: "agents",
      agents: [
        {
          id: "Main",
          displayName: "primary",
          kind: "main",
          status: "idle",
          hasSessionFile: true,
          createdAt: 1_000,
          lastActivity: 5_000,
        },
        {
          id: "Scout",
          displayName: "Policy Scout",
          kind: "sub",
          parentId: "Main",
          status: "running",
          hasSessionFile: false,
          createdAt: 1_500,
          lastActivity: 5_000,
        },
      ],
    });
    await phone.next(
      frame =>
        frame.t === "agents" && frame.agents.some(agent => agent.id === reviewer?.id && agent.state === "stopped"),
      "released sub settled",
    );

    // Leaving settles every mirrored sub with the leg.
    phone.send({ t: "collab_leave", sessionId: SESSION_LIVE });
    await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_close");
    await phone.next(
      frame => frame.t === "agents" && frame.agents.some(agent => agent.id === scout?.id && agent.state === "stopped"),
      "sub settled with the leg",
    );
    room.close();
  });

  test("a view-only link refuses every write by name and never sends one", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      // The host's verdict: this peer joined read-only.
      await r.send({
        t: "welcome",
        proto: 3,
        header: { type: "session", id: SESSION_LIVE, timestamp: "t", cwd: "/host" },
        state: HOST_STATE,
        entryCount: 0,
        readOnly: true,
        agents: [],
      });
      await r.send({ t: "snapshot-chunk", final: true, entries: [] });
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });
    const openAsk = await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_open");
    bridge.deliver({
      t: "tui_collab_opened",
      sessionId: SESSION_LIVE,
      requestId: openAsk.requestId as string,
      link: room.viewLink(),
      viewLink: room.viewLink(),
      writable: false,
    });

    const opened = openedFrame(await phone.next(isCollabOpened, "collab_opened (view link)"));
    expect(opened.readOnly).toBe(true);

    phone.send({ t: "prompt", agentId: opened.agentId, text: "should not reach the host" });
    const refusal = await phone.next(isErrorWithCode("collab_refused"), "view-only refusal");
    if (refusal.t !== "error") throw new Error("expected an error frame");
    expect(refusal.reason).toBe("view_only");
    expect(refusal.message).toBe(COLLAB_REFUSAL_REASONS.view_only);
    expect(refusal.agentId).toBe(opened.agentId);

    phone.send({ t: "cancel", agentId: opened.agentId });
    const abortRefusal = await phone.next(
      frame => frame.t === "error" && frame.reason === "view_only",
      "view-only abort refusal",
    );
    void abortRefusal;

    // Nothing but the hello ever reached the room: the daemon refused the
    // writes itself instead of letting the host reject them.
    expect(room.received.filter(frame => frame.t !== "hello")).toEqual([]);
    room.close();
  });

  test("a bridge link that does not parse is an unavailable join, not a guess", async () => {
    const h = await harness();
    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });
    const openAsk = await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_open");
    bridge.deliver({
      t: "tui_collab_opened",
      sessionId: SESSION_LIVE,
      requestId: openAsk.requestId as string,
      link: "definitely not a collab link",
      viewLink: "nor is this",
      writable: true,
    });

    const failure = await phone.next(isErrorWithCode("collab_unavailable"), "unavailable join");
    if (failure.t !== "error") throw new Error("expected an error frame");
    expect(failure.sessionId).toBe(SESSION_LIVE);
    expect(failure.message).toContain("unusable sharing link");
  });

  test("a session with no hosting terminal is refused by name", async () => {
    const h = await harness();
    // Deliberately no bridge leg: nothing live holds the session.
    const phone = await h.connect(await h.pair([SCOPE_READ]));

    // SESSION_LIVE exists in the index but no TUI holds it.
    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });
    const refusal = await phone.next(isErrorWithCode("collab_refused"), "not_hosted refusal");
    if (refusal.t !== "error") throw new Error("expected an error frame");
    expect(refusal.reason).toBe("not_hosted");

    // An id the index has never seen is unknown, not unshared.
    phone.send({ t: "collab_open", sessionId: "019fff0f-0000-7000-0000-00000000dead" });
    const unknown = await phone.next(
      frame => frame.t === "error" && frame.reason === "unknown_session",
      "unknown_session refusal",
    );
    void unknown;
  });

  test("the relay dying mid-session settles the agent row, and the transcript survives", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      await hostWelcomeWithTranscript(r);
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });
    const openAsk = await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_open");
    bridge.deliver({
      t: "tui_collab_opened",
      sessionId: SESSION_LIVE,
      requestId: openAsk.requestId as string,
      link: room.fullLink(),
      viewLink: room.viewLink(),
      writable: true,
    });
    const opened = openedFrame(await phone.next(isCollabOpened, "collab_opened"));
    phone.send({ t: "attach", agentId: opened.agentId, sinceSeq: 0 });
    await phone.next(frame => frame.t === "update", "back-transcript before the drop");

    // The room dies out from under the leg.
    room.closeGuestAsRoomClosed();
    await phone.next(
      frame =>
        frame.t === "agents" && frame.agents.some(agent => agent.id === opened.agentId && agent.state === "stopped"),
      "agent row settled after the drop",
    );

    // The update log outlived the room: a fresh attach still replays the
    // transcript the room delivered before it died.
    phone.send({ t: "detach", agentId: opened.agentId });
    phone.send({ t: "attach", agentId: opened.agentId, sinceSeq: 0 });
    await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("what is in this repo"),
      "transcript survives the drop",
    );

    // And a prompt now names the truth: nothing is co-driving that session.
    phone.send({ t: "prompt", agentId: opened.agentId, text: "anyone there" });
    const failure = await phone.next(
      frame => frame.t === "error" && frame.agentId === opened.agentId,
      "prompt after the drop",
    );
    if (failure.t !== "error") throw new Error("expected an error frame");
    expect(failure.message).toContain("no live host");
    room.close();
  });

  test("a transient relay drop reconnects and the resnapshot duplicates nothing", async () => {
    const h = await harness();
    let joins = 0;
    const room = new RelayRoom(async r => {
      joins += 1;
      await hostWelcomeWithTranscript(r);
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE });
    const openAsk = await waitForBridgeFrame(bridge, frame => frame.t === "tui_collab_open");
    bridge.deliver({
      t: "tui_collab_opened",
      sessionId: SESSION_LIVE,
      requestId: openAsk.requestId as string,
      link: room.fullLink(),
      viewLink: room.viewLink(),
      writable: true,
    });
    const opened = openedFrame(await phone.next(isCollabOpened, "collab_opened"));
    phone.send({ t: "attach", agentId: opened.agentId, sinceSeq: 0 });
    await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("what is in this repo"),
      "back-transcript before the drop",
    );

    // A transport kill, not a room death: the guest reconnects with backoff.
    room.terminateGuest();
    // The reconnect re-hellos (the scripted host re-welcomes), the snapshot
    // re-arrives, and the second copy of each entry must append nothing.
    await waitUntil(() => (joins === 2 ? joins : undefined), "the guest leg's reconnect");
    // Live traffic after the reconnect proves the leg itself recovered, not
    // just the socket underneath it.
    await room.send({ t: "state", state: { ...HOST_STATE, sessionName: "after reconnect" } });
    await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("after reconnect"),
      "host state after reconnect",
    );
    const duplicates = phone.frames.filter(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("what is in this repo"),
    );
    expect(duplicates.length).toBe(1);

    // The leg still steers after the reconnect.
    phone.send({ t: "prompt", agentId: opened.agentId, text: "still here" });
    const prompt = await waitUntil(() => room.received.find(frame => frame.t === "prompt"));
    if (prompt?.t !== "prompt") throw new Error("expected the prompt after reconnect");
    expect(prompt.text).toBe("still here");
    room.close();
  });

  test("collab_open with a link joins directly and streams updates without tui_collab_open", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      await hostWelcomeWithTranscript(r);
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    const phone = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone.send({ t: "collab_open", sessionId: SESSION_LIVE, link: room.fullLink() });

    const opened = openedFrame(await phone.next(isCollabOpened, "collab_opened directly with link"));
    expect(opened.agentId).toMatch(/^agt_/);
    expect(opened.readOnly).toBe(false);

    // Bridge should NOT have received a tui_collab_open frame
    expect(bridge.frames.filter(frame => frame.t === "tui_collab_open")).toEqual([]);

    // The back-transcript is in the update log: attach replays it
    phone.send({ t: "attach", agentId: opened.agentId, sinceSeq: 0 });
    const userChunk = await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("what is in this repo"),
      "replayed user chunk",
    );
    expect(userChunk.t).toBe("update");
    await phone.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("a daemon and a phone app"),
      "replayed assistant chunk",
    );

    room.close();
  });

  test("collab_open with an untrusted relay link is refused", async () => {
    const h = await harness();
    const phone = await h.connect(await h.pair([SCOPE_READ]));

    phone.send({
      t: "collab_open",
      sessionId: SESSION_LIVE,
      link: "wss://evil-relay.attacker.com/r/0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    const refusal = await phone.next(isErrorWithCode("collab_refused"), "untrusted_relay refusal");
    if (refusal.t !== "error") throw new Error("expected an error frame");
    expect(refusal.reason).toBe("untrusted_relay");
    expect(refusal.message).toBe(COLLAB_REFUSAL_REASONS.untrusted_relay);
  });

  test("per-client accounting: one client leaving leaves the leg open; the last client leaving closes it", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      await hostWelcomeWithTranscript(r);
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    void bridge;
    const phone1 = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));
    const phone2 = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone1.send({ t: "collab_open", sessionId: SESSION_LIVE, link: room.fullLink() });
    const opened1 = openedFrame(await phone1.next(isCollabOpened, "phone1 collab_opened"));

    phone2.send({ t: "collab_open", sessionId: SESSION_LIVE, link: room.fullLink() });
    const opened2 = openedFrame(await phone2.next(isCollabOpened, "phone2 collab_opened"));
    expect(opened2.agentId).toBe(opened1.agentId);

    phone1.send({ t: "attach", agentId: opened1.agentId, sinceSeq: 0 });
    phone2.send({ t: "attach", agentId: opened2.agentId, sinceSeq: 0 });

    // Phone 1 leaves
    phone1.send({ t: "collab_leave", sessionId: SESSION_LIVE });

    // Host sends a live state update
    await room.send({ t: "state", state: { ...HOST_STATE, sessionName: "still live for phone 2" } });

    // Phone 2 still receives the update
    await phone2.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("still live for phone 2"),
      "phone2 receives update after phone1 leaves",
    );

    expect(h.store.getAgent(opened1.agentId)?.state).not.toBe("stopped");

    // Phone 2 leaves
    phone2.send({ t: "collab_leave", sessionId: SESSION_LIVE });

    // Now both have left, so the leg closes and agent state becomes stopped
    await waitUntil(() => {
      const agt = h.store.getAgent(opened1.agentId);
      return agt?.state === "stopped" ? agt : undefined;
    }, "agent state stopped after last client leaves");

    room.close();
  });

  test("multi-client echo: a prompt sent through the guest leg appears as a user entry to every attached client", async () => {
    const h = await harness();
    const room = new RelayRoom(async r => {
      await hostWelcomeWithTranscript(r);
    });
    relays.push(room);

    const bridge = await h.registerBridge();
    void bridge;
    const phone1 = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));
    const phone2 = await h.connect(await h.pair([SCOPE_READ, SCOPE_PROMPT]));

    phone1.send({ t: "collab_open", sessionId: SESSION_LIVE, link: room.fullLink() });
    const opened1 = openedFrame(await phone1.next(isCollabOpened, "phone1 collab_opened"));

    phone2.send({ t: "collab_open", sessionId: SESSION_LIVE, link: room.fullLink() });
    const opened2 = openedFrame(await phone2.next(isCollabOpened, "phone2 collab_opened"));

    phone1.send({ t: "attach", agentId: opened1.agentId, sinceSeq: 0 });
    phone2.send({ t: "attach", agentId: opened2.agentId, sinceSeq: 0 });

    phone1.send({ t: "prompt", agentId: opened1.agentId, text: "hello from phone 1" });

    const prompt = await waitUntil(() => room.received.find(f => f.t === "prompt" && f.text === "hello from phone 1"));
    expect(prompt).toBeDefined();

    await room.send({
      t: "entry",
      entry: {
        type: "custom_message",
        customType: COLLAB_PROMPT_MESSAGE_TYPE,
        id: "prompt-echo-1",
        parentId: null,
        timestamp: new Date().toISOString(),
        content: "hello from phone 1",
        display: true,
        details: { from: "ompd" },
      },
    });

    const p1Echo = await phone1.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("hello from phone 1"),
      "phone1 receives echo",
    );
    expect(p1Echo.t).toBe("update");
    const p2Echo = await phone2.next(
      frame => frame.t === "update" && JSON.stringify(frame.update).includes("hello from phone 1"),
      "phone2 receives echo",
    );
    expect(p2Echo.t).toBe("update");

    room.close();
  });
});

// -- helpers -----------------------------------------------------------------

function waitForBridgeFrame(
  bridge: BridgeLeg,
  match: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return waitUntil(() => bridge.frames.find(match), "bridge frame");
}

async function waitUntil<T>(probe: () => T | undefined, label = "condition"): Promise<T> {
  const deadline = Date.now() + SIGNAL_DEADLINE_MS;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    // Real socket traffic crossing two processes: the poll resolves the
    // moment the condition holds, and the sleep only paces re-checks.
    await Bun.sleep(25);
  }
}

/** Narrow a matched frame to the collab open answer, so its agentId is typed. */
function openedFrame(frame: ServerFrame): Extract<ServerFrame, { t: "collab_opened" }> {
  if (frame.t !== "collab_opened") throw new Error(`expected collab_opened, got ${frame.t}`);
  return frame;
}
