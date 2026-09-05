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
  /**
   * Why a terminal agent ended where it did, when the daemon knows.
   *
   * Present on `failed` and absent everywhere else. It exists because `failed`
   * on its own is not a diagnosis: a container host that could not reach the
   * daemon's loopback MCP server produced exactly that state, an empty log and
   * an HTTP 500 reading "Internal error", and there was nowhere for the real
   * sentence to live. Redacted and length-bounded before it is stored, so it
   * carries no token, no query string and no argv.
   */
  failure?: string;
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
  /**
   * A container image to run instead of the pinned default toolchain.
   *
   * Never wire-accepted. This is the *resolved* spec, and the only thing that
   * may fill this field is the daemon's own `containerImage` config: see
   * `WireHostSpec` below, and the gateway's refusal of `host.image`.
   *
   * An image named here is **trusted by the operator who configured it**, in
   * the plain sense that nothing checks it. ompd mounts nothing over it, pins
   * no digest for it, and cannot confine what is inside it: a generic OCI
   * image's ENTRYPOINT is the first thing the runtime executes, before ompd
   * has a process to gate, so the approval gate is downstream of code that
   * has already run. There is no pre-entrypoint hook to put a gate in. Making
   * one trustworthy would take a different mechanism entirely, something like
   * requiring a signed image whose digest an operator approved out of band,
   * and ompd does not have that.
   */
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
  /**
   * Network policy for a container host.
   *
   * `"isolated"` (the default) gives the host a network of its own, so it
   * cannot see the operator's other containers, and leaves egress open because
   * an ACP agent has to reach a model endpoint.
   *
   * `"none"` asks for no network at all. Not every runtime can express that,
   * and one that cannot must refuse rather than approximate it: Apple
   * `container` has no `none` network (`--network none` gives
   * `notFound: "network none not found"`) and `--no-dns` only deletes
   * `/etc/resolv.conf` while leaving IP egress open. Silently downgrading a
   * request for no network into a NAT network with a missing resolver would be
   * a confinement claim nobody asked the runtime for.
   */
  network?: "isolated" | "none";
}

/**
 * What a paired device is allowed to ask for. No `image`.
 *
 * This and `HostSpec` differ by one optional field, which is not why both
 * exist. They exist because they carry different trust: a `HostSpec` is what
 * this daemon resolved, from its own config, on its own disk; a
 * `WireHostSpec` is what arrived over a socket from a device that holds
 * `manage` scope. Naming a container image is daemon-local supply-chain
 * approval, and a paired phone is not that, however well authenticated it is.
 *
 * `image?: never` rather than a bare `Omit`, and the difference is the whole
 * point of the type. A plain `Omit<HostSpec, "image">` is structurally
 * *bidirectionally* assignable with `HostSpec`: dropping an optional property
 * removes nothing a `HostSpec` value cannot satisfy, so the compiler would
 * have accepted a full `HostSpec` wherever a `WireHostSpec` was wanted and the
 * two names would have been documentation rather than a check. Declaring the
 * property as `never` makes only the widening direction legal: a
 * `WireHostSpec` still goes anywhere a `HostSpec` is wanted, because it is the
 * narrower promise, and a `HostSpec` no longer goes the other way, because
 * `string | undefined` is not assignable to `undefined`. A future change that
 * routes a value with an `image` back through the wire path fails to compile
 * instead of quietly re-opening the hole.
 */
export type WireHostSpec = Omit<HostSpec, "image"> & { image?: never };

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

/** A normalized image reference, or why the raw one is not usable as one. */
export type ImageRefResult = { ok: true; ref: string } | { ok: false; reason: string };

/**
 * C0, DEL, and C1. Written as ranges rather than as the handful anyone thinks
 * of, because "tab, newline, carriage return, NUL" is the list people write
 * down by hand and U+000B and U+0085 are the ones that walk through it. The
 * Unicode separators above this range (U+2028, U+2029) are not control
 * characters and are caught by the whitespace check below instead.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The package's one object guard.
 *
 * Exported rather than redefined per call site because there were two copies of
 * it, one here in core's validator and one private to the gateway, and a guard
 * that decides whether untrusted input is even an object is exactly the wrong
 * thing to have two subtly different versions of. It narrows to
 * `Record<string, unknown>` and no further: the fields stay `unknown`, which is
 * the point, so a caller still has to check each one it uses.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one place an image reference is normalized and checked, shared by the
 * gateway and by `loadConfig`.
 *
 * Shared rather than duplicated because the two doors disagreeing is the
 * actual failure: a value the wire refuses and the config accepts is a hole
 * with a check standing next to it. Both callers must use `ref` from the
 * result and never the string they passed in, which is why the trimmed value
 * is returned rather than a boolean. Trim happens exactly once, here, so no
 * caller can validate one string and then use a different one.
 *
 * What is refused, and why each one is not cosmetic:
 *
 * - Empty after trimming. `""` already means "not configured" to every caller,
 *   so a whitespace-only value that survived would mean "configured with
 *   nothing" and silently defeat the default it was meant to replace.
 * - A leading `-`. The reference lands in argv as the image positional, where
 *   a runtime reads it as a flag instead: `"--privileged"` produces
 *   `run --privileged tail -f /dev/null` and makes `tail` the image name.
 * - Any control character. Nothing legal contains one, and a value carrying a
 *   newline reads as one thing in a log line or a config file and as another
 *   to whatever parses it.
 * - Internal whitespace. No legal reference contains a space, and every layer
 *   that renders an argv as a string for a human, a log, or a shell splits it
 *   into two arguments.
 *
 * This is a refusal set, not a grammar. It does not attempt to decide whether
 * a reference names a real registry, repository, tag, or digest: the runtime
 * is the authority on that and will say so. The claim here is only that what
 * passes cannot be read as something other than one argv word.
 */
export function normalizeImageRef(raw: string): ImageRefResult {
  const ref = raw.trim();
  if (ref.length === 0) {
    return { ok: false, reason: "an image reference cannot be empty or only whitespace" };
  }
  const control = CONTROL_CHARS.exec(ref);
  if (control !== null) {
    const point = control[0].codePointAt(0) ?? 0;
    const code = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
    return {
      ok: false,
      reason: `an image reference cannot contain the control character ${code}; no legal reference has one, and a value carrying one reads differently to a human than to whatever parses it`,
    };
  }
  if (ref.startsWith("-")) {
    return {
      ok: false,
      reason:
        "an image reference cannot begin with a dash; a runtime would read it as a flag, not an image, and take the next word as the image name",
    };
  }
  if (/\s/.test(ref)) {
    return {
      ok: false,
      reason:
        "an image reference cannot contain whitespace; no legal reference has any, and anything that renders argv as a string splits it into two arguments",
    };
  }
  return { ok: true, ref };
}

