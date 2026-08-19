/**
 * Canonical contracts for ompd.
 *
 * This file is the authority. `docs/architecture.md` describes it in prose; if
 * the two ever disagree, this wins. Every slice builds against these types so
 * they can be developed concurrently without negotiating shapes.
 */

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentId = string; // "agt_" + 16 hex

export type AgentState =
  | "provisioning" // host being acquired
  | "starting" // host up, session not yet created
  | "idle" // ready, no turn in flight
  | "busy" // turn streaming
  | "waiting" // blocked on an approval decision
  | "stopped" // clean exit, transcript retained
  | "failed"; // crashed or provisioning failed

/** States from which no further work can proceed without operator action. */
export const TERMINAL_AGENT_STATES: readonly AgentState[] = ["stopped", "failed"];

export interface AgentMetrics {
  /** Total tokens consumed by this agent, including completed child turns. */
  usedTokens: number;
  /** Provider-reported cost in the account's base currency, when available. */
  costAmount?: number;
  /** Wall-clock runtime, measured from the agent's registration. */
  durationMs: number;
}

export interface Agent {
  id: AgentId;
  name: string;
  state: AgentState;
  /** OMP-side ACP session id. Absent until the session is created. */
  acpSessionId?: string;
  host: HostRef;
  cwd: string;
  createdAt: string;
  lastActiveAt: string;
  /** Set when this agent was spawned by a routine rather than a human. */
  routineId?: string;
  /** Parent agent registry id when this is an OMP subagent. */
  parentAgentId?: string;
  /** The assignment passed to a subagent, independent of its display name. */
  taskTitle?: string;
  /** Resolved provider/model identity reported by OMP. */
  model?: string;
  /** Live or terminal usage accumulated by the agent. */
  metrics?: AgentMetrics;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Federation queued intents
// ---------------------------------------------------------------------------

/**
 * A write accepted by a replica but reserved for the daemon that owns the
 * session. The replica may persist and relay it; only the delegate executes it.
 */
export type QueuedIntentAction = "prompt" | "decide" | "cancel" | "new-agent";
export type QueuedIntentStatus = "pending" | "claimed" | "delivered";

export interface QueuedIntent {
  seq?: number;
  id: string;
  /**
   * The owned agent. For `new-agent`, this is reserved by the replica before
   * it queues the request so the delegate creates the same identity.
   */
  agentId: AgentId;
  /** The paired device that the replica already authorized. */
  actorDeviceId: string;
  action: QueuedIntentAction;
  /** Action-specific, wire-safe input; narrowed again by the delegate. */
  payload: unknown;
  createdAt: string;
  status: QueuedIntentStatus;
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------

export type HostKind = "local" | "container" | "cloud";

export interface HostSpec {
  kind: HostKind;
  image?: string;
  repo?: string;
  ref?: string;
  /** JIT hosts self-destruct after this long idle. Omit for no expiry. */
  ttlSeconds?: number;
  /**
   * Extra host directories a container host can see, beyond the workspace.
   * Each lands at the identical absolute path inside, the same property that
   * makes the workspace mount work: a path named in a transcript means the
   * same thing on both sides of the boundary.
   */
  mounts?: HostMount[];
}

export interface HostMount {
  /** Absolute host path. Relative paths are refused: there is no cwd to resolve them against on the far side. */
  hostPath: string;
  /**
   * "ro" is the default. A folder the agent should merely see does not need
   * write access, and a writable mount is a deliberate act an operator opts
   * into per path rather than something that falls out of naming a folder.
   */
  mode?: "ro" | "rw";
}

export interface HostRef {
  kind: HostKind;
  /** pid for local, container id for container, machine id for cloud. */
  id: string;
  spec: HostSpec;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export type ApprovalChoice = "allow" | "deny";
export type ApprovalScope = "once" | "always";

/**
 * The only choices OMP offers when it asks an operator to review a plan.
 *
 * These strings are protocol values, not display copy: the answer goes back
 * through ACP's enum-shaped elicitation response.
 */
export type PlanReviewChoice = "Approve and execute" | "Refine plan";

/** A plan awaiting an operator's answer. It is transient, like an ACP turn. */
export interface PlanReviewRequest {
  requestId: string;
  agentId: AgentId;
  message: string;
  choices: readonly PlanReviewChoice[];
}

/**
 * ACP option ids, as advertised by `session/request_permission`. The supervisor
 * maps a PolicyDecision onto one of these; nothing else may.
 */
export type AcpOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface ApprovalRequest {
  requestId: string;
  agentId: AgentId;
  tool: string;
  input: unknown;
  /** Human-readable one-liner supplied by ACP, e.g. the shell command. */
  title: string;
  createdAt: string;
}

export interface ApprovalRecord extends ApprovalRequest {
  decision: ApprovalChoice;
  scope: ApprovalScope;
  /** Which rule decided. "operator" when a human broke a `prompt` tie. */
  rule: string;
  actorDeviceId: string | null;
  decidedAt: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface Actor {
  deviceId: string;
  scopes: string[];
}

export interface PolicyContext {
  agent: Agent;
  tool: string;
  input: unknown;
  actor: Actor;
}

export interface PolicyDecision {
  action: "allow" | "deny" | "prompt";
  reason: string;
  rule?: string;
}

export interface Policy {
  /** Pure and total: must never throw and never perform I/O. */
  evaluate(ctx: PolicyContext): PolicyDecision;
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export type TriggerSpec =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; seconds: number }
  | { kind: "manual" }
  | { kind: "webhook"; secretRef: string };

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  /** Prompt delivered to a fresh agent on each run. */
  prompt: string;
  cwd: string;
  host: HostSpec;
  /** Skip a run if the previous one is still going. */
  singleton: boolean;
  /** Kill a run that exceeds this. */
  timeoutSeconds?: number;
  labels: Record<string, string>;
  createdAt: string;
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out";

export interface Run {
  id: string;
  routineId: string;
  agentId?: AgentId;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  /** Final assistant text, truncated for listing. */
  summary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export interface Device {
  id: string;
  name: string;
  publicKey: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** Scope required to break a `prompt` tie on a tool approval. */
export const SCOPE_APPROVE = "approve";
/** Scope required to create or destroy agents. */
export const SCOPE_MANAGE = "manage";
/** Scope required to read transcripts. */
export const SCOPE_READ = "read";
/** Scope required to send prompts. */
export const SCOPE_PROMPT = "prompt";

/**
 * Loopback port the daemon binds when config says nothing.
 *
 * Lives here because two very different things need the same number and got it
 * wrong: the daemon defaulted to 7777 while the client suggested 7717, so a
 * first pairing failed for a reason neither side could report. A client cannot
 * import the daemon to ask, since that pulls `bun:sqlite` into a phone bundle,
 * so the contract owns it and both read it from here.
 */
export const DEFAULT_DAEMON_PORT = 7777;

// ---------------------------------------------------------------------------
// Agent-driveable WebView
//
// A capability, not a device. iOS, Android, macOS and Windows can each host
// `react-native-webview` and drive it from inside the app process; the
// laptop's own `browser`/`computer` OMP tools reach the user's real Chrome
// through the OMP browser relay instead, because there is no in-app browser
// to embed on a desktop that already has one. The web build has neither: a
// browser tab cannot honestly host a driveable browser inside itself, so
// `WebViewCapability` is `null` there at the type level, never a runtime
// throw. See `docs/browser.md` for the full contract and per-platform
// verified/gap matrix, and `app/src/browser/` for the implementation.
// ---------------------------------------------------------------------------

/** Whether the host app has verified this capability actually works, per platform. */
export type WebViewSupport = "verified" | "unverified" | "unavailable";

export type AppPlatform = "ios" | "android" | "macos" | "windows" | "web";

/** One row of the capability matrix; see `docs/browser.md` for how each was decided. */
export interface WebViewPlatformStatus {
  platform: AppPlatform;
  support: WebViewSupport;
  /** Why, when the answer is not "it works": what was tried, what broke, what was never scaffolded. */
  note: string;
}

/**
 * A node in the structural read. `text` and `attributes` are exactly what the
 * page said and are never anything but data -- see "Page content can only
 * ever become data" in `docs/browser.md`.
 */
export interface WebViewNode {
  tag: string;
  role?: string;
  /** Minted by the native side, never by the page. Valid until the next `observe` or a navigation. */
  ref: string;
  text?: string;
  attributes?: Record<string, string>;
  children?: WebViewNode[];
}

export interface WebViewObservation {
  url: string;
  title: string;
  tree: WebViewNode;
  /** True when the page was still loading at capture time; the tree may be partial. */
  settled: boolean;
}

/**
 * The five actions, chosen to mirror the relay's own vocabulary (navigate,
 * observe, click, type, screenshot) so driving a phone is not a second
 * language for a model that has already driven the relay.
 */
export type WebViewAction =
  | { kind: "navigate"; url: string }
  | { kind: "observe" }
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string; replace?: boolean }
  | { kind: "screenshot" };

/**
 * There is deliberately no variant here that represents "the page asked for
 * something." Only the native bridge produces this type, from its own
 * nonce-matched response to a request it issued -- never from unmediated page
 * content. See `app/src/browser/bridge.ts`.
 */
export type WebViewActionResult =
  | { kind: "observe"; observation: WebViewObservation }
  | { kind: "screenshot"; pngBase64: string }
  | { kind: "ack"; url: string; title: string }
  | { kind: "error"; message: string };

// ---------------------------------------------------------------------------
// Collaboration voice
// ---------------------------------------------------------------------------

/**
 * A speaker in a collaboration room.
 *
 * The daemon derives human identities from the authenticated socket and names
 * agent identities itself. A client-supplied frame never gets to choose one.
 */
export interface CollabVoiceParticipant {
  id: string;
  kind: "human" | "agent";
  displayName?: string;
}

/** Format shared by every track in a mixed frame. */
export interface CollabAudioFormat {
  encoding: "pcm_s16le";
  sampleRateHz: number;
  channels: 1 | 2;
}

/** One aligned participant track in a multi-party audio mix. */
export interface CollabVoiceTrack {
  participant: CollabVoiceParticipant;
  /** Base64 little-endian signed PCM. The enclosing mix supplies its format. */
  pcm: string;
}

/**
 * A finished push-to-talk note before the daemon authenticates and sequences
 * it. Clients provide audio only; the daemon owns author identity and order.
 */
export interface CollabVoiceNoteInput {
  t: "collab_voice_note";
  roomId: string;
  noteId: string;
  audio: CollabAudioFormat & { pcm: string };
  durationMs?: number;
}

/** An authenticated, room-sequenced audio note suitable for replay and playback. */
export interface CollabVoiceNoteFrame extends CollabVoiceNoteInput {
  participant: CollabVoiceParticipant;
  /** Monotonic within `roomId`, allocated atomically before any broadcast. */
  sequence: number;
  createdAt: string;
}

/**
 * An aligned group of simultaneous tracks. This is for a live mixer, not the
 * voice-note player, which deliberately plays finished notes one at a time.
 */
export interface CollabVoiceMixFrame {
  t: "collab_voice_mix";
  roomId: string;
  mixId: string;
  sequence: number;
  createdAt: string;
  format: CollabAudioFormat;
  tracks: readonly [CollabVoiceTrack, ...CollabVoiceTrack[]];
}

export type CollabVoiceFrame = CollabVoiceNoteFrame | CollabVoiceMixFrame;

/** Stored for transcript replay. Deliberately excludes raw audio bytes. */
export interface CollabVoiceNoteMetadata {
  roomId: string;
  sequence: number;
  noteId: string;
  participant: CollabVoiceParticipant;
  createdAt: string;
  durationMs?: number;
  format: CollabAudioFormat;
}

/**
 * WebRTC signaling sent by an authenticated participant. `targetParticipantId`
 * is resolved only among members of the same room.
 */
export type CollabSignalInput =
  | { t: "room_offer"; roomId: string; targetParticipantId: string; sdp: string }
  | { t: "room_answer"; roomId: string; targetParticipantId: string; sdp: string }
  | {
      t: "ice_candidate";
      roomId: string;
      targetParticipantId: string;
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
    };

/** Signaling the daemon has authenticated and routed to the intended room peer. */
export type CollabSignalFrame =
  | { t: "room_offer"; roomId: string; from: CollabVoiceParticipant; sdp: string }
  | { t: "room_answer"; roomId: string; from: CollabVoiceParticipant; sdp: string }
  | {
      t: "ice_candidate";
      roomId: string;
      from: CollabVoiceParticipant;
      candidate: string;
      sdpMid?: string;
      sdpMLineIndex?: number;
    };

export type CollabClientFrame =
  | { t: "room_join"; roomId: string }
  | { t: "room_leave"; roomId: string }
  | CollabSignalInput
  | CollabVoiceNoteInput;

export type CollabServerFrame =
  | { t: "room_participants"; roomId: string; participants: CollabVoiceParticipant[] }
  | CollabSignalFrame
  | CollabVoiceFrame
  /** Finished notes replay with their durable audio payload; app-side de-duplication prevents re-speaking live notes. */
  | { t: "collab_voice_history"; roomId: string; notes: CollabVoiceNoteFrame[] };

/**
 * How a steered turn lands in the live session. These are omp's own
 * `sendUserMessage` modes, verbatim and exhaustively: an omitted or `steer`
 * delivery takes the turn when the session is idle and interrupts it when one
 * is streaming, and `followUp` waits for the running turn to finish.
 *
 * There is deliberately no `nextTurn` here, though `pi.sendMessage` has one.
 * The prompt flow a steer goes through has no such mode, so offering it on the
 * wire would mean either refusing it at the extension after the daemon had
 * accepted it, or silently downgrading someone's stated intent. The daemon
 * refuses it as a `bad_frame` instead, at the only place that can say so.
 */
export type TuiSteerDelivery = "steer" | "followUp";

/** What a live terminal session reports back as a turn progresses. */
export type TuiActivityKind = "assistant_text" | "turn_start" | "turn_end";

/**
 * One turn of a session's transcript, as a tail reader recovered it from the
 * session file.
 *
 * Text, never blocks. A message's content in a session file is an array of
 * blocks (or, for some typed user turns, a bare string), and only a `text`
 * block is words: a `toolCall` is the agent reaching for a tool and a
 * `thinking` block is not what it said. So the daemon flattens a turn to the
 * words it actually spoke and drops a turn that spoke none, rather than
 * shipping a block union a client would have to re-learn this lesson to
 * render. `at` is the line's own ISO timestamp, or "" for a file that carried
 * none.
 */
export interface TranscriptTailMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Client wire protocol
// ---------------------------------------------------------------------------

export type ClientFrame =
  | { t: "attach"; agentId: AgentId; sinceSeq?: number }
  | { t: "detach"; agentId: AgentId }
  | { t: "prompt"; agentId: AgentId; text: string; images?: string[] }
  | { t: "cancel"; agentId: AgentId }
  | { t: "decide"; agentId: AgentId; requestId: string; choice: ApprovalChoice; scope?: ApprovalScope }
  | { t: "plan_decide"; agentId: AgentId; requestId: string; choice: PlanReviewChoice }
  | { t: "audio"; agentId: AgentId; pcm: string } // base64 16k mono PCM16
  | { t: "audio_end"; agentId: AgentId }
  /** Offer this socket's mounted WebView as the active target for an agent. */
  | { t: "webview_register"; agentId: AgentId }
  /** Withdraw this socket's WebView without detaching from the agent session. */
  | { t: "webview_unregister"; agentId: AgentId }
  /** The outcome of a `webview_action` this client's WebView was asked to perform. */
  | { t: "webview_result"; agentId: AgentId; requestId: string; result: WebViewActionResult }
  | CollabClientFrame
  /** A normal TUI offers its already-open session for a managed takeover. */
  | { t: "tui_register"; sessionId: string; cwd: string; title?: string; pid: number }
  /** ACP JSON-RPC carried over the registered TUI's single control socket. */
  | { t: "tui_acp"; sessionId: string; raw: string }
  /** The TUI has stopped rendering and its in-process ACP server is ready. */
  | { t: "tui_acp_ready"; sessionId: string }
  /**
   * Prompt a session a registered live TUI owns, without the takeover dance:
   * the daemon routes the text to that TUI as a `tui_steer`. `deliverAs`
   * defaults to `steer` server-side, matching omp's own `sendMessage` default.
   */
  | { t: "session_prompt"; sessionId: string; text: string; deliverAs?: TuiSteerDelivery }
  /** A registered live TUI reporting turn progress back to the daemon. */
  | { t: "tui_activity"; sessionId: string; kind: TuiActivityKind; text?: string }
  /**
   * Ask for the session index over this socket. A hub-relayed phone cannot
   * reach the daemon's HTTP surface at all -- the relay carries sealed
   * websocket frames only, never daemon HTTP paths -- so for that client
   * this frame is not a convenience beside `GET /v1/sessions`; it is the
   * only road the index can take.
   */
  | { t: "sessions"; query?: SessionQuery }
  /**
   * Take over a `live-tui` session through this socket. The hub relay
   * carries one sealed websocket and proxies no daemon HTTP, so `POST
   * /v1/sessions/:id/takeover` is a road a relayed phone cannot take; this
   * frame is the only one it can. `cwd` and `pid` are the index row's own
   * values echoed back, and the daemon verifies them against its index
   * rather than trusting them: a stale row on the phone must refuse naming
   * the mismatch, never open a different session than the one was tapped.
   */
  | { t: "session_takeover"; sessionId: string; cwd: string; pid: number }
  /**
   * Resume a dormant session under a daemon-owned agent. The same relay
   * constraint as `session_takeover`, and the same echo-and-verify rule for
   * `cwd`: `session/load` resolves the session file under the directory it
   * is handed, so an unverified cwd would silently aim the daemon's second
   * writer at the wrong tree -- the exact corruption a refusal exists to
   * prevent.
   */
  | { t: "session_resume"; sessionId: string; cwd: string }
  /**
   * Mint a new device's credential over this socket, in one authenticated
   * request. The two HTTP steps this replaces -- an unauthenticated
   * `POST /v1/pair` that records an intent, then an approve-scoped
   * `POST /v1/pairings/approve` that spends it -- are internal detail to a
   * caller that is already authenticated, and a hub relay carries frames
   * only, never daemon HTTP, so neither step can ride one. Requires
   * `approve`, and may not grant a scope the asking device does not hold.
   */
  | { t: "device_invite"; name: string; scopes: string[] }
  | RemoteStartClientFrame
  /**
   * The tail of a session's transcript, read straight from its file.
   *
   * Read scope, not manage: this is reading a transcript, which a read-only
   * device is already entitled to for its own agents, and it changes nothing
   * about the session. `limit` asks for at most that many of the most recent
   * turns; the daemon defaults it and caps it, so a client cannot ask for a
   * whole 10MB transcript in one frame.
   *
   * A live terminal session has no agent row, so `attach` and its `update`
   * stream cannot reach it. Without this frame, tapping a session with a
   * thousand messages in it shows a composer and nothing else.
   */
  | { t: "session_tail"; sessionId: string; limit?: number }
  | { t: "ping" };

export type ServerFrame =
  /**
   * The daemon's own record of what this socket's device may do, read from
   * the same place every authorization decision on that socket reads. A
   * client must prefer this over anything it was told at pairing time: a
   * stored hint can be stale (a rotated or narrowed grant) while the
   * daemon's answer never is. Optional only because an older daemon does
   * not report it, and absence means "unknown", never "no scopes".
   */
  | { t: "hello"; deviceId: string; agents: Agent[]; scopes?: string[] }
  | { t: "agents"; agents: Agent[] }
  | { t: "update"; agentId: AgentId; seq: number; update: unknown }
  | { t: "approval"; agentId: AgentId; requestId: string; title: string; tool: string; input: unknown }
  | { t: "plan_review"; agentId: AgentId; requestId: string; message: string; choices: readonly PlanReviewChoice[] }
  /**
   * The speakable form of a turn's answer, as prose.
   *
   * Separate from `speech` because a client that owns its own voice should
   * never receive audio it has to know to ignore, and separate from
   * `transcript` because that one carries the operator's speech in the other
   * direction.
   *
   * A rendering hint and nothing more. Receiving one must never cause a client
   * to act, approve, or change state, and a client that branches on the
   * content of one has a bug. `seq` is the highest update this summary derives
   * from, so a client can tell which turn is speaking and refuse to say the
   * same one twice after a reconnect. The text is already sanitised and capped
   * by the daemon; there is no client-sent counterpart, because a client that
   * could ask for a `say` could make another device speak arbitrary words.
   */
  | { t: "say"; agentId: AgentId; seq: number; text: string }
  /** Synthesized audio, for a client with no voice of its own. */
  | { t: "speech"; agentId: AgentId; pcm: string }
  | { t: "transcript"; agentId: AgentId; text: string; final: boolean }
  | { t: "error"; agentId?: AgentId; message: string; code?: string }
  /** Ask a client's embedded WebView to perform an action, already cleared by the policy engine. */
  | { t: "webview_action"; agentId: AgentId; requestId: string; action: WebViewAction }
  | CollabServerFrame
  /** Command a registered normal TUI to release its renderer for ACP takeover. */
  | { t: "tui_takeover"; sessionId: string }
  /** ACP JSON-RPC carried over the registered TUI's single control socket. */
  | { t: "tui_acp"; sessionId: string; raw: string }
  /**
   * Deliver a message into a session a registered live TUI owns. The daemon
   * sends this only in answer to a prompt-scoped `session_prompt`, and only to
   * the socket that registered the session.
   */
  | { t: "tui_steer"; sessionId: string; text: string; deliverAs: TuiSteerDelivery }
  /**
   * Turn progress from a registered live TUI, forwarded by the daemon to
   * clients that asked for the session index. Keyed by session id, not agent
   * id: a live terminal session has no agent row.
   */
  | { t: "tui_activity"; sessionId: string; kind: TuiActivityKind; text?: string }
  /**
   * The session index answering a `sessions` client frame, sent only to the
   * socket that asked. Carried on the sealed socket for the same reason the
   * request is: this is the one copy of the index a relayed phone can ever
   * reach, so it rides the same leg the rest of the phone's traffic does.
   */
  | { t: "sessions"; sessions: SessionSummary[] }
  /**
   * A `session_takeover` or `session_resume` succeeded -- or was already
   * true: a session the daemon's index reports as held by an agent answers
   * with that agent's id rather than an error, because the caller's intent
   * is already satisfied and a second holder would put two writers on one
   * session file, the exact corruption the takeover path exists to prevent.
   * Sent only to the socket that asked.
   */
  | { t: "session_opened"; sessionId: string; agentId: AgentId }
  /**
   * The answer to a `device_invite`: the one-time view of a credential just
   * minted, sent only to the socket that asked. Never broadcast, never
   * replayed after a reconnect -- a credential delivered twice is a second
   * credential in the wild that no operator asked for and no screen showed.
   */
  | { t: "device_invited"; token: string; name: string; scopes: string[] }
  | RemoteStartServerFrame
  /**
   * The transcript tail answering a `session_tail` frame, sent only to the
   * socket that asked. Oldest first, so a client appends live activity below
   * it without reordering. `truncated` says the tail is not the whole
   * transcript: either an older turn exists past the ones returned, or the
   * reader stopped at its byte budget with unread bytes behind it.
   */
  | { t: "session_tail"; sessionId: string; messages: TranscriptTailMessage[]; truncated: boolean }
  | { t: "pong" };

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  | "agent.create"
  | "agent.stop"
  | "agent.prompt"
  /**
   * A device took a turn in a session a live TUI owns, or was refused.
   *
   * Its own action rather than `agent.prompt` because it cannot borrow that
   * shape: `agent.prompt` names an `agentId` this daemon spawned and holds a
   * row for, while this names a session id owned by a foreign OMP process the
   * daemon only has a socket to. The detail carries the session, the delivery
   * mode, and the refusal reason, and never the prompt text: the text is the
   * operator's content, and an audit log is not a transcript.
   */
  | "session.prompt"
  | "approval.decide"
  | "device.pair"
  | "device.revoke"
  /** A daemon registered an outbound tunnel leg with a hub, or was refused. */
  | "tunnel.register"
  /** A client opened a tunnel session to this daemon, or was refused. */
  | "tunnel.attach"
  | "routine.create"
  | "routine.run"
  | "proposal.submit"
  | "proposal.promote"
  | "proposal.reject"
  | "host.provision"
  | "host.destroy"
  /**
   * A device asked what is in one of the operator's directories, or was
   * refused. Recorded on every exit, refusals included: reading someone's
   * filesystem from a phone is a privileged act, and a log that kept only
   * the successes would omit exactly the attempts worth reviewing.
   */
  | "fs.list"
  /** A device started a session at a directory it chose, or was refused. */
  | "session.create"
  /**
   * A device cloned a repository onto this machine, or was refused. `detail`
   * carries the url and the destination; a url carrying a credential is
   * refused before this record is written, so one can never be logged.
   */
  | "repo.clone";

export interface AuditEntry {
  id: number;
  ts: string;
  action: AuditAction;
  actorDeviceId: string | null;
  agentId?: AgentId;
  /** Structured detail. Must never contain credentials. */
  detail: Record<string, unknown>;
  outcome: "ok" | "denied" | "error";
}

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

/**
 * Paths the evolution engine may never modify. A proposal touching any of these
 * is archived at submission time rather than queued for review, because a loop
 * that can edit its own gate has no gate.
 *
 * Matched as path prefixes against repo-relative POSIX paths.
 */
export const PROTECTED_PATHS: readonly string[] = [
  "packages/core/src/policy.ts",
  "packages/core/src/audit.ts",
  "packages/core/src/contracts.ts",
  "packages/daemon/src/auth/",
  "packages/daemon/src/provisioner/",
  "packages/daemon/src/evolution/gate.ts",
  ".github/workflows/",
  "mise.toml",
];

export type ProposalState =
  | "submitted"
  | "archived" // touched a protected path
  | "evaluating"
  | "rejected" // failed evaluation
  | "awaiting_review" // passed evaluation, needs an operator
  | "canary"
  | "promoted"
  | "rolled_back";

export interface Proposal {
  id: string;
  title: string;
  rationale: string;
  /** Unified diff. Never applied to the running tree. */
  diff: string;
  touchedPaths: string[];
  state: ProposalState;
  verdict?: { passed: boolean; log: string };
  createdAt: string;
  promotedCommit?: string;
}

export function isProtectedPath(p: string): boolean {
  const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
  return PROTECTED_PATHS.some(prefix => (prefix.endsWith("/") ? norm.startsWith(prefix) : norm === prefix));
}

// ---------------------------------------------------------------------------
// Workspace: skills and connectors
//
// The daemon does not implement discovery itself -- it calls upstream's own
// `discoverSkills`, `discoverSlashCommands`, and `discoverMCPServers` and
// reshapes the result. These types are that reshaped, wire-safe view: never a
// place for a connector's raw config, which routinely carries tokens and
// headers a client must never receive.
// ---------------------------------------------------------------------------

/** Where upstream resolved a skill or connector's configuration from. */
export type WorkspaceSourceLevel = "user" | "project" | "native";

/**
 * A skill (`SKILL.md`, auto-invoked by description match) and a slash command
 * (an explicit `/name` template) are different upstream mechanisms, but both
 * are "reusable workflows invoked as /name" from a user's point of view, so
 * they share one catalogue here. `kind` tells them apart for a client that
 * cares.
 */
export type SkillKind = "skill" | "command";

export interface SkillSummary {
  /** Invocation name, without a leading "/". */
  name: string;
  description: string;
  kind: SkillKind;
  /** Upstream's raw provenance string, e.g. "claude-plugins:project". */
  source: string;
  /** Upstream's display name for the loader that found it, e.g. "Claude Code Marketplace". */
  providerName?: string;
  level?: WorkspaceSourceLevel;
  /**
   * The specific plugin that owns this skill, when its source path names one
   * (a marketplace cache entry or an installed plugin root). `providerName`
   * names the *loading mechanism*; this names the *plugin*, which is what a
   * user with dozens of plugins actually wants grouped by. Absent when the
   * skill has no plugin -- a bare project- or user-level skill file -- which
   * is the honest answer for those, not a guess.
   */
  pluginName?: string;
}

export type ConnectorStatus = "connected" | "connecting" | "disconnected";

/**
 * A connector's identity and health. Never its config: config carries tokens,
 * headers, and OAuth client secrets, and this type is what crosses the wire.
 */
export interface ConnectorSummary {
  name: string;
  connected: boolean;
  status: ConnectorStatus;
  providerName?: string;
  level?: WorkspaceSourceLevel;
  pluginName?: string;
  /**
   * Why it is not connected. The whole value of this view: a connector list
   * that cannot say why something is down is decoration. Present only when
   * `status !== "connected"`, and redacted before it ever reaches the store or
   * the wire.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * `waiting` is never written to the store: it is derived at read time by
 * checking whether the owning `Agent` is currently blocked on an approval
 * while the task is `running`, the same overlay `SessionIndex` uses for
 * session liveness. `canceled` is detected the same way `done` is -- from
 * the stop reason `Supervisor.prompt` settles with -- rather than written by
 * a separate `cancel` code path, so there is exactly one place a task's
 * outcome is decided.
 */
export type TaskState = "running" | "waiting" | "done" | "failed" | "canceled";

/** States from which a task proceeds no further; a new task is what comes next. */
export const TERMINAL_TASK_STATES: readonly TaskState[] = ["done", "failed", "canceled"];

/**
 * A named unit of work started from a sidebar: a prompt, the session doing
 * it, and a lifecycle a client can render as a card.
 *
 * Modelled as its own row rather than folded onto `Agent` because the two
 * lifecycles answer different questions. `Agent.state` is "is the process
 * alive and what is it doing right now" -- it returns to `idle` between
 * prompts and is reused across many of them. `Task.state` is "did the thing
 * the user asked for finish", which is a property of one prompt, not of the
 * process that served it. Collapsing them would force every agent creation
 * through the task fiction, or leave every non-task agent carrying nullable
 * task fields it never uses.
 *
 * `agentId` is the session doing the work, never a machine reference: per
 * control-plane/docs/portability.md, a task's session must not be assumed
 * local, and nothing here encodes where that session's host lives -- that is
 * `Agent.host`'s job, looked up through `agentId` at the point of use, not
 * copied here where it would go stale the moment the session moved.
 */
export interface Task {
  id: string;
  title: string;
  prompt: string;
  /**
   * The skill or command this task ran, when it was started from one. Display
   * metadata only -- the daemon never branches on it. Invoking a skill is
   * ordinary agent work: `prompt` already contains whatever the caller wants
   * sent (typically a `/skill:<name>` or `/<command>` invocation), and it
   * reaches the agent through the exact same `Supervisor.prompt` path, and
   * therefore the exact same policy gate, as a task with no skill at all.
   */
  skillName?: string;
  agentId: AgentId;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
  /** Stop reason on success, or an error message on failure. Redacted. */
  result?: string;
  labels: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Sessions
//
// Every OMP session ever written to ~/.omp/agent/sessions/<flattened-cwd>/,
// not only the ones ompd spawned. Filesystem-derived and rebuilt on every
// query -- see @ompd/daemon's SessionIndex -- because a session file can be
// appended to or removed by the OMP TUI at any moment and a cached copy would
// go stale under it. The only thing this layer persists is whether a session
// has been explicitly archived, which must survive a daemon restart.
//
// Per control-plane/docs/portability.md: a session id identifies a session,
// never a machine, and a cwd is data about a session, not its address.
// Nothing here encodes which host produced a session or implies grouping by
// directory is more than a view.
// ---------------------------------------------------------------------------

/**
 * Which of the three directory-naming schemes a session's flattened cwd
 * decoded under, or "unknown" when it could not be decoded with confidence.
 * See cwd-codec.ts in @ompd/daemon for what "confidence" means here: a
 * decode is trusted only when it round-trips back to the exact flattened
 * name through the same encoder OMP itself uses, and only when exactly one
 * real directory does so.
 */
export type SessionCwdScope = "home" | "tmp" | "abs" | "unknown";

/**
 * Why a cwd could not be decoded, present only when `cwd` is null. Distinct
 * from a client's point of view: "no real directory reconstructs this name"
 * usually means the directory was deleted after the session ran; "more than
 * one real directory reconstructs this name" is a genuine collision in
 * OMP's flattening scheme (e.g. home-relative "tmp/x" and a temp-relative
 * "x" both encode to "-tmp-x"). Either way the honest answer is "unknown",
 * never a guess.
 */
export type SessionCwdDecodeReason = "no_match" | "ambiguous";

/**
 * - `live-tui`: a running OMP TUI process holds this session (a live client
 *   presence record, verified against the real process, names it).
 * - `live-ompd`: an ompd-supervised agent holds this session. Checked before
 *   `live-tui`: an agent ompd drives also registers a TUI-shaped client
 *   presence in some code paths, and the agent row is the more specific,
 *   independently-reconciled source of truth for that case.
 * - `dormant`: on disk, no live process holds it.
 * - `archived`: explicitly archived. Excluded from default listings; never
 *   implies the session file was deleted.
 */
export type SessionLiveStatus = "live-tui" | "live-ompd" | "dormant" | "archived";

export interface SessionSummary {
  /** The session uuid, parsed from its jsonl filename. */
  id: string;
  /** Real working directory, when the flattened directory name decoded with confidence. Null, never guessed, otherwise. */
  cwd: string | null;
  cwdScope: SessionCwdScope;
  /** Present only when `cwd` is null. */
  cwdDecodeReason?: SessionCwdDecodeReason;
  /** The raw, still-flattened directory name this session was filed under, always present so a client can group or display something even when `cwd` is null. */
  flattenedDir: string;
  title: string;
  /** ISO timestamp, parsed from the jsonl filename. */
  createdAt: string;
  /** ISO timestamp, from the session file's mtime. */
  lastActivityAt: string;
  /** Null when the file exceeds the index build's size ceiling -- see `MESSAGE_COUNT_SIZE_CEILING_BYTES` in `@ompd/daemon`'s scanner.ts -- so one pathological transcript reports "unknown" instead of stalling the whole list. */
  messageCount: number | null;
  byteSize: number;
  status: SessionLiveStatus;
  archived: boolean;
  /** Present only when `status` is "live-tui". */
  pid?: number;
  /** Present only when `status` is "live-ompd". */
  agentId?: AgentId;
}

export type SessionSortKey = "status" | "age" | "lastActivity" | "messageCount" | "size";
export type SessionSortDir = "asc" | "desc";

export interface SessionQuery {
  status?: SessionLiveStatus[];
  /** Matches either a decoded `cwd` or a raw `flattenedDir`, so an undecodable group is still filterable. */
  cwd?: string;
  /** Archived sessions are excluded unless this is true. */
  includeArchived?: boolean;
  sort?: SessionSortKey;
  sortDir?: SessionSortDir;
}

export interface SessionGroup {
  /** The decoded `cwd` when every session in the group has one, else the shared `flattenedDir`. */
  key: string;
  cwd: string | null;
  sessions: SessionSummary[];
}

// ---------------------------------------------------------------------------
// Browsing the machine, and starting work on it
//
// A phone can already watch every session on the machine and take a turn in
// one. What it could not do is decide where the next piece of work happens:
// that meant sitting at the laptop. These three frames close that, and they
// are deliberately the most privileged thing a device can ask for over the
// socket, because between them they read the operator's directories and then
// run code in one. Every one of them requires SCOPE_MANAGE and is audited,
// including its refusals -- browsing is not watching.
//
// Every path in this section is absolute and belongs to the daemon's machine.
// The daemon holds a configured set of roots and answers about nothing
// outside them: a path that resolves out, by traversal or through a symlink,
// is refused rather than listed. See @ompd/daemon's `filesystem/` for the
// enforcement.
// ---------------------------------------------------------------------------

/**
 * What a directory entry is, as its dirent reported it. `link` is a symlink
 * the daemon deliberately did not follow: resolving it is the listing's job
 * only when the operator opens it, and only if it lands inside the roots.
 */
export type FsEntryKind = "dir" | "file" | "link";

export interface FsEntry {
  /**
   * The entry's own name within `FsListing.path`. In the roots listing -- the
   * answer to an `fs_list` with no path -- there is no containing directory,
   * so each entry names an absolute root instead.
   */
  name: string;
  kind: FsEntryKind;
  /**
   * True when this directory is the top of a git working tree, checked out or
   * linked. Present only on directories, and the one marking worth a stat: it
   * is what the operator is actually looking for when choosing where an agent
   * should act.
   */
  gitRepo?: boolean;
}

/**
 * One page of a directory, as `fs_listing` carries it.
 *
 * `bounded` is not decoration. A phone asking about a directory with fifty
 * thousand entries must get an answer rather than a stall, so the daemon
 * returns a page and says so; a client that hid that would be showing a
 * truncated directory as if it were the whole one.
 */
export interface FsListing {
  /** The directory listed, absolute. Empty in the roots listing, which has no directory of its own. */
  path: string;
  /** The parent to walk up to, or null at a root: there is nothing above a root a device may see. */
  parent: string | null;
  /** Every configured root, so a client can offer them without a second request. */
  roots: string[];
  entries: FsEntry[];
  /** True when the directory holds more entries than this page carries. */
  bounded: boolean;
}

/** Opaque id correlating one clone's progress frames with its completion. */
export type CloneId = string;

export type RemoteStartClientFrame =
  /**
   * Ask for one directory's entries. Omit `path` for the roots listing, which
   * is where a client with nothing selected starts.
   */
  | { t: "fs_list"; path?: string }
  /**
   * Start a new session at `cwd`, through the same supervisor path
   * `POST /v1/agents` takes. Answered by `session_opened`, so a client's
   * existing open handling needs no second case. `name` defaults to the
   * directory's own name, which is what an operator would have typed.
   */
  | { t: "session_create"; cwd: string; name?: string }
  /**
   * Clone `url` into a new directory under `parent`. `name` defaults to the
   * repository's own name. A url carrying a credential is refused rather than
   * run, because the alternative is a secret in an audit record.
   */
  | { t: "repo_clone"; url: string; parent: string; name?: string };

export type RemoteStartServerFrame =
  | ({ t: "fs_listing" } & FsListing)
  /**
   * One line of a clone's progress, as git wrote it. Capped in count and in
   * length: this is a progress hint for a phone, not a transcript.
   */
  | { t: "clone_progress"; cloneId: CloneId; line: string }
  /** The clone finished and `path` now exists. The terminal frame; failures use `error`. */
  | { t: "clone_done"; cloneId: CloneId; path: string };
