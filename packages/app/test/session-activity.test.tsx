/**
 * "The working indicator should be in chat, just as it is in the tui, after my
 * turn and before the composer."
 *
 * The first version of this put the indicator in the header, which answers a
 * different question: a header says what a session IS, and "the agent is
 * working on what I just sent" is a fact about the conversation. So the tests
 * that used to read a header badge now assert placement, ordering and removal
 * in the log itself, through the real `Console` over a canned socket, on the
 * frames a daemon actually sends.
 *
 * The transition semantics are omp's, taken from its source rather than
 * guessed, in `packages/coding-agent/src/modes/controllers/event-controller.ts`:
 * `#handleMessageStart` (721), `#handleMessageUpdate` (971, the token handler),
 * `#handleToolExecutionStart` (1297) and `#handleToolExecutionEnd` (1474) all
 * call `#ensureWorkingLoaderWhileStreaming()`, whose only condition is
 * `if (!this.ctx.viewSession.isStreaming) return;` (1751). The loader is
 * stopped in exactly one ordinary place, `#finishAgentEnd` (1677). So the
 * indicator runs for the WHOLE turn -- beside streaming prose, across tool
 * calls -- and stops at turn end. It is not replaced at first content, and
 * nothing keeps it alive on a timer.
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
const { Console } = await import("../src/console/Console.tsx");

/**
 * The two things this change introduces, loaded per test rather than at the
 * top of the file.
 *
 * Deliberate: the point of a baseline run is to see WHICH behaviours the old
 * build gets wrong. A top-level import of a module that does not exist on
 * `main` aborts the whole file, so every assertion below would report as one
 * module error and the placement failures -- the actual subject -- would never
 * run. Loaded here, `main` fails these tests individually and the placement
 * tests still execute and still fail on behaviour.
 */
async function gate(): Promise<typeof import("../src/session/activity.ts").conversationActivity> {
  const activity = await import("../src/session/activity.ts");
  return activity.conversationActivity;
}
async function row(): Promise<typeof import("../src/components/ActivityRow.tsx").ActivityRow> {
  const component = await import("../src/components/ActivityRow.tsx");
  return component.ActivityRow;
}

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
    // enough, which is what keeps the answer honest across the window where a
    // roster snapshot is older than the turn it describes.
    const streaming = reduce(EMPTY_SESSION, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "partial" },
      messageId: "m1",
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
      status: "in_progress",
    });
    expect(agentActivity(agent("a"), session, "connected", READY_LOAD)).toMatchObject({
      kind: "running",
      label: "reading",
    });

    session = reduce(session, {
      sessionUpdate: "tool_call",
      toolCallId: "t2",
      kind: "execute",
      status: "in_progress",
    });
    expect(agentActivity(agent("a"), session, "connected", READY_LOAD)).toMatchObject({
      kind: "running",
      label: "2 tools",
    });
  });

  test("two running calls of one kind still name that kind", () => {
    let session = EMPTY_SESSION;
    for (const id of ["t1", "t2"]) {
      session = reduce(session, { sessionUpdate: "tool_call", toolCallId: id, kind: "search", status: "in_progress" });
    }
    // Two of a kind is still one honest answer to "what is it doing", but not
    // to "how many": the count is what the label carries.
    expect(agentActivity(agent("a"), session, "connected", READY_LOAD).label).toBe("2 tools");
  });

  test("a clearance outranks a running tool, because it is the one state about the operator", () => {
    const session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      status: "in_progress",
    });
    const waiting = {
      ...session,
      pendingApprovals: [{ requestId: "r1", tool: "bash", title: "bash -lc ls", input: {} }],
    };
    expect(agentActivity(agent("a"), waiting, "connected", READY_LOAD)).toMatchObject({
      kind: "waiting",
      label: "Waiting for you",
      actionable: true,
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
    expect(agentActivity(busy, EMPTY_SESSION, "offline", READY_LOAD).kind).toBe("offline");
    expect(agentActivity(busy, EMPTY_SESSION, "reconnecting", READY_LOAD).kind).toBe("linking");
    expect(agentActivity(busy, EMPTY_SESSION, "connected", STALLED).kind).toBe("linking");
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
        live: false,
      });
    }
  });

  test("waiting is actionable only when a request actually arrived on this device", () => {
    // The daemon's own word, with nothing in this pane to answer. There is no
    // card here, so a row inviting an answer would point at no control.
    const remote = agentActivity(agent("a", { state: "waiting" }), EMPTY_SESSION, "connected", READY_LOAD);
    expect(remote).toMatchObject({ kind: "waiting", actionable: false });

    const here = agentActivity(
      agent("a"),
      { ...EMPTY_SESSION, pendingApprovals: [{ requestId: "r", tool: "bash", title: "bash", input: {} }] },
      "connected",
      READY_LOAD,
    );
    expect(here.actionable).toBe(true);
  });
});

