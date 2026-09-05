import { describe, expect, test } from "bun:test";
import { apply, emptyConsole } from "../src/console/state.ts";
import type { AgentId } from "@ompd/core/contracts";

describe("item 1: eviction drops markers that suppress replay/history", () => {
  test("evicting least-recent session also drops its watermark and historyBefore", () => {
    let state = emptyConsole([]);

    // Populate 10 sessions with watermarks and historyBefore
    for (let i = 1; i <= 10; i++) {
      const agentId = `agt_${i}` as AgentId;
      state = apply(state, {
        t: "session_history",
        event: {
          agentId,
          sessionId: `sess_${i}`,
          entries: [{ kind: "user", id: `u_${i}`, text: `hello ${i}`, at: "2026-09-05T00:00:00.000Z" }],
          nextBefore: 100,
        },
      });
      state = apply(state, {
        t: "update",
        event: {
          agentId,
          seq: 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `hi ${i}` },
          },
        },
      });
    }

    // Sessions are capped at 8: agt_1 and agt_2 were evicted
    expect(state.sessions.has("agt_1" as AgentId)).toBe(false);
    expect(state.sessions.has("agt_2" as AgentId)).toBe(false);
    expect(state.watermarks.has("agt_1" as AgentId)).toBe(false);
    expect(state.historyBefore.has("agt_1" as AgentId)).toBe(false);
  });

  test("item 9: phantom selections without sessions do not evict resident sessions", () => {
    let state = emptyConsole([]);
    // Populate 8 resident sessions
    for (let i = 1; i <= 8; i++) {
      state = apply(state, {
        t: "update",
        event: {
          agentId: `res_${i}` as AgentId,
          seq: 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `hi ${i}` },
          },
        },
      });
    }
    expect(state.sessions.size).toBe(8);

    // Select 5 phantom agents that never create a session
    for (let i = 1; i <= 5; i++) {
      state = apply(state, {
        t: "select",
        agentId: `phantom_${i}` as AgentId,
      });
    }

    // Now add 9th resident session. Total resident sessions = 9 > 8.
    state = apply(state, {
      t: "update",
      event: {
        agentId: "res_9" as AgentId,
        seq: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi 9" },
        },
      },
    });

    // Pre-fix failure: phantom selections consumed keep quota, evicting multiple resident sessions!
    // Expected: exactly res_1 (oldest resident) is evicted, res_2 through res_9 are kept.
    expect(state.sessions.has("res_1" as AgentId)).toBe(false);
    for (let i = 2; i <= 9; i++) {
      expect(state.sessions.has(`res_${i}` as AgentId)).toBe(true);
    }
    expect(state.sessions.size).toBe(8);
  });
});
