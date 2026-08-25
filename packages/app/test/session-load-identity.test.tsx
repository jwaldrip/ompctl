/**
 * The three things the merged loading machine got wrong, driven through the
 * surface an operator touches.
 *
 * Each of these was confirmed against `d3f92c1` before it was written, and
 * each fails there: a terminal row refused locally left the previous session
 * on screen behind a toast; a socket drop mid-open left the pane spinning with
 * nothing able to end it; and the context band rebuilt the whole subagent
 * forest on every frame of every streaming turn.
 *
 * The render cost is counted rather than felt, the same way `nav-latency`
 * counts it: the real branch component is wrapped so every render attempt the
 * app would pay is an attempt this file sees. A count above zero while the
 * roster holds still is the per-frame rebuild, not a style preference.
 */

import "./rnw.ts";

import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Agent, AgentId, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The forest builders are real; only their module bindings are wrapped, so
// every call this file counts is a call the app itself would make. Frozen
// before the mock registers, exactly as `nav-latency.test.tsx` does it: bun
// patches the cached namespace in place, so reading an export after the mock
// would return the wrapper and the wrapper would call itself forever.
//
// Counting the builders rather than the rendered rows is deliberate. A render
// counter would have to sit in a wrapper component, and a wrapper is itself
// re-rendered by every parent commit whether or not the memoised child under
// it does any work, so it measures the wrong thing. The defect under test is
// the rebuild: walking the roster, allocating a node per agent and DFSing for
// this session's, once per streaming frame.
const realHub = await import("../src/components/AgentHub.tsx");
const RealSubagentsOf = realHub.subagentsOf;
const RealAgentHubTree = realHub.agentHubTree;

/** Forest builds since the last reset. */
const builds = { subagentsOf: 0, agentHubTree: 0 };

mock.module("../src/components/AgentHub.tsx", () => ({
  ...realHub,
  subagentsOf: (agents: readonly Agent[], parentId: string) => {
    builds.subagentsOf += 1;
    return RealSubagentsOf(agents, parentId);
  },
  agentHubTree: (agents: readonly Agent[]) => {
    builds.agentHubTree += 1;
    return RealAgentHubTree(agents);
  },
}));

const { Console } = await import("../src/console/Console.tsx");

afterEach(() => {
  resetWindowSize();
  builds.subagentsOf = 0;
  builds.agentHubTree = 0;
});

const HOST = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };

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

function tuiRow(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    cwdScope: "home",
    flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
    status: "live-tui",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActivityAt: "2026-08-24T11:59:00.000Z",
    messageCount: 3,
    byteSize: 2_048,
    archived: false,
    pid: 4_242,
  };
}

const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [
    {
      id: "local",
      label: "Studio Mac",
      connection: { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket", token: "tok_1", scopes: [] },
    },
  ],
};

/** The slice of the client surface `useConsole` touches, canned. */
class CannedClient {
  readonly collabOpens: string[] = [];
  readonly histories: Array<{ agentId: AgentId; sessionId: string }> = [];
  readonly tails: string[] = [];
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
  openCollab(sessionId: string): void {
    this.collabOpens.push(sessionId);
  }
  leaveCollab(): void {}
  sessionTail(sessionId: string): void {
    this.tails.push(sessionId);
  }
  sessionHistory(agentId: AgentId, sessionId: string): void {
    this.histories.push({ agentId, sessionId });
  }
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
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  detailText: () => string;
  press: (testID: string) => void;
  emit: (name: string, event: unknown) => void;
  unmount: () => void;
}

