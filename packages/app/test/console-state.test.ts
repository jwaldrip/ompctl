/**
 * The console reducer, driven by a canned frame stream.
 *
 * Everything that decides what is on screen goes through `apply`, so a stream
 * of frames here produces exactly the state a live daemon would. These are the
 * behaviours a broken port would actually ship: a strip that keeps a transcript
 * after its agent is gone, a summary spoken twice after a reconnect, approval
 * controls that stay live after the daemon has refused them.
 */

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import type { ConsoleEvent, ConsoleState } from "../src/console/state.ts";
import {
  agentFor,
  allStats,
  apply,
  browserSessionsOf,
  canInvite,
  emptyConsole,
  fleetClearances,
  sessionFor,
  stripStats,
  tuiPageToAskFor,
  tuiSessionFor,
} from "../src/console/state.ts";
import { EMPTY_SESSION } from "../src/session/model.ts";

interface Capture {
  stream: { update: unknown }[];
}

const capture: Capture = await Bun.file(new URL("../../../scripts/update-shapes.json", import.meta.url)).json();
const STREAM: readonly unknown[] = capture.stream.map(frame => frame.update);

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `agent ${id}`,
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/Users/someone/dev/src/thing",
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

/** The whole captured turn, as the daemon would stream it for one agent. */
function turn(agentId: string): ConsoleEvent[] {
  return STREAM.map((update, index) => ({
    t: "update" as const,
    event: { agentId, seq: index + 1, update },
  }));
}

describe("a canned stream drives the board", () => {
  test("the roster becomes strips with derived readings", () => {
    const state = drive([
      { t: "agents", event: { agents: [agent("a1", { state: "busy" }), agent("a2")], deviceId: "dev" } },
      ...turn("a1"),
    ]);

    expect(state.agents.length).toBe(2);
    const stats = allStats(state);
    const a1 = stats.get("a1");
    expect(a1).toBeDefined();
    expect(a1?.tools).toBe(4);
    // The captured turn reports usage, so the strip has a context reading.
    expect(a1?.contextFraction).not.toBeNull();
    expect(a1?.contextFraction ?? 0).toBeGreaterThan(0);
    // An agent nobody streamed has no session and therefore no readings.
    expect(stats.get("a2")).toBeUndefined();
  });

  test("the transcript is the reducer's, not a second copy of it", () => {
    const state = drive([{ t: "agents", event: { agents: [agent("a1")] } }, ...turn("a1")]);
    const session = sessionFor(state, "a1");
    expect(session.entries.filter(entry => entry.kind === "tool").length).toBe(4);
    expect(sessionFor(state, "a2")).toBe(EMPTY_SESSION);
  });

  test("watermarks track the highest seq per agent", () => {
    const state = drive([{ t: "agents", event: { agents: [agent("a1")] } }, ...turn("a1")]);
    expect(state.watermarks.get("a1")).toBe(STREAM.length);
  });

  test("keeps subagents in Agent Hub rather than creating an unusable session row", () => {
    const state = drive([
      {
        t: "agents",
        event: {
          agents: [agent("primary"), agent("scout", { parentAgentId: "primary" })],
        },
      },
    ]);

    expect(browserSessionsOf(state).map(session => session.id)).toEqual(["primary"]);
  });
});

describe("clearances", () => {
  const asked: ConsoleEvent[] = [
    { t: "agents", event: { agents: [agent("a1"), agent("a2")] } },
    { t: "select", agentId: "a1" },
    { t: "approval", event: { agentId: "a1", requestId: "r1", tool: "shell", title: "rm -rf /", input: {} } },
    { t: "approval", event: { agentId: "a2", requestId: "r2", tool: "shell", title: "ls", input: {} } },
  ];

  test("are counted across the fleet, not just the open strip", () => {
    const state = drive(asked);
    expect(fleetClearances(state)).toBe(2);
    expect(stripStats(sessionFor(state, "a2")).clearances).toBe(1);
  });

  test("one on a strip nobody is watching raises a notice", () => {
    const state = drive(asked);
    // a1 is open, so its request is on screen already; a2's is not.
    expect(state.notice).toBe("agent a2 needs a clearance.");
    expect(apply(state, { t: "dismiss" }).notice).toBeNull();
  });

  test("a decision settles the card and clears the count", () => {
    const state = drive([...asked, { t: "decide", agentId: "a1", requestId: "r1", choice: "deny" }]);
    expect(stripStats(sessionFor(state, "a1")).clearances).toBe(0);
    const card = sessionFor(state, "a1").entries.find(entry => entry.kind === "approval");
    expect(card).toMatchObject({ decision: "deny" });
  });
});

