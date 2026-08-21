/**
 * Everything the console knows, and the one function that changes it.
 *
 * The session reducer turns one agent's update stream into a transcript. This
 * turns the whole client event stream into a screen: which agents exist, which
 * one is open, whether the link is up, and what this device is still allowed to
 * do. It is pure for the same reason the session reducer is: a canned stream of
 * frames must produce exactly the state a live daemon would, or the tests prove
 * nothing about the real thing.
 *
 * Sessions are kept for every agent whether or not it is on screen, so
 * switching strips is instant and a strip nobody is watching still reports its
 * load and its spend.
 */

import type {
  Agent,
  AgentId,
  ApprovalChoice,
  PlanReviewChoice,
  SessionSummary,
  TranscriptTailMessage,
  WebViewAction,
} from "@ompd/core/contracts";
import { SCOPE_APPROVE, SCOPE_PROMPT, TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type {
  AgentsEvent,
  ApprovalEvent,
  ClientErrorEvent,
  ConnectionState,
  PlanReviewEvent,
  SayEvent,
  SessionHistoryEvent,
  SessionTailEvent,
  StatusEvent,
  TuiActivityEvent,
  UnauthorizedEvent,
  UpdateEvent,
} from "@ompd/core/ompd-client";
import type { BrowserSession } from "../session/browser.ts";
import type { SessionState } from "../session/model.ts";
import {
  appendApproval,
  appendPrompt,
  EMPTY_SESSION,
  endTurn,
  mergeSessionHistory,
  reduce,
  resolveApproval,
  resolvePlanReview,
  setPlanReview,
} from "../session/model.ts";

/**
 * What a strip shows. Kept here rather than beside a component, because the
 * component that rendered it is gone and this is a pure derived shape a
 * future readout can reuse without pulling in a view.
 */
export interface StripStats {
  /** Fraction of the context window consumed, in `[0, 1]`. Null when unknown. */
  contextFraction: number | null;
  costAmount: number | null;
  costCurrency: string;
  tools: number;
  running: number;
  clearances: number;
}

/**
 * The sole agent action awaiting the selected screen's embedded browser.
 *
 * The daemon serializes actions for a target, but retaining the request id is
 * still necessary: a stale driver's completion must never erase a newer
 * action for the same agent.
 */
export interface PendingWebViewAction {
  requestId: string;
  action: WebViewAction;
}

/**
 * Error codes that mean the daemon overruled this device, not that the link
 * broke. The gateway wears `unauthorized` for both a dead token and a missing
 * scope; the client settles the first case on its own and emits
 * `unauthorized`, so seeing the code here means the second.
 */
const SCOPE_CODES: Record<string, true> = { forbidden: true, scope: true, unauthorized: true };

/**
 * Error codes the client itself emits when the link, not the daemon's
 * judgement, broke: the socket errored, never opened, went silent past the
 * pong deadline, or swallowed a send. A notice carrying one of these is a
 * claim about the connection, and a connection that has demonstrably
 * re-established itself has disproved the claim, so recovery clears what a
 * tap otherwise would. The daemon's own codes stay out, because a reconnect
 * says nothing about them: "prompt rejected" is still true after one.
 */
const LINK_CODES: Record<string, true> = {
  socket: true,
  socket_open: true,
  timeout: true,
  offline: true,
  send: true,
};

export interface ConsoleState {
  readonly agents: readonly Agent[];
  readonly sessions: ReadonlyMap<AgentId, SessionState>;
  /**
   * Every session on this machine, as the daemon's index last reported it.
   *
   * Held separately from `agents` because the two answer different questions:
   * an agent is a session this daemon currently holds, while the index is
   * every session on the machine, held by this daemon or not. The browser
   * must list the second, not the first, or every session no agent is
   * driving, which is most of a long-running machine's history, is invisible.
   */
  readonly sessionIndex: readonly SessionSummary[];
  /** Highest `seq` seen per agent, for the readout and for `say` de-duplication. */
  readonly watermarks: ReadonlyMap<AgentId, number>;
  /**
   * Consecutive roster snapshots that lacked an agent while its session lived.
   *
   * The roster arrives as snapshots over a relay that guarantees no ordering
   * against `session_opened` or update frames, so one snapshot missing an
   * agent proves nothing: it is routinely older than the resume that just
   * created the agent. Deletion waits for corroborated absence, and any
   * update or selection resets the streak, because both are newer evidence
   * the agent exists than any snapshot in flight.
   */
  readonly rosterMisses: ReadonlyMap<AgentId, number>;
  /** Latest spoken summary per agent. Text only; this build has no voice. */
  readonly spoken: ReadonlyMap<AgentId, { seq: number; text: string }>;
  /** Opaque byte cursor for the next older durable history page per agent. */
  readonly historyBefore: ReadonlyMap<AgentId, number | null>;
  readonly historyLoading: ReadonlySet<AgentId>;
  readonly connection: ConnectionState;
  readonly attempt: number;
  readonly delayMs: number | undefined;
  readonly selected: AgentId | null;
  /**
   * The live terminal session whose prompt surface is open, or null.
   *
   * Held beside `selected` rather than inside it because the two detail panes
   * answer different shapes: an agent has a transcript this device attaches
   * to, a terminal session has only the hints below. Exactly one of the two
   * is ever non-null; the reducer enforces the exclusivity.
   */
  readonly selectedTui: string | null;
  /** Hints about terminal sessions this device has prompted. Keyed by session id. */
  readonly tuiSessions: ReadonlyMap<string, TuiSessionState>;
  /** At most one browser action per agent. Completion is correlated by request id. */
  readonly pendingWebViewActions: ReadonlyMap<AgentId, PendingWebViewAction>;
  /**
   * The scopes the daemon's hello says this device holds, once it has said.
   * The authority behind `canApprove` and `canInvite`: a stored pairing
   * hint goes stale the moment a grant is rotated or narrowed, while this
   * answer is the record the daemon enforces against. Undefined until a
   * daemon that reports scopes has answered, and an older daemon never
   * does, so absence must read as "unknown" rather than "none" or every
   * gated control would hide against a working daemon.
   */
  readonly grantedScopes: readonly string[] | undefined;
  readonly canApprove: boolean;
  /** Why approval is refused, once the daemon has actually refused it. */
  readonly refusal: string | undefined;
  /**
   * Transient message for the operator. Cleared by `dismiss`, or by recovery
   * when the notice is about the link rather than an operator action.
   */
  readonly notice: string | null;
  /**
   * Whether `notice` describes the link. A link notice is a claim about the
   * connection, so a connection reaching `connected` again retires it: a
   * healed link must not keep wearing an error, and a broken one never
   * reaches `connected` to clear it. Every other notice stays put through a
   * reconnect, which says nothing about a clearance or a refusal.
   */
  readonly noticeAboutLink: boolean;
  /** Set once the daemon has confirmed the token is dead. Terminal. */
  readonly unauthorized: string | null;
}

/**
 * What this device knows about its right to steer a terminal session.
 *
 * `unknown` preserves compatibility with a pairing or daemon that never
 * reported scopes. Only `missing` is a refusal, because absence of evidence
 * from an older peer must not silently remove a control that may still work.
 */
export type TuiPromptAccess = "granted" | "unknown" | "missing";

/** The two prompt refusals this screen can repair differently. */
export type TuiPromptRefusalKind = "owner-gone" | "scope";
/**
 * What this device holds about one live terminal session, keyed by session id
 * because a terminal session has no agent row.
 *
 * Two different things live here, and the distinction is load-bearing.
 * `history` is transcript: the turns the daemon read out of the session's own
 * file when this surface opened, oldest first. Everything else is a hint,
 * because `tui_activity` frames are the terminal's own progress reporting and
 * the wire contract says so: `reply` holds only the last text, `sent` only
 * the prompt this device most recently sent, and neither accumulates.
 */
export interface TuiSessionState {
  /**
   * The last prompt this device sent, kept until the terminal reports taking
   * the turn. Live activity is not appended to the served history, so without
   * this echo the operator's own words vanish on submit.
   */
  readonly sent: string | null;
  /** True between the terminal's own `turn_start` and `turn_end`. */
  readonly busy: boolean;
  /**
   * True after this phone steers and until that terminal turn settles.
   * Terminal activity that started elsewhere leaves it false, so an empty
   * terminal-only turn does not become a false refusal on this device.
   */
  readonly awaitingReply: boolean;
  /** The last `assistant_text` the terminal reported, verbatim. */
  readonly reply: string | null;
  /**
   * The steered turn ended without readable assistant text. The full terminal
   * transcript remains authoritative; this names that boundary on the phone.
   */
  readonly replyUnavailable: boolean;
  /** Why the daemon refused the last prompt, once it has. */
  readonly refusal: string | null;
  /** Stable refusal vocabulary for the screen heading and recovery copy. */
  readonly refusalKind: TuiPromptRefusalKind | null;
  /**
   * The transcript tail the daemon served for this session, oldest first.
   *
   * Replaced wholesale by each `session_tail` frame rather than merged: the
   * daemon reads the file's end every time it is asked, so the newest answer
   * is the truth and a merge would only invent an ordering neither side
   * agreed on.
   */
  readonly history: readonly TranscriptTailMessage[];
  /** True when older turns exist above the tail the daemon served. */
  readonly historyTruncated: boolean;
}

const EMPTY_TUI_SESSION: TuiSessionState = {
  sent: null,
  busy: false,
  awaitingReply: false,
  reply: null,
  replyUnavailable: false,
  refusal: null,
  refusalKind: null,
  history: [],
  historyTruncated: false,
};

/**
 * What an operator can repair after the session index and the live socket
 * disagreed. The row may still say live while its owner already closed,
 * switched sessions, or lost the bridge, so the remedy starts at the terminal.
 */
const TUI_UNREACHABLE_GUIDANCE =
  "The terminal that owned this session is no longer reachable. Return to that terminal, make sure this session is still open, then try again.";

/** Scope refusals cannot be repaired by retrying the same instruction. */
const TUI_SCOPE_GUIDANCE =
  "This device does not hold the prompt scope. Pair it again with prompt access before steering this terminal.";

export function emptyConsole(scopes: readonly string[]): ConsoleState {
  return {
    agents: [],
    sessions: new Map(),
    sessionIndex: [],
    watermarks: new Map(),
    rosterMisses: new Map(),
    historyBefore: new Map(),
    historyLoading: new Set(),
    spoken: new Map(),
    connection: "connecting",
    attempt: 0,
    delayMs: undefined,
    selected: null,
    selectedTui: null,
    tuiSessions: new Map(),
    pendingWebViewActions: new Map(),
    // A pairing that did not declare its scopes stays optimistic; the daemon's
    // first refusal is what downgrades it.
    canApprove: scopes.length === 0 || scopes.includes(SCOPE_APPROVE),
    grantedScopes: undefined,
    refusal: undefined,
    notice: null,
    noticeAboutLink: false,
    unauthorized: null,
  };
}

export type ConsoleEvent =
  | { t: "status"; event: StatusEvent }
  | { t: "agents"; event: AgentsEvent }
  /** Daemon: the machine's full session index, answering this device's ask. */
  | { t: "sessions"; event: { sessions: readonly SessionSummary[] } }
  | { t: "update"; event: UpdateEvent }
  | { t: "approval"; event: ApprovalEvent }
  | { t: "plan_review"; event: PlanReviewEvent }
  | { t: "error"; event: ClientErrorEvent }
  | { t: "say"; event: SayEvent }
  | { t: "unauthorized"; event: UnauthorizedEvent }
  /** Daemon: turn progress from a live terminal session this device can prompt. */
  | { t: "tui_activity"; event: TuiActivityEvent }
  /** Daemon: the tail of a terminal session's transcript, answering this device's ask. */
  | { t: "session_tail"; event: SessionTailEvent }
  | { t: "session_history"; event: SessionHistoryEvent }
  | { t: "history_request"; agentId: AgentId }
  /** Local: the operator opened a terminal session's prompt surface, or went back to the bay. */
  | { t: "tui_select"; sessionId: string | null }
  /** Local: echo of a prompt this device just sent to a terminal session. */
  | { t: "tui_prompt"; sessionId: string; text: string }
  /** Local: the operator opened a strip, or went back to the bay. */
  | { t: "select"; agentId: AgentId | null }
  /** Local: echo of a prompt this device just sent. */
  | { t: "prompt"; agentId: AgentId; text: string }
  /** Local: a clearance this device just settled. */
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice }
  | { t: "plan_decide"; agentId: AgentId; requestId: string; choice: PlanReviewChoice }
  /** Daemon: an already-authorized action for this agent's registered WebView. */
  | { t: "webview_action"; agentId: AgentId; requestId: string; action: WebViewAction }
  /** Local: exactly this action was answered, or its screen went away. */
  | { t: "webview_result"; agentId: AgentId; requestId: string }
  | { t: "dismiss" };

