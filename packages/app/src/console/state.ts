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
  WebViewAction,
} from "@ompd/core/contracts";
import { SCOPE_APPROVE, TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type {
  AgentsEvent,
  ApprovalEvent,
  ClientErrorEvent,
  ConnectionState,
  PlanReviewEvent,
  SayEvent,
  StatusEvent,
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
  /** Latest spoken summary per agent. Text only; this build has no voice. */
  readonly spoken: ReadonlyMap<AgentId, { seq: number; text: string }>;
  readonly connection: ConnectionState;
  readonly attempt: number;
  readonly delayMs: number | undefined;
  readonly selected: AgentId | null;
  /** At most one browser action per agent. Completion is correlated by request id. */
  readonly pendingWebViewActions: ReadonlyMap<AgentId, PendingWebViewAction>;
  readonly canApprove: boolean;
  /** Why approval is refused, once the daemon has actually refused it. */
  readonly refusal: string | undefined;
  /** Transient message for the operator. Cleared by `dismiss`. */
  readonly notice: string | null;
  /** Set once the daemon has confirmed the token is dead. Terminal. */
  readonly unauthorized: string | null;
}

export function emptyConsole(scopes: readonly string[]): ConsoleState {
  return {
    agents: [],
    sessions: new Map(),
    sessionIndex: [],
    watermarks: new Map(),
    spoken: new Map(),
    connection: "connecting",
    attempt: 0,
    delayMs: undefined,
    selected: null,
    pendingWebViewActions: new Map(),
    // A pairing that did not declare its scopes stays optimistic; the daemon's
    // first refusal is what downgrades it.
    canApprove: scopes.length === 0 || scopes.includes(SCOPE_APPROVE),
    refusal: undefined,
    notice: null,
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
  /** Local: the operator opened a strip, or went back to the bay. */
  | { t: "select"; agentId: AgentId | null }
  /** Local: echo of a prompt this device just sent. */
  | { t: "prompt"; agentId: AgentId; text: string }
  /** Local: a clearance this device just settled. */
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice }
  | { t: "plan_decide"; agentId: AgentId; requestId: string; choice: PlanReviewChoice }
  /**
   * Local: the daemon adopted a live TUI into this agent at this device's
   * request. Admitted by hand because the roster push that says the same
   * thing only reaches sockets already attached to something, and this
   * device's socket is attached to nothing until the adoption succeeds.
   */
  | { t: "agent_admitted"; agent: Agent }
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
    case "status":
      return {
        ...state,
        connection: event.event.state,
        attempt: event.event.attempt,
        delayMs: event.event.delayMs,
      };

    case "agents":
      return applyAgents(state, event.event.agents);

    case "sessions":
      return applySessions(state, event.event.sessions);

    case "agent_admitted":
      // A double tap can race the roster push carrying the same agent. The
      // roster stays the authority; this only admits what the daemon itself
      // just returned from the adoption.
      return state.agents.some(agent => agent.id === event.agent.id)
        ? state
        : applyAgents(state, [...state.agents, event.agent]);

    case "update": {
      const { agentId, seq, update } = event.event;
      const watermarks = new Map(state.watermarks);
      watermarks.set(agentId, seq);
      return { ...withSession(state, agentId, session => reduce(session, update)), watermarks };
    }

    case "approval": {
      const { agentId, requestId, tool, title, input } = event.event;
      const next = withSession(state, agentId, session => appendApproval(session, { requestId, tool, title, input }));
      if (agentId === state.selected) return next;
      const name = state.agents.find(agent => agent.id === agentId)?.name ?? "An agent";
      return { ...next, notice: `${name} needs a clearance.` };
    }

    case "plan_review": {
      const { agentId, requestId, message, choices } = event.event;
      const next = withSession(state, agentId, session => setPlanReview(session, { requestId, message, choices }));
      if (agentId === state.selected) return next;
      const name = state.agents.find(agent => agent.id === agentId)?.name ?? "An agent";
      return { ...next, notice: `${name} needs a plan review.` };
    }

    case "error": {
      const { code, message } = event.event;
      if (code !== undefined && SCOPE_CODES[code]) {
        return {
          ...state,
          canApprove: false,
          refusal: `${message}. Sign this from a device holding the approve scope.`,
          notice: message,
        };
      }
      return { ...state, notice: message };
    }

    case "say":
      return applySay(state, event.event);

    case "unauthorized":
      return { ...state, unauthorized: event.event.reason, connection: "offline" };

    case "select": {
      if (state.selected === event.agentId) return state;
      if (event.agentId === null) return { ...state, selected: null };
      return { ...state, selected: event.agentId };
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
      return state.notice === null ? state : { ...state, notice: null };

    default:
      return state;
  }
}

/**
 * The roster is the authority on which agents exist. An agent that has left it
 * is never coming back on that id, so its transcript goes with it: keeping one
 * would grow without bound across a long-running session and show a log for
 * something that no longer exists.
 */
function applyAgents(state: ConsoleState, agents: readonly Agent[]): ConsoleState {
  const before = new Map(state.agents.map(agent => [agent.id, agent]));
  const live = new Set(agents.map(agent => agent.id));

  const sessions = new Map(state.sessions);
  for (const agent of agents) {
    // A turn that has stopped leaves nothing streaming, whatever the last
    // chunk claimed. Without this an interrupted turn keeps its caret forever.
    if (agent.state !== "busy" && before.get(agent.id)?.state === "busy") {
      const session = sessions.get(agent.id);
      if (session !== undefined) sessions.set(agent.id, endTurn(session));
    }
  }

  const watermarks = new Map(state.watermarks);
  const spoken = new Map(state.spoken);
  const pendingWebViewActions = new Map(state.pendingWebViewActions);
  for (const agentId of [...sessions.keys()]) {
    if (live.has(agentId)) continue;
    sessions.delete(agentId);
    watermarks.delete(agentId);
    spoken.delete(agentId);
    pendingWebViewActions.delete(agentId);
  }

  const selected = state.selected !== null && live.has(state.selected) ? state.selected : null;
  const lost = state.selected !== null && selected === null;

  return {
    ...state,
    agents,
    sessions,
    watermarks,
    spoken,
    pendingWebViewActions,
    selected,
    notice: lost ? "That agent is gone." : state.notice,
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

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export function sessionFor(state: ConsoleState, agentId: AgentId): SessionState {
  return state.sessions.get(agentId) ?? EMPTY_SESSION;
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
 * Adapts the daemon's session index into browser rows, with this device's
 * live roster overlaid.
 *
 * The index is the base because it is the only source that knows every
 * session on the machine; the roster only knows the ones this daemon
 * currently holds. A live agent that holds an indexed session is overlaid
 * onto its row, since the roster is fresher than the last snapshot; every
 * other row keeps exactly the status the daemon reported.
 */
export function browserSessionsOf(state: ConsoleState): BrowserSession[] {
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
  for (const agent of state.agents) {
    if (agent.parentAgentId !== undefined) continue;
    if (agent.acpSessionId !== undefined && indexed.has(agent.acpSessionId)) continue;
    const session = state.sessions.get(agent.id) ?? EMPTY_SESSION;
    rows.push({
      id: agent.acpSessionId ?? agent.id,
      title: agent.name,
      cwd: agent.cwd,
      status: TERMINAL_AGENT_STATES.includes(agent.state) ? "dormant" : "live-ompd",
      createdAt: agent.createdAt,
      lastActiveAt: agent.lastActiveAt,
      messageCount: session.entries.length,
      // Not knowable before the index sees the session file.
      sizeBytes: 0,
    });
  }
  return rows;
}

/**
 * What opening one browser row has to hit.
 *
 * Rows are sessions, not agents, so a tap has to be resolved to whichever
 * holder can serve it: a live agent from this device's roster, the agent the
 * index still names, or, for a session a TUI process at the machine holds,
 * the daemon's live-TUI takeover.
 */
export interface SessionOpenTarget {
  readonly sessionId: string;
  /** The agent that already holds this session, when one is known. */
  readonly agentId: AgentId | undefined;
  /** The daemon's index reported a live TUI process holding this session. */
  readonly liveTui: boolean;
}

export function openSessionTarget(state: ConsoleState, rowId: string): SessionOpenTarget {
  // The roster first: it is fresher than the snapshot, and a synthesized row
  // carries an agent id directly. Attaching to a terminal agent is still the
  // right open; it opens the transcript the operator tapped.
  const holder = state.agents.find(agent => agent.acpSessionId === rowId || agent.id === rowId);
  if (holder !== undefined) {
    return { sessionId: rowId, agentId: holder.id, liveTui: false };
  }

  const summary = state.sessionIndex.find(row => row.id === rowId);
  if (summary === undefined) {
    return { sessionId: rowId, agentId: undefined, liveTui: false };
  }
  // The roster has not admitted this agent yet, but the daemon's index named
  // it as holding the session, so the id it named is the one to attach to.
  if (summary.status === "live-ompd" && summary.agentId !== undefined) {
    return { sessionId: rowId, agentId: summary.agentId, liveTui: false };
  }
  return { sessionId: rowId, agentId: undefined, liveTui: summary.status === "live-tui" };
}