describe("no tool argument ever reaches the label or the announcement", () => {
  test("a title carrying a command and a path is never quoted", () => {
    // omp builds ACP's `title` from the call's own arguments, so this is the
    // shape a real frame has. The row may say the kind and nothing else.
    const secret = "bash -c 'curl -H \"Authorization: Bearer sk-live-DEADBEEF\" https://x/y'";
    const session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      title: secret,
      status: "in_progress",
    });
    const result = agentActivity(agent("a"), session, "connected", READY_LOAD);
    expect(result.label).toBe("running a command");
    expect(result.label).not.toContain("sk-live");
    expect(result.announcement).not.toContain("sk-live");
    expect(result.announcement).not.toContain("curl");
    expect(result.announcement).not.toContain("Authorization");
  });
});

describe("a live terminal reports what its bridge actually sends", () => {
  test("idle, then working across the terminal's own turn boundaries", () => {
    expect(tuiActivity(EMPTY_TUI, "connected", READY_LOAD, true)).toMatchObject({ kind: "ready", live: false });
    expect(tuiActivity({ ...EMPTY_TUI, busy: true }, "connected", READY_LOAD, true)).toMatchObject({
      kind: "working",
      announcement: "Working in the terminal",
      live: true,
    });
  });

  test("a terminal never claims a tool, because the bridge forwards none", () => {
    // The whole `TuiActivityKind` vocabulary is assistant_text, turn_start and
    // turn_end. A tool label here would be invented, so the narrower word is
    // the honest one and this pins it.
    const working = tuiActivity({ ...EMPTY_TUI, busy: true }, "connected", READY_LOAD, true);
    expect(working.kind).toBe("working");
    expect(working.label).toBe("Working");
  });

  test("a refusal needs the operator; a dead terminal is not live; the link still outranks both", () => {
    expect(tuiActivity({ ...EMPTY_TUI, refusal: "no bridge" }, "connected", READY_LOAD, true).kind).toBe("waiting");
    expect(tuiActivity(EMPTY_TUI, "connected", READY_LOAD, false).kind).toBe("stopped");
    expect(tuiActivity({ ...EMPTY_TUI, busy: true }, "offline", READY_LOAD, true).kind).toBe("offline");
    expect(tuiActivity({ ...EMPTY_TUI, busy: true }, "connected", STALLED, true).kind).toBe("linking");
  });

  test("a terminal refusal is never actionable in the conversation's sense", () => {
    // The refusal band below states the reason in full and carries whatever
    // control exists. A one-word row above it would add nothing.
    expect(tuiActivity({ ...EMPTY_TUI, refusal: "no bridge" }, "connected", READY_LOAD, true).actionable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The gate: what chat is allowed to carry
// ---------------------------------------------------------------------------

describe("only a turn belongs in the conversation", () => {
  test("work in flight is a row, named or not", async () => {
    const conversationActivity = await gate();
    const working = agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", READY_LOAD);
    expect(conversationActivity(working)).not.toBeNull();

    const running = agentActivity(
      agent("a"),
      reduce(EMPTY_SESSION, { sessionUpdate: "tool_call", toolCallId: "t1", kind: "read", status: "in_progress" }),
      "connected",
      READY_LOAD,
    );
    expect(conversationActivity(running)?.label).toBe("reading");
  });

  test("a decision this device can answer is a row", async () => {
    const conversationActivity = await gate();
    const waiting = agentActivity(
      agent("a"),
      { ...EMPTY_SESSION, pendingApprovals: [{ requestId: "r", tool: "bash", title: "bash", input: {} }] },
      "connected",
      READY_LOAD,
    );
    expect(conversationActivity(waiting)?.label).toBe("Waiting for you");
  });

  test("every resting and broken state is absent, never a row saying nothing is happening", async () => {
    const conversationActivity = await gate();
    // This is the defect the header version had: a permanent badge. A chat row
    // reading `Ready` above the composer would be the same badge relocated.
    const cases = [
      agentActivity(agent("a"), EMPTY_SESSION, "connected", READY_LOAD),
      agentActivity(agent("a", { state: "stopped" }), EMPTY_SESSION, "connected", READY_LOAD),
      agentActivity(agent("a", { state: "failed" }), EMPTY_SESSION, "connected", READY_LOAD),
      agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "offline", READY_LOAD),
      agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "reconnecting", READY_LOAD),
      agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", STALLED),
      agentActivity(agent("a", { state: "starting" }), EMPTY_SESSION, "connected", READY_LOAD),
      // Blocked on something this device was never sent: no card, so no row.
      agentActivity(agent("a", { state: "waiting" }), EMPTY_SESSION, "connected", READY_LOAD),
      tuiActivity(EMPTY_TUI, "connected", READY_LOAD, true),
      tuiActivity(EMPTY_TUI, "connected", READY_LOAD, false),
      tuiActivity({ ...EMPTY_TUI, refusal: "no bridge" }, "connected", READY_LOAD, true),
    ];
    for (const activity of cases) {
      expect(conversationActivity(activity)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// The rendered row
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

async function working() {
  const conversationActivity = await gate();
  const derived = conversationActivity(
    agentActivity(agent("a", { state: "busy" }), EMPTY_SESSION, "connected", READY_LOAD),
  );
  if (derived === null) throw new Error("a busy agent must be conversational");
  return derived;
}

describe("the row moves only while work is in flight", () => {
  test("working animates, and going idle removes the row entirely", async () => {
    const ActivityRow = await row();
    const view = mount(<ActivityRow activity={await working()} reduceMotion={false} />);
    try {
      expect(view.el("session-activity-dot-lit")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("reduced motion keeps the state and drops the movement", async () => {
    const ActivityRow = await row();
    const view = mount(<ActivityRow activity={await working()} reduceMotion />);
    try {
      // The state is still on screen and still says the same thing; only the
      // animation is gone.
      expect(view.el("session-activity-label")?.textContent).toBe("Working");
      expect(view.el("session-activity-dot")).not.toBeNull();
      expect(view.el("session-activity-dot-lit")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("a decision waiting on the operator is present but still", async () => {
    const ActivityRow = await row();
    const conversationActivity = await gate();
    const waiting = conversationActivity(
      agentActivity(
        agent("a"),
        { ...EMPTY_SESSION, pendingApprovals: [{ requestId: "r", tool: "bash", title: "bash", input: {} }] },
        "connected",
        READY_LOAD,
      ),
    );
    if (waiting === null) throw new Error("an outstanding approval must be conversational");
    const view = mount(<ActivityRow activity={waiting} reduceMotion={false} />);
    try {
      // Nothing is in flight, so nothing may move: movement is a claim.
      expect(view.el("session-activity-dot-lit")).toBeNull();
      expect(view.el("session-activity-label")?.textContent).toBe("Waiting for you");
    } finally {
      view.unmount();
    }
  });

  test("the row wears the conversation's own attribution, not a badge", async () => {
    const ActivityRow = await row();
    const view = mount(<ActivityRow activity={await working()} reduceMotion />);
    try {
      // The gutter word is what makes this read as the next agent row rather
      // than as chrome that happens to be inside the list.
      expect(view.host.textContent).toContain("agent");
    } finally {
      view.unmount();
    }
  });

  test("the announcement is a live region, and it is polite rather than assertive", async () => {
    const ActivityRow = await row();
    const view = mount(<ActivityRow activity={await working()} reduceMotion />);
    try {
      const row = view.el("session-activity");
      expect(row?.getAttribute("aria-label")).toBe("Working");
      // Assertive would interrupt whatever the operator is reading, on every
      // turn. This is a status, so it waits.
      expect(row?.getAttribute("aria-live")).toBe("polite");
    } finally {
      view.unmount();
    }
  });

  test("the dots contribute nothing readable, so the row reads once", async () => {
    const ActivityRow = await row();
    const view = mount(<ActivityRow activity={await working()} reduceMotion={false} />);
    try {
      // The row already carries the announcement, and the dots are marked
      // `accessibilityElementsHidden` / `importantForAccessibility="no-hide-
      // descendants"` in the source. Neither prop is reflected into the DOM by
      // react-native-web, so what is assertable here is the fact those props
      // exist to protect: the row's readable text is the attribution and the
      // label, and the animation adds no characters a screen reader would
      // reach.
      expect(view.el("session-activity-dot-lit")).not.toBeNull();
      expect(view.el("session-activity")?.textContent).toBe("agentWorking");
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
  /** The row's announcement, or null when there is no row at all. */
  rowLabel: () => string | null;
  /** Every element carrying the row's id, to catch a second one. */
  rowCount: () => number;
  /**
   * The given ids in the order they appear in the document, absent ones
   * dropped. Placement is the whole point of this change, so it is asserted on
   * real document position rather than on a screenshot or on faith.
   */
  order: (...testIDs: string[]) => string[];
  /** Whether `inner` is inside `outer`, which is what "rides the list" means. */
  within: (inner: string, outer: string) => boolean;
  /** The header's text, to prove the badge is gone rather than moved. */
  headText: (testID: string) => string;
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
    rowLabel: () => el("session-activity")?.getAttribute("aria-label") ?? null,
    rowCount: () => host.querySelectorAll('[data-testid="session-activity"]').length,
    order: (...testIDs) => {
      const found = testIDs
        .map(id => ({ id, node: el(id) }))
        .filter((candidate): candidate is { id: string; node: HTMLElement } => candidate.node !== null);
      return found
        .sort((left, right) =>
          // DOCUMENT_POSITION_FOLLOWING: right comes after left.
          left.node.compareDocumentPosition(right.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        )
        .map(candidate => candidate.id);
    },
    within: (inner, outer) => {
      const child = el(inner);
      return child !== null && el(outer)?.contains(child) === true;
    },
    headText: (testID: string) => el(testID)?.textContent ?? "",
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

/** An owned session, opened and idle, with one turn of the operator's in it. */
function openOwned(shell: Shell): void {
  shell.emit("agents", { agents: ROSTER });
  shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
}

function userTurn(shell: Shell, seq: number, text: string): void {
  shell.emit("update", {
    agentId: "agt_a",
    seq,
    update: { sessionUpdate: "user_message_chunk", content: { type: "text", text }, messageId: `u${seq}` },
  });
}

describe("a session joined after its turn ended", () => {
  /**
   * The device found this one. Attaching to an agent that is ALREADY idle never
   * produces a busy -> idle transition, and the daemon replays the transcript
   * as ordinary update frames, so the last assistant chunk of a turn that
   * finished before this device arrived stayed marked streaming. On an iPhone
   * 17 simulator against a real daemon the agent reported `idle` while the app
   * drew a "Working" row and offered the interrupt in place of send.
   *
   * The roster is the authority on liveness. A non-busy agent has nothing in
   * flight whether or not this device watched it stop.
   */
  test("shows no working row and offers send, not interrupt", () => {
    // Split width, so the detail pane and its composer are on screen without a
    // navigation press: the same shape the neighbouring cases use.
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      // Idle from the first frame: this device never sees `busy`.
      shell.emit("agents", { agents: ROSTER });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      userTurn(shell, 1, "what did you find?");
      // A replayed assistant chunk. No `message_end` follows, because the turn
      // was already over when we joined.
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The mount policy imports node:path." },
          messageId: "m1",
        },
      });
      // Deliberately NO trailing roster frame. A settled session sends none,
      // which is exactly what made the device fail while a test that emitted
      // one passed.

      expect(shell.rowLabel()).toBeNull();
      expect(shell.rowCount()).toBe(0);
      // The composer's own claim has to agree with the roster.
      expect(shell.el("composer-send")).not.toBeNull();
      expect(shell.el("composer-cancel")).toBeNull();
    } finally {
      shell.unmount();
    }
  });

  /**
   * The other half of the same fix, and the half nothing reached.
   *
   * `applyAgents` used to require having WATCHED the agent stop
   * (`before.get(id)?.state === "busy"`). One dropped roster snapshot is
   * tolerated by design -- `rosterMisses` reaps a session only after two
   * agreeing misses -- and a snapshot that omits the agent leaves `before`
   * with no entry for it, so the next frame saying `idle` found no remembered
   * `busy` beside it and settled nothing.
   *
   * The update path cannot cover this one, which is why both changes exist:
   * while the roster says `busy` a chunk IS a live stream and settling it
   * would erase a caret that is telling the truth, and no further chunk
   * arrives once the turn has ended.
   */
  test("a roster snapshot dropped between busy and idle still settles the turn", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      userTurn(shell, 1, "what did you find?");
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "The mount policy imports node:path." },
          messageId: "m1",
        },
      });
      // While the roster says busy, a streaming chunk is the honest reading.
      expect(shell.rowLabel()).toBe("Working");

      // One snapshot that does not name this agent. Survivable by contract.
      shell.emit("agents", { agents: [] });
      // The turn ended while the roster was away, so this frame is the first
      // evidence of it -- and there is no remembered `busy` beside it.
      shell.emit("agents", { agents: ROSTER });

      expect(shell.rowLabel()).toBeNull();
      expect(shell.rowCount()).toBe(0);
      expect(shell.el("composer-send")).not.toBeNull();
      expect(shell.el("composer-cancel")).toBeNull();
    } finally {
      shell.unmount();
    }
  });
});

describe("the turn underway sits after the operator's prompt and above the composer", () => {
  test("an idle session has no row at all: chat carries turns, not status", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      expect(shell.el("aui-messages")).not.toBeNull();
      expect(shell.rowLabel()).toBeNull();
      expect(shell.rowCount()).toBe(0);
    } finally {
      shell.unmount();
    }
  });

  test("the operator's turn, then the working row, then the composer", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "ship it");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });

      expect(shell.rowLabel()).toBe("Working");
      // The ordering the report was about, on document position.
      expect(shell.order("entry-user", "session-activity", "composer-surface")).toEqual([
        "entry-user",
        "session-activity",
        "composer-surface",
      ]);
    } finally {
      shell.unmount();
    }
  });

  test("the row is inside the log, so it scrolls with the turns rather than over them", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "ship it");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });

      expect(shell.within("session-activity", "aui-messages")).toBe(true);
    } finally {
      shell.unmount();
    }
  });

  test("a tool names its kind in the row and never its arguments", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "look at the config");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "execute",
          title: "bash -lc 'cat ~/.config/secret.env'",
          status: "in_progress",
        },
      });

      expect(shell.rowLabel()).toBe("Working: running a command");
      const row = shell.el("session-activity");
      expect(row?.textContent).toBe("agentrunning a command");
      expect(row?.textContent).not.toContain("secret.env");
      expect(row?.getAttribute("aria-label")).not.toContain("secret.env");
    } finally {
      shell.unmount();
    }
  });

  test("streaming prose does not remove the row, and does not double the claim", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "explain this");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      expect(shell.rowLabel()).toBe("Working");

      // First content arrives. omp's own token handler re-ensures the loader
      // (`#handleMessageUpdate` -> `#ensureWorkingLoaderWhileStreaming`), and
      // the loader is stopped only at `#finishAgentEnd`, so the row stays.
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Because " },
          messageId: "m1",
        },
      });

      expect(shell.el("entry-assistant")).not.toBeNull();
      expect(shell.rowLabel()).toBe("Working");
      // One indicator, not one per surface: exactly the TUI's shape, where a
      // single loader runs beside the streaming text.
      expect(shell.rowCount()).toBe(1);
      // And it is still the last thing before the composer, after the reply
      // that is being written.
      expect(shell.order("entry-user", "entry-assistant", "session-activity", "composer-surface")).toEqual([
        "entry-user",
        "entry-assistant",
        "session-activity",
        "composer-surface",
      ]);
    } finally {
      shell.unmount();
    }
  });

  test("the turn ending removes the row and leaves the composer", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "go");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" }, messageId: "m1" },
      });
      // How a turn actually ends for an owned session: the roster stops saying
      // busy. There is no `message_end` in this app's update vocabulary --
      // `reduce` would file one under `appendUnknown` -- and `applyAgents` is
      // what calls `endTurn` on the busy-to-not-busy transition, which is what
      // closes the streaming entry.
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "idle" } as Agent] });

      expect(shell.rowLabel()).toBeNull();
      expect(shell.rowCount()).toBe(0);
      // The conversation and the way to continue it both remain.
      expect(shell.el("entry-assistant")).not.toBeNull();
      expect(shell.el("composer-surface")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a decision waiting on the operator stays in place, and goes when it is answered", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "delete the branch");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      shell.emit("approval", {
        agentId: "agt_a",
        requestId: "r1",
        tool: "bash",
        title: "git branch -D park/old",
        input: {},
      });

      expect(shell.rowLabel()).toBe("Waiting for you");
      // The card is what the operator answers; the row says why the turn has
      // stopped. Both are in the log, in that order, above the composer.
      expect(shell.order("entry-user", "session-activity", "composer-surface")).toEqual([
        "entry-user",
        "session-activity",
        "composer-surface",
      ]);

      // Answered, and the turn goes back to work.
      shell.emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: { sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", status: "in_progress" },
      });
      // Answered by pressing the card, which is the only thing that clears
      // it: there is no settle frame, the decision is this device's own act.
      shell.press("approval-allow-r1");
      expect(shell.rowLabel()).toBe("Working: running a command");
    } finally {
      shell.unmount();
    }
  });

  test("a drop takes the row away rather than leaving a spinner nobody is driving", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "go");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      expect(shell.rowLabel()).toBe("Working");

      // Whatever the last frame said may be minutes stale, and the stalled
      // band below is the surface that owns saying so.
      shell.emit("status", { state: "reconnecting", attempt: 1, delayMs: 500 });
      expect(shell.rowLabel()).toBeNull();

      shell.emit("status", { state: "connected", attempt: 0 });
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      expect(shell.rowLabel()).toBe("Working");
    } finally {
      shell.unmount();
    }
  });

  test("streaming tokens never change the announcement, so nothing is re-announced", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });
      const seen = new Set<string>();
      for (let seq = 1; seq <= 30; seq += 1) {
        shell.emit("update", {
          agentId: "agt_a",
          seq,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `token ${seq} ` },
            messageId: "m1",
          },
        });
        const label = shell.rowLabel();
        if (label !== null) seen.add(label);
      }
      // A live region that re-announced per token would make VoiceOver
      // unusable on every turn.
      expect([...seen]).toEqual(["Working"]);
    } finally {
      shell.unmount();
    }
  });
});