describe("what the daemon says", () => {
  test("a summary replayed after a reconnect is not shown twice", () => {
    const first = drive([
      { t: "agents", event: { agents: [agent("a1")] } },
      { t: "say", event: { agentId: "a1", seq: 12, text: "the build passed" } },
    ]);
    // A resume replays; `seq` is what lets the client tell old prose from new.
    const replayed = apply(first, { t: "say", event: { agentId: "a1", seq: 12, text: "the build passed" } });
    expect(replayed).toBe(first);

    const newer = apply(first, { t: "say", event: { agentId: "a1", seq: 13, text: "and deployed" } });
    expect(newer.spoken.get("a1")).toEqual({ seq: 13, text: "and deployed" });
  });

  test("a stale summary cannot overwrite a newer one", () => {
    const state = drive([
      { t: "say", event: { agentId: "a1", seq: 20, text: "new" } },
      { t: "say", event: { agentId: "a1", seq: 5, text: "old" } },
    ]);
    expect(state.spoken.get("a1")?.text).toBe("new");
  });
});

describe("browser actions", () => {
  test("one agent retains only its newest request and a stale result cannot clear it", () => {
    const first = apply(emptyConsole([]), {
      t: "webview_action",
      agentId: "a1",
      requestId: "request-1",
      action: { kind: "observe" },
    });
    const replaced = apply(first, {
      t: "webview_action",
      agentId: "a1",
      requestId: "request-2",
      action: { kind: "screenshot" },
    });

    expect(replaced.pendingWebViewActions.get("a1")?.requestId).toBe("request-2");
    expect(apply(replaced, { t: "webview_result", agentId: "a1", requestId: "request-1" })).toBe(replaced);

    const settled = apply(replaced, { t: "webview_result", agentId: "a1", requestId: "request-2" });
    expect(settled.pendingWebViewActions.has("a1")).toBe(false);
  });
});

describe("durable session history", () => {
  test("older structured blocks prepend once and live updates stay last", () => {
    const live = drive([
      {
        t: "update",
        event: {
          agentId: "a1",
          seq: 9,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m-live",
            content: { type: "text", text: "Live tail." },
          },
        },
      },
    ]);
    const withHistory = apply(live, {
      t: "session_history",
      event: {
        agentId: "a1",
        sessionId: "s1",
        nextBefore: 123,
        entries: [
          { kind: "user", id: "u1", text: "Earlier ask.", at: "" },
          { kind: "assistant", id: "m1", text: "Earlier thought.", thought: true, at: "" },
          {
            kind: "tool",
            id: "tc1",
            toolKind: "read",
            title: "Read policy",
            status: "completed",
            input: { path: "policy.ts" },
            output: "policy body",
            locations: ["policy.ts"],
            at: "",
          },
          { kind: "assistant", id: "m-live", text: "Live tail.", thought: false, at: "" },
        ],
      },
    });
    const entries = sessionFor(withHistory, "a1").entries;
    expect(entries.map(entry => entry.id)).toEqual(["u1", "m1", "tc1", "m-live"]);
    expect(withHistory.historyBefore.get("a1")).toBe(123);

    const repeated = apply(withHistory, {
      t: "session_history",
      event: {
        agentId: "a1",
        sessionId: "s1",
        nextBefore: null,
        entries: withHistory.sessions.get("a1")?.entries as never,
      },
    });
    expect(sessionFor(repeated, "a1").entries).toHaveLength(4);
  });

  test("history request marks loading until its page arrives", () => {
    const loading = apply(emptyConsole([]), { t: "history_request", agentId: "a1" });
    expect(loading.historyLoading.has("a1")).toBe(true);
    const settled = apply(loading, {
      t: "session_history",
      event: { agentId: "a1", sessionId: "s1", entries: [], nextBefore: null },
    });
    expect(settled.historyLoading.has("a1")).toBe(false);
  });
});

