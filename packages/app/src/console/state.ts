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
  SessionDeleteResult,
  SessionSummary,
  TranscriptTailMessage,
  WebViewAction,
} from "@ompd/core/contracts";
import {
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  SESSION_DELETE_REFUSAL_REASONS,
  TERMINAL_AGENT_STATES,
} from "@ompd/core/contracts";
import type {
  AgentsEvent,
  ApprovalEvent,
  ClientErrorEvent,
  CollabOpenedEvent,
  ConnectionState,
  PlanReviewEvent,
  SayEvent,
  SessionHistoryEvent,
  SessionTailEvent,
  StatusEvent,
  TranscriptEvent,
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
  echoText,
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

/**
 * Whether the detail pane has what it opened for.
 *
 * - `loading`: a request that will certainly be answered is outstanding. Only
 *   a selection that actually sent one arms this.
 * - `ready`: the pane has the session's own data, whether that turns out to
 *   be a transcript or an honestly empty one. This is also the default for a
 *   subject nothing was ever asked about.
 * - `failed`: the open was refused or could not be served. The pane says so,
 *   in the daemon's words, under the subject that was refused.
 * - `stalled`: the link went down while the answer was outstanding, so the
 *   answer is never coming on that socket.
 *
 * `stalled` is not a flavour of `failed`, and collapsing the two was the
 * temptation worth resisting. A refusal is a verdict the operator has to act
 * on and it survives a reconnect; a dropped link is a condition that resolves
 * itself, and the same distinction already governs which notices `connected`
 * retires. Wearing "could not open" for a flap would teach an operator to
 * distrust a refusal that means it. And leaving such a load `loading` is the
 * perpetual spinner this whole contract exists to prevent: `loading` promises
 * an answer is on its way, and once the socket carrying it is gone that
 * promise is false.
 */
export type SessionLoadPhase = "loading" | "ready" | "failed" | "stalled";

/**
 * One subject's wait.
 *
 * What arms it: a fleet row press, a resume the daemon answered, or a join
 * the daemon answered, each of which sends a request whose answer always
 * comes back. What settles it: that subject's own authoritative data --
 * a `session_history` page, an `update`, a `session_tail` page, a terminal's
 * turn progress, or a refusal addressed to it. What stalls it: the link
 * dropping before any of those arrived.
 *
 * Never armed by a frame, only by a selection or by the reconnect that
 * re-asks for a stalled subject. A late answer for a subject the operator
 * already left can therefore settle that subject's wait but can never put it
 * back into one, and can never start one for anything else.
 */
export interface SessionLoad {
  readonly phase: SessionLoadPhase;
  /** The `ConsoleState.selection` that armed this wait. */
  readonly generation: number;
  /** The refusal's own words. Present only when `phase` is `failed`. */
  readonly error: string | null;
}

/**
 * What a subject nobody has asked about reports. Shared by reference so a
 * screen comparing loads across renders sees no change where none happened.
 */
export const READY_LOAD: SessionLoad = { phase: "ready", generation: 0, error: null };
export const MAX_RETAINED_SESSIONS = 8;

export interface ConsoleState {
  readonly agents: readonly Agent[];
  readonly sessions: ReadonlyMap<AgentId, SessionState>;
  readonly sessionRecency: readonly AgentId[];
  /** The durable ACP session identity last confirmed for each attached agent. */
  readonly sessionIds: ReadonlyMap<AgentId, string>;
  /** The newest failed open that named a durable session, if any. */
  readonly lastFailedSessionOpen: { readonly sessionId: string; readonly revision: number } | null;
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
  /**
   * The daemon's live decoding of what this device is saying, per agent, as
   * the `transcript` frames report it. Held beside the transcript proper
   * because the two answer different questions: dictation is the
   * composer's feedback about an utterance in flight, not part of the
   * session's history. Replaced, never merged, because each frame is the
   * daemon's newest word on one utterance.
   */
  readonly dictation: ReadonlyMap<AgentId, { readonly text: string; readonly final: boolean }>;
  /**
   * The agent whose microphone this device holds open, or null. One device
   * carries one utterance at a time on the wire, so this is a single id
   * rather than a set, and the composer's mic is a toggle rather than a
   * per-session switch.
   */
  readonly capturing: AgentId | null;
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
  /**
   * The live terminal sessions this device co-drives, keyed by the agent the
   * daemon presented for each join.
   *
   * A joined terminal is an ordinary agent in every other slice: selected
   * through `selected`, streamed through `sessions`, listed by the roster.
   * This map holds what those cannot say: which session the agent co-drives,
   * and whether the daemon's link to it is view-only. It stays empty on a
   * machine whose omp cannot host a room, which is why the hints above are
   * still the fallback rather than dead weight.
   */
  readonly collabAgents: ReadonlyMap<AgentId, CollabJoin>;
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
  /**
   * How many times the detail pane's subject has changed, counting from zero.
   *
   * A load records the generation that armed it, which is what makes a
   * superseded wait identifiable rather than merely unlucky: a test, and the
   * reducer's own guards, can say "this load belongs to a selection the
   * operator has already left" instead of inferring it from timing. It is
   * never a substitute for the identity key below -- that is what actually
   * keeps one session's frames out of another's pane.
   */
  readonly selection: number;
  /**
   * What the detail pane is waiting for, keyed by the subject it is waiting
   * on: an agent id for a session log, a session id for a terminal surface.
   *
   * Keyed by subject and never by "the current pane" precisely because the
   * frames that settle it cross a relay with no ordering guarantee. An answer
   * for a session the operator has already left settles that session's load
   * and touches nothing else, so it can neither render under the session now
   * open nor clear the wait that session is still in.
   *
   * A subject with no entry has nothing outstanding, which is why the default
   * is `ready` rather than `loading`: a pane must never wait on a request
   * nobody made. `SessionLoad`'s own doc names what arms and settles one.
   */
  readonly loads: ReadonlyMap<string, SessionLoad>;
}

/**
 * What this device knows about its right to use one scope.
 *
 * `unknown` preserves compatibility with a pairing or daemon that never
 * reported scopes. Only `missing` is a refusal, because absence of evidence
 * from an older peer must not silently remove a control that may still work.
 * No fourth value: a control either acts, acts optimistically, or says why
 * it cannot, and a screen that had a fourth case to render would be guessing.
 */
export type ScopeAccess = "granted" | "unknown" | "missing";

/**
 * The prompt scope's posture, which is what speaking to an agent and steering
 * a terminal both spend. An alias rather than its own union so every
 * scope-gated control in the app answers to one rule.
 */
export type PromptScopeAccess = ScopeAccess;

/**
 * The same rule, under the name the terminal screen has always imported.
 * Kept as an alias rather than inlined so the terminal's props stay stable
 * while the microphone and any later prompt-gated control share one rule.
 */
export type TuiPromptAccess = ScopeAccess;

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
   * The transcript this device holds for the session, oldest first.
   *
   * A cursorless `session_tail` frame replaces it wholesale rather than
   * merging: the daemon reads the file's end every time it is asked, so the
   * newest answer is the truth and a merge would only invent an ordering
   * neither side agreed on. A paged frame prepends, because the daemon read
   * strictly older bytes than everything already held.
   */
  readonly history: readonly TranscriptTailMessage[];
  /**
   * The byte offset the next older page starts from, or null when there is
   * no older page to ask for: the file's start is reached, or nothing has
   * been served yet. What the load-earlier control is offered on.
   */
  readonly historyCursor: number | null;
  /** True while an older page is in flight, so the control cannot be tapped twice. */
  readonly historyLoadingEarlier: boolean;
}

