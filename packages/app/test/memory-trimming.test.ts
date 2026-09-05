import { describe, expect, test } from "bun:test";
import { apply, emptyConsole } from "../src/console/state.ts";
import { appendPrompt, EMPTY_SESSION } from "../src/session/model.ts";
import type { AgentId } from "@ompd/core/contracts";

describe("defect 7: memory bounds", () => {
  test("deselected sessions beyond the most recent 8 are dropped from state.sessions while keeping watermarks", () => {
    let state = emptyConsole([]);

    // Open and stream 10 different sessions
    for (let i = 1; i <= 10; i++) {
      const agentId = `agt_${i}` as AgentId;
      state = apply(state, { t: "select", agentId, awaiting: false });
      state = apply(state, {
        t: "update",
        event: {
          agentId,
          seq: i * 10,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `turn ${i}` } },
        },
      });
    }

    // Pre-fix: state.sessions holds all 10 sessions!
    expect(state.sessions.size).toBeLessThanOrEqual(8);

    // But all 10 watermarks must be preserved so re-attach replays correctly
    expect(state.watermarks.size).toBe(10);
    for (let i = 1; i <= 10; i++) {
      expect(state.watermarks.has(`agt_${i}` as AgentId)).toBe(true);
    }
  });

  test("session.entries growth is capped by trimming to newest 2,000 entries with trimmed flag", () => {
    let session = EMPTY_SESSION;

    // Append 2,000 entries -> exactly at boundary, not trimmed
    for (let i = 1; i <= 2000; i++) {
      session = appendPrompt(session, `prompt ${i}`);
    }
    expect(session.entries.length).toBe(2000);
    expect(session.trimmed).toBeFalsy();

    // Append 2,001st entry -> trims to newest 2,000 entries and sets trimmed: true
    session = appendPrompt(session, "prompt 2001");

    // Pre-fix failure: entries length was 2001, trimmed was undefined
    expect(session.entries.length).toBe(2000);
    expect(session.trimmed).toBe(true);
    expect((session.entries[0] as any).text).toBe("prompt 2");
    expect((session.entries[1999] as any).text).toBe("prompt 2001");
  });
});
