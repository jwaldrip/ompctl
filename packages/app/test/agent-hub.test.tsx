import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { AgentHub, agentHubEmptyReason, agentHubTree } = await import("../src/components/AgentHub.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const createdAt = "2026-08-13T08:00:00.000Z";
const host = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };
const agents: Agent[] = [
  {
    id: "agt_main",
    name: "Primary",
    state: "busy",
    host,
    cwd: "/workspace",
    createdAt,
    lastActiveAt: createdAt,
    labels: {},
  },
  {
    id: "agt_scout",
    name: "Policy Scout",
    state: "idle",
    host,
    cwd: "/workspace",
    createdAt: "2026-08-13T08:01:00.000Z",
    lastActiveAt: createdAt,
    parentAgentId: "agt_main",
    taskTitle: "Inspect the permission path",
    model: "anthropic/claude-sonnet-5",
    metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
    labels: { source: "omp-subagent" },
  },
  {
    id: "agt_reviewer",
    name: "Review",
    state: "waiting",
    host,
    cwd: "/workspace",
    createdAt: "2026-08-13T08:02:00.000Z",
    lastActiveAt: createdAt,
    parentAgentId: "agt_scout",
    taskTitle: "Check authorization edges",
    model: "openai/gpt-5.4",
    metrics: { usedTokens: 240, durationMs: 5_000 },
    labels: { source: "omp-subagent" },
  },
];

/** One roster row, with the two fields the empty state classifies on. */
function rosterAgent(id: string, state: Agent["state"], source?: string): Agent {
  return {
    id,
    name: id,
    state,
    host,
    cwd: "/workspace",
    createdAt,
    lastActiveAt: createdAt,
    labels: source === undefined ? {} : { source },
  };
}

function renderHub(roster: Agent[]) {
  const hostElement = document.createElement("div");
  document.body.appendChild(hostElement);
  const root = createRoot(hostElement);
  act(() => {
    root.render(<AgentHub agents={roster} onOpen={() => undefined} />);
  });
  return { host: hostElement, root };
}

describe("agentHubTree", () => {
  test("carries assignment, model, runtime, and cost through the nested tree", () => {
    const [primary] = agentHubTree(agents);
    const scout = primary?.children[0]?.agent;
    const reviewer = primary?.children[0]?.children[0]?.agent;

    expect(scout).toMatchObject({
      name: "Policy Scout",
      taskTitle: "Inspect the permission path",
      model: "anthropic/claude-sonnet-5",
      metrics: { usedTokens: 1_560, costAmount: 0.024, durationMs: 91_000 },
    });
    expect(reviewer).toMatchObject({
      name: "Review",
      taskTitle: "Check authorization edges",
      model: "openai/gpt-5.4",
      metrics: { usedTokens: 240, durationMs: 5_000 },
    });
  });

  test("builds a parent-child tree from flat daemon events", () => {
    const [primary] = agentHubTree(agents);
    expect(primary?.agent.id).toBe("agt_main");
    expect(primary?.children[0]?.agent.id).toBe("agt_scout");
    expect(primary?.children[0]?.children[0]?.agent.id).toBe("agt_reviewer");
  });

  test("the component's own filter keeps main agents out of the tree", () => {
    // The exact filter AgentHub applies to the roster it is handed; main
    // agents belong to the Fleet row, never to this tree.
    const subagentsOnly = agents.filter(agent => agent.parentAgentId !== undefined);
    const roots = agentHubTree(subagentsOnly);

    expect(roots.map(node => node.agent.id)).toEqual(["agt_scout"]);
    expect(roots[0]?.children[0]?.agent.id).toBe("agt_reviewer");
  });
});

describe("agentHubEmptyReason", () => {
  test("an empty roster and a roster with nothing live both render nothing", () => {
    expect(agentHubEmptyReason([])).toBeNull();
    expect(agentHubEmptyReason([rosterAgent("agt_dead", "stopped"), rosterAgent("agt_gone", "failed")])).toBeNull();
  });

  test("live sessions and nothing shared is the unshared reason", () => {
    expect(agentHubEmptyReason([rosterAgent("agt_owned", "busy")])).toBe("unshared");
  });

  test("a co-driven session with no subagents is the shared-quiet reason", () => {
    expect(agentHubEmptyReason([rosterAgent("agt_guest", "idle", "collab-guest")])).toBe("sharedQuiet");
  });

  test("a co-driven session alongside owned ones names both causes", () => {
    expect(
      agentHubEmptyReason([rosterAgent("agt_guest", "busy", "collab-guest"), rosterAgent("agt_owned", "idle")]),
    ).toBe("sharedQuietWithOwned");
  });

  test("a stopped co-driven row does not count as shared", () => {
    expect(agentHubEmptyReason([rosterAgent("agt_guest", "stopped", "collab-guest")])).toBeNull();
  });
});

describe("AgentHub empty state", () => {
  test("nothing live renders no block at all", () => {
    const { host, root } = renderHub([]);
    expect(host.querySelector('[data-testid="agent-hub"]')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  test("an unshared roster says why nothing appears, verbatim", () => {
    const { host, root } = renderHub([rosterAgent("agt_owned", "busy")]);
    const empty = host.querySelector('[data-testid="agent-hub-empty"]');
    expect(empty?.textContent).toBe(
      "Subagents appear for a session whose operator has shared it with this daemon; nothing appears for one nobody has.",
    );
    act(() => root.unmount());
    host.remove();
  });

  test("a shared roster with no subagents says so", () => {
    const { host, root } = renderHub([rosterAgent("agt_guest", "idle", "collab-guest")]);
    expect(host.querySelector('[data-testid="agent-hub-empty"]')?.textContent).toBe(
      "Shared sessions report no subagents.",
    );
    act(() => root.unmount());
    host.remove();
  });

  test("a mixed roster names the owned sessions' missing feed", () => {
    const { host, root } = renderHub([
      rosterAgent("agt_guest", "busy", "collab-guest"),
      rosterAgent("agt_owned", "idle"),
    ]);
    expect(host.querySelector('[data-testid="agent-hub-empty"]')?.textContent).toBe(
      "Shared sessions report no subagents; sessions this daemon owns have no subagent feed.",
    );
    act(() => root.unmount());
    host.remove();
  });

  test("a roster with subagents renders the tree, not the empty state", () => {
    const { host, root } = renderHub(agents);
    expect(host.querySelector('[data-testid="agent-hub-empty"]')).toBeNull();
    expect(host.querySelector('[data-testid="agent-hub-agt_scout"]')).not.toBeNull();
    expect(host.textContent).toContain("Policy Scout");
    act(() => root.unmount());
    host.remove();
  });
});