/**
 * One live terminal session this device co-drives, keyed by the agent the
 * daemon presented for the join.
 *
 * Only the join lives here, never the transcript: a joined session streams
 * through the same update and history frames an owned agent uses, so the
 * co-driven screen is the ordinary session screen rather than a second
 * transcript shape. The hints above stay the surface for a terminal whose
 * omp cannot host a room at all.
 */
export interface CollabJoin {
  /** The session on the machine this agent co-drives. */
  readonly sessionId: string;
  /**
   * True when the daemon holds a view-only link to the terminal. A steer
   * would be refused, so the session screen names that instead of offering
   * a composer whose prompts cannot land.
   */
  readonly readOnly: boolean;
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
  historyCursor: null,
  historyLoadingEarlier: false,
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
    sessionRecency: [],
    sessionIds: new Map(),
    lastFailedSessionOpen: null,
    sessionIndex: [],
    watermarks: new Map(),
    rosterMisses: new Map(),
    dictation: new Map(),
    capturing: null,
    historyBefore: new Map(),
    historyLoading: new Set(),
    spoken: new Map(),
    connection: "connecting",
    attempt: 0,
    delayMs: undefined,
    selected: null,
    selectedTui: null,
    tuiSessions: new Map(),
    collabAgents: new Map(),
    pendingWebViewActions: new Map(),
    // A pairing that did not declare its scopes stays optimistic; the daemon's
    // first refusal is what downgrades it.
    canApprove: scopes.length === 0 || scopes.includes(SCOPE_APPROVE),
    grantedScopes: undefined,
    refusal: undefined,
    notice: null,
    noticeAboutLink: false,
    unauthorized: null,
    selection: 0,
    loads: new Map(),
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
  /** Daemon: its decoding of what this device said into an open microphone. */
  | { t: "transcript"; event: TranscriptEvent }
  /** Local: this device opened the microphone for one agent, or closed it. */
  | { t: "voice_capture"; agentId: AgentId | null }
  | { t: "unauthorized"; event: UnauthorizedEvent }
  /** Daemon: turn progress from a live terminal session this device can prompt. */
  | { t: "tui_activity"; event: TuiActivityEvent }
  /** Daemon: one page of a terminal session's transcript, answering this device's ask. */
  | { t: "session_tail"; event: SessionTailEvent }
  | { t: "session_history"; event: SessionHistoryEvent }
  | { t: "history_request"; agentId: AgentId }
  /** Local: this device just asked a terminal session for an older page. */
  | { t: "tui_history_request"; sessionId: string }
  /**
   * Local: the operator opened a terminal session's prompt surface, or went
   * back to the bay. `awaiting` carries the same meaning it does on `select`.
   */
  | { t: "tui_select"; sessionId: string | null; awaiting?: boolean }
  /** Local: echo of a prompt this device just sent to a terminal session. */
  | { t: "tui_prompt"; sessionId: string; text: string; imageCount?: number }
  /**
   * Daemon: a live terminal session this device asked to co-drive is now
   * presented as the named agent. The ordinary session screen renders it,
   * and everything after arrives as the frames any agent produces.
   */
  | { t: "collab_opened"; event: CollabOpenedEvent; awaiting?: boolean }
  /**
   * Local: the operator opened a session log, or went back to the bay.
   *
   * `awaiting` is the caller's own report of whether it sent a request that
   * will be answered. It is not a guess the reducer could make: only the
   * action layer knows whether this open asked the daemon for anything, and
   * arming a wait for an answer nobody asked for is precisely the perpetual
   * spinner this contract exists to make impossible.
   */
  | { t: "select"; agentId: AgentId | null; awaiting?: boolean }
  /** Local: echo of a prompt this device just sent. */
  | { t: "prompt"; agentId: AgentId; text: string; imageCount?: number }
  /** Local: a clearance this device just settled. */
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice }
  | { t: "plan_decide"; agentId: AgentId; requestId: string; choice: PlanReviewChoice }
  /** Daemon: an already-authorized action for this agent's registered WebView. */
  | { t: "webview_action"; agentId: AgentId; requestId: string; action: WebViewAction }
  /** Local: exactly this action was answered, or its screen went away. */
  | { t: "webview_result"; agentId: AgentId; requestId: string }
  /**
   * Local or daemon: the open of exactly this subject was refused, or could
   * not be served. Addressed, never ambient: a refusal that cannot name its
   * subject is a notice, because the alternative is failing whichever pane
   * happens to be open when it lands.
   */
  | { t: "open_failed"; subject: string; message: string }
  /**
   * Local: the reconnect has re-sent the ask for a subject whose link dropped
   * mid-open. Dispatched only after the frame is actually on the wire, so a
   * wait is never re-armed for a request nobody re-sent.
   */
  | { t: "load_rearm"; subject: string }
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
        // A wait is a promise that an answer is on its way, and the socket
        // carrying it has gone. Every outstanding one stalls here rather than
        // spinning until the app is restarted; the reconnect below is what
        // asks again. Done for every subject, not only the open one, because
        // a load left `loading` behind a pane the operator returns to would
        // be a spinner with nothing behind it.
        loads: event.event.state === "connected" ? state.loads : stallLoads(state.loads),
        // The history guard in the action layer skips a re-ask while it
        // believes one is in flight. After a drop nothing is in flight, so
        // holding the flag is what would silently swallow the reconnect's
        // re-ask.
        historyLoading: event.event.state === "connected" ? state.historyLoading : new Set<AgentId>(),
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
      // An update for an agent the roster says is not busy is HISTORY, not a
      // live stream. The daemon replays a settled transcript as ordinary
      // update frames, and a settled session then sends no further roster
      // push, so settling on the next `agents` frame is settling on a frame
      // that never comes. Measured on an iPhone 17 simulator against a real
      // daemon: the agent reported `idle` and the app drew a "Working" row and
      // offered the interrupt for as long as the session stayed open.
      //
      // `endTurn` is identity-stable when nothing is streaming, so this costs
      // one check per frame on the live path, where the roster IS busy and the
      // caret must stay.
      const live = state.agents.find(candidate => candidate.id === agentId);
      const applied = withSession(state, agentId, session => reduce(session, update));
      const isChunk =
        typeof update === "object" &&
        update !== null &&
        (Reflect.get(update, "sessionUpdate") === "agent_message_chunk" ||
          Reflect.get(update, "sessionUpdate") === "agent_thought_chunk");
      const next =
        !isChunk && live !== undefined && live.state !== "busy"
          ? withSession(applied, agentId, session => endTurn(session))
          : applied;
      return { ...settleLoad(next, agentId), watermarks, rosterMisses };
    }
    case "approval": {
      const { agentId, requestId, tool, title, input } = event.event;
      const next = settleLoad(
        withSession(state, agentId, session => appendApproval(session, { requestId, tool, title, input })),
        agentId,
      );
      if (agentId === state.selected) return next;
      const name = state.agents.find(agent => agent.id === agentId)?.name ?? "An agent";
      return { ...next, notice: `${name} needs a clearance.`, noticeAboutLink: false };
    }

    case "plan_review": {
      const { agentId, requestId, message, choices } = event.event;
      const next = settleLoad(
        withSession(state, agentId, session => setPlanReview(session, { requestId, message, choices })),
        agentId,
      );
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
      // A refused co-drive has no screen of its own to land on: the tap came
      // from a fleet row, and a join that never happened has no agent. So it
      // is a notice, worded from the daemon's own reason.
      const collabNotice = collabOpenNotice(event.event);
      if (collabNotice !== null) {
        return { ...state, notice: collabNotice, noticeAboutLink: false };
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
      const aboutLink = code !== undefined && LINK_CODES[code] === true;
      const sessionId = event.event.sessionId;
      const lastFailedSessionOpen =
        sessionId === undefined
          ? state.lastFailedSessionOpen
          : {
              sessionId,
              revision: (state.lastFailedSessionOpen?.revision ?? 0) + 1,
            };
      return { ...state, notice: message, noticeAboutLink: aboutLink, lastFailedSessionOpen };
    }

    case "say":
      return applySay(state, event.event);

    case "transcript": {
      // Each frame is the daemon's newest word on one utterance, so the
      // entry is replaced rather than appended; the composer renders it as
      // live dictation, and a `final` frame is what lets it stop moving.
      const { agentId, text, final } = event.event;
      const dictation = new Map(state.dictation);
      dictation.set(agentId, { text, final });
      return { ...state, dictation };
    }

    case "voice_capture": {
      if (event.agentId === null) {
        if (state.capturing === null) return state;
        // Closing the mic keeps the last dictation on screen: it is the
        // record of what was said, and the next open is what retires it.
        return { ...state, capturing: null };
      }
      const dictation = new Map(state.dictation);
      // A new utterance makes the previous one's words stale feedback, and
      // keeping them would read as the daemon transcribing the wrong audio.
      dictation.delete(event.agentId);
      return { ...state, capturing: event.agentId, dictation };
    }

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
      const sessionRecency = [event.agentId, ...(state.sessionRecency ?? []).filter(id => id !== event.agentId)];
      // A re-select of the pane's own subject changes nothing, including its
      // wait: a double tap must not restart a load that is already settled,
      // or the log an operator is reading flickers back to a spinner.
      if (state.selected === event.agentId && state.selectedTui === null) {
        return { ...(rosterMisses === state.rosterMisses ? state : { ...state, rosterMisses }), sessionRecency };
      }
      const nextState = {
        ...armLoad(state, event.agentId, event.awaiting === true),
        selected: event.agentId,
        selectedTui: null,
        rosterMisses,
        sessionRecency,
      };
      const pruned = pruneSessions(
        new Map(nextState.sessions),
        sessionRecency,
        event.agentId,
        nextState.watermarks,
        nextState.historyBefore,
      );
      return {
        ...nextState,
        sessions: pruned.sessions,
        sessionRecency: pruned.sessionRecency,
        watermarks: pruned.watermarks,
        historyBefore: pruned.historyBefore,
      };
    }

    case "tui_select": {
      if (event.sessionId === null) {
        return state.selectedTui === null ? state : { ...state, selectedTui: null };
      }
      // The collab fallback re-selects the terminal it already committed to,
      // so the idempotent case keeps the wait the row press armed rather than
      // arming a second one.
      if (state.selectedTui === event.sessionId && state.selected === null) return state;
      return {
        ...armLoad(state, event.sessionId, event.awaiting === true),
        selectedTui: event.sessionId,
        selected: null,
      };
    }

    case "collab_opened": {
      const { sessionId, agentId, readOnly } = event.event;
      // The daemon's answer is newer than any roster snapshot in flight over
      // the relay, so it retires a pending absence streak for the agent it
      // names, exactly as a `session_opened`-driven select does.
      const rosterMisses = clearMiss(state.rosterMisses, agentId);
      // A second open of a session the daemon already co-drives answers with
      // the agent it already holds, so the frame folds to no change and no
      // re-render. That is what makes a double tap on a row free.
      const existing = state.collabAgents.get(agentId);
      if (state.selected === agentId && existing?.sessionId === sessionId && existing.readOnly === readOnly) {
        return rosterMisses === state.rosterMisses ? state : { ...state, rosterMisses };
      }
      const collabAgents = new Map(state.collabAgents);
      collabAgents.set(agentId, { sessionId, readOnly });
      // This answer is what the row press was waiting for, so the terminal
      // subject's wait is over -- and the agent it names inherits one,
      // because the join's own transcript is what has not arrived yet.
      // Settling the first before arming the second keeps the pane in exactly
      // one wait rather than briefly in none.
      const settled = settleLoad(state, sessionId);
      return {
        ...armLoad(settled, agentId, event.awaiting === true),
        selected: agentId,
        selectedTui: null,
        collabAgents,
        rosterMisses,
      };
    }

    case "tui_prompt":
      return withTuiSession(state, event.sessionId, tui => ({
        ...tui,
        sent: echoText(event.text, event.imageCount ?? 0),
        awaitingReply: true,
        reply: null,
        replyUnavailable: false,
        refusal: null,
        refusalKind: null,
      }));

    case "tui_activity":
      // A terminal reporting its own turn progress is that session's data
      // arriving, so it settles the wait a row press armed even when the
      // tail page has not landed yet.
      return settleLoad(applyTuiActivity(state, event.event), event.event.sessionId);

    case "session_tail":
      return settleLoad(applySessionTail(state, event.event), event.event.sessionId);

    case "tui_history_request":
      return withTuiSession(state, event.sessionId, tui =>
        tui.historyLoadingEarlier ? tui : { ...tui, historyLoadingEarlier: true },
      );

    case "history_request": {
      const historyLoading = new Set(state.historyLoading);
      historyLoading.add(event.agentId);
      return { ...state, historyLoading };
    }

    case "session_history": {
      const { agentId, sessionId, entries, nextBefore } = event.event;
      const merged = withSession(state, agentId, session => mergeSessionHistory(session, entries));
      const live = state.agents.find(candidate => candidate.id === agentId);
      const next =
        live !== undefined && live.state !== "busy"
          ? withSession(merged, agentId, session => endTurn(session))
          : merged;
      const historyBefore = new Map(next.historyBefore);
      historyBefore.set(agentId, nextBefore);
      const historyLoading = new Set(next.historyLoading);
      historyLoading.delete(agentId);
      const sessionIds = new Map(next.sessionIds);
      sessionIds.set(agentId, sessionId);
      // The page the open asked for. It always comes back, empty or not,
      // which is what makes it the settle a session log can rely on: a
      // session with no transcript reaches its honest empty state here
      // rather than sitting under a spinner forever. The same frame is the
      // durable agent-to-session association a route-resumed session needs:
      // a roster snapshot may arrive later or never, and a stand-in agent
      // must still name the exact session the daemon just opened.
      return { ...settleLoad(next, agentId), historyBefore, historyLoading, sessionIds };
    }

    case "open_failed": {
      const held = state.loads.get(event.subject);
      // Only an unsettled wait can fail. A refusal for a subject that already
      // has its data, or that nobody is waiting on, is an ordinary notice's
      // business and must not blank a log that is on screen and correct.
      //
      // A stalled wait may fail: the refusal for a subject whose link dropped
      // arrives on the socket that replaced it, and it is the answer the pane
      // was waiting for either way.
      if (held === undefined || (held.phase !== "loading" && held.phase !== "stalled")) return state;
      const loads = new Map(state.loads);
      loads.set(event.subject, { phase: "failed", generation: held.generation, error: event.message });
      const historyLoading = new Set(state.historyLoading);
      historyLoading.delete(event.subject);
      return { ...state, loads, historyLoading };
    }
    case "load_rearm": {
      const held = state.loads.get(event.subject);
      if (held?.phase !== "stalled" && held?.phase !== "failed") return state;
      const selection = state.selection + 1;
      const loads = new Map(state.loads);
      loads.set(event.subject, { phase: "loading", generation: selection, error: null });
      const historyLoading = new Set(state.historyLoading);
      historyLoading.delete(event.subject);
      return { ...state, selection, loads, historyLoading };
    }

    case "prompt":
      return withSession(state, event.agentId, session => appendPrompt(session, event.text, event.imageCount ?? 0));

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
    //
    // Not gated on having WATCHED it stop. That gate was here, as
    // `before.get(agent.id)?.state === "busy"`, and it assumed this device saw
    // the busy state at least once. Attaching to an agent that is already idle
    // never produces that transition, and the daemon replays the transcript as
    // ordinary update frames -- so the last assistant chunk of a turn that
    // ended before we arrived stayed marked streaming for as long as the
    // session was open. Measured on an iPhone 17 simulator against a real
    // daemon: the agent reported `idle`, and the app drew a "Working" row and
    // offered the interrupt instead of send.
    //
    // `endTurn` returns the same object when nothing is streaming, so running
    // it on every non-busy agent every roster frame costs an identity check.
    if (agent.state !== "busy") {
      const session = sessions.get(agent.id);
      if (session !== undefined) sessions.set(agent.id, endTurn(session));
    }
  }

  const pendingWebViewActions = new Map(state.pendingWebViewActions);
  const rosterMisses = new Map(state.rosterMisses);
  const collabAgents = new Map(state.collabAgents);
  // A joined agent that never streamed an update holds no `sessions` entry,
  // so the absence rule walks the union: a join the roster drops must be
  // reaped by the same corroboration a streamed session gets.
  for (const agentId of new Set([...sessions.keys(), ...collabAgents.keys()])) {
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
    // A join is liveness too: the guest went terminal when it left the room,
    // so keeping the mapping would paint a view-only band over a transcript
    // nobody can steer either way.
    collabAgents.delete(agentId);
    const session = sessions.get(agentId);
    if (session !== undefined) sessions.set(agentId, endTurn(session));
  }

  return {
    ...state,
    agents: retainedAgents,
    sessions,
    pendingWebViewActions,
    rosterMisses,
    collabAgents,
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

/**
 * Commits a new detail subject and records what it is waiting for.
 *
 * The generation advances on every commit, whether or not anything is
 * outstanding, so it counts what the operator did rather than what the
 * network happened to do. `awaiting` false is not "no load": it is a load in
 * `ready`, recorded at this generation, which is how a settled subject stays
 * distinguishable from one nobody has opened.
 */
function armLoad(state: ConsoleState, subject: string, awaiting: boolean): ConsoleState {
  const selection = state.selection + 1;
  const loads = new Map(state.loads);
  loads.set(subject, { phase: awaiting ? "loading" : "ready", generation: selection, error: null });
  return { ...state, selection, loads };
}

/**
 * This subject's data arrived.
 *
 * Settles only a wait, and only this subject's. It never arms one and never
 * touches another subject's entry, which is the whole guard: a frame for a
 * session the operator has already left cannot clear the wait the session now
 * open is in, and cannot put the one it belongs to back into a wait either.
 *
 * A `failed` load stays failed. The refusal is the answer, and a later frame
 * for the same subject is not the daemon retracting it -- reopening the row
 * is what asks again.
 */
function settleLoad(state: ConsoleState, subject: string): ConsoleState {
  const held = state.loads.get(subject);
  // A stalled wait settles on real data too: the answer arriving on the socket
  // that replaced the dropped one is exactly what the pane was waiting for,
  // and refusing it here would leave a stall on screen over a live session.
  if (held === undefined || (held.phase !== "loading" && held.phase !== "stalled")) return state;
  const loads = new Map(state.loads);
  loads.set(subject, { phase: "ready", generation: held.generation, error: null });
  return { ...state, loads };
}

/**
 * Every outstanding wait, marked as having lost the socket its answer was
 * coming on.
 *
 * Allocates only when there is a wait to stall, so the common status frame
 * (a healthy `connected`, or a flap with nothing open) costs nothing and the
 * console skips the render.
 */
function stallLoads(loads: ReadonlyMap<string, SessionLoad>): ReadonlyMap<string, SessionLoad> {
  let next: Map<string, SessionLoad> | null = null;
  for (const [subject, load] of loads) {
    if (load.phase !== "loading") continue;
    next ??= new Map(loads);
    next.set(subject, { phase: "stalled", generation: load.generation, error: null });
  }
  return next ?? loads;
}

function pruneSessions(
  sessions: Map<AgentId, SessionState>,
  sessionRecency: readonly AgentId[],
  selected: AgentId | null,
  watermarks: ReadonlyMap<AgentId, number>,
  historyBefore: ReadonlyMap<AgentId, number | null>,
): {
  sessions: ReadonlyMap<AgentId, SessionState>;
  sessionRecency: readonly AgentId[];
  watermarks: ReadonlyMap<AgentId, number>;
  historyBefore: ReadonlyMap<AgentId, number | null>;
} {
  const residentRecency = sessionRecency.filter(id => sessions.has(id));
  if (sessions.size <= MAX_RETAINED_SESSIONS) {
    return { sessions, sessionRecency: residentRecency, watermarks, historyBefore };
  }
  const keep = new Set<AgentId>();
  if (selected !== null && sessions.has(selected)) keep.add(selected);
  for (const id of residentRecency) {
    if (keep.size >= MAX_RETAINED_SESSIONS) break;
    keep.add(id);
  }
  let nextWatermarks = watermarks;
  let nextHistoryBefore = historyBefore;
  for (const key of sessions.keys()) {
    if (!keep.has(key)) {
      sessions.delete(key);
      if (nextWatermarks.has(key)) {
        const next = new Map(nextWatermarks);
        next.delete(key);
        nextWatermarks = next;
      }
      if (nextHistoryBefore.has(key)) {
        const next = new Map(nextHistoryBefore);
        next.delete(key);
        nextHistoryBefore = next;
      }
    }
  }
  return {
    sessions,
    sessionRecency: residentRecency.filter(id => keep.has(id)),
    watermarks: nextWatermarks,
    historyBefore: nextHistoryBefore,
  };
}

function withSession(
  state: ConsoleState,
  agentId: AgentId,
  change: (session: SessionState) => SessionState,
): ConsoleState {
  const before = state.sessions.get(agentId) ?? EMPTY_SESSION;
  const after = change(before);
  if (after === before) return state;
  const rawSessions = new Map(state.sessions);
  rawSessions.set(agentId, after);
  const rawRecency = [agentId, ...(state.sessionRecency ?? []).filter(id => id !== agentId)];
  const pruned = pruneSessions(rawSessions, rawRecency, state.selected, state.watermarks, state.historyBefore);
  return {
    ...state,
    sessions: pruned.sessions,
    sessionRecency: pruned.sessionRecency,
    watermarks: pruned.watermarks,
    historyBefore: pruned.historyBefore,
  };
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

/**
 * One page of a terminal session's transcript, folded into what this device
 * holds for that session.
 *
 * The frame's echoed `cursor` decides which of two different things this is.
 * Absent means the daemon read the end of the file, which is what a fresh
 * open asks for, so it replaces the history wholesale. Present means an
 * older page, which prepends: the daemon read strictly older bytes than
 * anything already held, so there is nothing to merge and no ordering to
 * invent.
 *
 * A page whose cursor is not the one this session is holding answers an ask
 * some later open already replaced, and is dropped. Frames cross the hub
 * relay with no ordering guarantee against each other, so without this a
 * page in flight when the operator left and came back would prepend a
 * stranger's stretch of file onto a freshly served tail.
 */
function applySessionTail(state: ConsoleState, event: SessionTailEvent): ConsoleState {
  return withTuiSession(state, event.sessionId, tui => {
    if (event.cursor === undefined) {
      return {
        ...tui,
        history: event.messages,
        historyCursor: event.nextCursor,
        historyLoadingEarlier: false,
      };
    }
    if (tui.historyCursor !== event.cursor) return tui;
    return {
      ...tui,
      history: event.messages.length === 0 ? tui.history : [...event.messages, ...tui.history],
      historyCursor: event.nextCursor,
      historyLoadingEarlier: false,
    };
  });
}

/**
 * The offset to ask a terminal session for next, once a page has landed, or
 * null when the operator's tap is fully answered.
 *
 * A page can legitimately carry no turns while megabytes of file remain: a
 * long run of tool traffic says nothing, and the reader stops at its budget
 * inside one. The operator asked for earlier words, not earlier bytes, so an
 * empty page is not an answer and the view asks on from its cursor. Only a
 * page that produced turns, or one that reached the file's start, settles.
 *
 * The cursor must also have moved. A page that cannot advance -- one line
 * larger than the whole read budget is the only way -- would otherwise be
 * asked for forever.
 */
export function tuiPageToAskFor(event: SessionTailEvent): number | null {
  if (event.cursor === undefined) return null;
  if (event.messages.length > 0) return null;
  if (event.nextCursor === null || event.nextCursor >= event.cursor) return null;
  return event.nextCursor;
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
 * What the pane showing `subject` is waiting for.
 *
 * A screen asks only about its own subject, which is what makes cross-session
 * leakage impossible rather than merely unlikely: there is no call shape that
 * reads the pane's wait without naming whose wait it is. A subject nobody
 * asked about reports `ready`, because a pane must never wait on a request
 * nobody made.
 */
export function loadFor(state: ConsoleState, subject: string): SessionLoad {
  return state.loads.get(subject) ?? READY_LOAD;
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
  const load = state.loads.get(agentId);
  const loadSettled = load !== undefined && (load.phase === "ready" || load.phase === "failed");
  const rosterMisses = state.rosterMisses.get(agentId) ?? 0;

  // "That session closed." copy renders only when there is explicit gone evidence:
  // an explicit session_gone / session closed refusal, or a roster miss after the load settled.
  // Other load failures (e.g. deadline timeouts or transient read errors) keep the stand-in agent
  // so SessionLoadFailed can render with its Retry button.
  const isExplicitGone =
    load?.error === "session_gone" ||
    load?.error === "That session closed." ||
    (load?.error !== null && load?.error !== undefined && load.error.includes("unknown_session"));
  if (isExplicitGone && (session === undefined || session.entries.length === 0)) {
    return null;
  }
  if (rosterMisses >= 2 && loadSettled && (session === undefined || session.entries.length === 0)) {
    return null;
  }
  if (session === undefined && load === undefined) {
    return null;
  }

  const summary = state.sessionIndex.find(s => s.agentId === agentId || s.id === agentId);
  const gone = rosterMisses >= 2;
  return {
    id: agentId,
    name: session?.info.title ?? summary?.title ?? "Session",
    // One missing roster may race a resume replay. Two means the host is gone:
    // keep the transcript selected, but do not offer controls that send to it.
    state: gone ? "stopped" : "idle",
    // Inert: nothing renders host data on a session screen, and the roster
    // entry replaces this whole object on arrival.
    host: { kind: "local", id: "0", spec: { kind: "local" } },
    cwd: session?.info.cwd ?? summary?.cwd ?? "",
    createdAt: summary?.createdAt ?? "",
    lastActiveAt: session?.info.updatedAt ?? summary?.lastActivityAt ?? "",
    labels: {},
    acpSessionId: summary?.id,
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
 * The three-way rule every scope-gated control follows, over the two things
 * that actually decide it: what the daemon's hello reported (undefined until
 * a daemon that reports scopes has answered) and what the pairing stored.
 * Hello wins once it has answered, the stored claim stands in until then, and
 * an empty stored grant means old or unknown rather than missing.
 *
 * Exported in this shape because not every scope-gated surface is inside the
 * console reducer: `RoutinesScreen` owns its own socket and reads that
 * socket's own hello, so it has the two inputs without ever holding a
 * `ConsoleState`. One implementation for both, because two copies would
 * eventually disagree about what an older pairing means, and the screen that
 * disagreed would be the one whose controls silently went missing.
 */
export function scopeAccessOf(
  grantedScopes: readonly string[] | undefined,
  storedScopes: readonly string[],
  scope: string,
): ScopeAccess {
  if (grantedScopes !== undefined) return grantedScopes.includes(scope) ? "granted" : "missing";
  if (storedScopes.length === 0) return "unknown";
  return storedScopes.includes(scope) ? "granted" : "missing";
}

/** The prompt scope's posture: what speaking to an agent and steering a terminal spend. */
export function promptScopeAccess(state: ConsoleState, storedScopes: readonly string[]): PromptScopeAccess {
  return scopeAccessOf(state.grantedScopes, storedScopes, SCOPE_PROMPT);
}

/**
 * The manage scope's posture: what archiving already spends and what deleting
 * a session spends. `unknown` stays optimistic here as it does everywhere
 * else, and deliberately so even for something irreversible: the control is
 * two deliberate taps deep and the daemon enforces the scope regardless, so
 * an older pairing meets a refusal it can read rather than a control that
 * silently went missing.
 */
export function manageScopeAccess(state: ConsoleState, storedScopes: readonly string[]): ScopeAccess {
  return scopeAccessOf(state.grantedScopes, storedScopes, SCOPE_MANAGE);
}

/**
 * What to tell the operator about a delete the daemon has answered, or null
 * when there is nothing to say.
 *
 * Silence on success is deliberate: the rows disappear from the fleet, which
 * is the confirmation, and a toast repeating it would be noise on the one
 * action whose effect is impossible to miss. A refusal is the opposite case.
 * Nothing on screen changes when a delete is refused, so without this the
 * operator watches a session they asked to destroy stay exactly where it was
 * and has to guess whether the tap registered.
 *
 * Pure, and here rather than at the socket, so the wording is testable
 * without a client and the reasons stay the daemon's own.
 */
export function sessionDeleteNotice(results: readonly SessionDeleteResult[]): string | null {
  const refused = results.filter(result => !result.deleted);
  if (refused.length === 0) return null;
  const [first] = refused;
  if (first === undefined || first.deleted) return null;
  const reason = SESSION_DELETE_REFUSAL_REASONS[first.refusal];
  if (refused.length === 1) return `That session was not deleted: ${reason}.`;
  return `${refused.length} sessions were not deleted. The first: ${reason}.`;
}

/** The same rule for the terminal steering surface, under its historic name. */
export function tuiPromptAccess(state: ConsoleState, storedScopes: readonly string[]): TuiPromptAccess {
  return promptScopeAccess(state, storedScopes);
}

/** Hints about one terminal session. A row never prompted is not missing, it is blank. */
export function tuiSessionFor(state: ConsoleState, sessionId: string): TuiSessionState {
  return state.tuiSessions.get(sessionId) ?? EMPTY_TUI_SESSION;
}

/**
 * The band a view-only join's session screen carries in place of its
 * composer. Same vocabulary as the daemon's `view_only` refusal, so the band
 * a screen paints before a refused prompt and the notice after one read as
 * one rule rather than two.
 */
export const COLLAB_WATCH_ONLY =
  "Watching only. This terminal is shared view-only, so a steer from here would be refused.";

/**
 * The read scope's posture: what watching a session spends, owned or
 * co-driven. Joining a terminal as a viewer is the one open that spends it,
 * which is why it never needed its own gate before.
 */
export function readScopeAccess(state: ConsoleState, storedScopes: readonly string[]): ScopeAccess {
  return scopeAccessOf(state.grantedScopes, storedScopes, SCOPE_READ);
}

/**
 * What to tell the operator about a co-drive the daemon refused, or null when
 * the error is not one of those.
 *
 * `collab_unavailable` is deliberately absent: that is the answer an omp
 * without the hosting API gives, and the error handler in `useConsole` falls
 * the open back to the steer surface instead of refusing, so a toast on every
 * open would report a working screen as a failure. That fallback, and this
 * gap, die together when `pi.startCollab` ships. A real refusal is the
 * opposite case, and its message is the refusal record's own wording,
 * rendered verbatim after a prefix naming the act that failed.
 */
export function collabOpenNotice(event: ClientErrorEvent): string | null {
  if (event.code !== "collab_refused") return null;
  return `Co-driving was refused: ${event.message}`;
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