/**
 * Folds one event into the console. Returns the same state by reference when
 * nothing changed, so React skips the render.
 */
export function apply(state: ConsoleState, event: ConsoleEvent): ConsoleState {
  switch (event.t) {
    case "status": {
      const next = {
        ...state,
        connection: event.event.state,
        attempt: event.event.attempt,
        delayMs: event.event.delayMs,
      };
      // `connected` is the client reporting a completed handshake, the same
      // proof the status readout trusts, so it also retires a link notice:
      // the condition the notice described is over. No timer does this and
      // nothing else may, because a link that never recovers never sees this
      // state, so its notice stays on screen exactly as long as the break does.
      if (event.event.state === "connected" && state.noticeAboutLink) {
        return { ...next, notice: null, noticeAboutLink: false };
      }
      return next;
    }

    case "agents": {
      const next = applyAgents(state, event.event.agents);
      // Hello's scopes are the daemon's own record, and they win in both
      // directions: a grant widened since pairing surfaces its controls, and
      // one narrowed or rotated takes them away, which is the direction that
      // protects the operator from a stale hint. An older daemon reports no
      // scopes at all, and that absence is "unknown", not "none": the stored
      // pairing keeps holding the controls until a refusal or a newer daemon
      // says otherwise.
      if (event.event.scopes === undefined) return next;
      return {
        ...next,
        grantedScopes: event.event.scopes,
        canApprove: event.event.scopes.includes(SCOPE_APPROVE),
      };
    }
    case "sessions":
      return applySessions(state, event.event.sessions);

    case "update": {
      const { agentId, seq, update } = event.event;
      const watermarks = new Map(state.watermarks);
      watermarks.set(agentId, seq);
      // An update frame is newer evidence that the agent exists than any
      // roster snapshot in flight over the relay, so a session still receiving
      // updates can never be reaped by a stale roster.
      const rosterMisses = clearMiss(state.rosterMisses, agentId);
      return { ...withSession(state, agentId, session => reduce(session, update)), watermarks, rosterMisses };
    }
    case "approval": {
      const { agentId, requestId, tool, title, input } = event.event;
      const next = withSession(state, agentId, session => appendApproval(session, { requestId, tool, title, input }));
      if (agentId === state.selected) return next;
      const name = state.agents.find(agent => agent.id === agentId)?.name ?? "An agent";
      return { ...next, notice: `${name} needs a clearance.`, noticeAboutLink: false };
    }

    case "plan_review": {
      const { agentId, requestId, message, choices } = event.event;
      const next = withSession(state, agentId, session => setPlanReview(session, { requestId, message, choices }));
      if (agentId === state.selected) return next;
      const name = state.agents.find(agent => agent.id === agentId)?.name ?? "An agent";
      return { ...next, notice: `${name} needs a plan review.`, noticeAboutLink: false };
    }

    case "error": {
      const { code, message } = event.event;
      const selectedTui = state.selectedTui;
      const promptPending = selectedTui !== null && (state.tuiSessions.get(selectedTui)?.sent ?? null) !== null;
      // Prompt errors carry no session id, but a local prompt echo means this
      // open terminal screen has exactly one request awaiting an answer. A
      // refusal after the operator left has no honest screen correlation and
      // falls through to the ordinary notice path.
      if (code === "tui_unreachable" && selectedTui !== null) {
        return withTuiSession(state, selectedTui, tui => ({
          ...tui,
          sent: null,
          awaitingReply: false,
          replyUnavailable: false,
          refusal: TUI_UNREACHABLE_GUIDANCE,
          refusalKind: "owner-gone",
        }));
      }
      if (code !== undefined && SCOPE_CODES[code] && promptPending && selectedTui !== null) {
        return withTuiSession(state, selectedTui, tui => ({
          ...tui,
          sent: null,
          awaitingReply: false,
          replyUnavailable: false,
          refusal: TUI_SCOPE_GUIDANCE,
          refusalKind: "scope",
        }));
      }
      if (code !== undefined && SCOPE_CODES[code]) {
        return {
          ...state,
          canApprove: false,
          refusal: `${message}. Sign this from a device holding the approve scope.`,
          notice: message,
          noticeAboutLink: false,
        };
      }
      // The client's own transport codes describe the link; the daemon's
      // describe a request. Only the first kind may be cleared by recovery.
      const aboutLink = code !== undefined && LINK_CODES[code] === true;
      return { ...state, notice: message, noticeAboutLink: aboutLink };
    }

    case "say":
      return applySay(state, event.event);

    case "unauthorized":
      return { ...state, unauthorized: event.event.reason, connection: "offline" };

    case "select": {
      // Back goes to the bay from either detail pane, and an agent landing
      // (a resume claim answered) replaces an open terminal surface: the two
      // panes are exclusive by construction, not by caller discipline.
      if (event.agentId === null) {
        return state.selected === null && state.selectedTui === null
          ? state
          : { ...state, selected: null, selectedTui: null };
      }
      // Selecting an agent rides the daemon's `session_opened` answer or a
      // roster row, and both are newer than a snapshot still in flight over
      // the relay, so the choice also retires any pending absence streak: a
      // resume the daemon just confirmed must not be undone by a roster
      // photograph taken before the resumed agent was registered. A double
      // tap answers twice, so the re-select retires the streak too.
      const rosterMisses = clearMiss(state.rosterMisses, event.agentId);
      if (state.selected === event.agentId && state.selectedTui === null) {
        return rosterMisses === state.rosterMisses ? state : { ...state, rosterMisses };
      }
      return { ...state, selected: event.agentId, selectedTui: null, rosterMisses };
    }

    case "tui_select": {
      if (event.sessionId === null) {
        return state.selectedTui === null ? state : { ...state, selectedTui: null };
      }
      if (state.selectedTui === event.sessionId && state.selected === null) return state;
      return { ...state, selectedTui: event.sessionId, selected: null };
    }

    case "tui_prompt":
      return withTuiSession(state, event.sessionId, tui => ({
        ...tui,
        sent: event.text,
        awaitingReply: true,
        reply: null,
        replyUnavailable: false,
        refusal: null,
        refusalKind: null,
      }));

    case "tui_activity":
      return applyTuiActivity(state, event.event);

    case "session_tail":
      return withTuiSession(state, event.event.sessionId, tui => ({
        ...tui,
        history: event.event.messages,
        historyTruncated: event.event.truncated,
      }));

    case "history_request": {
      const historyLoading = new Set(state.historyLoading);
      historyLoading.add(event.agentId);
      return { ...state, historyLoading };
    }

    case "session_history": {
      const { agentId, entries, nextBefore } = event.event;
      const next = withSession(state, agentId, session => mergeSessionHistory(session, entries));
      const historyBefore = new Map(next.historyBefore);
      historyBefore.set(agentId, nextBefore);
      const historyLoading = new Set(next.historyLoading);
      historyLoading.delete(agentId);
      return { ...next, historyBefore, historyLoading };
    }

    case "prompt":
      return withSession(state, event.agentId, session => appendPrompt(session, event.text));

    case "decide":
      return withSession(state, event.agentId, session => resolveApproval(session, event.requestId, event.choice));

    case "plan_decide":
      return withSession(state, event.agentId, session => resolvePlanReview(session, event.requestId));
    case "webview_action": {
      const pendingWebViewActions = new Map(state.pendingWebViewActions);
      pendingWebViewActions.set(event.agentId, { requestId: event.requestId, action: event.action });
      return { ...state, pendingWebViewActions };
    }

    case "webview_result": {
      const pending = state.pendingWebViewActions.get(event.agentId);
      if (pending?.requestId !== event.requestId) return state;
      const pendingWebViewActions = new Map(state.pendingWebViewActions);
      pendingWebViewActions.delete(event.agentId);
      return { ...state, pendingWebViewActions };
    }

    case "dismiss":
      return state.notice === null ? state : { ...state, notice: null, noticeAboutLink: false };

    default:
      return state;
  }
}