/**
 * What the provisioner actually resolved for a host, as opposed to what the
 * caller asked for.
 *
 * This exists because the process maps were the only record of it, and that
 * made teardown depend on the daemon never restarting. `Agent.host` is already
 * persisted as JSON in the `agents` table, so everything here survives a
 * restart for free and `destroy` can work from the store instead of from
 * memory. Without it a restarted daemon leaves a running container and an
 * `ompd-*` network for a human to find by hand, because the container's command
 * is `tail -f /dev/null` and `--rm` therefore never fires.
 *
 * It is also the audit record: an operator asking what a container was given
 * needs the resolved image and the toolchain digests, not the caller's
 * `spec.image`, which is `undefined` on the default path.
 */
export interface ResolvedHost {
  /** Runtime CLI that owns this host. Required to destroy it after a restart. */
  runtime: string;
  /** Network created for this host, or null when it ran under a "none" policy and nothing was created. */
  network: string | null;
  /** Image actually used. Digest-pinned on the default path. */
  image: string;
  /** sha256 of the omp binary the container was given, when a toolchain was mounted. */
  ompSha256?: string;
  /** sha256 of the CA bundle the container was given, when a toolchain was mounted. */
  caSha256?: string;
  /**
   * Daemon-side directory seeded as the container's `HOME`, or null when the
   * host was provisioned without model access. Recorded for the same reason
   * `network` is: after a restart there is no process map, and this directory
   * is the guest's whole configuration, so teardown has to be able to reclaim
   * it from the store alone.
   *
   * It deliberately names the directory and nothing inside it. The bearer the
   * broker issued lives only in a 0600 file under this path and in the
   * broker's own memory, never here, because the store persists `HostRef` and
   * a token written into it would outlive the container that held it. The
   * consequence is intended: a daemon restart forgets every grant, so a
   * restarted daemon withdraws model access from containers it did not start.
   */
  guestHome?: string | null;
  /** ISO timestamp, so reconciliation can tell a fresh host from an orphan. */
  createdAt: string;
}

export interface HostRef {
  kind: HostKind;
  /** pid for local, container id for container, machine id for cloud. */
  id: string;
  spec: HostSpec;
  /**
   * Absent for a local host, and for any container host provisioned before
   * this field existed. A `destroy` that finds it absent falls back to the
   * process map and says so rather than pretending it reclaimed anything.
   */
  resolved?: ResolvedHost;
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

export interface RoutineAction {
  /** Stable within the routine, so an outcome still names the configured action after a rename. */
  id: string;
  name: string;
  /** Prompt delivered to a fresh agent when this action runs. */
  prompt: string;
  cwd: string;
  host: HostSpec;
  timeoutSeconds?: number;
  labels: Record<string, string>;
}

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerSpec;
  /** Actions run in this order. Every action records its own terminal outcome. */
  actions: RoutineAction[];
  /** Skip the whole event if a previous event is still running. */
  singleton: boolean;
  labels: Record<string, string>;
  createdAt: string;
}

/**
 * A routine safe to carry across a remote socket. Execution hosts never travel:
 * every received action runs through the daemon's local supervisor.
 */
export interface RemoteRoutine extends Omit<Routine, "actions"> {
  actions: Array<Omit<RoutineAction, "host">>;
}

export type ActionRunState = "queued" | "running" | "succeeded" | "failed" | "refused" | "timed_out" | "skipped";

export interface ActionRefusal {
  code: "invalid_action" | "unauthorized";
  reason: string;
}

export interface ActionRun {
  actionId: string;
  actionName: string;
  index: number;
  agentId?: AgentId;
  state: ActionRunState;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  refusal?: ActionRefusal;
  /**
   * The ACP session this action's agent opened, when it opened one.
   *
   * This is the same identity every other session surface is keyed by: it is
   * `Agent.acpSessionId`, and it is the row id the session index answers
   * queries under. A client that has it can therefore open this run's work
   * through the ordinary session path instead of needing a route of its own.
   * Transport is deliberately not stored beside it. Whether the session is
   * held by a live agent, dormant on disk, or live in a terminal is resolved
   * from the index at the moment of opening, and a copy taken when the run
   * finished would be a second answer that goes stale.
   *
   * Absent means one of two things and never a third: the run was recorded
   * before this field existed, or the action never got as far as opening a
   * session, which is every action refused for an empty prompt and every one
   * whose host could not be stood up. It does not mean the session is gone.
   * A reader with no id renders no link, because the only other option is
   * guessing one.
   *
   * It is not a credential. It names a session the daemon already serves
   * through the session surface, and every frame on that surface applies its
   * own scope gate, so holding the id is not authority to read or resume it.
   */
  sessionId?: string;
}

export type RunState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "timed_out";

export interface Run {
  id: string;
  routineId: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  /** Ordered one-for-one with the routine actions captured when this event started. */
  actions: ActionRun[];
  /** Event-level cause, used for singleton skips and daemon interruption. */
  error?: string;
}

/**
 * What a caller may say when it defines a routine, as opposed to what the
 * store holds.
 *
 * Three fields of {@link Routine} are absent on purpose, because each is the
 * daemon's to decide rather than a caller's to assert:
 *
 * - `id` and `createdAt` are minted at the write. A caller that supplied them
 *   could overwrite an unrelated routine by naming its id, which is an update
 *   wearing a create's name.
 * - `RoutineAction.host` is forced local. This mirrors what the app's own
 *   `routine_write` frame does and what `/v1/sync/import` does, and the reason
 *   is the same in all three: an execution host carries image, mounts, and
 *   network policy, so letting a definition name one turns "schedule a prompt"
 *   into "mount any path on this machine".
 *
 * A webhook trigger names no `secretRef` either. The daemon mints that, so two
 * routines cannot be made to share one credential row -- which would be one
 * secret opening two endpoints, and rotating either one silently breaking the
 * other.
 */
export type TriggerDraft =
  | { kind: "cron"; expression: string; timezone?: string }
  | { kind: "interval"; seconds: number }
  | { kind: "manual" }
  | { kind: "webhook" };

export interface RoutineActionDraft {
  /** Minted when absent. Supplying one keeps an outcome named across a rename. */
  id?: string;
  name: string;
  prompt: string;
  cwd: string;
  timeoutSeconds?: number;
  labels?: Record<string, string>;
}

export interface RoutineDraft {
  name: string;
  /** Defaults true: a routine defined and left off is the rarer intent. */
  enabled?: boolean;
  trigger: TriggerDraft;
  /** At least one. A routine with no actions is a schedule that does nothing. */
  actions: RoutineActionDraft[];
  /** Defaults true, matching the store's own column default. */
  singleton?: boolean;
  labels?: Record<string, string>;
}

