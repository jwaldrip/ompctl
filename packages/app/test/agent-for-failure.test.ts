import { describe, expect, test } from "bun:test";
import { agentFor, apply, emptyConsole } from "../src/console/state.ts";

describe("item 11: agentFor returns null only on explicit gone evidence", () => {
  test("a dormant open that hits history deadline keeps stand-in agent so SessionLoadFailed renders", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "select", agentId: "agt_dormant", awaiting: true });
    // Timeout or generic error fails the load
    const s2 = apply(s1, {
      t: "open_failed",
      subject: "agt_dormant",
      message: "The daemon took too long to answer this session.",
    });

    expect(s2.loads.get("agt_dormant")?.phase).toBe("failed");
    expect(s2.loads.get("agt_dormant")?.error).toBe("The daemon took too long to answer this session.");

    // Pre-fix failure: agentFor returned null, rendering "That session closed." and hiding Retry!
    const agent = agentFor(s2, "agt_dormant");
    expect(agent).not.toBeNull();
    expect(agent?.id).toBe("agt_dormant");
  });

  test("explicit gone evidence (session_gone or roster misses after settle) returns null", () => {
    const s0 = emptyConsole([]);
    const s1 = apply(s0, { t: "select", agentId: "agt_dormant", awaiting: true });
    const s2 = apply(s1, {
      t: "open_failed",
      subject: "agt_dormant",
      message: "session_gone",
    });

    expect(agentFor(s2, "agt_dormant")).toBeNull();
  });
});