/**
 * The roster is the authority on which agents exist, but a snapshot is a
 * photograph, not a verdict. Frames cross the hub relay with no ordering
 * guarantee against each other, so the snapshot that lands after a resume was
 * routinely taken before the resumed agent was registered, and the daemon's
 * roster pushes only reach sockets that already hold an attachment, which a
 * phone opening its first session is not. Deleting a session on one absence
 * would tear down the very session the operator just opened, which is the
 * dead end a dormant tap used to land on.
 *
 * So an absent agent is deleted only on corroborated absence: a second
 * consecutive snapshot without it, or a single one after the previous roster
 * showed it stopped or failed. A terminal agent is never coming back on that
 * id. Its disappearance from a later snapshot changes liveness, never
 * history: the transcript is durable and must remain viewable after its
 * process exits. Updates and selections reset the streak elsewhere in this
 * file, which keeps the resume race honest; two misses only make the stand-in
 * terminal and retire actions that need a live host.
 */
function applyAgents(state: ConsoleState, agents: readonly Agent[]): ConsoleState {
  const before = new Map(state.agents.map(agent => [agent.id, agent]));
  const live = new Set(agents.map(agent => agent.id));

  // The daemon roster is liveness, not the only copy of identity. Keep rows
  // it drops as stopped so transcripts do not lose their title, cwd, session
  // id, or parentAgentId. That metadata is what makes a stopped subagent both
  // navigable and resumable; replacing it with an anonymous stand-in is the
  // same blink-out in a quieter form.
  const retainedAgents: Agent[] = [...agents];
  for (const previous of state.agents) {
    if (live.has(previous.id)) continue;
    retainedAgents.push(TERMINAL_AGENT_STATES.includes(previous.state) ? previous : { ...previous, state: "stopped" });
  }

  const sessions = new Map(state.sessions);
  for (const agent of agents) {
    // A turn that has stopped leaves nothing streaming, whatever the last
    // chunk claimed. Without this an interrupted turn keeps its caret forever.
    if (agent.state !== "busy" && before.get(agent.id)?.state === "busy") {
      const session = sessions.get(agent.id);
      if (session !== undefined) sessions.set(agent.id, endTurn(session));
    }
  }

  const pendingWebViewActions = new Map(state.pendingWebViewActions);
  const rosterMisses = new Map(state.rosterMisses);
  for (const agentId of sessions.keys()) {
    if (live.has(agentId)) {
      rosterMisses.delete(agentId);
      continue;
    }
    const previous = before.get(agentId);
    const wasTerminal = previous !== undefined && TERMINAL_AGENT_STATES.includes(previous.state);
    const misses = wasTerminal ? 2 : Math.min(2, (rosterMisses.get(agentId) ?? 0) + 1);
    rosterMisses.set(agentId, misses);
    if (misses < 2) continue;

    // No host can settle these after two agreeing roster misses. Transcript,
    // watermarks and spoken output stay: they are history, not liveness.
    pendingWebViewActions.delete(agentId);
    const session = sessions.get(agentId);
    if (session !== undefined) sessions.set(agentId, endTurn(session));
  }

  return {
    ...state,
    agents: retainedAgents,
    sessions,
    pendingWebViewActions,
    rosterMisses,
  };
}