/**
 * A partial edit of an existing routine. Absent means unchanged; present
 * means replace. That distinction is the whole contract, so `undefined` and
 * "empty" must never be collapsed: `labels: {}` clears every label, while no
 * `labels` key at all leaves them alone.
 *
 * `actions` replaces the whole array rather than patching members, because an
 * ordered list has no stable per-index identity to patch against -- an edit
 * that inserted an action would silently retarget every later one.
 */
export interface RoutinePatch {
  name?: string;
  enabled?: boolean;
  trigger?: TriggerDraft;
  actions?: RoutineActionDraft[];
  singleton?: boolean;
  labels?: Record<string, string>;
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

/**
 * Loopback port the MCP auth broker binds when config says nothing.
 *
 * Fixed rather than OS-assigned, for the one reason that matters: this port
 * appears inside URLs written into OMP's own MCP config file, which is read by
 * sessions this daemon never started and outlives every restart. A port that
 * moved would leave those entries pointing at nothing, and the symptom would
 * be a connector that stopped working for no visible reason.
 */
export const DEFAULT_MCP_AUTH_PORT = 7778;

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
// ---------------------------------------------------------------------------
// Co-driving a live terminal session (the daemon as a collab guest)
//
// omp's `/collab` shares a running session through an end-to-end encrypted
// room; every payload is sealed AES-256-GCM under a key that only ever rides
// in the link. A phone co-drives one of those sessions by asking this daemon
// to join the room as a guest and render it back over the gateway socket.
//
// The load-bearing decision: a joined room is presented to the phone as an
// ordinary agent. `collab_opened` hands back an `agentId`, the room's
// back-transcript is appended to that agent's update log, and live entries
// and events keep arriving as the same `update` frames an owned agent
// produces. Attach, prompt, and cancel take their existing shapes; the app
// never learns a second transcript shape.
//
// Naming, because this file already has one: `CollabRooms` above is the
// daemon's own voice-note rooms, where the daemon is the hub. Here the
// daemon is a *guest* of a room some terminal hosts. The two share no state
// and no frames, and the vocabulary below (`collab_open`, never `room_join`
// for this) keeps them unmergeable.
// ---------------------------------------------------------------------------

/**
 * Why a collab request was refused. Named rather than boolean for the same
 * reason as `SessionDeleteRefusal`: each answer calls for something
 * different from an operator, and the app routes on the key rather than
 * parsing prose.
 *
 * - `unknown_session`: this machine has no session with that id. The usual
 *   cause is a stale row on the phone, and silence there would read as a
 *   join that never happened.
 * - `not_hosted`: the session exists, but no live terminal registered with
 *   this daemon holds it, so there is nothing that could share it. A
 *   dormant session is resumable instead; that is `session_resume`'s job,
 *   not this frame's.
 * - `occupied`: the session is already in a shared room this daemon did
 *   not open: it hosts one on a different relay, or it joined someone
 *   else's room as a guest. A phone write cannot fix either, so it is a
 *   refusal rather than a retry.
 * - `view_only`: the room was shared view-only, so the link this daemon
 *   holds carries no write token. Watching is all a guest may do, and the
 *   daemon refuses the write itself rather than send a frame the host is
 *   specified to reject.
 * - `not_joined`: a write or leave named a session this daemon is not
 *   co-driving, because it never joined or the room already ended.
 */
export type CollabRefusal =
  | "unknown_session"
  | "not_hosted"
  | "occupied"
  | "view_only"
  | "not_joined"
  | "invalid_link"
  | "untrusted_relay";

/**
 * The wording for each refusal, shared by every surface that has to say why:
 * the daemon's audit detail and the app's own notice. One copy, because two
 * would drift and an operator would meet whichever one the surface they
 * happened to be on kept.
 */
export const COLLAB_REFUSAL_REASONS: Record<CollabRefusal, string> = {
  unknown_session: "this machine has no session with that id",
  not_hosted: "no live terminal holds that session, so there is nothing to co-drive",
  occupied: "that session is already in a shared room this daemon did not open",
  view_only: "this session is shared view-only, so a guest may watch but not steer",
  not_joined: "this daemon is not co-driving that session",
  invalid_link: "the supplied collab link is invalid",
  untrusted_relay: "the collab link relay host is not this daemon or loopback",
};

/**
 * The agent-label key under which a co-driven agent carries the omp session
 * id it mirrors. A phone that reconnects finds its guest agent again through
 * the ordinary `agents` list by matching this label, instead of needing a
 * second registry to ask.
 */
export const COLLAB_GUEST_SESSION_LABEL = "collab.session";
/**
 * The `source` label value every co-driven agent row carries. The Agent Hub
 * reads it to tell a session the daemon co-drives (whose room reports a live
 * subagent registry) from one it owns (whose host has no registry surface at
 * all), which is what makes the hub's empty state able to say why it is
 * empty rather than read as a session with no subagents.
 */
export const COLLAB_GUEST_AGENT_SOURCE = "collab-guest";

/**
 * The frames the daemon and a hosting terminal's bridge exchange on the
 * terminal's registered control socket, so the daemon can obtain a room link
 * for a session it was asked to co-drive. `requestId` correlates every
 * answer with its ask, because hosting starts asynchronously. `relayUrl`
 * travels in the request so the room always lands on the relay this daemon
 * chose, never on one the bridge picked.
 *
 * The link is a credential: it is never written to the audit log, the same
 * rule the socket token already follows.
 */
export type TuiCollabClientFrame =
  | {
      t: "tui_collab_opened";
      sessionId: string;
      requestId: string;
      /** The strongest link the room offers: the full link when the room is writable, the view link when it is not. */
      link: string;
      /** The view-strength form of the same room's link, always present. */
      viewLink: string;
      /** False when the room was shared view-only; the daemon then refuses every write as `view_only`. */
      writable: boolean;
    }
  | {
      t: "tui_collab_error";
      sessionId: string;
      requestId: string;
      reason: "unavailable" | "refused";
      /** Why, in the bridge's own words, for the daemon to pass through to the phone's notice. */
      detail?: string;
    }
  | { t: "tui_collab_closed"; sessionId: string; requestId: string };

export type TuiCollabServerFrame =
  | { t: "tui_collab_open"; sessionId: string; requestId: string; relayUrl: string }
  | { t: "tui_collab_close"; sessionId: string; requestId: string };

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

export type SessionHistoryToolKind =
  | "think"
  | "read"
  | "execute"
  | "search"
  | "edit"
  | "fetch"
  | "move"
  | "delete"
  | "other";
export type SessionHistoryToolStatus = "pending" | "in_progress" | "completed" | "failed";

/**
 * One durable transcript block recovered from an OMP session JSONL.
 *
 * Unlike TranscriptTailMessage this preserves thinking and tool activity.
 * Pages are oldest-first and merge with live ACP updates in the app.
 */
export type SessionHistoryEntry =
  | { kind: "user"; id: string; text: string; at: string }
  | { kind: "assistant"; id: string; text: string; thought: boolean; at: string }
  | {
      kind: "tool";
      id: string;
      toolKind: SessionHistoryToolKind;
      title: string;
      status: SessionHistoryToolStatus;
      input: unknown;
      output: string | null;
      locations: string[];
      at: string;
    };

// ---------------------------------------------------------------------------
// Client wire protocol
// ---------------------------------------------------------------------------

/** One selectable value of an agent config option, as the agent offers it. */
export interface AgentConfigChoice {
  value: string;
  name: string;
  description?: string;
}

/**
 * One config option of a live agent session, verbatim as that session reports
 * it: the mode, the model, whatever else the agent exposes. Declared here
 * rather than imported from the daemon because the wire is where a client
 * meets this shape, and a client cannot reach across into the daemon's
 * package for a type. Structurally the daemon's own `SessionConfigOption`, so
 * the gateway hands its options straight to a frame with no conversion in
 * between to drift.
 *
 * `currentValue` is what the session holds now and `options` is everything it
 * will accept, so a client offering a choice outside that list is offering a
 * refusal.
 */
export interface AgentConfigOption {
  id: string;
  name: string;
  /** Groups related options, e.g. `mode` or `model`. */
  category: string;
  /** Widget hint from the agent, e.g. `select`. */
  type: string;
  currentValue: string;
  options: AgentConfigChoice[];
}

/** The three policy postures a daemon can hold. See `PolicyConfig.mode` for what each does. */
export type PolicyMode = "strict" | "standard" | "trusted";

/**
 * The two persisted settings a paired device may read and, holding `manage`,
 * change: the posture every agent on the machine runs under, and whether the
 * daemon keeps its host awake while it works. Binding, hub, binary, and
 * credential settings deliberately have no place here.
 */
export interface SyncSettings {
  policyMode: PolicyMode;
  keepAwake: boolean;
}

// ---------------------------------------------------------------------------
// Prompt attachments
//
// A prompt can carry images alongside its text, on both delivery paths: the
// agent prompt and the terminal steer. The bytes ride the same sealed socket
// as every other frame. The hub does tunnel HTTP, but exactly one shape of it,
// a webhook fire relayed as `webhook_request`, and no upload route exists for
// a phone to post to. Wiring a general proxy would carry the device's bearer
// token through the hub, which is the one thing keeping it a carrier of opaque
// traffic rather than a credential path, so the socket is where these go.
//
// That relay hop is what sizes the ceiling, not the agent: the hub caps one
// frame at 1,000,000 bytes (`MAX_FRAME_BYTES` in `packages/hub/src/hub.ts`),
// and a frame the hub refuses to carry is a disconnect the phone cannot tell
// apart from a dead daemon. The budgets below keep the worst case -- four
// images plus a normal prompt's text and JSON envelope -- under that cap with
// headroom. The ACP client's own 32 MiB line limit is never the binding
// constraint.
//
// A phone is not a trusted client, so the daemon enforces the same budgets at
// its socket boundary rather than trusting the app's picker: exceeding them
// is a named refusal, never a crash, a truncation, or a silent drop.
// ---------------------------------------------------------------------------

/** One image riding a prompt. `data` is base64-encoded bytes, no data: URL wrapper. */
export interface PromptImage {
  data: string;
  mimeType: string;
}

/** At most this many images per prompt. */
export const MAX_PROMPT_IMAGES = 4;

/** One image's base64 may be at most this many characters (about 256 KiB decoded). */
export const MAX_PROMPT_IMAGE_BASE64_CHARS = 350_000;

/** Every image on one prompt together may be at most this many base64 characters. */
export const MAX_PROMPT_IMAGES_BASE64_CHARS = 700_000;

/** The image types an agent's `image` prompt capability covers, and nothing else. */
export const PROMPT_IMAGE_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** Why a prompt's images were refused. Named so the app and the daemon say the same words. */
export type PromptImageRefusal = "too_many" | "too_large" | "bad_mime" | "bad_data";

/** The wording for each refusal, shared by every surface that has to say why. */
export const PROMPT_IMAGE_REFUSAL_REASONS: Readonly<Record<PromptImageRefusal, string>> = {
  too_many: `A prompt can carry at most ${MAX_PROMPT_IMAGES} images.`,
  too_large: `Images must stay small enough for one relayed prompt frame: at most ${MAX_PROMPT_IMAGE_BASE64_CHARS.toLocaleString("en-US")} base64 characters each and ${MAX_PROMPT_IMAGES_BASE64_CHARS.toLocaleString("en-US")} together. Resize before attaching.`,
  bad_mime: `Only ${PROMPT_IMAGE_MIME_TYPES.join(", ")} can ride a prompt.`,
  bad_data: "An attachment was not readable base64 image data.",
};

/**
 * Validate untrusted prompt images against the wire budgets. Returns the
 * parsed images, or the first named refusal. Both ends of the wire call this:
 * the app before it sends, the daemon before it accepts, so a client cannot
 * smuggle an unbounded base64 blob past a boundary that only one of them
 * checks.
 */
export function parsePromptImages(
  value: unknown,
): { ok: true; images: PromptImage[] } | { ok: false; refusal: PromptImageRefusal } {
  if (value === undefined) return { ok: true, images: [] };
  if (!Array.isArray(value) || value.length === 0) return { ok: false, refusal: "bad_data" };
  if (value.length > MAX_PROMPT_IMAGES) return { ok: false, refusal: "too_many" };

  const images: PromptImage[] = [];
  let total = 0;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) return { ok: false, refusal: "bad_data" };
    const { data, mimeType } = raw as Record<string, unknown>;
    if (typeof data !== "string" || typeof mimeType !== "string") return { ok: false, refusal: "bad_data" };
    // Padding at the end, base64 alphabet everywhere else, and at least one
    // character of payload: this is what keeps "base64" from being a label on
    // an arbitrary string the daemon would then relay verbatim.
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return { ok: false, refusal: "bad_data" };
    if (data.length > MAX_PROMPT_IMAGE_BASE64_CHARS) return { ok: false, refusal: "too_large" };
    if (!PROMPT_IMAGE_MIME_TYPES.includes(mimeType.toLowerCase())) return { ok: false, refusal: "bad_mime" };
    total += data.length;
    images.push({ data, mimeType: mimeType.toLowerCase() });
  }
  if (total > MAX_PROMPT_IMAGES_BASE64_CHARS) return { ok: false, refusal: "too_large" };
  return { ok: true, images };
}

