import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic on purpose, the same reason `nav-shell.test.tsx` states: bun
// evaluates a file's whole static import graph before its body runs, so a
// static import of anything that reaches `react-native` would pull the real
// package in before `./rnw.ts` could substitute `react-native-web` for it.
const {
  AGENT_STATE_TO_COLUMN,
  columnForAgent,
  SubagentBoard,
} = await import("../src/components/SubagentBoard.tsx");
const { SUBAGENT_UNOPENABLE } = await import("../src/components/AgentHub.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetWindowSize();
});

const HOST = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };
const NOW = Date.parse("2026-09-07T12:00:00.000Z");

function subagent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    state: "busy",
    host: HOST,
    cwd: "/workspace",
    createdAt: "2026-09-07T11:00:00.000Z",
    lastActiveAt: "2026-09-07T11:58:00.000Z",
    labels: { source: "omp-subagent" },
    acpSessionId: `sess_${id}`,
    ...overrides,
  };
}

interface Mounted {
  host: HTMLElement;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  unmount: () => void;
}

function mount(node: ReactNode): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  return {
    host,
    el,
    press: (testID: string) => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("AGENT_STATE_TO_COLUMN mapping table", () => {
  test("explicitly maps every AgentState across all seven contracts", () => {
    expect(AGENT_STATE_TO_COLUMN).toEqual({
      waiting: "needsYou",
      failed: "needsYou",
      busy: "working",
      provisioning: "working",
      starting: "working",
      idle: "idle",
      stopped: "done",
    });
  });

  test("columnForAgent handles clearance override and state fallback", () => {
    const idleAgent = subagent("agt_idle", { state: "idle" });
    expect(columnForAgent(idleAgent)).toBe("idle");
    expect(columnForAgent(idleAgent, () => true)).toBe("needsYou");
  });
});

describe("SubagentBoard", () => {
  const fiveSubagents: Agent[] = [
    subagent("agt_waiting", {
      name: "Approval Gate",
      taskTitle: "Review permissions before migration",
      state: "waiting",
    }),
    subagent("agt_failed", {
      name: "Config Writer",
      taskTitle: "Write system daemon config",
      state: "failed",
      failure: "Permission denied writing /etc/ompd.conf",
    }),
    subagent("agt_busy", {
      name: "Database Worker",
      taskTitle: "Refactor slow customer queries",
      state: "busy",
      model: "anthropic/claude-sonnet-5",
    }),
    subagent("agt_idle", {
      name: "PR Reviewer",
      taskTitle: "Audit incoming code changes",
      state: "idle",
    }),
    subagent("agt_stopped", {
      name: "Linter",
      taskTitle: "Run static analyzer across repository",
      state: "stopped",
      metrics: { usedTokens: 4200, costAmount: 0.0125, durationMs: 45000 },
    }),
  ];

  test("a fixture with five subagents across states renders the right columns and counts", () => {
    const opened: Agent[] = [];
    const view = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={agent => opened.push(agent)}
      />,
    );
    try {
      expect(view.el("subagent-board-column-needsYou")).not.toBeNull();
      expect(view.el("subagent-board-count-needsYou")?.textContent).toBe("2");

      expect(view.el("subagent-board-column-working")).not.toBeNull();
      expect(view.el("subagent-board-count-working")?.textContent).toBe("1");

      expect(view.el("subagent-board-column-idle")).not.toBeNull();
      expect(view.el("subagent-board-count-idle")?.textContent).toBe("1");

      expect(view.el("subagent-board-column-done")).not.toBeNull();
      expect(view.el("subagent-board-count-done")?.textContent).toBe("1");

      expect(view.host.textContent).toContain("Review permissions before migration");
      expect(view.host.textContent).toContain("Write system daemon config");
      expect(view.host.textContent).toContain("Refactor slow customer queries");
      expect(view.host.textContent).toContain("Audit incoming code changes");
      expect(view.host.textContent).toContain("Run static analyzer across repository");
    } finally {
      view.unmount();
    }
  });

  test("a failed subagent shows its failure sentence", () => {
    const view = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      const failureEl = view.el("subagent-card-failure-agt_failed");
      expect(failureEl).not.toBeNull();
      expect(failureEl?.textContent).toBe("Permission denied writing /etc/ompd.conf");
    } finally {
      view.unmount();
    }
  });

  test("tap calls onOpenSubagent with the id", () => {
    const opened: string[] = [];
    const view = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={agent => opened.push(agent.id)}
      />,
    );
    try {
      view.press("subagent-card-open-agt_busy");
      expect(opened).toEqual(["agt_busy"]);

      view.press("subagent-card-open-agt_failed");
      expect(opened).toEqual(["agt_busy", "agt_failed"]);
    } finally {
      view.unmount();
    }
  });

  test("an empty column is absent", () => {
    // Only working and done agents: needsYou and idle must be completely absent.
    const subset: Agent[] = [
      subagent("agt_work", { state: "busy", taskTitle: "Doing work" }),
      subagent("agt_complete", { state: "stopped", taskTitle: "Work done" }),
    ];
    const view = mount(
      <SubagentBoard
        agents={subset}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      expect(view.el("subagent-board-column-working")).not.toBeNull();
      expect(view.el("subagent-board-column-done")).not.toBeNull();

      expect(view.el("subagent-board-column-needsYou")).toBeNull();
      expect(view.el("subagent-board-column-idle")).toBeNull();
      expect(view.host.textContent).not.toContain("Needs you");
      expect(view.host.textContent).not.toContain("Idle");
      expect(view.el("subagent-board-count-needsYou")).toBeNull();
      expect(view.el("subagent-board-count-idle")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("cost only appears when metrics carry costAmount", () => {
    const view = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      expect(view.host.textContent).toContain("cost 0.0125");
      expect(view.host.textContent).not.toContain("cost 0.0000");
    } finally {
      view.unmount();
    }
  });

  test("shows model when known and elapsed since lastActiveAt", () => {
    const view = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      expect(view.host.textContent).toContain("anthropic/claude-sonnet-5");
      expect(view.host.textContent).toContain("2:00");
    } finally {
      view.unmount();
    }
  });

  test("an unopenable subagent renders explanation instead of open control", () => {
    const unopenable = subagent("agt_mirror", {
      name: "Mirror Agent",
      taskTitle: "Collab mirror without session",
      acpSessionId: undefined,
    });
    const view = mount(
      <SubagentBoard
        agents={[unopenable]}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      expect(view.el("subagent-card-open-agt_mirror")).toBeNull();
      expect(view.el("subagent-card-row-agt_mirror")).not.toBeNull();
      expect(view.el("subagent-card-unopenable-agt_mirror")?.textContent).toBe(SUBAGENT_UNOPENABLE);
    } finally {
      view.unmount();
    }
  });

  test("tablet renders a row of columns; phone renders a horizontal scroll", () => {
    // Phone layout
    setWindowSize(390, 844);
    const phoneView = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      expect(phoneView.el("subagent-board-phone")).not.toBeNull();
      expect(phoneView.el("subagent-board-tablet")).toBeNull();
    } finally {
      phoneView.unmount();
    }

    // Tablet layout
    setWindowSize(1024, 1366);
    const tabletView = mount(
      <SubagentBoard
        agents={fiveSubagents}
        now={NOW}
        onOpenSubagent={() => {}}
      />,
    );
    try {
      expect(tabletView.el("subagent-board-tablet")).not.toBeNull();
      expect(tabletView.el("subagent-board-phone")).toBeNull();
    } finally {
      tabletView.unmount();
    }
  });
});