describe("paging a live terminal session's transcript", () => {
  const SESSION = "s-tui";
  const page = (texts: readonly string[], nextCursor: number | null, cursor?: number): ConsoleEvent => ({
    t: "session_tail",
    event: {
      sessionId: SESSION,
      messages: texts.map(text => ({ role: "user" as const, text, at: "" })),
      truncated: nextCursor !== null,
      nextCursor,
      ...(cursor === undefined ? {} : { cursor }),
    },
  });

  test("a first page replaces, an older page prepends, and the cursor follows the file backwards", () => {
    const first = apply(emptyConsole([]), page(["newest"], 900));
    expect(tuiSessionFor(first, SESSION).history.map(m => m.text)).toEqual(["newest"]);
    expect(tuiSessionFor(first, SESSION).historyCursor).toBe(900);

    const older = apply(first, page(["older"], 400, 900));
    // Older above newer, which is the order the operator reads, and the
    // page already on screen survives: a paged answer that replaced would
    // lose the turns being read.
    expect(tuiSessionFor(older, SESSION).history.map(m => m.text)).toEqual(["older", "newest"]);
    expect(tuiSessionFor(older, SESSION).historyCursor).toBe(400);

    const start = apply(older, page(["oldest"], null, 400));
    expect(tuiSessionFor(start, SESSION).history.map(m => m.text)).toEqual(["oldest", "older", "newest"]);
    // Nothing older left: the surface has no cursor to offer a control on.
    expect(tuiSessionFor(start, SESSION).historyCursor).toBeNull();
  });

  test("a fresh open replaces a paged history rather than stacking onto it", () => {
    const paged = drive([page(["newest"], 900), page(["older"], 400, 900)]);

    const reopened = apply(paged, page(["newest again"], 900));

    expect(tuiSessionFor(reopened, SESSION).history.map(m => m.text)).toEqual(["newest again"]);
    expect(tuiSessionFor(reopened, SESSION).historyCursor).toBe(900);
  });

  test("a page answering a cursor this session no longer holds is dropped", () => {
    // Frames cross the hub relay with no ordering guarantee, so a page asked
    // for before the operator left and came back can land after the fresh
    // tail. Prepending it would splice a stretch of file from nowhere onto
    // the transcript.
    const reopened = drive([page(["newest"], 900), page(["older"], 400, 900), page(["fresh"], 700)]);

    const stale = apply(reopened, page(["from the old ask"], 200, 400));

    expect(tuiSessionFor(stale, SESSION).history.map(m => m.text)).toEqual(["fresh"]);
    expect(tuiSessionFor(stale, SESSION).historyCursor).toBe(700);
  });

  test("an empty older page adds no rows but carries the cursor deeper into the file", () => {
    const asked = drive([page(["newest"], 900), { t: "tui_history_request", sessionId: SESSION }]);
    expect(tuiSessionFor(asked, SESSION).historyLoadingEarlier).toBe(true);

    const silent = apply(asked, page([], 500, 900));

    expect(tuiSessionFor(silent, SESSION).history.map(m => m.text)).toEqual(["newest"]);
    expect(tuiSessionFor(silent, SESSION).historyCursor).toBe(500);
    expect(tuiSessionFor(silent, SESSION).historyLoadingEarlier).toBe(false);
  });

  test("an empty page with file behind it is asked on from; anything else settles", () => {
    const silent = page([], 500, 900);
    if (silent.t !== "session_tail") throw new Error("expected a session_tail event");
    // The whole point: a screenful of tool traffic said nothing, and the
    // operator asked for words. Stopping here would leave the tap unanswered
    // with megabytes still behind it.
    expect(tuiPageToAskFor(silent.event)).toBe(500);

    const withWords = page(["something"], 500, 900);
    const atStart = page([], null, 900);
    const firstOpen = page([], 500);
    // A cursor that cannot advance would be asked for forever: one line
    // bigger than the whole read budget is the only way to get here.
    const stuck = page([], 900, 900);
    for (const settled of [withWords, atStart, firstOpen, stuck]) {
      if (settled.t !== "session_tail") throw new Error("expected a session_tail event");
      expect(tuiPageToAskFor(settled.event)).toBeNull();
    }
  });
});

