/**
 * The Fleet index wiring: canned `sessions` frames becoming rendered rows,
 * the live roster overlaid onto them, and a live-tui row's open landing on
 * the prompt surface that steers the terminal instead of claiming it.
 *
 * The exact bug this file pins: a daemon with hundreds of sessions and a
 * phone showing "No sessions.", because Fleet rows were derived from the
 * agent roster alone. Every test here drives the real reducer, the real
 * browser reducer, and the real screen from fixed frames, so a pass means
 * the same frames would render the same fleet on a device.
 *
 * The hook tests mount `useConsole` against a canned client rather than a
 * socket: the decisions under test are which calls the hook makes and which
 * events it folds, not whether a websocket connects.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent, AgentId, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleEvent, ConsoleState, SessionOpenTarget } from "../src/console/state.ts";
import { apply, browserSessionsOf, emptyConsole, openSessionTarget, tuiSessionFor } from "../src/console/state.ts";
import type { ConsoleActions } from "../src/console/useConsole.ts";
import type { Connection } from "../src/platform/connection.ts";
import type { BrowserState } from "../src/session/browser.ts";
import { browserReduce, EMPTY_BROWSER } from "../src/session/browser.ts";

// Dynamic on purpose, same reason as `fleet-screen.test.tsx`: these modules
// import "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { useConsole } = await import("../src/console/useConsole.ts");

// React 19 reads this to decide whether act() is legal outside a test
// renderer. It is React's own contract with a test host and no shipped type
// declares it, so the declaration belongs here rather than at a call site.
declare global {
  // `var` is what a global declaration takes; `let`/`const` do not reach globalThis.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const DIR_A = "/Users/op/dev/src/github.com/op/alpha";
const DIR_B = "/Users/op/dev/src/github.com/op/beta";

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    cwd: DIR_A,
    cwdScope: "abs",
    flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
    title: `session ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-02T00:00:00.000Z",
    messageCount: 7,
    byteSize: 4096,
    status: "dormant",
    archived: false,
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `agent ${id}`,
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: DIR_A,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActiveAt: "2026-01-01T00:00:00.000Z",
    labels: {},
    ...overrides,
  };
}

function drive(events: readonly ConsoleEvent[], from = emptyConsole([])): ConsoleState {
  let state = from;
  for (const event of events) state = apply(state, event);
  return state;
}

function renderFleet(browser: BrowserState): string {
  return renderToStaticMarkup(
    <FleetScreen
      browser={browser}
      onSort={() => {}}
      onToggleGroup={() => {}}
      onToggleGrouped={() => {}}
      onToggleArchived={() => {}}
      onOpen={() => {}}
      onArchive={() => {}}
      onUnarchive={() => {}}
      now={NOW}
    />,
  );
}

// ---------------------------------------------------------------------------
// The bug: an index with no agents must still render rows
// ---------------------------------------------------------------------------

describe("an index with zero agents renders the fleet", () => {
  // Two directories, four rows, including one archived (hidden by default)
  // and one live-tui, so the corpus exercises every vocabulary value the
  // daemon can report.
  const INDEX: SessionSummary[] = [
    summary("s-a1", { cwd: DIR_A, flattenedDir: "-alpha", status: "dormant" }),
    summary("s-a2", { cwd: DIR_A, flattenedDir: "-alpha", status: "live-tui", pid: 4242 }),
    summary("s-b1", { cwd: DIR_B, flattenedDir: "-beta", status: "dormant" }),
    summary("s-b2", { cwd: DIR_B, flattenedDir: "-beta", status: "archived", archived: true }),
  ];
  const state = drive([{ t: "sessions", event: { sessions: INDEX } }]);
  const browser = browserReduce(EMPTY_BROWSER, { t: "load", sessions: browserSessionsOf(state) });
  const html = renderFleet(browser);

  test("a session that no agent ever held is a row, not a silence", () => {
    expect(html).toContain('data-testid="session-row-s-a1"');
    expect(html).toContain('data-testid="session-row-s-a2"');
    expect(html).toContain('data-testid="session-row-s-b1"');
  });

  test("the rows are grouped under both directories", () => {
    expect(html).toContain(`data-testid="group-header-${DIR_A}"`);
    expect(html).toContain(`data-testid="group-header-${DIR_B}"`);
  });

  test("the empty state does not appear while the index holds sessions", () => {
    expect(html).not.toContain("No sessions.");
    expect(html).not.toContain('data-testid="fleet-empty"');
    expect(html).toContain("3 sessions");
  });

  test("each row keeps the status the daemon's index reported", () => {
    // live-tui from the index survives into the row, including its label.
    expect(html).toContain('data-testid="session-status-s-a2"');
    expect(html).toContain("Prompt session s-a2");
  });
});

// ---------------------------------------------------------------------------
// The overlay: a live agent holding an indexed session
// ---------------------------------------------------------------------------

describe("a live agent is overlaid onto its indexed session", () => {
  const INDEX: SessionSummary[] = [
    // The daemon's snapshot still says dormant; the roster is fresher.
    summary("s-held", { cwd: DIR_A, flattenedDir: "-alpha", status: "dormant" }),
    summary("s-free", { cwd: DIR_B, flattenedDir: "-beta", status: "live-tui", pid: 9 }),
  ];
  const roster = [
    agent("agt_holder", { name: "the holder", acpSessionId: "s-held" }),
    // A subagent holds a session too, but its row belongs to the index; it
    // must not also be synthesized as a second row from the roster.
    agent("agt_sub", { acpSessionId: "s-free", parentAgentId: "agt_holder" }),
    // Created since the last ask: not in the snapshot, still owed a row.
    agent("agt_new", { name: "fresh agent", acpSessionId: "s-unindexed" }),
  ];
  const state = drive([
    { t: "sessions", event: { sessions: INDEX } },
    { t: "agents", event: { agents: roster } },
  ]);
  const rows = browserSessionsOf(state);

  test("the row shows the agent's name and its live status", () => {
    expect(rows.find(row => row.id === "s-held")).toMatchObject({ title: "the holder", status: "live-ompd" });
  });

  test("the held session appears exactly once, not once per source", () => {
    expect(rows.filter(row => row.id === "s-held")).toHaveLength(1);
  });

  test("a subagent's session stays one row, carrying the subagent's live status", () => {
    expect(rows.filter(row => row.id === "s-free")).toHaveLength(1);
    expect(rows.find(row => row.id === "s-free")).toMatchObject({ status: "live-ompd" });
  });

  test("an agent created since the last ask still gets a row", () => {
    expect(rows.find(row => row.id === "s-unindexed")).toMatchObject({
      title: "fresh agent",
      status: "live-ompd",
    });
  });

  test("an agent whose process ended stops claiming its row", () => {
    const stopped = drive([
      { t: "sessions", event: { sessions: INDEX } },
      {
        t: "agents",
        event: { agents: [agent("agt_holder", { acpSessionId: "s-held", state: "stopped" })] },
      },
    ]);
    expect(browserSessionsOf(stopped).find(row => row.id === "s-held")).toMatchObject({ status: "dormant" });
  });

  test("two agents naming one unindexed session produce a single live row", () => {
    // A resumed session whose previous holder is still on the roster. Both
    // named the same acpSessionId, and the index had not seen it yet, so the
    // fleet emitted two children with one key: React's warning banner then
    // covered the composer on a real screen.
    const contested = drive([
      { t: "sessions", event: { sessions: INDEX } },
      {
        t: "agents",
        event: {
          agents: [
            agent("agt_previous", { name: "previous holder", acpSessionId: "s-resumed", state: "stopped" }),
            agent("agt_current", { name: "current holder", acpSessionId: "s-resumed" }),
          ],
        },
      },
    ]);
    const resumed = browserSessionsOf(contested).filter(row => row.id === "s-resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]).toMatchObject({ title: "current holder", status: "live-ompd" });
  });
});

// ---------------------------------------------------------------------------
// Opening a row resolves to the holder, or the claim it can echo
// ---------------------------------------------------------------------------

describe("opening a row resolves to a holder, a claim, or the terminal prompt surface", () => {
  const INDEX: SessionSummary[] = [
    summary("s-tui", { cwd: DIR_A, flattenedDir: "-alpha", status: "live-tui", pid: 4242 }),
    summary("s-ompd", { cwd: DIR_A, flattenedDir: "-alpha", status: "live-ompd", agentId: "agt_late" }),
    summary("s-dormant", { cwd: DIR_B, flattenedDir: "-beta", status: "dormant" }),
    summary("s-opaque", {
      cwd: null,
      cwdScope: "unknown",
      cwdDecodeReason: "ambiguous",
      flattenedDir: "-opaque",
      status: "dormant",
    }),
  ];

  test("a live-tui row becomes a prompt target: the session id, and nothing to echo", () => {
    const target = openSessionTarget(drive([{ t: "sessions", event: { sessions: INDEX } }]), "s-tui");
    expect(target).toEqual({ kind: "live-tui", sessionId: "s-tui" });
  });

  test("a live-tui row with no pid or decodable cwd is still promptable", () => {
    // Prompting routes by session id and verifies nothing, so the echoes a
    // takeover needed are not prerequisites here. The daemon refuses an
    // unreachable terminal in words; the resolver must not refuse it first.
    const index = [
      summary("s-tui-nopid", { status: "live-tui" }),
      summary("s-tui-opaque", { cwd: null, cwdScope: "unknown", flattenedDir: "-opaque", status: "live-tui" }),
    ];
    const state = drive([{ t: "sessions", event: { sessions: index } }]);
    expect(openSessionTarget(state, "s-tui-nopid")).toEqual({ kind: "live-tui", sessionId: "s-tui-nopid" });
    expect(openSessionTarget(state, "s-tui-opaque")).toEqual({ kind: "live-tui", sessionId: "s-tui-opaque" });
  });

  test("a row the roster holds resolves to that agent, the way live-ompd opens", () => {
    const state = drive([
      { t: "sessions", event: { sessions: INDEX } },
      { t: "agents", event: { agents: [agent("agt_here", { acpSessionId: "s-tui" })] } },
    ]);
    expect(openSessionTarget(state, "s-tui")).toEqual({
      kind: "agent",
      sessionId: "s-tui",
      agentId: "agt_here",
    });
  });

  test("a row only the index's agentId names resolves to that agent", () => {
    const target = openSessionTarget(drive([{ t: "sessions", event: { sessions: INDEX } }]), "s-ompd");
    expect(target).toEqual({ kind: "agent", sessionId: "s-ompd", agentId: "agt_late" });
  });

  test("a dormant row becomes a resume target echoing that row's own cwd", () => {
    const target = openSessionTarget(drive([{ t: "sessions", event: { sessions: INDEX } }]), "s-dormant");
    expect(target).toEqual({ kind: "dormant", sessionId: "s-dormant", cwd: DIR_B });
  });

  test("a stopped roster holder resumes with the index's canonical cwd, not its stale alias", () => {
    const state = drive([
      { t: "sessions", event: { sessions: INDEX } },
      {
        t: "agents",
        event: {
          // macOS: an agent created in /tmp is indexed under /private/tmp.
          agents: [agent("agt_stopped", { state: "stopped", acpSessionId: "s-dormant", cwd: "/tmp/alias" })],
        },
      },
    ]);
    expect(openSessionTarget(state, "s-dormant")).toEqual({
      kind: "dormant",
      sessionId: "s-dormant",
      cwd: DIR_B,
    });
  });

  test("a row the index dropped, or whose cwd it could not decode, is unopenable", () => {
    const state = drive([{ t: "sessions", event: { sessions: INDEX } }]);
    // A stale row a newer index dropped: no echo exists, so no claim does.
    expect(openSessionTarget(state, "s-gone")).toEqual({ kind: "unopenable", sessionId: "s-gone" });
    // The daemon refuses a cwd it cannot verify, so the resolver must not
    // offer one.
    expect(openSessionTarget(state, "s-opaque")).toEqual({ kind: "unopenable", sessionId: "s-opaque" });
  });
});

// ---------------------------------------------------------------------------
// The hook: ask once, fold the answer, open through the action
// ---------------------------------------------------------------------------

/**
 * The client surface `useConsole` touches, canned. The hook under test is
 * real; the socket is not, because the decisions here are which calls the
 * hook makes and which events it folds.
 */
