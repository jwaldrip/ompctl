/**
 * A routine run's sessions, opened the way every other session is opened.
 *
 * The screen suite in `routines-screen.test.tsx` proves what a run history
 * renders and which session id each link hands over. This one proves the half
 * that only the shell can answer: that the id goes through the console's own
 * resolver, so a link lands on the surface the session index says holds it, and
 * that the routine's own place on screen survives the trip.
 *
 * The client is canned and the shell is real, the same split `nav-shell.test.tsx`
 * uses. `Console` hands the routines screen its `createClient`, so one canned
 * client serves both the console's socket and the routines screen's own.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent, AgentId, RemoteRoutine, Run, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic, the same reason every other shell suite does it: bun evaluates a
// file's whole static import graph before its body runs, so a static import of
// the console would pull the real `react-native` in before `./rnw.ts` could
// substitute it.
const { Console } = await import("../src/console/Console.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetWindowSize();
});

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

const ROUTINE: RemoteRoutine = {
  id: "rtn_brief",
  name: "Morning brief",
  enabled: true,
  trigger: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  actions: [
    { id: "gather", name: "Gather", prompt: "gather the facts", cwd: "/work", labels: {} },
    { id: "render", name: "Render", prompt: "render the brief", cwd: "/work", labels: {} },
  ],
  singleton: false,
  labels: {},
  createdAt: "2026-08-19T00:00:00.000Z",
};

/** One run whose two actions opened two different sessions. */
function run(overrides: { first?: string | undefined; second?: string | undefined } = {}): Run {
  const first = "first" in overrides ? overrides.first : "sess_gather";
  const second = "second" in overrides ? overrides.second : "sess_render";
  return {
    id: "run_1",
    routineId: ROUTINE.id,
    state: "succeeded",
    startedAt: "2026-08-19T09:00:00.000Z",
    finishedAt: "2026-08-19T09:00:20.000Z",
    actions: [
      {
        actionId: "gather",
        actionName: "Gather",
        index: 0,
        state: "succeeded",
        summary: "gathered",
        startedAt: "2026-08-19T09:00:00.000Z",
        finishedAt: "2026-08-19T09:00:10.000Z",
        ...(first === undefined ? {} : { sessionId: first }),
      },
      {
        actionId: "render",
        actionName: "Render",
        index: 1,
        state: "succeeded",
        summary: "rendered",
        startedAt: "2026-08-19T09:00:10.000Z",
        finishedAt: "2026-08-19T09:00:20.000Z",
        ...(second === undefined ? {} : { sessionId: second }),
      },
    ],
  };
}

function agent(id: AgentId, sessionId: string, name: string): Agent {
  return {
    id,
    name,
    state: "idle",
    acpSessionId: sessionId,
    host: { kind: "local", id: "42", spec: { kind: "local" } },
    cwd: "/work",
    createdAt: "2026-08-19T09:00:00.000Z",
    lastActiveAt: "2026-08-19T09:00:10.000Z",
    labels: {},
  };
}

function summary(id: string, status: SessionSummary["status"]): SessionSummary {
  return {
    id,
    title: `session ${id}`,
    cwd: "/work",
    cwdScope: "home",
    flattenedDir: "-work",
    status,
    createdAt: "2026-08-19T09:00:00.000Z",
    lastActivityAt: "2026-08-19T09:00:10.000Z",
    messageCount: 3,
    byteSize: 2_048,
    archived: false,
    ...(status === "live-tui" ? { pid: 4_242 } : {}),
  };
}

/**
 * The client surface both the console and the routines screen touch, canned.
 * Every call a test asserts on is recorded rather than ignored, and the collab
 * join answers the way an omp without the collab API does, so a live terminal
 * open lands on the local steer surface the shell already has a route for.
 */