export type ClientFrame =
  | { t: "attach"; agentId: AgentId; sinceSeq?: number }
  | { t: "detach"; agentId: AgentId }
  | { t: "prompt"; agentId: AgentId; text: string; images?: PromptImage[] }
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
  | { t: "session_prompt"; sessionId: string; text: string; deliverAs?: TuiSteerDelivery; images?: PromptImage[] }
  /** A registered live TUI reporting turn progress back to the daemon. */
  | { t: "tui_activity"; sessionId: string; kind: TuiActivityKind; text?: string }
  /**
   * Ask for the session index over this socket. A hub-relayed phone has no
   * road to `GET /v1/sessions`: the hub tunnels exactly one request shape,
   * a webhook fire, and no tunnel is wired for this route. So for that
   * client this frame is not a convenience beside the route; it is the only
   * road the index can take.
   */
  | { t: "sessions"; query?: SessionQuery }
  /**
   * Take over a `live-tui` session through this socket. `POST
   * /v1/sessions/:id/takeover` is a road a relayed phone cannot take, because
   * the hub tunnels only a webhook fire and no tunnel is wired for this
   * route; this frame is the only one it can take. Wiring a general request
   * tunnel instead would have handed the hub the device's bearer token to
   * forward, and the hub is built to carry traffic it cannot read.
   *
   * `cwd` and `pid` are the index row's own
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
   * Co-drive a live terminal session: join the collab room its host shares
   * and follow it as an ordinary agent. Requires read scope to watch; the
   * prompts that may follow require prompt scope, exactly as they do for an
   * owned agent. Answered by `collab_opened`, or by an `error` carrying
   * `collab_refused` (with a `CollabRefusal` reason) or `collab_unavailable`
   * when the join itself failed on the wire. Asking again for a session this
   * daemon already co-drives answers `collab_opened` with the same agentId,
   * so a reconnected phone can recover its row without a second guest.
   */
  | { t: "collab_open"; sessionId: string; link?: string }
  /**
   * Stop co-driving a session. The guest leaves the room and its agent row
   * goes terminal, exactly as a stopped owned agent does. One-shot like the
   * other instructions: a leave that never left means the daemon is still
   * co-driving a session the operator believes they walked away from.
   */
  | { t: "collab_leave"; sessionId: string }
  | TuiCollabClientFrame
  /**
   * Delete sessions: the transcript files themselves, and everything this
   * daemon persists about them. Irreversible, so it is the one session frame
   * that carries a list: clearing hundreds of dead fixture sessions one
   * frame at a time is not a capability anyone would use, and a batch whose
   * ids each succeed or are refused on their own is safer than a loop the
   * client has to drive and reconcile itself.
   *
   * Requires manage scope, the same gate archiving takes, and every id is
   * audited including its refusal. A session a process currently holds is
   * refused by name rather than deleted: see `SessionDeleteRefusal`.
   *
   * Answered by `sessions_deleted`, one result per id, to the asking socket
   * only. The fleet's own refresh does not ride that answer: the sessions
   * watcher sees the files go away and pushes a new index to every socket
   * that asked for one.
   */
  | { t: "session_delete"; sessionIds: string[] }
  /**
   * Mint a new device's credential over this socket, in one authenticated
   * request. The two HTTP steps this replaces -- an unauthenticated
   * `POST /v1/pair` that records an intent, then an approve-scoped
   * `POST /v1/pairings/approve` that spends it -- are internal detail to a
   * caller that is already authenticated, and the hub has no tunnel wired
   * for either route, so neither step can ride one. Requires
   * `approve`, and may not grant a scope the asking device does not hold.
   */
  | { t: "device_invite"; name: string; scopes: string[] }
  | RemoteStartClientFrame
  /**
   * Read every routine and its recent event outcomes through the sealed socket.
   * A hub-relayed phone has no route to the daemon's HTTP API: the hub's one
   * tunnel fires a webhook and carries nothing else.
   */
  | { t: "routines_read" }
  /** Replace one complete routine definition. Requires manage scope. */
  | { t: "routine_write"; routine: RemoteRoutine }
  /** Run one enabled routine now. Requires manage and prompt scope. */
  | { t: "routine_run"; routineId: string }
  /** Rotate a webhook routine's one-time secret. Requires manage scope. */
  | { t: "routine_secret_rotate"; routineId: string }
  /**
   * Delete routines for good. Requires manage scope, and refuses per id rather
   * than failing the batch. The one irreversible operation on the routine
   * catalog, so it is armed behind an explicit confirm on every surface that
   * offers it.
   */
  | { t: "routine_delete"; routineIds: string[] }
  /**
   * The tail of a session's transcript, read straight from its file, and the
   * pages of it older than that.
   *
   * Read scope, not manage: this is reading a transcript, which a read-only
   * device is already entitled to for its own agents, and it changes nothing
   * about the session. `limit` asks for at most that many of the most recent
   * turns; the daemon defaults it and caps it, so a client cannot ask for a
   * whole 10MB transcript in one frame.
   *
   * `cursor` is how the rest of the conversation is reached: every answer
   * carries the byte offset the next older page starts from, and sending it
   * back asks for that page. Absent means the newest turns. Paging rides
   * this frame rather than `session_history` because that one is keyed by
   * agent id, and a live terminal session has no agent row to key on, which
   * is the whole reason this frame exists.
   *
   * A live terminal session has no agent row, so `attach` and its `update`
   * stream cannot reach it. Without this frame, tapping a session with a
   * thousand messages in it shows a composer and nothing else.
   */
  | { t: "session_tail"; sessionId: string; limit?: number; cursor?: number }
  | { t: "session_history"; agentId: AgentId; sessionId: string; before?: number; limit?: number }
  /**
   * Ask what the daemon's two persisted settings hold right now. The hub
   * tunnels only a webhook fire and no tunnel is wired for
   * `GET /v1/sync-settings`, so a phone reads these through this frame
   * instead. Answered by `settings`, to the asking socket only.
   */
  | { t: "settings_read" }
  /**
   * Change both persisted settings in one frame. One-shot like the other
   * instructions: never replayed after a reconnect, so the operator retaps
   * rather than wonders. Answered by `settings` carrying what the daemon
   * reads back after applying, so a client renders confirmed state, never
   * its own request.
   */
  | ({ t: "settings_write" } & SyncSettings)
  /**
   * Ask what config options one agent's live session holds right now, the
   * mode among them. The hub tunnels only a webhook fire and no tunnel is
   * wired for `GET /v1/agents/:id/config`, so a phone reads this through
   * this frame instead. Answered by `agent_config`, to the asking
   * socket only.
   */
  | { t: "agent_config_read"; agentId: AgentId }
  /**
   * Move one agent's session onto `modeId`. One-shot like the other
   * instructions: never replayed after a reconnect, so the operator retaps
   * rather than wonders. Answered by `agent_config` carrying what the daemon
   * reads back after the session applied it, so a client renders confirmed
   * state and never its own request.
   */
  | { t: "agent_config_write"; agentId: AgentId; modeId: string }
  /**
   * The Cowork catalogue reads, sealed-socket versions of `GET /v1/skills`
   * and `GET /v1/connectors`. A hub-paired phone reaches these frames rather
   * than those routes: the hub tunnels exactly one HTTP shape today (the
   * routine webhook POST, carried as `webhook_request`/`webhook_response`),
   * and Cowork deliberately does not add a second, because a general tunnel
   * would carry this device's bearer token through the hub while typed frames
   * keep the hub relaying opaque sealed traffic. `cwd` scopes the discovery
   * the way the route's query parameter does; `agentId` resolves to that
   * agent's cwd, and `cwd` wins when both are given. Answered by
   * `skills`/`connectors`, to the asking socket only.
   */
  | { t: "skills_read"; cwd?: string; agentId?: string }
  | { t: "connectors_read"; cwd?: string; agentId?: string }
  /**
   * The task roster over this socket, the `GET /v1/tasks` twin. Answered by
   * `tasks`, to the asking socket only.
   */
  | { t: "tasks_read"; agentId?: string }
  /**
   * Start one task, the `POST /v1/tasks` twin: a named prompt against a
   * session that already exists, never a session-spawner. Answered by `task`
   * carrying what the daemon created, to the asking socket only.
   */
  | {
      t: "task_create";
      title: string;
      prompt: string;
      agentId: AgentId;
      skillName?: string;
      labels?: Record<string, string>;
    }
  /**
   * Cancel one task, the `POST /v1/tasks/:id/cancel` twin. Answered by
   * `task` carrying the task as the daemon now holds it, to the asking
   * socket only.
   */
  | { t: "task_cancel"; taskId: string }
  /**
   * Create an agent, the `POST /v1/agents` twin: the manage-scoped act that
   * provisions a host, which is how a Cowork container start crosses the
   * socket. Answered by `agent_created`, to the asking socket only.
   *
   * `host` is a `WireHostSpec`, so it cannot name an `image`. The daemon
   * refuses that field at both doors and this is the type saying so before a
   * client ships a frame that can only ever be a 400.
   */
  | {
      t: "agent_create";
      name: string;
      cwd: string;
      host?: WireHostSpec;
      routineId?: string;
      labels?: Record<string, string>;
    }
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
  /**
   * The one refusal envelope every surface shares. `code` names the class
   * (`collab_refused`, `collab_unavailable`, `unauthorized`, ...) for
   * routing; `reason` carries the machine key inside that class when one
   * exists (a `CollabRefusal` for collab frames), so a client renders
   * wording from the matching `*_REFUSAL_REASONS` record instead of
   * parsing `message`. `sessionId` correlates a failure with the session
   * row it came from, for frames that name a session rather than an agent.
   */
  | { t: "error"; agentId?: AgentId; sessionId?: string; message: string; code?: string; reason?: string }
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
   * the socket that registered the session. Images ride the steer as omp's own
   * `sendUserMessage` content blocks, the same vocabulary the agent prompt
   * uses, so a terminal turn and an agent turn can carry the same attachment.
   */
  | { t: "tui_steer"; sessionId: string; text: string; deliverAs: TuiSteerDelivery; images?: PromptImage[] }
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
   * A `collab_open` succeeded: this daemon joined the room the session's
   * host shares, and the guest leg now presents as the agent `agentId`.
   * Everything after this frame is the ordinary machinery -- `attach` for
   * the transcript, `update` as the room streams, `prompt` and `cancel` to
   * steer. `readOnly` reports the trust of the link the daemon holds: when
   * the room was shared view-only, every write is refused as `view_only`
   * no matter what scope the asking device carries.
   */
  | { t: "collab_opened"; sessionId: string; agentId: AgentId; readOnly: boolean }
  | TuiCollabServerFrame
  /**
   * What a `session_delete` did, one result per id asked for, sent only to
   * the socket that asked. A refusal is reported here beside the deletions
   * rather than as an `error` frame, because a mixed batch has both and an
   * error frame cannot say which ids it covers.
   */
  | { t: "sessions_deleted"; results: SessionDeleteResult[] }
  /** Current routine definitions and recent event outcomes, only for the asking socket. */
  | { t: "routines"; routines: RemoteRoutine[]; runs: Run[] }
  /** One routine event completed, with every action outcome in configured order. */
  | { t: "routine_ran"; run: Run }
  /** One-time webhook secret returned only to the socket that rotated it. */
  | { t: "routine_secret"; routineId: string; secret: string }
  /**
   * The skills or connectors catalogue answering `skills_read`/
   * `connectors_read`, sent only to the socket that asked. Reshaped and
   * wire-safe by construction: never a connector's raw config.
   */
  | { t: "skills"; skills: SkillSummary[] }
  | { t: "connectors"; connectors: ConnectorSummary[] }
  /** The task roster answering `tasks_read`, sent only to the socket that asked. */
  | { t: "tasks"; tasks: Task[] }
  /** One task as the daemon now holds it, answering `task_create` or `task_cancel`. */
  | { t: "task"; task: Task }
  /** The agent an `agent_create` made, sent only to the socket that asked. */
  | { t: "agent_created"; agent: Agent }
  /**
   * What a `routine_delete` did, one result per id asked for, sent only to the
   * socket that asked. Beside `sessions_deleted` rather than an error frame,
   * for the same reason: a mixed batch has both answers and an error frame
   * cannot say which ids it covers.
   */
  | { t: "routines_deleted"; results: RoutineDeleteResult[] }
  /**
   * The answer to a `device_invite`: the one-time view of a credential just
   * minted, sent only to the socket that asked. Never broadcast, never
   * replayed after a reconnect -- a credential delivered twice is a second
   * credential in the wild that no operator asked for and no screen showed.
   */
  | { t: "device_invited"; token: string; name: string; scopes: string[] }
  | RemoteStartServerFrame
  /**
   * One page of a transcript answering a `session_tail` frame, sent only to
   * the socket that asked. Oldest first, so a client appends live activity
   * below it without reordering. `truncated` says this page is not the whole
   * transcript: either an older turn exists past the ones returned, or the
   * reader stopped at its byte budget with unread bytes behind it.
   *
   * `nextCursor` is the byte offset the next older page starts from, or null
   * when this page reached the start of the file. It is a cursor, not a
   * promise of words: a page can arrive empty with a non-null cursor,
   * because a long run of tool traffic says nothing and the reader stopped
   * at its budget inside one. A client keeps asking from the cursor rather
   * than treating an empty page as the end.
   *
   * `cursor` echoes the offset this page was read from, and is absent on the
   * answer to a cursorless ask. A client needs it to tell a first page from
   * an older one without guessing from timestamps, and to drop a page that
   * answers an ask its surface has already replaced.
   */
  | {
      t: "session_tail";
      sessionId: string;
      messages: TranscriptTailMessage[];
      truncated: boolean;
      nextCursor: number | null;
      cursor?: number;
    }
  | {
      t: "session_history";
      agentId: AgentId;
      sessionId: string;
      entries: SessionHistoryEntry[];
      nextBefore: number | null;
    }
  /**
   * The daemon's settings as it holds them now, answering `settings_read` or
   * `settings_write` and sent only to the socket that asked. Read back after
   * any apply, so it is the daemon's confirmation rather than an echo of the
   * request.
   */
  | ({ t: "settings" } & SyncSettings)
  /**
   * One agent's session config as the daemon holds it now, answering
   * `agent_config_read` or `agent_config_write` and sent only to the socket
   * that asked. Read back from the session after any apply, so it is the
   * daemon's confirmation rather than an echo of the request: a client that
   * renders this is showing what the agent runs under, never what a device
   * asked for.
   */
  | { t: "agent_config"; agentId: AgentId; configOptions: AgentConfigOption[] }
  | { t: "pong" };

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditAction =
  /**
   * The ACP host for a provisioned host came up, or did not.
   *
   * Its own action rather than a second `host.provision`, which is what it used
   * to be. Two sites wrote `host.provision` for one container -- the
   * provisioner with the actor, the supervisor without one -- so a single
   * create read as two provisions in the audit trail and cost a diagnosis real
   * time. Provisioning a container and starting an ACP host inside it are
   * different events that fail for different reasons, and the trail should say
   * which one happened.
   */
  | "host.start"
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
  /**
   * A device asked to co-drive a live terminal session through its shared
   * collab room, or was refused. Recorded on every exit for the same reason
   * as `session.prompt`: this is a device reaching into a session someone
   * else is sitting at, and a log that kept only the successes would omit
   * exactly the attempts worth reviewing. `detail` carries the session id
   * and the refusal reason; the room link is a credential and never rides
   * an audit record.
   */
  | "collab.join"
  | "approval.decide"
  | "device.pair"
  | "device.revoke"
  /** A daemon registered an outbound tunnel leg with a hub, or was refused. */
  | "tunnel.register"
  /** A client opened a tunnel session to this daemon, or was refused. */
  | "tunnel.attach"
  /**
   * A routine definition was written for the first time. `detail` carries the
   * routine id, its name, and its trigger kind; never a webhook secret, and
   * never the `secretRef` that names one.
   */
  | "routine.create"
  /** An existing routine definition was edited. Same `detail` rules as `routine.create`. */
  | "routine.update"
  | "routine.run"
  /**
   * A whole configuration was restored from another daemon over
   * `/v1/sync/import`. One row for the restore, not one per routine: importing
   * a catalogue arms every automation in it, and fifty `routine.create` rows
   * would be fifty arming decisions nobody made. `detail` carries the routine
   * count and the policy mode, so a reader can see how much of the machine's
   * behaviour changed and under what policy, without a credential reaching a
   * log meant to be safe to print.
   */
  | "sync.import"
  | "proposal.submit"
  | "proposal.promote"
  | "proposal.reject"
  | "host.provision"
  | "host.destroy"
  /**
   * A brokered MCP grant was authorized, imported, refreshed, forgotten, or
   * wired into OMP's config.
   *
   * `detail` carries counts, grant ids, resource URLs and states, and nothing
   * else. No token, no refresh material, no client secret, and no upstream
   * error body -- providers put credential fragments in those. An audit record
   * is the wrong place to learn what a token looked like, and it is written to
   * a database the phone can read.
   */
  | "mcp_auth.login"
  | "mcp_auth.import"
  | "mcp_auth.apply"
  | "mcp_auth.refresh"
  | "mcp_auth.forget"
  /**
   * A host the store still listed was reclaimed at daemon start, or could not
   * be. Distinct from `host.destroy` because nobody asked for it: it is the
   * daemon noticing that a previous process left something running, and the
   * `error` outcome is the one an operator has to act on by hand.
   */
  | "host.reconcile"
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
   * A device deleted one session's transcript from disk, or was refused.
   * One record per id, whichever way it went: this is the only operation in
   * this daemon that destroys an operator's own work irreversibly, so the
   * log has to answer "who removed that session" for every id anyone ever
   * named, not only the ones that succeeded. `detail` carries the session id
   * and, on a refusal, which refusal it was.
   */
  | "session.delete"
  /**
   * A device deleted one routine and its runs and webhook credential, or was
   * refused. One record per id, whichever way it went, for the same reason as
   * `session.delete`: the log has to answer "who removed that routine" for
   * every id anyone ever named, not only the ones that succeeded. `detail`
   * carries the routine id and, on a refusal, which refusal it was.
   */
  | "routine.delete"
  /**
   * A container host was granted scoped access to one model through the
   * daemon's broker, or the grant failed. `detail` carries the model id, the
   * container network, and on a failure the reason; it NEVER carries the
   * bearer the guest was issued. A grant is the moment a guest gains the
   * ability to spend the operator's model credential, so it is its own action
   * rather than detail on `host.provision`: the two fail for different
   * reasons, and "which container could talk to which model, and when" has to
   * be answerable without reading provisioning records.
   */
  | "model.grant"
  /**
   * A container host's model grant was revoked, or the revocation failed.
   * Paired with `model.grant` so the trail bounds the window in which a guest
   * could spend the credential. Same rule on `detail`: model id, never a token.
   */
  | "model.revoke"
  /**
   * A device cloned a repository onto this machine, or was refused. `detail`
   * carries the url and the destination; a url carrying a credential is
   * refused before this record is written, so one can never be logged.
   */
  | "repo.clone"
  /** A direct socket exceeded the outbound backpressure ceiling and was closed with 1013. */
  | "socket.backpressure";

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
// MCP auth
// ---------------------------------------------------------------------------

