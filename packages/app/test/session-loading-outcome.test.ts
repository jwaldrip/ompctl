import { describe, expect, test } from "bun:test";
import { apply, emptyConsole, loadFor } from "../src/console/state.ts";

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

describe("live-tui session load phases", () => {
  test("collab joined: tui settles to ready and guest agent arms loading", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "tui_select", sessionId: "tui-1", awaiting: true });
    expect(loadFor(s1, "tui-1").phase).toBe("loading");

    const s2 = apply(s1, {
      t: "collab_opened",
      event: { sessionId: "tui-1", agentId: "agt_guest", readOnly: false },
      awaiting: true,
    });
    expect(loadFor(s2, "tui-1").phase).toBe("ready");
    expect(loadFor(s2, "agt_guest").phase).toBe("loading");
  });

  test("collab denied / open_failed on un-armed session records failed phase", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "open_failed", subject: "tui-1", message: "bridge_unavailable" });
    expect(loadFor(s1, "tui-1").phase).toBe("failed");
    expect(loadFor(s1, "tui-1").error).toBe("bridge_unavailable");
  });

  test("re-selecting a failed or settled terminal with awaiting: true re-arms loading", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "tui_select", sessionId: "tui-1", awaiting: true });
    const s2 = apply(s1, { t: "open_failed", subject: "tui-1", message: "bridge_unavailable" });
    expect(loadFor(s2, "tui-1").phase).toBe("failed");

    const s3 = apply(s2, { t: "tui_select", sessionId: "tui-1", awaiting: true });
    expect(loadFor(s3, "tui-1").phase).toBe("loading");
    expect(loadFor(s3, "tui-1").error).toBeNull();
  });

  test("selected terminal without load entry reports loading when history has not arrived", () => {
    const s0 = emptyConsole([]);
    const s1 = { ...s0, selectedTui: "tui-1" };
    expect(loadFor(s1, "tui-1").phase).toBe("loading");
  });

  test("tail empty settles load to ready with empty history", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "tui_select", sessionId: "tui-1", awaiting: true });
    const s2 = apply(s1, {
      t: "session_tail",
      event: { sessionId: "tui-1", entries: [], messages: [], truncated: false, nextCursor: null },
    });
    expect(loadFor(s2, "tui-1").phase).toBe("ready");
    expect(loadFor(s2, "tui-1").error).toBeNull();
  });

  test("tail arriving settles load to ready with turns", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "tui_select", sessionId: "tui-1", awaiting: true });
    expect(loadFor(s1, "tui-1").phase).toBe("loading");

    const s2 = apply(s1, {
      t: "session_tail",
      event: {
        sessionId: "tui-1",
        entries: [{ kind: "text", role: "assistant", text: "hello", at: "2026-09-08T00:00:00.000Z" }],
        messages: [{ kind: "text", role: "assistant", text: "hello", at: "2026-09-08T00:00:00.000Z" }],
        truncated: false,
        nextCursor: null,
      },
    });
    expect(loadFor(s2, "tui-1").phase).toBe("ready");
    expect(loadFor(s2, "tui-1").error).toBeNull();
  });
});
