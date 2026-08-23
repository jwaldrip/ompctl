/**
 * The daemon's registry of collab guest legs: one live co-driving join per
 * mirrored omp session.
 *
 * Named to never merge with `CollabRooms` (rooms.ts). That class is the
 * daemon's own voice-note hub, where the daemon is the room server and
 * phones are participants. This is the opposite direction: the daemon joins
 * a room some terminal's omp host shares, as a guest, and mirrors that
 * session back over the gateway socket as an ordinary agent. The two share
 * no state, no frames, and no vocabulary.
 *
 * The leg is daemon state, not client state, exactly like an owned agent: a
 * phone losing signal must not drop the co-drive. `openCollab` creates the
 * agent row, joins the room, and appends the room's transcript into the
 * agent's update log, so `attach`, replay, and live delivery all work
 * through machinery that knows nothing about collab.
 *
 * The room key is the one secret this holds. It lives in the parsed link,
 * then inside the non-extractable WebCrypto key handle of the guest socket,
 * for exactly as long as the leg is open, and is dropped when the leg closes
 * — never written to the store, the audit log, or any file. There is no
 * guest replica on disk by design: the update log already is the daemon's
 * copy of the transcript, in the store, under the agent row, which is why
 * nothing here writes under `~/.omp/collab/` or anywhere near the
 * operator's session tree.
 */

import {
  type Actor,
  type Agent,
  type AgentId,
  type AgentState,
  COLLAB_GUEST_SESSION_LABEL,
  type CollabRefusal,
  type PromptImage,
  SCOPE_PROMPT,
  SCOPE_READ,
  type Store,
  type TuiCollabClientFrame,
  type TuiCollabServerFrame,
} from "@ompd/core";
import { createAgentId } from "../supervisor.ts";
import { importRoomKey } from "./guest-codec.ts";
import type { CollabHostFrame } from "./guest-frames.ts";
import { parseCollabLink } from "./guest-link.ts";
import type { CollabFrameMapping } from "./guest-mapper.ts";
import { CollabStreamMapper } from "./guest-mapper.ts";
import { CollabGuestSocket } from "./guest-socket.ts";

/** The bridge must answer an open within this budget or the join fails. */
const BRIDGE_TIMEOUT_MS = 15_000;
/** Mirrors the TUI guest's welcome budget: a host that never answers hello ends the join. */
const WELCOME_TIMEOUT_MS = 30_000;
/** Mirrors the TUI guest's snapshot budget: every snapshot chunk must make progress. */
const SNAPSHOT_PROGRESS_TIMEOUT_MS = 30_000;

export interface CollabGuestsOptions {
  store: Store;
  /** The supervisor's authorization gate; the guest leg re-checks every privileged call through it. */
  authorize: (actor: Actor, scope: string, action: string, agentId?: AgentId) => Actor;
  /** Fan-out the gateway already listens to; updates and roster pushes ride it. */
  events: {
    onUpdate: (agentId: AgentId, seq: number, update: unknown) => void;
    onAgentsChanged: (agents: Agent[]) => void;
  };
  /** Send a bridge frame to the registered TUI holding `sessionId`; false when no live TUI holds it. */
  sendToHostingTui: (sessionId: string, frame: TuiCollabServerFrame) => boolean;
  /**
   * Whether the daemon's session index knows this session id. Consulted only
   * to tell `unknown_session` from `not_hosted`; a daemon with no index
   * wired cannot prove a session unknown, so it defaults to known.
   */
  sessionKnown?: (sessionId: string) => Promise<boolean>;
  /** The relay URL rooms this daemon opens should live on; null when the daemon's relay is not bound. */
  relayUrl: () => string | null;
  /** Participant name this leg reports to the host; also the own-prompt suppression key. */
  displayName?: string;
  bridgeTimeoutMs?: number;
  welcomeTimeoutMs?: number;
  snapshotTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export type CollabOpenOutcome =
  | { opened: true; agentId: AgentId; readOnly: boolean }
  | { refused: CollabRefusal }
  | { unavailable: string };

export type CollabLeaveOutcome = { left: true; agentId: AgentId } | { refused: "not_joined" };

/** A prompt or abort aimed at a guest agent, after the gateway's scope gate already passed. */
export type CollabWriteOutcome = { sent: true } | { refused: "view_only" | "not_joined" };

/** One live guest leg: the join, its agent row, and its frame pipeline. */
interface GuestLeg {
  sessionId: string;
  agentId: AgentId;
  socket: CollabGuestSocket;
  mapper: CollabStreamMapper;
  /** Effective trust: the link carried no write token, or the host marked this peer read-only. */
  readOnly: boolean;
  createdAtMs: number;
  /** The bridge request that opened the room, so leave can close a room this daemon caused. */
  bridgeRequestId: string;
  terminal: boolean;
}

/** A `collab_open` in flight against the bridge. */
interface PendingOpen {
  sessionId: string;
  resolve: (frame: Extract<TuiCollabClientFrame, { t: "tui_collab_opened" | "tui_collab_error" }>) => void;
  reject: (err: Error) => void;
  timer: Timer;
}

export class CollabGuests {
  readonly #store: Store;
  readonly #authorize: CollabGuestsOptions["authorize"];
  readonly #events: CollabGuestsOptions["events"];
  readonly #sendToHostingTui: CollabGuestsOptions["sendToHostingTui"];
  readonly #sessionKnown: (sessionId: string) => Promise<boolean>;
  readonly #relayUrl: () => string | null;
  readonly #displayName: string;
  readonly #bridgeTimeoutMs: number;
  readonly #welcomeTimeoutMs: number;
  readonly #snapshotTimeoutMs: number;
  readonly #log: (line: string) => void;

