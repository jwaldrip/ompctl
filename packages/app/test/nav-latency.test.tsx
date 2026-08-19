/**
 * What one navigation costs, counted rather than felt.
 *
 * The operator's report was "naving is slow", measured on a phone as seconds
 * between a tap and an interactive terminal, and more seconds still on the way
 * back. A screen-by-screen walkthrough cannot tell a refetch from a re-render,
 * so this file instruments the four things a round trip could plausibly pay
 * for: index requests the client sends, row objects the derivation rebuilds,
 * worlds the browser reducer accepts, and renders the bay's list pays. The
 * shell, the hook, and the socket wiring are real; the socket is canned.
 *
 * ## The contract these counts defend
 *
 * The index is a snapshot the client asked for once per pairing, and the list
 * is already holding it, so a push or a pop has nothing to ask the daemon for
 * and nothing to rebuild in the bay: zero index asks, zero list mounts, and
 * zero row renders per navigation. A count above zero is not a style problem;
 * it is the phone's missing seconds.
 *
 * ## Why the counts are taken over a window and not at the pop
 *
 * The pop's own commit is a bad place to look, and looking there is how a
 * whole class of this cost stayed hidden. A phone renders once per socket
 * message, so by the time a thumb lands on back, every frame of the turn has
 * already re-derived whatever it was going to re-derive; the pop finds its
 * memo keys unchanged and measures as free. It is not free. It is queued
 * behind what those frames left on the thread, which is what the operator
 * sees as seconds of nothing happening before the animation starts. So the
 * live cases below count the whole window the operator is inside -- open,
 * work, leave -- and compare it against the same window with the session
 * holding still.
 */

import "./rnw.ts";

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Agent, AgentId, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { SessionRowProps } from "../src/components/SessionRow.tsx";
import type { ConsoleState } from "../src/console/state.ts";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import type { FleetScreenProps } from "../src/screens/FleetScreen.tsx";
import type { BrowserAction, BrowserState } from "../src/session/browser.ts";
import { resetSafeAreaInsets } from "./rnw.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The rows and the screen are real; only their module bindings are wrapped, so
// every render and mount this file counts is a render or mount the app itself
// would have paid. Dynamic imports with an explicit order, for the same reason
// as `nav-shell.test.tsx`: the counting wrappers must replace the cached
// modules before the console's import graph binds them, and bun evaluates a
// file's whole static import graph before its body runs.
const realRow = await import("../src/components/SessionRow.tsx");
// Frozen before the mock registers: bun patches the cached module's namespace
// in place, so a read of `realRow.SessionRow` after the mock would return the
// wrapper, and the wrapper would call itself forever.
const RealSessionRow = realRow.SessionRow;

/**
 * Counts cell render attempts rather than memo-defeated function bodies: the
 * wrapper is what the list's cells render, so a count above zero is a cell
 * re-render the real row's `memo` was supposed to make unnecessary. Mounts are
 * exact, which is what the list-stays-mounted contract needs.
 */
const counts = {
  fleetMounts: 0,
  fleetUnmounts: 0,
  fleetRenders: 0,
  rowMounts: 0,
  rowUnmounts: 0,
  rowRenders: 0,
  /** Calls into `browserSessionsOf`: one is every row object in the fleet, rebuilt. */
  rowBuilds: 0,
  /** `load` actions the browser reducer accepted: one is a new world to sort, group, and re-render. */
  reloads: 0,
};

function resetCounts(): void {
  counts.fleetMounts = 0;
  counts.fleetUnmounts = 0;
  counts.fleetRenders = 0;
  counts.rowMounts = 0;
  counts.rowUnmounts = 0;
  counts.rowRenders = 0;
  counts.rowBuilds = 0;
  counts.reloads = 0;
}
mock.module("../src/components/SessionRow.tsx", () => ({
  ...realRow,
  SessionRow: function InstrumentedSessionRow(props: SessionRowProps): JSX.Element {
    counts.rowRenders += 1;
    useEffect(() => {
      counts.rowMounts += 1;
      return () => {
        counts.rowUnmounts += 1;
      };
    }, []);
    return <RealSessionRow {...props} />;
  },
}));