describe("the roster is the authority", () => {
  test("one snapshot without the open agent keeps the session it just opened", () => {
    const state = drive([
      { t: "agents", event: { agents: [agent("a1"), agent("a2")] } },
      { t: "select", agentId: "a2" },
      ...turn("a2"),
      // A snapshot taken before the resume registered the agent can land
      // after the open, because the relay guarantees no frame order.
      { t: "agents", event: { agents: [agent("a1")] } },
    ]);

    expect(state.sessions.has("a2")).toBe(true);
    expect(state.watermarks.has("a2")).toBe(true);
    expect(state.selected).toBe("a2");
    expect(state.notice).toBeNull();
  });

  test("repeated roster misses mark the agent stopped but keep its transcript selected", () => {
    const state = drive([
      { t: "agents", event: { agents: [agent("a1"), agent("a2", { acpSessionId: "s2", parentAgentId: "a1" })] } },
      { t: "select", agentId: "a2" },
      ...turn("a2"),
      { t: "agents", event: { agents: [agent("a1")] } },
      { t: "agents", event: { agents: [agent("a1")] } },
    ]);

    expect(state.sessions.has("a2")).toBe(true);
    expect(state.watermarks.has("a2")).toBe(true);
    expect(state.selected).toBe("a2");
    expect(state.notice).toBeNull();
    expect(agentFor(state, "a2")?.state).toBe("stopped");
    expect(agentFor(state, "a2")).toMatchObject({ acpSessionId: "s2", parentAgentId: "a1" });
  });

  test("a terminal agent leaving the roster keeps its complete transcript viewable", () => {
    const state = drive([
      {
        t: "agents",
        event: { agents: [agent("a1"), agent("a2", { state: "stopped", acpSessionId: "s2", parentAgentId: "a1" })] },
      },
      { t: "select", agentId: "a2" },
      ...turn("a2"),
      { t: "agents", event: { agents: [agent("a1")] } },
    ]);

    expect(state.sessions.has("a2")).toBe(true);
    expect(sessionFor(state, "a2").entries.length).toBeGreaterThan(0);
    expect(state.selected).toBe("a2");
    expect(agentFor(state, "a2")?.state).toBe("stopped");
    expect(agentFor(state, "a2")).toMatchObject({ acpSessionId: "s2", parentAgentId: "a1" });
  });

  test("an update retires the absence streak, so a streaming agent survives stale rosters", () => {
    const state = drive([
      { t: "agents", event: { agents: [agent("a1"), agent("a2")] } },
      ...turn("a2"),
      { t: "agents", event: { agents: [agent("a1")] } },
      {
        t: "update",
        event: {
          agentId: "a2",
          seq: 999,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "still here" },
            messageId: "late",
          },
        },
      },
      { t: "agents", event: { agents: [agent("a1")] } },
    ]);

    expect(state.sessions.has("a2")).toBe(true);
  });

  test("a re-select retires the absence streak, so a double-tap resume cannot be reaped", () => {
    const state = drive([
      { t: "agents", event: { agents: [agent("a1"), agent("a2")] } },
      { t: "select", agentId: "a2" },
      ...turn("a2"),
      { t: "agents", event: { agents: [agent("a1")] } },
      // The second answer a double tap earns: same agent, selected again.
      { t: "select", agentId: "a2" },
      { t: "agents", event: { agents: [agent("a1")] } },
    ]);

    expect(state.sessions.has("a2")).toBe(true);
    expect(state.selected).toBe("a2");
  });

  test("an agent the roster never listed still opens once its replay starts", () => {
    // The daemon answers a resume with `session_opened` and streams the
    // replay, but its roster pushes only reach sockets that already held an
    // attachment, so the resumed agent may be absent from every roster frame
    // this device has seen.
    const state = drive([
      { t: "agents", event: { agents: [agent("a1")] } },
      { t: "select", agentId: "a2" },
      ...turn("a2"),
    ]);

    expect(state.selected).toBe("a2");
    const resolved = agentFor(state, "a2");
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe("a2");
    // The roster entry still wins whenever the roster does list the agent.
    expect(agentFor(state, "a1")?.name).toBe("agent a1");
  });

  test("a vouched agent renders its stand-in before its first frame lands", () => {
    // The resume answer selects, attaches, and asks for the first history
    // page; the replay and the page are still on the wire. Claiming the
    // session closed in this window is the dead end a dormant tap landed on:
    // the claim was false for the whole of the daemon's read.
    const opening = drive([
      { t: "agents", event: { agents: [agent("a1")] } },
      { t: "select", agentId: "a2" },
      { t: "history_request", agentId: "a2" },
    ]);
    const standIn = agentFor(opening, "a2");
    expect(standIn).not.toBeNull();
    expect(standIn?.state).toBe("idle");

    // An empty first page folds no session entry, and the answer must not
    // resurrect the closed claim either: the daemon still vouched for the
    // agent, and its replay may yet stream.
    const answered = apply(opening, {
      t: "session_history",
      event: { agentId: "a2", sessionId: "s2", entries: [], nextBefore: null },
    });
    expect(agentFor(answered, "a2")).not.toBeNull();
  });

  test("a turn that stopped leaves nothing streaming", () => {
    const state = drive([
      { t: "agents", event: { agents: [agent("a1", { state: "busy" })] } },
      {
        t: "update",
        event: {
          agentId: "a1",
          seq: 1,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" }, messageId: "m" },
        },
      },
      { t: "agents", event: { agents: [agent("a1", { state: "idle" })] } },
    ]);

    const streaming = sessionFor(state, "a1").entries.filter(entry => entry.kind === "assistant" && entry.streaming);
    expect(streaming.length).toBe(0);
  });
});