class CannedClient {
  readonly attached: AgentId[] = [];
  readonly collabOpens: string[] = [];
  readonly resumes: Array<{ sessionId: string; cwd: string }> = [];
  readonly histories: Array<{ agentId: AgentId; sessionId: string }> = [];
  readonly tails: string[] = [];
  readonly routineReads: number[] = [];
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
  attach(agentId: AgentId): void {
    this.attached.push(agentId);
  }
  listSessions(): void {}
  openCollab(sessionId: string): void {
    this.collabOpens.push(sessionId);
    this.emit("error", {
      code: "collab_unavailable",
      sessionId,
      message: "this omp build cannot host a collab room",
    });
  }
  leaveCollab(): void {}
  sessionTail(sessionId: string): void {
    this.tails.push(sessionId);
  }
  sessionHistory(agentId: AgentId, sessionId: string): void {
    this.histories.push({ agentId, sessionId });
  }
  sessionPrompt(): void {}
  resumeSession(sessionId: string, cwd: string): void {
    this.resumes.push({ sessionId, cwd });
  }
  deleteSessions(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  readRoutines(): void {
    this.routineReads.push(this.routineReads.length + 1);
  }
  writeRoutine(): void {}
  runRoutine(): void {}
  deleteRoutines(): void {}
  rotateRoutineSecret(): void {}
}

interface Shell {
  host: HTMLElement;
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  emit: (name: string, event: unknown) => void;
  unmount: () => void;
}

/**
 * The real shell over a canned socket, already connected, then walked to the
 * routines route through the menu the way a thumb reaches it.
 */
function mountRoutines(options: {
  rows?: readonly SessionSummary[];
  agents?: readonly Agent[];
  runs?: readonly Run[];
}): Shell {
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

  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  const press = (testID: string): void => {
    const target = el(testID);
    if (target === null) throw new Error(`no ${testID} control rendered`);
    act(() => {
      target.click();
    });
  };
  const emit = (name: string, event: unknown): void => {
    act(() => {
      client.emit(name, event);
    });
  };

  emit("status", { state: "connected", attempt: 0 });
  emit("sessions", { sessions: options.rows ?? [] });
  emit("agents", { agents: options.agents ?? [], scopes: CONNECTION.scopes });

  press("open-menu");
  press("menu-routines");
  emit("routines", { routines: [ROUTINE], runs: options.runs ?? [run()] });

  return {
    host,
    client,
    el,
    press,
    emit,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("a run's linked session opens through the console's own resolver", () => {
  test("an owned session opens the agent log, not the terminal surface", () => {
    const shell = mountRoutines({
      rows: [summary("sess_gather", "live-ompd"), summary("sess_render", "live-tui")],
      agents: [agent("agt_gather", "sess_gather", "Gather")],
    });
    try {
      shell.press("run-run_1-toggle");
      shell.press("run-run_1-action-gather-open");
      shell.emit("session_history", {
        agentId: "agt_gather",
        sessionId: "sess_gather",
        entries: [],
        nextBefore: null,
      });

      // The roster holds this session with a live agent, so the resolver's
      // answer is that agent and the open is an attach. A terminal surface
      // here would mean the index's status had decided it instead.
      expect(shell.client.attached).toEqual(["agt_gather"]);
      expect(shell.el("session")).not.toBeNull();
      expect(shell.el("terminal-session")).toBeNull();
      expect(shell.client.collabOpens).toEqual([]);
    } finally {
      shell.unmount();
    }
  });

  test("a co-driven session opens the terminal surface, not the agent log", () => {
    const shell = mountRoutines({
      rows: [summary("sess_gather", "live-ompd"), summary("sess_render", "live-tui")],
      agents: [agent("agt_gather", "sess_gather", "Gather")],
    });
    try {
      shell.press("run-run_1-toggle");
      shell.press("run-run_1-action-render-open");

      // Nothing in the roster holds this one and the index calls it live-tui,
      // so it is joined as a guest first. This canned daemon cannot host a
      // collab room, which is the answer that falls back to the local steer
      // surface, and either way it is never an attach.
      expect(shell.client.collabOpens).toEqual(["sess_render"]);
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.el("session")).toBeNull();
      expect(shell.client.attached).toEqual([]);
    } finally {
      shell.unmount();
    }
  });

  test("a session the index no longer describes reads as unavailable and the screen survives", () => {
    const shell = mountRoutines({ rows: [], agents: [] });
    try {
      shell.press("run-run_1-toggle");
      shell.press("run-run_1-action-gather-open");

      // No index row and no agent: there is nothing for the daemon to verify a
      // claim against, so the console says so rather than sending a frame that
      // cannot land.
      expect(shell.el("toast")?.textContent).toContain("no record the daemon can verify");
      expect(shell.client.attached).toEqual([]);
      expect(shell.client.resumes).toEqual([]);
      expect(shell.client.collabOpens).toEqual([]);
      // The point of the case: the run history is still on screen and still
      // showing the run whose link could not be honoured.
      expect(shell.el("routines-screen")).not.toBeNull();
      expect(shell.el("run-run_1-action-gather-open")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a dormant session opens through a resume claim carrying the index's own directory", () => {
    const shell = mountRoutines({ rows: [summary("sess_gather", "dormant")], agents: [] });
    try {
      shell.press("run-run_1-toggle");
      shell.press("run-run_1-action-gather-open");

      expect(shell.client.resumes).toEqual([{ sessionId: "sess_gather", cwd: "/work" }]);
      expect(shell.client.attached).toEqual([]);
    } finally {
      shell.unmount();
    }
  });
});

describe("switching between two of a run's sessions keeps them apart", () => {
  test("opening the second session then the first shows the first's transcript alone", () => {
    const shell = mountRoutines({
      rows: [summary("sess_gather", "live-ompd"), summary("sess_render", "live-ompd")],
      agents: [agent("agt_gather", "sess_gather", "Gather"), agent("agt_render", "sess_render", "Render")],
    });
    try {
      shell.press("run-run_1-toggle");

      shell.press("run-run_1-action-render-open");
      shell.emit("session_history", { agentId: "agt_render", sessionId: "sess_render", entries: [], nextBefore: null });
      shell.emit("update", {
        agentId: "agt_render",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "render the brief" },
          messageId: "u_render",
        },
      });
      expect(shell.host.textContent).toContain("render the brief");

      shell.press("session-back");

      shell.press("run-run_1-action-gather-open");
      shell.emit("session_history", { agentId: "agt_gather", sessionId: "sess_gather", entries: [], nextBefore: null });
      shell.emit("update", {
        agentId: "agt_gather",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "gather the facts" },
          messageId: "u_gather",
        },
      });

      // Each screen is keyed on its agent, so the second open builds a new one
      // rather than re-rendering the first with a different target.
      expect(shell.host.textContent).toContain("gather the facts");
      expect(shell.host.textContent).not.toContain("render the brief");
    } finally {
      shell.unmount();
    }
  });
});