/** `scopes` is the pairing's own claim, which is what the read gate reads. */
function mountShell(scopes: readonly string[] = ["read", "prompt", "approve", "manage"]): Shell {
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const connection: Connection = {
    transport: "direct",
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_1",
    scopes: [...scopes],
  };
  act(() => {
    root.render(
      <Console
        connection={connection}
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
  });
  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  return {
    client,
    el,
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

const ALPHA: Agent[] = [agent("agt_a", { name: "Alpha", acpSessionId: "sess_a" })];

/** Opens Alpha and settles it, so every test below starts with A on screen. */
function withAlphaOnScreen(shell: Shell): void {
  shell.emit("agents", { agents: ALPHA });
  shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
  shell.emit("update", {
    agentId: "agt_a",
    seq: 1,
    update: { sessionUpdate: "plan", entries: [{ content: "Alpha's only todo", status: "in_progress" }] },
  });
}

// ---------------------------------------------------------------------------
// Blocker 1
// ---------------------------------------------------------------------------

describe("a terminal row this device may not read still commits its own pane", () => {
  test("the refusal renders under that terminal, and the previous session leaves the screen", () => {
    setWindowSize(1024, 1366);
    // A pairing that provably holds no read scope: the gate is local, so the
    // daemon is never asked and there is no addressed error to come back.
    const shell = mountShell(["prompt"]);
    try {
      withAlphaOnScreen(shell);
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
      expect(shell.detailText()).toContain("Alpha's only todo");

      shell.press("session-open-sess_tui");

      // The pane is the pressed row's, wearing the pressed row's refusal.
      // Before this it stayed on Alpha and raised a toast, so the operator's
      // tap read as having done nothing.
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.el("terminal-title")?.textContent).toBe("terminal work");
      expect(shell.el("session-load-failed-title")?.textContent).toBe("terminal work");
      expect(shell.el("session-load-failed-message")?.textContent).toContain("does not hold the read scope");
      expect(shell.el("session")).toBeNull();
      expect(shell.detailText()).not.toContain("Alpha's only todo");

      // And no frame left the device for a session it may not read.
      expect(shell.client.collabOpens).toHaveLength(0);
      expect(shell.client.tails).toHaveLength(0);
    } finally {
      shell.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Blocker 2
// ---------------------------------------------------------------------------

describe("a link lost mid-open never leaves a pane spinning", () => {
  test("a terminal open stalls on the drop, is re-asked on reconnect, and settles on the tail", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      withAlphaOnScreen(shell);
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
      shell.press("session-open-sess_tui");
      expect(shell.el("session-loading")).not.toBeNull();
      expect(shell.client.collabOpens).toEqual(["sess_tui"]);

      // The socket goes before the join is answered. The wait promised an
      // answer that is no longer coming, so it stalls rather than spins.
      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 1_000 });
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.el("session-load-stalled-title")?.textContent).toBe("terminal work");
      expect(shell.el("session-load-stalled-detail")?.textContent).toBe("Reconnecting, then asking again.");
      // A flap is not a refusal, and must not wear one.
      expect(shell.el("session-load-failed")).toBeNull();
      // Alpha does not come back. The pane stays the row the operator pressed.
      expect(shell.detailText()).not.toContain("Alpha's only todo");

      // The reconnect re-asks. `collab_open` is the one frame the client
      // itself documents as answering with the agent the daemon already
      // co-drives, so re-sending it is safe.
      shell.emit("status", { state: "connected", attempt: 0 });
      expect(shell.client.collabOpens).toEqual(["sess_tui", "sess_tui"]);
      expect(shell.el("session-loading")).not.toBeNull();
      expect(shell.el("session-load-stalled")).toBeNull();

      // And the answer settles it, as it always did.
      shell.emit("error", {
        code: "collab_unavailable",
        sessionId: "sess_tui",
        message: "this omp build cannot host a collab room",
      });
      shell.emit("session_tail", { sessionId: "sess_tui", messages: [], truncated: false });
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.el("session-load-stalled")).toBeNull();
      expect(shell.el("terminal-transcript-limit")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a refusal arriving after a stall is still the answer, and still fails that pane", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
      shell.press("session-open-sess_tui");
      shell.emit("status", { state: "offline", attempt: 3 });
      expect(shell.el("session-load-stalled-detail")?.textContent).toBe(
        "No link. This session is asked for again as soon as there is one.",
      );

      // The reconnect re-asks while the pane is still stalled, which is the
      // point; the refusal then arrives on the new socket.
      shell.emit("status", { state: "connected", attempt: 0 });
      shell.emit("error", { code: "collab_refused", sessionId: "sess_tui", message: "The host declined the join." });
      expect(shell.el("session-load-failed-message")?.textContent).toBe("The host declined the join.");
      const asksAtRefusal = shell.client.collabOpens.length;

      // A refusal survives every later flap: it is a verdict the operator has
      // to act on, not a condition the reconnect clears. Re-arming it would
      // turn each drop into a spinner over an answer already given, and would
      // re-ask the host that already said no.
      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 500 });
      shell.emit("status", { state: "connected", attempt: 0 });
      expect(shell.el("session-load-failed-message")?.textContent).toBe("The host declined the join.");
      expect(shell.el("session-load-stalled")).toBeNull();
      expect(shell.client.collabOpens).toHaveLength(asksAtRefusal);
    } finally {
      shell.unmount();
    }
  });

  test("a session log's stalled open re-asks for its history page, and settles on it", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: [...ALPHA, agent("agt_b", { name: "Bravo", acpSessionId: "sess_b" })] });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      shell.press("session-open-sess_b");
      expect(shell.el("session-loading-title")?.textContent).toBe("Bravo");

      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 1_000 });
      expect(shell.el("session-load-stalled-title")?.textContent).toBe("Bravo");

      // The history page is not replayed by the client, so the console must
      // ask again itself. The guard that skips a duplicate ask has to have
      // been cleared by the drop, or this re-ask would be swallowed.
      shell.emit("status", { state: "connected", attempt: 0 });
      expect(shell.client.histories.filter(entry => entry.agentId === "agt_b")).toHaveLength(2);
      expect(shell.el("session-loading-title")?.textContent).toBe("Bravo");

      shell.emit("session_history", { agentId: "agt_b", sessionId: "sess_b", entries: [], nextBefore: null });
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.el("aui-messages")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a session with no file on disk never waits, so a drop has nothing to stall", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      // No `acpSessionId`: no history page is asked for, so no wait is armed.
      // That is what keeps the stall path free of a subject it could never
      // re-ask for -- the attach the client replays on its own is everything
      // such a pane was ever owed.
      shell.emit("agents", { agents: [agent("agt_new", { name: "Fresh" })] });
      shell.press("session-open-agt_new");
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.el("aui-messages")).not.toBeNull();

      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 1_000 });
      shell.emit("status", { state: "connected", attempt: 0 });
      expect(shell.el("session-load-stalled")).toBeNull();
      expect(shell.el("session-load-failed")).toBeNull();
      expect(shell.el("aui-messages")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a drop with nothing open changes no load, so a healthy console pays nothing", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      withAlphaOnScreen(shell);
      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 1_000 });
      // Alpha is settled, not waiting: a flap must not blank a log that is on
      // screen and correct.
      expect(shell.el("session-load-stalled")).toBeNull();
      expect(shell.el("session-loading")).toBeNull();
      expect(shell.detailText()).toContain("Alpha's only todo");
    } finally {
      shell.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Blocker 3
// ---------------------------------------------------------------------------

describe("a streaming turn does not rebuild the subagent forest", () => {
  test("frames arriving against an unchanged roster cost zero forest builds", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      const roster: Agent[] = [
        agent("agt_a", { name: "Alpha", acpSessionId: "sess_a" }),
        agent("agt_a:sub:1", { name: "Scout", parentAgentId: "agt_a", acpSessionId: "s1" }),
        agent("agt_a:sub:2", { name: "Reviewer", parentAgentId: "agt_a:sub:1", acpSessionId: "s2" }),
      ];
      shell.emit("agents", { agents: roster });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      expect(shell.el("session-context-subagents")).not.toBeNull();

      // The band is on screen and its rows have rendered. From here the
      // roster holds still, which is what it does for minutes at a time while
      // a turn streams.
      builds.subagentsOf = 0;
      builds.agentHubTree = 0;
      for (let seq = 2; seq < 22; seq += 1) {
        shell.emit("update", {
          agentId: "agt_a",
          seq,
          update: { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "tok " } },
        });
      }

      // Twenty frames of a live turn. Unmemoised, each one walked the roster,
      // allocated a node per agent and DFSed for this session's, then handed
      // every branch a fresh object so the rows re-rendered too.
      expect(builds.subagentsOf).toBe(0);
      expect(builds.agentHubTree).toBe(0);
      // And the rows are still there: zero builds because nothing changed,
      // not because the section vanished.
      expect(shell.el("agent-hub-agt_a:sub:1")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a roster change still re-renders, so the memo cannot hide a real one", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      const scout = agent("agt_a:sub:1", { name: "Scout", parentAgentId: "agt_a", acpSessionId: "s1" });
      shell.emit("agents", { agents: [...ALPHA, scout] });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      builds.subagentsOf = 0;

      shell.emit("agents", { agents: [...ALPHA, { ...scout, state: "stopped" as const }] });
      expect(builds.subagentsOf).toBeGreaterThan(0);
      expect(shell.el("agent-hub-agt_a:sub:1")?.textContent).toContain("stopped");
    } finally {
      shell.unmount();
    }
  });
});
