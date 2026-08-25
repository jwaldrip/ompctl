/**
 * Rendered frames of the real screens, for looking at.
 *
 * Not a test and not product code: the ordering assertions live in the suites
 * and they check document position, which is stronger than a picture. What a
 * picture answers that they cannot is whether the row collides with the
 * composer, the safe-area pad or the plan band at a real viewport size.
 *
 * The simulator smoke cannot reach this state -- it is `LaunchSmokeUITests`
 * against a build with no daemon, so it never opens a session -- so these
 * frames come from the same react-native-web substitution the shipped web
 * build makes, driven through the real `Console` over a canned socket.
 *
 * Run from packages/app:
 *   bun --preload ./test/preload-react.ts test/render-frames.tsx
 *
 * Writes /tmp/frames/*.html, each standing alone with no network: open one and
 * screenshot `#frame`, which is sized to the device it names.
 */

import "./rnw.ts";

import { mkdirSync, writeFileSync } from "node:fs";
import type { Agent, RemoteRoutine, Run, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { setWindowSize } from "./rnw.ts";

const { Console } = await import("../src/console/Console.tsx");
// Dynamic for the same RNW boundary as Console: Paper reaches React Native, so
// loading it before the substitution would pull the native entrypoint in.
const { WithOmpTheme } = await import("./theme.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
    return () => {};
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
  readRoutines(): void {}
  writeRoutine(): void {}
  runRoutine(): void {}
  deleteRoutines(): void {}
  rotateRoutineSecret(): void {}
}

const AGENT: Agent = {
  id: "agt_a",
  name: "Alpha",
  state: "busy",
  acpSessionId: "sess_a",
  host: { kind: "local", id: "42", spec: { kind: "local" } },
  cwd: "/Users/jwaldrip/dev/src/github.com/jwaldrip/ompctl",
  createdAt: "2026-08-24T11:00:00.000Z",
  lastActiveAt: "2026-08-24T11:59:00.000Z",
  labels: {},
  model: "anthropic/claude-opus-5",
};

const TUI_ROW: SessionSummary = {
  id: "sess_tui",
  title: "ompctl terminal",
  cwd: "/Users/jwaldrip/dev/src/github.com/jwaldrip/ompctl",
  cwdScope: "home",
  flattenedDir: "-Users-jwaldrip-dev-src-github-com-jwaldrip-ompctl",
  status: "live-tui",
  createdAt: "2026-08-24T11:00:00.000Z",
  lastActivityAt: "2026-08-24T11:59:00.000Z",
  messageCount: 4,
  byteSize: 4_096,
  archived: false,
  pid: 4_242,
};

/** A routine whose two prompt actions each opened their own session. */
const BRIEF_ROUTINE: RemoteRoutine = {
  id: "rtn_brief",
  name: "Morning brief",
  enabled: true,
  trigger: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  actions: [
    { id: "gather", name: "Gather the facts", prompt: "gather", cwd: "/Users/jwaldrip/dev/src/ompctl", labels: {} },
    { id: "render", name: "Render the brief", prompt: "render", cwd: "/Users/jwaldrip/dev/src/ompctl", labels: {} },
  ],
  singleton: true,
  labels: {},
  createdAt: "2026-08-20T09:00:00.000Z",
};

/**
 * Five runs, so the card shows its first page and says how much it is holding
 * back. The newest is the one the frame expands; the oldest carries no session
 * ids, which is what a run recorded before the field existed looks like.
 */
const BRIEF_RUNS: Run[] = [
  {
    id: "run_0900",
    routineId: "rtn_brief",
    state: "succeeded",
    startedAt: "2026-08-24T09:00:00.000Z",
    finishedAt: "2026-08-24T09:03:20.000Z",
    actions: [
      {
        actionId: "gather",
        actionName: "Gather the facts",
        index: 0,
        state: "succeeded",
        summary: "read 41 commits and 3 calendars",
        startedAt: "2026-08-24T09:00:00.000Z",
        finishedAt: "2026-08-24T09:01:40.000Z",
        agentId: "agt_gather",
        sessionId: "sess_gather",
      },
      {
        actionId: "render",
        actionName: "Render the brief",
        index: 1,
        state: "failed",
        error: "the report template referenced a font that is not installed",
        startedAt: "2026-08-24T09:01:40.000Z",
        finishedAt: "2026-08-24T09:03:20.000Z",
        agentId: "agt_render",
        sessionId: "sess_render",
      },
    ],
  },
  {
    id: "run_0800",
    routineId: "rtn_brief",
    state: "running",
    startedAt: "2026-08-23T09:00:00.000Z",
    actions: [
      {
        actionId: "gather",
        actionName: "Gather the facts",
        index: 0,
        state: "running",
        startedAt: "2026-08-23T09:00:00.000Z",
        agentId: "agt_old_gather",
        sessionId: "sess_old_gather",
      },
    ],
  },
  {
    id: "run_0700",
    routineId: "rtn_brief",
    state: "skipped",
    startedAt: "2026-08-22T09:00:00.000Z",
    finishedAt: "2026-08-22T09:00:00.000Z",
    error: "the previous run was still going, and this routine is a singleton",
    actions: [],
  },
  {
    id: "run_0600",
    routineId: "rtn_brief",
    state: "succeeded",
    startedAt: "2026-08-21T09:00:00.000Z",
    finishedAt: "2026-08-21T09:02:00.000Z",
    actions: [
      {
        actionId: "gather",
        actionName: "Gather the facts",
        index: 0,
        state: "succeeded",
        startedAt: "2026-08-21T09:00:00.000Z",
        finishedAt: "2026-08-21T09:02:00.000Z",
      },
    ],
  },
  {
    id: "run_0500",
    routineId: "rtn_brief",
    state: "failed",
    startedAt: "2026-08-20T09:00:00.000Z",
    finishedAt: "2026-08-20T09:00:01.000Z",
    actions: [
      {
        actionId: "gather",
        actionName: "Gather the facts",
        index: 0,
        state: "refused",
        refusal: { code: "unauthorized", reason: "the routine's device holds no prompt scope" },
        startedAt: "2026-08-20T09:00:00.000Z",
        finishedAt: "2026-08-20T09:00:01.000Z",
      },
    ],
  },
];

const BRIEF_AGENT: Agent = {
  ...AGENT,
  id: "agt_gather",
  name: "Gather the facts",
  state: "idle",
  acpSessionId: "sess_gather",
};

const GATHER_ROW: SessionSummary = {
  ...TUI_ROW,
  id: "sess_gather",
  title: "Gather the facts",
  status: "live-ompd",
};

/** Live in a terminal, so its link resolves to the co-driven surface. */
const RENDER_ROW: SessionSummary = { ...TUI_ROW, id: "sess_render", title: "Render the brief" };

interface Frame {
  name: string;
  width: number;
  height: number;
  drive: (emit: (name: string, event: unknown) => void, press: (testID: string) => void) => void;
}

const FRAMES: Frame[] = [
  {
    name: "iphone-owned-working",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("agents", { agents: [AGENT] });
      press("session-open-sess_a");
      emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "move the working indicator into the conversation" },
          messageId: "u1",
        },
      });
      emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "read",
          title: "read packages/app/src/components/Transcript.tsx",
          status: "in_progress",
        },
      });
    },
  },
  {
    name: "iphone-owned-streaming",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("agents", { agents: [AGENT] });
      press("session-open-sess_a");
      emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "why did the header placement read wrong?" },
          messageId: "u1",
        },
      });
      emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Because a header says what a session is, and the turn in flight is a fact about the conversation.",
          },
          messageId: "m1",
        },
      });
    },
  },
  {
    name: "ipad-owned-working",
    width: 1024,
    height: 1366,
    drive: emit => {
      emit("agents", { agents: [AGENT] });
      emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "move the working indicator into the conversation" },
          messageId: "u1",
        },
      });
      emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          kind: "execute",
          title: "bun run test",
          status: "in_progress",
        },
      });
    },
  },
  {
    name: "iphone-terminal-working",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("sessions", { sessions: [TUI_ROW] });
      press("session-open-sess_tui");
      emit("error", {
        code: "collab_unavailable",
        sessionId: "sess_tui",
        message: "this omp build cannot host a collab room",
      });
      emit("session_tail", {
        sessionId: "sess_tui",
        messages: [
          { role: "user", text: "run the suite", at: "2026-08-24T11:58:00.000Z" },
          { role: "assistant", text: "771 pass, 0 fail.", at: "2026-08-24T11:58:30.000Z" },
        ],
        truncated: false,
      });
      emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });
    },
  },
  {
    name: "ipad-terminal-working",
    width: 1024,
    height: 1366,
    drive: (emit, press) => {
      emit("sessions", { sessions: [TUI_ROW] });
      press("session-open-sess_tui");
      emit("error", {
        code: "collab_unavailable",
        sessionId: "sess_tui",
        message: "this omp build cannot host a collab room",
      });
      emit("session_tail", {
        sessionId: "sess_tui",
        messages: [
          { role: "user", text: "run the suite", at: "2026-08-24T11:58:00.000Z" },
          { role: "assistant", text: "771 pass, 0 fail.", at: "2026-08-24T11:58:30.000Z" },
        ],
        truncated: false,
      });
      emit("tui_activity", { sessionId: "sess_tui", kind: "turn_start" });
    },
  },
  {
    name: "iphone-owned-idle",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      // The absence case, for looking at: no row, no badge, nothing claiming
      // work. This is what the header version could never show.
      // Busy first, then idle: the roster transition is what closes the
      // stream, so an agent that was never busy would hold a streaming entry
      // forever and this frame would show a row it should not have.
      emit("agents", { agents: [AGENT] });
      press("session-open-sess_a");
      emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "thanks" }, messageId: "u1" },
      });
      emit("update", {
        agentId: "agt_a",
        seq: 2,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." }, messageId: "m1" },
      });
      emit("agents", { agents: [{ ...AGENT, state: "idle" }] });
    },
  },
  // The run history, and then one of its linked sessions opened over it. The
  // suites assert what these carry; what a picture answers is whether a run row
  // and its action rows still read at a card's width, and whether the session
  // pushed over the routines route covers it rather than sitting beside it.
  {
    name: "iphone-routine-runs",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("agents", { agents: [BRIEF_AGENT], scopes: CONNECTION.scopes });
      emit("sessions", { sessions: [GATHER_ROW, RENDER_ROW] });
      press("open-menu");
      press("menu-routines");
      emit("routines", { routines: [BRIEF_ROUTINE], runs: BRIEF_RUNS });
      press("run-run_0900-toggle");
    },
  },
  {
    name: "ipad-routine-runs",
    width: 1024,
    height: 1366,
    drive: (emit, press) => {
      emit("agents", { agents: [BRIEF_AGENT], scopes: CONNECTION.scopes });
      emit("sessions", { sessions: [GATHER_ROW, RENDER_ROW] });
      press("open-menu");
      press("menu-routines");
      emit("routines", { routines: [BRIEF_ROUTINE], runs: BRIEF_RUNS });
      press("run-run_0900-toggle");
    },
  },
  {
    name: "iphone-routine-run-session",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("agents", { agents: [BRIEF_AGENT], scopes: CONNECTION.scopes });
      emit("sessions", { sessions: [GATHER_ROW, RENDER_ROW] });
      press("open-menu");
      press("menu-routines");
      emit("routines", { routines: [BRIEF_ROUTINE], runs: BRIEF_RUNS });
      press("run-run_0900-toggle");
      press("run-run_0900-action-gather-open");
      emit("session_history", { agentId: "agt_gather", sessionId: "sess_gather", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_gather",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "gather this morning's facts" },
          messageId: "u1",
        },
      });
    },
  },
  {
    name: "ipad-routine-run-session",
    width: 1024,
    height: 1366,
    drive: (emit, press) => {
      emit("agents", { agents: [BRIEF_AGENT], scopes: CONNECTION.scopes });
      emit("sessions", { sessions: [GATHER_ROW, RENDER_ROW] });
      press("open-menu");
      press("menu-routines");
      emit("routines", { routines: [BRIEF_ROUTINE], runs: BRIEF_RUNS });
      press("run-run_0900-toggle");
      press("run-run_0900-action-gather-open");
      emit("session_history", { agentId: "agt_gather", sessionId: "sess_gather", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_gather",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "gather this morning's facts" },
          messageId: "u1",
        },
      });
    },
  },
  {
    // The clearance surface, which is the one place a picture is worth more
    // than a position assertion: an `ApprovalCard` carries three controls and
    // a tool payload, so it is the widest row the log ever renders and the
    // most likely to collide with the composer on the narrowest phone.
    name: "iphone-owned-approval",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("agents", { agents: [AGENT] });
      press("session-open-sess_a");
      emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "delete the stale worktrees" },
          messageId: "u1",
        },
      });
      emit("approval", {
        agentId: "agt_a",
        requestId: "req_1",
        title: "Run a command",
        tool: "bash",
        input: { command: "git worktree prune" },
      });
    },
  },
  {
    name: "ipad-owned-approval",
    width: 1024,
    height: 1366,
    drive: (emit, press) => {
      emit("agents", { agents: [AGENT] });
      press("session-open-sess_a");
      emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
      emit("update", {
        agentId: "agt_a",
        seq: 1,
        update: {
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "delete the stale worktrees" },
          messageId: "u1",
        },
      });
      emit("approval", {
        agentId: "agt_a",
        requestId: "req_1",
        title: "Run a command",
        tool: "bash",
        input: { command: "git worktree prune" },
      });
    },
  },
  {
    // Arriving, before any history lands. The frame that proves the load state
    // owns the pane rather than sitting above a half-built log: nothing here
    // may claim a turn, and nothing may show another session's rows.
    name: "iphone-owned-loading",
    width: 390,
    height: 844,
    drive: (emit, press) => {
      emit("agents", { agents: [AGENT] });
      press("session-open-sess_a");
    },
  },
];

