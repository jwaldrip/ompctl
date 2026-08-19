/**
 * What one navigation costs, counted rather than felt.
 *
 * The operator's report was "naving is slow", measured on a phone as seconds
 * between a tap and an interactive terminal, and more seconds still on the way
 * back. A screen-by-screen walkthrough cannot tell a refetch from a re-render,
 * so this file instruments the two things a round trip could plausibly pay
 * for: index requests the client sends, and renders the bay's list pays. The
 * shell, the hook, and the socket wiring are real; the socket is canned.
 *
 * ## The contract these counts defend
 *
 * The index is a snapshot the client asked for once per pairing, and the list
 * is already holding it, so a push or a pop has nothing to ask the daemon for
 * and nothing to rebuild in the bay: zero index asks, zero list mounts, and
 * zero row renders per navigation. A count above zero is not a style problem;
 * it is the phone's missing seconds.
 */

import "./rnw.ts";

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { SessionRowProps } from "../src/components/SessionRow.tsx";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import type { FleetScreenProps } from "../src/screens/FleetScreen.tsx";
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
};

function resetCounts(): void {
  counts.fleetMounts = 0;
  counts.fleetUnmounts = 0;
  counts.fleetRenders = 0;
  counts.rowMounts = 0;
  counts.rowUnmounts = 0;
  counts.rowRenders = 0;
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
