/**
 * The session's own context, above its transcript.
 *
 * Two layers, because two different things can break. The pure grouping and
 * the panel are driven directly, so a todo's phase, its state, and its blocker
 * are asserted against exactly the entries a producer sent. The identity rules
 * go through the real `Console` over a canned socket, because "session B never
 * shows session A's subagents" is a claim about the composition, and a panel
 * rendered in isolation cannot make it.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent, AgentId } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { rhythm } from "../src/design/rhythm.ts";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import type { PlanEntry, SessionState } from "../src/session/model.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic on purpose, the same reason `nav-shell.test.tsx` states: bun
// evaluates a file's whole static import graph before its body runs, so a
// static import of anything that reaches `react-native` would pull the real
// package in before `./rnw.ts` could substitute `react-native-web` for it.
const { SessionContext, todoPhases, todoProgress, TODO_ABSENT_WHILE_BUSY } = await import(
  "../src/components/SessionContext.tsx"
);
const { EMPTY_SESSION, reduce } = await import("../src/session/model.ts");
const { Console } = await import("../src/console/Console.tsx");
const { SUBAGENT_UNOPENABLE } = await import("../src/components/AgentHub.tsx");
const { StyleSheet } = await import("react-native");
const { WithOmpTheme } = await import("./theme.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetWindowSize();
});

const HOST = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };
const NOW = Date.parse("2026-08-24T12:00:00.000Z");

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    state: "busy",
    host: HOST,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActiveAt: "2026-08-24T11:59:00.000Z",
    labels: {},
    ...overrides,
  };
}

/** A session whose reducer has already folded one `plan` update. */
function sessionWithPlan(entries: readonly Record<string, unknown>[]): SessionState {
  return reduce(EMPTY_SESSION, { sessionUpdate: "plan", entries });
}

interface Mounted {
  host: HTMLElement;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  render: (node: ReactNode) => void;
  unmount: () => void;
}

