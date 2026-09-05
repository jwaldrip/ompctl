/**
 * The client-facing surface: HTTP for state, one websocket for everything live.
 *
 * Two properties shape this file.
 *
 * The first is that agent lifetime does not belong to a connection. Nothing
 * here stops, cancels, or unblocks an agent because a socket went away, and the
 * update log is written by the supervisor whether or not anyone is listening.
 * That is what makes `attach` with `sinceSeq` able to hand a phone the exact
 * frames it missed rather than a truncated turn.
 *
 * The second is that this layer is the least trusted part of the daemon. It
 * terminates connections from a phone on someone else's network, so every frame
 * is treated as hostile input: scopes are re-read from the device row, a
 * client's `decide` is passed to the supervisor as evidence rather than applied,
 * malformed input produces an error frame instead of a dropped socket, and no
 * single client can monopolise the daemon.
 */

import { createHash, randomBytes } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  type Actor,
  type Agent,
  type AgentId,
  type AuditInput,
  type ClientFrame,
  COLLAB_REFUSAL_REASONS,
  type CollabRefusal,
  type CollabVoiceNoteFrame,
  type CollabVoiceParticipant,
  type ConnectorSummary,
  type EndpointOffer,
  isRecord,
  type McpAuthState,
  type McpAuthStatus,
  nextFireTime,
  type PersistCollabVoiceNoteInput,
  PROMPT_IMAGE_REFUSAL_REASONS,
  parsePromptImages,
  type QueuedIntent,
  ROUTINE_DELETE_REFUSAL_REASONS,
  type Routine,
  type RoutineAction,
  type RoutineActionDraft,
  type RoutineDeleteResult,
  type RoutineDraft,
  type RoutinePatch,
  type Run,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  SESSION_DELETE_REFUSAL_REASONS,
  type ServerFrame,
  type SessionDeleteResult,
  type SessionLiveStatus,
  type SessionQuery,
  type SessionSortDir,
  type SessionSortKey,
  type SessionSummary,
  type SkillSummary,
  type Store,
  type SyncSettings,
  type Task,
  TERMINAL_AGENT_STATES,
  type TriggerDraft,
  type TuiActivityKind,
  type TuiSteerDelivery,
  validateWireHostSpec,
  type WebViewAction,
  type WebViewActionResult,
  type WireHostSpec,
} from "@ompd/core";
import type { Server, ServerWebSocket } from "bun";
import { LOCAL_HOSTNAMES, parseCollabLink } from "../collab/guest-link.ts";
import { CollabGuests } from "../collab/guests.ts";
import { CollabRelay, isRelaySocketData, type RelaySocket, type RelaySocketData } from "../collab/relay.ts";
import { type CollabConnection, CollabRoomError, CollabRooms } from "../collab/rooms.ts";
import { type CloneRun, type FilesystemSurface, FsRefusal } from "../filesystem/index.ts";
import { MODE_OPTION_ID, type SessionConfig } from "../hosts.ts";
import { HISTORY_MAX_TURNS, readSessionHistory } from "../sessions/history.ts";
import type { SessionIndex } from "../sessions/session-index.ts";
import { readSessionTail, TAIL_MAX_MESSAGES } from "../sessions/tail.ts";
import type { SessionWatch } from "../sessions/watcher.ts";
import {
  AgentBusyError,
  createAgentId,
  type PendingApproval,
  type PendingPlanReview,
  type Supervisor,
  UnauthorizedError,
} from "../supervisor.ts";
import { WEB_ASSETS, WEB_ASSETS_BUILT } from "../web-assets.ts";
import type { CreateTaskInput } from "../workspace/tasks.ts";
import { DeviceAuth, PairingBacklogError, PairingError } from "./auth.ts";
import type { GatewayEvents } from "./events.ts";
import { TokenBucket } from "./ratelimit.ts";

/**
 * Content types for the console's asset kinds.
 *
 * Explicit rather than inferred: a `.webmanifest` served as octet-stream makes
 * the PWA silently uninstallable, and that failure looks like nothing at all.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".map": "application/json",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extname(key)] ?? "application/octet-stream";
}

/** Decode one embedded asset into a response with an explicit content type. */
function embeddedResponse(base64: string, key: string): Response {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return new Response(bytes, { headers: { "content-type": contentTypeFor(key) } });
}
/** Narrow an untrusted client payload before it reaches the MCP result path. */
function isWebViewActionResult(value: unknown): value is WebViewActionResult {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const result = value as Record<string, unknown>;
  switch (result.kind) {
    case "ack":
      return typeof result.url === "string" && typeof result.title === "string";
    case "error":
      return typeof result.message === "string";
    case "screenshot":
      return typeof result.pngBase64 === "string";
    case "observe": {
      if (typeof result.observation !== "object" || result.observation === null) return false;
      const observation = result.observation as Record<string, unknown>;
      return (
        typeof observation.url === "string" &&
        typeof observation.title === "string" &&
        typeof observation.settled === "boolean" &&
        typeof observation.tree === "object" &&
        observation.tree !== null
      );
    }
    default:
      return false;
  }
}

const SESSION_STATUSES: readonly SessionLiveStatus[] = ["live-tui", "live-ompd", "dormant", "archived"];
const SESSION_SORT_KEYS: readonly SessionSortKey[] = ["status", "age", "lastActivity", "messageCount", "size"];
const SESSION_SORT_DIRS: readonly SessionSortDir[] = ["asc", "desc"];

/**
 * Parses and validates `/v1/sessions*` query parameters into a
 * `SessionQuery`, doing the grouping/sorting/filtering decisions
 * server-side rather than handing a client 305 rows to sort itself -- the
 * whole point of running this behind a phone's pull-to-refresh.
 */
function parseSessionQuery(url: URL): { query: SessionQuery } | { error: string } {
  const statusParam = url.searchParams.get("status");
  const cwdParam = url.searchParams.get("cwd");
  const includeArchivedParam = url.searchParams.get("includeArchived");
  const sortParam = url.searchParams.get("sort");
  const sortDirParam = url.searchParams.get("sortDir");
  return validateSessionQuery({
    // The comma-split and the true/1 coercion are HTTP's own serialisation,
    // nothing more: everything past this point is decided once, in the
    // shared validator, so the HTTP route and the `sessions` frame cannot
    // drift apart on what a malformed query means.
    ...(statusParam
      ? {
          status: statusParam
            .split(",")
            .map(s => s.trim())
            .filter(s => s.length > 0),
        }
      : {}),
    ...(cwdParam ? { cwd: cwdParam } : {}),
    ...(includeArchivedParam !== null
      ? { includeArchived: includeArchivedParam === "true" || includeArchivedParam === "1" }
      : {}),
    ...(sortParam ? { sort: sortParam } : {}),
    ...(sortDirParam ? { sortDir: sortDirParam } : {}),
  });
}

/**
 * Narrows an untrusted `SessionQuery`-shaped value into a `SessionQuery`.
 * The one validator both session surfaces call: the HTTP route above and the
 * `sessions` websocket frame below. An unknown status or sort key is refused
 * here rather than silently coerced, because a coerced query is a filter that
 * quietly does not do what the client asked, which on a phone reads as
 * "sessions are missing".
 */
function validateSessionQuery(value: unknown): { query: SessionQuery } | { error: string } {
  if (value === undefined || value === null) return { query: {} };
  if (!isRecord(value)) return { error: "query must be an object" };

  const query: SessionQuery = {};

  if (value.status !== undefined) {
    if (!Array.isArray(value.status)) return { error: "status must be an array of live statuses" };
    for (const s of value.status) {
      if (typeof s !== "string" || !SESSION_STATUSES.includes(s as SessionLiveStatus)) {
        return { error: `unknown status "${String(s)}", expected one of ${SESSION_STATUSES.join(", ")}` };
      }
    }
    query.status = value.status as SessionLiveStatus[];
  }

  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string") return { error: "cwd must be a string" };
    // An empty cwd filters nothing; the HTTP route drops `?cwd=` the same way.
    if (value.cwd.length > 0) query.cwd = value.cwd;
  }

  if (value.includeArchived !== undefined) {
    if (typeof value.includeArchived !== "boolean") return { error: "includeArchived must be a boolean" };
    query.includeArchived = value.includeArchived;
  }

  if (value.sort !== undefined) {
    if (typeof value.sort !== "string" || !SESSION_SORT_KEYS.includes(value.sort as SessionSortKey)) {
      return { error: `unknown sort "${String(value.sort)}", expected one of ${SESSION_SORT_KEYS.join(", ")}` };
    }
    query.sort = value.sort as SessionSortKey;
  }

  if (value.sortDir !== undefined) {
    if (typeof value.sortDir !== "string" || !SESSION_SORT_DIRS.includes(value.sortDir as SessionSortDir)) {
      return {
        error: `unknown sortDir "${String(value.sortDir)}", expected one of ${SESSION_SORT_DIRS.join(", ")}`,
      };
    }
    query.sortDir = value.sortDir as SessionSortDir;
  }

  return { query };
}

/**
 * A refusal from `#takeOverLiveTui`'s own pre-checks, carrying the code a
 * `session_takeover` frame must answer with. The HTTP route reports only the
 * message, so throwing a typed error instead of a plain one changes nothing
 * for direct callers and everything for a phone, which needs a code to route
 * the cause to the right screen instead of parsing prose.
 */
class TakeoverRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** What `verifySessionClaim` decided about a session-open request. */
type SessionClaim =
  | { verdict: "proceed"; row: SessionSummary }
  /** Already held: the idempotent answer is the agent that holds it. */
  | { verdict: "held"; agentId: AgentId }
  | { verdict: "refuse"; code: string; message: string };

/**
 * Verify a `session_takeover` or `session_resume` request against the index
 * this daemon itself would answer a `sessions` query from. The one verifier
 * both frames call, the way `validateSessionQuery` is the one validator the
 * HTTP route and the `sessions` frame share, so neither frame can grow a
 * weaker door than the other.
 *
 * The caller's `cwd` and `pid` are echoes of an index row the client once
 * saw, not credentials: they are compared against a freshly built row, and
 * a mismatch refuses naming the cause rather than trusting the echo, because
 * `session/load` resolves the session file under the directory it is handed
 * and a recycled pid means the process the caller pointed at is not the one
 * holding the transcript. A row already held by an agent is a "held"
 * verdict rather than a refusal: spawning a second holder would put two
 * writers on one session file, the exact corruption `takeOverTuiSession`'s
 * own refusal exists to prevent, and the idempotent answer satisfies the
 * caller's actual intent.
 */
async function verifySessionClaim(
  index: SessionIndex,
  sessionId: string,
  claimed: { cwd: string; pid?: number },
  want: "live-tui" | "dormant",
): Promise<SessionClaim> {
  const row = await index.get(sessionId);
  if (!row) {
    return { verdict: "refuse", code: "unknown_session", message: `no session ${sessionId} exists on this daemon` };
  }
  // Checked before anything the caller said: the daemon's own roster is the
  // more specific, independently reconciled source of truth for a session it
  // holds, exactly as it outranks a client-presence file in the index build.
  if (row.status === "live-ompd") {
    return row.agentId !== undefined
      ? { verdict: "held", agentId: row.agentId }
      : {
          verdict: "refuse",
          code: "already_held",
          message: `session ${sessionId} is held by an agent with no id in the index`,
        };
  }
  if (row.status !== want) {
    const wanted = want === "live-tui" ? "a live TUI" : "dormant";
    return {
      verdict: "refuse",
      code: want === "live-tui" ? "not_live_tui" : "not_dormant",
      message: `session ${sessionId} is ${row.status}, not ${wanted}`,
    };
  }
  if (row.cwd === null) {
    return {
      verdict: "refuse",
      code: "cwd_mismatch",
      message: `session ${sessionId} has no decodable cwd to verify the request against`,
    };
  }
  if (row.cwd !== claimed.cwd) {
    return {
      verdict: "refuse",
      code: "cwd_mismatch",
      message: `session ${sessionId} lives in ${row.cwd}, not ${claimed.cwd}`,
    };
  }
  if (want === "live-tui" && row.pid !== claimed.pid) {
    return {
      verdict: "refuse",
      code: "pid_mismatch",
      message: `session ${sessionId} is held by pid ${row.pid}, not ${claimed.pid}`,
    };
  }
  return { verdict: "proceed", row };
}

/**
 * Loopback by default. Reaching this daemon from elsewhere must be a separate,
 * deliberate act (a tunnel the operator starts), never a default anyone
 * inherits by running it.
 */
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_VERSION = "0.1.0";

/** Frames a socket may burst, and its steady-state allowance. */
const RATE_BURST = 50;
const RATE_PER_SECOND = 10;
/** ACP owns streaming backpressure; only cap an individual tunneled JSON-RPC frame. */
const MAX_TUI_ACP_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * Cap on the text of one `tui_activity` frame. Activity is a hint about a row
 * a phone is watching, not a transcript transport; a bridge that tried to ship
 * a whole answer through it would be using the wrong frame, and this cap is
 * what makes that misuse cost one refused frame instead of a flooded client.
 */
const MAX_TUI_ACTIVITY_TEXT_BYTES = 64 * 1024;

/**
 * How long a `tui_takeover` request waits for the terminal to release its
 * renderer. Generous for a terminal that is mid-turn and answers late, short
 * enough that a build with no takeover support refuses instead of hanging.
 */
const TAKEOVER_ACK_TIMEOUT_MS = 15_000;

/**
 * Clones one socket may have running at once.
 *
 * A clone is the one frame here that spends minutes of disk and network on a
 * single tap, and a phone in a pocket can send a lot of taps. The rate limiter
 * bounds frames per second, which is the wrong unit for work that outlives the
 * frame that started it; this bounds the work.
 */
const MAX_CLONES_PER_SOCKET = 3;

/** The only scopes a device row may carry. Anything else is a typo, not a grant. */
const KNOWN_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE];

/**
 * The scope ceiling every path that grants a device enforces, HTTP route and
 * socket frame alike: each requested scope must be a name this daemon knows,
 * and a device may never mint one more powerful than itself. Shared rather
 * than copied, because a hub-relayed phone reaches the frame while a direct
 * caller reaches the route, and a door that differs between the two is a
 * privilege escalation waiting to be found. Refused rather than clamped, and
 * nothing is consumed on refusal, so the right approver can still try again.
 */
function narrowGrantedScopes(
  requested: readonly unknown[],
  held: ReadonlySet<string>,
): { granted: string[] } | { error: "unknown_scope" } | { error: "scope_escalation"; missing: string[] } {
  const scopes: string[] = [];
  for (const scope of requested) {
    if (typeof scope !== "string" || !KNOWN_SCOPES.includes(scope)) return { error: "unknown_scope" };
    scopes.push(scope);
  }
  const missing = scopes.filter(scope => !held.has(scope));
  if (missing.length > 0) return { error: "scope_escalation", missing };
  return { granted: scopes };
}

/**
 * The slice of the voice bridge the gateway needs.
 *
 * Declared structurally so the gateway never imports the voice package: the
 * two slices are wired together by whoever builds the daemon, and a test double
 * satisfies this just as well as the real bridge.
 */
export interface VoiceHandler {
  handleFrame(frame: ClientFrame, actor: Actor): Promise<void>;
  close(): void | Promise<void>;
}

/**
 * Built once per socket so the bridge can push speech back down that socket.
 *
 * The actor comes with it because voice belongs to a device, not a
 * connection: a phone that drops and reconnects is the same paired device and
 * should still be spoken to, and a desktop attached to the same agent is a
 * different device and should not be.
 */
export type VoiceHandlerFactory = (send: (frame: ServerFrame) => void, actor: Actor) => VoiceHandler;

/**
 * The slice of the scheduler the gateway needs, declared structurally for the
 * same reason `VoiceHandler` is: the two are wired together by whoever builds
 * the daemon, and neither has to import the other.
 */
export interface WebhookFireAttempt {
  accepted: boolean;
  reason?: "not_found" | "forbidden";
  run?: Run;
}

export interface RoutineRunner {
  runNow(routineId: string, actor: Actor): Promise<Run>;
  fireWebhook(routineId: string, presentedSecret: string): Promise<WebhookFireAttempt>;
  /**
   * Delete routines for good, with per-id results. On the runner rather than
   * the store because only the scheduler knows whether a run is in flight.
   */
  deleteRoutines(routineIds: readonly string[]): Promise<RoutineDeleteResult[]>;
}

/**
 * The slice of the workspace skills catalogue the gateway needs, declared
 * structurally like `RoutineRunner`: `../workspace/skills.ts` does not know
 * this file exists.
 */
export interface SkillCatalog {
  list(cwd?: string): Promise<SkillSummary[]>;
}

/** The connector counterpart to `SkillCatalog`. */
export interface ConnectorCatalog {
  list(cwd?: string): Promise<ConnectorSummary[]>;
}

/**
 * The MCP auth broker, as the gateway is allowed to see it.
 *
 * Every method here returns identifiers, states and URLs. There is
 * deliberately no method that returns a token, a refresh token or a client
 * secret, so no route can be written that leaks one by accident: the type
 * itself refuses. `authorizationUrl` is the one URL that crosses the wire and
 * it is a public endpoint carrying a PKCE challenge, not a credential.
 */
export interface McpAuthCatalog {
  status(): McpAuthStatus;
  beginLogin(input: { resourceUrl: string; name?: string }): Promise<{ flowId: string; authorizationUrl: string }>;
  loginProgress(
    flowId: string,
  ): { state: "pending" | "complete" | "failed"; grantId?: string; serverName?: string; detail?: string } | undefined;
  refresh(
    grantId: string,
  ): Promise<{ outcome: "ok" | "definitive" | "transient"; state: McpAuthState; detail?: string }>;
  forget(grantId: string): boolean;
  importFromOmp(input: { dryRun: boolean; force: boolean }): Promise<McpAuthImportReport>;
  apply(): Promise<McpAuthApplyReport>;
  unapply(): Promise<{ removed: string[] }>;
}

export interface McpAuthImportReport {
  refused?: "broker_running";
  dryRun: boolean;
  imported: Array<{ grantId: string; serverName: string; resourceUrl: string; recoveredTokenUrl: boolean }>;
  skipped: Array<{ resourceUrl: string; reason: string }>;
}

export interface McpAuthApplyReport {
  applied: Array<{ serverName: string; brokerName: string; url: string }>;
  disabled: string[];
  /**
   * Grants deliberately left unwired, and why.
   *
   * `apply` also disables the original server's own definition, so wiring a
   * grant that cannot serve would replace something that works today with a
   * 503. These are reported rather than written, and the next `apply` picks
   * them up once a person has authorized them.
   */
  skipped: Array<{ serverName: string; state: McpAuthState; detail: string }>;
}

/**
 * The two persisted settings that may move between daemons. Binding, hub,
 * binary and credential settings deliberately have no place in this surface.
 * Lives in the core contracts now that the socket frames carry it, so the
 * wire and the seam cannot drift apart; re-exported because daemon-side code
 * and tests reach it through this module.
 */
export type { SyncSettings };

export interface SyncConfig {
  read(): SyncSettings;
  apply(settings: SyncSettings): void;
}
const SYNC_DOCUMENT_KEYS: Record<string, true> = {
  policyMode: true,
  keepAwake: true,
  routines: true,
  skills: true,
  connectors: true,
};
const SYNC_ROUTINE_KEYS: Record<string, true> = {
  id: true,
  name: true,
  enabled: true,
  trigger: true,
  actions: true,
  singleton: true,
  labels: true,
  createdAt: true,
};
const FORBIDDEN_SYNC_KEY = /(token|credential|bearer|authorization|process|pid|host)/i;

/**
 * Whether a client-supplied `deliverAs` is one omp's prompt flow accepts.
 *
 * `nextTurn` is deliberately absent: `pi.sendUserMessage` has no such mode, so
 * accepting it here would mean the extension either refused it later, where no
 * client is listening, or downgraded it to a steer, delivering the operator's
 * words at a moment they did not choose.
 */
function isTuiSteerDelivery(value: unknown): value is TuiSteerDelivery {
  return value === "steer" || value === "followUp";
}

/** Whether a TUI-supplied activity kind is one the daemon forwards. */
function isTuiActivityKind(value: unknown): value is TuiActivityKind {
  return value === "assistant_text" || value === "turn_start" || value === "turn_end";
}

function hasForbiddenSyncField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenSyncField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => (key !== "secretRef" && FORBIDDEN_SYNC_KEY.test(key)) || hasForbiddenSyncField(child),
  );
}

function isTrigger(value: unknown): value is Routine["trigger"] {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  const keys = Object.keys(value);
  switch (value.kind) {
    case "manual":
      return keys.length === 1;
    case "interval":
      return (
        keys.every(key => key === "kind" || key === "seconds") &&
        typeof value.seconds === "number" &&
        Number.isFinite(value.seconds)
      );
    case "cron":
      return (
        keys.every(key => key === "kind" || key === "expression" || key === "timezone") &&
        typeof value.expression === "string" &&
        (value.timezone === undefined || typeof value.timezone === "string")
      );
    case "webhook":
      return keys.every(key => key === "kind" || key === "secretRef") && typeof value.secretRef === "string";
    default:
      return false;
  }
}

function isSyncAction(value: unknown): value is SyncRoutine["actions"][number] {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.some(
      key =>
        key !== "id" &&
        key !== "name" &&
        key !== "prompt" &&
        key !== "cwd" &&
        key !== "timeoutSeconds" &&
        key !== "labels",
    )
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.prompt === "string" &&
    typeof value.cwd === "string" &&
    (value.timeoutSeconds === undefined || typeof value.timeoutSeconds === "number") &&
    isRecord(value.labels) &&
    Object.values(value.labels).every(label => typeof label === "string")
  );
}

function isSyncRoutine(value: unknown): value is SyncRoutine {
  if (
    !isRecord(value) ||
    hasForbiddenSyncField(value) ||
    Object.keys(value).some(key => SYNC_ROUTINE_KEYS[key] !== true)
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.enabled === "boolean" &&
    isTrigger(value.trigger) &&
    Array.isArray(value.actions) &&
    value.actions.every(isSyncAction) &&
    typeof value.singleton === "boolean" &&
    isRecord(value.labels) &&
    Object.values(value.labels).every(label => typeof label === "string") &&
    typeof value.createdAt === "string"
  );
}

const ROUTINE_DRAFT_KEYS: Record<string, true> = {
  name: true,
  enabled: true,
  trigger: true,
  actions: true,
  singleton: true,
  labels: true,
};
const ROUTINE_ACTION_DRAFT_KEYS: Record<string, true> = {
  id: true,
  name: true,
  prompt: true,
  cwd: true,
  timeoutSeconds: true,
  labels: true,
};
const CRON_TRIGGER_KEYS: Record<string, true> = { kind: true, expression: true, timezone: true };
const INTERVAL_TRIGGER_KEYS: Record<string, true> = { kind: true, seconds: true };
const BARE_TRIGGER_KEYS: Record<string, true> = { kind: true };

/**
 * The first key a caller sent that the surface does not accept, or undefined.
 *
 * The key's name and not merely the fact of it, because these reasons are the
 * whole of what a caller has to fix its request from: "invalid" tells an agent
 * to guess, and an agent that guesses retries.
 */
function firstUnknownKey(value: Record<string, unknown>, allowed: Record<string, true>): string | undefined {
  return Object.keys(value).find(key => allowed[key] !== true);
}

/** A flat label map, as a guard so a parsed draft is typed rather than asserted. */
function isLabelMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every(label => typeof label === "string");
}

/**
 * A caller-supplied trigger, or one sentence saying what is wrong with it.
 *
 * The whole draft/patch family answers with a reason string rather than
 * `null`, because that reason is carried out on the 400 and is the only thing
 * a caller has to correct its request from. A bare "invalid" costs a retry
 * loop where a named field costs one fix.
 *
 * Unknown keys are refused rather than dropped, exactly as `isSyncRoutine`
 * does and for the same reason: a body carrying a field this surface has never
 * heard of comes from a caller that believes something is being configured,
 * and quietly keeping the recognisable half reports success for a request that
 * was only half understood.
 */
function parseTriggerDraft(value: unknown): TriggerDraft | string {
  if (!isRecord(value)) return "trigger must be an object naming a kind";
  switch (value.kind) {
    case "manual": {
      const unknown = firstUnknownKey(value, BARE_TRIGGER_KEYS);
      if (unknown !== undefined) return `a manual trigger takes no other field, so "${unknown}" cannot be honoured`;
      return { kind: "manual" };
    }
    case "webhook": {
      // Refused rather than ignored, and named as the daemon's job rather than
      // reported as an unknown key: a caller supplying its own `secretRef`
      // believes it is choosing the credential row this endpoint checks
      // against, and two routines pointed at one row means rotating either
      // silently breaks the other.
      if ("secretRef" in value) {
        return (
          "a webhook trigger must not carry secretRef: the daemon mints it, and " +
          "POST /v1/routines/:id/webhook-secret is where a secret value is issued"
        );
      }
      const unknown = firstUnknownKey(value, BARE_TRIGGER_KEYS);
      if (unknown !== undefined) return `a webhook trigger takes no other field, so "${unknown}" cannot be honoured`;
      return { kind: "webhook" };
    }
    case "interval": {
      const unknown = firstUnknownKey(value, INTERVAL_TRIGGER_KEYS);
      if (unknown !== undefined) {
        return `an interval trigger takes kind and seconds, so "${unknown}" cannot be honoured`;
      }
      const seconds = value.seconds;
      // Whole seconds, matching what the MCP schema accepts and what the store
      // has column semantics for. Two write doors that disagree about what is
      // legal is a shared contract in name only: a fraction accepted here is a
      // routine an MCP caller cannot restate and a reader cannot reason about.
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
        return "trigger.seconds must be a finite number greater than 0";
      }
      if (!Number.isInteger(seconds)) return "trigger.seconds must be a whole number of seconds";
      return { kind: "interval", seconds };
    }
    case "cron": {
      const unknown = firstUnknownKey(value, CRON_TRIGGER_KEYS);
      if (unknown !== undefined) {
        return `a cron trigger takes kind, expression and timezone, so "${unknown}" cannot be honoured`;
      }
      const expression = value.expression;
      const timezone = value.timezone;
      if (typeof expression !== "string" || expression.trim().length === 0) {
        return "trigger.expression must be a non-empty cron expression";
      }
      if (timezone !== undefined && (typeof timezone !== "string" || timezone.trim().length === 0)) {
        return "trigger.timezone must be a non-empty IANA timezone name when present";
      }
      // The scheduler's own call, not a second parser: `nextFireTime` is what
      // arms every fire, and it resolves the zone through `Intl` as well as
      // parsing the expression. Checking only the expression left an unknown or
      // empty zone to throw on the first tick, which arms nothing and says so
      // nowhere a caller is listening.
      try {
        nextFireTime(expression, new Date(), timezone);
      } catch (err) {
        const detail = err instanceof Error ? err.message : "unparsable";
        return `trigger is not a schedule this daemon can run: ${detail}`;
      }
      return timezone === undefined ? { kind: "cron", expression } : { kind: "cron", expression, timezone };
    }
    default:
      return "trigger.kind must be one of cron, interval, manual, webhook";
  }
}