  readonly #bySession = new Map<string, GuestLeg>();
  readonly #byAgent = new Map<AgentId, GuestLeg>();
  readonly #pendingOpens = new Map<string, PendingOpen>();

  constructor(opts: CollabGuestsOptions) {
    this.#store = opts.store;
    this.#authorize = opts.authorize;
    this.#events = opts.events;
    this.#sendToHostingTui = opts.sendToHostingTui;
    this.#sessionKnown = opts.sessionKnown ?? (async () => true);
    this.#relayUrl = opts.relayUrl;
    this.#displayName = opts.displayName ?? "ompd";
    this.#bridgeTimeoutMs = opts.bridgeTimeoutMs ?? BRIDGE_TIMEOUT_MS;
    this.#welcomeTimeoutMs = opts.welcomeTimeoutMs ?? WELCOME_TIMEOUT_MS;
    this.#snapshotTimeoutMs = opts.snapshotTimeoutMs ?? SNAPSHOT_PROGRESS_TIMEOUT_MS;
    this.#log = opts.onLog ?? (() => {});
  }

  /** Whether `agentId` names a guest agent; the gateway routes prompt/cancel through this. */
  holds(agentId: AgentId): boolean {
    return this.#byAgent.has(agentId);
  }

  /** The guest agent mirroring `sessionId`, when this daemon is co-driving it. */
  agentForSession(sessionId: string): AgentId | undefined {
    return this.#bySession.get(sessionId)?.agentId;
  }

  /**
   * Join the room a live terminal's host shares for `sessionId` and present
   * it as an ordinary agent. Idempotent: a second ask for a session this
   * daemon already co-drives answers with the same agent, so a reconnected
   * phone recovers its row without a second guest leg in the room.
   */
  async openCollab(sessionId: string, actor: Actor): Promise<CollabOpenOutcome> {
    const existing = this.#bySession.get(sessionId);
    if (existing !== undefined) {
      return { opened: true, agentId: existing.agentId, readOnly: existing.readOnly };
    }
    // Read is the floor: watching is what opening buys, and steering is
    // gated again per write. Re-resolved from the device row rather than
    // trusting the caller's claim, the same rule the supervisor enforces.
    try {
      this.#authorize(actor, SCOPE_READ, "collab.open");
    } catch (err) {
      this.#audit(actor, sessionId, "denied", { reason: "unauthorized" });
      throw err;
    }
    const relayUrl = this.#relayUrl();
    if (relayUrl === null) {
      this.#audit(actor, sessionId, "denied", { reason: "no_relay" });
      return { unavailable: "this daemon's collab relay is not running" };
    }
    const answer = await this.#askBridgeForLink(sessionId, relayUrl);
    if (answer === "not_hosted" || answer === "unknown_session") {
      this.#audit(actor, sessionId, "denied", { reason: answer });
      return { refused: answer };
    }
    if ("bridge_error" in answer) {
      this.#audit(actor, sessionId, "denied", { reason: `bridge_${answer.bridge_error.reason}` });
      if (answer.bridge_error.reason === "refused") {
        // Occupied: the session is already in a room this daemon did not
        // open, and a phone cannot fix that from here.
        return { refused: "occupied" };
      }
      return { unavailable: answer.bridge_error.detail ?? "the terminal could not start sharing" };
    }
    const parsed = parseCollabLink(answer.link);
    if ("error" in parsed) {
      this.#log(`collab guest ${sessionId}: bridge returned an unparseable link`);
      return { unavailable: "the terminal returned an unusable sharing link" };
    }
    const writable = answer.writable && parsed.writeToken !== undefined;
    return await this.#join(sessionId, parsed, writable, answer.requestId, actor);
  }