describe("scope", () => {
  test("a pairing that declared no scopes stays optimistic", () => {
    expect(emptyConsole([]).canApprove).toBe(true);
    expect(emptyConsole(["read"]).canApprove).toBe(false);
    expect(emptyConsole(["read", "approve"]).canApprove).toBe(true);
  });

  test("the daemon's refusal downgrades the controls and says why", () => {
    const state = apply(emptyConsole([]), {
      t: "error",
      event: { code: "forbidden", message: "device may not approve" },
    });
    expect(state.canApprove).toBe(false);
    expect(state.refusal).toContain("approve scope");
  });

  test("an ordinary error is a notice, not a downgrade", () => {
    const state = apply(emptyConsole([]), { t: "error", event: { message: "prompt rejected" } });
    expect(state.canApprove).toBe(true);
    expect(state.notice).toBe("prompt rejected");
  });
});

describe("granted scopes", () => {
  test("hello's answer overrules the stored pairing in both directions", () => {
    // A one-tap link once carried no scopes, so the stored hint can be
    // wrong either way. The daemon's hello is what the daemon enforces,
    // so it is what the console believes.
    const widened = apply(emptyConsole(["read", "prompt"]), {
      t: "agents",
      event: { agents: [], deviceId: "dev_phone", scopes: ["read", "prompt", "approve"] },
    });
    expect(widened.grantedScopes).toEqual(["read", "prompt", "approve"]);
    expect(widened.canApprove).toBe(true);
    expect(canInvite(widened, ["read", "prompt"])).toBe(true);

    // The narrowing direction is the one that protects the operator from
    // a stale hint: a rotated grant takes the controls away even though
    // the stored connection still claims them.
    const narrowed = apply(emptyConsole(["read", "prompt", "approve"]), {
      t: "agents",
      event: { agents: [], deviceId: "dev_phone", scopes: ["read", "prompt"] },
    });
    expect(narrowed.grantedScopes).toEqual(["read", "prompt"]);
    expect(narrowed.canApprove).toBe(false);
    expect(canInvite(narrowed, ["read", "prompt", "approve"])).toBe(false);
  });

  test("a daemon that reports no scopes leaves the stored hint holding the controls", () => {
    // An older daemon never says; absence is unknown, not an empty grant,
    // or every gated control would hide against a working daemon.
    const state = apply(emptyConsole(["read", "approve"]), {
      t: "agents",
      event: { agents: [], deviceId: "dev_phone" },
    });
    expect(state.grantedScopes).toBeUndefined();
    expect(state.canApprove).toBe(true);
    expect(canInvite(state, ["read", "approve"])).toBe(true);

    const bare = apply(emptyConsole([]), { t: "agents", event: { agents: [], deviceId: "dev_phone" } });
    expect(canInvite(bare, [])).toBe(true);
  });

  test("the stored value decides before hello arrives", () => {
    expect(canInvite(emptyConsole(["read", "approve"]), ["read", "approve"])).toBe(true);
    expect(canInvite(emptyConsole(["read", "prompt"]), ["read", "prompt"])).toBe(false);
    // A pairing that declared nothing stays optimistic, exactly as canApprove does.
    expect(canInvite(emptyConsole([]), [])).toBe(true);
  });
});

describe("connection", () => {
  test("status carries the retry countdown through to the readout", () => {
    const state = apply(emptyConsole([]), {
      t: "status",
      event: { state: "reconnecting", attempt: 3, delayMs: 4000 },
    });
    expect(state.connection).toBe("reconnecting");
    expect(state.attempt).toBe(3);
    expect(state.delayMs).toBe(4000);
  });

  test("a withdrawn credential is terminal", () => {
    const state = apply(emptyConsole([]), {
      t: "unauthorized",
      event: { reason: "The daemon rejected this device's token." },
    });
    expect(state.unauthorized).toContain("rejected");
    expect(state.connection).toBe("offline");
  });
});
