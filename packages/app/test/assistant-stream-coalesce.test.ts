import { describe, expect, test } from "bun:test";
import { apply, emptyConsole } from "../src/console/state.ts";
import type { Agent } from "@ompd/core/contracts";

const HOST = { kind: "local" as const, id: "0", spec: { kind: "local" as const } };

function makeAgent(id: string, state: "idle" | "busy" = "idle"): Agent {
  return {
    id,
    name: `Agent ${id}`,
    state,
    host: HOST,
    cwd: "/tmp",
    createdAt: "2026-09-05T00:00:00.000Z",
    lastActiveAt: "2026-09-05T00:00:00.000Z",
    labels: {},
  };
}

describe("item 12: assistant reply chunks with rotating ids must coalesce into one row", () => {
  test("replay under idle roster: multiple chunks coalesce and non-chunk frame closes stream", () => {
    let state = emptyConsole([]);
    // 1. Roster arrives with agent in idle state
    state = apply(state, {
      t: "agents",
      event: { agents: [makeAgent("a1", "idle")] },
    });
    state = apply(state, { t: "select", agentId: "a1" });

    // 2. Replay chunk id A: "port"
    state = apply(state, {
      t: "update",
      event: {
        agentId: "a1",
        seq: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_chunk_A",
          content: { type: "text", text: "port" },
        },
      },
    });

    // 3. Replay chunk id B: "al_mtotb2v"
    state = apply(state, {
      t: "update",
      event: {
        agentId: "a1",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_chunk_B",
          content: { type: "text", text: "al_mtotb2v" },
        },
      },
    });

    // 4. Replay chunk id B: "c"
    state = apply(state, {
      t: "update",
      event: {
        agentId: "a1",
        seq: 3,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_chunk_B",
          content: { type: "text", text: "c" },
        },
      },
    });

    // 5. Replay non-chunk frame (usage_update) settles stream
    state = apply(state, {
      t: "update",
      event: {
        agentId: "a1",
        seq: 4,
        update: {
          sessionUpdate: "usage_update",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      },
    });

    const session = state.sessions.get("a1");
    expect(session).toBeDefined();

    const assistants = session?.entries.filter(e => e.kind === "assistant") ?? [];
    // Pre-fix failure: assistants has length 2 (["port", "al_mtotb2vc"]) because endTurn ran after chunk A!
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("portal_mtotb2vc");
    expect((assistants[0] as any)?.streaming).toBe(false);
  });

  test("live order: chunk A arrives before busy roster frame, chunk B coalesces", () => {
    let state = emptyConsole([]);
    // Agent is initially known as idle
    state = apply(state, {
      t: "agents",
      event: { agents: [makeAgent("a1", "idle")] },
    });
    state = apply(state, { t: "select", agentId: "a1" });

    // Live chunk A arrives before any busy roster frame lands
    state = apply(state, {
      t: "update",
      event: {
        agentId: "a1",
        seq: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_A",
          content: { type: "text", text: "P" },
        },
      },
    });

    // Live chunk B arrives
    state = apply(state, {
      t: "update",
      event: {
        agentId: "a1",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_B",
          content: { type: "text", text: "ORTAL-X" },
        },
      },
    });

    const session = state.sessions.get("a1");
    const assistants = session?.entries.filter(e => e.kind === "assistant") ?? [];
    // Pre-fix failure: assistants has length 2 (["P", "ORTAL-X"]) because idle-roster check closed stream after chunk A!
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.text).toBe("PORTAL-X");
  });
});