describe("the routine keeps its place while one of its sessions is open", () => {
  test("coming back finds the same run still open, on a phone", () => {
    const shell = mountRoutines({
      rows: [summary("sess_gather", "live-ompd")],
      agents: [agent("agt_gather", "sess_gather", "Gather")],
    });
    try {
      shell.press("run-run_1-toggle");
      expect(shell.el("run-run_1-action-gather-open")).not.toBeNull();

      shell.press("run-run_1-action-gather-open");
      shell.emit("session_history", { agentId: "agt_gather", sessionId: "sess_gather", entries: [], nextBefore: null });
      expect(shell.el("session")).not.toBeNull();

      shell.press("session-back");

      // The routines route was pushed under the session route rather than
      // replaced, so its own state came back with it: the run whose link was
      // tapped is still the open one, and the screen never returned to its
      // loading state.
      expect(shell.el("routines-screen")).not.toBeNull();
      expect(shell.el("run-run_1-action-gather-open")).not.toBeNull();
      expect(shell.el("session")).toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("on a tablet the stack presents the session, because the pane beside the list is buried", () => {
    setWindowSize(1024, 1366);
    const shell = mountRoutines({
      rows: [summary("sess_gather", "live-ompd")],
      agents: [agent("agt_gather", "sess_gather", "Gather")],
    });
    try {
      shell.press("run-run_1-toggle");
      shell.press("run-run_1-action-gather-open");
      shell.emit("session_history", { agentId: "agt_gather", sessionId: "sess_gather", entries: [], nextBefore: null });

      // A tablet normally shows the detail in the fleet's own split pane, and
      // that pane is behind this full-screen route: without the shell taking
      // the selection here, the tap would have changed nothing on screen.
      expect(shell.el("session")).not.toBeNull();
      // Exactly one, never one per surface: two screens over one agent would
      // both claim that agent's WebView target.
      expect(shell.host.querySelectorAll('[data-testid="session"]')).toHaveLength(1);

      shell.press("session-back");
      expect(shell.el("routines-screen")).not.toBeNull();
      expect(shell.el("run-run_1-action-gather-open")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });
});