function mount(node: ReactNode): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // Wrapped the way `App.tsx` wraps the whole console: Paper's own components
  // read their palette, faces and radii from the provider, and a panel
  // rendered without one is a different surface from the one that ships.
  act(() => {
    root.render(<WithOmpTheme>{node}</WithOmpTheme>);
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
    render: next => {
      act(() => {
        root.render(<WithOmpTheme>{next}</WithOmpTheme>);
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

function panel(options: {
  session?: SessionState;
  agents?: readonly Agent[];
  subject?: Agent;
  origin?: "owned" | "co-driven" | "watching";
  opened?: Agent[];
  defaultOpen?: boolean;
}) {
  const subject = options.subject ?? agent("agt_main");
  const opened = options.opened ?? [];
  return (
    <SessionContext
      agent={subject}
      agents={options.agents ?? [subject]}
      defaultOpen={options.defaultOpen ?? true}
      now={NOW}
      onOpenSubagent={next => opened.push(next)}
      origin={options.origin ?? "owned"}
      session={options.session ?? EMPTY_SESSION}
    />
  );
}

/**
 * `getSheet` is a react-native-web extension the package's own web build
 * publishes and its types do not. Same cast `composer-actions.test.tsx` makes,
 * for the same reason: a static `StyleSheet` value compiles to an atomic class
 * whose declaration lives in one injected sheet rather than in the markup.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/**
 * The declarations an element actually carries, from BOTH places RNW puts them.
 *
 * Registered `StyleSheet` values arrive as classes in the injected sheet;
 * anything computed at render time -- a row's own indent, which is its depth
 * times one step -- is written inline instead. Reading either half alone makes
 * a real measurement read as `undefined`, so this merges them and lets inline
 * win, which is what the cascade does.
 */
function declarationsFor(element: HTMLElement): Map<string, string> {
  const classes = element.className.split(/\s+/).filter(name => name.length > 0);
  const out = new Map<string, string>();
  const take = (text: string): void => {
    for (const declaration of text.matchAll(/([a-z-]+):\s*([^;]+);/gi)) {
      const property = declaration[1];
      const value = declaration[2];
      if (property === undefined || value === undefined) continue;
      out.set(property.toLowerCase(), value.replaceAll(" ", "").trim());
    }
  };
  for (const rule of rnwStyleSheet.getSheet().textContent.split("\n")) {
    if (!classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule))) continue;
    take(rule);
  }
  const inline = element.getAttribute("style");
  if (inline !== null) take(inline.endsWith(";") ? inline : `${inline};`);
  return out;
}

/** One measurement off an element, in points, or null when it declares none. */
function points(element: HTMLElement, property: string): number | null {
  const written = declarationsFor(element).get(property);
  return written === undefined ? null : Number.parseFloat(written);
}

// ---------------------------------------------------------------------------
// Grouping and progress, against the exact entries a producer sends
// ---------------------------------------------------------------------------

describe("todo grouping", () => {
  test("consecutive runs of one phase group together and keep the writer's order", () => {
    const plan: PlanEntry[] = [
      { content: "Read the contracts", priority: "medium", status: "completed", phase: "Audit" },
      { content: "Trace the reducer", priority: "medium", status: "in_progress", phase: "Audit" },
      { content: "Wire the panel", priority: "medium", status: "pending", phase: "Build" },
      // The same heading reappearing later is a second place in the document,
      // never a group to merge back into the first: merging would reorder the
      // operator's own list to make it tidier.
      { content: "Re-audit", priority: "medium", status: "pending", phase: "Audit" },
    ];
    expect(todoPhases(plan).map(phase => [phase.name, phase.todos.length])).toEqual([
      ["Audit", 2],
      ["Build", 1],
      ["Audit", 1],
    ]);
  });

  test("a producer that sends no phases yields one unnamed group, not a phase called nothing", () => {
    const plan: PlanEntry[] = [
      { content: "Ship it", priority: "medium", status: "pending" },
      { content: "Prove it", priority: "medium", status: "pending" },
    ];
    expect(todoPhases(plan)).toEqual([{ name: null, todos: plan }]);
  });

  test("dropped work is settled but never counted as done", () => {
    const plan: PlanEntry[] = [
      { content: "a", priority: "medium", status: "completed" },
      { content: "b", priority: "medium", status: "abandoned" },
      { content: "c", priority: "medium", status: "blocked" },
      { content: "d", priority: "medium", status: "pending" },
    ];
    // 1/4, not 2/4: an abandoned task is finished with, not finished.
    expect(todoProgress(plan)).toEqual({ done: 1, settled: 2, total: 4 });
  });
});

// ---------------------------------------------------------------------------
// The reducer, which is the whole contract path for an owned session's todos
// ---------------------------------------------------------------------------

describe("the plan reducer carries omp's real todo shape", () => {
  test("phase, blocker and all five states survive an ACP plan update", () => {
    const session = sessionWithPlan([
      { content: "Read the contracts", priority: "high", status: "completed", phase: "Audit" },
      { content: "Wire the panel", priority: "medium", status: "blocked", phase: "Build", blocker: "waiting on #118" },
      { content: "Drop the rail idea", priority: "low", status: "abandoned", phase: "Build" },
    ]);
    expect(session.plan).toEqual([
      { content: "Read the contracts", priority: "high", status: "completed", phase: "Audit" },
      { content: "Wire the panel", priority: "medium", status: "blocked", phase: "Build", blocker: "waiting on #118" },
      { content: "Drop the rail idea", priority: "low", status: "abandoned", phase: "Build" },
    ]);
  });

  test("a producer that sends neither phase nor blocker leaves both absent, never null", () => {
    const [todo] = sessionWithPlan([{ content: "Ship it", status: "in_progress" }]).plan;
    expect(todo).toEqual({ content: "Ship it", priority: "medium", status: "in_progress" });
    expect("phase" in (todo ?? {})).toBe(false);
    expect("blocker" in (todo ?? {})).toBe(false);
  });

  test("a status omp does not have falls back to pending rather than rendering a blank chip", () => {
    const [todo] = sessionWithPlan([{ content: "Ship it", status: "somethingelse" }]).plan;
    expect(todo?.status).toBe("pending");
  });

  test("a thinking level on the info update reaches the session, and its absence stays null", () => {
    expect(EMPTY_SESSION.info.thinkingLevel).toBeNull();
    const informed = reduce(EMPTY_SESSION, {
      sessionUpdate: "session_info_update",
      model: "anthropic/claude-opus-5",
      thinkingLevel: "high",
    });
    expect(informed.info.thinkingLevel).toBe("high");
    // An owned ACP session never sends the field; a later update without it
    // must not wipe what a co-driven one already reported.
    expect(reduce(informed, { sessionUpdate: "session_info_update", model: "x" }).info.thinkingLevel).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe("the panel renders what the session actually reported", () => {
  test("todos render with their phase, their state, and the reason a blocked one is stuck", () => {
    const view = mount(
      panel({
        session: sessionWithPlan([
          { content: "Read the contracts", status: "completed", phase: "Audit" },
          { content: "Wire the panel", status: "in_progress", phase: "Build" },
          { content: "Prove the switch", status: "blocked", phase: "Build", blocker: "the loading fix is in flight" },
        ]),
      }),
    );
    try {
      expect(view.el("session-context-todos")).not.toBeNull();
      expect(view.el("session-context-todo-progress")?.textContent).toBe("1/3");
      expect(view.el("session-context-phase-0")?.textContent).toBe("Audit");
      expect(view.el("session-context-phase-1")?.textContent).toBe("Build");
      const text = view.host.textContent ?? "";
      expect(text).toContain("Read the contracts");
      expect(text).toContain("in progress");
      expect(text).toContain("blocked");
      expect(text).toContain("Blocked on the loading fix is in flight");
    } finally {
      view.unmount();
    }
  });

  test("a subagent with a transcript is a control; one without says why it is not", () => {
    const main = agent("agt_main");
    const opened: Agent[] = [];
    const view = mount(
      panel({
        subject: main,
        opened,
        agents: [
          main,
          // The supervisor's ACP mirror: a session id, so it opens.
          agent("agt_scout", {
            name: "Policy Scout",
            state: "idle",
            parentAgentId: "agt_main",
            acpSessionId: "sess_scout",
            taskTitle: "Inspect the permission path",
            model: "anthropic/claude-sonnet-5",
            labels: { source: "omp-subagent" },
          }),
          // The collab guest leg's mirror: no session id, because the room
          // streams the mirrored session's transcript and nothing else.
          agent("agt_mirror", {
            name: "Mirrored Sub",
            state: "busy",
            parentAgentId: "agt_main",
            labels: { source: "omp-subagent" },
          }),
        ],
      }),
    );
    try {
      expect(view.el("session-context-subagents")).not.toBeNull();
      expect(view.host.textContent).toContain("Policy Scout");
      expect(view.host.textContent).toContain("Inspect the permission path");

      view.press("agent-hub-open-agt_scout");
      expect(opened.map(next => next.id)).toEqual(["agt_scout"]);

      // The unreachable one is text, not a button that lands on a blank log.
      expect(view.el("agent-hub-open-agt_mirror")).toBeNull();
      expect(view.el("agent-hub-row-agt_mirror")).not.toBeNull();
      expect(view.el("agent-hub-unopenable-agt_mirror")?.textContent).toBe(SUBAGENT_UNOPENABLE);
    } finally {
      view.unmount();
    }
  });

  test("a sub of a sub nests under its own parent rather than flattening onto the session", () => {
    const main = agent("agt_main");
    const view = mount(
      panel({
        subject: main,
        agents: [
          main,
          agent("agt_scout", { parentAgentId: "agt_main", acpSessionId: "s1" }),
          agent("agt_reviewer", { parentAgentId: "agt_scout", acpSessionId: "s2" }),
        ],
      }),
    );
    try {
      const scout = view.el("agent-hub-agt_scout");
      expect(scout).not.toBeNull();
      // Containment is the claim: a flattened list would put both rows as
      // siblings and the operator would lose who delegated to whom.
      expect(scout?.querySelector('[data-testid="agent-hub-agt_reviewer"]')).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("another session's subagents never appear under this one", () => {
    const mine = agent("agt_mine");
    const view = mount(
      panel({
        subject: mine,
        agents: [
          mine,
          agent("agt_theirs"),
          agent("agt_their_sub", { name: "Theirs", parentAgentId: "agt_theirs", acpSessionId: "s9" }),
        ],
      }),
    );
    try {
      expect(view.el("session-context-subagents")).toBeNull();
      expect(view.host.textContent).not.toContain("Theirs");
    } finally {
      view.unmount();
    }
  });

  test("the state rows carry the model, the thinking level and the link, and nothing it was not told", () => {
    const view = mount(
      panel({
        origin: "co-driven",
        session: reduce(EMPTY_SESSION, {
          sessionUpdate: "session_info_update",
          model: "Claude Opus 5",
          thinkingLevel: "high",
          cwd: "/Users/op/dev/src/github.com/op/alpha",
        }),
      }),
    );
    try {
      expect(view.el("session-context-model")?.textContent).toBe("Claude Opus 5");
      expect(view.el("session-context-thinking")?.textContent).toBe("high");
      expect(view.el("session-context-origin")?.textContent).toBe("co-driving a shared terminal");
      // Nothing pending and nothing running: those rows are absent, not zero.
      expect(view.el("session-context-clearances")).toBeNull();
      expect(view.el("session-context-running")).toBeNull();
      expect(view.el("session-context-failed")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("an owned session with no thinking level on the wire omits the row instead of guessing one", () => {
    const view = mount(panel({ subject: agent("agt_main", { model: "openai/gpt-5.4" }) }));
    try {
      expect(view.el("session-context-model")?.textContent).toBe("openai/gpt-5.4");
      expect(view.el("session-context-thinking")).toBeNull();
      // Owned is what every session is until told otherwise, so there is no
      // Link row to read: a band that said so on every pane was the one row
      // that made this section impossible to omit.
      expect(view.el("session-context-origin")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("a view-only join says it is watching, not co-driving", () => {
    const view = mount(panel({ origin: "watching" }));
    try {
      expect(view.el("session-context-origin")?.textContent).toBe("watching a shared terminal");
    } finally {
      view.unmount();
    }
  });

  test("running tools and outstanding clearances appear only once they exist", () => {
    let session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      title: "bash",
      status: "in_progress",
    });
    session = reduce(session, { sessionUpdate: "tool_call", toolCallId: "t2", title: "read", status: "pending" });
    const view = mount(panel({ session }));
    try {
      expect(view.el("session-context-running")?.textContent).toBe("2 tools");
    } finally {
      view.unmount();
    }
  });
});

describe("empty data omits a section rather than reporting a zero", () => {
  test("an idle session with no todos, no subs and only its own identity still shows the identity", () => {
    const view = mount(panel({ subject: agent("agt_main", { state: "idle" }) }));
    try {
      // The panel exists because the state rows are real; the two sections
      // with nothing behind them are absent, not empty.
      expect(view.el("session-context")).not.toBeNull();
      expect(view.el("session-context-todos")).toBeNull();
      expect(view.el("session-context-todo-progress")).toBeNull();
      expect(view.el("session-context-subagents")).toBeNull();
      expect(view.host.textContent).not.toContain("0/0");
    } finally {
      view.unmount();
    }
  });

  test("a busy session with no todo list yet names that, because silence there is a claim", () => {
    const view = mount(panel({ subject: agent("agt_main", { state: "busy" }) }));
    try {
      expect(view.el("session-context-todos-absent")?.textContent).toBe(TODO_ABSENT_WHILE_BUSY);
    } finally {
      view.unmount();
    }
  });

  test("a stopped session with nothing to report renders no band at all", () => {
    const view = mount(panel({ subject: agent("agt_main", { state: "stopped", cwd: "" }) }));
    try {
      // The whole band, not just its sections: no todos, no subagents, no
      // model, no directory and an owned link nobody needs told about leaves
      // nothing to say, and a heading over nothing is the chrome this design
      // refuses. Before the Link row was gated this assertion was impossible.
      expect(view.el("session-context")).toBeNull();
      expect(view.el("session-context-toggle")).toBeNull();
      // cwd blank and no model: every row is genuinely unknown, so the whole
      // band is absent rather than a header over three dashes. `Link` alone
      // would be chrome.
      expect(view.el("session-context-todos-absent")).toBeNull();
      expect(view.el("session-context-todos")).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe("the collapse default follows the screen class", () => {
  test("a phone starts collapsed with its counts on the header, so the transcript stays primary", () => {
    setWindowSize(390, 844);
    const main = agent("agt_main");
    const view = mount(
      <SessionContext
        agent={main}
        agents={[main, agent("agt_sub", { parentAgentId: "agt_main", acpSessionId: "s1" })]}
        now={NOW}
        onOpenSubagent={() => {}}
        origin="owned"
        session={sessionWithPlan([{ content: "Ship it", status: "in_progress" }])}
      />,
    );
    try {
      expect(view.el("session-context-body")).toBeNull();
      // Collapsed is not silent: the header carries what the sections would.
      expect(view.el("session-context-summary")?.textContent).toBe("0/1 todos · 1 subagent");
      view.press("session-context-toggle");
      expect(view.el("session-context-body")).not.toBeNull();
      expect(view.el("session-context-todos")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("a tablet starts open, because it has the vertical room a phone does not", () => {
    setWindowSize(1024, 1366);
    const main = agent("agt_main");
    const view = mount(
      <SessionContext
        agent={main}
        agents={[main]}
        now={NOW}
        onOpenSubagent={() => {}}
        origin="owned"
        session={sessionWithPlan([{ content: "Ship it", status: "in_progress" }])}
      />,
    );
    try {
      expect(view.el("session-context-body")).not.toBeNull();
      expect(view.el("session-context-todos")).not.toBeNull();
      view.press("session-context-toggle");
      expect(view.el("session-context-body")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("an iPad in portrait is still a tablet: the default is decided by the shortest side", () => {
    setWindowSize(820, 1180);
    const main = agent("agt_main");
    const view = mount(
      <SessionContext
        agent={main}
        agents={[main]}
        now={NOW}
        onOpenSubagent={() => {}}
        origin="owned"
        session={sessionWithPlan([{ content: "Ship it", status: "pending" }])}
      />,
    );
    try {
      expect(view.el("session-context-body")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The rhythm, read off the rendered surface
// ---------------------------------------------------------------------------

describe("the panel spends one step per level of nesting and nothing else", () => {
  /** A chain four deep under the open session, every link openable. */
  const chain = [
    agent("agt_main"),
    agent("agt_a", { parentAgentId: "agt_main", acpSessionId: "s_a" }),
    agent("agt_b", { parentAgentId: "agt_a", acpSessionId: "s_b" }),
    agent("agt_c", { parentAgentId: "agt_b", acpSessionId: "s_c" }),
    agent("agt_d", { parentAgentId: "agt_c", acpSessionId: "s_d" }),
  ];

  test("three levels deep is three steps of rhythm.indent, not an ad-hoc ramp", () => {
    const view = mount(panel({ subject: chain[0] as Agent, agents: chain }));
    try {
      // Read off the row itself rather than summed up the tree: the branch
      // boxes nest, so an offset paid by them compounds invisibly and the step
      // a row sits at stops being anything a reader -- or this test -- can
      // check. `marginLeft: space.wide` plus `paddingLeft: space.snug` plus a
      // rail is what used to add up to one step by accident; it reads as zero
      // here, at every depth, which is the failure this asserts.
      const indentOf = (id: string): number => {
        const row = view.el(`agent-hub-open-${id}`);
        if (row === null) throw new Error(`no row rendered for ${id}`);
        return points(row, "padding-left") ?? 0;
      };
      expect(indentOf("agt_a")).toBe(0);
      expect(indentOf("agt_b")).toBe(rhythm.indent);
      expect(indentOf("agt_c")).toBe(2 * rhythm.indent);
      expect(indentOf("agt_d")).toBe(3 * rhythm.indent);
      // The multiplication, stated as the rule rather than as three numbers: a
      // second per-level inset anywhere in the tree breaks this even if each
      // row's own value still looked plausible.
      expect(indentOf("agt_d") - indentOf("agt_c")).toBe(rhythm.indent);
    } finally {
      view.unmount();
    }
  });

  test("a nested row is still a finger target, sized by a floor rather than a height", () => {
    const view = mount(panel({ subject: chain[0] as Agent, agents: chain }));
    try {
      const row = view.el("agent-hub-open-agt_d");
      if (row === null) throw new Error("no deepest row rendered");
      expect(points(row, "min-height")).toBe(rhythm.minTarget);
      // A fixed height is what clips a row at a larger type size.
      expect(points(row, "height")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("a directory as long as the machine says it is truncates in its row, never widens it", () => {
    const deep = "/Users/op/dev/src/github.com/op/alpha/packages/app/src/components/really/deep";
    const view = mount(
      panel({
        subject: agent("agt_main", { cwd: deep, model: "anthropic/claude-opus-5-with-a-very-long-name" }),
      }),
    );
    try {
      const value = view.el("session-context-cwd");
      if (value === null) throw new Error("no directory row rendered");
      const declarations = declarationsFor(value);
      // `numberOfLines={1}`: the value ellipsises inside its own share of the
      // row. Without it the path sets a floor the row cannot go under and the
      // band grows wider than the pane it sits in.
      expect(declarations.get("text-overflow")).toBe("ellipsis");
      expect(declarations.get("white-space")).toBe("nowrap");
      expect(declarations.get("overflow-x")).toBe("hidden");
      // And the label column beside it is a floor, so a larger type size grows
      // the column instead of cutting the word in it.
      const label = value.previousElementSibling;
      if (!(label instanceof HTMLElement)) throw new Error("no label beside the value");
      expect(points(label, "min-width")).toBe(96);
      expect(points(label, "width")).toBeNull();
    } finally {
      view.unmount();
    }
  });
});

describe("collapsed, the band is one row on the transcript's own column", () => {
  test("the header is one row tall by a floor, and pays the screen gutter", () => {
    setWindowSize(390, 844);
    const main = agent("agt_main");
    const view = mount(
      <SessionContext
        agent={main}
        agents={[main, agent("agt_sub", { parentAgentId: "agt_main", acpSessionId: "s1" })]}
        now={NOW}
        onOpenSubagent={() => {}}
        origin="owned"
        session={sessionWithPlan([{ content: "Ship it", status: "in_progress" }])}
      />,
    );
    try {
      const head = view.el("session-context-toggle");
      if (head === null) throw new Error("no header rendered");
      // Collapsed the band is the header and nothing else, so the header's own
      // height IS the band's height.
      expect(view.el("session-context-body")).toBeNull();
      expect(points(head, "min-height")).toBe(rhythm.minTarget);
      expect(points(head, "height")).toBeNull();
      // The same inset the transcript below it pays, which is what makes the
      // two read as one column rather than two panels that nearly line up.
      expect(points(head, "padding-left")).toBe(rhythm.gutter);
      expect(points(head, "padding-right")).toBe(rhythm.gutter);
    } finally {
      view.unmount();
    }
  });

  test("open, the sections are a section apart and the body pays the same gutter", () => {
    setWindowSize(390, 844);
    const view = mount(
      panel({
        session: sessionWithPlan([{ content: "Ship it", status: "in_progress" }]),
      }),
    );
    try {
      const body = view.el("session-context-body");
      if (body === null) throw new Error("no body rendered");
      // The scroll view's own child is the content container RNW renders the
      // contentContainerStyle onto, and it compiles a `gap` and an all-sides
      // `padding` to those shorthands rather than to their long forms.
      const content = body.firstElementChild;
      if (!(content instanceof HTMLElement)) throw new Error("no scroll content rendered");
      expect(points(content, "gap")).toBe(rhythm.sectionGap);
      expect(points(content, "padding")).toBe(rhythm.gutter);
    } finally {
      view.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Identity, through the real console
// ---------------------------------------------------------------------------

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "prompt", "approve", "manage"],
};

const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [{ id: "local", label: "Studio Mac", connection: CONNECTION }],
};

/** The slice of the client surface `useConsole` touches, canned. */
class CannedClient {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  on(name: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter(entry => entry !== listener),
      );
    };
  }
  start(): void {}
  close(): void {}
  reconnectNow(): void {}
  attach(): void {}
  listSessions(): void {}
  openCollab(): void {}
  leaveCollab(): void {}
  sessionTail(): void {}
  sessionHistory(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  deleteSessions(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  startVoice(): void {}
  stopVoice(): void {}
  sendAudio(): void {}
}

interface Shell {
  host: HTMLElement;
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  /**
   * The context panel's own text, never the whole shell's. The fleet bay
   * beside the detail pane runs a roster-wide Agent Hub, so a shell-wide
   * search for a subagent's name finds it whichever session is open and
   * would pass this test's negative assertions for the wrong reason.
   */
  panelText: () => string;
  /**
   * The open detail pane's own text: the session log, or the terminal
   * surface. Scoped like `panelText` and for the same reason -- the fleet bay
   * beside it lists the whole machine, so a shell-wide search would pass a
   * negative assertion for the wrong reason.
   */
  detailText: () => string;
  press: (testID: string) => void;
  emit: (name: string, event: unknown) => void;
  unmount: () => void;
}

function mountShell(): Shell {
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // Provided the way the app provides it, at the root above the console: the
  // shell renders Paper components (a chip, a button, an icon slot), and
  // without the provider those come out in Material's palette with Paper's own
  // icon renderer, which is not the shell this test is about.
  act(() => {
    root.render(
      <WithOmpTheme>
        <Console
          connection={CONNECTION}
          daemonLabel="Studio Mac"
          connections={CONNECTIONS}
          onAddConnection={() => {}}
          onSelectConnection={() => {}}
          onUnpair={() => {}}
          createClient={() => client as unknown as OmpdClient}
        />
      </WithOmpTheme>,
    );
  });
  act(() => {
    client.emit("status", { state: "connected", attempt: 0 });
  });
  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  return {
    host,
    client,
    el,
    panelText: () => el("session-context")?.textContent ?? "",
    detailText: () => el("session")?.textContent ?? el("terminal-session")?.textContent ?? "",
    press: (testID: string) => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    emit: (name, event) => {
      act(() => {
        client.emit(name, event);
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

/** The roster both identity tests run against: two sessions, one with a sub. */
const TWO_SESSIONS: Agent[] = [
  // Both carry a session id, which is what a real session log has and what
  // makes an open ask for the history page a wait can end on.
  agent("agt_a", { name: "Alpha", acpSessionId: "sess_a" }),
  agent("agt_a:sub:1", {
    name: "Alpha Scout",
    parentAgentId: "agt_a",
    acpSessionId: "sess_alpha_scout",
    labels: { source: "omp-subagent" },
  }),
  agent("agt_b", { name: "Bravo", acpSessionId: "sess_b" }),
];

function planUpdate(agentId: AgentId, seq: number, entries: readonly Record<string, unknown>[]): unknown {
  return { agentId, seq, update: { sessionUpdate: "plan", entries } };
}

describe("the panel belongs to the open session and to no other", () => {
  test("live frames move a todo and a subagent without the operator reselecting anything", () => {
    // A tablet, so the detail pane is beside the list and the panel is open
    // by default: what is under test is the frame arriving, not a tap.
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: TWO_SESSIONS });
      shell.emit("update", planUpdate("agt_a", 1, [{ content: "Wire the panel", status: "in_progress" }]));
      expect(shell.el("session-context-todo-progress")?.textContent).toBe("0/1");
      expect(shell.panelText()).toContain("in progress");
      expect(shell.panelText()).toContain("Alpha Scout");

      // The same list, one status moved on, plus a second todo: the panel
      // follows without the operator touching the screen.
      shell.emit(
        "update",
        planUpdate("agt_a", 2, [
          { content: "Wire the panel", status: "completed" },
          { content: "Prove the switch", status: "in_progress" },
        ]),
      );
      expect(shell.el("session-context-todo-progress")?.textContent).toBe("1/2");
      expect(shell.panelText()).toContain("Prove the switch");

      // And the roster is the authority on the subagent's state.
      shell.emit("agents", {
        agents: TWO_SESSIONS.map(row => (row.id === "agt_a:sub:1" ? { ...row, state: "stopped" as const } : row)),
      });
      const sub = shell.el("agent-hub-agt_a:sub:1");
      expect(sub?.textContent).toContain("stopped");
    } finally {
      shell.unmount();
    }
  });

  test("switching sessions drops the first one's context, and a late frame for it cannot come back", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: TWO_SESSIONS });
      shell.emit("update", planUpdate("agt_a", 1, [{ content: "Alpha's only todo", status: "in_progress" }]));
      expect(shell.el("session-name")?.textContent).toBe("Alpha");
      expect(shell.panelText()).toContain("Alpha's only todo");
      expect(shell.panelText()).toContain("Alpha Scout");

      // Open Bravo through its own subagent-free session. The detail pane
      // swaps; nothing about Alpha may survive the swap.
      shell.press("session-open-sess_b");
      expect(shell.el("session-name")?.textContent).toBe("Bravo");
      expect(shell.panelText()).not.toContain("Alpha's only todo");
      expect(shell.panelText()).not.toContain("Alpha Scout");
      expect(shell.el("session-context-todos")).toBeNull();

      // The frame that was already in flight when the operator switched. It
      // is addressed to Alpha, so it lands in Alpha's slice and nowhere near
      // what is on screen.
      shell.emit("update", planUpdate("agt_a", 3, [{ content: "Alpha's late todo", status: "completed" }]));
      expect(shell.el("session-name")?.textContent).toBe("Bravo");
      expect(shell.panelText()).not.toContain("Alpha's late todo");
      expect(shell.el("session-context-todos")).toBeNull();

      // And Alpha still has both when the operator goes back, so "cleared"
      // meant cleared from the view, never destroyed.
      shell.press("session-open-sess_a");
      expect(shell.el("session-name")?.textContent).toBe("Alpha");
      expect(shell.panelText()).toContain("Alpha's late todo");
    } finally {
      shell.unmount();
    }
  });
});

/**
 * A live-tui fleet row, so a press goes down the join path rather than the
 * roster's synthesized-agent path.
 */
function tuiRow(id: string, title: string) {
  return {
    id,
    title,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    cwdScope: "home" as const,
    flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
    status: "live-tui" as const,
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActivityAt: "2026-08-24T11:59:00.000Z",
    messageCount: 3,
    byteSize: 2_048,
    archived: false,
    pid: 4_242,
  };
}

describe("a row press commits its own session before the daemon answers", () => {
  test("pressing a session shows that session loading, with none of the previous one on screen", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      // Alpha is auto-selected on a tablet and settles on its history page.
      shell.emit("agents", { agents: TWO_SESSIONS });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      shell.emit("update", planUpdate("agt_a", 1, [{ content: "Alpha's only todo", status: "in_progress" }]));
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.panelText()).toContain("Alpha's only todo");

      // The press, and nothing else. No frame has answered for Bravo yet.
      shell.press("session-open-sess_b");
      expect(shell.el("session-loading")).not.toBeNull();
      // The pane names the session it is waiting for, so the press visibly
      // landed on Bravo rather than leaving Alpha on screen.
      expect(shell.el("session-loading-title")?.textContent).toBe("Bravo");
      expect(shell.el("session-name")?.textContent).toBe("Bravo");

      // Nothing of Alpha's, and nothing that claims Bravo is empty: the
      // transcript's own empty state is a verified absence, and this pane has
      // verified nothing yet.
      expect(shell.el("aui-messages")).toBeNull();
      expect(shell.el("aui-messages")).toBeNull();
      expect(shell.el("session-context")).toBeNull();
      expect(shell.detailText()).not.toContain("Alpha's only todo");
      // And no controls for a session that may yet be refused.
      expect(shell.el("composer-input")).toBeNull();
      expect(shell.el("session-actions-withheld")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("the first authoritative answer clears the wait, and an empty session says so truthfully", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: TWO_SESSIONS });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      shell.press("session-open-sess_b");
      expect(shell.el("session-loading")).not.toBeNull();

      // Bravo's history page comes back with nothing in it, which is an
      // answer: the session exists and has no turns.
      shell.emit("session_history", { agentId: "agt_b", sessionId: "sess_b", entries: [], nextBefore: null });
      expect(shell.el("session-loading")).toBeNull();
      // The honest empty, not a spinner that never ends.
      expect(shell.el("aui-messages")).not.toBeNull();
      expect(shell.el("aui-messages")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a refused open renders that session's refusal and never restores the previous one", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: TWO_SESSIONS });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      shell.emit("update", planUpdate("agt_a", 1, [{ content: "Alpha's only todo", status: "in_progress" }]));
      shell.press("session-open-sess_b");

      shell.emit("error", { agentId: "agt_b", code: "forbidden", message: "That session is not yours to read." });
      expect(shell.el("session-load-failed")).not.toBeNull();
      expect(shell.el("session-load-failed-title")?.textContent).toBe("Bravo");
      expect(shell.el("session-load-failed-message")?.textContent).toBe("That session is not yours to read.");
      // The pane stays Bravo's. Falling back to Alpha would tell the operator
      // their press did nothing when it was answered with a no.
      expect(shell.el("session-name")?.textContent).toBe("Bravo");
      expect(shell.detailText()).not.toContain("Alpha's only todo");
      expect(shell.el("session-loading")).toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a late answer for a session already left cannot end the wait the open one is in", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      const three = [...TWO_SESSIONS, agent("agt_c", { name: "Charlie", acpSessionId: "sess_c" })];
      shell.emit("agents", { agents: three });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });

      // B, then C, faster than either answered.
      shell.press("session-open-sess_b");
      shell.press("session-open-sess_c");
      expect(shell.el("session-loading-title")?.textContent).toBe("Charlie");

      // B's answer lands now. It is addressed to B, so it settles B and is
      // invisible here: Charlie is still waiting, and nothing of B's renders.
      shell.emit("session_history", { agentId: "agt_b", sessionId: "sess_b", entries: [], nextBefore: null });
      shell.emit("update", planUpdate("agt_b", 4, [{ content: "Bravo's late todo", status: "completed" }]));
      expect(shell.el("session-loading")).not.toBeNull();
      expect(shell.el("session-loading-title")?.textContent).toBe("Charlie");
      expect(shell.el("session-context")).toBeNull();
      expect(shell.detailText()).not.toContain("Bravo's late todo");

      // And C's own answer is what ends C's wait.
      shell.emit("session_history", { agentId: "agt_c", sessionId: "sess_c", entries: [], nextBefore: null });
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.el("session-name")?.textContent).toBe("Charlie");

      // B kept the data that arrived while it was off screen, so going back
      // is instant rather than a second wait.
      shell.press("session-open-sess_b");
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.panelText()).toContain("Bravo's late todo");
    } finally {
      shell.unmount();
    }
  });

  test("a terminal row press commits the terminal before the join is answered, and its tail settles it", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
      shell.press("session-open-sess_tui");

      // The pane is the pressed row's already: the daemon has answered
      // neither the join nor the tail.
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.el("terminal-title")?.textContent).toBe("terminal work");
      expect(shell.el("session-loading-title")?.textContent).toBe("terminal work");
      expect(shell.el("terminal-log")).toBeNull();
      // None of the hints, because each is a claim about a session this pane
      // does not have yet.
      expect(shell.el("terminal-explainer")).toBeNull();
      expect(shell.el("terminal-transcript-limit")).toBeNull();

      // The canned daemon has no collab API, so the open falls back to the
      // steer surface and the tail is what answers.
      shell.emit("session_tail", { sessionId: "sess_tui", messages: [], truncated: false });
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.el("terminal-transcript-limit")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a co-driven join moves the wait onto the agent it names, and the agent's own page ends it", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "shared terminal")] });
      shell.press("session-open-sess_tui");
      expect(shell.el("terminal-session")).not.toBeNull();

      // The daemon joined it instead: the pane becomes the guest agent's, and
      // it is still waiting, because the join's transcript has not landed.
      shell.emit("agents", { agents: [agent("agt_guest", { name: "shared terminal" })] });
      shell.emit("collab_opened", { sessionId: "sess_tui", agentId: "agt_guest", readOnly: false });
      expect(shell.el("session")).not.toBeNull();
      expect(shell.el("session-loading-title")?.textContent).toBe("shared terminal");
      expect(shell.el("session-context")).toBeNull();

      shell.emit("session_history", { agentId: "agt_guest", sessionId: "sess_tui", entries: [], nextBefore: null });
      expect(shell.el("session-loading")).toBeNull();
      // And the context panel names the link the console recorded for it.
      expect(shell.el("session-context-origin")?.textContent).toBe("co-driving a shared terminal");
    } finally {
      shell.unmount();
    }
  });
});
