/**
 * The Fleet index wiring: canned `sessions` frames becoming rendered rows,
 * the live roster overlaid onto them, and a live-tui row's open asking the
 * daemon to co-drive the session through its collab guest, with the steer
 * surface as the fallback when that terminal's omp cannot host a room.
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
import { COLLAB_REFUSAL_REASONS } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleEvent, ConsoleState, SessionOpenTarget } from "../src/console/state.ts";
import {
  apply,
  browserSessionsOf,
  COLLAB_WATCH_ONLY,
  emptyConsole,
  loadFor,
  openSessionTarget,
  tuiSessionFor,
} from "../src/console/state.ts";
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
      onDelete={() => {}}
      deleteAccess="granted"
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
  readonly collabOpens: string[] = [];
  readonly collabLeaves: string[] = [];
  readonly sessionPrompts: Array<{ sessionId: string; text: string }> = [];
  readonly resumes: Array<{ sessionId: string; cwd: string }> = [];
  readonly tails: Array<{ sessionId: string; limit: number | undefined; cursor?: number }> = [];
  readonly histories: Array<{ agentId: AgentId; sessionId: string; before?: number }> = [];
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
  openCollab(sessionId: string): void {
    this.collabOpens.push(sessionId);
  }
  leaveCollab(sessionId: string): void {
    this.collabLeaves.push(sessionId);
  }
  sessionPrompt(sessionId: string, text: string): void {
    this.sessionPrompts.push({ sessionId, text });
  }
  resumeSession(sessionId: string, cwd: string): void {
    this.resumes.push({ sessionId, cwd });
  }
  sessionTail(sessionId: string, limit?: number, cursor?: number): void {
    this.tails.push({ sessionId, limit, ...(cursor === undefined ? {} : { cursor }) });
  }
  sessionHistory(agentId: AgentId, sessionId: string, before?: number): void {
    this.histories.push({ agentId, sessionId, ...(before === undefined ? {} : { before }) });
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
  // A pairing that can both watch and steer, which is what a live-tui row's
  // open and the prompts that follow it spend.
  scopes: ["read", "prompt", "approve", "manage"],
};

interface Mounted {
  client: CannedClient;
  state: () => ConsoleState;
  actions: () => ConsoleActions;
  unmount: () => void;
}

function mountConsole(connection: Connection = CONNECTION): Mounted {
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
    root.render(createElement(Probe, { connection }));
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

/**
 * Open a live-tui row the way every omp before `pi.startCollab` resolves it:
 * the join ask, the daemon's `collab_unavailable` answer, and the fallback
 * that lands the operator on the steer surface. The steer tests open through
 * here because that answer is what the terminals in the field give today.
 */