mkdirSync("/tmp/frames", { recursive: true });

for (const frame of FRAMES) {
  setWindowSize(frame.width, frame.height);
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
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
  const emit = (name: string, event: unknown): void => {
    act(() => {
      client.emit(name, event);
    });
  };
  const press = (testID: string): void => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    if (!(found instanceof HTMLElement)) throw new Error(`${frame.name}: no ${testID}`);
    act(() => {
      found.click();
    });
  };
  emit("status", { state: "connected", attempt: 0 });
  frame.drive(emit, press);

  const rows = host.querySelectorAll('[data-testid="session-activity"]').length;
  const label = host.querySelector('[data-testid="session-activity"]')?.getAttribute("aria-label") ?? "(none)";
  // react-native-web builds its stylesheet through `insertRule`, so the
  // `<style>` nodes it owns have empty `textContent` and reading that produced
  // an unstyled frame. The rules live in the CSSOM; serialise those.
  const sheets = [...document.styleSheets];
  const styles = sheets
    .flatMap(sheet => {
      try {
        return [...sheet.cssRules].map(rule => rule.cssText);
      } catch {
        // A cross-origin sheet cannot be read. None here, but a silent empty
        // string beats a throw that loses every other sheet.
        return [];
      }
    })
    .join("\n");
  // The device box goes LAST so it wins: react-native-web emits its own
  // `html, body` reset, and a sizing rule declared before it lost. `display:
  // flex` is the other half -- the app's root is `flex: 1`, which needs a
  // parent with a bounded main axis or the whole column collapses and the log
  // renders at zero height.
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${frame.name}</title>
<style>${styles}</style>
<style>
html,body{margin:0!important;padding:0!important;background:#141310;overflow:hidden}
#frame{width:${frame.width}px;height:${frame.height}px;overflow:hidden;position:relative;display:flex;flex-direction:column}
#frame > *{flex:1 1 auto;min-height:0}
</style>
</head><body><div id="frame">${host.innerHTML}</div></body></html>`;
  writeFileSync(`/tmp/frames/${frame.name}.html`, html);
  console.log(`${frame.name.padEnd(26)} ${frame.width}x${frame.height}  rows=${rows}  label=${label}`);

  act(() => {
    root.unmount();
  });
  host.remove();
}
