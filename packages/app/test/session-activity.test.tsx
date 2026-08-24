/**
 * "I can't tell the agent is working."
 *
 * The derivation is driven directly, because precedence is the design and a
 * table is the honest way to pin it. The transitions are driven through the
 * real `Console` over a canned socket with the frames a daemon actually sends,
 * because "the header changes when a tool starts" is a claim about the whole
 * composition and a component rendered from a hand-built prop cannot make it.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic, same reason every rendering test here is: bun binds a file's whole
// static import graph before its body runs, so a static import would pull the
// real `react-native` in before `./rnw.ts` substitutes `react-native-web`.
const { agentActivity, tuiActivity } = await import("../src/session/activity.ts");
const { EMPTY_SESSION, reduce } = await import("../src/session/model.ts");
const { READY_LOAD } = await import("../src/console/state.ts");
const { ActivityPip } = await import("../src/components/ActivityPip.tsx");
const { Console } = await import("../src/console/Console.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetWindowSize();
});

const HOST = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };
const STALLED = { phase: "stalled" as const, generation: 1, error: null };
const FAILED = { phase: "failed" as const, generation: 1, error: "refused" };

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id,
    state: "idle",
    host: HOST,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActiveAt: "2026-08-24T11:59:00.000Z",
    labels: {},
    ...overrides,
  };
}

const EMPTY_TUI = {
  sent: null,
  busy: false,
  awaitingReply: false,
  reply: null,
  replyUnavailable: false,
  refusal: null,
  refusalKind: null,
  history: [],
  historyCursor: null,
  historyLoadingEarlier: false,
} as const;

// ---------------------------------------------------------------------------
// The derivation, and its precedence
// ---------------------------------------------------------------------------

describe("an owned session's activity is derived from state that already exists", () => {
  test("an idle connected session is ready, and nothing moves", () => {
    const result = agentActivity(agent("a"), EMPTY_SESSION, "connected", READY_LOAD);
    expect(result).toMatchObject({ kind: "ready", label: "Ready", live: false });
  });

  test("a busy agent with nothing named yet is working, and moves", () => {
    const result = agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", READY_LOAD);
    expect(result).toMatchObject({ kind: "working", label: "Working", live: true });
  });

  test("a streaming reply is working even before the roster catches up", () => {
    // The roster still says idle; the transcript is mid-stream. Either fact is
    // enough, which is what keeps the header honest across the window where a
    // roster snapshot is older than the turn it describes.
    const streaming = reduce(EMPTY_SESSION, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "thinking out loud" },
    });
    expect(agentActivity(agent("a"), streaming, "connected", READY_LOAD)).toMatchObject({
      kind: "working",
      live: true,
    });
  });

  test("one running tool is named by its kind, and several are counted", () => {
    let session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      title: "read src/secret.ts",
      status: "in_progress",
    });
    expect(agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD)).toMatchObject({
      kind: "running",
      label: "reading",
      live: true,
    });

    session = reduce(session, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      kind: "execute",
      title: "bash",
      status: "in_progress",
    });
    expect(agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD).label).toBe("2 tools");

    // One settles: back to naming the single kind still running.
    session = reduce(session, { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" });
    expect(agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD).label).toBe("reading");

    // Both settle: the agent is still busy, so working rather than ready.
    session = reduce(session, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    expect(agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD).label).toBe("Working");
  });

  test("two running calls of one kind still name that kind", () => {
    let session = EMPTY_SESSION;
    for (const id of ["t1", "t2"]) {
      session = reduce(session, { sessionUpdate: "tool_call", toolCallId: id, kind: "search", status: "in_progress" });
    }
    // Two of one kind has one honest answer, and it is not "2 tools" only
    // because the count is what a person cares about less than the verb.
    expect(agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD).label).toBe("2 tools");
  });

  test("a clearance outranks a running tool, because it is the one state about the operator", () => {
    let session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      status: "in_progress",
    });
    session = { ...session, pendingApprovals: [{ requestId: "r1", tool: "bash", title: "bash", input: {} }] };
    expect(agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD)).toMatchObject({
      kind: "waiting",
      label: "Waiting for you",
      live: false,
    });
  });

  test("a plan review is a decision too, and several are counted in the announcement", () => {
    const review = {
      ...EMPTY_SESSION,
      planReview: { requestId: "p1", message: "ok?", choices: ["Approve and execute"] as const },
      pendingApprovals: [{ requestId: "r1", tool: "bash", title: "bash", input: {} }],
    };
    expect(agentActivity(agent("a"), review, "connected", READY_LOAD).announcement).toBe(
      "Waiting for you, 2 decisions",
    );
  });

  test("the link outranks everything, in both directions", () => {
    const busy = agent("a", { state: "busy" });
    // A mid-turn session whose link dropped must not keep claiming to work:
    // whatever the last frame said may be minutes stale.
    expect(agentActivity(busy, EMPTY_SESSION, "offline", READY_LOAD)).toMatchObject({
      kind: "offline",
      live: false,
    });
    expect(agentActivity(busy, EMPTY_SESSION, "reconnecting", READY_LOAD)).toMatchObject({
      kind: "linking",
      live: false,
    });
    // A stalled pane is the same claim arriving from the load machine.
    expect(agentActivity(busy, EMPTY_SESSION, "connected", STALLED)).toMatchObject({ kind: "linking", live: false });
  });

  test("a real failure reads failed, from either producer", () => {
    expect(agentActivity(agent("a", { state: "failed" }), EMPTY_SESSION, "connected", READY_LOAD).kind).toBe("failed");
    expect(agentActivity(agent("a"), EMPTY_SESSION, "connected", FAILED).kind).toBe("failed");
  });

  test("a stopped agent is stopped, not ready and not working", () => {
    expect(agentActivity(agent("a", { state: "stopped" }), EMPTY_SESSION, "connected", READY_LOAD)).toMatchObject({
      kind: "stopped",
      live: false,
    });
  });

  test("provisioning and starting say so rather than claiming work", () => {
    for (const state of ["provisioning", "starting"] as const) {
      expect(agentActivity(agent("a", { state }), EMPTY_SESSION, "connected", READY_LOAD)).toMatchObject({
        kind: "linking",
        label: "Starting",
        live: false,
      });
    }
  });
});

describe("no tool argument ever reaches the label or the announcement", () => {
  test("a title carrying a command and a path is never quoted", () => {
    // omp builds ACP's `title` from the call's own arguments, so this is the
    // shape a real frame has. The header may say the kind and nothing else.
    const secret = "bash -c 'curl -H \"Authorization: Bearer sk-live-DEADBEEF\" https://x/y'";
    const session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      title: secret,
      rawInput: { command: secret },
      status: "in_progress",
    });
    const result = agentActivity(agent("a", { state: "busy" }), session, "connected", READY_LOAD);
    expect(result.label).toBe("running a command");
    for (const text of [result.label, result.announcement]) {
      expect(text).not.toContain("sk-live-DEADBEEF");
      expect(text).not.toContain("curl");
      expect(text).not.toContain("Authorization");
      expect(text).not.toContain(secret);
    }
  });
});

describe("a live terminal reports what its bridge actually sends", () => {
  test("idle, then working across the terminal's own turn boundaries", () => {
    expect(tuiActivity(EMPTY_TUI, "connected", READY_LOAD, true)).toMatchObject({ kind: "ready", live: false });
    expect(tuiActivity({ ...EMPTY_TUI, busy: true }, "connected", READY_LOAD, true)).toMatchObject({
      kind: "working",
      label: "Working",
      live: true,
    });
    // This device's own outstanding steer counts too: the operator pressed
    // send and the terminal has not taken the turn yet.
    expect(tuiActivity({ ...EMPTY_TUI, awaitingReply: true }, "connected", READY_LOAD, true).kind).toBe("working");
  });

  test("a terminal never claims a tool, because the bridge forwards none", () => {
    // The whole `TuiActivityKind` vocabulary is assistant_text, turn_start and
    // turn_end. A tool label here would be invented, so the narrower word is
    // the honest one and this pins it.
    const working = tuiActivity({ ...EMPTY_TUI, busy: true }, "connected", READY_LOAD, true);
    expect(working.label).toBe("Working");
    expect(working.announcement).toBe("Working in the terminal");
  });

  test("a refusal needs the operator; a dead terminal is not live; the link still outranks both", () => {
    expect(tuiActivity({ ...EMPTY_TUI, refusal: "no bridge" }, "connected", READY_LOAD, true).kind).toBe("waiting");
    expect(tuiActivity(EMPTY_TUI, "connected", READY_LOAD, false).kind).toBe("stopped");
    expect(tuiActivity({ ...EMPTY_TUI, busy: true }, "offline", READY_LOAD, true).kind).toBe("offline");
    expect(tuiActivity({ ...EMPTY_TUI, busy: true }, "connected", STALLED, true).kind).toBe("linking");
  });
});

// ---------------------------------------------------------------------------
// The rendered pip
// ---------------------------------------------------------------------------

interface Mounted {
  host: HTMLElement;
  el: (testID: string) => HTMLElement | null;
  render: (node: ReactNode) => void;
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
    render: next =>
      act(() => {
        root.render(next);
      }),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("the pip moves only while work is in flight", () => {
  test("working animates, and going idle stops it in the same commit", () => {
    const working = agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", READY_LOAD);
    const view = mount(<ActivityPip activity={working} reduceMotion={false} />);
    try {
      expect(view.el("session-activity-dot-lit")).not.toBeNull();

      const idle = agentActivity(agent("a"), EMPTY_SESSION, "connected", READY_LOAD);
      view.render(<ActivityPip activity={idle} reduceMotion={false} />);
      // No dots at all, not merely paused: the animated child unmounts, so its
      // interval is cleared rather than left ticking behind a static label.
      expect(view.el("session-activity-dot-lit")).toBeNull();
      expect(view.el("session-activity-dot")).not.toBeNull();
      expect(view.el("session-activity-label")?.textContent).toBe("Ready");
    } finally {
      view.unmount();
    }
  });

  test("reduced motion keeps the state and drops the movement", () => {
    const working = agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", READY_LOAD);
    const view = mount(<ActivityPip activity={working} reduceMotion />);
    try {
      expect(view.el("session-activity-dot-lit")).toBeNull();
      expect(view.el("session-activity-dot")).not.toBeNull();
      // The information survives; only the animation is gone.
      expect(view.el("session-activity-label")?.textContent).toBe("Working");
    } finally {
      view.unmount();
    }
  });

  test("compact keeps the dot and drops the word, for a phone header", () => {
    const working = agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", READY_LOAD);
    const view = mount(<ActivityPip activity={working} compact reduceMotion />);
    try {
      expect(view.el("session-activity")).not.toBeNull();
      expect(view.el("session-activity-label")).toBeNull();
      // Still readable to assistive technology, which never depended on the word.
      expect(view.el("session-activity")?.getAttribute("aria-label")).toBe("Working");
    } finally {
      view.unmount();
    }
  });

  test("the announcement is a live region, and it is polite rather than assertive", () => {
    const waiting = agentActivity(
      agent("a"),
      { ...EMPTY_SESSION, pendingApprovals: [{ requestId: "r", tool: "bash", title: "bash", input: {} }] },
      "connected",
      READY_LOAD,
    );
    const view = mount(<ActivityPip activity={waiting} reduceMotion />);
    try {
      const pip = view.el("session-activity");
      expect(pip?.getAttribute("aria-label")).toBe("Waiting for you");
      expect(pip?.getAttribute("aria-live")).toBe("polite");
    } finally {
      view.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Through the real console, on real frames
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
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  pipLabel: () => string | null;
  press: (testID: string) => void;
  emit: (name: string, event: unknown) => void;
  unmount: () => void;
}

function mountShell(): Shell {
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
  });
  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  return {
    client,
    el,
    pipLabel: () => el("session-activity")?.getAttribute("aria-label") ?? null,
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

const ROSTER: Agent[] = [agent("agt_a", { name: "Alpha", acpSessionId: "sess_a", state: "idle" })];

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

describe("the header follows a real turn, frame by frame", () => {
  test("idle to working to a named tool to waiting and back to idle", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: ROSTER });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      expect(shell.pipLabel()).toBe("Ready");

      // The roster says the turn started.
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      expect(shell.pipLabel()).toBe("Working");

      // A tool starts. The kind is named; the title, which carries the
      // command, is not.
      shell.emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "execute",
          title: "bash -c 'rm -rf /tmp/scratch'",
          status: "in_progress",
        },
      });
      expect(shell.pipLabel()).toBe("Working: running a command");
      expect(shell.pipLabel()).not.toContain("rm -rf");

      // It asks for a clearance, which outranks the work it is doing.
      shell.emit("approval", {
        agentId: "agt_a",
        requestId: "r1",
        tool: "bash",
        title: "bash",
        input: { command: "rm -rf /tmp/scratch" },
      });
      expect(shell.pipLabel()).toBe("Waiting for you");

      // Settled and finished: back to the tool, then to idle.
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" },
      });
      shell.press("approval-allow-r1");
      expect(shell.pipLabel()).toBe("Working");

      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "idle" } as Agent] });
      expect(shell.pipLabel()).toBe("Ready");
    } finally {
      shell.unmount();
    }
  });

  test("streaming tokens never change the announcement, so nothing is re-announced", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      const seen = new Set<string>();
      for (let seq = 1; seq <= 30; seq += 1) {
        shell.emit("update", {
          agentId: "agt_a",
          seq,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m1",
            content: { type: "text", text: `tok${seq} ` },
          },
        });
        const label = shell.pipLabel();
        if (label !== null) seen.add(label);
      }
      // Thirty frames, one announcement. A live region speaks when its content
      // changes, so a label that changed per token would speak thirty times.
      expect([...seen]).toEqual(["Working"]);
    } finally {
      shell.unmount();
    }
  });

  test("a drop overrides the activity, and reconnecting restores it from authoritative state", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      expect(shell.pipLabel()).toBe("Working");

      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 500 });
      expect(shell.pipLabel()).toBe("Reconnecting to the daemon");

      shell.emit("status", { state: "offline", attempt: 4 });
      expect(shell.pipLabel()).toBe("No link to the daemon");

      // Back up. The roster is what says what the session is doing now, not a
      // remembered label from before the drop.
      shell.emit("status", { state: "connected", attempt: 0 });
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "idle" } as Agent] });
      expect(shell.pipLabel()).toBe("Ready");
    } finally {
      shell.unmount();
    }
  });

  test("a terminal session's header follows its own turn boundaries", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
      shell.press("session-open-sess_tui");
      shell.emit("error", {
        code: "collab_unavailable",
        sessionId: "sess_tui",
        message: "this omp build cannot host a collab room",
      });
      shell.emit("session_tail", { sessionId: "sess_tui", messages: [], truncated: false });
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.pipLabel()).toBe("Ready");

      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });
      expect(shell.pipLabel()).toBe("Working in the terminal");

      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "assistant_text", text: "partial" });
      // Still one label across progress frames, for the same dedup reason.
      expect(shell.pipLabel()).toBe("Working in the terminal");

      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_end" });
      expect(shell.pipLabel()).toBe("Ready");
    } finally {
      shell.unmount();
    }
  });
});

describe("the header holds its layout across every label", () => {
  test("a phone shows the dot without the word; a tablet shows both", () => {
    setWindowSize(390, 844);
    const phone = mountShell();
    try {
      phone.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      phone.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      phone.press("session-open-sess_a");
      expect(phone.el("session-activity")).not.toBeNull();
      expect(phone.el("session-activity-label")).toBeNull();
      expect(phone.pipLabel()).toBe("Working");
    } finally {
      phone.unmount();
    }

    setWindowSize(1024, 1366);
    const tablet = mountShell();
    try {
      tablet.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      tablet.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      expect(tablet.el("session-activity-label")?.textContent).toBe("Working");
    } finally {
      tablet.unmount();
    }
  });

  test("the pip's box styles do not change with its label", () => {
    // react-native-web compiles `minWidth` into a class rather than an inline
    // style, so reading `style.minWidth` returns "" and an equality check on it
    // would pass for every possible pair. What is assertable here is that the
    // box's own class list is byte-identical across the shortest and longest
    // labels, which is the same claim one level up: only the text node differs,
    // so nothing about the container's geometry is a function of the state.
    //
    // What this does NOT prove is the rendered pixel width, because happy-dom
    // has no layout engine. The iOS simulator smoke is what covers that.
    const short = agentActivity(agent("a"), EMPTY_SESSION, "connected", READY_LOAD);
    const view = mount(<ActivityPip activity={short} reduceMotion />);
    try {
      const before = view.el("session-activity")?.getAttribute("class");
      expect(before ?? "").not.toBe("");
      const long = agentActivity(
        agent("a"),
        { ...EMPTY_SESSION, pendingApprovals: [{ requestId: "r", tool: "b", title: "b", input: {} }] },
        "connected",
        READY_LOAD,
      );
      view.render(<ActivityPip activity={long} reduceMotion />);
      expect(view.el("session-activity-label")?.textContent).toBe("Waiting for you");
      expect(view.el("session-activity")?.getAttribute("class")).toBe(before);
    } finally {
      view.unmount();
    }
  });
});