/**
 * The index replaces itself wholesale. It is a snapshot of the whole machine,
 * so merging would only ever keep rows the daemon has already dropped, and a
 * shorter answer than the last one is the machine telling the truth.
 */
function applySessions(state: ConsoleState, sessions: readonly SessionSummary[]): ConsoleState {
  if (state.sessionIndex === sessions) return state;
  return { ...state, sessionIndex: sessions };
}

/**
 * A rendering hint and nothing more. `seq` is the update the prose derives
 * from, so a replay after a reconnect cannot make the app repeat a summary it
 * has already shown, and a stale frame cannot overwrite a newer one.
 */

function applySay(state: ConsoleState, event: SayEvent): ConsoleState {
  const previous = state.spoken.get(event.agentId);
  if (previous !== undefined && event.seq <= previous.seq) return state;
  const spoken = new Map(state.spoken);
  spoken.set(event.agentId, { seq: event.seq, text: event.text });
  return { ...state, spoken };
}

/**
 * Drops one agent's absence streak. Allocates only when there is a streak to
 * drop, so the per-update reset costs nothing on the common path.
 */
function clearMiss(misses: ReadonlyMap<AgentId, number>, agentId: AgentId): ReadonlyMap<AgentId, number> {
  if (!misses.has(agentId)) return misses;
  const next = new Map(misses);
  next.delete(agentId);
  return next;
}