/**
 * What the daemon can currently say about one remote MCP server's OAuth grant.
 *
 * Five states rather than a boolean because the difference between them is the
 * whole point. "Down" is not one thing: a grant the provider will never renew
 * needs a human at a browser, a grant that failed once needs nothing but time,
 * and a provider that never issued a refresh token needs the operator to know
 * that no daemon can fix it.
 *
 * - `healthy`      the daemon holds refresh material and the last exchange with
 *                  the token endpoint succeeded.
 * - `refreshing`   an exchange is in flight right now.
 * - `degraded`     the last exchange failed transiently (network, 5xx, timeout).
 *                  The grant is intact and the daemon is backing off, so this
 *                  resolves itself.
 * - `reauth_required` the provider refused the refresh token definitively
 *                  (`invalid_grant`, revoked, reuse detected). Retrying cannot
 *                  help; a person must authorize again.
 * - `no_refresh_grant` the authorization server does not implement the refresh
 *                  grant, or issued no refresh token. The access token will die
 *                  and nothing here can renew it. Reported rather than papered
 *                  over, because a keepalive that pretends otherwise is a lie
 *                  with a schedule attached.
 */
export type McpAuthState = "healthy" | "refreshing" | "degraded" | "reauth_required" | "no_refresh_grant";

/**
 * One brokered MCP grant, as a client may see it.
 *
 * Deliberately carries no token, no refresh material, and no client secret.
 * Everything here is either an identifier, a URL the provider publishes, or a
 * timestamp: a screenshot of this type leaks nothing. `account` is the
 * provider's own non-secret label for the authorized identity (an email, a
 * workspace name) and is absent when the provider gave none.
 */
