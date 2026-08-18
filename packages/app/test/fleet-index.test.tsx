/**
 * The Fleet index wiring: canned `sessions` frames becoming rendered rows,
 * the live roster overlaid onto them, and a live-tui row's open landing on
 * the takeover path.
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
import { apply, browserSessionsOf, emptyConsole, openSessionTarget } from "../src/console/state.ts";
import type { ConsoleActions } from "../src/console/useConsole.ts";
import type { Connection } from "../src/platform/connection.ts";
import type { BrowserState } from "../src/session/browser.ts";
import { browserReduce, EMPTY_BROWSER } from "../src/session/browser.ts";

// Dynamic on purpose, same reason as `fleet-screen.test.tsx`: these modules
// import "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { takeOverLiveTui, useConsole } = await import("../src/console/useConsole.ts");

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
      onTakeover={() => {}}
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
    expect(html).toContain("Attach session s-a2");
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
});

// ---------------------------------------------------------------------------
// Opening a live-tui row drives the takeover
// ---------------------------------------------------------------------------

describe("opening a live-tui row resolves to the takeover", () => {
  const INDEX: SessionSummary[] = [
    summary("s-tui", { cwd: DIR_A, flattenedDir: "-alpha", status: "live-tui", pid: 4242 }),
    summary("s-ompd", { cwd: DIR_A, flattenedDir: "-alpha", status: "live-ompd", agentId: "agt_late" }),
    summary("s-dormant", { cwd: DIR_B, flattenedDir: "-beta", status: "dormant" }),
  ];

  test("a row only the daemon's index knows about becomes a live-tui target", () => {
    const target = openSessionTarget(drive([{ t: "sessions", event: { sessions: INDEX } }]), "s-tui");
    expect(target).toEqual({ sessionId: "s-tui", agentId: undefined, liveTui: true });
  });

  test("a row the roster holds resolves to that agent, the way live-ompd opens", () => {
    const state = drive([
      { t: "sessions", event: { sessions: INDEX } },
      { t: "agents", event: { agents: [agent("agt_here", { acpSessionId: "s-tui" })] } },
    ]);
    expect(openSessionTarget(state, "s-tui")).toEqual({
      sessionId: "s-tui",
      agentId: "agt_here",
      liveTui: false,
    });
  });

  test("a row only the index's agentId names resolves to that agent", () => {
    const target = openSessionTarget(drive([{ t: "sessions", event: { sessions: INDEX } }]), "s-ompd");
    expect(target).toEqual({ sessionId: "s-ompd", agentId: "agt_late", liveTui: false });
  });

  test("the takeover POSTs the daemon's takeover route for that session id", async () => {
    const adopted = agent("agt_adopted", { acpSessionId: "s-tui" });
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const result = await takeOverLiveTui("s-tui", {
      root: "http://127.0.0.1:7777",
      token: "tok_1",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ agent: adopted }), { status: 201 });
      },
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:7777/v1/sessions/s-tui/takeover",
        init: { method: "POST", headers: { Authorization: "Bearer tok_1" } },
      },
    ]);
    expect(result.id).toBe("agt_adopted");
  });

  test("a relayed connection, with no HTTP root, says so instead of guessing a route", async () => {
    await expect(takeOverLiveTui("s-tui", { root: null, token: "tok_1" })).rejects.toThrow(
      /relayed connection cannot reach/,
    );
  });

  test("the daemon's refusal is the error the operator sees", async () => {
    await expect(
      takeOverLiveTui("s-tui", {
        root: "http://127.0.0.1:7777",
        token: "tok_1",
        fetch: async () =>
          new Response(JSON.stringify({ error: "no connected TUI owns session s-tui" }), { status: 409 }),
      }),
    ).rejects.toThrow("no connected TUI owns session s-tui");
  });

  test("the adopted agent is admitted and selected, so the open lands", () => {
    const admitted = drive([
      { t: "sessions", event: { sessions: INDEX } },
      { t: "agent_admitted", agent: agent("agt_adopted", { acpSessionId: "s-tui" }) },
      { t: "select", agentId: "agt_adopted" },
    ]);
    expect(admitted.agents.map(entry => entry.id)).toContain("agt_adopted");
    expect(admitted.selected).toBe("agt_adopted");
    // A second admission of the same agent changes nothing; the roster stays
    // the authority.
    expect(apply(admitted, { t: "agent_admitted", agent: admitted.agents[0] as Agent })).toBe(admitted);
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

/** Let a takeover's promise chain run to completion inside act(). */
async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
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

describe("useConsole opens a row through its holder or the takeover", () => {
  test("a row with a holder attaches to that agent, the live-ompd open", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { sessionId: "s-held", agentId: "agt_here", liveTui: false };
      act(() => {
        mounted.actions().openSession(target);
      });
      expect(mounted.client.attached).toEqual([{ agentId: "agt_here", options: { sinceSeq: 0 } }]);
      expect(mounted.state().selected).toBe("agt_here");
    } finally {
      mounted.unmount();
    }
  });

  test("a live-tui row takes over, admits the adopted agent, and opens it", async () => {
    const originalFetch = globalThis.fetch;
    const adopted = agent("agt_adopted", { acpSessionId: "s-tui" });
    const urls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({ agent: adopted }), { status: 201 });
    }) as unknown as typeof fetch;
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { sessionId: "s-tui", agentId: undefined, liveTui: true };
      mounted.actions().openSession(target);
      await settle();
      expect(urls).toEqual(["http://127.0.0.1:7777/v1/sessions/s-tui/takeover"]);
      expect(mounted.state().agents.map(entry => entry.id)).toContain("agt_adopted");
      expect(mounted.state().selected).toBe("agt_adopted");
      expect(mounted.client.attached).toEqual([{ agentId: "agt_adopted", options: { sinceSeq: 0 } }]);
    } finally {
      mounted.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("a takeover the daemon refuses becomes a notice, not a silent tap", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "no connected TUI owns session s-tui" }), {
        status: 409,
      })) as unknown as typeof fetch;
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { sessionId: "s-tui", agentId: undefined, liveTui: true };
      mounted.actions().openSession(target);
      await settle();
      expect(mounted.state().notice).toBe("no connected TUI owns session s-tui");
      expect(mounted.state().selected).toBeNull();
      expect(mounted.client.attached).toHaveLength(0);
    } finally {
      mounted.unmount();
      globalThis.fetch = originalFetch;
    }
  });

  test("a dormant row answers honestly that this build cannot resume it", () => {
    const mounted = mountConsole();
    try {
      const target: SessionOpenTarget = { sessionId: "s-dormant", agentId: undefined, liveTui: false };
      act(() => {
        mounted.actions().openSession(target);
      });
      expect(mounted.state().notice).toContain("dormant");
      expect(mounted.client.attached).toHaveLength(0);
    } finally {
      mounted.unmount();
    }
  });
});
