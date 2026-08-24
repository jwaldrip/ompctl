/**
 * What the session is doing right now, in one word an operator can read
 * without expanding anything.
 *
 * The reported gap was "I can't tell the agent is working". Every fact needed
 * to answer that was already in the store and none of it was on screen: the
 * agent's own state, the running-tool counts the transcript reducer maintains,
 * the clearances waiting on a person, the terminal's own turn boundaries, and
 * the link. This derives from exactly those and adds no state of its own.
 *
 * Derived, never remembered. There is no timer here and no "last seen busy at"
 * -- a spinner that keeps turning because a frame stopped arriving is the lie
 * this is meant to replace, so a state that has gone idle reads idle on the
 * very next render.
 *
 * Separate from the link readout, which answers a different question. One says
 * whether this device can hear the daemon; this says what the session is doing.
 * They disagree in both directions: a healthy link over an idle session, and a
 * dropped link over a session that was mid-turn when it went.
 */

import { type Agent, TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { SessionLoad, TuiSessionState } from "../console/state.ts";
import type { SessionState, ToolKind } from "./model.ts";

/**
 * The states worth distinguishing, in the order they take precedence.
 *
 * Precedence is the whole design, so it is stated rather than implied:
 *
 * 1. `offline` / `linking` -- a claim about the agent is worthless when this
 *    device cannot hear it. Whatever the last frame said may be minutes stale.
 * 2. `failed` -- a real failure, from the agent's own state or a refused open.
 * 3. `waiting` -- the only state that is about the operator. It outranks
 *    `running` because a session can hold a clearance while a tool it started
 *    earlier is still going, and the thing the person must know is that it is
 *    waiting on them.
 * 4. `running` -- named work in flight.
 * 5. `working` -- in flight with nothing named yet: thinking, or streaming.
 * 6. `stopped` / `ready` -- nothing in flight.
 */
export type SessionActivityKind =
  | "offline"
  | "linking"
  | "failed"
  | "waiting"
  | "running"
  | "working"
  | "stopped"
  | "ready";

export interface SessionActivity {
  readonly kind: SessionActivityKind;
  /** Compact label, for a phone header. Never carries tool arguments. */
  readonly label: string;
  /** What a screen reader should say. Same facts, read as a sentence. */
  readonly announcement: string;
  /** True only while work is actually in flight, which is the only time anything may move. */
  readonly live: boolean;
}

/**
 * Tool kinds as a person would say them. Deliberately the kind and never the
 * title: ACP's `title` is built from the call's own arguments, so it carries
 * command lines and paths that must not reach a header or an announcement.
 */
const KIND_WORDS: Record<ToolKind, string> = {
  think: "thinking",
  read: "reading",
  execute: "running a command",
  search: "searching",
  edit: "editing",
  fetch: "fetching",
  move: "moving files",
  delete: "deleting",
  other: "working",
};

/**
 * The one running kind, when there is exactly one call running and therefore
 * exactly one honest thing to name. Two calls of the same kind still name it;
 * two of different kinds do not, because there is no single answer and
 * picking one would be a guess about which the operator cares about.
 */
function soleRunningKind(activity: SessionState["activity"]): ToolKind | null {
  if (activity.running === 0) return null;
  const kinds = Object.entries(activity.runningByKind).filter(([, count]) => (count ?? 0) > 0);
  if (kinds.length !== 1) return null;
  return (kinds[0]?.[0] ?? null) as ToolKind | null;
}

function toolPhrase(activity: SessionState["activity"]): string {
  const sole = soleRunningKind(activity);
  if (sole !== null && activity.running === 1) return KIND_WORDS[sole];
  return `${activity.running} tools`;
}

/**
 * An owned or co-driven session's activity: an agent row, its reduced session,
 * the pane's load and the link.
 */
export function agentActivity(
  agent: Agent,
  session: SessionState,
  connection: ConnectionState,
  load: SessionLoad,
): SessionActivity {
  if (connection === "offline") {
    return { kind: "offline", label: "No link", announcement: "No link to the daemon", live: false };
  }
  if (connection === "connecting" || connection === "reconnecting" || load.phase === "stalled") {
    return { kind: "linking", label: "Reconnecting", announcement: "Reconnecting to the daemon", live: false };
  }
  if (agent.state === "failed" || load.phase === "failed") {
    return { kind: "failed", label: "Failed", announcement: "This session failed", live: false };
  }
  // Either kind of decision the session can be blocked on. A plan review is a
  // clearance in every way that matters to a person glancing at a header.
  const clearances = session.pendingApprovals.length + (session.planReview === null ? 0 : 1);
  if (clearances > 0 || agent.state === "waiting") {
    return {
      kind: "waiting",
      label: "Waiting for you",
      announcement: clearances > 1 ? `Waiting for you, ${clearances} decisions` : "Waiting for you",
      live: false,
    };
  }
  if (TERMINAL_AGENT_STATES.includes(agent.state)) {
    return { kind: "stopped", label: "Stopped", announcement: "This session has stopped", live: false };
  }
  if (session.activity.running > 0) {
    const phrase = toolPhrase(session.activity);
    return { kind: "running", label: phrase, announcement: `Working: ${phrase}`, live: true };
  }
  // `busy` is the daemon's own word for a turn in flight, and a streaming
  // entry is the same fact one layer down: either is enough, and neither is
  // inferred from how long ago something happened.
  const streaming = session.entries.some(entry => entry.kind === "assistant" && entry.streaming);
  if (agent.state === "busy" || streaming) {
    return { kind: "working", label: "Working", announcement: "Working", live: true };
  }
  if (agent.state === "provisioning" || agent.state === "starting") {
    return { kind: "linking", label: "Starting", announcement: "Starting this session", live: false };
  }
  return { kind: "ready", label: "Ready", announcement: "Ready", live: false };
}

/**
 * A live terminal session's activity, from what the terminal itself reports.
 *
 * The wire is narrower here than for an owned agent and the labels say so
 * rather than borrowing the richer vocabulary. `tui_activity` carries the
 * terminal's own `turn_start` and `turn_end`, which is a real working signal,
 * so thinking and idle ARE distinguishable on this path. What it does not
 * carry is tool state: `TuiActivityKind` is `assistant_text`, `turn_start` and
 * `turn_end` and nothing else, so a terminal session can never say which tool
 * is running. That is a missing producer, not something to synthesise: the
 * bridge would have to forward omp's `tool_execution_*` events for it, and it
 * does not. The honest label is the narrower one.
 */
export function tuiActivity(
  tui: TuiSessionState,
  connection: ConnectionState,
  load: SessionLoad,
  liveTerminal: boolean,
): SessionActivity {
  if (connection === "offline") {
    return { kind: "offline", label: "No link", announcement: "No link to the daemon", live: false };
  }
  if (connection === "connecting" || connection === "reconnecting" || load.phase === "stalled") {
    return { kind: "linking", label: "Reconnecting", announcement: "Reconnecting to the daemon", live: false };
  }
  if (load.phase === "failed") {
    return { kind: "failed", label: "Failed", announcement: "This session could not be opened", live: false };
  }
  // A refusal is the terminal or the daemon declining, which the operator has
  // to resolve; the screen states the reason in full below the header.
  if (tui.refusal !== null) {
    return { kind: "waiting", label: "Needs you", announcement: "This terminal needs your attention", live: false };
  }
  if (!liveTerminal) {
    return { kind: "stopped", label: "Not live", announcement: "This session is not live in a terminal", live: false };
  }
  // The terminal's own turn boundary, and this device's own outstanding steer.
  // No tool vocabulary, because the bridge sends none.
  if (tui.busy || tui.awaitingReply) {
    return { kind: "working", label: "Working", announcement: "Working in the terminal", live: true };
  }
  return { kind: "ready", label: "Ready", announcement: "Ready", live: false };
}