export interface McpAuthSummary {
  /** Stable id. Also the last path segment of the loopback endpoint. */
  id: string;
  /** The name this server is mounted under in OMP's MCP config. */
  serverName: string;
  /** The upstream MCP endpoint the daemon proxies to. */
  resourceUrl: string;
  /** The authorization server that issued the grant. */
  issuer: string;
  state: McpAuthState;
  /** Why, in one line, when the state is not `healthy`. Redacted before it is stored or sent. */
  detail?: string;
  /** Scopes the provider actually granted, space separated. */
  scopes: string;
  account?: string;
  /** ISO timestamp of the last successful token exchange, absent if never. */
  lastRefreshAt?: string;
  /** ISO timestamp the in-memory access token expires, absent when none is held. */
  accessExpiresAt?: string;
  /** Consecutive transient failures. Zero whenever the last exchange succeeded. */
  failures: number;
  /** ISO timestamp the daemon will next attempt a refresh, when it is backing off. */
  nextAttemptAt?: string;
  /** Whether the authorization server advertises the refresh grant at all. */
  supportsRefresh: boolean;
  /** Whether an OMP session pointed at the loopback endpoint would reach this grant right now. */
  wired: boolean;
}

/**
 * The daemon's whole MCP auth surface: every grant plus where the broker is
 * listening, so a client can tell "no grants" from "the broker is not running".
 */
