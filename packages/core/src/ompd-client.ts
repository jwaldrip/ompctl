/**
 * Typed websocket client for the ompd gateway.
 *
 * The load-bearing property here is lossless resume. Agent lifetime belongs to
 * the daemon, so a client that loses its connection mid-turn must come back to
 * exactly the updates it missed: no gap, no duplicate. The daemon persists
 * every `session/update` with a monotonic per-agent `seq` for precisely this
 * reason, so the client's job is to remember the highest `seq` it has actually
 * delivered and to reattach with that watermark on every reconnect.
 *
 * Everything the client touches from the outside world (socket construction,
 * timers, randomness, connectivity) is injectable, so the reconnect path is
 * testable without a live daemon and without waiting on wall-clock time.
 *
 * This is the one implementation every ompd client (TUI, app, web, and
 * anything future) shares. It has no framework dependency: only
 * `@ompd/core/contracts` and the seams above. A host that cannot use the
 * platform `WebSocket` global supplies its own via `createSocket`.
 */

import type {
  Agent,
  AgentConfigOption,
  AgentId,
  ApprovalChoice,
  ApprovalScope,
  ClientFrame,
  CloneId,
  CollabSignalFrame,
  CollabSignalInput,
  CollabVoiceFrame,
  CollabVoiceNoteFrame,
  CollabVoiceNoteInput,
  CollabVoiceParticipant,
  FsListing,
  PlanReviewChoice,
  RemoteRoutine,
  RoutineDeleteResult,
  Run,
  ServerFrame,
  SessionDeleteResult,
  SessionHistoryEntry,
  SessionQuery,
  SessionSummary,
  SyncSettings,
  TranscriptTailMessage,
  TuiActivityKind,
  TuiSteerDelivery,
  WebViewAction,
  WebViewActionResult,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Cancels a scheduled callback. Calling it twice must be harmless. */
export type Cancel = () => void;

/** Schedules `fn` after `ms`. Mirrors `setTimeout`, minus the host quirks. */
export type Scheduler = (fn: () => void, ms: number) => Cancel;

export interface SocketCloseInfo {
  code?: number;
  reason?: string;
}

/**
 * The slice of a websocket this client uses. A real `WebSocket` is adapted onto
 * this rather than typed as it, because DOM's `CloseEvent`-shaped handlers are
 * contravariantly incompatible with a narrower structural type.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((info: SocketCloseInfo) => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((message: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/**
 * What the daemon said when asked whether a token is still a credential.
 *
 * `unknown` is not a failure to answer politely: it is the answer when the
 * daemon could not be reached at all, and it must never be treated as a
 * rejection. An unreachable daemon is the ordinary case this client already
 * handles by reconnecting.
 */
export type CredentialVerdict = "valid" | "rejected" | "unknown";

export type CredentialProbe = () => Promise<CredentialVerdict>;

const SOCKET_OPEN = 1;

/**
 * Error codes worth asking the daemon whether this credential is still good.
 *
 * The gateway answers `unauthorized` both for "that token is not valid" and
 * for "your device does not hold that scope", and the two want opposite
 * responses: forget the pairing, or carry on with fewer buttons. The code
 * alone cannot tell them apart, so it only triggers the question.
 */
const AUTH_SUSPECT_CODES: Record<string, true> = { unauthorized: true };

/**
 * Whether losing a frame to a closed socket is worth telling the operator
 * about. Attach and detach are re-sent from `attached` on the next `hello`,
 * and a ping that never left is answered by the next ping, so their loss is
 * invisible by design. A prompt, cancel, or decision is an instruction that
 * simply did not happen, and silence there is how an operator ends up
 * believing they approved something.
 */
const LOSS_IS_VISIBLE: Record<ClientFrame["t"], boolean> = {
  attach: false,
  detach: false,
  ping: false,
  audio: false,
  audio_end: false,
  room_join: false,
  room_leave: false,
  room_offer: true,
  room_answer: true,
  ice_candidate: true,
  collab_voice_note: true,
  prompt: true,
  cancel: true,
  decide: true,
  plan_decide: true,
  // A lost result is a lost answer: the agent never learns whether the
  // navigate/click/type it dispatched actually happened, which is the same
  // "silently believed something occurred" failure a lost `decide` is.
  webview_result: true,
  // Re-sent from `webviews` on the next `hello`, exactly like `attach`: a
  // registration that never left is restored by the reconnect that follows.
  webview_register: false,
  webview_unregister: false,
  // Normal TUI control frames are emitted only by the terminal client, never
  // by this app-facing client. Losing one here is not a user instruction.
  tui_register: false,
  tui_acp: false,
  tui_acp_ready: false,
  // Same reasoning as `prompt`: a steered session prompt that never left is
  // an instruction that silently did not happen.
  session_prompt: true,
  // Emitted by the terminal bridge, never by this client. Losing one here is
  // not a user instruction.
  tui_activity: false,
  // Re-sent from the remembered query on the next `hello`, exactly like
  // `attach`: the answer is a snapshot this client asked for, not an
  // instruction that silently did not happen.
  sessions: false,
  // One-shot instructions, never replayed: a takeover or resume that never
  // left is an operator action that silently did not happen, the same
  // failure class as a lost `prompt`, and the operator must hear about it
  // rather than watch a session that will never open.
  session_takeover: true,
  session_resume: true,
  // Irreversible and never replayed. A delete that never left is an
  // operator action that silently did not happen, and the operator must
  // hear that rather than believe a transcript is gone; re-sending it on a
  // reconnect would be worse, because by then they may have decided not to.
  session_delete: true,
  // Same failure class as the one-shot session frames, with more at stake:
  // an invite that never left is a credential the operator believes they
  // handed over and did not, and the new device's user is left scanning a
  // code that was never minted.
  device_invite: true,
  // Gestures, every one of them, and none is replayed: a tap on a directory
  // that silently went nowhere leaves an operator watching a spinner, and a
  // start or a clone that never left is an action they will believe happened.
  fs_list: true,
  session_create: true,
  repo_clone: true,
  // One-shot too, but a lost tail is not an instruction that silently did
  // not happen: nothing on the machine changes, and the surface that asked
  // asks again the next time it opens. Reporting it would put an error in
  // front of an operator whose only remedy is the reconnect already running.
  session_tail: false,
  session_history: false,
  // A snapshot ask, same class as `session_tail`: nothing on the machine
  // changes, and the surface that asked asks again the next time it opens.
  settings_read: false,
  agent_config_read: false,
  // A lost write is an instruction that silently did not happen: the
  // operator believes the machine now runs under a different policy and it
  // does not, which is the same failure class as a lost `decide`.
  settings_write: true,
  // A lost write is an instruction that silently did not happen: the
  // operator believes the agent now runs under a different mode and it does
  // not, so the next turn runs with permissions they think they changed.
  // Same failure class as a lost `decide`.
  agent_config_write: true,
  // A snapshot ask, same class as `settings_read`; the three that follow are
  // instructions that silently did not happen. A lost write leaves an
  // operator believing a routine is armed, a lost run leaves them waiting on
  // work that never started, and a lost rotate leaves a secret they think
  // they replaced still live at the webhook.
  routines_read: false,
  routine_write: true,
  routine_run: true,
  routine_secret_rotate: true,
  // Irreversible and never replayed, exactly `session_delete`'s class: a
  // delete that never left leaves an operator believing a routine is gone
  // while its schedule still fires; re-sending after they may have changed
  // their mind would be worse.
  routine_delete: true,
};

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  /** Delay before the first retry. */
  baseMs: number;
  /** Ceiling. Growth stops here however long the outage runs. */
  maxMs: number;
  /** Multiplier applied per consecutive failure. */
  factor: number;
  /**
   * Fraction of the delay given over to randomness, in `[0, 1]`. A delay lands
   * in `[raw * (1 - jitter), raw]`, so jitter only ever shortens a wait and can
   * never breach the ceiling. Its job is to stop every client in a fleet
   * reconnecting on the same tick after the daemon restarts.
   */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.3,
};