function withSession(
  state: ConsoleState,
  agentId: AgentId,
  change: (session: SessionState) => SessionState,
): ConsoleState {
  const before = state.sessions.get(agentId) ?? EMPTY_SESSION;
  const after = change(before);
  if (after === before) return state;
  const sessions = new Map(state.sessions);
  sessions.set(agentId, after);
  return { ...state, sessions };
}

/**
 * Terminal turn progress, folded as hints about one row. A `turn_start`
 * retires the sent echo and proves the bridge owner is back, so it clears an
 * owner refusal but never a scope refusal. A turn this phone started remains
 * awaiting until its end. If no readable assistant text arrived by then, the
 * screen names the missing readback instead of looking stalled.
 */
function applyTuiActivity(state: ConsoleState, event: TuiActivityEvent): ConsoleState {
  return withTuiSession(state, event.sessionId, tui => {
    switch (event.kind) {
      case "turn_start":
        // Activity proves an owner is back, but it says nothing about this
        // device's scope. Only an owner refusal may recover from activity.
        if (tui.refusalKind === "scope") return { ...tui, sent: null, busy: true };
        return {
          ...tui,
          sent: null,
          busy: true,
          refusal: null,
          refusalKind: null,
        };
      case "assistant_text":
        return event.text === undefined
          ? tui
          : {
              ...tui,
              reply: event.text,
              replyUnavailable: false,
            };
      case "turn_end":
        return {
          ...tui,
          busy: false,
          awaitingReply: false,
          replyUnavailable: tui.awaitingReply && tui.reply === null,
        };
    }
  });
}