// The two seams the list's real cost flows through, wrapped for the same
// reason and in the same way as the row and the screen: dynamically imported
// because a static import would bind the console's graph to the real modules
// before these wrappers could replace them. A render count alone cannot tell a
// frame that rebuilt 546 row objects from one that reused them, and the
// reducer is where a rebuilt array becomes a whole list to re-sort and
// re-group, so both are counted rather than inferred.
const realState = await import("../src/console/state.ts");
const realBrowserSessionsOf = realState.browserSessionsOf;
mock.module("../src/console/state.ts", () => ({
  ...realState,
  browserSessionsOf: (state: ConsoleState) => {
    counts.rowBuilds += 1;
    return realBrowserSessionsOf(state);
  },
}));

const realBrowser = await import("../src/session/browser.ts");
const realBrowserReduce = realBrowser.browserReduce;
mock.module("../src/session/browser.ts", () => ({
  ...realBrowser,
  browserReduce: (state: BrowserState, action: BrowserAction) => {
    const next = realBrowserReduce(state, action);
    if (action.t === "load" && next !== state) counts.reloads += 1;
    return next;
  },
}));

const realFleet = await import("../src/screens/FleetScreen.tsx");
// Frozen for the same reason as the row: `realFleet.FleetScreen` would be the
// wrapper the moment the mock registers.
const RealFleetScreen = realFleet.FleetScreen;
mock.module("../src/screens/FleetScreen.tsx", () => ({
  ...realFleet,
  FleetScreen: function InstrumentedFleetScreen(props: FleetScreenProps): JSX.Element {
    counts.fleetRenders += 1;
    useEffect(() => {
      counts.fleetMounts += 1;
      return () => {
        counts.fleetUnmounts += 1;
      };
    }, []);
    return <RealFleetScreen {...props} />;
  },
}));

const { Console } = await import("../src/console/Console.tsx");

afterEach(resetSafeAreaInsets);

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "approve", "manage"],
};

const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [{ id: "local", label: "Studio Mac", connection: CONNECTION }],
};

/**
 * The client surface `useConsole` touches, canned the way `nav-shell.test.tsx`
 * cans it, with the one addition this file exists for: the index ask is
 * recorded, because an ask the operator did not order is a round trip the
 * phone is waiting on.
 */
class CannedClient {
  readonly indexAsks: unknown[] = [];
  readonly tails: Array<{ sessionId: string; limit?: number }> = [];
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
  listSessions(query?: unknown): void {
    this.indexAsks.push(query ?? null);
  }
  sessionTail(sessionId: string, limit?: number): void {
    this.tails.push({ sessionId, limit });
  }
  sessionPrompt(): void {}
  resumeSession(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `session ${id}`,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    cwdScope: "home",
    flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
    status: "live-tui",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActivityAt: "2026-02-28T00:00:00.000Z",
    messageCount: 12,
    byteSize: 4_096,
    archived: false,
    pid: 4_242,
    ...overrides,
  };
}

/** The operator's real machine: 541 sessions across 93 directories. */
const BIG_INDEX: readonly SessionSummary[] = Array.from({ length: 541 }, (_, i) =>
  summary(`sess_${String(i).padStart(3, "0")}`, {
    cwd: `/Users/op/dev/src/github.com/op/repo_${String(i % 93).padStart(2, "0")}`,
    flattenedDir: `repo_${String(i % 93).padStart(2, "0")}`,
  }),
);

interface Bay {
  host: HTMLElement;
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  /** Taps whichever row the active sort put first, under `act`. */
  openFirstRow: () => void;
  press: (testID: string) => void;
  /**
   * One socket frame, committed on its own.
   *
   * One `act` per frame rather than a burst inside one, because a phone gets
   * one websocket message per macrotask and pays the whole render for each.
   * Batching a burst into a single commit would hide exactly the cost this
   * file is here to count.
   */
  frame: (name: string, event: unknown) => void;
  unmount: () => void;
}