class CannedClient {
  readonly askedIndex: unknown[] = [];
  readonly attached: Array<{ agentId: AgentId; options: unknown }> = [];
  readonly sessionPrompts: Array<{ sessionId: string; text: string }> = [];
  readonly resumes: Array<{ sessionId: string; cwd: string }> = [];
  readonly tails: Array<{ sessionId: string; limit: number | undefined }> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  // -- the surface OmpdClient exposes, as the hook uses it ------------------

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
  attach(agentId: AgentId, options?: unknown): void {
    this.attached.push({ agentId, options });
  }
  listSessions(query?: unknown): void {
    this.askedIndex.push(query);
  }
  sessionPrompt(sessionId: string, text: string): void {
    this.sessionPrompts.push({ sessionId, text });
  }
  resumeSession(sessionId: string, cwd: string): void {
    this.resumes.push({ sessionId, cwd });
  }
  sessionTail(sessionId: string, limit?: number): void {
    this.tails.push({ sessionId, limit });
  }
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
}

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "approve", "manage"],
};

interface Mounted {
  client: CannedClient;
  state: () => ConsoleState;
  actions: () => ConsoleActions;
  unmount: () => void;
}

function mountConsole(): Mounted {
  const client = new CannedClient();
  let latest: [ConsoleState, ConsoleActions] | null = null;
  function Probe(props: { connection: Connection }): null {
    latest = useConsole(props.connection, () => client as unknown as OmpdClient);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Probe, { connection: CONNECTION }));
  });
  return {
    client,
    state: () => (latest as NonNullable<typeof latest>)[0],
    actions: () => (latest as NonNullable<typeof latest>)[1],
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("useConsole asks for the index once and folds the answer", () => {
  test("the first established connection asks; a reconnect does not ask again", () => {
    const mounted = mountConsole();
    try {
      act(() => {
        mounted.client.emit("status", { state: "connecting", attempt: 0 });
      });
      expect(mounted.client.askedIndex).toHaveLength(0);
      act(() => {
        mounted.client.emit("status", { state: "connected", attempt: 0 });
      });
      expect(mounted.client.askedIndex).toEqual([{ includeArchived: true }]);
      // The client replays the request itself after a reconnect; asking here
      // too would duplicate the frame.
      act(() => {
        mounted.client.emit("status", { state: "reconnecting", attempt: 1, delayMs: 1000 });
        mounted.client.emit("status", { state: "connected", attempt: 1 });
      });
      expect(mounted.client.askedIndex).toHaveLength(1);
    } finally {
      mounted.unmount();
    }
  });

  test("the sessions event becomes the state's index and the fleet's rows", () => {
    const mounted = mountConsole();
    try {
      const index = [summary("s-a1", { cwd: DIR_A, flattenedDir: "-alpha" })];
      act(() => {
        mounted.client.emit("sessions", { sessions: index });
      });
      expect(mounted.state().sessionIndex).toEqual(index);
      expect(browserSessionsOf(mounted.state()).map(row => row.id)).toEqual(["s-a1"]);
    } finally {
      mounted.unmount();
    }
  });
});

describe("useConsole opens a row through its holder or a claim on the socket", () => {
  test("a row with a holder attaches to that agent, the live-ompd open", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { kind: "agent", sessionId: "s-held", agentId: "agt_here" };
      act(() => {
        mounted.actions().openSession(target);
      });
      expect(mounted.client.attached).toEqual([{ agentId: "agt_here", options: { sinceSeq: 0 } }]);
      expect(mounted.state().selected).toBe("agt_here");
    } finally {
      mounted.unmount();
    }
  });

  test("a live-tui row opens the prompt surface and asks for its transcript, claiming nothing", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { kind: "live-tui", sessionId: "s-tui" };
      act(() => {
        mounted.actions().openSession(target);
      });
      expect(mounted.state().selectedTui).toBe("s-tui");
      // The one frame the open does send: this session's own transcript tail.
      // A terminal session has no agent row to attach to, so without it the
      // surface opens as a composer over an empty pane.
      expect(mounted.client.tails).toEqual([{ sessionId: "s-tui", limit: undefined }]);
      // And it claims nothing: no takeover, no resume, no attach. A terminal
      // cannot be taken over from here, and reading a transcript is not
      // pretending the daemon agreed to something it was never asked.
      expect(mounted.client.sessionPrompts).toHaveLength(0);
      expect(mounted.client.resumes).toHaveLength(0);
      expect(mounted.client.attached).toHaveLength(0);
      expect(mounted.state().selected).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("prompting the open terminal sends sessionPrompt with that row's id and the text", () => {
    const mounted = mountConsole();
    try {
      act(() => {
        mounted.actions().openSession({ kind: "live-tui", sessionId: "s-tui" });
      });
      act(() => {
        mounted.actions().promptTui("s-tui", "Reply with exactly: phone-turn-ok");
      });
      expect(mounted.client.sessionPrompts).toEqual([
        { sessionId: "s-tui", text: "Reply with exactly: phone-turn-ok" },
      ]);
      // The sent echo is on state immediately: the daemon does not echo
      // prompts, so without it a successful send still looks dropped.
      expect(tuiSessionFor(mounted.state(), "s-tui").sent).toBe("Reply with exactly: phone-turn-ok");
    } finally {
      mounted.unmount();
    }
  });

  test("a dormant row claims the resume over the socket, echoing that row's cwd", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { kind: "dormant", sessionId: "s-dormant", cwd: DIR_B };
      act(() => {
        mounted.actions().openSession(target);
      });
      expect(mounted.client.resumes).toEqual([{ sessionId: "s-dormant", cwd: DIR_B }]);
      expect(mounted.state().selected).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("an unopenable row answers with a notice instead of a claim the daemon must refuse", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { kind: "unopenable", sessionId: "s-gone" };
      act(() => {
        mounted.actions().openSession(target);
      });
      expect(mounted.state().notice).toContain("cannot be opened");
      expect(mounted.client.sessionPrompts).toHaveLength(0);
      expect(mounted.client.resumes).toHaveLength(0);
      expect(mounted.client.attached).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });

  test("a session_opened reply selects and attaches the agent the daemon named", () => {
    const mounted = mountConsole();
    try {
      act(() => {
        mounted.client.emit("session_opened", { sessionId: "s-tui", agentId: "agt_adopted" });
      });
      expect(mounted.state().selected).toBe("agt_adopted");
      expect(mounted.client.attached).toEqual([{ agentId: "agt_adopted", options: { sinceSeq: 0 } }]);
    } finally {
      mounted.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The terminal lifecycle: prompt, hints, and the refusal that names a remedy
// ---------------------------------------------------------------------------

describe("a prompted terminal reports progress as hints, never a transcript", () => {
  test("a turn folds to busy, then a reply, then done", () => {
    const started = drive([
      { t: "tui_prompt", sessionId: "s-tui", text: "status of the deploy?" },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "turn_start" } },
    ]);
    // turn_start retires the sent echo and marks the turn busy: the
    // terminal took the prompt.
    expect(tuiSessionFor(started, "s-tui").sent).toBeNull();
    expect(tuiSessionFor(started, "s-tui").busy).toBe(true);

    const state = drive([
      { t: "tui_prompt", sessionId: "s-tui", text: "status of the deploy?" },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "assistant_text", text: "green" } },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "turn_end" } },
    ]);
    expect(tuiSessionFor(state, "s-tui").busy).toBe(false);
    // The reply is the last text reported, not an appended transcript row.
    expect(tuiSessionFor(state, "s-tui").reply).toBe("green");
  });

  test("a second assistant_text replaces the first, and a hint never accumulates", () => {
    const state = drive([
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "assistant_text", text: "almost" } },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "assistant_text", text: "done" } },
    ]);
    expect(tuiSessionFor(state, "s-tui").reply).toBe("done");
  });

  test("an unreachable refusal lands on the open terminal, naming cause and remedy", () => {
    const state = drive([
      { t: "tui_select", sessionId: "s-tui" },
      { t: "tui_prompt", sessionId: "s-tui", text: "hello?" },
      { t: "error", event: { message: "no connected TUI owns session s-tui", code: "tui_unreachable" } },
    ]);
    const tui = tuiSessionFor(state, "s-tui");
    expect(tui.sent).toBeNull();
    // Words the operator can act on: the owner went away and recovery starts
    // at that terminal, not the daemon's raw code or phrasing.
    expect(tui.refusalKind).toBe("owner-gone");
    expect(tui.refusal).toContain("no longer reachable");
    expect(tui.refusal).toContain("Return to that terminal");
    expect(tui.refusal).not.toContain("no connected TUI owns");
    // The refusal is held on the screen's state, not burned into the toast.
    expect(state.notice).toBeNull();
  });

  test("a refusal with no terminal open falls back to the daemon's own message", () => {
    const state = drive([
      { t: "error", event: { message: "no connected TUI owns session s-tui", code: "tui_unreachable" } },
    ]);
    expect(state.notice).toBe("no connected TUI owns session s-tui");
    expect(tuiSessionFor(state, "s-tui").refusal).toBeNull();
  });

  test("activity after a refusal clears it: the bridge came back", () => {
    const state = drive([
      { t: "tui_select", sessionId: "s-tui" },
      { t: "error", event: { message: "no connected TUI owns session s-tui", code: "tui_unreachable" } },
      { t: "tui_activity", event: { sessionId: "s-tui", kind: "turn_start" } },
    ]);
    expect(tuiSessionFor(state, "s-tui").refusal).toBeNull();
    expect(tuiSessionFor(state, "s-tui").busy).toBe(true);
  });

  test("opening a terminal closes the agent strip, and an agent landing closes the terminal", () => {
    const both = drive([
      { t: "select", agentId: "agt_open" },
      { t: "tui_select", sessionId: "s-tui" },
    ]);
    expect(both.selected).toBeNull();
    expect(both.selectedTui).toBe("s-tui");

    const adopted = drive([
      { t: "tui_select", sessionId: "s-tui" },
      { t: "select", agentId: "agt_adopted" },
    ]);
    expect(adopted.selectedTui).toBeNull();
    expect(adopted.selected).toBe("agt_adopted");
  });

  test("back clears the terminal surface", () => {
    const state = drive([
      { t: "tui_select", sessionId: "s-tui" },
      { t: "select", agentId: null },
    ]);
    expect(state.selectedTui).toBeNull();
  });
});