function withTuiSession(
  state: ConsoleState,
  sessionId: string,
  change: (tui: TuiSessionState) => TuiSessionState,
): ConsoleState {
  const before = state.tuiSessions.get(sessionId) ?? EMPTY_TUI_SESSION;
  const after = change(before);
  if (after === before) return state;
  const tuiSessions = new Map(state.tuiSessions);
  tuiSessions.set(sessionId, after);
  return { ...state, tuiSessions };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function sessionFor(state: ConsoleState, agentId: AgentId): SessionState {
  return state.sessions.get(agentId) ?? EMPTY_SESSION;
}

/**
 * The agent a screen should render for an id: the roster's entry when it has
 * one, and otherwise a stand-in for an agent the daemon has vouched for but
 * the roster has not listed yet.
 *
 * That gap is the dormant open. The daemon answers a resume with
 * `session_opened` and streams the replay, but its roster pushes only reach
 * sockets that already held an attachment, so the first socket to open a
 * session learns the new agent only from the next unrelated roster change or
 * a reconnect. Rendering nothing until then reads as a tap that did nothing;
 * rendering the stand-in reads as the session, which is what the updates
 * arriving into `sessions` already prove it is. The stand-in is built only
 * from what the session itself reported (title, cwd, updatedAt) plus an
 * honest idle state, never an invented name, and the first roster frame that
 * lists the agent replaces it whole.
 */
export function agentFor(state: ConsoleState, agentId: AgentId): Agent | null {
  const roster = state.agents.find(agent => agent.id === agentId);
  if (roster !== undefined) return roster;
  const session = state.sessions.get(agentId);
  if (session === undefined) return null;
  const gone = (state.rosterMisses.get(agentId) ?? 0) >= 2;
  return {
    id: agentId,
    name: session.info.title ?? "Session",
    // One missing roster may race a resume replay. Two means the host is gone:
    // keep the transcript selected, but do not offer controls that send to it.
    state: gone ? "stopped" : "idle",
    // Inert: nothing renders host data on a session screen, and the roster
    // entry replaces this whole object on arrival.
    host: { kind: "local", id: "0", spec: { kind: "local" } },
    cwd: session.info.cwd ?? "",
    createdAt: "",
    lastActiveAt: session.info.updatedAt ?? "",
    labels: {},
  };
}

/**
 * Whether this device may invite another one. The daemon's hello is the
 * authority once it has answered; the stored pairing's scopes stand in only
 * until then, optimistic when the pairing declared none (a one-tap link
 * printed before it carried scopes), so the menu is right on first paint and
 * correct afterwards. A narrowed grant takes the entry point away, which is
 * the point: the daemon would refuse the mint anyway.
 */
export function canInvite(state: ConsoleState, storedScopes: readonly string[]): boolean {
  if (state.grantedScopes !== undefined) return state.grantedScopes.includes(SCOPE_APPROVE);
  return storedScopes.length === 0 || storedScopes.includes(SCOPE_APPROVE);
}

/**
 * Whether this device may steer a live terminal. The daemon's hello wins,
 * then the stored pairing hint. An empty stored grant means old or unknown,
 * not missing, so the terminal may still answer and name a real refusal.
 */
export function tuiPromptAccess(state: ConsoleState, storedScopes: readonly string[]): TuiPromptAccess {
  const scopes = state.grantedScopes;
  if (scopes !== undefined) return scopes.includes(SCOPE_PROMPT) ? "granted" : "missing";
  if (storedScopes.length === 0) return "unknown";
  return storedScopes.includes(SCOPE_PROMPT) ? "granted" : "missing";
}

/** Hints about one terminal session. A row never prompted is not missing, it is blank. */
export function tuiSessionFor(state: ConsoleState, sessionId: string): TuiSessionState {
  return state.tuiSessions.get(sessionId) ?? EMPTY_TUI_SESSION;
}

/** What a strip shows. Derived rather than stored, so it cannot go stale. */
export function stripStats(session: SessionState): StripStats {
  const usage = session.usage;
  return {
    contextFraction: usage === null || usage.size === 0 ? null : usage.used / usage.size,
    costAmount: usage === null ? null : usage.costAmount,
    costCurrency: usage?.costCurrency ?? "USD",
    tools: session.activity.tools,
    running: session.activity.running,
    clearances: session.pendingApprovals.length,
  };
}

export function allStats(state: ConsoleState): Map<AgentId, StripStats> {
  const stats = new Map<AgentId, StripStats>();
  for (const [agentId, session] of state.sessions) stats.set(agentId, stripStats(session));
  return stats;
}

/**
 * Clearances across the whole fleet, not just the open strip. The readout is
 * the only place an operator sees that a strip they are not looking at has
 * stopped and is waiting on them.
 */
export function fleetClearances(state: ConsoleState): number {
  let total = 0;
  for (const session of state.sessions.values()) total += session.pendingApprovals.length;
  return total;
}

/**
 * The two slices a fleet row is made of.
 *
 * Narrower than `ConsoleState` on purpose, and the narrowing is the whole
 * point: a row must never be a function of the transcript slice. `sessions`
 * changes identity on every chunk of every live turn, so a rows derivation
 * that reads it has to be re-run per chunk, which rebuilds every row on the
 * machine -- hundreds of them -- to answer a question none of them asked.
 * That cost lands on the thread the pop animation needs, and it is what made
 * leaving a live session take seconds. Keeping it out of the type is what
 * stops it growing back.
 */
export type FleetRowSources = Pick<ConsoleState, "sessionIndex" | "agents">;

/**
 * Adapts the daemon's session index into browser rows, with this device's
 * live roster overlaid.
 *
 * The index is the base because it is the only source that knows every
 * session on the machine; the roster only knows the ones this daemon
 * currently holds. A live agent that holds an indexed session is overlaid
 * onto its row, since the roster is fresher than the last snapshot; every
 * other row keeps exactly the status the daemon reported.
 */
export function browserSessionsOf(state: FleetRowSources): BrowserSession[] {
  const holding = new Map<string, Agent>();
  for (const agent of state.agents) {
    if (agent.acpSessionId === undefined) continue;
    // A stopped or failed agent is passed over the same way the daemon's own
    // index passes it over when naming a holder: the process is gone, and
    // the session file on disk is `dormant`.
    if (TERMINAL_AGENT_STATES.includes(agent.state)) continue;
    holding.set(agent.acpSessionId, agent);
  }

  const rows: BrowserSession[] = [];
  const indexed = new Set<string>();
  for (const summary of state.sessionIndex) {
    indexed.add(summary.id);
    const agent = holding.get(summary.id);
    rows.push({
      id: summary.id,
      title: agent?.name ?? summary.title,
      // `flattenedDir` is always present for exactly this case: a group the
      // codec could not decode still needs something to display and group by.
      cwd: summary.cwd ?? summary.flattenedDir,
      status: agent !== undefined ? "live-ompd" : summary.status,
      createdAt: summary.createdAt,
      lastActiveAt: agent?.lastActiveAt ?? summary.lastActivityAt,
      // Null means one file exceeded the index's counting ceiling. The row
      // shape has no unknown slot, and inventing a fifth status would lie
      // harder than a zero.
      messageCount: summary.messageCount ?? 0,
      sizeBytes: summary.byteSize,
    });
  }

  // An agent created since the last ask holds a session the snapshot cannot
  // know about yet, and a fleet browser that hides the agent someone just
  // made is a regression on what the roster alone already listed. Those rows
  // are synthesized from the roster until the next index replaces them;
  // subagents stay in Agent Hub, where their hierarchy is legible.
  // A row's id is a session identity, so it may appear once. Two roster agents
  // can name the same acpSessionId before the index has seen it: a resumed
  // session whose previous holder is still listed. Emitting both produced two
  // children with one key, and React's warning banner then covered the
  // composer on a real screen. A live holder wins over a terminal one, since
  // the live process is the truth about what holds the session now.
  const synthesized = new Map<string, BrowserSession>();
  for (const agent of state.agents) {
    if (agent.parentAgentId !== undefined) continue;
    if (agent.acpSessionId !== undefined && indexed.has(agent.acpSessionId)) continue;
    const id = agent.acpSessionId ?? agent.id;
    const terminal = TERMINAL_AGENT_STATES.includes(agent.state);
    const held = synthesized.get(id);
    if (held !== undefined && (terminal || held.status === "live-ompd")) continue;
    synthesized.set(id, {
      id,
      title: agent.name,
      cwd: agent.cwd,
      status: terminal ? "dormant" : "live-ompd",
      createdAt: agent.createdAt,
      lastActiveAt: agent.lastActiveAt,
      // Counting the transcript this device happens to hold would be the
      // wrong number anyway: it counts entries received here, so it reads
      // zero for any session this device never opened and never matches the
      // daemon's own count for one it did. The index is what counts messages,
      // and it has not seen this session yet, so this says so the same way
      // `sizeBytes` below does.
      messageCount: 0,
      // Not knowable before the index sees the session file.
      sizeBytes: 0,
    });
  }
  rows.push(...synthesized.values());
  return rows;
}

/**
 * What opening one browser row has to hit.
 *
 * Rows are sessions, not agents, so a tap has to be resolved to whichever
 * holder can serve it: a live agent from this device's roster, the agent the
 * index still names, the live-TUI prompt surface, or, for a session on disk
 * that nothing holds, a resume claim. The resume claim carries the index
 * row's own `cwd` because the daemon verifies that echo against a row it
 * rebuilds itself, so the value must be the one the operator tapped, never
 * invented. A live-TUI open verifies nothing and echoes nothing: prompting
 * routes by session id alone, so the target is the id and nothing else. A row
 * the index does not describe, or a dormant row whose directory it could not
 * decode, has no claim this device can echo, so it resolves to the one shape
 * that says so instead of a frame the daemon must refuse.
 */
export type SessionOpenTarget =
  | { readonly kind: "agent"; readonly sessionId: string; readonly agentId: AgentId }
  | { readonly kind: "live-tui"; readonly sessionId: string }
  | { readonly kind: "dormant"; readonly sessionId: string; readonly cwd: string }
  | { readonly kind: "unopenable"; readonly sessionId: string };

export function openSessionTarget(state: ConsoleState, rowId: string): SessionOpenTarget {
  const summary = state.sessionIndex.find(row => row.id === rowId);
  // The roster is fresher than the index for a live holder. A terminal holder
  // is different: Fleet labels its row Resume, so attaching to the dead agent
  // id would open history but leave interaction impossible. Agent Hub opens
  // that durable history explicitly; Fleet wakes the same ACP session.
  const holder = state.agents.find(agent => agent.acpSessionId === rowId || agent.id === rowId);
  if (holder !== undefined) {
    if (TERMINAL_AGENT_STATES.includes(holder.state)) {
      // The index owns the canonical cwd the daemon verifies. Agent rows may
      // hold a filesystem alias (`/tmp`) for the same directory the scanner
      // reports as `/private/tmp`; echoing the agent's copy is a guaranteed
      // cwd_mismatch.
      if (holder.acpSessionId === undefined || summary?.cwd == null) {
        return { kind: "unopenable", sessionId: rowId };
      }
      return { kind: "dormant", sessionId: holder.acpSessionId, cwd: summary.cwd };
    }
    return { kind: "agent", sessionId: rowId, agentId: holder.id };
  }

  // A stale row: a newer index dropped it, and the roster never held it.
  if (summary === undefined) {
    return { kind: "unopenable", sessionId: rowId };
  }
  // The roster has not admitted this agent yet, but the daemon's index named
  // it as holding the session, so the id it named is the one to attach to.
  if (summary.status === "live-ompd" && summary.agentId !== undefined) {
    return { kind: "agent", sessionId: rowId, agentId: summary.agentId };
  }
  // A live terminal session is prompted, never taken over: the terminal
  // cannot hand its renderer to this device, so the open is a local prompt
  // surface and the daemon's answer to whatever is sent from it is the only
  // claim that ever crosses the wire. Nothing is echoed, so an undecodable
  // directory or a missing pid costs nothing here; the screen falls back to
  // the flattened name the index always carries.
  if (summary.status === "live-tui") {
    return { kind: "live-tui", sessionId: rowId };
  }
  // The daemon verifies the echoed `cwd` against an index row it rebuilds
  // itself, so a claim can only carry what this row actually reported. A
  // directory the codec could not decode leaves nothing to echo and no claim
  // to make.
  if (summary.cwd === null) {
    return { kind: "unopenable", sessionId: rowId };
  }
  // Dormant and archived rows ride the same resume claim; the daemon's own
  // verifier, not this resolver, is where an archived row is refused.
  return { kind: "dormant", sessionId: rowId, cwd: summary.cwd };
}
