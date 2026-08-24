import { describe, expect, test } from "bun:test";
import { apply } from "../src/console/state.ts";
import { sessionFor } from "../src/console/state.ts";
import { emptyConsole } from "../src/console/state.ts";
import type { Agent } from "@ompd/core/contracts";

// Helper to create minimal agent for testing
function agent(id: string): Agent {
  return {
    id,
    name: `Agent ${id}`,
    state: "running",
    attempts: 1,
  } as Agent;
}

// Helper to create session update
function turn(agentId: string) {
  return [
    { t: "transcript", event: { agentId, update: { kind: "text", channel: "message", text: "Hello from " + agentId } } },
  ];
}

describe("app session navigation - RN app loading state", () => {
  test("selecting a session immediately clears stale entries before new data arrives", () => {
    let state = emptyConsole();
    
    // Agent A is selected and gets entries
    state = apply(state, { t: "agents", event: { agents: [agent("a1"), agent("a2")] } });
    state = apply(state, { t: "select", agentId: "a1" });
    for (const evt of turn("a1")) state = apply(state, evt);
    
    // Verify A has entries
    const sessionA = sessionFor(state, "a1");
    expect(sessionA.entries.length).toBeGreaterThan(0);
    
    // Switch to B (previously empty, just got created)
    state = apply(state, { t: "select", agentId: "a2" });
    
    // B should start empty even if it had entries before
    const sessionB = sessionFor(state, "a2");
    expect(sessionB.entries.length).toBe(0);
  });

  test("switching A->B->C prevents late B data from overwriting C", () => {
    let state = emptyConsole();
    
    state = apply(state, { t: "agents", event: { agents: [agent("a1"), agent("a2"), agent("a3")] } });
    
    // Open A with entries
    state = apply(state, { t: "select", agentId: "a1" });
    for (const evt of turn("a1")) state = apply(state, evt);
    let sessionA = sessionFor(state, "a1");
    const aEntryCount = sessionA.entries.length;
    expect(aEntryCount).toBeGreaterThan(0);
    
    // Switch to B - should be empty
    state = apply(state, { t: "select", agentId: "a2" });
    let sessionB = sessionFor(state, "a2");
    expect(sessionB.entries.length).toBe(0);
    
    // Switch to C - should be empty
    state = apply(state, { t: "select", agentId: "a3" });
    let sessionC = sessionFor(state, "a3");
    expect(sessionC.entries.length).toBe(0);
    
    // Now B gets data (late arriving)
    for (const evt of turn("a2")) state = apply(state, evt);
    sessionB = sessionFor(state, "a2");
    const bEntryCount = sessionB.entries.length;
    expect(bEntryCount).toBeGreaterThan(0);
    
    // C should still be empty, not showing B's content
    sessionC = sessionFor(state, "a3");
    expect(sessionC.entries.length).toBe(0);
    
    // B should have its content
    sessionB = sessionFor(state, "a2");
    expect(sessionB.entries.length).toBe(bEntryCount);
  });

  test("session failure does not restore previous session content", () => {
    let state = emptyConsole();
    
    state = apply(state, { t: "agents", event: { agents: [agent("a1"), agent("a2")] } });
    
    // A has entries
    state = apply(state, { t: "select", agentId: "a1" });
    for (const evt of turn("a1")) state = apply(state, evt);
    const sessionA = sessionFor(state, "a1");
    expect(sessionA.entries.length).toBeGreaterThan(0);
    
    // Switch to B
    state = apply(state, { t: "select", agentId: "a2" });
    let sessionB = sessionFor(state, "a2");
    expect(sessionB.entries.length).toBe(0);
    
    // If B later fails or stays empty (no data arrives), it should not show A's content
    state = apply(state, { t: "select", agentId: "a2" });
    sessionB = sessionFor(state, "a2");
    expect(sessionB.entries.length).toBe(0);
  });

  test("re-selecting same session does not clear if already selected", () => {
    let state = emptyConsole();
    
    state = apply(state, { t: "agents", event: { agents: [agent("a1")] } });
    
    // Select A
    state = apply(state, { t: "select", agentId: "a1" });
    
    // Give it entries
    for (const evt of turn("a1")) state = apply(state, evt);
    let sessionA = sessionFor(state, "a1");
    const entryCount = sessionA.entries.length;
    expect(entryCount).toBeGreaterThan(0);
    
    // Re-select A (double tap) - should NOT clear since it's already selected
    state = apply(state, { t: "select", agentId: "a1" });
    sessionA = sessionFor(state, "a1");
    // Entries should be preserved
    expect(sessionA.entries.length).toBe(entryCount);
  });
});