function openTuiByFallback(mounted: Mounted, sessionId: string): void {
  act(() => {
    mounted.actions().openSession({ kind: "live-tui", sessionId });
  });
  act(() => {
    mounted.client.emit("error", {
      code: "collab_unavailable",
      sessionId,
      message: "this omp build cannot host a collab room",
    });
  });
}

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

  test("a live-tui row asks the daemon to co-drive, and the pane is that row's from the press", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { kind: "live-tui", sessionId: "s-tui" };
      act(() => {
        mounted.actions().openSession(target);
      });
      // The one frame the open sends is the join. No agent is selected yet:
      // the screen that renders a co-driven terminal is the ordinary session
      // screen, and its agent exists only once `collab_opened` names one. The
      // terminal surface, though, is this row's immediately, waiting on the
      // answer, because a press that commits nothing leaves the previous
      // session on screen while the operator waits for this one.
      expect(mounted.client.collabOpens).toEqual(["s-tui"]);
      expect(mounted.client.tails).toHaveLength(0);
      expect(mounted.client.resumes).toHaveLength(0);
      expect(mounted.client.attached).toHaveLength(0);
      expect(mounted.state().selected).toBeNull();
      expect(mounted.state().selectedTui).toBe("s-tui");
      expect(loadFor(mounted.state(), "s-tui").phase).toBe("loading");

      // The join's answer is the landing: the agent it names is selected and
      // attached exactly as a resume's answer would be, which is the whole
      // point of presenting a joined terminal as an ordinary agent.
      act(() => {
        mounted.client.emit("collab_opened", { sessionId: "s-tui", agentId: "agt_guest", readOnly: false });
      });
      expect(mounted.state().selected).toBe("agt_guest");
      expect(mounted.client.attached).toEqual([{ agentId: "agt_guest", options: { sinceSeq: 0 } }]);
      expect(mounted.client.histories).toEqual([{ agentId: "agt_guest", sessionId: "s-tui" }]);
      // The terminal's wait is over -- the join is its answer -- and the
      // agent it named inherits one, because the join's transcript has not
      // arrived yet.
      expect(loadFor(mounted.state(), "s-tui").phase).toBe("ready");
      expect(loadFor(mounted.state(), "agt_guest").phase).toBe("loading");
    } finally {
      mounted.unmount();
    }
  });

  test("loading earlier asks from the cursor the daemon handed back, and only once per page", () => {
    const mounted = mountConsole();
    try {
      openTuiByFallback(mounted, "s-tui");
      act(() => {
        mounted.client.emit("session_tail", {
          sessionId: "s-tui",
          messages: [{ role: "user", text: "the newest words", at: "" }],
          truncated: true,
          nextCursor: 4096,
        });
      });

      act(() => {
        mounted.actions().loadEarlierTui("s-tui");
      });
      expect(mounted.client.tails).toEqual([
        { sessionId: "s-tui", limit: undefined },
        { sessionId: "s-tui", limit: undefined, cursor: 4096 },
      ]);

      // A second tap while that page is in flight must not put a second ask
      // for the same offset on the wire.
      act(() => {
        mounted.actions().loadEarlierTui("s-tui");
      });
      expect(mounted.client.tails).toHaveLength(2);

      // And once the file's start is reached there is nothing left to ask
      // for, whatever the surface does.
      act(() => {
        mounted.client.emit("session_tail", {
          sessionId: "s-tui",
          messages: [{ role: "user", text: "the oldest words", at: "" }],
          truncated: false,
          nextCursor: null,
          cursor: 4096,
        });
      });
      act(() => {
        mounted.actions().loadEarlierTui("s-tui");
      });
      expect(mounted.client.tails).toHaveLength(2);
      expect(tuiSessionFor(mounted.state(), "s-tui").history.map(m => m.text)).toEqual([
        "the oldest words",
        "the newest words",
      ]);
    } finally {
      mounted.unmount();
    }
  });

  test("a page of pure tool traffic is asked past, not reported as the end of the file", () => {
    // The exhaustion case that would otherwise strand the operator: the
    // daemon's page carried no words because a screenful of the file is tool
    // calls, and the file still holds plenty behind it.
    const mounted = mountConsole();
    try {
      openTuiByFallback(mounted, "s-tui");
      act(() => {
        mounted.client.emit("session_tail", { sessionId: "s-tui", messages: [], truncated: true, nextCursor: 9000 });
      });
      act(() => {
        mounted.actions().loadEarlierTui("s-tui");
      });
      act(() => {
        mounted.client.emit("session_tail", {
          sessionId: "s-tui",
          messages: [],
          truncated: true,
          nextCursor: 6000,
          cursor: 9000,
        });
      });

      // The empty page's own cursor was asked for without the operator
      // tapping again: they asked for earlier words, not earlier bytes.
      expect(mounted.client.tails).toEqual([
        { sessionId: "s-tui", limit: undefined },
        { sessionId: "s-tui", limit: undefined, cursor: 9000 },
        { sessionId: "s-tui", limit: undefined, cursor: 6000 },
      ]);
      expect(tuiSessionFor(mounted.state(), "s-tui").historyLoadingEarlier).toBe(true);

      // Words at last: the walk settles rather than running on.
      act(() => {
        mounted.client.emit("session_tail", {
          sessionId: "s-tui",
          messages: [{ role: "assistant", text: "words behind the noise", at: "" }],
          truncated: true,
          nextCursor: 3000,
          cursor: 6000,
        });
      });
      expect(mounted.client.tails).toHaveLength(3);
      expect(tuiSessionFor(mounted.state(), "s-tui").history.map(m => m.text)).toEqual(["words behind the noise"]);
      expect(tuiSessionFor(mounted.state(), "s-tui").historyLoadingEarlier).toBe(false);
    } finally {
      mounted.unmount();
    }
  });

  test("prompting the open terminal sends sessionPrompt with that row's id and the text", () => {
    const mounted = mountConsole();
    try {
      openTuiByFallback(mounted, "s-tui");
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
      expect(mounted.client.histories).toEqual([{ agentId: "agt_adopted", sessionId: "s-tui" }]);
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

// ---------------------------------------------------------------------------
// Co-driving a terminal: the join, its refusals, and what a second tap costs
// ---------------------------------------------------------------------------

describe("a co-drive join is idempotent and states every refusal", () => {
  const joined = (readOnly: boolean): ConsoleEvent => ({
    t: "collab_opened",
    event: { sessionId: "s-tui", agentId: "agt_guest", readOnly },
  });

  test("a second answer for a session already joined folds to no change at all", () => {
    // The daemon answers a re-open with the agent it already holds rather
    // than joining twice, so the frame must cost this device nothing: same
    // state by reference means React skips the render, and a double tap on a
    // row cannot make a second screen or a second guest.
    const once = drive([joined(false)]);
    expect(once.selected).toBe("agt_guest");
    expect(once.collabAgents.get("agt_guest")).toEqual({ sessionId: "s-tui", readOnly: false });

    expect(apply(once, joined(false))).toBe(once);
  });

  test("a view-only join is recorded as such, so the screen can say so before a prompt is typed", () => {
    const state = drive([joined(true)]);
    expect(state.collabAgents.get("agt_guest")?.readOnly).toBe(true);
    // And the wording the screen carries is the daemon's own vocabulary for
    // that refusal rather than a second phrasing of it.
    expect(COLLAB_WATCH_ONLY).toContain("view-only");
  });

  test("a refused join is named on screen, in the daemon's own reason", () => {
    const state = drive([
      {
        t: "error",
        event: {
          message: COLLAB_REFUSAL_REASONS.not_hosted,
          code: "collab_refused",
          reason: "not_hosted",
          sessionId: "s-tui",
        },
      },
    ]);
    expect(state.notice).toBe(`Co-driving was refused: ${COLLAB_REFUSAL_REASONS.not_hosted}`);
    // A refusal is not a broken link: a reconnect must not clear it, because
    // reconnecting says nothing about whether that terminal hosts a room.
    expect(state.noticeAboutLink).toBe(false);
  });

  test("a pairing that cannot watch is told why, and no frame is sent", () => {
    // The three-way scope rule at the open: `missing` states the reason,
    // rather than spending a round trip on a frame the daemon must refuse
    // and whose refusal would arrive wearing another scope's wording. It
    // does not fall back either: a pairing is the operator's own grant, so
    // widening it is their call, never the surface's to route around.
    const mounted = mountConsole({ ...CONNECTION, scopes: ["prompt"] });
    try {
      act(() => {
        mounted.actions().openSession({ kind: "live-tui", sessionId: "s-tui" });
      });
      expect(mounted.client.collabOpens).toHaveLength(0);
      // Addressed to the row that was pressed, not raised as an ambient
      // notice. The pane commits to that terminal first and then wears the
      // refusal, because a toast over the previous session's log while that
      // log stayed on screen read as a tap that did nothing.
      expect(mounted.state().selected).toBeNull();
      expect(mounted.state().selectedTui).toBe("s-tui");
      const refused = loadFor(mounted.state(), "s-tui");
      expect(refused.phase).toBe("failed");
      expect(refused.error).toContain("read scope");
    } finally {
      mounted.unmount();
    }
  });

  test("a pairing that cannot steer is told why, and the prompt never leaves the device", () => {
    const mounted = mountConsole({ ...CONNECTION, scopes: ["read"] });
    try {
      act(() => {
        mounted.client.emit("collab_opened", { sessionId: "s-tui", agentId: "agt_guest", readOnly: false });
      });
      act(() => {
        mounted.actions().prompt("agt_guest", "take the wheel");
      });
      expect(mounted.state().notice).toContain("prompt scope");
      // The echo is what makes a sent prompt visible, so its absence is the
      // proof nothing was sent: a refused steer must not look delivered.
      expect(mounted.state().sessions.get("agt_guest")).toBeUndefined();
    } finally {
      mounted.unmount();
    }
  });

  test("leaving a co-driven session tells the daemon to leave the room", () => {
    const mounted = mountConsole();
    try {
      act(() => {
        mounted.client.emit("collab_opened", { sessionId: "s-tui", agentId: "agt_guest", readOnly: false });
      });
      act(() => {
        mounted.actions().back();
      });
      expect(mounted.client.collabLeaves).toEqual(["s-tui"]);
      expect(mounted.state().selected).toBeNull();

      // Opening another session is leaving this one too, and the daemon hears
      // about it exactly once rather than on every re-select.
      act(() => {
        mounted.client.emit("collab_opened", { sessionId: "s-tui", agentId: "agt_guest", readOnly: false });
      });
      act(() => {
        mounted.actions().select("agt_other");
      });
      expect(mounted.client.collabLeaves).toEqual(["s-tui", "s-tui"]);
    } finally {
      mounted.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The fallback: an omp without the collab API keeps its steer surface
// ---------------------------------------------------------------------------

describe("an omp without the collab API still gets its terminal steered", () => {
  test("collab_unavailable lands the open on the steer surface, and the operator can still prompt", () => {
    const mounted = mountConsole();
    try {
      act(() => {
        mounted.actions().openSession({ kind: "live-tui", sessionId: "s-tui" });
      });
      // The join was asked for first: collab stays the preferred path.
      expect(mounted.client.collabOpens).toEqual(["s-tui"]);
      // And the pane is this row's already, waiting on the answer. Claiming
      // nothing until the daemon replied is what left the previous session on
      // screen while the operator waited for this one.
      expect(mounted.state().selectedTui).toBe("s-tui");
      expect(loadFor(mounted.state(), "s-tui").phase).toBe("loading");

      act(() => {
        mounted.client.emit("error", {
          code: "collab_unavailable",
          sessionId: "s-tui",
          message: "this omp build cannot host a collab room",
        });
      });

      // The fallback, not a notice: the terminal surface opens with its
      // transcript tail asked for, and nothing reports a working screen as
      // a failure.
      expect(mounted.state().selectedTui).toBe("s-tui");
      expect(mounted.client.tails).toEqual([{ sessionId: "s-tui", limit: undefined }]);
      expect(mounted.state().notice).toBeNull();

      // And the surface is a working one: a steer rides the same
      // session_prompt frame it always did, with the sent echo on screen
      // before the daemon answers.
      act(() => {
        mounted.actions().promptTui("s-tui", "Reply with exactly: phone-turn-ok");
      });
      expect(mounted.client.sessionPrompts).toEqual([
        { sessionId: "s-tui", text: "Reply with exactly: phone-turn-ok" },
      ]);
      expect(tuiSessionFor(mounted.state(), "s-tui").sent).toBe("Reply with exactly: phone-turn-ok");
    } finally {
      mounted.unmount();
    }
  });

  test("a refused co-drive does not fall back: it states itself", () => {
    const mounted = mountConsole();
    try {
      act(() => {
        mounted.actions().openSession({ kind: "live-tui", sessionId: "s-tui" });
      });
      act(() => {
        mounted.client.emit("error", {
          code: "collab_refused",
          reason: "not_hosted",
          sessionId: "s-tui",
          message: COLLAB_REFUSAL_REASONS.not_hosted,
        });
      });

      // A refusal is a decision the operator must make, so the surface
      // stays closed: no fallback opens, no tail is asked for, and the
      // refusal names itself in the daemon's own words.
      // The pane stays the pressed row's and wears the refusal: bouncing back
      // to the list would read as a tap that did nothing, when in fact it was
      // answered with a no.
      expect(mounted.state().selectedTui).toBe("s-tui");
      const refused = loadFor(mounted.state(), "s-tui");
      expect(refused.phase).toBe("failed");
      expect(refused.error).toBe(COLLAB_REFUSAL_REASONS.not_hosted);
      expect(mounted.client.tails).toHaveLength(0);
      expect(mounted.state().notice).toBe(`Co-driving was refused: ${COLLAB_REFUSAL_REASONS.not_hosted}`);
      // And no steer leaves the device for a session nobody opened.
      expect(mounted.client.sessionPrompts).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });
});
