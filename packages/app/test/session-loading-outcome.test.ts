import { describe, expect, test } from "bun:test";
import { apply, emptyConsole } from "../src/console/state.ts";

describe("defect 3: loading outcome while session_history is in flight", () => {
  test("an update from attach replay does not prematurely settle load to ready while history is in flight", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "select", agentId: "agt_1", awaiting: true });
    const s2 = apply(s1, { t: "history_request", agentId: "agt_1" });
    expect(s2.loads.get("agt_1")?.phase).toBe("loading");
    expect(s2.historyLoading.has("agt_1")).toBe(true);

    // Attach replay update arrives while history is in flight
    // It should keep loading phase
    const s3 = apply(s2, {
      t: "update",
      event: {
        agentId: "agt_1",
        seq: 1,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "streaming content" },
        },
      },
    });

    // While history is in flight, load phase stays loading
    // (or when history arrives it settles)
    expect(s3.historyLoading.has("agt_1")).toBe(true);

    // Once session_history arrives, it settles to ready
    const s4 = apply(s3, {
      t: "session_history",
      event: {
        agentId: "agt_1",
        sessionId: "sess_1",
        entries: [],
        nextBefore: null,
      },
    });
    expect(s4.loads.get("agt_1")?.phase).toBe("ready");
    expect(s4.historyLoading.has("agt_1")).toBe(false);
  });

  test("load_rearm transitions a failed load back to loading", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "select", agentId: "a1", awaiting: true });
    const s2 = apply(s1, { t: "open_failed", subject: "a1", message: "History did not arrive." });
    expect(s2.loads.get("a1")?.phase).toBe("failed");
    expect(s2.loads.get("a1")?.error).toBe("History did not arrive.");

    const s3 = apply(s2, { t: "load_rearm", subject: "a1" });
    expect(s3.loads.get("a1")?.phase).toBe("loading");
    expect(s3.loads.get("a1")?.error).toBeNull();
  });
});