function parseRoutineActionDraft(value: unknown, index: number): RoutineActionDraft | string {
  if (!isRecord(value)) return `actions[${index}] must be an object`;
  const unknown = firstUnknownKey(value, ROUTINE_ACTION_DRAFT_KEYS);
  if (unknown !== undefined) {
    return (
      `actions[${index}] carries an unknown key "${unknown}": ` +
      "an action takes id, name, prompt, cwd, timeoutSeconds and labels"
    );
  }
  const { id, name, prompt, cwd, timeoutSeconds, labels } = value;
  if (id !== undefined && (typeof id !== "string" || id.length === 0)) {
    return `actions[${index}].id must be a non-empty string when present`;
  }
  if (typeof name !== "string" || name.trim().length === 0) return `actions[${index}].name must be a non-empty string`;
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    return `actions[${index}].prompt must be a non-empty string`;
  }
  // Absolute, because a relative path is resolved against whatever directory
  // the daemon happens to have been started in, which is not a place the
  // caller can see and not the same place twice.
  if (typeof cwd !== "string" || cwd.length === 0) return `actions[${index}].cwd must be a non-empty absolute path`;
  if (!cwd.startsWith("/")) return `actions[${index}].cwd must be an absolute path, so "${cwd}" cannot be honoured`;
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)
  ) {
    return `actions[${index}].timeoutSeconds must be a finite number greater than 0 when present`;
  }
  // Whole seconds, for the reason `trigger.seconds` is: the MCP schema accepts
  // only integers, and a surface that takes a fraction the other one refuses
  // means a routine one door created cannot be restated through the other.
  if (timeoutSeconds !== undefined && !Number.isInteger(timeoutSeconds)) {
    return `actions[${index}].timeoutSeconds must be a whole number of seconds`;
  }
  if (labels !== undefined && !isLabelMap(labels)) {
    return `actions[${index}].labels must be an object whose every value is a string`;
  }
  return {
    ...(id === undefined ? {} : { id }),
    name: name.trim(),
    prompt,
    cwd,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(labels === undefined ? {} : { labels }),
  };
}

function parseRoutineActionDrafts(value: unknown): RoutineActionDraft[] | string {
  if (!Array.isArray(value)) return "actions must be an array of actions";
  if (value.length === 0) {
    return "actions must name at least one action: a routine with none is a schedule that does nothing";
  }
  const drafts: RoutineActionDraft[] = [];
  for (const [index, action] of value.entries()) {
    const draft = parseRoutineActionDraft(action, index);
    if (typeof draft === "string") return draft;
    drafts.push(draft);
  }
  return drafts;
}

/** A complete routine definition as a caller may state it, or the reason it was refused. */
function parseRoutineDraft(value: unknown): RoutineDraft | string {
  if (!isRecord(value)) return "a routine draft must be a JSON object";
  const unknown = firstUnknownKey(value, ROUTINE_DRAFT_KEYS);
  if (unknown !== undefined) {
    return `unknown key "${unknown}": a routine draft takes name, enabled, trigger, actions, singleton and labels`;
  }
  const { name, enabled, singleton, labels } = value;
  if (typeof name !== "string" || name.trim().length === 0) return "name must be a non-empty string";
  if (enabled !== undefined && typeof enabled !== "boolean") return "enabled must be a boolean when present";
  if (singleton !== undefined && typeof singleton !== "boolean") return "singleton must be a boolean when present";
  if (labels !== undefined && !isLabelMap(labels)) return "labels must be an object whose every value is a string";
  const trigger = parseTriggerDraft(value.trigger);
  if (typeof trigger === "string") return trigger;
  const actions = parseRoutineActionDrafts(value.actions);
  if (typeof actions === "string") return actions;
  return {
    // Trimmed, so the name the store holds is the one validation approved
    // rather than one with invisible padding a later lookup would miss.
    name: name.trim(),
    ...(enabled === undefined ? {} : { enabled }),
    trigger,
    actions,
    ...(singleton === undefined ? {} : { singleton }),
    ...(labels === undefined ? {} : { labels }),
  };
}

/**
 * A partial edit, or the reason it was refused.
 *
 * Every field is copied onto the result only when the caller actually sent
 * the key, so the returned patch carries presence and not merely value. That
 * is what lets the route apply it by spread: absent stays absent, and
 * `labels: {}` stays a real instruction to clear every label.
 */
function parseRoutinePatch(value: unknown): RoutinePatch | string {
  if (!isRecord(value)) return "a routine patch must be a JSON object";
  const unknown = firstUnknownKey(value, ROUTINE_DRAFT_KEYS);
  if (unknown !== undefined) {
    return `unknown key "${unknown}": a routine patch takes name, enabled, trigger, actions, singleton and labels`;
  }
  const { name, enabled, singleton, labels } = value;
  const patch: RoutinePatch = {};
  if ("name" in value) {
    if (typeof name !== "string" || name.trim().length === 0) return "name must be a non-empty string";
    patch.name = name.trim();
  }
  if ("enabled" in value) {
    if (typeof enabled !== "boolean") return "enabled must be a boolean";
    patch.enabled = enabled;
  }
  if ("singleton" in value) {
    if (typeof singleton !== "boolean") return "singleton must be a boolean";
    patch.singleton = singleton;
  }
  if ("labels" in value) {
    if (!isLabelMap(labels)) return "labels must be an object whose every value is a string";
    patch.labels = labels;
  }
  if ("trigger" in value) {
    const trigger = parseTriggerDraft(value.trigger);
    if (typeof trigger === "string") return trigger;
    patch.trigger = trigger;
  }
  if ("actions" in value) {
    const actions = parseRoutineActionDrafts(value.actions);
    if (typeof actions === "string") return actions;
    patch.actions = actions;
  }
  return patch;
}

/**
 * A daemon-minted id, in the one shape every other daemon-minted id uses:
 * `createAgentId`'s `agt_`, the scheduler's `run_`, and here `rtn_`, `act_`
 * and `whsec_`. The prefix names the kind, so an id read out of a log or an
 * audit row says what it addresses without a lookup.
 */
function mintId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * A drafted action as the store holds it.
 *
 * The host is forced local rather than read from the draft, the same thing
 * `/v1/sync/import` and the app's `routine_write` frame both do: an execution
 * host carries image, mounts and network policy, so a definition allowed to
 * name one turns "schedule a prompt" into "mount any path on this machine".
 *
 * An id is minted only when the draft named none, so an edit that re-sends an
 * action keeps the id its recorded runs already point at.
 */
function materialiseAction(draft: RoutineActionDraft): RoutineAction {
  return {
    id: draft.id ?? mintId("act"),
    name: draft.name,
    prompt: draft.prompt,
    cwd: draft.cwd,
    host: { kind: "local" },
    ...(draft.timeoutSeconds === undefined ? {} : { timeoutSeconds: draft.timeoutSeconds }),
    labels: draft.labels ?? {},
  };
}

/** Runs returned beside one routine when the caller names no `runLimit`. */
const ROUTINE_RUNS_DEFAULT = 10;
/** Ceiling on `runLimit`: one response answers "show me more", not "show me everything". */
const ROUTINE_RUNS_MAX = 50;

function parseSyncDocument(value: unknown): SyncDocument | null {
  if (!isRecord(value) || hasForbiddenSyncField(value)) return null;
  if (Object.keys(value).some(key => SYNC_DOCUMENT_KEYS[key] !== true)) return null;
  if (
    (value.policyMode !== "strict" && value.policyMode !== "standard" && value.policyMode !== "trusted") ||
    typeof value.keepAwake !== "boolean" ||
    !Array.isArray(value.routines) ||
    !Array.isArray(value.skills) ||
    !Array.isArray(value.connectors) ||
    !value.routines.every(isSyncRoutine)
  ) {
    return null;
  }
  return value as unknown as SyncDocument;
}

const SYNC_SETTINGS_KEYS: Record<string, true> = {
  policyMode: true,
  keepAwake: true,
};

/**
 * The exact body `/v1/sync-settings` accepts. Unknown fields are refused
 * rather than dropped: this surface moves two settings and nothing else, so a
 * body carrying more is aimed at the wrong endpoint, and silently accepting
 * the recognizable parts would let that mistake pass as a success.
 */
/**
 * A catalogue read's optional scoping fields, checked at the socket door
 * before the shared path runs: the wire is not a place to assume the frame
 * kept to the contract. A type guard rather than inline checks so the frame
 * narrows to `CatalogQuery` for the shared call.
 */
function isCatalogQuery(frame: object): frame is CatalogQuery {
  const query = frame as { cwd?: unknown; agentId?: unknown };
  return (
    (query.cwd === undefined || typeof query.cwd === "string") &&
    (query.agentId === undefined || typeof query.agentId === "string")
  );
}

function parseSyncSettings(value: unknown): SyncSettings | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some(key => SYNC_SETTINGS_KEYS[key] !== true)) return null;
  if (
    (value.policyMode !== "strict" && value.policyMode !== "standard" && value.policyMode !== "trusted") ||
    typeof value.keepAwake !== "boolean"
  ) {
    return null;
  }
  return { policyMode: value.policyMode, keepAwake: value.keepAwake };
}
/**
 * The slice of task lifecycle the gateway needs. `create` and `cancel` take
 * the resolved `Actor` and are expected to authorize it themselves -- see
 * `TaskManager` in `../workspace/tasks.ts` -- so the scope checks below are
 * the same defence-in-depth `/v1/agents/:id/prompt` already has, not the only
 * ones.
 */
/** How a skills/connectors catalogue query is scoped: `cwd` wins, else the agent's own. */
export interface CatalogQuery {
  cwd?: string;
  agentId?: string;
}

/**
 * What one shared Cowork capability answered, as facts rather than wire
 * shapes. The HTTP door maps these onto status codes and the socket door onto
 * frames, so the two cannot disagree about what happened, only about how to
 * say it.
 */
export type CoworkListOutcome<T> =
  | { kind: "ok"; value: T }
  /** No catalogue wired into this daemon build: the feature is off, not empty. */
  | { kind: "off" }
  /** The query named an agent this daemon holds no row for. */
  | { kind: "unknown-agent" }
  | { kind: "failed"; error: string };

/** A task mutation's answer, on the same shared-facts rule as the reads. */
export type TaskOutcome =
  | { kind: "ok"; value: Task }
  | { kind: "off" }
  | { kind: "bad"; error: string }
  | { kind: "refused"; error: string }
  /** What was named does not exist, or the mutation could not run on it. */
  | { kind: "missing"; error: string };

/** An agent creation's answer, including the replica's queue-instead-of-run. */
export type AgentCreateOutcome =
  | { kind: "created"; agent: Agent }
  | { kind: "queued"; intent: QueuedIntent }
  | { kind: "bad"; error: string }
  | { kind: "refused"; error: string }
  | { kind: "failed"; error: string };

export interface TaskCatalog {
  get(id: string): Task | null;
  list(agentId?: string): Task[];
  create(input: CreateTaskInput, actor: Actor): Promise<Task>;
  cancel(id: string, actor: Actor): Promise<Task>;
}

/**
 * Replica-only write buffering and the credential a local delegate presents
 * while pulling it. A non-replica can expose no queue and remains a normal
 * direct-execution gateway.
 */
export interface FederationIntentQueue {
  replica: boolean;
  syncToken: string;
}

export interface SyncRoutine {
  id: string;
  name: string;
  enabled: boolean;
  trigger: Routine["trigger"];
  actions: Array<Omit<Routine["actions"][number], "host">>;
  singleton: boolean;
  labels: Record<string, string>;
  createdAt: string;
}

export interface SyncDocument extends SyncSettings {
  routines: SyncRoutine[];
  skills: SkillSummary[];
  connectors: ConnectorSummary[];
}

export const DEFAULT_MAX_SOCKET_BUFFER_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface GatewayOptions {
  /**
   * Maximum bytes permitted in a socket outbound buffer before closing with 1013 backpressure.
   * Defaults to 8 MiB.
   */
  maxSocketBufferBytes?: number;
  supervisor: Supervisor;
  store: Store;
  /**
   * Set only on the cloud replica. The sync token serves `/v1/sync/intents`;
   * it is deliberately distinct from paired-device bearer credentials.
   */
  federation?: FederationIntentQueue;
  /**
   * The same `GatewayEvents` instance handed to the supervisor as its event
   * sink. Without it the HTTP surface still works and the socket still accepts
   * frames, but nothing is pushed.
   */
  events?: GatewayEvents;
  /**
   * Where a bug in a request handler is reported.
   *
   * Server side only, and deliberately not part of the response: a stack from
   * this process names filesystem paths and internals that a remote client has
   * no business reading.
   */
  onError?: (err: Error) => void;
  onLog?: (message: string) => void;
  host?: string;
  /** 0 asks the OS for a free port; read the real one back from `listen()`. */
  port?: number;
  version?: string;
  /**
   * Whether the collab relay at /r/<roomId> can be upgraded by non-loopback
   * peers. Off by default: the relay is unauthenticated by design, so exposing
   * it beyond loopback must be an explicit choice.
   */
  exposeCollabRelay?: boolean;
  /**
   * Peer address resolver for the relay upgrade guard. Injectable so tests can
   * supply a fake remote address without spinning up a separate network.
   */
  requestAddress?: (req: Request, server: Server<any>) => string | null;
  /**
   * Opaque identity of the state directory this daemon serves.
   *
   * Published on `/v1/health` so a second `ompd start` can tell "that is me
   * already running" from "something else owns this port". Without it the CLI
   * treats any healthy listener as itself and silently points the operator at
   * a foreign daemon with a different token.
   */
  homeId?: string;
  /** How long an unapproved pairing stays claimable. */
  pairingTtlMs?: number;
  /**
   * How long a `tui_takeover` waits for the terminal to release its renderer.
   * Injectable so a test can assert the refusal without waiting out a clock.
   */
  takeoverAckTimeoutMs?: number;
  voice?: VoiceHandlerFactory;
  /**
   * Called when a device sends a typed prompt.
   *
   * Exists so voice can follow the modality a device most recently used: it
   * speaks, it hears; it types, it stops hearing. The gateway does not know
   * what that means, only that it happened.
   */
  onTextPrompt?: (agentId: AgentId, actor: Actor) => void;
  /**
   * Runs routines on demand. Absent, `POST /v1/routines/:id/run` reports the
   * feature off rather than pretending to have queued something.
   */
  routines?: RoutineRunner;
  /**
   * Owns the durable, non-secret configuration sync settings. The gateway
   * asks this seam for every export and calls it before reporting an import,
   * rather than making a constructor-time config copy authoritative.
   */
  syncConfig?: SyncConfig;
  /**
   * Reads and writes a session's ACP config options (mode, model). Absent,
   * `/v1/agents/:id/config` reports the feature off rather than inventing a
   * mode the agent has never heard of.
   */
  sessions?: SessionConfig;
  /**
   * Directory of built web-client files served from `/`.
   *
   * Unauthenticated on purpose: it is the app shell, and a browser has to load
   * it before it can present a token. Nothing about this machine's agents is
   * in it. Absent, the gateway is API-only.
   */
  staticRoot?: string;
  /**
   * Called with the replacement a rotation minted, before the response goes
   * out. Returns the path it persisted the token to, if it persisted it.
   *
   * The daemon uses it to rewrite `<home>/token` when the local operator's
   * credential is the one rotating, so a rotation performed from a phone does
   * not lock the CLI on this machine out of its own daemon. The gateway itself
   * knows nothing about the state directory, and reports back only so the
   * answer can say which file moved rather than guessing.
   */
  onTokenRotated?: (deviceId: string, token: string) => string | undefined;
  /** Fails in-flight actions when their registered target disappears. */
  onWebViewUnavailable?: (agentId: AgentId) => void;
  /**
   * The skills-and-commands catalogue. Absent, `GET /v1/skills` reports the
   * feature off rather than an empty catalogue, which a client would read as
   * "this workspace has no skills" instead of "this daemon build has no
   * catalogue wired in".
   */
  skills?: SkillCatalog;
  /** The connector counterpart to `skills`. Absent, `GET /v1/connectors` reports the feature off the same way. */
  connectors?: ConnectorCatalog;
  /**
   * The MCP auth broker. Absent, every `/v1/mcp-auth*` route reports the
   * feature off, so an operator can tell "no grants yet" from "this daemon is
   * not brokering MCP auth at all" -- a distinction that matters here more
   * than most, because both look like a connector that stopped working.
   */
  mcpAuth?: McpAuthCatalog;
  /**
   * Task lifecycle. Absent, every `/v1/tasks*` route reports the feature off
   * rather than 404ing, so a client can tell "no such task" from "this
   * daemon build has no task tracking".
   */
  tasks?: TaskCatalog;
  /**
   * The filesystem-derived session catalog. Absent, every `/v1/sessions*`
   * route reports the feature off rather than an empty list, the same
   * distinction `skills`/`connectors`/`tasks` already draw between "nothing
   * here" and "this daemon build has no catalogue wired in".
   */
  sessionIndex?: SessionIndex;
  /**
   * Reads live endpoint offers from config and identity. Absent, `GET
   * /v1/endpoints` reports an empty offer list rather than an error: unlike
   * `skills`/`connectors`/`tasks`, "nothing reachable" is itself a real
   * answer this route can give, so there is no separate off-signal to draw.
   */
  endpoints?: () => EndpointOffer[];
  /**
   * Settles one action previously dispatched to a registered client WebView.
   * Returning false means the request is stale, unknown, or belongs elsewhere.
   */
  onWebViewResult?: (agentId: AgentId, requestId: string, result: WebViewActionResult) => boolean;
  /**
   * Browsing this machine, starting a session at a chosen directory, and
   * cloning into one. Absent, `fs_list`, `session_create` and `repo_clone`
   * report the feature off rather than answering: an unconfigured daemon
   * browses nothing, and "no roots configured" must never read as "the whole
   * filesystem".
   */
  filesystem?: FilesystemSurface;
}

interface LiveTuiSocket {
  sessionId: string;
  cwd: string;
  title: string | undefined;
  pid: number;
  agentId: AgentId | undefined;
  onAcpMessage: ((raw: string) => void) | undefined;
  onAcpClose: (() => void) | undefined;
}

interface PendingTuiTakeover {
  socket: GatewaySocket;
  actor: Actor;
  resolve: (agent: Agent) => void;
  reject: (error: Error) => void;
}

interface SocketState {
  deviceId: string;
  scopes: Set<string>;
  /** Agents this socket asked for. Nothing is pushed for anything else. */
  attached: Set<AgentId>;
  notifiedGoneSessions: Set<string>;
  /**
   * Highest seq already delivered, per agent. Replay and the live stream both
   * go through this, which is what guarantees a reattach has no duplicates.
   */
  delivered: Map<AgentId, number>;
  /**
   * Approval request ids already delivered, per agent. Serves the same purpose
   * as `delivered` does for updates: replay and the live push share one choke
   * point, so a reattach cannot show the same ask twice.
   */
  approvals: Map<AgentId, Set<string>>;
  /** Plan-review request ids already delivered, keyed like tool approvals. */
  planReviews: Map<AgentId, Set<string>>;
  /**
   * Highest turn already summarised to this socket, per agent. Serves the same
   * purpose `delivered` does for updates: a repeat is how a client ends up
   * saying the same sentence twice.
   */
  said: Map<AgentId, number>;
  bucket: TokenBucket;
  /**
   * Set when this device is revoked while the connection is live.
   *
   * Revocation is already enforced on every privileged call, because the
   * supervisor re-reads the device row before honouring one. What that misses
   * is a connection that has already attached and is only reading: it reaches
   * no supervisor call, so nothing re-checks it. This flag is what closes that
   * gap, and it closes it the same way for every transport.
   *
   * A flag rather than closing the socket, because `stop(true)` deadlocks on
   * Bun 1.3.4 if a socket was closed here first, as the note on `close` below
   * records. An inert socket is as good: it accepts no frame and is pushed
   * nothing.
   */
  revoked: boolean;
  voice: VoiceHandler | null;
  /** Stable member identity used to remove this exact socket from rooms. */
  collab: CollabConnection | null;
  /** Present only on the one socket serving a normal live TUI. */
  tui: LiveTuiSocket | null;
  /**
   * True once this socket asked for the session index with a `sessions`
   * frame. That ask is the opt-in for live `tui_activity`: a phone that
   * listed sessions is watching those rows and is pushed a terminal turn as
   * it happens, while a socket that never asked is pushed nothing. Connection
   * scoped on purpose: the client replays its query after a reconnect (the
   * same machinery that replays attachments), so the replay re-arms this, and
   * a socket that goes away stops watching by virtue of no longer being in
   * `#sockets`.
   */
  watchingSessions: boolean;
  /**
   * The session query this socket last asked with, so a watcher-driven push
   * re-serves the view it asked for instead of the unfiltered catalog.
   * Paired with `watchingSessions`: `{}` means asked-with-no-query, which is
   * a real ask and must still be pushed to, exactly as the client's replay
   * contract distinguishes it from never-asked.
   */
  sessionQuery: SessionQuery;
}
/**
 * Every shape an upgraded socket on this server may carry: an authenticated
 * gateway connection, or one leg of the content-blind collab relay. The two
 * never mix after upgrade, and the discriminant check at each websocket
 * handler is the only place they meet.
 */
type GatewaySocketData = SocketState | RelaySocketData;

/**
 * What the frame handler needs from a connection.
 *
 * A real `ServerWebSocket<SocketState>` satisfies this, and so does a tunnel
 * session, which is the point: one handler, one set of scope checks, and no
 * second authorization surface that can drift from this one.
 *
 * Deliberately structural in the transport and not in the payload. `data` stays
 * `SocketState` so every check below still reads a known shape; widening that
 * toward a loose record is how a scope check quietly starts trusting whatever
 * the caller put there.
 */
export interface GatewaySocket {
  data: SocketState;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
  /**
   * Number of bytes currently buffered in the transport awaiting flush.
   *
   * Bun ServerWebSocket implements this natively. For tunnel connections
   * tunneled through TunnelDaemon, frames are relayed immediately over the
   * shared hub WebSocket without per-session buffer measurement; where
   * unmeasurable, this returns undefined and the direct path enforces the cap.
   */
  getBufferedAmount?(): number;
}

/**
 * A live tunnel session, or the reason there is not one.
 *
 * The refusal reasons mirror `AuthVerdict` rather than flattening to a
 * boolean, because the tunnel audits which door closed and "unknown token"
 * and "revoked device" call for different responses from an operator.
 */
export type TunnelSessionResult =
  | {
      ok: true;
      deviceId: string;
      /** Hand one decrypted client frame to the shared handler. */
      deliver(raw: string): void;
      close(): void;
    }
  | { ok: false; reason: "unknown" | "revoked" };

export class Gateway {
  #sup: Supervisor;
  #store: Store;
  #federation: FederationIntentQueue | undefined;
  #auth: DeviceAuth;
  #events: GatewayEvents | undefined;
  #host: string;
  #port: number;
  #maxSocketBufferBytes: number;
  #hasClosedSockets = false;
  #version: string;
  #homeId: string | undefined;
  #voice: VoiceHandlerFactory | undefined;
  #onTextPrompt: ((agentId: AgentId, actor: Actor) => void) | undefined;
  #routines: RoutineRunner | undefined;
  #sessions: SessionConfig | undefined;
  #onTokenRotated: ((deviceId: string, token: string) => string | undefined) | undefined;
  #skills: SkillCatalog | undefined;
  #connectors: ConnectorCatalog | undefined;
  #mcpAuth: McpAuthCatalog | undefined;
  #syncConfig: SyncConfig | undefined;
  #tasks: TaskCatalog | undefined;
  #sessionIndex: SessionIndex | undefined;
  /**
   * The sessions-root watcher, running only while at least one socket has
   * asked for the index. Started lazily by the first `sessions` ask and
   * stopped when the last watcher disconnects or the gateway closes, so a
   * daemon nobody is listing sessions on holds no filesystem watch handle
   * at all.
   */
  #sessionWatch: SessionWatch | undefined;
  #endpoints: (() => EndpointOffer[]) | undefined;
  #filesystem: FilesystemSurface | undefined;
  /**
   * Clones in flight, per socket.
   *
   * Held here rather than on `SocketState` because the only two things that
   * ever consult it are the frame that starts a clone and the close that has
   * to stop one: an operator who walked into a lift must not leave `git`
   * running against a directory nobody is waiting for any more.
   */
  #clones = new Map<GatewaySocket, Set<CloneRun>>();
  #onWebViewResult: GatewayOptions["onWebViewResult"];
  #onWebViewUnavailable: GatewayOptions["onWebViewUnavailable"];
  #staticRoot: string | undefined;
  #onError: GatewayOptions["onError"];
  #onLog: GatewayOptions["onLog"];
  #collab: CollabRooms;
  /**
   * Guest legs into omp collab rooms. A different thing from `#collab`
   * above despite the neighbourly naming: that one is the daemon's own
   * voice-note rooms (the daemon as hub), this one is the daemon joining
   * rooms other terminals host. See `collab/guests.ts`.
   */
  #collabGuests: CollabGuests;
  #collabRelay = new CollabRelay();
  #exposeCollabRelay: boolean;
  #requestAddress: (req: Request, server: Server<any>) => string | null;

  /** Set by `listen`, so uptime measures serving rather than construction. */
  #startedAtMs: number | undefined;