/**
 * Delay before retry number `attempt` (zero-based: attempt 0 is the first
 * retry after a healthy connection dropped).
 */
export function computeBackoffDelay(attempt: number, options: BackoffOptions, random: () => number): number {
  const exponent = Math.max(0, attempt);
  const raw = Math.min(options.maxMs, options.baseMs * options.factor ** exponent);
  const spread = raw * clamp01(options.jitter) * clamp01(random());
  return Math.max(0, Math.round(raw - spread));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "offline";

export interface StatusEvent {
  state: ConnectionState;
  /** Consecutive failed attempts. Zero while healthy. */
  attempt: number;
  /** Present on `reconnecting`: how long until the next attempt. */
  delayMs?: number;
  /** Human-readable cause of the last transition, when there was one. */
  reason?: string;
}

export interface AgentsEvent {
  agents: Agent[];
  /** Present only on the initial `hello` of a connection. */
  deviceId?: string;
  /**
   * The scopes the daemon says this device holds, carried the same way as
   * `deviceId`: present only on the initial `hello`, and only when the
   * daemon reports them. Undefined is an older daemon, never an empty
   * grant, so a reader must treat it as unknown rather than none.
   */
  scopes?: string[];
}

export interface UpdateEvent {
  agentId: AgentId;
  seq: number;
  /** Raw ACP `session/update` payload. Shape is the transcript's problem. */
  update: unknown;
}

export interface ApprovalEvent {
  agentId: AgentId;
  requestId: string;
  title: string;
  tool: string;
  input: unknown;
}

export interface PlanReviewEvent {
  agentId: AgentId;
  requestId: string;
  message: string;
  choices: readonly PlanReviewChoice[];
}

export interface ClientErrorEvent {
  message: string;
  code?: string;
  agentId?: AgentId;
}

/**
 * The spoken form of a settled turn, as text.
 *
 * `seq` is the update the prose derives from, so a client that reconnects and
 * replays can tell a fresh summary from one it has already spoken.
 */
export interface SayEvent {
  agentId: AgentId;
  seq: number;
  text: string;
}

/** Synthesized speech for a turn the operator started by speaking. */
export interface SpeechEvent {
  agentId: AgentId;
  /** base64 16kHz mono PCM16, the same wire format the client sends up. */
  pcm: string;
}

/** A finalised transcript of what the operator said. */
export interface TranscriptEvent {
  agentId: AgentId;
  text: string;
  final: boolean;
}

/**
 * The daemon has confirmed this token is no longer a credential.
 *
 * Terminal. The client has stopped and will not reconnect, because there is
 * nothing to reconnect with: only a new pairing produces a working token.
 */
export interface UnauthorizedEvent {
  /** Plain language, for a screen a person is looking at. */
  reason: string;
}

/**
 * An action the daemon wants this client's embedded WebView to perform.
 *
 * Only ever delivered to the socket that registered as the agent's WebView
 * target, and only after the daemon's policy engine cleared it. The client's
 * job is to perform it and answer with `webViewResult` carrying the same
 * `requestId`: the daemon holds the agent's tool call open until it does, so
 * an unanswered action is a tool call that waits out the bridge's timeout.
 */
export interface WebViewActionEvent {
  agentId: AgentId;
  requestId: string;
  action: WebViewAction;
}

export interface RoomParticipantsEvent {
  roomId: string;
  participants: CollabVoiceParticipant[];
}

export interface RoomSignalEvent {
  signal: CollabSignalFrame;
}

export interface CollabVoiceEvent {
  frame: CollabVoiceFrame;
}

export interface CollabVoiceHistoryEvent {
  roomId: string;
  notes: CollabVoiceNoteFrame[];
}

/**
 * The session index, answering `listSessions` or the replay of it after a
 * reconnect. A snapshot, not a stream: each delivery replaces whatever the
 * previous one showed, because the daemon rebuilds the index from disk on
 * every request and nothing about an old row survives a new answer.
 */
export interface SessionsEvent {
  sessions: SessionSummary[];
}

/**
 * The daemon opened a session this client asked to open -- by takeover or
 * by resume, including the idempotent answer for one already held. Carries
 * no agent record on purpose: the `agents` event (or `hello`) delivers the
 * roster, and a second copy here would be a second thing to keep in sync.
 */
export interface SessionOpenedEvent {
  sessionId: string;
  agentId: AgentId;
}

/**
 * What a `deleteSessions` did, one result per id asked for. Delivered to the
 * socket that asked and nowhere else; the fleet's own refresh arrives
 * separately as a `sessions` snapshot the daemon's watcher pushes when the
 * files go away, so a surface listening only to this event learns the
 * outcome, and one listening only to the index learns the new world.
 */
export interface SessionsDeletedEvent {
  results: SessionDeleteResult[];
}

/**
 * A credential minted by this device's own `inviteDevice`, answering exactly
 * the socket that asked. The token is the one-time view: nothing downstream
 * of this event retains it unless the operator chooses to show or spend it.
 */
export interface DeviceInvitedEvent {
  token: string;
  name: string;
  scopes: string[];
}

/**
 * Turn progress from a live terminal session, forwarded by the daemon because
 * this client asked for the session index. Not resumable and not sequenced:
 * a `turn_start` missed during a drop is superseded by whatever the index and
 * the next activity frame say when the socket comes back, so the client treats
 * these as hints about a row it is watching, never as a transcript.
 */
export interface TuiActivityEvent {
  sessionId: string;
  kind: TuiActivityKind;
  text?: string;
}

/**
 * One directory, as the daemon reads it right now.
 *
 * A snapshot answering a gesture, never state this client maintains: the
 * operator tapped a folder and this is what was in it. `bounded` says the
 * daemon returned a page rather than the whole directory, and a view that
 * dropped that would be showing a truncated listing as a complete one.
 */
export interface FsListingEvent extends FsListing {}

/** One line of a clone's progress, correlated by `cloneId`. */
export interface CloneProgressEvent {
  cloneId: CloneId;
  line: string;
}

/** A clone finished and `path` now exists. Failures arrive as `error`, like every other refusal. */
export interface CloneDoneEvent {
  cloneId: CloneId;
  path: string;
}

/**
 * One page of a session's transcript, answering `sessionTail`. Oldest first,
 * so a view appends live `tui_activity` below it without reordering.
 * `truncated` says the page is not the whole transcript, which is a
 * rendering hint and nothing more.
 *
 * `nextCursor` is the offset to ask from for the next older page, or null at
 * the start of the file. An empty page with a non-null cursor is a real
 * answer, not an end: a long run of tool traffic says nothing, so a view
 * asks on rather than stopping. `cursor` is the offset this page was read
 * from, absent when the ask carried none, which is how a view tells a first
 * page from an older one and drops a page answering an ask it has replaced.
 */
export interface SessionTailEvent {
  sessionId: string;
  messages: TranscriptTailMessage[];
  truncated: boolean;
  nextCursor: number | null;
  cursor?: number;
}

/** One structured page of durable session history. */
export interface SessionHistoryEvent {
  agentId: AgentId;
  sessionId: string;
  entries: SessionHistoryEntry[];
  nextBefore: number | null;
}

/**
 * The daemon's settings as it holds them now, answering `readSettings` or
 * `writeSettings`. Confirmation rather than echo: after a write it carries
 * what the daemon read back from the store that persists.
 */
export interface SettingsEvent {
  settings: SyncSettings;
}

/**
 * Every routine the daemon holds plus the runs recorded against them,
 * answering `readRoutines`. A snapshot ask, so a surface renders the schedule
 * and its history together rather than stitching two frames.
 */
export interface RoutinesEvent {
  routines: RemoteRoutine[];
  runs: Run[];
}

/** One routine run recorded, carrying every action's outcome. */
export interface RoutineRanEvent {
  run: Run;
}

/**
 * A routine's webhook secret, freshly minted by `rotateRoutineSecret`. Shown
 * once: the daemon keeps only what it needs to verify a caller.
 */
export interface RoutineSecretEvent {
  routineId: string;
  secret: string;
}

/**
 * What a `deleteRoutines` did, one result per id asked for. Delivered to the
 * socket that asked; the refreshed catalogue arrives separately as a
 * `routines` snapshot, so a surface listening only to this event learns the
 * refusal without waiting on a refresh it may never get.
 */
export interface RoutinesDeletedEvent {
  results: RoutineDeleteResult[];
}

/**
 * One agent's session config as the daemon holds it now, answering
 * `readAgentConfig` or `writeAgentConfig`. Confirmation rather than echo:
 * after a write it carries what the daemon read back from the session, so a
 * surface renders the mode the agent actually runs under.
 */
export interface AgentConfigEvent {
  agentId: AgentId;
  configOptions: AgentConfigOption[];
}

export interface ClientEventMap {
  status: StatusEvent;
  agents: AgentsEvent;
  update: UpdateEvent;
  approval: ApprovalEvent;
  plan_review: PlanReviewEvent;
  error: ClientErrorEvent;
  say: SayEvent;
  speech: SpeechEvent;
  transcript: TranscriptEvent;
  unauthorized: UnauthorizedEvent;
  webview_action: WebViewActionEvent;
  room_participants: RoomParticipantsEvent;
  room_signal: RoomSignalEvent;
  tui_activity: TuiActivityEvent;
  collab_voice: CollabVoiceEvent;
  collab_voice_history: CollabVoiceHistoryEvent;
  sessions: SessionsEvent;
  session_opened: SessionOpenedEvent;
  sessions_deleted: SessionsDeletedEvent;
  device_invited: DeviceInvitedEvent;
  fs_listing: FsListingEvent;
  clone_progress: CloneProgressEvent;
  clone_done: CloneDoneEvent;
  settings: SettingsEvent;
  routines: RoutinesEvent;
  routine_ran: RoutineRanEvent;
  routines_deleted: RoutinesDeletedEvent;
  routine_secret: RoutineSecretEvent;
  session_tail: SessionTailEvent;
  session_history: SessionHistoryEvent;
  agent_config: AgentConfigEvent;
}

export type ClientEventName = keyof ClientEventMap;
export type Listener<K extends ClientEventName> = (event: ClientEventMap[K]) => void;
export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface OmpdClientOptions {
  /** Socket endpoint, e.g. `ws://127.0.0.1:7777/v1/socket`. */
  url: string;
  /** Device token issued at pairing. Appended as the `token` query parameter. */
  token: string;
  backoff?: Partial<BackoffOptions>;
  /** Interval between liveness pings once a connection is established. */
  pingIntervalMs?: number;
  /** How long a `pong` may take before the link is declared dead. */
  pongTimeoutMs?: number;
  createSocket?: SocketFactory;
  schedule?: Scheduler;
  random?: () => number;
  /** Reports host connectivity. Distinguishes "retrying" from "no network". */
  isOnline?: () => boolean;
  /**
   * Asks the daemon whether the token is still a credential. Defaults to one
   * authenticated HTTP request against the same origin as `url`.
   */
  probeCredential?: CredentialProbe;
}

export interface AttachOptions {
  /**
   * Replay from just after this sequence number. Omit to resume from the
   * client's own watermark, which is what a reconnect wants. Pass `0` to ask
   * for the full transcript.
   */
  sinceSeq?: number;
}

export class OmpdClient {
  private readonly url: string;
  private readonly token: string;
  private readonly backoff: BackoffOptions;
  private readonly pingIntervalMs: number;
  private readonly pongTimeoutMs: number;
  private readonly createSocket: SocketFactory;
  private readonly schedule: Scheduler;
  private readonly random: () => number;
  private readonly isOnline: () => boolean;
  private readonly probeCredential: CredentialProbe;

  private readonly listeners = new Map<ClientEventName, Set<(event: never) => void>>();

  /** Highest `seq` delivered per agent. The resume watermark. */
  private readonly watermarks = new Map<AgentId, number>();
  /** Agents whose attachment must survive a reconnect. */
  private readonly attached = new Set<AgentId>();
  /**
   * Agents whose WebView this client is the live target for.
   *
   * Kept separately from `attached` because the daemon drops the registration
   * when the socket goes, while the attachment is what this client wants to be
   * true. A reconnect replays both, in that order.
   */
  private readonly webviews = new Set<AgentId>();
  /** Rooms this client must rejoin after a socket reconnect. */
  private readonly rooms = new Set<string>();
  /**
   * The last session query asked for, replayed after a reconnect exactly like
   * an attachment: a phone that listed sessions, dropped, and came back must
   * hold a current index without knowing it reconnected. `askedSessions`
   * distinguishes "never asked" from a real `listSessions()` with no query,
   * which must still be replayed.
   */
  private askedSessions = false;
  private sessionQuery: SessionQuery | undefined;

  private socket: SocketLike | null = null;
  /** Invalidates handlers belonging to a socket we have already abandoned. */
  private generation = 0;
  private attempt = 0;
  private state: ConnectionState = "offline";
  private started = false;
  /** Last delay handed to the scheduler, so a repeat can be stepped off. */
  private previousDelayMs: number | null = null;
  /** True once this attempt has been answered with `hello`. Reset per attempt. */
  private authenticated = false;
  /** Set once the daemon has confirmed the token is dead. Never unset. */
  private rejected = false;
  /** One probe at a time; a flurry of refusals asks the same question once. */
  private probing = false;

  private cancelReconnect: Cancel | null = null;
  private cancelPing: Cancel | null = null;
  private cancelPong: Cancel | null = null;

  constructor(options: OmpdClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.pingIntervalMs = options.pingIntervalMs ?? 15_000;
    this.pongTimeoutMs = options.pongTimeoutMs ?? 10_000;
    this.createSocket = options.createSocket ?? createPlatformSocket;
    this.schedule = options.schedule ?? scheduleWithTimeout;
    this.random = options.random ?? Math.random;
    this.isOnline = options.isOnline ?? readNavigatorOnline;
    this.probeCredential = options.probeCredential ?? createCredentialProbe(options.url, options.token);
  }

  // -- public surface -------------------------------------------------------

  get connectionState(): ConnectionState {
    return this.state;
  }

  /** Highest sequence number delivered for an agent, or `undefined`. */
  watermark(agentId: AgentId): number | undefined {
    return this.watermarks.get(agentId);
  }

  on<K extends ClientEventName>(name: K, listener: Listener<K>): Unsubscribe {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    // One cast, contained here: the map is heterogeneous by construction and
    // `on`/`emit` are the only two places that know the pairing is sound.
    const erased = listener as unknown as (event: never) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  /** Opens the connection and keeps it open until `close()`. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.attempt = 0;
    this.previousDelayMs = null;
    this.openSocket("start");
  }

  /** Closes deliberately. No further reconnects until `start()` is called. */
  close(): void {
    this.started = false;
    this.clearTimers();
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(1000, "client closed");
    this.setStatus("offline", { reason: "closed by client" });
  }

  /**
   * Skips a pending backoff wait and retries immediately. Called when the
   * host comes back online or regains foreground, both of which mean the
   * reason for the wait has probably just gone away.
   *
   * A pending timer is the only thing this cancels. With an attempt already in
   * flight there is nothing to hurry, and tearing that socket down on every
   * refocus would turn a flaky link into a connect loop.
   */
  reconnectNow(): void {
    if (!this.started) return;
    if (this.cancelReconnect === null) return;
    this.cancelReconnect();
    this.cancelReconnect = null;
    this.openSocket("manual retry");
  }

  attach(agentId: AgentId, options: AttachOptions = {}): void {
    this.attached.add(agentId);
    if (options.sinceSeq !== undefined) this.watermarks.set(agentId, options.sinceSeq);
    this.sendAttach(agentId);
  }

  detach(agentId: AgentId): void {
    // The watermark deliberately outlives the attachment: reattaching later
    // should resume, not replay a transcript the client already holds.
    this.attached.delete(agentId);
    // The daemon drops the WebView target with the attachment, so holding the
    // local flag would make the next `hello` re-register a WebView for an
    // agent this client is no longer watching.
    this.webviews.delete(agentId);
    this.send({ t: "detach", agentId });
  }

  /**
   * Offer this client's embedded WebView as the agent's action target.
   *
   * The daemon keeps one target per agent, so registering displaces whatever
   * held it before. Detaching drops it too, which is why this is only ever
   * called for an agent this client is already attached to.
   */
  registerWebView(agentId: AgentId): void {
    this.webviews.add(agentId);
    this.send({ t: "webview_register", agentId });
  }

  /** Withdraw this client's WebView without detaching from the agent. */
  unregisterWebView(agentId: AgentId): void {
    this.webviews.delete(agentId);
    this.send({ t: "webview_unregister", agentId });
  }

  /** Answer one dispatched action. `requestId` must be the one that arrived. */
  webViewResult(agentId: AgentId, requestId: string, result: WebViewActionResult): void {
    this.send({ t: "webview_result", agentId, requestId, result });
  }

  prompt(agentId: AgentId, text: string, images?: string[]): void {
    const frame: ClientFrame =
      images && images.length > 0 ? { t: "prompt", agentId, text, images } : { t: "prompt", agentId, text };
    this.send(frame);
  }

  cancel(agentId: AgentId): void {
    this.send({ t: "cancel", agentId });
  }

  /**
   * Stream one chunk of the operator's speech: base64 16kHz mono PCM16, the
   * wire format the daemon's voice bridge decodes. One utterance is many
   * chunks followed by one `endAudio`, and the daemon answers the end with
   * a `transcript` frame, never a return value.
   *
   * Not remembered across a reconnect and not a visible loss when the socket
   * is down: an utterance is live audio rather than an instruction, and the
   * daemon drops its buffers with the socket they arrived on. The caller
   * that owns the microphone hears the disconnect and ends the utterance
   * itself.
   */
  sendAudio(agentId: AgentId, pcm: string): void {
    this.send({ t: "audio", agentId, pcm });
  }

  /**
   * Finish one utterance. The daemon transcribes what it buffered and sends
   * the text back as a `transcript` frame; the prompt it becomes is the
   * daemon's own authorization decision, not this method's.
   */
  endAudio(agentId: AgentId): void {
    this.send({ t: "audio_end", agentId });
  }

  decide(agentId: AgentId, requestId: string, choice: ApprovalChoice, scope?: ApprovalScope): void {
    const frame: ClientFrame =
      scope === undefined
        ? { t: "decide", agentId, requestId, choice }
        : { t: "decide", agentId, requestId, choice, scope };
    this.send(frame);
  }

  /** Join a room and automatically restore membership after a reconnect. */
  joinRoom(roomId: string): void {
    this.rooms.add(roomId);
    this.send({ t: "room_join", roomId });
  }

  leaveRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.send({ t: "room_leave", roomId });
  }

  /** Relay a WebRTC offer, answer, or ICE candidate to one room participant. */
  sendRoomSignal(signal: CollabSignalInput): void {
    this.send(signal);
  }

  /** Publish a finished push-to-talk note. Identity and order are daemon-owned. */
  sendCollabVoiceNote(note: Omit<CollabVoiceNoteInput, "t">): void {
    this.send({ t: "collab_voice_note", ...note });
  }

  decidePlan(agentId: AgentId, requestId: string, choice: PlanReviewChoice): void {
    this.send({ t: "plan_decide", agentId, requestId, choice });
  }

  /**
   * Ask for the session index. The answer arrives as the `sessions` event,
   * never a return value: on a phone behind a hub relay the request and the
   * answer both ride the sealed socket, because the hub tunnels exactly one
   * request shape today, a webhook fire, and no tunnel is wired for a
   * `GET /v1/sessions` to fall back on. Re-issued automatically
   * after a reconnect, like an attachment.
   */
  listSessions(query?: SessionQuery): void {
    this.askedSessions = true;
    this.sessionQuery = query;
    this.sendSessionsQuery();
  }

  /**
   * Ask the daemon to take a `live-tui` session over. `cwd` and `pid` must
   * be the row's own values as the index delivered them, because the daemon
   * verifies the echo and refuses a mismatch. The answer arrives as the
   * `session_opened` event, or an `error` naming the cause.
   *
   * One-shot, unlike `listSessions`: never re-issued after a reconnect, and
   * deliberately so. A takeover or resume that raced a drop either took (the
   * daemon answers on the next socket once the index shows it held, which
   * the idempotent answer covers) or did not (the operator retaps, which is
   * the only honest retry for an action with side effects this large).
   * Replaying it blind would take over a session the operator may have
   * decided, watching a spinner, not to hand over.
   */
  takeOverSession(sessionId: string, cwd: string, pid: number): void {
    this.send({ t: "session_takeover", sessionId, cwd, pid });
  }

  /**
   * Mint a credential for one new device over this socket -- the sealed road
   * a hub-relayed phone must take, because the hub carries no tunnel for the
   * two HTTP pairing routes, and wiring one would mean handing it this
   * device's bearer token to forward. The answer arrives
   * as the `device_invited` event, or an `error` naming the refusal.
   *
   * One-shot, like `takeOverSession`, for a reason that admits no replay at
   * all: a credential minted twice is two credentials. Resending after a
   * reconnect would mint a second token nobody has been shown, which is not
   * recovery, it is the leak one-shot semantics exist to prevent. If the
   * first attempt never landed, the operator presses Generate again.
   */
  inviteDevice(name: string, scopes: string[]): void {
    this.send({ t: "device_invite", name, scopes: [...scopes] });
  }

  /**
   * Ask the daemon to resume a dormant session. The same one-shot contract
   * as `takeOverSession`, and the same echo-and-verify rule for `cwd`.
   */
  resumeSession(sessionId: string, cwd: string): void {
    this.send({ t: "session_resume", sessionId, cwd });
  }

  /**
   * Delete sessions: their transcripts, and everything the daemon persists
   * about them. Irreversible, and requires manage scope. The answer arrives
   * as the `sessions_deleted` event, one result per id, which is where a
   * refusal (a live session, an unknown id) is reported.
   *
   * Takes a list because the daemon's frame does, and a caller with one
   * session passes one id. One-shot with a visible loss, like every other
   * instruction here, and never replayed: see `LOSS_IS_VISIBLE`.
   *
   * Copied rather than forwarded, matching `inviteDevice`: the caller's array
   * must not be able to change what this client is about to put on the wire.
   */
  deleteSessions(sessionIds: readonly string[]): void {
    this.send({ t: "session_delete", sessionIds: [...sessionIds] });
  }

  /**
   * Ask for one page of a session's transcript: the newest turns, or the
   * page older than `cursor` when an earlier answer handed one over. The
   * answer arrives as the `session_tail` event, or an `error` naming the
   * cause: `unknown_session` for an id this machine holds no file for.
   *
   * One-shot, deliberately unlike `listSessions`: a transcript page is a
   * snapshot of a screen the operator is looking at, so the surface that
   * wants one asks when it opens, and asks again when the operator reaches
   * for older turns. Replaying it on every reconnect would re-read a file
   * for a screen nobody may still be on, and the daemon's `tui_activity`
   * stream already carries what changed since.
   */
  sessionTail(sessionId: string, limit?: number, cursor?: number): void {
    const frame: ClientFrame = {
      t: "session_tail",
      sessionId,
      ...(limit === undefined ? {} : { limit }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    this.send(frame);
  }

  /** Read one structured page of a root or subagent's durable transcript. */
  sessionHistory(agentId: AgentId, sessionId: string, before?: number, limit?: number): void {
    this.send({
      t: "session_history",
      agentId,
      sessionId,
      ...(before === undefined ? {} : { before }),
      ...(limit === undefined ? {} : { limit }),
    });
  }

  /**
   * Ask what the daemon's two persisted settings hold. The answer arrives as
   * the `settings` event, or an `error` naming the refusal.
   *
   * One-shot, like `sessionTail` and for the same reason: a snapshot of a
   * screen the operator is looking at, asked when that screen opens, never
   * replayed onto a screen nobody may still be on.
   */
  readSettings(): void {
    this.send({ t: "settings_read" });
  }

  /**
   * Change both persisted settings. The answer arrives as the `settings`
   * event carrying what the daemon read back after applying, so a surface
   * renders the confirmed state rather than its own request; a scope or
   * validation refusal arrives as an `error` naming it.
   *
   * One-shot, like the other instructions: not replayed after a reconnect,
   * because an operator who retaps is informed and one who waits on a
   * replayed policy change is not.
   */
  writeSettings(settings: SyncSettings): void {
    this.send({ t: "settings_write", policyMode: settings.policyMode, keepAwake: settings.keepAwake });
  }

  /** Read routines and their recent per-action outcomes over the sealed socket. */
  readRoutines(): void {
    this.send({ t: "routines_read" });
  }

  /** Replace one routine definition. The daemon supplies local execution hosts. */
  writeRoutine(routine: RemoteRoutine): void {
    this.send({ t: "routine_write", routine });
  }

  /** Run one routine now. The completed per-action outcomes arrive as `routine_ran`. */
  runRoutine(routineId: string): void {
    this.send({ t: "routine_run", routineId });
  }

  /** Rotate a webhook secret. The plaintext arrives once as `routine_secret`. */
  rotateRoutineSecret(routineId: string): void {
    this.send({ t: "routine_secret_rotate", routineId });
  }

  /**
   * Delete routines for good. Per-id outcomes arrive as `routines_deleted`;
   * a refusal names itself, so a surface can say what to do next rather than
   * that it simply cannot.
   */
  deleteRoutines(routineIds: readonly string[]): void {
    this.send({ t: "routine_delete", routineIds: [...routineIds] });
  }

  /**
   * Ask what config options one agent's session holds, the mode among them.
   * The answer arrives as the `agent_config` event, or an `error` naming the
   * refusal: `unknown_agent` for an id this daemon holds no row for,
   * `no_session` for an agent with no live session behind it.
   *
   * One-shot, like `sessionTail` and for the same reason: a snapshot of a
   * screen the operator is looking at, asked when that screen opens, never
   * replayed onto a screen nobody may still be on.
   */
  readAgentConfig(agentId: AgentId): void {
    this.send({ t: "agent_config_read", agentId });
  }

  /**
   * Move one agent's session onto `modeId`. The answer arrives as the
   * `agent_config` event carrying what the daemon read back from the session,
   * so a surface renders the confirmed mode rather than its own request; a
   * scope, shape, or unknown-mode refusal arrives as an `error` naming it.
   *
   * One-shot, like the other instructions: not replayed after a reconnect,
   * because an operator who retaps is informed and one whose mode change is
   * silently replayed later is not.
   */
  writeAgentConfig(agentId: AgentId, modeId: string): void {
    this.send({ t: "agent_config_write", agentId, modeId });
  }

  /**
   * Prompt a session a registered live TUI owns. The daemon answers with a
   * `tui_unreachable` error when no connected TUI holds that session, so a
   * dormant row in the index is an explicit refusal, never a silent drop.
   */
  sessionPrompt(sessionId: string, text: string, deliverAs?: TuiSteerDelivery): void {
    const frame: ClientFrame =
      deliverAs === undefined
        ? { t: "session_prompt", sessionId, text }
        : { t: "session_prompt", sessionId, text, deliverAs };
    this.send(frame);
  }

  /**
   * Ask what is in one directory on the daemon's machine, or -- with no path
   * -- for the roots it will answer about at all. The answer arrives as the
   * `fs_listing` event.
   *
   * Never replayed after a reconnect, unlike `listSessions`. A listing is the
   * answer to a tap, not state this client holds: the directory on screen
   * does not go stale the way a live session index does, and a view that
   * wants a fresh one after a drop asks for it, which is the only honest way
   * to refresh something an operator may meanwhile have navigated away from.
   */
  listDirectory(path?: string): void {
    const frame: ClientFrame = path === undefined ? { t: "fs_list" } : { t: "fs_list", path };
    this.send(frame);
  }

  /**
   * Start a new session at `cwd`. The answer is the same `session_opened`
   * event a takeover or resume produces, so nothing downstream needs a second
   * case to open what this created.
   *
   * One-shot, for the reason `takeOverSession` is: replaying it after a
   * reconnect would start a second session at that directory, and the
   * operator would have asked for one.
   */
  createSession(cwd: string, name?: string): void {
    const frame: ClientFrame = name === undefined ? { t: "session_create", cwd } : { t: "session_create", cwd, name };
    this.send(frame);
  }

  /**
   * Clone `url` into a new directory under `parent`. Progress arrives as
   * `clone_progress` events and completion as `clone_done`; a refusal, a bad
   * url, or a failing git arrives as `error`.
   *
   * One-shot for the strongest version of the usual reason: a replayed clone
   * would meet its own half-finished directory and be refused, and the
   * operator would be reading a failure for work that actually succeeded.
   */
  cloneRepo(url: string, parent: string, name?: string): void {
    const frame: ClientFrame =
      name === undefined ? { t: "repo_clone", url, parent } : { t: "repo_clone", url, parent, name };
    this.send(frame);
  }

  // -- connection lifecycle -------------------------------------------------

  private openSocket(reason: string): void {
    this.clearTimers();
    this.generation += 1;
    const generation = this.generation;
    this.authenticated = false;
    this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting", { reason });

    let socket: SocketLike;
    try {
      socket = this.createSocket(this.socketUrl());
    } catch (cause) {
      this.emit("error", { message: `could not open socket: ${describe(cause)}`, code: "socket_open" });
      this.scheduleReconnect("socket construction failed");
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (generation !== this.generation) return;
      // Not "connected" yet. The link is only proven once the daemon has
      // authenticated us and said `hello`.
      this.startPingLoop();
    };
    socket.onmessage = message => {
      if (generation !== this.generation) return;
      this.handleRaw(message.data);
    };
    socket.onerror = info => {
      if (generation !== this.generation) return;
      // The report and the recovery are split on purpose: this says the link
      // is failing right now, and the close that follows drives the reconnect
      // so the two paths cannot both schedule one. Downstream, the notice this
      // becomes carries the tunnel's own reason when it has one, and it is
      // retired only by a later status of `connected`: a link that heals
      // leaves no stale error behind, and one that does not stays on screen.
      this.emit("error", { message: errorReason(info), code: "socket" });
    };
    socket.onclose = info => {
      if (generation !== this.generation) return;
      this.socket = null;
      this.clearTimers();
      if (!this.started) return;
      const cause = info.reason && info.reason.length > 0 ? info.reason : `closed (${info.code ?? "no code"})`;
      // A handshake the daemon refused and a cable someone pulled arrive here
      // identically: a client cannot read the status of a failed websocket
      // upgrade. So the reconnect is scheduled exactly as it always was, and
      // the question is asked alongside it. An outage answers "unknown" and
      // nothing changes; only a daemon that is up and says 401 stops the loop.
      if (!this.authenticated) {
        this.checkCredential("The daemon rejected this device's token.");
      }
      this.scheduleReconnect(cause);
    };
  }

  private scheduleReconnect(reason: string): void {
    if (!this.started) return;
    if (this.cancelReconnect) return;
    const delayMs = this.nextDelayMs();
    this.attempt += 1;
    const offline = !this.isOnline();
    this.setStatus(offline ? "offline" : "reconnecting", { delayMs, reason });
    this.cancelReconnect = this.schedule(() => {
      this.cancelReconnect = null;
      if (!this.started) return;
      this.openSocket("retry");
    }, delayMs);
  }

  /**
   * Backoff delay for the next attempt, guaranteed to differ from the delay
   * used for the previous one.
   *
   * Jitter exists so retries do not line up: not just across a fleet of
   * clients, but across successive attempts by one client hammering a daemon
   * that is coming back up. Two identical waits in a row are the exact
   * collision jitter is there to prevent, and they do happen once the delay is
   * pinned at the ceiling and only the jitter term varies. So when the formula
   * repeats itself, step one millisecond off it. That stays inside
   * `[0, maxMs]` by construction, because it only ever shortens the wait.
   */
  private nextDelayMs(): number {
    const proposed = computeBackoffDelay(this.attempt, this.backoff, this.random);
    if (proposed !== this.previousDelayMs) {
      this.previousDelayMs = proposed;
      return proposed;
    }
    // A zero proposal can only repeat when the ceiling itself is zero, and a
    // zero ceiling means "never wait", which has no second value to offer.
    const nudged = proposed > 0 ? proposed - 1 : Math.min(1, this.backoff.maxMs);
    this.previousDelayMs = nudged;
    return nudged;
  }

  private startPingLoop(): void {
    if (this.cancelPing) this.cancelPing();
    this.cancelPing = this.schedule(() => {
      this.cancelPing = null;
      if (!this.socket) return;
      this.send({ t: "ping" });
      this.armPongDeadline();
      this.startPingLoop();
    }, this.pingIntervalMs);
  }

  private armPongDeadline(): void {
    if (this.cancelPong) this.cancelPong();
    this.cancelPong = this.schedule(() => {
      this.cancelPong = null;
      // Silence is indistinguishable from a half-open socket, and a half-open
      // socket is the failure mode that loses a turn without anyone noticing.
      this.emit("error", { message: "no pong within deadline; link is dead", code: "timeout" });
      this.dropSocket("ping timeout");
    }, this.pongTimeoutMs);
  }

  private dropSocket(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    this.generation += 1;
    this.clearTimers();
    if (socket) socket.close(4000, reason);
    this.scheduleReconnect(reason);
  }

  /**
   * Ask the daemon whether this token is still a credential, and stop if it
   * is not.
   *
   * Fire and forget: nothing waits on the answer, so a reconnect already in
   * flight proceeds at its usual pace and an unreachable daemon costs one
   * failed request. Only a definite `rejected` changes anything.
   */
  private checkCredential(reason: string): void {
    if (this.probing || this.rejected || !this.started) return;
    this.probing = true;
    void this.probeCredential().then(
      verdict => {
        this.probing = false;
        if (verdict === "rejected") this.declareRejected(reason);
      },
      () => {
        // A probe that threw is a probe that learned nothing. Silence here is
        // correct: the reconnect loop is still running and will ask again.
        this.probing = false;
      },
    );
  }

  /**
   * Terminal. The token is gone, and retrying a credential the daemon has
   * withdrawn is the loop this exists to break: it never succeeds, and it
   * leaves an operator watching a spinner that means "re-pair".
   */
  private declareRejected(reason: string): void {
    if (this.rejected) return;
    this.rejected = true;
    this.started = false;
    if (this.cancelReconnect) {
      this.cancelReconnect();
      this.cancelReconnect = null;
    }
    this.clearTimers();
    this.generation += 1;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close(4001, "credential rejected");
    this.setStatus("offline", { reason });
    this.emit("unauthorized", { reason });
  }

  private clearTimers(): void {
    if (this.cancelPing) {
      this.cancelPing();
      this.cancelPing = null;
    }
    if (this.cancelPong) {
      this.cancelPong();
      this.cancelPong = null;
    }
  }

  // -- frames ---------------------------------------------------------------

  private socketUrl(): string {
    const separator = this.url.includes("?") ? "&" : "?";
    return `${this.url}${separator}token=${encodeURIComponent(this.token)}`;
  }

  private send(frame: ClientFrame): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      if (LOSS_IS_VISIBLE[frame.t]) {
        this.emit("error", { message: `not connected; "${frame.t}" was not sent`, code: "offline" });
      }
      return;
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch (cause) {
      this.emit("error", { message: `send failed: ${describe(cause)}`, code: "send" });
    }
  }

  private sendAttach(agentId: AgentId): void {
    const sinceSeq = this.watermarks.get(agentId);
    const frame: ClientFrame = sinceSeq === undefined ? { t: "attach", agentId } : { t: "attach", agentId, sinceSeq };
    this.send(frame);
  }

  private sendSessionsQuery(): void {
    const query = this.sessionQuery;
    this.send(query === undefined ? { t: "sessions" } : { t: "sessions", query });
  }

  private handleRaw(data: unknown): void {
    if (typeof data !== "string") {
      this.emit("error", { message: "binary frame ignored", code: "bad_frame" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.emit("error", { message: "unparseable frame ignored", code: "bad_frame" });
      return;
    }
    if (typeof parsed !== "object" || parsed === null || !("t" in parsed) || typeof parsed.t !== "string") {
      this.emit("error", { message: "frame without a type ignored", code: "bad_frame" });
      return;
    }
    // Narrowed above to an object carrying a string `t`. Which string it is
    // remains the switch's problem, and its default arm covers every value
    // this build does not recognise.
    const frame = parsed as ServerFrame;
    this.handleFrame(frame);
  }

  private handleFrame(frame: ServerFrame): void {
    switch (frame.t) {
      case "hello": {
        this.attempt = 0;
        this.authenticated = true;
        this.setStatus("connected", { reason: "hello" });
        // The whole point of the watermark. Every agent this client cares about
        // is reattached from exactly where its stream stopped.
        this.emit("agents", { agents: frame.agents, deviceId: frame.deviceId, scopes: frame.scopes });
        for (const agentId of this.attached) this.sendAttach(agentId);
        // After the attachments, never before: the daemon refuses a
        // registration for an agent this socket has not attached to yet.
        for (const agentId of this.webviews) this.send({ t: "webview_register", agentId });
        for (const roomId of this.rooms) this.send({ t: "room_join", roomId });
        // Last, like the rooms: the index is a snapshot asked for, not state
        // the daemon holds about this socket, so there is no ordering
        // constraint with the replays above -- only that a client which
        // asked before the drop is not left holding a stale list after it.
        if (this.askedSessions) this.sendSessionsQuery();
        return;
      }
      case "agents":
        this.emit("agents", { agents: frame.agents });
        return;
      case "sessions":
        this.emit("sessions", { sessions: frame.sessions });
        return;
      case "session_opened":
        this.emit("session_opened", { sessionId: frame.sessionId, agentId: frame.agentId });
        return;
      case "sessions_deleted":
        this.emit("sessions_deleted", { results: frame.results });
        return;
      case "device_invited":
        this.emit("device_invited", { token: frame.token, name: frame.name, scopes: frame.scopes });
        return;
      case "fs_listing":
        this.emit("fs_listing", {
          path: frame.path,
          parent: frame.parent,
          roots: frame.roots,
          entries: frame.entries,
          bounded: frame.bounded,
        });
        return;
      case "clone_progress":
        this.emit("clone_progress", { cloneId: frame.cloneId, line: frame.line });
        return;
      case "clone_done":
        this.emit("clone_done", { cloneId: frame.cloneId, path: frame.path });
        return;
      case "session_tail":
        this.emit("session_tail", {
          sessionId: frame.sessionId,
          messages: frame.messages,
          truncated: frame.truncated,
          // An older daemon sends neither cursor field. Absent `nextCursor`
          // has to read as "no older page reachable" rather than as zero,
          // which would be an offset a client could ask from.
          nextCursor: frame.nextCursor ?? null,
          ...(frame.cursor === undefined ? {} : { cursor: frame.cursor }),
        });
        return;
      case "session_history":
        this.emit("session_history", {
          agentId: frame.agentId,
          sessionId: frame.sessionId,
          entries: frame.entries,
          nextBefore: frame.nextBefore,
        });
        return;
      case "settings":
        this.emit("settings", {
          settings: { policyMode: frame.policyMode, keepAwake: frame.keepAwake },
        });
        return;
      case "routines":
        this.emit("routines", { routines: frame.routines, runs: frame.runs });
        return;
      case "routine_ran":
        this.emit("routine_ran", { run: frame.run });
        return;
      case "routine_secret":
        this.emit("routine_secret", { routineId: frame.routineId, secret: frame.secret });
        return;
      case "routines_deleted":
        this.emit("routines_deleted", { results: frame.results });
        return;
      case "agent_config":
        this.emit("agent_config", {
          agentId: frame.agentId,
          configOptions: frame.configOptions,
        });
        return;
      case "tui_activity":
        this.emit("tui_activity", {
          sessionId: frame.sessionId,
          kind: frame.kind,
          text: frame.text,
        });
        return;
      case "update":
        this.handleUpdate(frame.agentId, frame.seq, frame.update);
        return;
      case "approval":
        this.emit("approval", {
          agentId: frame.agentId,
          requestId: frame.requestId,
          title: frame.title,
          tool: frame.tool,
          input: frame.input,
        });
        return;
      case "room_participants":
        this.emit("room_participants", { roomId: frame.roomId, participants: frame.participants });
        return;
      case "room_offer":
      case "room_answer":
      case "ice_candidate":
        this.emit("room_signal", { signal: frame });
        return;
      case "collab_voice_note":
      case "collab_voice_mix":
        this.emit("collab_voice", { frame });
        return;
      case "collab_voice_history":
        this.emit("collab_voice_history", { roomId: frame.roomId, notes: frame.notes });
        return;
      case "plan_review":
        this.emit("plan_review", {
          agentId: frame.agentId,
          requestId: frame.requestId,
          message: frame.message,
          choices: frame.choices,
        });
        return;
      case "error":
        // An error frame is a message about a request, not a transport
        // failure. Tearing down the socket here would turn "that prompt was
        // rejected" into "you are disconnected".
        this.emit("error", { message: frame.message, code: frame.code, agentId: frame.agentId });
        // Except when the daemon has stopped recognising us at all, which
        // wears the same code as a scope refusal. Asking settles which it is
        // without guessing from the message text.
        if (frame.code !== undefined && AUTH_SUSPECT_CODES[frame.code]) {
          this.checkCredential(`The daemon rejected this device's token: ${frame.message}`);
        }
        return;
      case "pong":
        if (this.cancelPong) {
          this.cancelPong();
          this.cancelPong = null;
        }
        return;
      case "say":
        // The text path. A client with a local synthesizer speaks this and
        // never needs the PCM below. Dropping it into `default` is what made
        // the whole point of an on-device voice unreachable.
        this.emit("say", { agentId: frame.agentId, seq: frame.seq, text: frame.text });
        return;
      case "speech":
        // Emitted, not dropped. The daemon speaks only to a device that spoke
        // first, so a frame arriving here was asked for, and swallowing it is
        // what made "bi-directional voice" one-directional.
        this.emit("speech", { agentId: frame.agentId, pcm: frame.pcm });
        return;
      case "transcript":
        this.emit("transcript", {
          agentId: frame.agentId,
          text: frame.text,
          final: frame.final,
        });
        return;
      case "webview_action":
        this.emit("webview_action", {
          agentId: frame.agentId,
          requestId: frame.requestId,
          action: frame.action,
        });
        return;
      default:
        // A newer daemon may speak frames this build has never heard of.
        // Ignoring them is the only forward-compatible answer.
        return;
    }
  }

  private handleUpdate(agentId: AgentId, seq: number, update: unknown): void {
    const previous = this.watermarks.get(agentId);
    if (previous !== undefined && seq <= previous) {
      // Replay overlap after a reconnect. Dropping it here is what makes
      // resume idempotent.
      return;
    }
    if (previous !== undefined && seq > previous + 1) {
      this.emit("error", {
        agentId,
        code: "seq_gap",
        message: `missed updates ${previous + 1}..${seq - 1}`,
      });
    }
    this.watermarks.set(agentId, seq);
    this.emit("update", { agentId, seq, update });
  }

  // -- emitter --------------------------------------------------------------

  private setStatus(state: ConnectionState, extra: { delayMs?: number; reason?: string }): void {
    this.state = state;
    this.emit("status", { state, attempt: this.attempt, ...extra });
  }

  private emit<K extends ClientEventName>(name: K, event: ClientEventMap[K]): void {
    const set = this.listeners.get(name);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      // The listener map is heterogeneous by construction; `on` and `emit` are
      // the only two places that know each key's payload type, and they agree.
      const typed = listener as unknown as Listener<K>;
      try {
        typed(event);
      } catch (cause) {
        // A broken view must not take the connection down with it.
        console.error(`ompd: "${name}" listener threw`, cause);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function scheduleWithTimeout(fn: () => void, ms: number): Cancel {
  const handle = setTimeout(fn, ms);
  return () => {
    clearTimeout(handle);
  };
}

/**
 * Optimistic by design. Browsers report connectivity on `navigator.onLine`;
 * a plain Node/Bun process has no such property, and its absence has to mean
 * "assume reachable", because the failure mode of guessing offline is a
 * client that stops trying.
 *
 * A host that wants the real answer injects `isOnline` instead.
 */
function readNavigatorOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // Bun's ambient `navigator` type has no DOM lib behind it, so `onLine` is
  // not a known property here even though every real host that defines
  // `navigator` at all (browsers, React Native) does define it.
  const withOnline = navigator as unknown as { onLine?: boolean };
  return withOnline.onLine !== false;
}

/** `WebSocket` as every target spells it: browsers, Bun, and React Native's own. */
function createPlatformSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const adapter: SocketLike = {
    get readyState(): number {
      return ws.readyState;
    },
    send(data: string): void {
      ws.send(data);
    },
    close(code?: number, reason?: string): void {
      ws.close(code, reason);
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  ws.onopen = () => adapter.onopen?.();
  ws.onclose = event => adapter.onclose?.({ code: event.code, reason: event.reason });
  ws.onerror = event => adapter.onerror?.(event);
  ws.onmessage = event => adapter.onmessage?.({ data: event.data });
  return adapter;
}

/**
 * Ask the daemon directly whether a token is still a credential.
 *
 * This exists because a client cannot see the status of a websocket upgrade
 * the server refused: a 401 at the handshake and a pulled cable both arrive as
 * an anonymous close, and treating either as the other is a bug in one
 * direction or the other. One authenticated HTTP request separates them, and
 * it is the only thing that can.
 *
 * A 403 counts as valid. The daemon authenticated the token and then declined
 * the scope, which is a live credential answering.
 */
function createCredentialProbe(socketUrl: string, token: string): CredentialProbe {
  return async () => {
    const endpoint = agentsEndpoint(socketUrl);
    if (endpoint === null) return "unknown";
    try {
      const response = await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
      return response.status === 401 ? "rejected" : "valid";
    } catch {
      // Unreachable, blocked, or offline. Says nothing about the token.
      return "unknown";
    }
  };
}

/**
 * `ws://host/v1/socket?x=1#y` becomes `http://host/v1/agents`, on any platform.
 *
 * Exported for the test that pins the mapping. Null means the address was not
 * a websocket URL this client could have connected to in the first place.
 */
export function agentsEndpoint(socketUrl: string): string | null {
  const match = /^(wss?|https?):\/\/([^/?#]+)/.exec(socketUrl);
  if (match === null) return null;
  const [, scheme, authority] = match;
  if (scheme === undefined || authority === undefined || authority.length === 0) return null;
  const secure = scheme === "wss" || scheme === "https";
  return `${secure ? "https" : "http"}://${authority}/v1/agents`;
}

/**
 * What an `onerror` actually carries. The tunnel reports its failures as
 * `{ message }` with a reason worth reading (a relay sequence gap, a refused
 * handshake); a bare platform websocket reports an `Event` with nothing on
 * it. Both must fit one notice, so the reason is the tunnel's message when
 * there is one and the transport's name otherwise.
 */
function errorReason(info: unknown): string {
  if (typeof info === "object" && info !== null && "message" in info) {
    const message = (info as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "websocket error";
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