  /** Stop co-driving `sessionId`: leave the room, settle the agent row, release the room if this daemon caused it. */
  leaveCollab(sessionId: string, actor: Actor): CollabLeaveOutcome {
    this.#authorize(actor, SCOPE_READ, "collab.leave");
    const leg = this.#bySession.get(sessionId);
    if (leg === undefined) {
      this.#audit(actor, sessionId, "denied", { reason: "not_joined" });
      return { refused: "not_joined" };
    }
    this.#endLeg(leg, "stopped", "left");
    this.#sendToHostingTui(sessionId, { t: "tui_collab_close", sessionId, requestId: leg.bridgeRequestId });
    this.#audit(actor, sessionId, "ok", { agentId: leg.agentId, reason: "left" });
    return { left: true, agentId: leg.agentId };
  }

  /**
   * Forward a prompt into the room. Refused locally when the leg holds a
   * view-only link: the host is specified to reject the write anyway, and a
   * named refusal here tells the phone why instead of a frame that dies
   * silently on the far side.
   */
  prompt(agentId: AgentId, text: string, images: PromptImage[] | undefined, actor: Actor): CollabWriteOutcome {
    this.#authorize(actor, SCOPE_PROMPT, "agent.prompt", agentId);
    const leg = this.#byAgent.get(agentId);
    if (leg === undefined) return { refused: "not_joined" };
    if (leg.readOnly) {
      this.#store.audit({
        action: "agent.prompt",
        agentId,
        actorDeviceId: actor.deviceId,
        outcome: "denied",
        detail: { sessionId: leg.sessionId, reason: "view_only" },
      });
      return { refused: "view_only" };
    }
    this.#store.audit({
      action: "agent.prompt",
      agentId,
      actorDeviceId: actor.deviceId,
      outcome: "ok",
      detail: {
        sessionId: leg.sessionId,
        chars: text.length,
        ...(images !== undefined && images.length > 0 ? { images: images.length } : {}),
      },
    });
    this.#setState(leg, "busy");
    leg.socket.send({
      t: "prompt",
      text,
      ...(images !== undefined && images.length > 0
        ? { images: images.map(image => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })) }
        : {}),
    });
    return { sent: true };
  }

  /** Interrupt the mirrored session's running turn. Same trust rule as a prompt. */
  abort(agentId: AgentId, actor: Actor): CollabWriteOutcome {
    this.#authorize(actor, SCOPE_PROMPT, "agent.cancel", agentId);
    const leg = this.#byAgent.get(agentId);
    if (leg === undefined) return { refused: "not_joined" };
    if (leg.readOnly) return { refused: "view_only" };
    leg.socket.send({ t: "abort" });
    return { sent: true };
  }

  /** Route a bridge answer to the open that asked for it. */
  onBridgeFrame(frame: TuiCollabClientFrame): void {
    if (frame.t === "tui_collab_opened" || frame.t === "tui_collab_error") {
      for (const [requestId, pending] of this.#pendingOpens) {
        if ((frame as { requestId?: string }).requestId !== requestId) continue;
        this.#pendingOpens.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(frame);
        return;
      }
      return;
    }
    // tui_collab_closed: informational. A room ending is observed through
    // the guest socket's own close path, which is authoritative.
  }

  /** The bridge socket for a hosting terminal died: fail any open still waiting on it. */
  onHostTuiGone(sessionId: string): void {
    for (const [requestId, pending] of this.#pendingOpens) {
      if (pending.sessionId !== sessionId) continue;
      this.#pendingOpens.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error(`the terminal holding session ${sessionId} disconnected`));
    }
    // Live legs need no teardown here: the room dies with its host, and the
    // guest socket observes that directly.
  }

  /** Daemon shutdown: every leg leaves and every row settles. */
  close(): void {
    for (const leg of this.#bySession.values()) this.#endLeg(leg, "stopped", "daemon stopping");
  }

  // -- join ------------------------------------------------------------------

  async #askBridgeForLink(
    sessionId: string,
    relayUrl: string,
  ): Promise<
    | Extract<TuiCollabClientFrame, { t: "tui_collab_opened" }>
    | { bridge_error: Extract<TuiCollabClientFrame, { t: "tui_collab_error" }> }
    | "not_hosted"
    | "unknown_session"
  > {
    const requestId = crypto.randomUUID();
    const sent = this.#sendToHostingTui(sessionId, { t: "tui_collab_open", sessionId, requestId, relayUrl });
    if (!sent) {
      // No registered TUI holds the session. The index decides which
      // refusal tells the phone the truth: an id it never had, or a session
      // that exists but nothing live is sharing.
      return (await this.#sessionKnown(sessionId)) ? "not_hosted" : "unknown_session";
    }
    const answer = await new Promise<Extract<TuiCollabClientFrame, { t: "tui_collab_opened" | "tui_collab_error" }>>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          this.#pendingOpens.delete(requestId);
          reject(new Error("the terminal did not answer the sharing request"));
        }, this.#bridgeTimeoutMs);
        this.#pendingOpens.set(requestId, { sessionId, resolve, reject, timer });
      },
    );
    return answer.t === "tui_collab_opened" ? answer : { bridge_error: answer };
  }

  async #join(
    sessionId: string,
    parsed: { wsUrl: string; roomId: string; key: Uint8Array; writeToken?: Uint8Array },
    writable: boolean,
    bridgeRequestId: string,
    actor: Actor,
  ): Promise<CollabOpenOutcome> {
    const agentId = createAgentId();
    const mapper = new CollabStreamMapper({ ownName: this.#displayName });
    const socket = new CollabGuestSocket({ wsUrl: parsed.wsUrl, key: importRoomKey(parsed.key) });
    const writeToken =
      writable && parsed.writeToken !== undefined ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
    // The join settles (or fails) through these; everything after runs on
    // socket frames, not on this call's stack.
    const joined = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<string>();
    let settled = false;
    const leg: GuestLeg = {
      sessionId,
      agentId,
      socket,
      mapper,
      readOnly: !writable,
      createdAtMs: Date.now(),
      bridgeRequestId,
      terminal: false,
    };

    let welcomed = false;
    let snapshotDone = false;
    let welcomeTimer: Timer | null = null;
    let snapshotTimer: Timer | null = null;
    const clearTimers = (): void => {
      if (welcomeTimer !== null) {
        clearTimeout(welcomeTimer);
        welcomeTimer = null;
      }
      if (snapshotTimer !== null) {
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
    };
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      failure.resolve(reason);
    };

    socket.onOpen = () => {
      socket.send({ t: "hello", proto: 3, name: this.#displayName, writeToken });
    };
    socket.onControl = msg => {
      if (msg.t === "room-closed") fail("the room closed before the join finished");
    };
    socket.onClose = (reason, willReconnect) => {
      // Transient drops are the socket's business; it reconnects and the
      // host re-delivers the snapshot (entries dedupe by id).
      if (willReconnect) return;
      if (settled) {
        this.#endLeg(leg, "stopped", reason);
        return;
      }
      fail(reason);
    };
    socket.onFrame = frame => {
      const mapping = this.#ingest(leg, frame);
      if (mapping === null || settled) return;
      if (mapping.header !== undefined) {
        welcomed = true;
        // The host's verdict outranks the link's strength: a host that
        // marks this peer read-only is the authority on what it will
        // accept, whatever token the link carried.
        if (mapping.readOnly === true) leg.readOnly = true;
      }
      if (welcomed && !snapshotDone) {
        if (mapping.snapshotFinal === true) {
          snapshotDone = true;
        } else {
          // Every non-final chunk must make progress; a stalled snapshot
          // ends the join rather than hanging the phone's open.
          if (snapshotTimer !== null) clearTimeout(snapshotTimer);
          snapshotTimer = setTimeout(
            () => fail("the session snapshot never finished arriving"),
            this.#snapshotTimeoutMs,
          );
        }
      }
      if (welcomed && snapshotDone) {
        settled = true;
        clearTimers();
        joined.resolve();
      }
    };

    this.#bySession.set(sessionId, leg);
    this.#byAgent.set(agentId, leg);
    this.#upsertLegRow(leg, "starting", undefined, undefined);
    this.#audit(actor, sessionId, "ok", { agentId, roomId: parsed.roomId, writable });
    welcomeTimer = setTimeout(() => fail("the host never answered this join"), this.#welcomeTimeoutMs);
    socket.connect();

    const raced = await Promise.race([joined.promise.then(() => "joined" as const), failure.promise]);
    if (raced !== "joined") {
      this.#endLeg(leg, "failed", raced);
      this.#audit(actor, sessionId, "denied", { reason: "join_failed", detail: raced });
      return { unavailable: `could not co-drive session ${sessionId}: ${raced}` };
    }
    return { opened: true, agentId, readOnly: leg.readOnly };
  }

  // -- frame application -----------------------------------------------------

  /**
   * Apply one host frame: log its updates, adopt its state, and end the leg
   * if the frame says the sharing stopped. Returns the mapping the join
   * waiter inspects, or null once the leg is terminal.
   */
  #ingest(leg: GuestLeg, frame: CollabHostFrame): CollabFrameMapping | null {
    if (leg.terminal) return null;
    const mapping = leg.mapper.mapFrame(frame);
    for (const update of mapping.updates) {
      const seq = this.#store.appendUpdate(leg.agentId, update);
      this.#events.onUpdate(leg.agentId, seq, update);
    }
    if (mapping.ended !== undefined) {
      this.#endLeg(leg, "stopped", mapping.ended);
      return null;
    }
    if (mapping.state !== undefined || mapping.header !== undefined) {
      const state: AgentState =
        mapping.state !== undefined
          ? mapping.state.isStreaming
            ? "busy"
            : "idle"
          : (this.#store.getAgent(leg.agentId)?.state ?? "idle");
      this.#upsertLegRow(leg, state, mapping.header, mapping.state);
    }
    return mapping;
  }

  #upsertLegRow(
    leg: GuestLeg,
    state: AgentState,
    header: CollabFrameMapping["header"],
    live: CollabFrameMapping["state"],
  ): void {
    const existing = this.#store.getAgent(leg.agentId);
    const now = new Date().toISOString();
    const metrics = leg.mapper.metrics();
    const agent: Agent = {
      id: leg.agentId,
      name: live?.sessionName ?? header?.title ?? existing?.name ?? `Co-driving ${leg.sessionId.slice(0, 8)}`,
      state,
      host: existing?.host ?? { kind: "local", id: `collab:${leg.sessionId.slice(0, 8)}`, spec: { kind: "local" } },
      cwd: live?.cwd ?? header?.cwd ?? existing?.cwd ?? "",
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
      parentAgentId: existing?.parentAgentId,
      model: live?.model !== undefined ? `${live.model.provider}/${live.model.id}` : existing?.model,
      metrics: {
        usedTokens: metrics.usedTokens,
        costAmount: metrics.costAmount,
        durationMs: Date.now() - leg.createdAtMs,
      },
      labels: existing?.labels ?? { source: "collab-guest", [COLLAB_GUEST_SESSION_LABEL]: leg.sessionId },
    };
    this.#store.upsertAgent(agent);
    this.#events.onAgentsChanged(this.#store.listAgents());
  }

  #setState(leg: GuestLeg, state: AgentState): void {
    this.#store.setAgentState(leg.agentId, state);
    this.#events.onAgentsChanged(this.#store.listAgents());
  }

  /** Terminal close of a leg: leave the room, settle the row, and drop the key by dropping every reference to it. */
  #endLeg(leg: GuestLeg, state: AgentState, reason: string): void {
    if (leg.terminal) return;
    leg.terminal = true;
    this.#bySession.delete(leg.sessionId);
    this.#byAgent.delete(leg.agentId);
    leg.socket.close();
    this.#store.setAgentState(leg.agentId, state);
    this.#events.onAgentsChanged(this.#store.listAgents());
    this.#log(`collab guest ${leg.sessionId}: ended (${reason})`);
  }

  #audit(actor: Actor, sessionId: string, outcome: "ok" | "denied", detail: Record<string, unknown>): void {
    this.#store.audit({
      action: "collab.join",
      actorDeviceId: actor.deviceId,
      outcome,
      detail: { sessionId, ...detail },
    });
  }
}