export interface McpAuthStatus {
  /** Loopback base URL sessions connect to, absent when the broker is not listening. */
  endpoint?: string;
  /**
   * Why the listener is not up, when it should be.
   *
   * An absent `endpoint` has two very different causes: the operator turned the
   * broker off, or the port it was told to use is already taken. The second one
   * leaves every brokered config entry pointing at nothing, so it must not be
   * reported as the same silence as the first.
   */
  listenError?: string;
  /** Which at-rest protection the refresh tokens actually got. Named, never assumed. */
  vault: "keychain" | "libsecret" | "file";
  grants: McpAuthSummary[];
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

/**
 * Why one id in a delete request was refused. Named rather than boolean
 * because the three answers call for three different things from an
 * operator: stop the session, check the id, or look at the machine.
 *
 * - `live`: a process holds this session right now (`live-ompd` or
 *   `live-tui`). Deleting the transcript under a running writer would leave
 *   it appending to an unlinked file, so the operator stops it or takes it
 *   over first.
 * - `not_found`: this machine has no session file with that id. Reported
 *   rather than treated as already gone, because the usual cause is a typo
 *   or a stale row, and silence there reads as a successful delete.
 * - `failed`: the file was there and the removal did not succeed. The
 *   session is intact; the cause is on the machine (permissions, a mount).
 */
export type SessionDeleteRefusal = "live" | "not_found" | "failed";

/**
 * One id's outcome. Every id in a request gets exactly one of these, so a
 * batch that refuses some and deletes the rest reports precisely which. A
 * single ok/failed for the whole batch would leave an operator unable to
 * tell what is still on disk.
 */
export type SessionDeleteResult =
  | { sessionId: string; deleted: true }
  | { sessionId: string; deleted: false; refusal: SessionDeleteRefusal };

/**
 * The wording for each refusal, shared by every surface that has to say why:
 * the daemon's audit detail, the HTTP response a script reads, and the app's
 * own notice. One copy, because two would drift and an operator would meet
 * whichever one the surface they happened to be on kept.
 */
export const SESSION_DELETE_REFUSAL_REASONS: Record<SessionDeleteRefusal, string> = {
  live: "a process is holding this session; stop it or take it over first",
  not_found: "this machine has no session with that id",
  failed: "the transcript could not be removed from disk",
};

/**
 * Why one id in a routine delete request was refused. Named rather than
 * boolean for the same reason as `SessionDeleteRefusal`: each answer calls
 * for something different from an operator.
 *
 * - `running`: a run of this routine is in flight right now. Deleting the
 *   definition under a live run would orphan a record still being written,
 *   so the operator lets the run finish (or stops it) and deletes then.
 * - `not_found`: this daemon holds no routine with that id. Reported rather
 *   than treated as already gone, because the usual cause is a typo or a
 *   stale list, and silence there reads as a successful delete.
 * - `failed`: the definition was there and the removal did not succeed. The
 *   routine is intact; the cause is on the machine.
 */
export type RoutineDeleteRefusal = "running" | "not_found" | "failed";

/** One id's outcome, mirroring `SessionDeleteResult` for the same reasons. */
export type RoutineDeleteResult =
  | { routineId: string; deleted: true }
  | { routineId: string; deleted: false; refusal: RoutineDeleteRefusal };

/** The wording for each refusal, shared by every surface for the same reason. */
export const ROUTINE_DELETE_REFUSAL_REASONS: Record<RoutineDeleteRefusal, string> = {
  running: "a run of this routine is in flight; let it finish or stop it first",
  not_found: "this daemon holds no routine with that id",
  failed: "the routine could not be removed from the store",
};

/**
 * The public route a webhook routine's caller POSTs to. One copy of the path
 * shape, because the gateway matches it and the app renders it: two copies
 * would drift, and instructions that name a route the daemon no longer serves
 * are worse than none. The id is encoded, so a caller can hand this the exact
 * id the daemon minted without thinking about URL syntax.
 */
export function webhookPath(routineId: string): string {
  return `/v1/webhooks/${encodeURIComponent(routineId)}`;
}

/**
 * The same fire, addressed to a hub instead of the daemon itself. The hub
 * tunnels this one request shape: it takes the POST, sends it down the
 * daemon's already-open sealed socket as a `webhook_request`, and replays the
 * daemon's `webhook_response` as a real HTTP response. Two segments rather
 * than one because the hub serves many daemons and has to be told which.
 *
 * This is the address to hand out for a daemon with no reachable address of
 * its own, which is the ordinary case. The routine's secret is the only thing
 * gating it, and the hub reads that secret in order to forward it, so it is a
 * credential to treat as one.
 */
export function hubWebhookPath(daemonId: string, routineId: string): string {
  return `/v1/webhooks/${encodeURIComponent(daemonId)}/${encodeURIComponent(routineId)}`;
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