  #server: Server<GatewaySocketData> | undefined;
  #sockets = new Set<GatewaySocket>();
  /** Most recently registered live WebView socket for each agent. */
  #webviews = new Map<AgentId, GatewaySocket>();
  #tuiTakeovers = new Map<string, PendingTuiTakeover>();
  #takeoverAckTimeoutMs: number;
  #unsubscribeSay: (() => void) | undefined;
  #unsubscribeRevoked: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(opts: GatewayOptions) {
    this.#sup = opts.supervisor;
    this.#exposeCollabRelay = opts.exposeCollabRelay ?? false;
    this.#requestAddress = opts.requestAddress ?? ((req, server) => server.requestIP(req)?.address ?? null);
    this.#store = opts.store;
    this.#collab = new CollabRooms(this.#store);
    this.#collabGuests = new CollabGuests({
      store: opts.store,
      authorize: (actor, scope, action, agentId) => this.#sup.authorize(actor, scope, action, agentId),
      // The same fan-out the supervisor's events ride, so guest-agent
      // updates reach attached sockets through the identical choke point.
      events: opts.events ?? { onUpdate: () => undefined, onAgentsChanged: () => undefined },
      sendToHostingTui: (sessionId, frame) => {
        const owner = [...this.#sockets].find(socket => socket.data.tui?.sessionId === sessionId);
        if (owner === undefined) return false;
        this.#send(owner, frame);
        return true;
      },
      sessionKnown: async sessionId => {
        const index = this.#sessionIndex;
        // Without an index the daemon cannot prove a session unknown, so it
        // falls through to `not_hosted`, which is true of every session no
        // registered TUI holds.
        if (index === undefined) return true;
        return (await index.get(sessionId)) != null;
      },
      // The daemon's own relay rides this same server (the /r/<roomId>
      // routes), so the loopback URL rooms are asked to live on is simply
      // this server's bound address. Null before listen(): a room cannot
      // be opened before the relay exists to host it.
      relayUrl: () => {
        const port = this.#server?.port;
        return port === undefined ? null : `ws://127.0.0.1:${port}`;
      },
    });
    if (opts.federation?.syncToken.trim() === "") throw new Error("federation sync token is required");
    this.#federation = opts.federation;
    this.#auth = new DeviceAuth({ store: opts.store, pairingTtlMs: opts.pairingTtlMs });
    this.#takeoverAckTimeoutMs = opts.takeoverAckTimeoutMs ?? TAKEOVER_ACK_TIMEOUT_MS;
    this.#events = opts.events;
    this.#host = opts.host ?? DEFAULT_HOST;
    this.#port = opts.port ?? 0;
    this.#maxSocketBufferBytes = opts.maxSocketBufferBytes ?? DEFAULT_MAX_SOCKET_BUFFER_BYTES;
    this.#version = opts.version ?? DEFAULT_VERSION;
    this.#homeId = opts.homeId;
    this.#voice = opts.voice;
    this.#onTextPrompt = opts.onTextPrompt;
    this.#routines = opts.routines;
    this.#sessions = opts.sessions;
    this.#onTokenRotated = opts.onTokenRotated;
    this.#syncConfig = opts.syncConfig;
    this.#skills = opts.skills;
    this.#connectors = opts.connectors;
    this.#mcpAuth = opts.mcpAuth;
    this.#tasks = opts.tasks;
    this.#sessionIndex = opts.sessionIndex;
    this.#endpoints = opts.endpoints;
    this.#filesystem = opts.filesystem;
    this.#onWebViewResult = opts.onWebViewResult;
    this.#onWebViewUnavailable = opts.onWebViewUnavailable;
    // Resolved once so the traversal check below compares two absolute paths.
    this.#staticRoot = opts.staticRoot === undefined ? undefined : resolve(opts.staticRoot);
    this.#onError = opts.onError;
    this.#onLog = opts.onLog;

    this.#unsubscribe = this.#events?.add({
      onUpdate: (agentId, seq, update) => {
        for (const ws of this.#sockets) {
          if (ws.data.attached.has(agentId)) this.#deliverUpdate(ws, agentId, seq, update);
        }
      },
      onAgentsChanged: agents => {
        // Attached sockets only, like the other two events. `hello` is what
        // does discovery; a socket watching no agent refreshes the list with
        // `GET /v1/agents` or by reconnecting, rather than being pushed to.
        for (const ws of this.#sockets) {
          if (ws.data.attached.size === 0) continue;
          if (ws.data.scopes.has(SCOPE_READ)) this.#send(ws, { t: "agents", agents });
        }
      },
      onApprovalNeeded: approval => {
        for (const ws of this.#sockets) {
          if (!ws.data.attached.has(approval.agentId)) continue;
          this.#deliverApproval(ws, approval);
        }
      },
      onPlanReviewNeeded: review => {
        for (const ws of this.#sockets) {
          if (!ws.data.attached.has(review.agentId)) continue;
          this.#deliverPlanReview(ws, review);
        }
      },
    });

    this.#unsubscribeSay = this.#events?.addSayListener(event => {
      for (const ws of this.#sockets) {
        // The same rule the other pushes follow: attached to that agent, and
        // holding read. Not a broadcast, and never to a socket that has not
        // asked about this agent.
        if (!ws.data.attached.has(event.agentId)) continue;
        if (!ws.data.scopes.has(SCOPE_READ)) continue;
        // One summary per turn per socket. A second copy of the same seq is
        // how a client ends up saying the same sentence twice.
        if ((ws.data.said.get(event.agentId) ?? 0) >= event.seq) continue;
        ws.data.said.set(event.agentId, event.seq);
        this.#send(ws, { t: "say", agentId: event.agentId, seq: event.seq, text: event.text });
      }
    });

    // Revocation is already enforced on every privileged call: the supervisor
    // re-reads the device row before honouring one. What that does not cover is
    // a socket that has already attached and is only reading, which reaches no
    // supervisor call and so re-checks nothing. Dropping the connection closes
    // that gap, and it closes it for every transport at once rather than for
    // whichever one remembered to ask.
    this.#unsubscribeRevoked = this.#auth.onRevoked(deviceId => {
      for (const ws of [...this.#sockets]) {
        if (ws.data.deviceId !== deviceId) continue;
        ws.data.revoked = true;
        this.#send(ws, { t: "error", code: "unauthorized", message: "this device has been revoked" });
        // Keep the TCP socket inert for Bun's stop behaviour, but revoke an
        // ACP leg immediately so a removed device cannot keep owning a TUI.
        this.#close(ws);
      }
    });
  }

  /** Start serving. Returns the bound port, which matters when `port` was 0. */
  async listen(): Promise<number> {
    this.#server ??= Bun.serve({
      hostname: this.#host,
      port: this.#port,
      fetch: (req, server) => this.#fetch(req, server),
      /**
       * 255, Bun's ceiling. The default 10s kills any request whose handler
       * legitimately waits out an agent turn before answering, which is what
       * the webhook route and `POST /v1/routines/:id/run` both do: a fire
       * observed live died at exactly 10s while its turn kept running. A turn
       * longer than the ceiling still loses its response (the run itself
       * completes); no larger value exists to hold it for.
       */
      idleTimeout: 255,
      /**
       * A request handler that throws is a bug in this daemon, and Bun's own
       * 500 body says only "Internal error" with the stack going nowhere. That
       * is indistinguishable from a route that deliberately answered 500,
       * which has already cost real time to tell apart.
       */
      error: (err: Error) => {
        this.#onError?.(err);
        return Response.json({ error: "internal_error" }, { status: 500 });
      },
      websocket: {
        open: (ws: ServerWebSocket<GatewaySocketData>) => {
          if (isRelaySocketData(ws.data)) return this.#collabRelay.open(this.#relaySocket(ws));
          this.#open(ws as ServerWebSocket<SocketState>);
        },
        message: (ws: ServerWebSocket<GatewaySocketData>, message: string | Buffer) => {
          if (isRelaySocketData(ws.data)) return this.#collabRelay.message(this.#relaySocket(ws), message);
          this.#message(ws as ServerWebSocket<SocketState>, message);
        },
        close: (ws: ServerWebSocket<GatewaySocketData>) => {
          if (isRelaySocketData(ws.data)) return this.#collabRelay.close(this.#relaySocket(ws));
          this.#close(ws as ServerWebSocket<SocketState>);
        },
      },
    });
    this.#startedAtMs ??= Date.now();

    // Bun reports no port for a unix-socket server. This one always binds TCP,
    // so an absent port means the listen did not do what was asked.
    const { port } = this.#server;
    if (port === undefined) throw new Error("gateway did not bind a TCP port");
    return port;
  }

  /**
   * The relay origin a collab host on this machine points at so the room
   * stays on it, in the shape omp's `CollabHost.start(relayUrl)` expects: a
   * bare origin it appends `/r/<roomId>` to itself. `ws://` rather than
   * `wss://`: omp's link grammar accepts plain ws only for local hosts, and
   * this daemon binds loopback unless the operator deliberately rebinds. A
   * wildcard bind still answers on loopback, so the URL names that.
   */
  get collabRelayUrl(): string {
    const port = this.#server?.port;
    if (port === undefined) throw new Error("gateway is not listening");
    const host = this.#host === "0.0.0.0" || this.#host === "::" ? "127.0.0.1" : this.#host;
    return `ws://${host}:${port}`;
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#unsubscribeSay?.();
    this.#unsubscribeSay = undefined;
    this.#unsubscribeRevoked?.();
    this.#unsubscribeRevoked = undefined;
    this.#disarmSessionWatcher();
    for (const ws of [...this.#sockets]) this.#close(ws);
    // Relay legs are not in `#sockets`; `stop(true)` tears them down with
    // everything else, and the room state dies with the server.
    // `stop(true)` closes live connections itself. Closing each socket here
    // first and then awaiting it deadlocks on Bun 1.3.4: the promise never
    // settles. Measured, not guessed. Clients therefore see an abnormal close
    // rather than a 1001, which is the right trade for a shutdown path that
    // actually returns.
    //
    // The same poison applies when a socket was closed server-side at ANY
    // point in the server's life, which the collab relay's refusals do by
    // design (4004/4009/4001 are its protocol). Reproduced on 1.3.14: the
    // await never settles, though the listen port is released synchronously
    // either way, so skipping the await costs nothing the shutdown order
    // relies on.
    const stopping = this.#server?.stop(true);
    if (!this.#collabRelay.hasClosedLegs && !this.#hasClosedSockets) await stopping;
    this.#server = undefined;
    this.#startedAtMs = undefined;
  }

  /**
   * Operator action. Turns a recorded pairing intent into a device with scopes.
   *
   * In-process, and the scopes it writes are the caller's choice rather than
   * the pairing client's. `POST /v1/pairings/approve` reaches this over HTTP,
   * but only for a device that already holds `approve`, and only for scopes
   * that device already holds. Nothing a client says at `POST /v1/pair`
   * influences either check, so pairing still grants nothing by itself.
   */
  approvePairing(code: string, scopes: string[]): string {
    return this.#auth.approvePairing(code, scopes).token;
  }

  /**
   * Admit a connection that arrived over a tunnel rather than over the port.
   *
   * The whole point is that this is not a second authorization surface. The
   * token goes to the same `authenticate` a local websocket uses, the identity
   * comes only from that verdict, and every frame afterwards runs the same
   * handler with the same scope checks. A caller cannot name a device, cannot
   * choose a scope, and cannot skip a check, because none of those are
   * parameters.
   *
   * Returns a refusal rather than throwing: the tunnel needs to say which door
   * closed so the daemon can audit it, and an exception collapses that back to
   * one outcome.
   */
  acceptTunnelSession(
    token: string,
    send: (raw: string) => void,
    getBufferedAmount?: () => number,
    onClose?: (code?: number, reason?: string) => void,
  ): TunnelSessionResult {
    const verdict = this.#auth.authenticate(token);
    if (!verdict.ok) {
      switch (verdict.reason) {
        case "unknown":
          return { ok: false, reason: "unknown" };
        case "revoked":
          return { ok: false, reason: "revoked" };
        default: {
          // A variant added later must break the build here rather than fall
          // through into an accidental admission.
          const exhaustive: never = verdict.reason;
          throw new Error(`unhandled auth verdict ${String(exhaustive)}`);
        }
      }
    }

    const ws: GatewaySocket = {
      data: this.#socketStateFor(verdict.actor),
      send,
      close: (code?: number, reason?: string) => {
        try {
          onClose?.(code, reason);
        } catch {}
        this.#close(ws);
      },
      getBufferedAmount,
    };
    this.#open(ws);
    return {
      ok: true,
      deviceId: verdict.actor.deviceId,
      deliver: raw => {
        this.#message(ws, raw);
      },
      close: () => {
        try {
          onClose?.();
        } catch {}
        this.#close(ws);
      },
    };
  }

  /**
   * The one place a `SocketState` is built.
   *
   * Both transports come through here, so scopes are resolved from the device
   * row exactly once and neither transport can supply its own.
   */
  #socketStateFor(actor: Actor): SocketState {
    return {
      deviceId: actor.deviceId,
      scopes: new Set(actor.scopes),
      attached: new Set(),
      notifiedGoneSessions: new Set(),
      watchingSessions: false,
      sessionQuery: {},
      delivered: new Map(),
      approvals: new Map(),
      planReviews: new Map(),
      said: new Map(),
      bucket: new TokenBucket({ capacity: RATE_BURST, refillPerSecond: RATE_PER_SECOND }),
      revoked: false,
      voice: null,
      collab: null,
      tui: null,
    };
  }

  /**
   * Mint a token for a device row that already exists.
   *
   * In-process only, and deliberately unreachable over HTTP: a route that
   * handed out a token for an arbitrary device id would be a way to impersonate
   * one. The daemon uses it for the local operator device, whose authority
   * comes from filesystem access rather than from pairing.
   */
  issueToken(deviceId: string): string {
    return this.#auth.issueToken(deviceId);
  }

  /**
   * Whether a raw token is still a live credential for that device, without
   * recording a use.
   *
   * In-process only. The daemon asks it of the token file it finds at startup,
   * which is how a plain restart reuses the operator's existing credential
   * instead of minting a new one and logging every other device out with it.
   */
  hasLiveToken(deviceId: string, token: string): boolean {
    return this.#auth.hasLiveToken(deviceId, token);
  }

  /**
   * Fan out a complete agent voice note to an active room. This is in-process
   * only: no paired client can choose an agent identity by naming it on a
   * websocket frame.
   */
  publishCollabAgentVoiceNote(
    roomId: string,
    agent: CollabVoiceParticipant,
    note: Omit<PersistCollabVoiceNoteInput, "roomId" | "participant">,
  ): CollabVoiceNoteFrame {
    return this.#collab.publishAgentVoiceNote(roomId, agent, note);
  }

  /**
   * Dispatch an already policy-cleared action to the active WebView target.
   *
   * False is a synchronous availability result, not an eventual timeout: the
   * bridge can fail the tool call immediately when no client has mounted the
   * requested agent's WebView.
   */
  sendWebViewAction(agentId: AgentId, requestId: string, action: WebViewAction): boolean {
    const ws = this.#webviews.get(agentId);
    if (ws === undefined || !this.#sockets.has(ws) || ws.data.revoked) return false;
    try {
      ws.send(JSON.stringify({ t: "webview_action", agentId, requestId, action } satisfies ServerFrame));
      return true;
    } catch {
      this.#webviews.delete(agentId);
      return false;
    }
  }

  /**
   * The webhook's secret is the only credential this path accepts. It is used
   * by both the loopback HTTP route and the outbound tunnel's local endpoint.
   */
  async fireWebhook(routineId: string, secret: string, _body?: Uint8Array, _contentType?: string): Promise<Response> {
    const runner = this.#routines;
    if (!runner) return Response.json({ error: "routines_unavailable" }, { status: 503 });

    const result = await runner.fireWebhook(routineId, secret);
    if (!result.accepted) {
      return Response.json({ error: "webhook_refused" }, { status: result.reason === "forbidden" ? 403 : 404 });
    }
    return Response.json({ run: result.run }, { status: 202 });
  }
  /** Revoke a paired device. Takes effect on its next request or frame. */
  revokeDevice(deviceId: string): void {
    this.#auth.revoke(deviceId);
  }

  /**
   * Agent ownership is a live supervisor binding. A mirrored row is readable
   * through this gateway but cannot execute until its owning delegate pulls it.
   */
  #queuesForDelegate(agentId: AgentId): boolean {
    return (
      this.#federation?.replica === true && this.#store.getAgent(agentId) !== null && !this.#sup.ownsAgent(agentId)
    );
  }

  #enqueueIntent(agentId: AgentId, actor: Actor, action: QueuedIntent["action"], payload: unknown): QueuedIntent {
    return this.#store.enqueueQueuedIntent({
      id: `qi_${crypto.randomUUID().replace(/-/g, "")}`,
      agentId,
      actorDeviceId: actor.deviceId,
      action,
      payload,
      createdAt: new Date().toISOString(),
    });
  }

  async #syncIntents(req: Request, path: string): Promise<Response> {
    const federation = this.#federation;
    if (federation === undefined) return Response.json({ error: "not_found" }, { status: 404 });
    const header = req.headers.get("authorization");
    if (header !== `Bearer ${federation.syncToken}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (path === "/v1/sync/intents" && req.method === "GET") {
      return Response.json({ intents: this.#store.listPendingQueuedIntents() });
    }
    if (path === "/v1/sync/intents/claim" && req.method === "POST") {
      let body: { id?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.id !== "string" || body.id.length === 0) {
        return Response.json({ error: "id must be a non-empty string" }, { status: 400 });
      }
      const claimed = this.#store.claimQueuedIntent(body.id);
      if (!claimed) {
        return Response.json({ error: "not_pending" }, { status: 409 });
      }
      return Response.json({ ok: true, intent: claimed });
    }
    if (path === "/v1/sync/intents/ack" && req.method === "POST") {
      let body: { ids?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (!Array.isArray(body.ids) || !body.ids.every(id => typeof id === "string" && id.length > 0)) {
        return Response.json({ error: "ids must be a non-empty string array" }, { status: 400 });
      }
      return Response.json({ delivered: this.#store.markQueuedIntentsDelivered(body.ids) });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // -- http ------------------------------------------------------------------

  async #fetch(req: Request, server: Server<GatewaySocketData>): Promise<Response | undefined> {
    // `req.url` is absolute only when the request carried a Host header, and
    // HTTP/1.0 does not require one. Parsed bare, such a request threw here,
    // before any authentication ran, so anything able to open the port could
    // produce an unhandled exception on every request it sent. The bind
    // address is a base rather than a guess at what the client meant: only the
    // path and query are ever read from this.
    const url = URL.parse(req.url, `http://${this.#host}`);
    if (url === null) return Response.json({ error: "bad_request" }, { status: 400 });
    const path = url.pathname;

    if (path === "/v1/health") {
      // Unauthenticated, so it carries liveness and nothing else. Anything
      // about agents here would be an unauthenticated disclosure of what this
      // machine is doing.
      //
      // `homeId` is the exception, and it earns its place: without it `ompd
      // start` treats ANY healthy listener on its port as itself, silently
      // reports "already listening", and leaves the operator pointed at a
      // different daemon holding a different token. It is a hash rather than
      // the path because the path contains a username and this route is
      // unauthenticated.
      return Response.json({ ok: true, version: this.#version, homeId: this.#homeId });
    }

    if (path === "/v1/pair") {
      if (req.method !== "POST") return Response.json({ error: "not_found" }, { status: 404 });
      let body: { name?: unknown; publicKey?: unknown };
      try {
        body = (await req.json()) as { name?: unknown; publicKey?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.name !== "string" || typeof body.publicKey !== "string") {
        return Response.json({ error: "name and publicKey are required" }, { status: 400 });
      }
      try {
        // Only the code comes back. No token, no scopes, no device id: there is
        // nothing here a client could present to any other route.
        const code = this.#auth.beginPairing({ name: body.name, publicKey: body.publicKey });
        return Response.json({ code });
      } catch (err) {
        if (err instanceof PairingBacklogError) {
          return Response.json({ error: "pairing_backlog" }, { status: 429 });
        }
        throw err;
      }
    }

    const webhook = /^\/v1\/webhooks\/([^/]+)$/.exec(path);
    if (webhook && req.method === "POST") {
      // This is deliberately not a device bearer token. It is a narrow,
      // per-routine capability and the scheduler verifies its stored hash.
      const secret = req.headers.get("x-webhook-secret") ?? url.searchParams.get("token") ?? "";
      const body = new Uint8Array(await req.arrayBuffer());
      return await this.fireWebhook(webhook[1] ?? "", secret, body, req.headers.get("content-type") ?? undefined);
    }
    // The collab relay: unauthenticated by design, because possession of the
    // link is the trust boundary and every frame is sealed before it reaches
    // the socket, so the relay forwards ciphertext it cannot read either way.
    // omp's CollabSocket presents no credential on this leg, so a token gate
    // would break `/collab ws://127.0.0.1:<port>` without protecting
    // anything. Exposure is the daemon's bind, loopback unless the operator
    // deliberately rebinds; what a relay leg can do is bounded there. The
    // reasoning lives in full in collab/relay.ts.
    const relayUpgrade = this.#collabRelay.upgradeData(url);
    if (relayUpgrade !== null) {
      if (relayUpgrade instanceof Response) return relayUpgrade;
      if (!this.#exposeCollabRelay) {
        const address = this.#requestAddress(req, server);
        if (!isLoopbackPeer(address)) {
          return new Response("collab relay is restricted to loopback peers", { status: 403 });
        }
      }
      if (server.upgrade(req, { data: relayUpgrade })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    // Everything outside `/v1` is the web client, and it is terminal: a path
    // that is not an API route must never fall through to the bearer check
    // below, or a missing asset answers 401 and a browser is told to
    // authenticate for a file that does not exist. Unauthenticated on purpose,
    // because a browser cannot present a token it has not loaded the app to
    // obtain.
    if (!path.startsWith("/v1/")) {
      return (await this.#serveStatic(path)) ?? Response.json({ error: "not_found" }, { status: 404 });
    }

    const header = req.headers.get("authorization");
    const bearer = header?.startsWith("Bearer ") === true ? header.slice("Bearer ".length) : null;

    if (path === "/v1/socket") {
      // A browser cannot set headers on a websocket, so the query parameter is
      // the primary carrier here and the header is the convenience.
      const token = url.searchParams.get("token") ?? bearer;
      const actor = token === null ? null : this.#auth.resolveActor(token);
      if (!actor) return new Response("unauthorized", { status: 401 });

      const data = this.#socketStateFor(actor);
      if (server.upgrade(req, { data })) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    }

    if (path === "/v1/sync/intents" || path === "/v1/sync/intents/claim" || path === "/v1/sync/intents/ack") {
      return this.#syncIntents(req, path);
    }

    const actor = bearer === null ? null : this.#auth.resolveActor(bearer);
    if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
    const scopes = new Set(actor.scopes);

    if (path === "/v1/agents" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ agents: this.#sup.listAgents() });
    }

    if (path === "/v1/agents" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      // One shared path with the `agent_create` frame below, so the route and
      // the socket cannot disagree about what creating an agent is. The
      // supervisor's own authorize-and-audit is the mutation record both
      // doors leave behind.
      const outcome = await this.#createAgentOverWire(body, actor);
      if (outcome.kind === "bad") return Response.json({ error: outcome.error }, { status: 400 });
      if (outcome.kind === "queued") return Response.json({ intent: outcome.intent }, { status: 202 });
      if (outcome.kind === "refused") return Response.json({ error: "forbidden" }, { status: 403 });
      if (outcome.kind === "failed") {
        return Response.json({ error: outcome.error }, { status: 500 });
      }
      return Response.json({ agent: outcome.agent }, { status: 201 });
    }

    const agentRoute = /^\/v1\/agents\/([^/]+)$/.exec(path);
    if (agentRoute && req.method === "DELETE") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      try {
        await this.#sup.stopAgent(agentRoute[1] ?? "", actor);
        return Response.json({ ok: true });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json({ error: err instanceof Error ? err.message : "stop failed" }, { status: 404 });
      }
    }

    const configRoute = /^\/v1\/agents\/([^/]+)\/config$/.exec(path);
    if (configRoute && (req.method === "GET" || req.method === "POST")) {
      // Reading the mode is watching; setting it is driving. `plan` is the
      // read-only mode, so moving off it widens what the agent may do, and a
      // device holding only `read` must not be able to do that. `prompt` is the
      // right bar rather than `manage`: anyone who can send a prompt can
      // already make a default-mode agent act.
      const needed = req.method === "GET" ? SCOPE_READ : SCOPE_PROMPT;
      if (!scopes.has(needed)) return Response.json({ error: "forbidden" }, { status: 403 });

      const sessions = this.#sessions;
      if (!sessions) return Response.json({ error: "config_unavailable" }, { status: 503 });

      const agent = this.#store.getAgent(configRoute[1] ?? "");
      if (!agent) return Response.json({ error: "not_found" }, { status: 404 });
      const sessionId = agent.acpSessionId;
      if (sessionId === undefined) {
        return Response.json({ error: "no_session" }, { status: 409 });
      }

      if (req.method === "GET") {
        const options = sessions.configFor(sessionId);
        if (!options) return Response.json({ error: "config_unavailable" }, { status: 503 });
        return Response.json({ agentId: agent.id, configOptions: options });
      }

      let body: { modeId?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.modeId !== "string") {
        return Response.json({ error: "modeId is required" }, { status: 400 });
      }

      // Checked against what this session actually offers. Forwarding an
      // unknown mode would either be ignored or wedge the turn, and both look
      // like the daemon losing the request.
      const known = sessions.configFor(sessionId)?.find(option => option.id === MODE_OPTION_ID);
      if (known && !known.options.some(choice => choice.value === body.modeId)) {
        return Response.json(
          { error: "unknown_mode", known: known.options.map(choice => choice.value) },
          { status: 400 },
        );
      }

      try {
        // Not audited: `AuditAction` is a frozen closed union with no member
        // for a mode change, and recording this under a member that means
        // something else would corrupt the audit log to fake coverage.
        const options = await sessions.setMode(sessionId, body.modeId);
        return Response.json({ agentId: agent.id, configOptions: options });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "set_mode failed" }, { status: 502 });
      }
    }

    const promptRoute = /^\/v1\/agents\/([^/]+)\/prompt$/.exec(path);
    if (promptRoute && req.method === "POST") {
      // The same gate the socket's `prompt` frame passes, and the supervisor
      // re-authorizes from the device row behind it either way.
      if (!scopes.has(SCOPE_PROMPT)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: { text?: unknown; images?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const images = parsePromptImages(body.images);
      if (typeof body.text !== "string" || (body.text.length === 0 && !(images.ok && images.images.length > 0))) {
        return Response.json({ error: "text is required" }, { status: 400 });
      }
      if (!images.ok) {
        // The same budgets and the same words as the socket frame, so a client
        // meets one vocabulary whichever road it takes. Ignoring the field
        // instead would be the one worse answer: a caller believing an image
        // reached the agent that never did.
        return Response.json(
          { error: `attachment_${images.refusal}`, message: PROMPT_IMAGE_REFUSAL_REASONS[images.refusal] },
          { status: 413 },
        );
      }

      const agentId = promptRoute[1] ?? "";
      if (this.#queuesForDelegate(agentId)) {
        const intent = this.#enqueueIntent(
          agentId,
          actor,
          "prompt",
          images.images.length > 0 ? { text: body.text as string, images: images.images } : { text: body.text },
        );
        return Response.json({ intent }, { status: 202 });
      }

      try {
        // Awaited, unlike the socket path: the whole point of this route is to
        // hand a script the stop reason, which does not exist until the turn
        // settles. The turn itself is identical either way.
        const result = await this.#sup.prompt(
          agentId,
          body.text as string,
          actor,
          images.images.length > 0 ? images.images : undefined,
        );
        return Response.json({ agentId: promptRoute[1], stopReason: result.stopReason });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        if (err instanceof AgentBusyError) {
          return Response.json({ error: "agent_busy", message: err.message }, { status: 409 });
        }
        return Response.json({ error: err instanceof Error ? err.message : "prompt failed" }, { status: 404 });
      }
    }

    if (path === "/v1/audit" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const raw = Number(url.searchParams.get("limit") ?? "200");
      const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 1000) : 200;
      return Response.json({ entries: this.#store.listAudit(limit) });
    }

    if (path === "/v1/approvals" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({
        pending: this.#sup.pendingApprovals(),
        recent: this.#store.listApprovals(url.searchParams.get("agentId") ?? undefined),
      });
    }

    if (path === "/v1/status" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const byState: Record<string, number> = {};
      for (const agent of this.#sup.listAgents()) {
        byState[agent.state] = (byState[agent.state] ?? 0) + 1;
      }
      const startedAtMs = this.#startedAtMs ?? Date.now();
      return Response.json({
        version: this.#version,
        startedAt: new Date(startedAtMs).toISOString(),
        uptimeMs: Date.now() - startedAtMs,
        agents: { total: this.#sup.listAgents().length, byState },
      });
    }

    if (path === "/v1/pairings" && req.method === "GET") {
      // Approve scope, not read: a code is the thing an approval is spent on,
      // so seeing the queue is part of approving rather than part of watching.
      if (!scopes.has(SCOPE_APPROVE)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      return Response.json({ pending: this.#auth.pendingPairings() });
    }

    if (path === "/v1/pairings/approve" && req.method === "POST") {
      if (!scopes.has(SCOPE_APPROVE)) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      let body: { code?: unknown; scopes?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      if (typeof body.code !== "string" || !Array.isArray(body.scopes)) {
        return Response.json({ error: "code and scopes are required" }, { status: 400 });
      }

      // Narrowed element by element rather than asserted wholesale: this array
      // came off the wire and decides what a new device is allowed to do. The
      // same ceiling the socket frame runs, from the one shared helper.
      const ceiling = narrowGrantedScopes(body.scopes, scopes);
      if ("error" in ceiling) {
        if (ceiling.error === "unknown_scope") {
          return Response.json({ error: "unknown_scope", known: KNOWN_SCOPES }, { status: 400 });
        }
        // A device may never mint one more powerful than itself. Refused
        // rather than quietly clamped: an operator who asked for `manage` and
        // got a device without it would debug the wrong thing for a long time.
        // The code is not spent, so the right approver can still use it.
        return Response.json({ error: "scope_escalation", missing: ceiling.missing }, { status: 403 });
      }

      try {
        const { token, name } = this.#auth.approvePairing(body.code, ceiling.granted);
        return Response.json({ token, name });
      } catch (err) {
        if (err instanceof PairingError) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }
    }

    if (path === "/v1/devices" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ devices: this.#store.listDevices() });
    }

    if (path === "/v1/endpoints" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const offers = this.#endpoints?.() ?? [];
      return Response.json({ offers });
    }

    const deviceRoute = /^\/v1\/devices\/([^/]+)$/.exec(path);
    if (deviceRoute && req.method === "DELETE") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const deviceId = deviceRoute[1] ?? "";
      if (!this.#store.getDevice(deviceId)) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      this.#auth.revoke(deviceId);
      return Response.json({ ok: true });
    }

    if (path === "/v1/tokens/rotate" && req.method === "POST") {
      // Read as text first: rotating your own token needs no body at all, and
      // an absent one must not read as malformed.
      const raw = await req.text();
      let body: { deviceId?: unknown } = {};
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as { deviceId?: unknown };
        } catch {
          return Response.json({ error: "bad_json" }, { status: 400 });
        }
      }
      if (body.deviceId !== undefined && typeof body.deviceId !== "string") {
        return Response.json({ error: "deviceId must be a string" }, { status: 400 });
      }

      // Rotating your own credential needs no scope. It only ever withdraws
      // authority the caller already holds and replaces it with the same
      // authority under a new secret, which is a thing every device should be
      // able to do the moment it suspects its token has leaked.
      const target = body.deviceId ?? actor.deviceId;
      const own = target === actor.deviceId;

      if (!own) {
        if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
        const device = this.#store.getDevice(target);
        if (!device) return Response.json({ error: "not_found" }, { status: 404 });
        // The same clamp pairing approval uses, for the same reason. Rotation
        // hands the caller a working credential for the target, so without
        // this a device holding only `manage` could mint itself one holding
        // `approve` and answer its own tool approvals.
        const missing = device.scopes.filter(scope => !scopes.has(scope));
        if (missing.length > 0) {
          return Response.json({ error: "scope_escalation", missing }, { status: 403 });
        }
      }

      try {
        // `bearer` is non-null here: the check above this block is what
        // produced `actor`. Passing it makes a self-rotation withdraw exactly
        // the row the caller presented rather than everything that device holds.
        const rotated = this.#auth.rotateToken(target, own ? (bearer ?? undefined) : undefined);
        const tokenPath = this.#onTokenRotated?.(rotated.deviceId, rotated.token);
        return Response.json({
          deviceId: rotated.deviceId,
          tokenId: rotated.tokenId,
          revoked: rotated.revoked,
          ...(tokenPath === undefined ? {} : { tokenPath }),
          token: rotated.token,
        });
      } catch (err) {
        if (err instanceof PairingError) {
          return Response.json({ error: err.message }, { status: 404 });
        }
        throw err;
      }
    }

    const webhookSecret = /^\/v1\/routines\/([^/]+)\/webhook-secret$/.exec(path);
    if (webhookSecret && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const routine = this.#store.listRoutines().find(candidate => candidate.id === webhookSecret[1]);
      if (!routine) return Response.json({ error: "not_found" }, { status: 404 });
      if (routine.trigger.kind !== "webhook") {
        return Response.json({ error: "not_a_webhook_routine" }, { status: 400 });
      }

      // Returned exactly once. The store receives only the digest, so neither
      // a restart nor another route can reveal this credential later.
      const secret = randomBytes(32).toString("base64url");
      this.#store.upsertWebhookSecret(routine.trigger.secretRef, createHash("sha256").update(secret).digest("hex"));
      return Response.json({ secret }, { status: 201 });
    }

    if (path === "/v1/sync-settings" && (req.method === "GET" || req.method === "POST")) {
      // This is the CLI, curl, and direct-LAN door: the app never calls it,
      // because the hub has no tunnel wired for this route. The one request
      // shape the hub does tunnel is a webhook fire, gated by a per-routine
      // secret; generalising that into a proxy for routes like this one would
      // mean the hub forwarding a device bearer token, so the phone reaches
      // the same two settings through the `settings_read`/`settings_write`
      // frames instead. Same seam, same gates, two doors by transport.
      //
      // Reading the daemon's policy is watching; changing it moves the bar
      // every other scope is measured against, which is `manage`'s job alone.
      // Export/import stay at `manage` for both verbs because a sync document
      // is a full state copy; these two settings are safe to watch with `read`
      // so a watch-only pairing can still see what governs it.
      const needed = req.method === "GET" ? SCOPE_READ : SCOPE_MANAGE;
      if (!scopes.has(needed)) return Response.json({ error: "forbidden" }, { status: 403 });
      const config = this.#syncConfig;
      if (!config) return Response.json({ error: "sync_unavailable" }, { status: 503 });

      if (req.method === "GET") {
        try {
          return Response.json(config.read());
        } catch (err) {
          return Response.json({ error: err instanceof Error ? err.message : "settings read failed" }, { status: 502 });
        }
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const settings = parseSyncSettings(body);
      if (settings === null) return Response.json({ error: "invalid_settings" }, { status: 400 });
      try {
        // Confirmed, not echoed: the response is what the daemon reads back
        // after applying, so a client renders the state that now persists
        // rather than the state it asked for.
        config.apply(settings);
        return Response.json(config.read());
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "settings apply failed" }, { status: 502 });
      }
    }

    if (path === "/v1/sync/export" && req.method === "GET") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const config = this.#syncConfig;
      const skills = this.#skills;
      const connectors = this.#connectors;
      if (!config || !skills || !connectors) {
        return Response.json({ error: "sync_unavailable" }, { status: 503 });
      }
      try {
        return Response.json({
          ...config.read(),
          routines: this.#store.listRoutines().map(routine => ({
            ...routine,
            actions: routine.actions.map(({ host: _host, ...action }) => action),
          })),
          skills: await skills.list(),
          connectors: await connectors.list(),
        } satisfies SyncDocument);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "sync export failed" }, { status: 502 });
      }
    }

    if (path === "/v1/sync/import" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const config = this.#syncConfig;
      if (!config) return Response.json({ error: "sync_unavailable" }, { status: 503 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid_sync_document" }, { status: 400 });
      }
      const document = parseSyncDocument(body);
      if (document === null) return Response.json({ error: "invalid_sync_document" }, { status: 400 });
      // Counted rather than assumed, because a restore is not atomic: settings
      // land first, then each routine in turn, and a failure part way through
      // leaves a machine holding some of another daemon's catalogue. The 400
      // below says the import failed, which is true and is also the reading that
      // sends someone looking for a machine that changed nothing.
      //
      // `stage` is what makes the count readable. A bare index cannot say
      // whether zero completed means the settings failed before any routine was
      // attempted, or whether a count equal to `attempted` means the last
      // routine failed when in fact every one of them landed and only the record
      // of it did not.
      let stage: "settings" | "routines" | "record" = "settings";
      let completed = 0;
      try {
        config.apply({ policyMode: document.policyMode, keepAwake: document.keepAwake });
        stage = "routines";
        for (const routine of document.routines) {
          // Execution hosts never travel. Imported actions execute locally,
          // through the receiving daemon's own supervisor. The webhook
          // `secretRef` does not travel either: only the exporting daemon holds
          // the hash it names, so honouring it here names a row that does not
          // exist and cannot be made to. `#persistRoutine` mints a local ref
          // instead, and withdraws a local credential a restore has moved a
          // routine off.
          this.#persistRoutine({
            ...routine,
            actions: routine.actions.map(action => ({ ...action, host: { kind: "local" } })),
          });
          completed += 1;
        }
        stage = "record";
        // One row for the one decision that was made. Restoring a catalogue
        // arms every automation in it, so a door that wrote them all and
        // recorded nothing left the operator's own log unable to answer why a
        // machine started running work nobody scheduled on it. Per-routine
        // `routine.create` rows would be fifty arming decisions nobody made,
        // which reads worse than one restore recorded as a restore.
        //
        // The same fields as the failure row below, deliberately. They were
        // once `routines` here and `completed`/`attempted` there, which meant
        // anything counting imports had to special-case the outcome to find the
        // same number under a different name. On success `stage` is always
        // `record` and `completed` always equals `attempted`, and both are
        // carried anyway so the shape of a `sync.import` row does not depend on
        // how it went.
        this.#store.audit({
          action: "sync.import",
          actorDeviceId: actor.deviceId,
          outcome: "ok",
          detail: {
            stage,
            completed,
            attempted: document.routines.length,
            policyMode: document.policyMode,
          },
        });
        return Response.json({ ok: true, routines: completed });
      } catch (err) {
        const reason = err instanceof Error ? err.message : "sync import failed";
        // The row a partial restore needs most. Recording only the successes
        // would leave the one case where the log matters, a machine holding half
        // of somebody else's configuration, as the one case with nothing in it.
        //
        // `completed` counts routines whose write committed, and `stage` says
        // where the import stopped. A routine and its credential withdrawal now
        // commit or roll back together, so the one that threw is not on disk and
        // `completed` does not count it. What `stage` still carries that a bare
        // count cannot is which of the three phases ended the restore, since
        // settings land outside the store and outside any of those transactions.
        //
        // A restore is not atomic across routines: each one is its own
        // transaction and this row is written after all of them. If this insert
        // and the one above both fail, N routines are armed with nothing naming
        // the restore, and the catch below says what that costs.
        try {
          this.#store.audit({
            action: "sync.import",
            actorDeviceId: actor.deviceId,
            outcome: "error",
            detail: {
              stage,
              completed,
              attempted: document.routines.length,
              policyMode: document.policyMode,
              reason,
            },
          });
        } catch {
          // Suppressed so the caller's 400 keeps carrying the original reason,
          // which is the part anyone diagnosing this needs, rather than being
          // replaced by a second failure from the recording of the first.
          //
          // What this costs is worth naming: an audit row that could not be
          // written leaves no trace anywhere, and the store failing is only one
          // of the reasons it might not have been. `stage` in the row above is
          // the closest thing to a substitute, and on this path even that is
          // gone.
        }
        return Response.json({ error: reason }, { status: 400 });
      }
    }

    if (path === "/v1/routines" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      return Response.json({ routines: this.#store.listRoutines() });
    }

    if (path === "/v1/routines" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const draft = parseRoutineDraft(body);
      if (typeof draft === "string") {
        return Response.json({ error: "invalid_routine", reason: draft }, { status: 400 });
      }
      // Minted against the catalogue, not merely minted. `#persistRoutine` is
      // an upsert by design, because three of the four doors that reach it are,
      // so an id that happened to already exist would make this create silently
      // overwrite an unrelated routine. Sixteen hex characters make that
      // vanishingly unlikely and "unlikely" is not a property a create route
      // should rest an operator's automation on.
      const taken: Record<string, true> = {};
      for (const held of this.#store.listRoutines()) taken[held.id] = true;
      let id = mintId("rtn");
      while (taken[id] === true) id = mintId("rtn");
      const routine = this.#writeRoutine({
        routine: {
          id,
          name: draft.name,
          // Enabled and singleton default on: a routine defined and left off is
          // the rarer intent, and overlapping runs of the same automation is
          // the rarer want.
          enabled: draft.enabled ?? true,
          // The draft names no `secretRef` and the seam mints one for a webhook
          // trigger. The secret VALUE is never minted here: a create that
          // returned one would put a credential in a response nobody asked for
          // it in, and into whatever record the caller keeps of its own
          // requests. `POST /v1/routines/:id/webhook-secret` is the one place a
          // value is issued, and it issues it exactly once.
          trigger: draft.trigger,
          actions: draft.actions.map(materialiseAction),
          singleton: draft.singleton ?? true,
          labels: draft.labels ?? {},
          createdAt: new Date().toISOString(),
        },
        actorDeviceId: actor.deviceId,
      });
      return Response.json({ routine }, { status: 201 });
    }

    const routineRun = /^\/v1\/routines\/([^/]+)\/run$/.exec(path);
    if (routineRun && req.method === "POST") {
      // The scheduler authorizes again from the device row. This is the cheap
      // first gate, not the authority.
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const runner = this.#routines;
      if (!runner) {
        return Response.json({ error: "routines_unavailable" }, { status: 503 });
      }
      try {
        const run = await runner.runNow(routineRun[1] ?? "", actor);
        return Response.json({ run });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          return Response.json({ error: "forbidden" }, { status: 403 });
        }
        return Response.json({ error: err instanceof Error ? err.message : "run failed" }, { status: 404 });
      }
    }

    // A POST with a body rather than `DELETE /v1/routines/:id`, mirroring
    // `/v1/sessions/delete`: the capability is a list, every id answers for
    // itself in `results`, and a refusal among them does not fail the rest.
    // The response is 200 even when every id was refused, because the request
    // was understood and answered; a caller checks `results`, not the status.
    if (path === "/v1/routines/delete" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const runner = this.#routines;
      if (!runner) return Response.json({ error: "routines_unavailable" }, { status: 503 });
      let body: { routineIds?: unknown };
      try {
        body = (await req.json()) as { routineIds?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const ids = body.routineIds;
      // An empty list is refused rather than answered with an empty result,
      // for the same reason as sessions: for something irreversible, "I
      // deleted nothing" and "you asked me to delete nothing" are worth
      // telling apart.
      if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || id.length === 0)) {
        return Response.json({ error: "routineIds must be a non-empty array of routine ids" }, { status: 400 });
      }
      const results = await this.#deleteRoutines(runner, ids as string[], actor.deviceId);
      return Response.json({ results });
    }

    // Last of the routine routes, deliberately. Every other one is either a
    // literal path or two segments deep; this is the only matcher under
    // `/v1/routines/` that accepts an arbitrary segment, so it has to be
    // tried after `/v1/routines/delete` or it would swallow it. `:id/run` and
    // `:id/webhook-secret` are two segments and cannot match here at all.
    // A `GET /v1/routines/delete` does land here and answers `not_found`,
    // which is the honest reply: there is no routine by that id.
    const routineById = /^\/v1\/routines\/([^/]+)$/.exec(path);

    if (routineById && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const routine = this.#store.listRoutines().find(candidate => candidate.id === routineById[1]);
      if (!routine) return Response.json({ error: "not_found" }, { status: 404 });
      // Clamped rather than refused: a caller naming a thousand runs has made
      // a guess about a ceiling it cannot see, not an error, and the honest
      // answer to "show me more" is as much as one response should carry.
      // `parseInt` of a missing or unparsable value is NaN, which is how an
      // absent parameter and `runLimit=soon` both reach the default.
      const requested = Number.parseInt(url.searchParams.get("runLimit") ?? "", 10);
      const runLimit = Number.isNaN(requested)
        ? ROUTINE_RUNS_DEFAULT
        : Math.min(Math.max(requested, 1), ROUTINE_RUNS_MAX);
      // `listRuns` orders `started_at DESC`, so newest-first comes out of the
      // store and nothing here reorders it.
      return Response.json({ routine, runs: this.#store.listRuns(routine.id, runLimit) });
    }

    if (routineById && req.method === "PATCH") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const existing = this.#store.listRoutines().find(candidate => candidate.id === routineById[1]);
      if (!existing) return Response.json({ error: "not_found" }, { status: 404 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const patch = parseRoutinePatch(body);
      if (typeof patch === "string") {
        return Response.json({ error: "invalid_patch", reason: patch }, { status: 400 });
      }

      // `{ ...existing, ...patch }` is the patch contract written out: a
      // spread copies own keys only, so a key the caller sent replaces and a
      // key it never sent is not touched. That is what keeps `labels: {}`
      // clearing every label while an absent `labels` preserves them, and it
      // is why the merge is a spread rather than six `patch.key !== undefined`
      // tests: an undefined or truthiness test reads an empty object and an
      // absent key as the same thing, and clearing a label would become
      // impossible through this route. `parseRoutinePatch` sets a key only
      // after validating a real value, so no key here is present-but-
      // undefined.
      //
      // `trigger` and `actions` are then overwritten, because a draft is not
      // what the store holds: a drafted action names no execution host, which
      // `materialiseAction` forces local. Those two read `undefined` for
      // absence rather than testing presence, which is safe where it would not
      // be above: a trigger is never an empty object, and an empty `actions`
      // array is refused outright, so neither field has an empty-versus-absent
      // distinction left to lose. The webhook `secretRef` is the seam's, not
      // this route's: a patch that leaves a webhook alone keeps the stored ref,
      // and one that moves off webhook withdraws the row after the write lands.
      const routine = this.#writeRoutine({
        routine: {
          ...existing,
          ...patch,
          trigger: patch.trigger ?? existing.trigger,
          actions: (patch.actions ?? existing.actions).map(materialiseAction),
        },
        actorDeviceId: actor.deviceId,
      });
      return Response.json({ routine });
    }

    if (path === "/v1/skills" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      // One shared path with the `skills_read` frame below, so the route and
      // the socket cannot disagree about what a catalogue read is.
      const outcome = await this.#listSkills({
        cwd: url.searchParams.get("cwd") ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
      });
      if (outcome.kind === "off") return Response.json({ error: "skills_unavailable" }, { status: 503 });
      if (outcome.kind === "unknown-agent") return Response.json({ error: "not_found" }, { status: 404 });
      if (outcome.kind === "failed") return Response.json({ error: outcome.error }, { status: 502 });
      return Response.json({ skills: outcome.value });
    }

    if (path === "/v1/connectors" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const outcome = await this.#listConnectors({
        cwd: url.searchParams.get("cwd") ?? undefined,
        agentId: url.searchParams.get("agentId") ?? undefined,
      });
      if (outcome.kind === "off") return Response.json({ error: "connectors_unavailable" }, { status: 503 });
      if (outcome.kind === "unknown-agent") return Response.json({ error: "not_found" }, { status: 404 });
      if (outcome.kind === "failed") return Response.json({ error: outcome.error }, { status: 502 });
      return Response.json({ connectors: outcome.value });
    }

    // MCP auth. Reading the state of a grant is `read`; everything that moves
    // a credential is `manage`, including login, because beginning an
    // authorization is how a new credential gets onto this machine.
    if (path === "/v1/mcp-auth" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      return Response.json(broker.status());
    }

    if (path === "/v1/mcp-auth/login" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      let body: { resourceUrl?: unknown; name?: unknown };
      try {
        body = (await req.json()) as { resourceUrl?: unknown; name?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const resourceUrl = typeof body.resourceUrl === "string" ? body.resourceUrl : "";
      // https only, and not as a style preference: an authorization code and
      // then a bearer token travel to whatever this names, so a plaintext
      // destination is a credential handed to the network. Loopback is the one
      // exception, because a test's fake authorization server lives there and
      // nothing leaves the machine.
      let parsed: URL;
      try {
        parsed = new URL(resourceUrl);
      } catch {
        return Response.json({ error: "resourceUrl must be an absolute URL" }, { status: 400 });
      }
      const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
      if (parsed.protocol !== "https:" && !loopback) {
        return Response.json({ error: "resourceUrl must be https, or loopback" }, { status: 400 });
      }
      const name = typeof body.name === "string" && body.name.length > 0 ? body.name : undefined;
      try {
        const begun = await broker.beginLogin({ resourceUrl, name });
        this.#store.audit({
          action: "mcp_auth.login",
          actorDeviceId: actor.deviceId,
          outcome: "ok",
          detail: { resourceUrl },
        });
        return Response.json(begun, { status: 201 });
      } catch (err) {
        this.#store.audit({
          action: "mcp_auth.login",
          actorDeviceId: actor.deviceId,
          outcome: "error",
          detail: { resourceUrl },
        });
        return Response.json({ error: err instanceof Error ? err.message : "login failed" }, { status: 502 });
      }
    }

    const mcpAuthLoginProgress = /^\/v1\/mcp-auth\/login\/([A-Za-z0-9_-]+)$/.exec(path);
    if (mcpAuthLoginProgress && req.method === "GET") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      const progress = broker.loginProgress(mcpAuthLoginProgress[1] ?? "");
      if (progress === undefined) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json(progress);
    }

    if (path === "/v1/mcp-auth/import" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      let body: { dryRun?: unknown; force?: unknown };
      try {
        body = (await req.json()) as { dryRun?: unknown; force?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const report = await broker.importFromOmp({ dryRun: body.dryRun === true, force: body.force === true });
      this.#store.audit({
        action: "mcp_auth.import",
        actorDeviceId: actor.deviceId,
        outcome: report.refused === undefined ? "ok" : "denied",
        // Counts and refusal reasons only. The URLs are already in the report
        // the caller receives; the audit log does not need a second copy, and
        // it certainly does not need anything from the credential rows.
        detail: { imported: report.imported.length, skipped: report.skipped.length, dryRun: report.dryRun },
      });
      return Response.json(report);
    }

    if (path === "/v1/mcp-auth/apply" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      try {
        const report = await broker.apply();
        this.#store.audit({
          action: "mcp_auth.apply",
          actorDeviceId: actor.deviceId,
          outcome: "ok",
          detail: { applied: report.applied.length, disabled: report.disabled.length },
        });
        return Response.json(report);
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "apply failed" }, { status: 409 });
      }
    }

    if (path === "/v1/mcp-auth/unapply" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      const removed = await broker.unapply();
      this.#store.audit({
        action: "mcp_auth.apply",
        actorDeviceId: actor.deviceId,
        outcome: "ok",
        detail: { removed: removed.removed.length },
      });
      return Response.json(removed);
    }

    const mcpAuthRefresh = /^\/v1\/mcp-auth\/([A-Za-z0-9_]+)\/refresh$/.exec(path);
    if (mcpAuthRefresh && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      const result = await broker.refresh(mcpAuthRefresh[1] ?? "");
      this.#store.audit({
        action: "mcp_auth.refresh",
        actorDeviceId: actor.deviceId,
        outcome: result.outcome === "ok" ? "ok" : "error",
        detail: { grantId: mcpAuthRefresh[1], state: result.state },
      });
      return Response.json(result);
    }

    const mcpAuthForget = /^\/v1\/mcp-auth\/([A-Za-z0-9_]+)$/.exec(path);
    if (mcpAuthForget && req.method === "DELETE") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const broker = this.#mcpAuth;
      if (!broker) return Response.json({ error: "mcp_auth_unavailable" }, { status: 503 });
      const removed = broker.forget(mcpAuthForget[1] ?? "");
      this.#store.audit({
        action: "mcp_auth.forget",
        actorDeviceId: actor.deviceId,
        outcome: removed ? "ok" : "denied",
        detail: { grantId: mcpAuthForget[1] },
      });
      if (!removed) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ removed });
    }

    if (path === "/v1/tasks" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const outcome = this.#listTasks(url.searchParams.get("agentId") ?? undefined);
      if (outcome.kind === "off") return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      return Response.json({ tasks: outcome.value });
    }

    const taskRoute = /^\/v1\/tasks\/([^/]+)$/.exec(path);
    if (taskRoute && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const catalog = this.#tasks;
      if (!catalog) return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      const task = catalog.get(taskRoute[1] ?? "");
      if (!task) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({ task });
    }

    if (path === "/v1/tasks" && req.method === "POST") {
      // The same gate a plain prompt needs: a task is a named, tracked
      // prompt against a session that already exists, not a session-spawner.
      // Creating that session is `manage`'s job via `POST /v1/agents`.
      if (!scopes.has(SCOPE_PROMPT)) return Response.json({ error: "forbidden" }, { status: 403 });
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      // One shared path with the `task_create` frame below, so the route and
      // the socket cannot disagree about what starting a task is.
      const createOutcome = await this.#createTask(body, actor);
      if (createOutcome.kind === "off") return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      if (createOutcome.kind === "bad") return Response.json({ error: createOutcome.error }, { status: 400 });
      if (createOutcome.kind === "refused") return Response.json({ error: "forbidden" }, { status: 403 });
      // 404 rather than 500, unchanged from before the shared path existed:
      // the failures that land here (unknown agent, unknown task) are all
      // "what you named is not there", and this status is a public contract.
      if (createOutcome.kind !== "ok") return Response.json({ error: createOutcome.error }, { status: 404 });
      return Response.json({ task: createOutcome.value }, { status: 201 });
    }

    const taskCancel = /^\/v1\/tasks\/([^/]+)\/cancel$/.exec(path);
    if (taskCancel && req.method === "POST") {
      // The same gate `cancel` takes on the websocket frame and on
      // `Supervisor.cancel` itself; this call re-authorizes from the device
      // row regardless.
      if (!scopes.has(SCOPE_PROMPT)) return Response.json({ error: "forbidden" }, { status: 403 });
      const outcome = await this.#cancelTask(taskCancel[1] ?? "", actor);
      if (outcome.kind === "off") return Response.json({ error: "tasks_unavailable" }, { status: 503 });
      if (outcome.kind === "refused") return Response.json({ error: "forbidden" }, { status: 403 });
      if (outcome.kind !== "ok") return Response.json({ error: outcome.error }, { status: 404 });
      return Response.json({ task: outcome.value });
    }

    // -- sessions ------------------------------------------------------------
    //
    // `read` lists and groups; `manage` archives, the same split every other
    // catalogue-vs-mutation pair in this route table uses (skills/connectors
    // read vs agent create/stop). Grouping and sorting happen inside
    // `SessionIndex`, not here, so a phone never downloads the full catalog
    // to sort it locally.

    if (path === "/v1/sessions" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      const parsed = parseSessionQuery(url);
      if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
      // The build is cooperative but still async: awaiting here (rather
      // than blocking the loop inside a synchronous build) is what keeps
      // this route and every other one -- health included -- live while a
      // cold index is being assembled. Counts are first paint: cached where
      // known, null where the background warm pass has not reached them.
      return Response.json({ sessions: await index.query(parsed.query) });
    }

    if (path === "/v1/sessions/grouped" && req.method === "GET") {
      if (!scopes.has(SCOPE_READ)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      const parsed = parseSessionQuery(url);
      if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
      return Response.json({ groups: await index.grouped(parsed.query) });
    }

    const sessionTakeoverRoute = /^\/v1\/sessions\/([^/]+)\/takeover$/.exec(path);
    if (sessionTakeoverRoute && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      try {
        const agent = await this.#takeOverLiveTui(sessionTakeoverRoute[1] ?? "", actor);
        return Response.json({ agent }, { status: 201 });
      } catch (err) {
        return Response.json({ error: err instanceof Error ? err.message : "TUI takeover failed" }, { status: 409 });
      }
    }

    const sessionArchiveRoute = /^\/v1\/sessions\/([^/]+)\/archive$/.exec(path);
    if (sessionArchiveRoute && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      index.archive(sessionArchiveRoute[1] ?? "");
      return Response.json({ ok: true });
    }

    const sessionUnarchiveRoute = /^\/v1\/sessions\/([^/]+)\/unarchive$/.exec(path);
    if (sessionUnarchiveRoute && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      index.unarchive(sessionUnarchiveRoute[1] ?? "");
      return Response.json({ ok: true });
    }

    // A POST with a body rather than `DELETE /v1/sessions/:id`, because the
    // capability is a list: clearing hundreds of dead sessions one request at
    // a time is not something anyone would do, and a body is the only place a
    // list can ride. Every id answers for itself in `results`, so a refusal
    // among them does not fail the rest -- and the response is 200 even when
    // every id was refused, because the request was understood and answered.
    // A caller checks `results`, not the status line.
    if (path === "/v1/sessions/delete" && req.method === "POST") {
      if (!scopes.has(SCOPE_MANAGE)) return Response.json({ error: "forbidden" }, { status: 403 });
      const index = this.#sessionIndex;
      if (!index) return Response.json({ error: "sessions_unavailable" }, { status: 503 });
      let body: { sessionIds?: unknown };
      try {
        body = (await req.json()) as { sessionIds?: unknown };
      } catch {
        return Response.json({ error: "bad_json" }, { status: 400 });
      }
      const ids = body.sessionIds;
      // An empty list is refused rather than answered with an empty result:
      // for something irreversible, "I deleted nothing" and "you asked me to
      // delete nothing" are worth telling apart.
      if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || id.length === 0)) {
        return Response.json({ error: "sessionIds must be a non-empty array of session ids" }, { status: 400 });
      }
      const results = await this.#deleteSessions(index, ids as string[], actor.deviceId);
      return Response.json({ results });
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /**
   * Which directory a skills/connectors catalogue query is scoped to.
   *
   * `cwd` wins when both are given. `agentId` resolves through this daemon's
   * own agent rows rather than being handed to discovery as a raw path,
   * because an operator asking "what does agent X have" who mistypes the id
   * must get a refusal, not a silent fall-through to the daemon's own default
   * project directory and a catalogue for the wrong workspace.
   *
   * Takes the query fields rather than a URL so the HTTP route and the
   * `skills_read`/`connectors_read` frames resolve through this one method.
   */
  #resolveCatalogCwd(query: CatalogQuery): { cwd: string | undefined } | { notFound: true } {
    if (query.cwd !== undefined) return { cwd: query.cwd };
    if (query.agentId === undefined) return { cwd: undefined };
    const agent = this.#store.getAgent(query.agentId);
    return agent ? { cwd: agent.cwd } : { notFound: true };
  }

  /**
   * The skills catalogue for one workspace. One shared path for the
   * `GET /v1/skills` route and the `skills_read` frame: whichever door is
   * asked, the same resolution, the same catalogue call, the same failure
   * facts. Only the wire each door speaks differs.
   */
  async #listSkills(query: CatalogQuery): Promise<CoworkListOutcome<SkillSummary[]>> {
    const catalog = this.#skills;
    if (!catalog) return { kind: "off" };
    const resolved = this.#resolveCatalogCwd(query);
    if ("notFound" in resolved) return { kind: "unknown-agent" };
    try {
      return { kind: "ok", value: await catalog.list(resolved.cwd) };
    } catch (err) {
      return { kind: "failed", error: err instanceof Error ? err.message : "skill discovery failed" };
    }
  }

  /** The connector counterpart to `#listSkills`, on the same shared-path rule. */
  async #listConnectors(query: CatalogQuery): Promise<CoworkListOutcome<ConnectorSummary[]>> {
    const catalog = this.#connectors;
    if (!catalog) return { kind: "off" };
    const resolved = this.#resolveCatalogCwd(query);
    if ("notFound" in resolved) return { kind: "unknown-agent" };
    try {
      return { kind: "ok", value: await catalog.list(resolved.cwd) };
    } catch (err) {
      return { kind: "failed", error: err instanceof Error ? err.message : "connector discovery failed" };
    }
  }

  /**
   * The task roster, optionally narrowed to one agent. One shared path for
   * `GET /v1/tasks` and the `tasks_read` frame.
   */
  #listTasks(agentId: string | undefined): { kind: "ok"; value: Task[] } | { kind: "off" } {
    const catalog = this.#tasks;
    if (!catalog) return { kind: "off" };
    return { kind: "ok", value: catalog.list(agentId) };
  }

  /**
   * Start one task. One shared path for `POST /v1/tasks` and the
   * `task_create` frame. Takes the already-parsed body: the HTTP door keeps
   * its own JSON parse (and its `bad_json` answer), the socket door receives
   * a parsed frame, and every field check beyond that lives here.
   *
   * The audit is `Supervisor.prompt`'s own, reached through the catalog: the
   * same `agent.prompt` record either door leaves behind.
   */
  async #createTask(body: unknown, actor: Actor): Promise<TaskOutcome> {
    const catalog = this.#tasks;
    if (!catalog) return { kind: "off" };
    const input = body as {
      title?: unknown;
      prompt?: unknown;
      agentId?: unknown;
      skillName?: unknown;
      labels?: unknown;
    };
    if (typeof input.title !== "string" || typeof input.prompt !== "string" || typeof input.agentId !== "string") {
      return { kind: "bad", error: "title, prompt, and agentId are required" };
    }
    if (input.skillName !== undefined && typeof input.skillName !== "string") {
      return { kind: "bad", error: "skillName must be a string" };
    }
    // `labels` passes through unvalidated, exactly as the HTTP route always
    // did: inventing a stricter check here would change a public contract in
    // the same change that adds a second door to it.
    try {
      return {
        kind: "ok",
        value: await catalog.create(
          {
            title: input.title,
            prompt: input.prompt,
            agentId: input.agentId,
            ...(input.skillName === undefined ? {} : { skillName: input.skillName }),
            ...(input.labels === undefined ? {} : { labels: input.labels as Record<string, string> }),
          },
          actor,
        ),
      };
    } catch (err) {
      return this.#taskRefusal(err);
    }
  }

  /**
   * Cancel one task. One shared path for `POST /v1/tasks/:id/cancel` and the
   * `task_cancel` frame; the audit is `Supervisor.cancel`'s own.
   */
  async #cancelTask(taskId: string, actor: Actor): Promise<TaskOutcome> {
    const catalog = this.#tasks;
    if (!catalog) return { kind: "off" };
    try {
      return { kind: "ok", value: await catalog.cancel(taskId, actor) };
    } catch (err) {
      return this.#taskRefusal(err);
    }
  }

  /** The shared mapping of a task-mutation throw onto the outcome both doors see. */
  #taskRefusal(err: unknown): Exclude<TaskOutcome, { kind: "ok" | "off" }> {
    if (err instanceof UnauthorizedError) return { kind: "refused", error: err.message };
    return { kind: "missing", error: err instanceof Error ? err.message : "task operation failed" };
  }

  /**
   * Create an agent, host and all. One shared path for `POST /v1/agents` and
   * the `agent_create` frame: the same shape checks, the same replica
   * decision, and `Supervisor.createAgent`'s own authorize-and-audit as the
   * mutation record either door leaves behind.
   *
   * `host` is validated rather than cast. It used to be `body as { host?:
   * HostSpec }`, which is not a check at all: a `manage`-scoped caller's
   * `host` reached the provisioner with its declared type and none of its
   * claims tested, and the provisioner turns those fields into a container
   * runtime's argv. What survives that validation is a `WireHostSpec`, which
   * is the narrower promise: it cannot carry an `image`, and the supervisor
   * accepts it because widening to `HostSpec` is the safe direction.
   */
  async #createAgentOverWire(body: unknown, actor: Actor): Promise<AgentCreateOutcome> {
    const input = body as {
      name?: unknown;
      cwd?: unknown;
      host?: unknown;
      routineId?: string;
      labels?: Record<string, string>;
    };
    if (typeof input.name !== "string" || typeof input.cwd !== "string") {
      return { kind: "bad", error: "name and cwd are required" };
    }
    // Validated before the replica branch, not inside the run path. A replica
    // queues the spec for a primary to run later, so a `host` checked only on
    // the run path would be persisted unchecked and validated by nobody.
    let host: WireHostSpec | undefined;
    if (input.host !== undefined) {
      const validated = validateWireHostSpec(input.host);
      if ("error" in validated) return { kind: "bad", error: validated.error };
      host = validated.host;
    }
    if (this.#federation?.replica === true) {
      const intent = this.#enqueueIntent(createAgentId(), actor, "new-agent", {
        name: input.name,
        cwd: input.cwd,
        host,
        routineId: input.routineId,
        labels: input.labels,
      });
      return { kind: "queued", intent };
    }
    try {
      return {
        kind: "created",
        agent: await this.#sup.createAgent(
          {
            name: input.name,
            cwd: input.cwd,
            host,
            ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
          },
          actor,
        ),
      };
    } catch (err) {
      if (err instanceof UnauthorizedError) return { kind: "refused", error: err.message };
      return { kind: "failed", error: err instanceof Error ? err.message : "agent creation failed" };
    }
  }

  /** One socket skills read, mapping the shared outcome onto the asking socket. */
  async #serveSkillsRead(ws: GatewaySocket, query: CatalogQuery): Promise<void> {
    const outcome = await this.#listSkills(query);
    switch (outcome.kind) {
      case "ok":
        this.#send(ws, { t: "skills", skills: outcome.value });
        return;
      case "off":
        this.#send(ws, {
          t: "error",
          code: "skills_unavailable",
          message: "no skills catalogue is wired into this daemon",
        });
        return;
      case "unknown-agent":
        this.#send(ws, {
          t: "error",
          code: "not_found",
          message: query.agentId === undefined ? "no such agent" : `no agent ${query.agentId} on this machine`,
        });
        return;
      case "failed":
        this.#send(ws, { t: "error", code: "skills_failed", message: outcome.error });
    }
  }

  /** One socket connectors read, on the same shared-outcome rule. */
  async #serveConnectorsRead(ws: GatewaySocket, query: CatalogQuery): Promise<void> {
    const outcome = await this.#listConnectors(query);
    switch (outcome.kind) {
      case "ok":
        this.#send(ws, { t: "connectors", connectors: outcome.value });
        return;
      case "off":
        this.#send(ws, {
          t: "error",
          code: "connectors_unavailable",
          message: "no connector catalogue is wired into this daemon",
        });
        return;
      case "unknown-agent":
        this.#send(ws, {
          t: "error",
          code: "not_found",
          message: query.agentId === undefined ? "no such agent" : `no agent ${query.agentId} on this machine`,
        });
        return;
      case "failed":
        this.#send(ws, { t: "error", code: "connectors_failed", message: outcome.error });
    }
  }

  /**
   * One socket task mutation, mapping the shared outcome onto the asking
   * socket. Takes the already-started mutation so its scope gate has run
   * before any await, the same shape `routine_run` uses.
   */
  async #serveTaskMutation(ws: GatewaySocket, asked: string, mutation: Promise<TaskOutcome>): Promise<void> {
    let outcome: TaskOutcome;
    try {
      outcome = await mutation;
    } catch (err) {
      // The shared path maps its own throws; this guard is for the promise
      // itself, so the asking socket still costs exactly one error frame.
      this.#send(ws, {
        t: "error",
        code: "task_failed",
        message: err instanceof Error ? err.message : `${asked} failed`,
      });
      return;
    }
    switch (outcome.kind) {
      case "ok":
        this.#send(ws, { t: "task", task: outcome.value });
        return;
      case "off":
        this.#send(ws, {
          t: "error",
          code: "tasks_unavailable",
          message: "no task lifecycle is wired into this daemon",
        });
        return;
      case "bad":
        this.#send(ws, { t: "error", code: "bad_frame", message: outcome.error });
        return;
      case "refused":
        this.#send(ws, { t: "error", code: "unauthorized", message: outcome.error });
        return;
      case "missing":
        this.#send(ws, { t: "error", code: "not_found", message: outcome.error });
    }
  }

  /**
   * One socket agent creation, mapping the shared outcome onto the asking
   * socket. The audit is `Supervisor.createAgent`'s own; this adds nothing.
   */
  async #serveAgentCreate(ws: GatewaySocket, frame: Extract<ClientFrame, { t: "agent_create" }>): Promise<void> {
    const outcome = await this.#createAgentOverWire(frame, this.#actorOf(ws));
    switch (outcome.kind) {
      case "created":
        this.#send(ws, { t: "agent_created", agent: outcome.agent });
        return;
      case "queued":
        // The HTTP door answers a queue with 202 because a caller there may
        // genuinely want one. This door refuses, for the reason
        // `session_create` refuses on a replica: the mount paths this frame
        // carries were resolved on this replica's own disk (by its own
        // `fs_list`) and mean nothing on the delegate that would run the
        // agent, so a queued start is not the start that was asked for.
        this.#send(ws, {
          t: "error",
          code: "replica",
          message: "this daemon is a replica; create the agent where its directories live",
        });
        return;
      case "bad":
        this.#send(ws, { t: "error", code: "bad_frame", message: outcome.error });
        return;
      case "refused":
        this.#send(ws, { t: "error", code: "unauthorized", message: outcome.error });
        return;
      case "failed":
        this.#send(ws, { t: "error", code: "agent_create_failed", message: outcome.error });
    }
  }

  /**
   * Serve a built web-client file, or null to let the API's 404 stand.
   *
   * The traversal check compares resolved absolute paths rather than screening
   * the request for `..`, because a request path is not a filesystem path until
   * it has been decoded and normalised, and screening before that is how
   * traversal bugs happen.
   */
  async #serveStatic(pathname: string): Promise<Response | null> {
    const root = this.#staticRoot;
    // No directory on disk means this is the compiled binary, which carries the
    // console embedded instead. Without this branch the installed artifact
    // serves the API and answers `/` with not_found, which is what `ompd open`
    // used to land on.
    if (root === undefined) return await this.#serveEmbedded(pathname);

    let relative = "";
    try {
      relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    } catch {
      // Malformed percent-encoding. Nothing here can name a real file.
      return null;
    }

    const target = resolve(root, relative);
    if (target !== root && !target.startsWith(root + sep)) return null;

    const file = Bun.file(target);
    if (await file.exists()) return new Response(file);

    // The client owns its own routing, so a path with no file extension is a
    // route rather than a missing asset and gets the shell. A missing `.js`
    // stays a 404, because answering it with HTML turns a broken deploy into a
    // console parse error somewhere unrelated.
    if (extname(target) !== "") return null;
    const shell = Bun.file(join(root, "index.html"));
    if (!(await shell.exists())) return null;
    return new Response(shell, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  /**
   * Serve the console embedded in the compiled binary.
   *
   * The asset map is generated at build time by `scripts/gen-web-assets.ts`,
   * so lookups are exact and there is no path to traverse: a request either
   * names a key that was embedded or it does not exist.
   */
  #serveEmbedded(pathname: string): Response | null {
    if (!WEB_ASSETS_BUILT) return null;

    let key = "";
    try {
      key = decodeURIComponent(pathname);
    } catch {
      // Malformed percent-encoding cannot name an embedded key.
      return null;
    }
    // The manifest keys all start with a slash, so normalise before lookup
    // rather than trusting the request to have one.
    if (!key.startsWith("/")) key = `/${key}`;
    if (key === "/") key = "/index.html";

    const embedded = WEB_ASSETS[key];
    if (embedded !== undefined) return embeddedResponse(embedded, key);

    // Same rule as the on-disk path: an extensionless path is a client route
    // and gets the shell, while a missing asset stays a 404 so a broken build
    // fails where it broke rather than as a parse error somewhere unrelated.
    if (extname(key) !== "") return null;
    const shell = WEB_ASSETS["/index.html"];
    if (shell === undefined) return null;
    return embeddedResponse(shell, "/index.html");
  }
  async #takeOverLiveTui(sessionId: string, actor: Actor): Promise<Agent> {
    const socket = [...this.#sockets].find(ws => ws.data.tui?.sessionId === sessionId);
    const tui = socket?.data.tui;
    if (!socket || !tui) {
      throw new TakeoverRefusal(`no connected TUI owns session ${sessionId}`, "tui_unreachable");
    }
    if (tui.agentId) {
      throw new TakeoverRefusal(`session ${sessionId} is already managed as agent ${tui.agentId}`, "already_held");
    }
    if (this.#tuiTakeovers.has(sessionId)) {
      throw new TakeoverRefusal(`session ${sessionId} takeover is already pending`, "takeover_pending");
    }

    return await new Promise<Agent>((resolve, reject) => {
      // Bounded, because the other half of this handshake may not exist.
      // `tui_takeover` asks a terminal to stop rendering and host an ACP
      // server, which only omp itself can do; the bridge extension that
      // registers these sessions deliberately implements steering and not
      // this. So a build without takeover support answers nothing, and an
      // unbounded wait leaves the operator looking at a screen that never
      // resolves until they quit the terminal. A refusal by name is the
      // honest answer to a door that is not there.
      const timer = setTimeout(() => {
        this.#tuiTakeovers.delete(sessionId);
        reject(
          new TakeoverRefusal(
            `the terminal holding session ${sessionId} did not release its renderer; its omp build may not support takeover`,
            "tui_no_takeover",
          ),
        );
      }, this.#takeoverAckTimeoutMs);
      const settle = <T>(finish: (value: T) => void) => {
        return (value: T): void => {
          clearTimeout(timer);
          finish(value);
        };
      };
      this.#tuiTakeovers.set(sessionId, { socket, actor, resolve: settle(resolve), reject: settle(reject) });
      this.#send(socket, { t: "tui_takeover", sessionId });
    });
  }

  async #completeLiveTuiTakeover(ws: GatewaySocket, sessionId: string): Promise<void> {
    const pending = this.#tuiTakeovers.get(sessionId);
    const tui = ws.data.tui;
    if (!pending || pending.socket !== ws || !tui || tui.sessionId !== sessionId) {
      this.#send(ws, { t: "error", code: "bad_frame", message: "unexpected TUI takeover acknowledgement" });
      return;
    }
    this.#tuiTakeovers.delete(sessionId);
    try {
      const agent = await this.#sup.takeOverTuiSession(
        { sessionId, name: tui.title ?? `TUI ${sessionId}`, cwd: tui.cwd, pid: tui.pid },
        {
          send: raw => this.#send(ws, { t: "tui_acp", sessionId, raw }),
          onMessage: listener => {
            tui.onAcpMessage = listener;
          },
          onClose: listener => {
            tui.onAcpClose = listener;
          },
          close: () => ws.close(),
        },
        pending.actor,
      );
      tui.agentId = agent.id;
      pending.resolve(agent);
    } catch (err) {
      pending.reject(err instanceof Error ? err : new Error("TUI takeover failed"));
      // The renderer has already stopped. Closing the control transport makes
      // its in-process ACP server dispose the adopted session instead of
      // stranding a headless process that the daemon never registered.
      ws.close();
    }
  }

  /**
   * Open one index session under the daemon for a socket client: take over
   * the TUI holding it, or resume it from disk. The sealed-socket
   * counterpart of `POST /v1/sessions/:id/takeover`, which a hub-relayed
   * phone cannot reach because the hub carries no tunnel for it: a webhook
   * fire is the one request shape it does tunnel.
   *
   * Reuses the same helpers the HTTP paths use rather than a parallel
   * implementation: takeover goes through `#takeOverLiveTui`, and resume
   * through `Supervisor.resumeAgent`, so the two doors cannot drift apart
   * behind their different transports. The index verification happens here
   * because only this path carries caller echoes to verify. A failure
   * re-checks the claim before answering, because losing a race to another
   * client's identical request is the success the caller asked for, not an
   * error.
   */
  async #openSessionOverSocket(
    ws: GatewaySocket,
    frame: Extract<ClientFrame, { t: "session_takeover" }> | Extract<ClientFrame, { t: "session_resume" }>,
  ): Promise<void> {
    const actor = this.#actorOf(ws);
    const index = this.#sessionIndex;
    if (!index) {
      this.#send(ws, {
        t: "error",
        sessionId: frame.sessionId,
        code: "sessions_unavailable",
        message: "no session index is wired into this daemon",
      });
      return;
    }
    const takeover = frame.t === "session_takeover";
    const claimed = { cwd: frame.cwd, ...(takeover ? { pid: frame.pid } : {}) };
    try {
      const claim = await verifySessionClaim(index, frame.sessionId, claimed, takeover ? "live-tui" : "dormant");
      if (claim.verdict === "refuse") {
        this.#send(ws, { t: "error", sessionId: frame.sessionId, code: claim.code, message: claim.message });
        return;
      }
      if (claim.verdict === "held") {
        this.#send(ws, { t: "session_opened", sessionId: frame.sessionId, agentId: claim.agentId });
        return;
      }
      try {
        const agent = takeover
          ? await this.#takeOverLiveTui(frame.sessionId, actor)
          : await this.#sup.resumeAgent(
              {
                name: claim.row.title !== "" ? claim.row.title : `Session ${frame.sessionId}`,
                cwd: frame.cwd,
                sessionId: frame.sessionId,
              },
              actor,
            );
        this.#send(ws, { t: "session_opened", sessionId: frame.sessionId, agentId: agent.id });
      } catch (err) {
        // The claim is re-verified rather than trusting the throw: a refusal
        // naming "already held" from a path that lost a race means another
        // caller's identical request finished in between, and that outcome is
        // the idempotent answer, not a failure.
        const settled = await verifySessionClaim(index, frame.sessionId, claimed, takeover ? "live-tui" : "dormant");
        if (settled.verdict === "held") {
          this.#send(ws, { t: "session_opened", sessionId: frame.sessionId, agentId: settled.agentId });
          return;
        }
        this.#send(ws, {
          t: "error",
          sessionId: frame.sessionId,
          code: err instanceof TakeoverRefusal ? err.code : takeover ? "takeover_failed" : "resume_failed",
          message: err instanceof Error ? err.message : "session open failed",
        });
      }
    } catch (err) {
      this.#send(ws, {
        t: "error",
        sessionId: frame.sessionId,
        code: takeover ? "takeover_failed" : "resume_failed",
        message: err instanceof Error ? err.message : "session open failed",
      });
    }
  }

  // -- browsing this machine, and starting work on it ------------------------

  /**
   * The gate the three filesystem frames share: manage scope, and a daemon
   * that actually has roots configured. Audits the refusal it returns, so
   * every one of these attempts leaves a record whichever door closed.
   *
   * Returns false when the caller must stop. One helper rather than three
   * copies, because two of these frames run code on the operator's machine
   * and a scope check that drifted between them would be the whole bug.
   */
  #authorizeFilesystem(
    ws: GatewaySocket,
    action: "fs.list" | "session.create" | "repo.clone",
    frameType: string,
    detail: Record<string, unknown>,
  ): boolean {
    if (!ws.data.scopes.has(SCOPE_MANAGE)) {
      this.#store.audit({
        action,
        actorDeviceId: ws.data.deviceId,
        outcome: "denied",
        detail: { ...detail, reason: "unauthorized" },
      });
      this.#send(ws, { t: "error", code: "unauthorized", message: `${frameType} requires manage scope` });
      return false;
    }
    if (this.#filesystem === undefined) {
      this.#store.audit({
        action,
        actorDeviceId: ws.data.deviceId,
        outcome: "denied",
        detail: { ...detail, reason: "filesystem_unavailable" },
      });
      this.#send(ws, {
        t: "error",
        code: "filesystem_unavailable",
        message: "no browsable directories are wired into this daemon",
      });
      return false;
    }
    return true;
  }

  /**
   * Turn an `FsRefusal` into the error frame that names why, and audit the
   * refusal under the action that produced it. Anything that is not an
   * `FsRefusal` is a bug in this daemon rather than a decision about the
   * request, and reports as one without leaking its internals to the client.
   */
  #refuseFilesystem(
    ws: GatewaySocket,
    action: "fs.list" | "session.create" | "repo.clone",
    err: unknown,
    detail: Record<string, unknown>,
    fallbackCode: string,
  ): void {
    const refusal = err instanceof FsRefusal;
    const code = refusal ? err.code : fallbackCode;
    this.#store.audit({
      action,
      actorDeviceId: ws.data.deviceId,
      outcome: refusal ? "denied" : "error",
      detail: { ...detail, reason: code },
    });
    this.#send(ws, {
      t: "error",
      code,
      message: err instanceof Error ? err.message : `${action} failed`,
    });
  }

  async #serveFsListing(ws: GatewaySocket, path: string | undefined): Promise<void> {
    const filesystem = this.#filesystem;
    if (filesystem === undefined) return;
    try {
      const listing = await filesystem.list(path);
      this.#store.audit({
        action: "fs.list",
        actorDeviceId: ws.data.deviceId,
        outcome: "ok",
        // The resolved path, not the requested one: that is what was actually
        // read, and the two differ exactly when a symlink or a `..` was involved.
        detail: { path: listing.path, entries: listing.entries.length, bounded: listing.bounded },
      });
      this.#send(ws, { t: "fs_listing", ...listing });
    } catch (err) {
      this.#refuseFilesystem(ws, "fs.list", err, { path }, "fs_list_failed");
    }
  }

  /**
   * Start a session at a directory the operator picked on a phone.
   *
   * Goes through `Supervisor.createAgent`, the same call `POST /v1/agents`
   * makes, so policy, host selection and the audit record are the ones every
   * other creation path already gets. The answer is the existing
   * `session_opened` frame, which is why a client needs no new case to open
   * what this made.
   */
  async #createSessionOverSocket(
    ws: GatewaySocket,
    frame: Extract<ClientFrame, { t: "session_create" }>,
  ): Promise<void> {
    const filesystem = this.#filesystem;
    if (filesystem === undefined) return;
    // A replica queues writes for the daemon that owns the session, and a
    // queued intent has no session id to answer with. Worse, the cwd this
    // frame carries was browsed on this replica's disk and means nothing on
    // the delegate's. Refusing is the honest answer; `POST /v1/agents` is
    // still there for a caller that genuinely wants a queued creation.
    if (this.#federation?.replica === true) {
      this.#refuseFilesystem(
        ws,
        "session.create",
        new FsRefusal("bad_path", "this daemon is a replica; a session must be created where its directory is"),
        { cwd: frame.cwd },
        "session_create_failed",
      );
      return;
    }
    let cwd: string;
    try {
      cwd = await filesystem.directory(frame.cwd);
    } catch (err) {
      this.#refuseFilesystem(ws, "session.create", err, { cwd: frame.cwd }, "session_create_failed");
      return;
    }
    const requested = frame.name?.trim();
    // The directory's own name is what an operator would have typed, and a
    // session called `alpha` is findable in a list where `Session 3` is not.
    const name = requested === undefined || requested.length === 0 ? basename(cwd) : requested;
    try {
      const agent = await this.#sup.createAgent({ name, cwd }, this.#actorOf(ws));
      const sessionId = agent.acpSessionId;
      if (sessionId === undefined) {
        // `createAgent` sets this before returning, so reaching here means the
        // supervisor changed under us. Reported rather than papered over with
        // an invented id a client would then try to open.
        this.#refuseFilesystem(
          ws,
          "session.create",
          new Error(`agent ${agent.id} started without a session`),
          { cwd, agentId: agent.id },
          "session_create_failed",
        );
        return;
      }
      this.#store.audit({
        action: "session.create",
        agentId: agent.id,
        actorDeviceId: ws.data.deviceId,
        outcome: "ok",
        detail: { cwd, name },
      });
      this.#send(ws, { t: "session_opened", sessionId, agentId: agent.id });
    } catch (err) {
      this.#refuseFilesystem(
        ws,
        "session.create",
        err,
        { cwd },
        err instanceof UnauthorizedError ? "unauthorized" : "session_create_failed",
      );
    }
  }

  /**
   * Clone a repository onto this machine for a device that is not at the
   * keyboard.
   *
   * Registered against the socket before it is awaited, so a socket that goes
   * away takes the clone with it: an operator who walked out of range must not
   * leave `git` writing into a directory nobody is waiting for. The audit
   * record is written when git is actually started, with the validated url --
   * `validateCloneUrl` has by then refused every form that could carry a
   * credential, which is what makes the url safe to record at all.
   */
  async #startCloneOverSocket(ws: GatewaySocket, frame: Extract<ClientFrame, { t: "repo_clone" }>): Promise<void> {
    const filesystem = this.#filesystem;
    if (filesystem === undefined) return;
    const running = this.#clones.get(ws);
    if (running !== undefined && running.size >= MAX_CLONES_PER_SOCKET) {
      this.#refuseFilesystem(
        ws,
        "repo.clone",
        new FsRefusal("clone_busy", `this device already has ${running.size} clones running`),
        { parent: frame.parent },
        "clone_failed",
      );
      return;
    }

    let run: CloneRun;
    try {
      run = await filesystem.clone(
        {
          url: frame.url,
          parent: frame.parent,
          ...(frame.name === undefined ? {} : { name: frame.name }),
        },
        // Bound to the socket, not to a subscription: progress belongs to the
        // device that asked, and a clone is nobody else's business.
        line => this.#send(ws, { t: "clone_progress", cloneId: run.cloneId, line }),
      );
    } catch (err) {
      this.#refuseFilesystem(ws, "repo.clone", err, { parent: frame.parent }, "clone_failed");
      return;
    }

    const tracked = running ?? new Set<CloneRun>();
    tracked.add(run);
    this.#clones.set(ws, tracked);
    this.#store.audit({
      action: "repo.clone",
      actorDeviceId: ws.data.deviceId,
      outcome: "ok",
      detail: { url: run.url, path: run.path, cloneId: run.cloneId },
    });

    try {
      await run.finished;
      this.#send(ws, { t: "clone_done", cloneId: run.cloneId, path: run.path });
    } catch (err) {
      this.#refuseFilesystem(ws, "repo.clone", err, { url: run.url, path: run.path }, "clone_failed");
    } finally {
      tracked.delete(run);
      if (tracked.size === 0) this.#clones.delete(ws);
    }
  }

  /**
   * Stop every clone this socket started. Called from `#close`, because a
   * clone outlives the frame that asked for it and nothing else would ever
   * stop one whose operator has gone.
   */
  #cancelClones(ws: GatewaySocket): void {
    const running = this.#clones.get(ws);
    if (running === undefined) return;
    this.#clones.delete(ws);
    for (const run of running) run.cancel();
  }

  // -- websocket -------------------------------------------------------------

  /**
   * Narrow a socket the discriminant already identified as a relay leg.
   * Sound because `data` is pinned at upgrade and never reassigned; this is
   * the one place the union is resolved by anything but the check itself.
   */
  #relaySocket(ws: ServerWebSocket<GatewaySocketData>): RelaySocket {
    return ws as RelaySocket;
  }

  #open(ws: GatewaySocket): void {
    this.#sockets.add(ws);
    ws.data.collab = {
      actor: this.#actorOf(ws),
      send: frame => this.#send(ws, frame),
    };
    if (this.#voice) ws.data.voice = this.#voice(frame => this.#send(ws, frame), this.#actorOf(ws));
    this.#send(ws, {
      t: "hello",
      deviceId: ws.data.deviceId,
      // The daemon's own record of what this device may do, read from the
      // same scope set every authorization decision on this socket reads
      // rather than from anything the client claimed at pairing time. A
      // stored hint goes stale the moment a grant is narrowed or rotated;
      // this answer cannot be, because it is the thing being enforced.
      scopes: [...ws.data.scopes],
      agents: ws.data.scopes.has(SCOPE_READ) ? this.#sup.listAgents() : [],
    });
  }

  #close(ws: GatewaySocket): void {
    this.#sockets.delete(ws);
    if (ws.data.collab !== null) {
      this.#collab.leaveAll(ws.data.collab);
      ws.data.collab = null;
    }
    this.#collabGuests.onClientDisconnected(ws);
    this.#unregisterWebViews(ws);
    this.#cancelClones(ws);
    for (const [sessionId, pending] of this.#tuiTakeovers) {
      if (pending.socket !== ws) continue;
      this.#tuiTakeovers.delete(sessionId);
      pending.reject(new Error(`TUI disconnected during takeover of session ${sessionId}`));
    }
    const tui = ws.data.tui;
    ws.data.tui = null;
    const closeAcp = tui?.onAcpClose;
    if (tui) {
      // A hosting terminal dying fails any collab open still waiting on its
      // bridge. Live guest legs observe the room's death through their own
      // socket, so they need nothing here.
      this.#collabGuests.onHostTuiGone(tui.sessionId);
      tui.onAcpClose = undefined;
      tui.onAcpMessage = undefined;
    }
    closeAcp?.();
    void ws.data.voice?.close();
    ws.data.voice = null;
    // The sessions watcher exists for sockets still watching the index; the
    // last one out releases the filesystem handle (the next `sessions` ask
    // restarts it), so an idle daemon watches nothing.
    if (ws.data.watchingSessions && !this.#hasSessionWatchers()) this.#disarmSessionWatcher();
  }

  #unregisterWebView(agentId: AgentId, ws: GatewaySocket): void {
    if (this.#webviews.get(agentId) !== ws) return;
    this.#webviews.delete(agentId);
    this.#onWebViewUnavailable?.(agentId);
  }

  #unregisterWebViews(ws: GatewaySocket): void {
    for (const [agentId, target] of this.#webviews) {
      if (target === ws) this.#unregisterWebView(agentId, ws);
    }
  }

  #message(ws: GatewaySocket, message: string | Buffer): void {
    if (ws.data.revoked) {
      this.#send(ws, { t: "error", code: "unauthorized", message: "this device has been revoked" });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof message === "string" ? message : message.toString());
    } catch {
      // A bad frame is a client bug, not grounds to drop a connection the
      // client may be relying on to finish a turn.
      this.#send(ws, { t: "error", code: "bad_json", message: "frame was not valid JSON" });
      return;
    }

    if (parsed === null || typeof parsed !== "object" || !("t" in parsed)) {
      this.#send(ws, { t: "error", code: "unknown_frame", message: "frame has no type" });
      return;
    }
    const frameType = parsed.t;
    if (typeof frameType !== "string") {
      this.#send(ws, { t: "error", code: "unknown_frame", message: "frame type is not a string" });
      return;
    }

    const tui = ws.data.tui;
    let registeredTuiAcp = false;
    let tuiAcpRaw = "";
    if (frameType === "tui_acp" && tui !== null && "sessionId" in parsed && "raw" in parsed) {
      const sessionId = parsed.sessionId;
      const raw = parsed.raw;
      if (sessionId === tui.sessionId && typeof raw === "string") {
        registeredTuiAcp = true;
        tuiAcpRaw = raw;
      }
    }
    if (registeredTuiAcp && Buffer.byteLength(tuiAcpRaw, "utf8") > MAX_TUI_ACP_FRAME_BYTES) {
      this.#send(ws, { t: "error", code: "frame_too_large", message: "ACP frame exceeds 32 MiB" });
      return;
    }
    const parsedAgentId =
      typeof parsed === "object" && parsed !== null && "agentId" in parsed && typeof parsed.agentId === "string"
        ? (parsed.agentId as AgentId)
        : undefined;
    const parsedSessionId =
      typeof parsed === "object" && parsed !== null && "sessionId" in parsed && typeof parsed.sessionId === "string"
        ? (parsed.sessionId as string)
        : undefined;

    if (!registeredTuiAcp && !ws.data.bucket.take()) {
      this.#send(ws, {
        t: "error",
        agentId: parsedAgentId,
        sessionId: parsedSessionId,
        code: "rate_limited",
        message: "too many frames",
      });
      return;
    }

    // Narrowed as far as a discriminant can take it. Whether the rest of the
    // frame matches its type is checked per case below, because the wire is
    // not a place to assume anyone kept to the contract.
    const frame = parsed as ClientFrame;
    try {
      this.#handle(ws, frame, frameType);
    } catch (err) {
      // Last line of defence. A frame handler that throws would otherwise take
      // the connection, and on an unhandled path the process, down with it. A
      // hostile or merely malformed frame must cost one error frame, no more.
      this.#send(ws, {
        t: "error",
        agentId: parsedAgentId,
        sessionId: parsedSessionId,
        code:
          err instanceof CollabRoomError
            ? err.code
            : err instanceof UnauthorizedError
              ? "unauthorized"
              : "frame_failed",
        message: err instanceof Error ? err.message : "frame handling failed",
      });
    }
  }

  #handle(ws: GatewaySocket, frame: ClientFrame, frameType: string): void {
    switch (frame.t) {
      case "tui_register": {
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "TUI registration requires manage scope" });
          return;
        }
        if (
          typeof frame.sessionId !== "string" ||
          frame.sessionId.length === 0 ||
          typeof frame.cwd !== "string" ||
          frame.cwd.length === 0 ||
          (frame.title !== undefined && typeof frame.title !== "string") ||
          !Number.isSafeInteger(frame.pid) ||
          frame.pid <= 0
        ) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "invalid TUI registration" });
          return;
        }
        const registeredElsewhere = [...this.#sockets].some(
          socket => socket !== ws && socket.data.tui?.sessionId === frame.sessionId,
        );
        if (registeredElsewhere || (ws.data.tui !== null && ws.data.tui.sessionId !== frame.sessionId)) {
          this.#send(ws, { t: "error", code: "session_busy", message: "that TUI session is already registered" });
          return;
        }
        ws.data.tui = {
          sessionId: frame.sessionId,
          cwd: frame.cwd,
          title: frame.title,
          pid: frame.pid,
          agentId: undefined,
          onAcpMessage: undefined,
          onAcpClose: undefined,
        };
        return;
      }

      case "tui_acp": {
        const tui = ws.data.tui;
        if (!tui || frame.sessionId !== tui.sessionId || typeof frame.raw !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "ACP frame has no registered TUI" });
          return;
        }
        tui.onAcpMessage?.(frame.raw);
        return;
      }

      case "tui_acp_ready": {
        const tui = ws.data.tui;
        if (!tui || frame.sessionId !== tui.sessionId) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "takeover acknowledgement has no registered TUI" });
          return;
        }
        void this.#completeLiveTuiTakeover(ws, frame.sessionId);
        return;
      }

      case "session_prompt": {
        // Audited at every exit, including both refusals, because this is a
        // device reaching into a terminal someone else is sitting at and
        // taking a turn in it. A record only on success would leave the two
        // interesting cases -- a device without the scope, and a session
        // nothing owns -- as the only privileged attempts this daemon keeps
        // no trace of. `detail` never carries the text: that is the
        // operator's content, and an audit log is not a transcript.
        const audit = (outcome: "ok" | "denied", detail: Record<string, unknown>): void => {
          this.#store.audit({
            action: "session.prompt",
            actorDeviceId: ws.data.deviceId,
            outcome,
            detail,
          });
        };

        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          audit("denied", { reason: "unauthorized", sessionId: frame.sessionId });
          this.#send(ws, {
            t: "error",
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "unauthorized",
            message: "session prompt requires prompt scope",
          });
          return;
        }
        const images = parsePromptImages(frame.images);
        if (
          typeof frame.sessionId !== "string" ||
          frame.sessionId.length === 0 ||
          typeof frame.text !== "string" ||
          // An image-only prompt is a real prompt; emptiness only rules out a
          // frame with no content of either kind.
          (frame.text.length === 0 && images.ok && images.images.length === 0) ||
          (frame.deliverAs !== undefined && !isTuiSteerDelivery(frame.deliverAs))
        ) {
          // `nextTurn` lands here: `pi.sendUserMessage` has no such mode, and
          // refusing it is the honest answer, not downgrading it to a steer.
          audit("denied", { reason: "bad_frame" });
          this.#send(ws, {
            t: "error",
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "bad_frame",
            message: "invalid session prompt",
          });
          return;
        }
        if (!images.ok) {
          // The same budgets the agent prompt enforces, for the same reason:
          // this frame also rides one relayed socket hop, and a refusal that
          // names itself is the alternative to a disconnect the phone would
          // read as a dead daemon.
          audit("denied", { reason: `attachment_${images.refusal}`, sessionId: frame.sessionId });
          this.#send(ws, {
            t: "error",
            sessionId: frame.sessionId,
            code: `attachment_${images.refusal}`,
            message: PROMPT_IMAGE_REFUSAL_REASONS[images.refusal],
          });
          return;
        }
        const deliverAs: TuiSteerDelivery = frame.deliverAs ?? "steer";
        // Routing trusts the same registry the takeover route trusts: the one
        // socket whose `tui` registration names this session, never a claim
        // about a session file. An absent registration is exactly the
        // condition `tui_unreachable` already names, so a client meets one
        // vocabulary for takeover and for steering alike.
        const owner = [...this.#sockets].find(socket => socket.data.tui?.sessionId === frame.sessionId);
        if (owner === undefined) {
          audit("denied", { reason: "tui_unreachable", sessionId: frame.sessionId, deliverAs });
          this.#send(ws, {
            t: "error",
            sessionId: frame.sessionId,
            code: "tui_unreachable",
            message: `no connected TUI owns session ${frame.sessionId}`,
          });
          return;
        }
        audit("ok", {
          sessionId: frame.sessionId,
          deliverAs,
          ...(images.images.length > 0 ? { images: images.images.length } : {}),
        });
        this.#send(owner, {
          t: "tui_steer",
          sessionId: frame.sessionId,
          text: frame.text,
          deliverAs,
          ...(images.images.length > 0 ? { images: images.images } : {}),
        });
        return;
      }

      case "tui_activity": {
        const tui = ws.data.tui;
        if (!tui || frame.sessionId !== tui.sessionId) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "activity frame has no registered TUI" });
          return;
        }
        if (
          !isTuiActivityKind(frame.kind) ||
          (frame.text !== undefined && typeof frame.text !== "string") ||
          (frame.text !== undefined && Buffer.byteLength(frame.text, "utf8") > MAX_TUI_ACTIVITY_TEXT_BYTES)
        ) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "invalid TUI activity" });
          return;
        }
        // Delivered to watchers only, gate by gate: asked for the index,
        // still holds read, not revoked. Iterating `#sockets` is itself half
        // the guarantee, because revocation closes a socket and `#close`
        // removes it from this set; the `revoked` re-check covers the window
        // between the flag flipping and the close landing. Nothing here is
        // addressed, so no watcher list can go stale behind a dead socket.
        const activity: ServerFrame =
          frame.text === undefined
            ? { t: "tui_activity", sessionId: frame.sessionId, kind: frame.kind }
            : { t: "tui_activity", sessionId: frame.sessionId, kind: frame.kind, text: frame.text };
        for (const watcher of this.#sockets) {
          if (!watcher.data.watchingSessions) continue;
          if (!watcher.data.scopes.has(SCOPE_READ)) continue;
          if (watcher.data.revoked) continue;
          this.#send(watcher, activity);
        }
        return;
      }

      case "ping":
        this.#send(ws, { t: "pong" });
        return;

      case "attach": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "attach requires read scope" });
          return;
        }
        if (typeof frame.agentId !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "attach needs an agentId" });
          return;
        }
        // Registering before the replay is what closes the gap. The store read
        // and the sends below are synchronous, so no live update can interleave
        // and arrive out of order, and `#deliverUpdate` drops anything at or
        // below the high-water mark so nothing arrives twice either.
        ws.data.attached.add(frame.agentId);
        this.#armSessionWatcher();
        const attachedAgent = this.#store.getAgent(frame.agentId);
        if (attachedAgent?.acpSessionId && !TERMINAL_AGENT_STATES.includes(attachedAgent.state) && this.#sessionIndex) {
          const sid = attachedAgent.acpSessionId;
          const key = `${attachedAgent.id}:${sid}`;
          const index = this.#sessionIndex;
          void (async () => {
            const p1 = await index.pathFor(sid);
            if (p1 !== undefined) return;
            const p2 = await index.pathFor(sid);
            if (p2 !== undefined) return;
            if (!ws.data.attached.has(attachedAgent.id) || ws.data.revoked) return;
            if (ws.data.notifiedGoneSessions.has(key)) return;
            ws.data.notifiedGoneSessions.add(key);
            this.#send(ws, {
              t: "error",
              code: "session_gone",
              sessionId: sid,
              agentId: attachedAgent.id,
              message: `session ${sid} has been removed from disk`,
            });
          })();
        }
        if (frame.sinceSeq !== undefined) {
          for (const record of this.#store.updatesSince(frame.agentId, frame.sinceSeq)) {
            this.#deliverUpdate(ws, frame.agentId, record.seq, record.payload);
          }
        }

        // An approval is otherwise only ever pushed live, so a client that
        // connects or reconnects while the agent is already blocked on one
        // sees an agent that is simply not moving, with no way to unblock it.
        // Replaying after the updates puts the ask in the same order it
        // originally arrived in, behind the transcript that led to it. This is
        // the update log's lossless-resume rule applied to the other thing a
        // client cannot reconstruct on its own.
        for (const approval of this.#sup.pendingApprovals()) {
          if (approval.agentId !== frame.agentId) continue;
          this.#deliverApproval(ws, approval);
        }
        for (const review of this.#sup.pendingPlanReviews()) {
          if (review.agentId !== frame.agentId) continue;
          this.#deliverPlanReview(ws, review);
        }
        return;
      }

      case "detach":
        ws.data.attached.delete(frame.agentId);
        if (!this.#hasSessionWatchers()) this.#disarmSessionWatcher();
        // Forget the high-water mark too, so a later attach may replay again.
        ws.data.delivered.delete(frame.agentId);
        // Same for approvals, so a reattach is shown a still-pending ask.
        ws.data.approvals.delete(frame.agentId);
        ws.data.planReviews.delete(frame.agentId);
        // And the spoken summary, so a reattached client is told again what
        // the turn it is watching came to.
        ws.data.said.delete(frame.agentId);
        this.#unregisterWebView(frame.agentId, ws);
        return;

      case "webview_register": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, {
            t: "error",
            code: "unauthorized",
            message: "webview registration requires read scope",
          });
          return;
        }
        if (typeof frame.agentId !== "string" || !ws.data.attached.has(frame.agentId)) {
          this.#send(ws, {
            t: "error",
            code: "webview_not_attached",
            message: "attach to the agent before registering its WebView",
          });
          return;
        }
        const previous = this.#webviews.get(frame.agentId);
        if (previous !== undefined && previous !== ws) this.#unregisterWebView(frame.agentId, previous);
        this.#webviews.set(frame.agentId, ws);
        return;
      }

      case "webview_unregister":
        this.#unregisterWebView(frame.agentId, ws);
        return;

      case "webview_result": {
        if (
          typeof frame.agentId !== "string" ||
          typeof frame.requestId !== "string" ||
          !isWebViewActionResult(frame.result)
        ) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "invalid webview result" });
          return;
        }
        if (this.#webviews.get(frame.agentId) !== ws) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "webview_not_registered",
            message: "this socket is not the active WebView target for the agent",
          });
          return;
        }
        if (this.#onWebViewResult?.(frame.agentId, frame.requestId, frame.result) !== true) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unknown_webview_request",
            message: "the WebView request is unknown or already settled",
          });
        }
        return;
      }

      case "sessions": {
        // The same read gate and the same validation the HTTP index route
        // runs, because a hub-relayed phone reaches this frame instead of
        // that route and must not meet a weaker door here. The reply goes to
        // the asking socket only: the index is an answer to a request, not a
        // broadcast, and one phone refreshing must not push 300 rows at every
        // other client on the daemon.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "sessions requires read scope" });
          return;
        }
        const index = this.#sessionIndex;
        if (!index) {
          this.#send(ws, {
            t: "error",
            code: "sessions_unavailable",
            message: "no session index is wired into this daemon",
          });
          return;
        }
        const parsed = validateSessionQuery(frame.query);
        if ("error" in parsed) {
          this.#send(ws, { t: "error", code: "bad_query", message: parsed.error });
          return;
        }
        // A query that reached this point is a socket watching the index, so
        // it is also opting into live activity about the rows it asked about.
        // Armed after validation, not before: a query the daemon refused must
        // not buy a subscription.
        ws.data.watchingSessions = true;
        // The last query this socket asked with, re-served on every
        // watcher-driven push below: a socket filtering to one project keeps
        // seeing that project's rows, and a query-less ask (a real ask, per
        // the client's replay contract) keeps seeing the whole catalog.
        ws.data.sessionQuery = parsed.query;
        // Armed before the reply is served, for the same reason `attach`
        // registers before its replay: once this socket is counted as a
        // watcher, a filesystem event racing the reply joins the same
        // in-flight index build instead of slipping between the ask and the
        // subscription that lets disk changes reach this socket.
        this.#armSessionWatcher();
        // Deliberately detached, following the prompt case: the index build
        // is cooperative but its reply is still an async answer, and this
        // socket (and every other) must keep being served while it is
        // produced. The client replaces the index wholesale on each frame,
        // so the first-paint frame followed by one upgraded frame once cold
        // counts land is the intended first-paint path, not a duplicate.
        void this.#serveSessionsFrame(ws, index, parsed.query);
        return;
      }

      case "session_tail": {
        // Read scope, matching `attach`: this is a transcript, and a
        // read-only device is already entitled to read one. Nothing about the
        // session changes, so there is no manage gate to pass and nothing to
        // audit that `sessions` does not already leave unaudited.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, {
            t: "error",
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "unauthorized",
            message: "session tail requires read scope",
          });
          return;
        }
        if (
          typeof frame.sessionId !== "string" ||
          frame.sessionId.length === 0 ||
          (frame.limit !== undefined && (!Number.isSafeInteger(frame.limit) || frame.limit <= 0)) ||
          (frame.cursor !== undefined && (!Number.isSafeInteger(frame.cursor) || frame.cursor < 0))
        ) {
          this.#send(ws, {
            t: "error",
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "bad_frame",
            message:
              "session tail needs a sessionId, a positive integer limit when given, and a non-negative integer cursor when given",
          });
          return;
        }
        const tailIndex = this.#sessionIndex;
        if (!tailIndex) {
          this.#send(ws, {
            t: "error",
            sessionId: frame.sessionId,
            code: "sessions_unavailable",
            message: "no session index is wired into this daemon",
          });
          return;
        }
        // Detached like the index reply, and for the same reason: resolving
        // the file and reading its tail are async, and every socket must keep
        // being served while one client's transcript is read.
        void this.#serveSessionTailFrame(ws, tailIndex, frame.sessionId, frame.limit, frame.cursor);
        return;
      }

      case "session_history": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, {
            t: "error",
            agentId: typeof frame.agentId === "string" ? frame.agentId : undefined,
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "unauthorized",
            message: "session history requires read scope",
          });
          return;
        }
        if (
          typeof frame.agentId !== "string" ||
          frame.agentId.length === 0 ||
          typeof frame.sessionId !== "string" ||
          frame.sessionId.length === 0 ||
          (frame.before !== undefined && (!Number.isSafeInteger(frame.before) || frame.before < 0)) ||
          (frame.limit !== undefined && (!Number.isSafeInteger(frame.limit) || frame.limit <= 0))
        ) {
          this.#send(ws, {
            t: "error",
            agentId: typeof frame.agentId === "string" ? frame.agentId : undefined,
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "bad_frame",
            message: "session history frame is malformed",
          });
          return;
        }
        const agent = this.#store.getAgent(frame.agentId);
        if (agent === null || agent.acpSessionId !== frame.sessionId) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            sessionId: frame.sessionId,
            code: "unknown_session",
            message: "agent does not own the requested session",
          });
          return;
        }
        const historyIndex = this.#sessionIndex;
        if (!historyIndex) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            sessionId: frame.sessionId,
            code: "sessions_unavailable",
            message: "no session index is wired",
          });
          return;
        }
        void this.#serveSessionHistoryFrame(
          ws,
          historyIndex,
          frame.agentId,
          frame.sessionId,
          frame.before,
          frame.limit,
        );
        return;
      }

      case "agent_config_read": {
        // The same read gate the HTTP route runs, because a hub-relayed phone
        // reaches this frame instead of that route and must not meet a weaker
        // door here. The reply goes to the asking socket only: a config is the
        // answer to a request, not a broadcast.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "agent config requires read scope",
          });
          return;
        }
        if (typeof frame.agentId !== "string" || frame.agentId.length === 0) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "agent_config_read needs an agentId" });
          return;
        }
        const configured = this.#resolveAgentSession(ws, frame.agentId);
        if (!configured) return;
        const options = configured.sessions.configFor(configured.sessionId);
        // The same 503 the HTTP route gives when the session has reported no
        // config yet: an empty answer would read as an agent with no modes,
        // which is a different and false statement.
        if (!options) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "config_unavailable",
            message: `no config has been reported for agent ${frame.agentId}`,
          });
          return;
        }
        this.#send(ws, { t: "agent_config", agentId: frame.agentId, configOptions: options });
        return;
      }

      case "agent_config_write": {
        // Prompt rather than manage, the HTTP route's own bar and for its
        // reason: `plan` is the read-only mode, so moving off it widens what
        // the agent may do and a device holding only `read` must not be able
        // to do that, while anyone who can send a prompt can already make a
        // default-mode agent act.
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "agent_config_write requires prompt scope",
          });
          return;
        }
        // The wire is not a place to assume anyone kept to the contract: the
        // same value checks the HTTP route runs on its body, on the two fields
        // this frame owns.
        if (
          typeof frame.agentId !== "string" ||
          frame.agentId.length === 0 ||
          typeof frame.modeId !== "string" ||
          frame.modeId.length === 0
        ) {
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "agent_config_write needs an agentId and a non-empty modeId",
          });
          return;
        }
        const target = this.#resolveAgentSession(ws, frame.agentId);
        if (!target) return;
        // Checked against what this session actually offers, exactly as the
        // HTTP route does: forwarding an unknown mode would either be ignored
        // or wedge the turn, and both look like the daemon losing the request.
        const known = target.sessions.configFor(target.sessionId)?.find(option => option.id === MODE_OPTION_ID);
        if (known && !known.options.some(choice => choice.value === frame.modeId)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unknown_mode",
            message: `agent ${frame.agentId} has no mode ${frame.modeId}; it offers ${known.options
              .map(choice => choice.value)
              .join(", ")}`,
          });
          return;
        }
        // Detached like the session index reply, and for the same reason:
        // `session/set_mode` is a round trip to the agent, and every socket
        // must keep being served while one client's mode change lands.
        void this.#serveAgentConfigWrite(ws, target.sessions, target.sessionId, frame.agentId, frame.modeId);
        return;
      }

      case "skills_read": {
        // The same read gate the HTTP route runs, because a hub-relayed phone
        // reaches this frame instead of that route and must not meet a weaker
        // door here. The reply goes to the asking socket only: a catalogue is
        // an answer to a request, not a broadcast.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "skills_read requires read scope" });
          return;
        }
        if (!isCatalogQuery(frame)) {
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "skills_read needs a string cwd and agentId, when given",
          });
          return;
        }
        // Detached like the session index: discovery is async, and this
        // socket keeps being served while the catalogue is read.
        void this.#serveSkillsRead(ws, frame);
        return;
      }

      case "connectors_read": {
        // Read, the same gate and for the same reason as `skills_read`.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "connectors_read requires read scope" });
          return;
        }
        if (!isCatalogQuery(frame)) {
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "connectors_read needs a string cwd and agentId, when given",
          });
          return;
        }
        void this.#serveConnectorsRead(ws, frame);
        return;
      }

      case "tasks_read": {
        // Read, matching `GET /v1/tasks`: the roster is watching, not acting.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "tasks_read requires read scope" });
          return;
        }
        if (frame.agentId !== undefined && typeof frame.agentId !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "tasks_read needs a string agentId, when given" });
          return;
        }
        const outcome = this.#listTasks(frame.agentId);
        if (outcome.kind === "off") {
          this.#send(ws, {
            t: "error",
            code: "tasks_unavailable",
            message: "no task lifecycle is wired into this daemon",
          });
          return;
        }
        this.#send(ws, { t: "tasks", tasks: outcome.value });
        return;
      }

      case "task_create": {
        // Prompt, the HTTP route's own bar and for its reason: a task is a
        // named prompt against a session that already exists, so anyone who
        // may prompt may start one, and a read-only device may not.
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "task_create requires prompt scope" });
          return;
        }
        // The same value checks the shared path runs; the frame carries no
        // `bad_json` equivalent because it arrived parsed, so a wrong shape
        // is a bad_frame rather than a parse failure.
        if (
          typeof frame.title !== "string" ||
          typeof frame.prompt !== "string" ||
          typeof frame.agentId !== "string" ||
          (frame.skillName !== undefined && typeof frame.skillName !== "string")
        ) {
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "task_create needs a title, a prompt, an agentId, and a string skillName when given",
          });
          return;
        }
        // Detached like `routine_run`: `Supervisor.prompt` runs the prompt,
        // and every socket keeps being served while it lands.
        void this.#serveTaskMutation(ws, "task_create", this.#createTask(frame, this.#actorOf(ws)));
        return;
      }

      case "task_cancel": {
        // Prompt, the same gate the HTTP cancel route and the `cancel` frame
        // take: cancelling a task is cancelling the prompt that runs it.
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "task_cancel requires prompt scope" });
          return;
        }
        if (typeof frame.taskId !== "string" || frame.taskId.length === 0) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "task_cancel needs a non-empty taskId" });
          return;
        }
        void this.#serveTaskMutation(ws, "task_cancel", this.#cancelTask(frame.taskId, this.#actorOf(ws)));
        return;
      }

      case "agent_create": {
        // Manage, the HTTP route's own bar: this provisions a host, which is
        // the most privileged thing a device can ask for over either door.
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "agent_create requires manage scope" });
          return;
        }
        if (typeof frame.name !== "string" || typeof frame.cwd !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "agent_create needs a name and a cwd" });
          return;
        }
        // Detached like `session_create`: provisioning a host is async, and
        // this socket keeps being served while the container comes up.
        void this.#serveAgentCreate(ws, frame);
        return;
      }

      case "settings_read": {
        // The same read gate the HTTP route runs, because a hub-relayed
        // phone reaches this frame instead of that route and must not meet
        // a weaker door here. The reply goes to the asking socket only:
        // settings are an answer to a request, not a broadcast.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "settings requires read scope" });
          return;
        }
        const config = this.#syncConfig;
        if (!config) {
          this.#send(ws, {
            t: "error",
            code: "settings_unavailable",
            message: "no settings store is wired into this daemon",
          });
          return;
        }
        try {
          this.#send(ws, { t: "settings", ...config.read() });
        } catch (err) {
          this.#send(ws, {
            t: "error",
            code: "settings_failed",
            message: err instanceof Error ? err.message : "settings read failed",
          });
        }
        return;
      }

      case "settings_write": {
        // The same manage gate the HTTP route takes: this moves the bar every
        // other scope is measured against, and a read-only phone must not be
        // able to do it by reaching for the socket instead of the route.
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#send(ws, {
            t: "error",
            code: "unauthorized",
            message: "settings_write requires manage scope",
          });
          return;
        }
        // The wire is not a place to assume anyone kept to the contract: the
        // same value checks the HTTP route runs on its body, on the two
        // fields this frame owns. The frame's own `t` is the discriminator,
        // not a field, so it is lifted out before the values are validated.
        const settings = parseSyncSettings({ policyMode: frame.policyMode, keepAwake: frame.keepAwake });
        if (settings === null) {
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message:
              "settings_write needs exactly a policyMode of strict, standard, or trusted and a keepAwake boolean",
          });
          return;
        }
        const config = this.#syncConfig;
        if (!config) {
          this.#send(ws, {
            t: "error",
            code: "settings_unavailable",
            message: "no settings store is wired into this daemon",
          });
          return;
        }
        try {
          config.apply(settings);
          this.#send(ws, { t: "settings", ...config.read() });
        } catch (err) {
          this.#send(ws, {
            t: "error",
            code: "settings_failed",
            message: err instanceof Error ? err.message : "settings apply failed",
          });
        }
        return;
      }

      case "routines_read": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "routines_read requires read scope" });
          return;
        }
        this.#send(ws, this.#routineSnapshot());
        return;
      }

      case "routine_write": {
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "routine_write requires manage scope" });
          return;
        }
        if (!isSyncRoutine(frame.routine)) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "routine_write needs one complete routine" });
          return;
        }
        // Execution hosts are forced local for the reason `/v1/sync/import`
        // forces them. Everything else this frame carries that is the daemon's
        // to decide, rather than a caller's to assert, belongs to the seam:
        // whether this is a create, and the webhook `secretRef`. The frame's
        // wire type requires a ref on a webhook trigger, and the app round
        // trips a snapshot it read, so honouring the value would work right up
        // until a client sent one that named another routine's credential row.
        this.#writeRoutine({
          routine: {
            ...frame.routine,
            actions: frame.routine.actions.map(action => ({ ...action, host: { kind: "local" } })),
          },
          actorDeviceId: ws.data.deviceId,
        });
        this.#send(ws, this.#routineSnapshot());
        return;
      }

      case "routine_run": {
        if (
          typeof frame.routineId !== "string" ||
          frame.routineId.length === 0 ||
          !ws.data.scopes.has(SCOPE_MANAGE) ||
          !ws.data.scopes.has(SCOPE_PROMPT)
        ) {
          this.#send(ws, {
            t: "error",
            code: "unauthorized",
            message: "routine_run requires a routineId plus manage and prompt scope",
          });
          return;
        }
        const runner = this.#routines;
        if (!runner) {
          this.#send(ws, { t: "error", code: "routines_unavailable", message: "no routine runner is wired in" });
          return;
        }
        void runner.runNow(frame.routineId, this.#actorOf(ws)).then(
          run => this.#send(ws, { t: "routine_ran", run }),
          err =>
            this.#send(ws, {
              t: "error",
              code: err instanceof UnauthorizedError ? "unauthorized" : "routine_failed",
              message: err instanceof Error ? err.message : "routine run failed",
            }),
        );
        return;
      }

      case "routine_secret_rotate": {
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#send(ws, {
            t: "error",
            code: "unauthorized",
            message: "routine_secret_rotate requires manage scope",
          });
          return;
        }
        const routine = this.#store.listRoutines().find(candidate => candidate.id === frame.routineId);
        if (!routine) {
          this.#send(ws, { t: "error", code: "not_found", message: "routine not found" });
          return;
        }
        if (routine.trigger.kind !== "webhook") {
          this.#send(ws, { t: "error", code: "not_a_webhook_routine", message: "routine is not webhook-triggered" });
          return;
        }
        const secret = randomBytes(32).toString("base64url");
        this.#store.upsertWebhookSecret(routine.trigger.secretRef, createHash("sha256").update(secret).digest("hex"));
        this.#send(ws, { t: "routine_secret", routineId: routine.id, secret });
        return;
      }

      case "routine_delete": {
        // Audited under the action itself rather than dropped, with no ids:
        // the frame has not been shape-checked yet, so there is nothing here
        // worth recording beyond the attempt. Mirrors `session_delete`.
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          this.#store.audit({
            action: "routine.delete",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "unauthorized" },
          });
          this.#send(ws, { t: "error", code: "unauthorized", message: "routine_delete requires manage scope" });
          return;
        }
        const runner = this.#routines;
        if (!runner) {
          this.#send(ws, {
            t: "error",
            code: "routines_unavailable",
            message: "no routine runner is wired into this daemon",
          });
          return;
        }
        // The wire is not a place to assume anyone kept to the contract. An
        // empty list is refused rather than answered with an empty result,
        // for the same irreversible-operation reason as the HTTP door.
        if (
          !Array.isArray(frame.routineIds) ||
          frame.routineIds.length === 0 ||
          frame.routineIds.some(id => typeof id !== "string" || id.length === 0)
        ) {
          this.#store.audit({
            action: "routine.delete",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "bad_frame" },
          });
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "routine_delete needs at least one non-empty routine id",
          });
          return;
        }
        // Detached like `session_delete`: the runner's answer is async, and
        // this socket keeps being served while it is produced.
        void this.#deleteRoutines(runner, frame.routineIds, ws.data.deviceId).then(
          results => {
            this.#send(ws, { t: "routines_deleted", results });
          },
          (err: unknown) => {
            this.#send(ws, {
              t: "error",
              code: "routine_delete_failed",
              message: err instanceof Error ? err.message : "routine delete failed",
            });
          },
        );
        return;
      }

      case "session_takeover":
      case "session_resume": {
        // Resume is the prerequisite to prompt an indexed dormant session, so
        // it needs the same prompt scope as the interaction that follows.
        // Takeover still seizes a session currently owned by a live terminal
        // and remains manage. Shape and index verification below are identical
        // for both; only the authority they exercise differs.
        const scope = frame.t === "session_resume" ? SCOPE_PROMPT : SCOPE_MANAGE;
        const scopeName = frame.t === "session_resume" ? "prompt" : "manage";
        if (!ws.data.scopes.has(scope)) {
          this.#send(ws, {
            t: "error",
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "unauthorized",
            message: `${frame.t} requires ${scopeName} scope`,
          });
          return;
        }
        // The wire is not a place to assume anyone kept to the contract; the
        // same shape checks `tui_register` runs on its own fields.
        if (
          typeof frame.sessionId !== "string" ||
          frame.sessionId.length === 0 ||
          typeof frame.cwd !== "string" ||
          frame.cwd.length === 0 ||
          (frame.t === "session_takeover" && (!Number.isSafeInteger(frame.pid) || frame.pid <= 0))
        ) {
          this.#send(ws, {
            t: "error",
            sessionId: typeof frame.sessionId === "string" ? frame.sessionId : undefined,
            code: "bad_frame",
            message: `${frame.t} needs a sessionId, a non-empty cwd, and a positive pid when taking over`,
          });
          return;
        }
        void this.#openSessionOverSocket(ws, frame);
        return;
      }

      case "collab_open": {
        // Read is the floor, matching `attach`: opening buys watching, and
        // every write that may follow is gated again at prompt scope. The
        // registry re-resolves the device row itself, the same defense the
        // supervisor runs.
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "collab open requires read scope" });
          return;
        }
        if (typeof frame.sessionId !== "string" || frame.sessionId.length === 0) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "collab_open needs a sessionId" });
          return;
        }
        const link = "link" in frame && typeof frame.link === "string" ? frame.link : undefined;
        if ("link" in frame && frame.link !== undefined && typeof frame.link !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "collab_open link must be a string" });
          return;
        }
        if (link !== undefined) {
          const parsed = parseCollabLink(link);
          if ("error" in parsed) {
            this.#send(ws, {
              t: "error",
              sessionId: frame.sessionId,
              code: "collab_refused",
              reason: "invalid_link",
              message: COLLAB_REFUSAL_REASONS.invalid_link,
            });
            return;
          }
          const relayUrlObj = new URL(parsed.wsUrl);
          const isLoopback = LOCAL_HOSTNAMES[relayUrlObj.hostname] === true;
          let isOwnRelay = false;
          try {
            const ownOrigin = new URL(this.collabRelayUrl).origin;
            isOwnRelay = relayUrlObj.origin === ownOrigin;
          } catch {
            // not listening
          }
          if (!isLoopback && !isOwnRelay) {
            this.#send(ws, {
              t: "error",
              sessionId: frame.sessionId,
              code: "collab_refused",
              reason: "untrusted_relay",
              message: COLLAB_REFUSAL_REASONS.untrusted_relay,
            });
            return;
          }
        }
        // Deliberately not awaited: the join walks a bridge round trip and a
        // relay handshake, and the socket must stay responsive to `collab_leave`
        // while it runs.
        void this.#collabGuests
          .openCollab(frame.sessionId, this.#actorOf(ws), link, ws)
          .then(outcome => this.#answerCollabOpen(ws, frame.sessionId, outcome))
          .catch((err: unknown) => {
            this.#send(ws, {
              t: "error",
              sessionId: frame.sessionId,
              code: err instanceof UnauthorizedError ? "unauthorized" : "collab_unavailable",
              message: err instanceof Error ? err.message : "collab open failed",
            });
          });
        return;
      }

      case "collab_leave": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "collab leave requires read scope" });
          return;
        }
        if (typeof frame.sessionId !== "string" || frame.sessionId.length === 0) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "collab_leave needs a sessionId" });
          return;
        }
        // Success needs no ack frame: the agent row goes terminal and every
        // attached socket is told through the ordinary `agents` push, which
        // is the same shape a stopped owned agent produces.
        const outcome = this.#collabGuests.leaveCollab(frame.sessionId, this.#actorOf(ws), ws);
        if ("refused" in outcome) {
          this.#send(ws, {
            t: "error",
            sessionId: frame.sessionId,
            code: "collab_refused",
            reason: outcome.refused,
            message: COLLAB_REFUSAL_REASONS[outcome.refused],
          });
        }
        return;
      }

      case "tui_collab_opened":
      case "tui_collab_error":
      case "tui_collab_closed": {
        // Bridge answers ride the registered TUI socket; from any other
        // socket the frame names a request that was never made.
        if (!ws.data.tui) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "collab bridge frame has no registered TUI" });
          return;
        }
        this.#collabGuests.onBridgeFrame(frame);
        return;
      }

      case "session_delete": {
        // Manage, the same gate archiving takes, and the same one takeover
        // takes: this is the operator's own record of their work being
        // destroyed, and a read-only device must not reach it.
        if (!ws.data.scopes.has(SCOPE_MANAGE)) {
          // Audited under the action itself rather than dropped, and with no
          // session id: the frame has not been shape-checked yet, so there is
          // nothing here worth recording beyond the attempt.
          this.#store.audit({
            action: "session.delete",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "unauthorized" },
          });
          this.#send(ws, { t: "error", code: "unauthorized", message: "session_delete requires manage scope" });
          return;
        }
        const index = this.#sessionIndex;
        if (!index) {
          this.#send(ws, {
            t: "error",
            code: "sessions_unavailable",
            message: "no session index is wired into this daemon",
          });
          return;
        }
        // The wire is not a place to assume anyone kept to the contract. An
        // empty list is refused rather than answered with an empty result:
        // for an irreversible operation, "I deleted nothing" and "you asked
        // me to delete nothing" are worth telling apart.
        if (
          !Array.isArray(frame.sessionIds) ||
          frame.sessionIds.length === 0 ||
          frame.sessionIds.some(id => typeof id !== "string" || id.length === 0)
        ) {
          this.#store.audit({
            action: "session.delete",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "bad_frame" },
          });
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "session_delete needs at least one non-empty session id",
          });
          return;
        }
        // Detached like the index build it runs on top of: this walks the
        // sessions tree, and this socket (and every other) keeps being served
        // while it does.
        void this.#deleteSessions(index, frame.sessionIds, ws.data.deviceId).then(
          results => {
            this.#send(ws, { t: "sessions_deleted", results });
          },
          (err: unknown) => {
            this.#send(ws, {
              t: "error",
              code: "session_delete_failed",
              message: err instanceof Error ? err.message : "session delete failed",
            });
          },
        );
        return;
      }

      case "fs_list": {
        // Audited at every exit, refusals included, for the reason
        // `session_prompt` is: this is a device reading the operator's own
        // directories from somewhere else, and a log that kept only the
        // answers would omit exactly the attempts worth reviewing. `manage`
        // rather than `read`, because a browse is the first half of choosing
        // where code runs, and the second half is one frame away.
        if (!this.#authorizeFilesystem(ws, "fs.list", "fs_list", { path: frame.path })) return;
        if (frame.path !== undefined && (typeof frame.path !== "string" || frame.path.length === 0)) {
          this.#store.audit({
            action: "fs.list",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "bad_frame" },
          });
          this.#send(ws, { t: "error", code: "bad_frame", message: "fs_list needs a non-empty path, or none at all" });
          return;
        }
        // Detached like the session index: a directory read is an async
        // answer, and this socket has to keep being served while it is
        // produced.
        void this.#serveFsListing(ws, frame.path);
        return;
      }

      case "session_create": {
        if (!this.#authorizeFilesystem(ws, "session.create", "session_create", { cwd: frame.cwd })) return;
        if (
          typeof frame.cwd !== "string" ||
          frame.cwd.length === 0 ||
          (frame.name !== undefined && typeof frame.name !== "string")
        ) {
          this.#store.audit({
            action: "session.create",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "bad_frame" },
          });
          this.#send(ws, { t: "error", code: "bad_frame", message: "session_create needs a non-empty cwd" });
          return;
        }
        void this.#createSessionOverSocket(ws, frame);
        return;
      }

      case "repo_clone": {
        if (
          !this.#authorizeFilesystem(ws, "repo.clone", "repo_clone", {
            // Deliberately not the url. A url is only safe to record once
            // `validateCloneUrl` has refused the credential-carrying forms,
            // and that has not run yet at this exit.
            parent: frame.parent,
          })
        ) {
          return;
        }
        if (
          typeof frame.url !== "string" ||
          frame.url.length === 0 ||
          typeof frame.parent !== "string" ||
          frame.parent.length === 0 ||
          (frame.name !== undefined && typeof frame.name !== "string")
        ) {
          this.#store.audit({
            action: "repo.clone",
            actorDeviceId: ws.data.deviceId,
            outcome: "denied",
            detail: { reason: "bad_frame", parent: frame.parent },
          });
          this.#send(ws, { t: "error", code: "bad_frame", message: "repo_clone needs a url and a parent directory" });
          return;
        }
        void this.#startCloneOverSocket(ws, frame);
        return;
      }
      case "prompt": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: typeof frame.agentId === "string" ? frame.agentId : undefined,
            code: "unauthorized",
            message: "prompt requires prompt scope",
          });
          return;
        }
        // The image budgets are enforced here rather than in the app: a phone
        // is a peer on this socket, not a trusted client, and the hub's frame
        // cap protects the relay, not the daemon. A refusal names itself so a
        // client can say what to do about it instead of guessing.
        const images = parsePromptImages(frame.images);
        if (!images.ok) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: `attachment_${images.refusal}`,
            message: PROMPT_IMAGE_REFUSAL_REASONS[images.refusal],
          });
          return;
        }
        // Announced before it is sent, so whoever is tracking how a device is
        // talking to an agent learns it typed even if the prompt then fails.
        this.#onTextPrompt?.(frame.agentId, this.#actorOf(ws));
        // A guest agent is steered through its collab leg, not an ACP
        // session: same frame, same scope, different road. Checked before
        // the federation queue so a live local leg is never parked as an
        // intent for a delegate that cannot hold it.
        if (this.#collabGuests.holds(frame.agentId)) {
          try {
            const outcome = this.#collabGuests.prompt(
              frame.agentId,
              frame.text,
              images.images.length > 0 ? images.images : undefined,
              this.#actorOf(ws),
            );
            if ("sent" in outcome) return;
            this.#send(ws, {
              t: "error",
              agentId: frame.agentId,
              code: "collab_refused",
              reason: outcome.refused,
              message: COLLAB_REFUSAL_REASONS[outcome.refused],
            });
          } catch (err) {
            this.#send(ws, {
              t: "error",
              agentId: frame.agentId,
              code: err instanceof UnauthorizedError ? "unauthorized" : "prompt_failed",
              message: err instanceof Error ? err.message : "prompt failed",
            });
          }
          return;
        }
        if (this.#queuesForDelegate(frame.agentId)) {
          this.#enqueueIntent(
            frame.agentId,
            this.#actorOf(ws),
            "prompt",
            images.images.length > 0 ? { text: frame.text, images: images.images } : { text: frame.text },
          );
          return;
        }

        // Deliberately not awaited: a turn outlives the frame that started it,
        // and the socket has to stay responsive to `cancel` while it runs.
        void this.#sup
          .prompt(frame.agentId, frame.text, this.#actorOf(ws), images.images.length > 0 ? images.images : undefined)
          .catch((err: unknown) => {
            this.#send(ws, {
              t: "error",
              agentId: frame.agentId,
              code:
                err instanceof AgentBusyError
                  ? "agent_busy"
                  : err instanceof UnauthorizedError
                    ? "unauthorized"
                    : "prompt_failed",
              message: err instanceof Error ? err.message : "prompt failed",
            });
          });
        return;
      }

      case "cancel": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: typeof frame.agentId === "string" ? frame.agentId : undefined,
            code: "unauthorized",
            message: "cancel requires prompt scope",
          });
          return;
        }
        // A guest agent's interrupt is the collab `abort` frame, same scope
        // gate, placed before the federation queue for the same reason the
        // prompt interception is.
        if (this.#collabGuests.holds(frame.agentId)) {
          try {
            const outcome = this.#collabGuests.abort(frame.agentId, this.#actorOf(ws));
            if ("sent" in outcome) return;
            this.#send(ws, {
              t: "error",
              agentId: frame.agentId,
              code: "collab_refused",
              reason: outcome.refused,
              message: COLLAB_REFUSAL_REASONS[outcome.refused],
            });
          } catch (err) {
            this.#send(ws, {
              t: "error",
              agentId: frame.agentId,
              code: err instanceof UnauthorizedError ? "unauthorized" : "cancel_failed",
              message: err instanceof Error ? err.message : "cancel failed",
            });
          }
          return;
        }
        if (this.#queuesForDelegate(frame.agentId)) {
          this.#enqueueIntent(frame.agentId, this.#actorOf(ws), "cancel", {});
          return;
        }

        void this.#sup.cancel(frame.agentId, this.#actorOf(ws)).catch((err: unknown) => {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: err instanceof UnauthorizedError ? "unauthorized" : "cancel_failed",
            message: err instanceof Error ? err.message : "cancel failed",
          });
        });
        return;
      }

      case "plan_decide": {
        if (
          typeof frame.agentId !== "string" ||
          typeof frame.requestId !== "string" ||
          (frame.choice !== "Approve and execute" && frame.choice !== "Refine plan")
        ) {
          this.#send(ws, { t: "error", code: "bad_frame", message: "invalid plan decision" });
          return;
        }
        if (!this.#sup.decidePlan(frame.requestId, frame.choice, this.#actorOf(ws))) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "plan decision refused: unknown request or missing approve scope",
          });
        }
        return;
      }

      case "device_invite": {
        // The sealed-socket counterpart of the two HTTP pairing routes: the
        // hub has no tunnel wired for either of them, so from anywhere but
        // the daemon's own network this frame is the only road to inviting a
        // device that exists at all. The same approve gate and the same
        // ceiling the route runs, because a weaker door on the socket would
        // be a stronger door in disguise.
        if (!ws.data.scopes.has(SCOPE_APPROVE)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "device invite requires approve scope" });
          return;
        }
        // The wire is not a place to assume anyone kept to the contract; the
        // same shape discipline every other frame runs on its own fields.
        if (typeof frame.name !== "string" || !Array.isArray(frame.scopes)) {
          this.#send(ws, {
            t: "error",
            code: "bad_frame",
            message: "device invite needs a name and a scopes array",
          });
          return;
        }
        const ceiling = narrowGrantedScopes(frame.scopes, ws.data.scopes);
        if ("error" in ceiling) {
          if (ceiling.error === "unknown_scope") {
            this.#send(ws, {
              t: "error",
              code: "bad_frame",
              message: `device invite scopes must be among ${KNOWN_SCOPES.join(", ")}`,
            });
            return;
          }
          this.#send(ws, {
            t: "error",
            code: "unauthorized",
            message: `this device cannot grant ${ceiling.missing.join(", ")}: it does not hold that scope itself`,
          });
          return;
        }
        const { token, name } = this.#auth.inviteDevice(ws.data.deviceId, frame.name, ceiling.granted);
        // The asking socket only, ever: the token is the one-time view of a
        // credential, and a broadcast or a replay would be a second
        // credential in the wild minted by nobody.
        this.#send(ws, { t: "device_invited", token, name, scopes: ceiling.granted });
        return;
      }

      case "decide": {
        if (!ws.data.scopes.has(SCOPE_APPROVE)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "decision requires approve scope",
          });
          return;
        }
        if (this.#queuesForDelegate(frame.agentId)) {
          this.#enqueueIntent(frame.agentId, this.#actorOf(ws), "decide", {
            requestId: frame.requestId,
            choice: frame.choice,
            scope: frame.scope ?? "once",
          });
          return;
        }

        // The frame contributes a request id and a choice. Everything about who
        // is asking comes from the socket's resolved identity, and the
        // supervisor re-reads the device row before honouring any of it, so a
        // client cannot name a device or a scope it does not hold. A false
        // return means unknown request or insufficient scope, and the pending
        // approval is left to policy and the timeout.
        const accepted = this.#sup.decide(frame.requestId, frame.choice, frame.scope ?? "once", this.#actorOf(ws));
        if (!accepted) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "decision refused: unknown request or missing approve scope",
          });
        }
        return;
      }

      case "room_join": {
        if (!ws.data.scopes.has(SCOPE_READ)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "room join requires read scope" });
          return;
        }
        if (typeof frame.roomId !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "room join needs a roomId" });
          return;
        }
        this.#collab.join(frame.roomId, this.#collabConnection(ws));
        return;
      }

      case "room_leave": {
        if (typeof frame.roomId !== "string") {
          this.#send(ws, { t: "error", code: "bad_frame", message: "room leave needs a roomId" });
          return;
        }
        this.#collab.leave(frame.roomId, this.#collabConnection(ws));
        return;
      }

      case "room_offer":
      case "room_answer":
      case "ice_candidate": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "room signaling requires prompt scope" });
          return;
        }
        this.#collab.relaySignal(frame, this.#collabConnection(ws));
        return;
      }

      case "collab_voice_note": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, { t: "error", code: "unauthorized", message: "voice notes require prompt scope" });
          return;
        }
        this.#collab.publishVoiceNote(frame, this.#collabConnection(ws));
        return;
      }

      case "audio":
      case "audio_end": {
        if (!ws.data.scopes.has(SCOPE_PROMPT)) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "unauthorized",
            message: "audio requires prompt scope",
          });
          return;
        }
        const voice = ws.data.voice;
        if (!voice) {
          this.#send(ws, {
            t: "error",
            agentId: frame.agentId,
            code: "voice_unavailable",
            message: "no voice bridge is attached to this daemon",
          });
          return;
        }
        void voice.handleFrame(frame, this.#actorOf(ws));
        return;
      }

      default:
        this.#send(ws, {
          t: "error",
          code: "unknown_frame",
          message: `unsupported frame type ${frameType}`,
        });
    }
  }

  // -- internals -------------------------------------------------------------

  /**
   * The identity a frame acts under.
   *
   * Resolved at connect time from the device row, never from frame contents.
   * Revocation mid-session is still honoured because every privileged call this
   * feeds re-reads the device row and rejects a revoked one.
   */
  #actorOf(ws: GatewaySocket): Actor {
    return { deviceId: ws.data.deviceId, scopes: [...ws.data.scopes] };
  }

  /**
   * A room membership holds this exact connection object. Reconstructing one
   * per frame would let a stale socket remove a newer login by the same device.
   */
  #collabConnection(ws: GatewaySocket): CollabConnection {
    if (ws.data.collab === null) throw new Error("collaboration connection was not initialised");
    return ws.data.collab;
  }

  /** Translate one `collab_open` outcome into the frames a phone expects: success, a named refusal, or the wire failure. */
  #answerCollabOpen(
    ws: GatewaySocket,
    sessionId: string,
    outcome: Awaited<ReturnType<CollabGuests["openCollab"]>>,
  ): void {
    if ("opened" in outcome) {
      this.#send(ws, {
        t: "collab_opened",
        sessionId,
        agentId: outcome.agentId,
        readOnly: outcome.readOnly,
      });
      return;
    }
    if ("refused" in outcome) {
      const refusal: CollabRefusal = outcome.refused;
      this.#send(ws, {
        t: "error",
        sessionId,
        code: "collab_refused",
        reason: refusal,
        message: COLLAB_REFUSAL_REASONS[refusal],
      });
      return;
    }
    this.#send(ws, { t: "error", sessionId, code: "collab_unavailable", message: outcome.unavailable });
  }

  #deliverUpdate(ws: GatewaySocket, agentId: AgentId, seq: number, update: unknown): void {
    // The single choke point replay and live traffic share, so a frame the
    // socket already has can never be sent twice.
    const delivered = ws.data.delivered.get(agentId) ?? 0;
    if (seq <= delivered) return;
    ws.data.delivered.set(agentId, seq);
    this.#send(ws, { t: "update", agentId, seq, update });
  }

  /**
   * The approval counterpart to `#deliverUpdate`, and the only place an
   * `approval` frame is written.
   *
   * Keyed by request id rather than by a high-water mark, because approvals
   * settle out of order and a pending set shrinks as well as grows. Detach
   * clears the agent's set, so a deliberate reattach can be shown the ask
   * again while a duplicate attach cannot.
   */
  #deliverApproval(ws: GatewaySocket, approval: Omit<PendingApproval, "resolve">): void {
    let sent = ws.data.approvals.get(approval.agentId);
    if (!sent) {
      sent = new Set<string>();
      ws.data.approvals.set(approval.agentId, sent);
    }
    if (sent.has(approval.requestId)) return;
    sent.add(approval.requestId);
    this.#send(ws, {
      t: "approval",
      agentId: approval.agentId,
      requestId: approval.requestId,
      title: approval.title,
      tool: approval.tool,
      input: approval.input,
    });
  }

  #deliverPlanReview(ws: GatewaySocket, review: Omit<PendingPlanReview, "resolve">): void {
    let sent = ws.data.planReviews.get(review.agentId);
    if (!sent) {
      sent = new Set<string>();
      ws.data.planReviews.set(review.agentId, sent);
    }
    if (sent.has(review.requestId)) return;
    sent.add(review.requestId);
    this.#send(ws, {
      t: "plan_review",
      agentId: review.agentId,
      requestId: review.requestId,
      message: review.message,
      choices: review.choices,
    });
  }

  #hasSessionWatchers(): boolean {
    for (const other of this.#sockets) {
      if ((other.data.watchingSessions || other.data.attached.size > 0) && !other.data.revoked) return true;
    }
    return false;
  }

  /**
   * Start the sessions-root watcher unless one is already running. Called
   * from the `sessions` frame because the ask is the opt-in: watching the
   * filesystem is something a listing socket buys, not a daemon-wide
   * default. A null start (no sessions root on this machine yet) is not
   * memoized, so the next ask retries and picks the root up once the first
   * local session creates it.
   */
  #armSessionWatcher(): void {
    if (this.#sessionWatch !== undefined) return;
    const index = this.#sessionIndex;
    if (!index) return;
    const handle = index.watch(() => this.#pushSessionsToWatchers(), {
      onError: err => {
        this.#onError?.(err instanceof Error ? err : new Error(String(err)));
        // A failed watch degrades this daemon to pull-only: every `sessions`
        // ask still rebuilds from disk, so the failure is reported and the
        // handle forgotten rather than retried in a loop.
        if (this.#sessionWatch === handle) this.#sessionWatch = undefined;
      },
    });
    if (handle === null) return;
    this.#sessionWatch = handle;
  }

  #disarmSessionWatcher(): void {
    this.#sessionWatch?.stop();
    this.#sessionWatch = undefined;
  }

  /**
   * One debounced filesystem change, fanned out to the sockets that asked
   * for the index and may still read it: the same gate per socket as
   * `tui_activity` (asked, read scope, not revoked), because iterating
   * `#sockets` is half the guarantee and the per-socket checks are the
   * other half. Never a broadcast: a socket that never asked is pushed
   * nothing, the same line the asking reply already draws.
   *
   * Every push runs through `#serveSessionsFrame`, whose `queryWithWarm`
   * joins any in-flight build rather than queueing a second scan behind it,
   * so a filesystem change landing mid-build costs one shared build, not
   * two.
   */
  #pushSessionsToWatchers(): void {
    const index = this.#sessionIndex;
    if (!index) return;
    let watchers = 0;
    for (const ws of this.#sockets) {
      if (ws.data.revoked) continue;
      if (ws.data.watchingSessions && ws.data.scopes.has(SCOPE_READ)) {
        watchers += 1;
        void this.#serveSessionsFrame(ws, index, ws.data.sessionQuery);
      } else if (ws.data.attached.size > 0) {
        watchers += 1;
      }
    }
    if (watchers === 0) this.#disarmSessionWatcher();
    void this.#checkGoneSessions();
  }

  async #checkGoneSessions(): Promise<void> {
    const index = this.#sessionIndex;
    if (!index) return;
    for (const agent of this.#sup.listAgents()) {
      if (!agent.acpSessionId || TERMINAL_AGENT_STATES.includes(agent.state)) continue;
      const key = `${agent.id}:${agent.acpSessionId}`;

      const path1 = await index.pathFor(agent.acpSessionId);
      if (path1 !== undefined) {
        for (const ws of this.#sockets) {
          ws.data.notifiedGoneSessions.delete(key);
        }
        continue;
      }

      // D3: Confirm absence with a fresh second lookup after the first miss before emitting
      const path2 = await index.pathFor(agent.acpSessionId);
      if (path2 !== undefined) {
        for (const ws of this.#sockets) {
          ws.data.notifiedGoneSessions.delete(key);
        }
        continue;
      }

      for (const ws of this.#sockets) {
        if (!ws.data.attached.has(agent.id) || ws.data.revoked) continue;
        if (ws.data.notifiedGoneSessions.has(key)) continue;
        ws.data.notifiedGoneSessions.add(key);
        this.#send(ws, {
          t: "error",
          code: "session_gone",
          sessionId: agent.acpSessionId,
          agentId: agent.id,
          message: `session ${agent.acpSessionId} has been removed from disk`,
        });
      }
    }
  }

  /**
   * One socket `sessions` request: a first-paint frame the moment the
   * shared build resolves -- every row, counts from cache where known and
   * null where not -- then, when the background warm pass fills those
   * counts in, exactly one upgraded frame with the same query re-run. The
   * client replaces the index wholesale per frame, so a null count shown
   * briefly is honest and a fabricated 0 never appears. A warm pass that
   * finishes after the socket closes lands in `#send`'s quiet catch; a
   * reconnect replay arriving meanwhile joins the same in-flight build
   * instead of multiplying the work.
   */
  async #serveSessionsFrame(ws: GatewaySocket, index: SessionIndex, query: SessionQuery): Promise<void> {
    try {
      const { sessions, warmed } = await index.queryWithWarm(query);
      this.#send(ws, { t: "sessions", sessions });
      if (warmed === null) return;
      const upgraded = await warmed;
      this.#send(ws, { t: "sessions", sessions: upgraded });
    } catch (err) {
      // Detached from `#handle`, so its last-line-of-defence try/catch no
      // longer covers this; an answer that cannot be produced must still
      // cost the asking socket exactly one error frame, not a dropped one.
      this.#send(ws, {
        t: "error",
        code: "sessions_failed",
        message: err instanceof Error ? err.message : "session index failed",
      });
    }
  }

  /**
   * The one place a session deletion happens, for both doors: the HTTP route
   * and the socket frame. Shared rather than duplicated because the audit
   * record is the point -- two copies would eventually disagree about what
   * gets written, and the log of who destroyed an operator's transcripts is
   * the last thing that should depend on which road the request took.
   *
   * One record per id, whichever way that id went, carrying the id and the
   * refusal when there was one. `outcome` is `ok` for a deletion and `denied`
   * for a live or unknown session, because both of those are decisions this
   * daemon made about the request; a removal that failed on the machine is
   * `error`, because nothing decided it.
   */
  async #deleteSessions(
    index: SessionIndex,
    sessionIds: readonly string[],
    actorDeviceId: string,
  ): Promise<SessionDeleteResult[]> {
    const results = await index.delete(sessionIds);
    for (const result of results) {
      this.#store.audit({
        action: "session.delete",
        actorDeviceId,
        outcome: result.deleted ? "ok" : result.refusal === "failed" ? "error" : "denied",
        detail: result.deleted
          ? { sessionId: result.sessionId }
          : {
              sessionId: result.sessionId,
              refusal: result.refusal,
              reason: SESSION_DELETE_REFUSAL_REASONS[result.refusal],
            },
      });
    }
    return results;
  }

  /**
   * The one place a routine definition reaches the store, for every door that
   * writes one: `POST /v1/routines`, `PATCH /v1/routines/:id`, the app's
   * `routine_write` frame, and `/v1/sync/import`.
   *
   * Two things live here because they cannot be trusted to a caller, and
   * because a door that skips either one is indistinguishable from a door that
   * does not.
   *
   * **Whether this is a create.** Decided by looking, never by what a caller
   * says. `routine_write` and sync import are both upserts, so the same request
   * shape arms a new automation or edits an existing one and only the store
   * knows which.
   *
   * **The webhook credential.** A caller never chooses a `secretRef`. The
   * socket frame and a sync document both carry one in their wire type, and
   * honouring it lets two routines point at one credential row, where rotating
   * either silently breaks the other. So the incoming value is read for its
   * kind and discarded, and the ref is either the one already on disk or a
   * freshly minted one. See `#adoptTrigger`.
   *
   * The definition, the credential a retarget withdraws, and the audit row all
   * go through `store.commitRoutineWrite` as one transaction. Separately they
   * were three writes, and the invariant this seam exists to hold, that no door
   * arms an automation without leaving a record, was a hope: a committed
   * definition followed by a failed audit insert left the automation as the only
   * trace of itself. All three now commit or roll back together, so a failed
   * audit leaves no routine rather than an unrecorded one, and a withdrawal can
   * no longer outlive the definition that stopped naming it.
   *
   * The withdrawal is still ordered after the write inside that transaction.
   * That ordering no longer guards against a crash between them, because there
   * is no longer a between; it is kept because a rollback undoes both and a
   * reader should not have to reason about a delete that precedes the row it
   * depends on.
   *
   * `audit` is a callback because only the caller knows whether this write is one
   * arming decision to record or one routine inside a restore that records
   * itself once for the whole catalogue. It is invoked here and its result is
   * handed to the store, so it runs before the transaction opens and a throw
   * from it writes nothing at all.
   */
  #persistRoutine(
    input: Omit<Routine, "trigger"> & { trigger: TriggerDraft | Routine["trigger"] },
    audit?: (created: boolean, routine: Routine) => AuditInput,
  ): { routine: Routine; created: boolean } {
    const existing = this.#store.listRoutines().find(candidate => candidate.id === input.id);
    const created = existing === undefined;
    const routine: Routine = { ...input, trigger: this.#adoptTrigger(existing?.trigger, input.trigger) };
    // The capability is exactly what a retarget withdraws, so the credential
    // goes with it. A surviving hash is a live secret nothing in the catalogue
    // names any more: nothing lists it and nothing can rotate it.
    const withdrawn =
      existing?.trigger.kind === "webhook" && routine.trigger.kind !== "webhook"
        ? existing.trigger.secretRef
        : undefined;
    this.#store.commitRoutineWrite({
      routine,
      ...(withdrawn === undefined ? {} : { withdrawSecretRef: withdrawn }),
      ...(audit === undefined ? {} : { audit: audit(created, routine) }),
    });
    return { routine, created };
  }

  /**
   * The `secretRef` a written routine ends up with, given what is already on
   * disk. Pure: it decides a value and touches nothing. The withdrawal of the
   * row that value replaces belongs to `#persistRoutine`, in the same
   * transaction as the write, so neither can land without the other.
   *
   * - webhook staying webhook keeps the stored ref verbatim, whatever the
   *   incoming definition claims. It is the public half of the endpoint's
   *   identity, so re-minting it on an edit that never mentioned the webhook
   *   would break a URL already handed out and every secret rotated against it.
   * - anything else becoming webhook mints a fresh ref, so no two routines can
   *   be made to share one credential row, and so a ref minted by some other
   *   daemon and carried in a sync document never names a row here.
   */
  #adoptTrigger(current: Routine["trigger"] | undefined, next: TriggerDraft | Routine["trigger"]): Routine["trigger"] {
    if (next.kind !== "webhook") return next;
    return current?.kind === "webhook" ? current : { kind: "webhook", secretRef: mintId("whsec") };
  }

  /**
   * One routine written and recorded, which is every door except sync import.
   *
   * Before this seam existed the socket frame wrote no audit row at all, which
   * is how `routine.create` came to be a declared audit action nothing ever
   * emitted: whether arming an automation on this machine was recorded depended
   * on which road the request took.
   *
   * `/v1/sync/import` writes through `#persistRoutine` and records itself as
   * one `sync.import` row instead. It is a whole-state restore and answers with
   * a count, so fifty rows here would be fifty separate arming decisions nobody
   * made, which reads worse than one restore recorded as a restore.
   *
   * `detail` never carries a webhook secret nor the `secretRef` that names one.
   * It is the single free-form field on an audit row, so it is the one place a
   * credential could reach a log meant to be safe to read, print, and hand to
   * whoever is diagnosing a machine. The trigger is recorded by kind alone,
   * which is all a reader needs to know what armed the routine.
   */
  #writeRoutine(input: {
    routine: Omit<Routine, "trigger"> & { trigger: TriggerDraft | Routine["trigger"] };
    actorDeviceId: string;
  }): Routine {
    const { routine } = this.#persistRoutine(input.routine, (created, written) => ({
      action: created ? "routine.create" : "routine.update",
      actorDeviceId: input.actorDeviceId,
      outcome: "ok",
      detail: {
        routineId: written.id,
        name: written.name,
        trigger: written.trigger.kind,
        actions: written.actions.length,
      },
    }));
    return routine;
  }

  /**
   * The one place a routine deletion happens, for both doors: the HTTP route
   * and the socket frame. Shared for the same reason as `#deleteSessions` --
   * two copies would eventually disagree about what gets written, and the log
   * of who destroyed an operator's automation is the last thing that should
   * depend on which road the request took.
   *
   * One record per id, whichever way that id went. `outcome` is `ok` for a
   * deletion, `denied` for a running or unknown routine (both decisions this
   * daemon made), and `error` for a store failure, because nothing decided it.
   */
  async #deleteRoutines(
    runner: RoutineRunner,
    routineIds: readonly string[],
    actorDeviceId: string,
  ): Promise<RoutineDeleteResult[]> {
    const results = await runner.deleteRoutines(routineIds);
    for (const result of results) {
      this.#store.audit({
        action: "routine.delete",
        actorDeviceId,
        outcome: result.deleted ? "ok" : result.refusal === "failed" ? "error" : "denied",
        detail: result.deleted
          ? { routineId: result.routineId }
          : {
              routineId: result.routineId,
              refusal: result.refusal,
              reason: ROUTINE_DELETE_REFUSAL_REASONS[result.refusal],
            },
      });
    }
    return results;
  }

  /**
   * One socket `session_tail` request: the session's file located through the
   * index (which refuses an id the catalog does not hold, so a client cannot
   * name an arbitrary path), then one page of its turns read from the end,
   * or from the cursor an earlier page handed the client.
   *
   * The limit is clamped here as well as in the reader, because the gateway
   * is the door: a client asking for a million turns gets the ceiling, not a
   * refusal, since the honest answer to "show me more" is as much as a frame
   * can carry. The cursor is not clamped here: only the reader knows the
   * file's size, and it answers an offset past the end as exhaustion.
   */
  async #serveSessionTailFrame(
    ws: GatewaySocket,
    index: SessionIndex,
    sessionId: string,
    limit: number | undefined,
    cursor: number | undefined,
  ): Promise<void> {
    try {
      const path = await index.pathFor(sessionId);
      if (path === undefined) {
        this.#send(ws, {
          t: "error",
          sessionId,
          code: "unknown_session",
          message: `no session ${sessionId} on this machine`,
        });
        return;
      }
      const tail = await readSessionTail(path, {
        ...(limit === undefined ? {} : { limit: Math.min(limit, TAIL_MAX_MESSAGES) }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      this.#send(ws, {
        t: "session_tail",
        sessionId,
        messages: tail.messages,
        truncated: tail.truncated,
        nextCursor: tail.nextCursor,
        // Echoed so the asking client can tell this page's place in the file
        // without inferring it from the turns, which a first page and an
        // older page can both leave ambiguous.
        ...(cursor === undefined ? {} : { cursor }),
      });
    } catch (err) {
      // Detached from `#handle`, so its last-line-of-defence try/catch no
      // longer covers this: an answer that cannot be produced must still cost
      // the asking socket exactly one error frame, never a dropped one.
      this.#send(ws, {
        t: "error",
        sessionId,
        code: "session_tail_failed",
        message: err instanceof Error ? err.message : "session tail failed",
      });
    }
  }

  /** One bounded structured history page, addressed only through the index. */
  async #serveSessionHistoryFrame(
    ws: GatewaySocket,
    index: SessionIndex,
    agentId: AgentId,
    sessionId: string,
    before: number | undefined,
    limit: number | undefined,
  ): Promise<void> {
    try {
      const path = await index.pathFor(sessionId);
      if (path === undefined) {
        this.#send(ws, { t: "error", agentId, sessionId, code: "unknown_session", message: `no session ${sessionId}` });
        return;
      }
      const history = await readSessionHistory(path, {
        ...(before === undefined ? {} : { before }),
        ...(limit === undefined ? {} : { limit: Math.min(limit, HISTORY_MAX_TURNS) }),
      });

      // Filter entries to only return turns older than this agent's own update log:
      // entries whose `at` is before the agent's `createdAt`, or before the timestamp
      // of its first stored update, whichever is earlier/more precise.
      // This guarantees that history is "what happened before this agent" and replay
      // is "what happened under it", with zero duplicate overlap.
      const agent = this.#store.getAgent(agentId);
      let cutoffMs = agent ? new Date(agent.createdAt).getTime() : Infinity;
      const firstUpdate = this.#store.updatesSince(agentId, 0, 1)[0];
      if (firstUpdate) {
        const updateMs = new Date(firstUpdate.ts).getTime();
        if (!Number.isNaN(updateMs)) {
          cutoffMs = Math.min(cutoffMs, updateMs);
        }
      }

      const entries = Number.isFinite(cutoffMs)
        ? history.entries.filter(entry => {
            const entryMs = new Date(entry.at).getTime();
            return Number.isNaN(entryMs) || entryMs < cutoffMs;
          })
        : history.entries;

      this.#send(ws, {
        t: "session_history",
        agentId,
        sessionId,
        entries,
        nextBefore: history.nextBefore,
      });
    } catch (err) {
      this.#send(ws, {
        t: "error",
        agentId,
        sessionId,
        code: "session_history_failed",
        message: err instanceof Error ? err.message : "session history failed",
      });
    }
  }

  /**
   * Every routine plus the last runs recorded against each, as one frame. The
   * host secret is stripped on the way out: a surface needs to know a webhook
   * exists, never the value that authenticates a caller to it.
   */
  #routineSnapshot(): Extract<ServerFrame, { t: "routines" }> {
    const routines = this.#store.listRoutines();
    return {
      t: "routines",
      routines: routines.map(routine => ({
        ...routine,
        actions: routine.actions.map(({ host: _host, ...action }) => action),
      })),
      runs: routines.flatMap(routine => this.#store.listRuns(routine.id, 10)),
    };
  }

  /**
   * The live session behind an agent id, or the one named refusal that says
   * why there is none. Shared by both agent-config frames so a phone is told
   * the same thing whichever it sent, and so neither can answer an id the
   * store holds no row for with a crash or with silence.
   *
   * The refusals are the HTTP route's own, one per cause: the seam missing
   * from this daemon, the agent not existing, and the agent existing with no
   * session behind it are three different problems, and an operator whose
   * phone says "unavailable" for all three cannot act on any of them.
   */
  #resolveAgentSession(
    ws: GatewaySocket,
    agentId: AgentId,
  ): { sessions: SessionConfig; sessionId: string } | undefined {
    const sessions = this.#sessions;
    if (!sessions) {
      this.#send(ws, {
        t: "error",
        agentId,
        code: "config_unavailable",
        message: "no session config is wired into this daemon",
      });
      return undefined;
    }
    const agent = this.#store.getAgent(agentId);
    if (!agent) {
      this.#send(ws, {
        t: "error",
        agentId,
        code: "unknown_agent",
        message: `no agent ${agentId} exists on this daemon`,
      });
      return undefined;
    }
    const sessionId = agent.acpSessionId;
    if (sessionId === undefined) {
      this.#send(ws, {
        t: "error",
        agentId,
        code: "no_session",
        message: `agent ${agentId} has no live session to configure`,
      });
      return undefined;
    }
    return { sessions, sessionId };
  }

  /**
   * One socket `agent_config_write`: the mode asked of the session, then the
   * daemon's read-back of what that session now holds. The reply carries the
   * read-back rather than the request, so a client renders the mode the agent
   * actually runs under even if the agent settled somewhere else.
   */
  async #serveAgentConfigWrite(
    ws: GatewaySocket,
    sessions: SessionConfig,
    sessionId: string,
    agentId: AgentId,
    modeId: string,
  ): Promise<void> {
    try {
      // Not audited, for the reason the HTTP route names: `AuditAction` is a
      // frozen closed union with no member for a mode change, and recording
      // this under a member that means something else would corrupt the audit
      // log to fake coverage.
      const options = await sessions.setMode(sessionId, modeId);
      this.#send(ws, { t: "agent_config", agentId, configOptions: options });
    } catch (err) {
      // Detached from `#handle`, so its last-line-of-defence try/catch no
      // longer covers this: a mode change that cannot land must still cost the
      // asking socket exactly one error frame, never a dropped one.
      this.#send(ws, {
        t: "error",
        agentId,
        code: "agent_config_failed",
        message: err instanceof Error ? err.message : "set_mode failed",
      });
    }
  }

  #send(ws: GatewaySocket, frame: ServerFrame): void {
    const buffered = ws.getBufferedAmount?.() ?? 0;
    if (buffered > this.#maxSocketBufferBytes) {
      this.#store.audit({
        action: "socket.backpressure",
        actorDeviceId: ws.data.deviceId,
        outcome: "error",
        detail: { buffered, limit: this.#maxSocketBufferBytes, code: 1013, reason: "backpressure" },
      });
      this.#onLog?.(
        `[gateway] closing socket for ${ws.data.deviceId} due to backpressure: ${buffered} bytes buffered (limit ${this.#maxSocketBufferBytes})`,
      );
      this.#hasClosedSockets = true;
      try {
        ws.close(1013, "backpressure");
      } catch {
        // Socket closed or closing
      }
      this.#close(ws);
      return;
    }
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // The socket went away between an event firing and this send. `#close`
      // removes it from the registry; there is nothing to report to.
    }
  }
}

function isLoopbackPeer(address: string | null): boolean {
  if (address === null) return false;
  const trimmed = address.trim().toLowerCase();
  if (LOCAL_HOSTNAMES[trimmed] === true) return true;
  const ipv4 = trimmed.startsWith("::ffff:") ? trimmed.slice("::ffff:".length) : trimmed;
  return ipv4.startsWith("127.");
}