describe("the header says what the session is, and nothing about the turn", () => {
  test("an owned session's header carries identity and state, with no working badge", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      userTurn(shell, 1, "go");
      shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });

      // The row exists, and it is not in the header.
      expect(shell.rowLabel()).toBe("Working");
      const head = shell.headText("session-head");
      expect(head).toContain("Alpha");
      expect(head).toContain("busy");
      expect(head).not.toContain("Working");
      expect(shell.within("session-activity", "aui-messages")).toBe(true);
    } finally {
      shell.unmount();
    }
  });

  test("a terminal session's header carries identity and status, with no working badge", () => {
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
      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });

      expect(shell.rowLabel()).toBe("Working in the terminal");
      const head = shell.headText("terminal-head");
      expect(head).toContain("terminal work");
      expect(head).not.toContain("Working");
    } finally {
      shell.unmount();
    }
  });
});

describe("a terminal's turn sits in its log too, on the terminal's own boundaries", () => {
  function openTerminal(shell: Shell): void {
    shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
    shell.press("session-open-sess_tui");
    shell.emit("error", {
      code: "collab_unavailable",
      sessionId: "sess_tui",
      message: "this omp build cannot host a collab room",
    });
    shell.emit("session_tail", {
      sessionId: "sess_tui",
      messages: [{ role: "user", text: "run the suite", at: "2026-08-24T11:58:00.000Z" }],
      truncated: false,
    });
  }

  test("idle has no row", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openTerminal(shell);
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.rowLabel()).toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("turn_start puts the row after the log's rows and before the composer", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openTerminal(shell);
      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });

      expect(shell.rowLabel()).toBe("Working in the terminal");
      expect(shell.order("terminal-turn-0", "session-activity", "terminal-composer-surface")).toEqual([
        "terminal-turn-0",
        "session-activity",
        "terminal-composer-surface",
      ]);
      // In the log, so it scrolls with the turns.
      expect(shell.within("session-activity", "terminal-log")).toBe(true);
    } finally {
      shell.unmount();
    }
  });

  test("assistant text does not remove it, and turn_end does", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openTerminal(shell);
      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });
      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "assistant_text", text: "partial" });
      expect(shell.rowLabel()).toBe("Working in the terminal");
      expect(shell.rowCount()).toBe(1);

      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_end" });
      expect(shell.rowLabel()).toBeNull();
      expect(shell.el("terminal-composer-surface")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("the old bare kicker in the hints block is gone, not duplicated", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openTerminal(shell);
      shell.emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });
      // It said the same words in a different place, below the composer's
      // hints rather than in the conversation.
      expect(shell.el("terminal-busy")).toBeNull();
      expect(shell.rowCount()).toBe(1);
    } finally {
      shell.unmount();
    }
  });
});

describe("the row holds its place on a phone as well as a tablet", () => {
  for (const [name, width, height] of [
    ["phone", 390, 844],
    ["tablet", 1024, 1366],
  ] as const) {
    test(`${name}: prompt, row, composer, in that order and none of them overlapping`, () => {
      setWindowSize(width, height);
      const shell = mountShell();
      try {
        shell.emit("agents", { agents: ROSTER });
        if (name === "phone") shell.press("session-open-sess_a");
        shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
        userTurn(shell, 1, "ship it");
        shell.emit("agents", { agents: [{ ...ROSTER[0], state: "busy" } as Agent] });

        expect(shell.rowLabel()).toBe("Working");
        expect(shell.order("entry-user", "session-activity", "composer-surface")).toEqual([
          "entry-user",
          "session-activity",
          "composer-surface",
        ]);
        // One row on either form factor: no second copy for a wide layout.
        expect(shell.rowCount()).toBe(1);
      } finally {
        shell.unmount();
      }
    });
  }
});