/** Mounts the real shell over a canned socket, already connected and indexed. */
function mountBay(rows: readonly SessionSummary[] = BIG_INDEX): Bay {
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <Console
        connection={CONNECTION}
        daemonLabel="Studio Mac"
        connections={CONNECTIONS}
        onAddConnection={() => {}}
        onSelectConnection={() => {}}
        onUnpair={() => {}}
        createClient={() => client as unknown as OmpdClient}
      />,
    );
  });

  act(() => {
    client.emit("status", { state: "connected", attempt: 0 });
    client.emit("sessions", { t: "sessions", sessions: rows });
  });

  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  const firstRowControl = (): HTMLElement => {
    const first = host.querySelector<HTMLElement>('[data-testid^="session-open-sess_"]');
    if (first === null) throw new Error("no session row rendered to open");
    return first;
  };

  return {
    host,
    client,
    el,
    openFirstRow: () => {
      act(() => {
        firstRowControl().click();
      });
    },
    press: (testID: string) => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    frame: (name: string, event: unknown) => {
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

/** The instrumentation must be bound, or every count below is a vacuous zero. */
describe("the instrumentation itself", () => {
  test("mounting the bay renders the list and its windowed rows", () => {
    const bay = mountBay();
    try {
      expect(counts.fleetRenders).toBeGreaterThan(0);
      expect(counts.rowMounts).toBeGreaterThan(0);
      expect(bay.el("fleet-list")).not.toBeNull();
    } finally {
      bay.unmount();
    }
  });
});

describe("a navigation does not pay for the bay twice", () => {
  test("pushing the terminal route leaves the bay's list mounted, not rebuilt", () => {
    const bay = mountBay();
    try {
      const listNode = bay.el("fleet-list");
      expect(listNode).not.toBeNull();
      resetCounts();

      bay.openFirstRow();
      expect(bay.el("terminal-session")).not.toBeNull();

      // The mount, not a screenshot: a rebuilt list is a new node and a new
      // mount count, either of which would show here.
      expect(counts.fleetMounts).toBe(0);
      expect(counts.fleetUnmounts).toBe(0);
      expect(bay.el("fleet-list")).toBe(listNode);
    } finally {
      bay.unmount();
    }
  });

  test("popping back sends zero new index requests, as does pushing again", () => {
    const bay = mountBay();
    try {
      expect(bay.client.indexAsks.length).toBe(1);

      resetCounts();
      bay.openFirstRow();
      bay.press("terminal-back");
      bay.openFirstRow();
      bay.press("terminal-back");

      expect(bay.el("fleet-list")).not.toBeNull();
      expect(bay.client.indexAsks.length).toBe(1);
    } finally {
      bay.unmount();
    }
  });

  test("a large index still renders a window, not the whole fleet", () => {
    const bay = mountBay();
    try {
      const mountedRows = bay.host.querySelectorAll('[data-testid^="session-row-"]').length;
      // 541 rows across 93 groups; a window is a screenful, not a census.
      expect(mountedRows).toBeLessThan(100);
      expect(mountedRows).toBeLessThan(BIG_INDEX.length);
    } finally {
      bay.unmount();
    }
  });

  test("a round trip renders zero rows and remounts nothing", () => {
    const bay = mountBay();
    try {
      resetCounts();

      bay.openFirstRow();
      expect(bay.el("terminal-session")).not.toBeNull();
      const afterPush = { ...counts };
      const asksAfterPush = bay.client.indexAsks.length;

      bay.press("terminal-back");
      expect(bay.el("fleet-list")).not.toBeNull();
      const afterPop = { ...counts };
      const asksAfterPop = bay.client.indexAsks.length;
      // The bay already holds the index and is already mounted; both ends of
      // the trip are pure stack work. Row renders and remounts are the phone's
      // missing milliseconds, so the ceiling is zero, not "few".
      expect(afterPush.rowRenders).toBe(0);
      expect(afterPush.fleetMounts).toBe(0);
      expect(asksAfterPush).toBe(1);
      expect(afterPop.rowRenders).toBe(0);
      expect(afterPop.fleetMounts).toBe(0);
      expect(afterPop.rowMounts).toBe(0);
      expect(asksAfterPop).toBe(1);
    } finally {
      bay.unmount();
    }
  });
});

/**
 * The only case the operator actually has, and the one the counts above cannot
 * see.
 *
 * Every test above navigates away from a session that is holding still. The
 * operator never does: the sessions worth opening on a phone are the ones an
 * agent is working in, so from the moment the detail route is on screen the
 * socket is delivering transcript frames for it, and it keeps delivering them
 * until the operator leaves. A guarantee that only holds while nothing is
 * streaming is a guarantee about a session nobody opens.
 *
 * `sess_000` is the row the sort puts first inside the first group, so the
 * agent below holds the row the operator would actually tap.
 */
const HELD_SESSION = "sess_000";
const HOLDER = "agt_main" as AgentId;

/** An agent this daemon holds, working in an indexed session. */
function holder(overrides: Partial<Agent> = {}): Agent {
  return {
    id: HOLDER,
    name: "Primary",
    state: "busy",
    acpSessionId: HELD_SESSION,
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/Users/op/dev/src/github.com/op/repo_00",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    labels: {},
    ...overrides,
  };
}

/**
 * The index the operator's phone actually holds while an agent works: the same
 * 541 rows, with the one the agent is in still described the way the daemon's
 * last snapshot found it. The snapshot is older than the roster, which is why
 * the row reads `Live (agent)` once the roster arrives and reads what the
 * index says the moment it leaves.
 */
const HELD_INDEX: readonly SessionSummary[] = BIG_INDEX.map(row =>
  row.id === HELD_SESSION ? { ...row, status: "dormant" as const } : row,
);

/**
 * What the daemon sends while an agent is working: chunk after chunk of
 * thinking and prose, a tool call and its completion, and the last of the
 * reply. Twenty-eight frames is a few seconds of one turn, not a pathological
 * case, and the operator's turns run for minutes.
 */
function streamOneTurn(bay: Bay, agentId: AgentId): void {
  const updates: unknown[] = [];
  for (let i = 0; i < 24; i += 1) {
    const thinking = i % 3 === 0;
    updates.push({
      sessionUpdate: thinking ? "agent_thought_chunk" : "agent_message_chunk",
      // Distinct per channel: two entries sharing a message id is a duplicate
      // transcript key, which would be a bug in the fixture rather than
      // anything the daemon does.
      messageId: `${thinking ? "t" : "m"}_${Math.floor(i / 4)}`,
      content: { type: "text", text: `chunk ${i} ` },
    });
  }
  updates.push(
    { sessionUpdate: "tool_call", toolCallId: "tc_1", title: "read packages/app/src", status: "pending" },
    { sessionUpdate: "tool_call_update", toolCallId: "tc_1", status: "completed" },
    { sessionUpdate: "agent_message_chunk", messageId: "m_last", content: { type: "text", text: "done" } },
    { sessionUpdate: "agent_message_chunk", messageId: "m_last", content: { type: "text", text: "." } },
  );

  updates.forEach((update, index) => {
    bay.frame("update", { agentId, seq: index + 1, update });
  });
}

/** Mounts the bay, admits the holder, and opens the session it holds. */
function mountHeldBay(): Bay {
  const bay = mountBay(HELD_INDEX);
  bay.frame("agents", { agents: [holder()] });
  // The row has to be in the first window, or the tap below would be a tap on
  // nothing and every count after it a vacuous zero.
  expect(bay.el(`session-open-${HELD_SESSION}`)).not.toBeNull();
  bay.press(`session-open-${HELD_SESSION}`);
  expect(bay.el("session-name")).not.toBeNull();
  return bay;
}

/**
 * What the list paid, as one value. The four counts are the whole bill: row
 * objects rebuilt, worlds handed to the reducer, cells re-rendered, cells
 * remounted. Compared as an object so a regression prints every line of it.
 */
function listCost(): Record<string, number> {
  return {
    rowBuilds: counts.rowBuilds,
    reloads: counts.reloads,
    rowRenders: counts.rowRenders,
    rowMounts: counts.rowMounts,
  };
}

/**
 * What one round trip through the held session costs the list, with whatever
 * the socket delivers in the middle of it.
 *
 * The whole trip rather than the pop alone, because the pop alone measures
 * nothing: by the time the operator's thumb lands, every frame of the turn has
 * already re-derived the list, so the pop's own commit finds the memo key
 * unchanged and looks free. It is not free -- it is queued behind the work
 * those frames left on the thread, which is what the operator sees as seconds
 * of nothing happening. Counting the trip is counting that queue.
 */
function roundTrip(work: (bay: Bay) => void): Record<string, number> {
  const bay = mountHeldBay();
  try {
    resetCounts();
    work(bay);
    bay.press("session-back");
    expect(bay.el("fleet-list")).not.toBeNull();
    expect(counts.fleetMounts).toBe(0);
    expect(bay.client.indexAsks.length).toBe(1);
    return listCost();
  } finally {
    bay.unmount();
  }
}

describe("leaving a live session does not pay for its stream", () => {
  test("a turn streaming behind the detail route rebuilds no rows and re-renders none", () => {
    const bay = mountHeldBay();
    try {
      resetCounts();

      streamOneTurn(bay, HOLDER);

      // The list is behind the open session and nothing about these frames
      // reaches a row: the row's counts come from the index, which held still.
      // A rebuild here is 541 row objects, a re-sort, a re-group, and the whole
      // mounted window, paid per frame, on the thread the pop animation needs.
      // Asserted together so a regression prints the whole bill rather than
      // its first line.
      expect(listCost()).toEqual({ rowBuilds: 0, reloads: 0, rowRenders: 0, rowMounts: 0 });
    } finally {
      bay.unmount();
    }
  });

  test("a trip through a working session costs the list what a trip through an idle one costs", () => {
    // One variable between the two: whether the agent did anything while the
    // operator was in there. The contract is that it costs the list nothing,
    // so the comparison is the assertion and the value below is what keeps a
    // regression that made both expensive from passing it.
    const idle = roundTrip(() => {});
    const working = roundTrip(bay => {
      streamOneTurn(bay, HOLDER);
    });

    expect(working).toEqual(idle);
    expect(idle).toEqual({ rowBuilds: 0, reloads: 0, rowRenders: 0, rowMounts: 0 });
  });

  test("a live terminal session's activity frames cost the list nothing either", () => {
    const bay = mountBay();
    try {
      bay.openFirstRow();
      expect(bay.el("terminal-session")).not.toBeNull();
      resetCounts();

      bay.frame("session_tail", { sessionId: "sess_000", messages: [], truncated: false });
      for (let i = 0; i < 8; i += 1) {
        bay.frame("tui_activity", { sessionId: "sess_000", kind: "turn_start" });
        bay.frame("tui_activity", { sessionId: "sess_000", kind: "assistant_text", text: `working ${i}` });
        bay.frame("tui_activity", { sessionId: "sess_000", kind: "turn_end" });
      }
      bay.press("terminal-back");
      expect(bay.el("fleet-list")).not.toBeNull();

      expect(listCost()).toEqual({ rowBuilds: 0, reloads: 0, rowRenders: 0, rowMounts: 0 });
    } finally {
      bay.unmount();
    }
  });

  test("a live frame arriving while the list is on screen still moves that row", () => {
    // The other side of the ledger. A list that never re-derives would pass
    // every count above and be useless, so this proves both of the inputs a row
    // still has reach it while the operator is looking at it: the roster, which
    // the daemon pushes on every state change of every live turn, and the
    // index, which is where a message count comes from.
    const bay = mountBay(HELD_INDEX);
    try {
      expect(bay.el(`session-status-${HELD_SESSION}`)?.textContent).toBe("Dormant");
      expect(bay.el(`session-messages-${HELD_SESSION}`)?.textContent).toBe("12");

      // An agent takes the session: the roster is fresher than the snapshot and
      // the row has to say so.
      bay.frame("agents", { agents: [holder()] });
      expect(bay.el(`session-status-${HELD_SESSION}`)?.textContent).toBe("Live (agent)");

      // And it has to stop saying so when the process ends.
      bay.frame("agents", { agents: [holder({ state: "stopped" })] });
      expect(bay.el(`session-status-${HELD_SESSION}`)?.textContent).toBe("Dormant");

      // A fresh index answer still moves the count the index owns.
      bay.frame("sessions", {
        sessions: HELD_INDEX.map(row => (row.id === HELD_SESSION ? { ...row, messageCount: 41 } : row)),
      });
      expect(bay.el(`session-messages-${HELD_SESSION}`)?.textContent).toBe("41");
    } finally {
      bay.unmount();
    }
  });

  test("a row the index has never seen is still listed, and says what it does not know", () => {
    // The rows that used to carry a live transcript count. They exist because
    // hiding an agent someone just made would be worse than listing it, and
    // the two numbers the index owns are the two this row cannot answer.
    const fresh = "agt_fresh" as AgentId;
    const bay = mountBay([]);
    try {
      bay.frame("agents", { agents: [holder({ id: fresh, acpSessionId: undefined, name: "Fresh" })] });
      expect(bay.el(`session-row-${fresh}`)).not.toBeNull();
      expect(bay.el(`session-status-${fresh}`)?.textContent).toBe("Live (agent)");
      expect(bay.el(`session-messages-${fresh}`)?.textContent).toBe("0");

      resetCounts();
      bay.frame("update", {
        agentId: fresh,
        seq: 1,
        update: { sessionUpdate: "agent_message_chunk", messageId: "m_1", content: { type: "text", text: "hi" } },
      });
      // Even here, with the row on screen and the frame addressed to it, the
      // transcript does not reach the list. That is the trade the counts above
      // are bought with, and it is a number the index owns, not this device.
      expect(listCost()).toEqual({ rowBuilds: 0, reloads: 0, rowRenders: 0, rowMounts: 0 });
      expect(bay.el(`session-messages-${fresh}`)?.textContent).toBe("0");
    } finally {
      bay.unmount();
    }
  });
});
