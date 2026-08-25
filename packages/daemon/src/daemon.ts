/**
 * The composition root.
 *
 * Six slices were built against fixed contracts and none of them knows the
 * others exist. This is the one file that does: it opens the store, builds the
 * policy, and hands each subsystem exactly the collaborators it declared. Every
 * wiring decision that could otherwise be made twice, differently, is made here
 * once.
 *
 * Two of those decisions are load bearing.
 *
 * **Shutdown is ordered, and the order is not cosmetic.** The scheduler stops
 * first so no new run is queued, then the runs already in flight are drained
 * while the hosts serving them are still up: cancelling a turn needs its host,
 * and a run that cannot write its terminal record outlives the daemon as a row
 * stuck in `running`. The gateway closes next so no new request arrives, and
 * only then does the supervisor tear down running agents. Closing the gateway
 * after the supervisor would accept a request against a supervisor that had
 * already killed its hosts, which is how an in-flight agent is lost with a
 * client watching.
 *
 * **The local operator device is minted from the filesystem, not from
 * pairing.** Every API call needs a paired device, and the machine's own
 * operator has no way to pair with a daemon they cannot yet call. Writing a
 * token to a 0600 file under `~/.ompd` requires local filesystem access, which
 * already implies the ability to run arbitrary code as this user, so it grants
 * nothing that was not already held. It is a convenience for someone who is
 * already the operator, never a way in for someone who is not.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { joinAssistantText, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";
import {
  type Actor,
  type AgentId,
  DEFAULT_DAEMON_PORT,
  DefaultPolicy,
  type Device,
  type EndpointOffer,
  normalizeImageRef,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
  TERMINAL_AGENT_STATES,
} from "@ompd/core";
import type { TunnelDaemon } from "@ompd/tunnel";
import { type AwakeProcess, SleepGuard } from "./awake.ts";
import { NO_TARGET, type WebViewApprovalGate, WebViewBridge, type WebViewDispatch } from "./browser/bridge.ts";
import { startWebViewMcpServer, type WebViewMcpServer, webViewMcpServersFor } from "./browser/mcp-server.ts";
import { endpointPath } from "./endpoint.ts";
import { reachableEndpoints } from "./endpoints.ts";
import { EvolutionEngine, ProposalStore } from "./evolution/index.ts";
import { HttpIntentPeer, type IntentPeer, QueuedIntentDrainer } from "./federation/queued-intents.ts";
import { Filesystem } from "./filesystem/index.ts";
import { Gateway, GatewayEvents, type VoiceHandler } from "./gateway/index.ts";
import { homeIdFor } from "./home-id.ts";
import { HostRegistry } from "./hosts.ts";
import { DaemonModelAccess } from "./model-broker/index.ts";
import { ContainerBackend, HostProvisioner, KNOWN_RUNTIMES, LocalBackend } from "./provisioner/index.ts";
import { Scheduler } from "./routines/index.ts";
import { SessionIndex } from "./sessions/session-index.ts";
import { Supervisor } from "./supervisor.ts";
import { createTunnelDialer } from "./tunnel/dial.ts";
import { identityPath, loadIdentity } from "./tunnel/identity.ts";
import { assertSoleDaemon } from "./tunnel/sole-daemon.ts";
import {
  type SttEngine,
  selectSttEngine,
  selectTtsEngine,
  speakableSegments,
  type TtsEngine,
  VoiceBridge,
} from "./voice/index.ts";
import { listConnectorCatalog, listSkillCatalog, TaskManager } from "./workspace/index.ts";

export const OMPD_VERSION = "0.1.0";

/**
 * The key voice mode is held under.
 *
 * A device may be speaking to one agent and typing at another, so neither
 * half is sufficient alone. The separator is a null byte because neither an
 * agent id nor a device id can contain one, which is what stops two innocent
 * pairs from colliding into a third.
 */
function voiceKey(agentId: AgentId, deviceId: string): string {
  return `${agentId}\u0000${deviceId}`;
}

/**
 * Ceiling on a spoken summary.
 *
 * A client reads this out. Roughly two minutes of speech is already more than
 * anyone wants unprompted, and an uncapped one would let a verbose turn hold
 * a phone hostage.
 */
const SAY_MAX_CHARS = 1_200;

export interface SpokenReply {
  /** Sanitised, capped prose. Safe to hand straight to a speech engine. */
  text: string;
  /** Last update the text derives from, so a client can tell turns apart. */
  seq: number;
}

/** Cut at the last word boundary at or before `limit`, so speech does not stop mid-word. */
function truncateOnWord(text: string, limit: number): string {
  const clipped = text.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(" ");
  return lastSpace > limit / 2 ? clipped.slice(0, lastSpace) : clipped;
}

/**
 * Stable id for the machine's own operator.
 *
 * Stable rather than random so a restart reuses the row instead of leaving a
 * trail of orphaned devices, and so "does the local operator exist" is a
 * primary-key lookup rather than a scan with a heuristic in it.
 */
export const LOCAL_OPERATOR_DEVICE_ID = "dev_local_operator";

/** The local operator holds everything; it is the machine's own account. */
const LOCAL_OPERATOR_SCOPES: readonly string[] = [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE];

const POLICY_MODES: readonly string[] = ["strict", "standard", "trusted"];

export interface OmpdConfig {
  /**
   * Loopback. Binding anywhere else publishes a daemon that runs arbitrary
   * code as this user to whoever can reach the interface, so it is a
   * deliberate edit rather than a default.
   */
  host: string;
  port: number;
  policyMode: "strict" | "standard" | "trusted";
  /** The `omp` binary hosts are spawned from. */
  ompPath: string;
  /**
   * Hold a macOS idle-sleep assertion while any agent is working.
   *
   * On by default, because a turn started from a phone that dies when the Mac
   * goes idle is the failure mode that makes remote use pointless. Scoped to
   * work in flight rather than always on, so an idle daemon costs nothing.
   */
  keepAwake: boolean;
  /**
   * Hub to dial out to, or empty for none.
   *
   * Empty by default: reaching this daemon from elsewhere stays a deliberate
   * act. Set it and the daemon holds an outbound connection to that hub, which
   * is how a laptop behind NAT becomes reachable without opening a port.
   */
  hubUrl: string;
  /**
   * When true, this daemon is a cloud replica: authorized writes for agents it
   * does not own are queued rather than executed. Requires replicaSyncToken.
   */
  replica: boolean;
  /**
   * Dedicated sync credential for `/v1/sync/intents*`. Empty means no sync
   * surface. Distinct from paired-device bearer tokens.
   */
  replicaSyncToken: string;
  /**
   * Base URL of a cloud replica this local delegate drains. Empty means no
   * drain. Requires intentPeerToken.
   */
  intentPeerUrl: string;
  /**
   * Sync token presented to intentPeerUrl. Empty means no drain.
   */
  intentPeerToken: string;
  /**
   * Delegate poll cadence in milliseconds. 0 means the drainer default.
   */
  intentPollIntervalMs: number;
  /**
   * Directories a paired device may browse, start a session in, and clone
   * into.
   *
   * Empty means the operator's home directory, which is the honest default:
   * this exists so someone standing up with a phone can pick where the next
   * piece of work happens, and everything they would pick lives under home.
   * Narrow it to the directories that actually hold work, or widen it
   * deliberately -- but note what widening means, because a device that can
   * name a directory can start a session in it, and a session runs code.
   *
   * A path outside every entry here is refused rather than listed, and
   * resolution happens before that check, so `..` and a symlink pointing out
   * are the same refusal. See `filesystem/roots.ts`.
   */
  fsRoots: string[];
  /**
   * Container runtime this daemon uses, or empty for the platform default.
   *
   * Durable config rather than an environment variable, and that is the whole
   * point of it: a launchd-started daemon does not inherit anyone's shell, so
   * an env-only pin was reliably present while a developer tested it by hand
   * and reliably absent in the one place it decides anything. It also has to
   * be readable by `ompd doctor`, which is a different process and would
   * otherwise be reporting its own environment rather than the daemon's.
   *
   * An unknown name is refused rather than ignored: falling back to the
   * platform default when an operator asked for docker would run every agent
   * somewhere they did not choose, with nothing saying so.
   */
  containerRuntime: string;
  /**
   * Container image every container host runs, or empty for ompd's pinned
   * default base plus its mounted toolchain.
   *
   * Setting this is an act of **trust by the operator who sets it**, and the
   * trust is not backed by anything ompd does. Nothing is mounted over a named
   * image, no digest is pinned for it, and the approval gate cannot confine
   * what is inside it: the image's ENTRYPOINT is the first thing the runtime
   * executes, before ompd has a process to gate, so everything ompd controls
   * is downstream of code that has already run. There is no pre-entrypoint
   * hook to put a gate in; making this safe would need a different mechanism,
   * such as accepting only signed images whose digest the operator approved
   * out of band, and ompd has no such mechanism today.
   *
   * That is also exactly why it lives here and not on the wire. This is a
   * decision made on the machine that will run it, by whoever has its disk. A
   * paired device holding `manage` scope is authenticated, not trusted with
   * supply chain, so `host.image` is refused at the gateway.
   *
   * Normalized and checked by `normalizeImageRef`, the same function the
   * gateway uses, so the two doors cannot drift apart.
   */
  containerImage: string;
  /**
   * Provision container hosts with scoped access to one model, through the
   * daemon's own broker.
   *
   * On by default, and the default is the honest one: a container agent holds
   * no provider credential of its own, so without this it comes up, reaches
   * `idle`, and then fails every prompt with `No model selected`. That is the
   * exact shape of a capability that looks delivered and is not.
   *
   * Turning it off does **not** produce a container agent that answers
   * prompts. It makes container provisioning refuse, naming this key, and that
   * is the only defensible reading of "off": the alternative is a mute agent
   * sitting at `idle` with nothing saying why. There is no fallback to a local
   * model and no invented default either, because both would answer a prompt
   * from somewhere the operator never chose.
   */
  containerModelAccess: boolean;
  /**
   * The single model id a container host is granted, or empty to resolve the
   * host's own `modelRoles.default` from the omp config.
   *
   * Empty means "resolve", the same convention `containerImage: ""` already
   * carries for "ompd's pinned default": a real answer rather than a missing
   * one. What it must never mean is a model this file picked. The grant is
   * spent against the operator's own credential, so which provider it reaches
   * and what it costs are theirs to decide; if neither this nor
   * `modelRoles.default` resolves, container provisioning fails naming both
   * rather than reaching for whatever happens to be installed.
   *
   * One model, not a set. The broker allowlists exactly this id and refuses a
   * request whose body names anything else, so a guest holding the grant
   * cannot widen it into the operator's whole provider catalogue.
   *
   * Provider-qualified, like `anthropic/claude-haiku-4-5`, because that is the
   * form the gateway's own catalogue and `modelRoles.default` both use. A bare
   * model name is not a valid value here.
   */
  containerModel: string;
  /**
   * Port the model broker binds on each container network's gateway address.
   *
   * One fixed port serves every network at once, which is worth stating
   * because it looks like a collision waiting to happen and is not: the broker
   * binds the *per-network gateway address*, and each container network gets
   * its own subnet, so two listeners on two networks never share an address.
   * Two daemons on one machine would collide, and that is already refused.
   *
   * It cannot be `0` for an OS-assigned port, and that is the whole reason it
   * is a setting rather than a detail. The guest's `models.yml` carries the
   * endpoint and has to be seeded before the container starts, while the
   * gateway address does not exist to bind until a container is already
   * running on that network. The number is therefore needed before the bind
   * can happen, so it has to be chosen rather than discovered.
   */
  containerModelBrokerPort: number;
}

export const DEFAULT_CONFIG: OmpdConfig = {
  host: "127.0.0.1",
  port: DEFAULT_DAEMON_PORT,
  policyMode: "standard",
  ompPath: "omp",
  keepAwake: true,
  hubUrl: "",
  replica: false,
  replicaSyncToken: "",
  intentPeerUrl: "",
  intentPeerToken: "",
  intentPollIntervalMs: 0,
  fsRoots: [],
  containerRuntime: "",
  containerImage: "",
  containerModelAccess: true,
  containerModel: "",
  containerModelBrokerPort: 7788,
};

export interface OmpdOptions {
  /** State directory. Defaults to `~/.ompd`. */
  home?: string;
  /** Overrides applied on top of the config file, for CLI flags. */
  overrides?: Partial<OmpdConfig>;
  /**
   * Built web client served from `/`. Defaults to the workspace's
   * `packages/web/dist` when it has been built, and to API-only when it has not.
   */
  staticRoot?: string;
  /** Repository the evolution engine proposes against. Defaults to the cwd. */
  repoRoot?: string;
  /** Host factory seam, so a test never spawns a real `omp acp`. */
  spawnHost?: (opts: SpawnLocalHostOptions) => LocalHost;
  /** Approval deadline seam for deterministic composition tests. */
  approvalTimeoutMs?: number;
  /**
   * Optional replica queue owned by another daemon. Its presence turns this
   * daemon into the local delegate that periodically drains that peer.
   */
  intentPeer?: IntentPeer;
  /** Delegate poll cadence for `intentPeer`; defaults to the drainer cadence. */
  intentPollIntervalMs?: number;
  /** Power-assertion seam, so a test never spawns a real `caffeinate`. */
  spawnAwake?: (command: string[]) => AwakeProcess;
  /** Skips speech-engine probing, which shells out. */
  voice?: boolean;
  /**
   * Pre-selected speech engines, used instead of probing.
   *
   * The same kind of seam as `spawnHost`: it exists so the voice path can be
   * exercised on a machine that has no speech binaries at all, and so an
   * embedder can supply its own.
   */
  stt?: SttEngine;
  tts?: TtsEngine;
  onLog?: (line: string) => void;
}

export interface LocalOperatorBootstrap {
  deviceId: string;
  tokenPath: string;
  /** True when this start created the device row rather than reusing it. */
  created: boolean;
  /**
   * True when the token already on disk was still valid and was left alone.
   * False means this start wrote a new one, which invalidates the old.
   */
  reused: boolean;
}

export interface OmpdStartInfo {
  port: number;
  url: string;
  /**
   * Where a device can actually reach this daemon, as of this start.
   *
   * Returned rather than looked up afterward because `url` is the bind
   * address, and `0.0.0.0` is a sentinel meaning "every interface" rather than
   * a destination anything can open. A caller printing a banner needs the real
   * set, and asking the daemon over HTTP for it would mean resolving an
   * endpoint file that a foreground start has only just written.
   */
  endpoints: EndpointOffer[];
  /** Null when the local operator device exists but has been revoked. */
  bootstrap: LocalOperatorBootstrap | null;
}

export interface SignalHandlerOptions {
  /** Defaults to `process.exit`. Injected so a test can watch the code. */
  exit?: (code: number) => void;
}

/**
 * Read `<home>/config.json`, merged over the defaults.
 *
 * A file that exists and is wrong is an error, never a silent fallback: a
 * daemon that quietly ran under `standard` because someone typoed `strict`
 * would be enforcing a policy nobody chose.
 */
export function loadConfig(home: string, overrides: Partial<OmpdConfig> = {}): OmpdConfig {
  const path = join(home, "config.json");
  let fromFile: Partial<OmpdConfig> = {};

  if (existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    fromFile = parsed as Partial<OmpdConfig>;
  }

  const merged: OmpdConfig = { ...DEFAULT_CONFIG, ...fromFile, ...overrides };

  if (typeof merged.host !== "string" || merged.host.length === 0) {
    throw new Error(`${path}: host must be a non-empty string`);
  }
  if (!Number.isInteger(merged.port) || merged.port < 0 || merged.port > 65_535) {
    throw new Error(`${path}: port must be an integer between 0 and 65535`);
  }
  if (!POLICY_MODES.includes(merged.policyMode)) {
    throw new Error(`${path}: policyMode must be one of ${POLICY_MODES.join(", ")}, got ${String(merged.policyMode)}`);
  }
  if (typeof merged.ompPath !== "string" || merged.ompPath.length === 0) {
    throw new Error(`${path}: ompPath must be a non-empty string`);
  }
  if (typeof merged.keepAwake !== "boolean") {
    throw new Error(`${path}: keepAwake must be true or false, got ${String(merged.keepAwake)}`);
  }
  if (typeof merged.hubUrl !== "string") {
    throw new Error(`${path}: hubUrl must be a string, got ${String(merged.hubUrl)}`);
  }
  if (merged.hubUrl !== "" && !/^wss?:\/\//.test(merged.hubUrl)) {
    // A hub reached over plain http is one anything on the path can answer for.
    // The sealed channel would still refuse an impostor, but failing here names
    // the misconfiguration rather than surfacing it as a handshake that never
    // completes.
    throw new Error(`${path}: hubUrl must be a ws:// or wss:// URL, got ${merged.hubUrl}`);
  }
  if (typeof merged.replica !== "boolean") {
    throw new Error(`${path}: replica must be true or false, got ${String(merged.replica)}`);
  }
  if (typeof merged.replicaSyncToken !== "string") {
    throw new Error(`${path}: replicaSyncToken must be a string, got ${String(merged.replicaSyncToken)}`);
  }
  if (merged.replica && merged.replicaSyncToken === "") {
    throw new Error(`${path}: replica requires a non-empty replicaSyncToken`);
  }
  if (typeof merged.intentPeerUrl !== "string") {
    throw new Error(`${path}: intentPeerUrl must be a string, got ${String(merged.intentPeerUrl)}`);
  }
  if (typeof merged.intentPeerToken !== "string") {
    throw new Error(`${path}: intentPeerToken must be a string, got ${String(merged.intentPeerToken)}`);
  }
  if (merged.intentPeerUrl !== "" && !/^https?:\/\//.test(merged.intentPeerUrl)) {
    throw new Error(`${path}: intentPeerUrl must be an http:// or https:// URL, got ${merged.intentPeerUrl}`);
  }
  if ((merged.intentPeerUrl === "") !== (merged.intentPeerToken === "")) {
    throw new Error(`${path}: intentPeerUrl and intentPeerToken must both be set or both be empty`);
  }
  if (
    typeof merged.intentPollIntervalMs !== "number" ||
    !Number.isFinite(merged.intentPollIntervalMs) ||
    merged.intentPollIntervalMs < 0 ||
    !Number.isInteger(merged.intentPollIntervalMs)
  ) {
    throw new Error(
      `${path}: intentPollIntervalMs must be a non-negative integer, got ${String(merged.intentPollIntervalMs)}`,
    );
  }
  if (!Array.isArray(merged.fsRoots) || merged.fsRoots.some(root => typeof root !== "string")) {
    throw new Error(`${path}: fsRoots must be an array of absolute paths`);
  }
  for (const root of merged.fsRoots) {
    if (!isAbsolute(root)) throw new Error(`${path}: fsRoots entries must be absolute paths, got ${root}`);
  }
  // Resolved here rather than at the browse boundary, so `ompd config` and the
  // logs show the operator which directories are actually exposed instead of
  // an empty list that silently means something.
  if (merged.fsRoots.length === 0) merged.fsRoots = [homedir()];

  if (typeof merged.containerRuntime !== "string") {
    throw new Error(`${path}: containerRuntime must be a string, got ${String(merged.containerRuntime)}`);
  }
  if (merged.containerRuntime !== "" && !KNOWN_RUNTIMES.includes(merged.containerRuntime)) {
    throw new Error(
      `${path}: containerRuntime must be empty for the platform default or one of ` +
        `${KNOWN_RUNTIMES.join(", ")}, got ${merged.containerRuntime}`,
    );
  }
  if (typeof merged.containerImage !== "string") {
    throw new Error(`${path}: containerImage must be a string, got ${String(merged.containerImage)}`);
  }
  if (merged.containerImage !== "") {
    // The same normalizer the gateway runs, so a value one door refuses cannot
    // be a value the other accepts. The normalized form is written back, so
    // everything downstream uses the string that was checked rather than the
    // one that was typed.
    const image = normalizeImageRef(merged.containerImage);
    if (!image.ok) throw new Error(`${path}: containerImage is not usable: ${image.reason}`);
    merged.containerImage = image.ref;
  }
  if (typeof merged.containerModelAccess !== "boolean") {
    throw new Error(`${path}: containerModelAccess must be true or false, got ${String(merged.containerModelAccess)}`);
  }
  if (typeof merged.containerModel !== "string") {
    throw new Error(`${path}: containerModel must be a string, got ${String(merged.containerModel)}`);
  }
  // Not `0`. Every other port in this file may be zero and mean "whatever the
  // OS hands back", and this one cannot: the guest's config carries the
  // endpoint and is written before the container starts, while the address the
  // broker binds does not exist until it is already running. A zero here would
  // seed a guest with a port nothing ever listens on.
  if (
    !Number.isInteger(merged.containerModelBrokerPort) ||
    merged.containerModelBrokerPort < 1 ||
    merged.containerModelBrokerPort > 65_535
  ) {
    throw new Error(
      `${path}: containerModelBrokerPort must be an integer between 1 and 65535, got ` +
        `${String(merged.containerModelBrokerPort)}`,
    );
  }

  return merged;
}

/**
 * How this daemon's config resolves into the container backend's settings.
 *
 * Named rather than inlined at the construction site, because the
 * empty-string convention is a rule and not formatting. `""` means "not
 * configured", and `ContainerBackend` reads an absent `runtime` as "probe in
 * platform order" and an absent `image` as "the pinned base plus the mounted
 * toolchain". Passing the empty string straight through would turn both of
 * those into a pin on a runtime named `""` and an image named `""`, which is
 * the shape of bug that produces a runtime error a long way from its cause.
 *
 * These used to be `process.env.OMPD_CONTAINER_RUNTIME` and
 * `OMPD_CONTAINER_IMAGE`, read here and again in `HostProvisioner`'s own
 * defaults. Both reads are gone. A launchd-started daemon inherits launchd's
 * environment rather than any shell, so an env-only setting was reliably
 * present while a developer tested it by hand and reliably absent in the one
 * place it decided anything; and `ompd doctor`, a different process, could
 * only ever report on its own environment. There is no env override left on
 * the product path, deliberately: an override that a second process cannot
 * see is a setting that cannot be reported honestly.
 *
 * A configured image is trusted by whoever configured it and is confined by
 * nothing ompd does. See `OmpdConfig.containerImage`.
 */
export function containerBackendSettings(config: OmpdConfig): { runtime?: string; image?: string } {
  return {
    ...(config.containerRuntime === "" ? {} : { runtime: config.containerRuntime }),
    ...(config.containerImage === "" ? {} : { image: config.containerImage }),
  };
}

/**
 * Create the state directory 0700 if it is not there.
 *
 * Shared with the CLI, which has to write a log file into it before the
 * daemon's own constructor has had a chance to run.
 */
export function ensureHome(home: string): string {
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask, and this directory holds a
    // credential, so the permission is asserted rather than requested.
    chmodSync(home, 0o700);
  }
  return home;
}

// In `endpoint.ts` and re-exported, so the tunnel's pre-start guard can read
// the published address without importing the composition root.
export { endpointPath };

export class Ompd {
  #home: string;
  #config: OmpdConfig;
  #onLog: (line: string) => void;
  #voiceEnabled: boolean;

  #store: Store;
  #proposals: ProposalStore;
  #events: GatewayEvents;
  #hosts: HostRegistry;
  #supervisor: Supervisor;
  #provisioner: HostProvisioner;
  /**
   * The one thing that makes a container agent able to answer a prompt.
   *
   * Built unconditionally rather than lazily on the first container provision,
   * because it owns nothing until asked: no port is bound and no `omp` child
   * is spawned until a container actually needs a grant. What construction here
   * does buy is that `#stop` has something to close on every path, including a
   * daemon that failed part-way through `start`.
   */
  #modelAccess: DaemonModelAccess;
  #scheduler: Scheduler;
  #tasks: TaskManager;
  #sessionIndex: SessionIndex;
  #evolution: EvolutionEngine;
  #gateway: Gateway;
  #queuedIntentDrainer: QueuedIntentDrainer | undefined;
  #intentPollIntervalMs: number | undefined;
  /**
   * The port the gateway actually bound, read back from `listen()`.
   *
   * `#config.port` may be `0`, a request for whatever the OS hands back, so
   * anything that has to name this daemon's real address, `/v1/endpoints`
   * included, reads this instead of the config value.
   */
  #boundPort: number | undefined;
  #sleepGuard: SleepGuard;
  /** The outbound leg, when a hub is configured. */
  #tunnel: TunnelDaemon | undefined;
  #webViewBridge: WebViewBridge;
  #webViewMcpServer: WebViewMcpServer | undefined;

  #stt: SttEngine | undefined;
  #tts: TtsEngine | undefined;
  #starting: Promise<OmpdStartInfo> | undefined;
  #stopping: Promise<void> | undefined;

  /**
   * `agentId + deviceId` pairs currently in voice mode.
   *
   * Keyed on the device rather than on the socket or the agent, and that
   * choice is the whole design. Socket-keyed would go mute every time a phone
   * changed networks, which is the failure this daemon exists to prevent.
   * Agent-keyed would push synthesized audio at a desktop that only ever
   * typed. A device is the thing that asked to be spoken to.
   */
  #voiced = new Set<string>();
  /** Live bridges by device, so a reconnect is spoken to on its new socket. */
  #bridges = new Map<string, Set<VoiceBridge>>();
  /**
   * Highest update seq seen per agent, so a reply can be read back as the
   * updates a turn produced rather than the agent's whole history.
   */
  #lastSeq = new Map<AgentId, number>();

  /**
   * Opens local state and builds every subsystem. Touches the filesystem and
   * nothing else; the network is `start`'s job.
   */
  constructor(opts: OmpdOptions = {}) {
    this.#home = ensureHome(opts.home ?? join(homedir(), ".ompd"));

    this.#config = loadConfig(this.#home, opts.overrides);
    this.#onLog = opts.onLog ?? (() => {});
    this.#voiceEnabled = opts.voice ?? true;
    // Set here, not in `start`, because the guard there decides whether to
    // probe by asking whether these are already filled.
    this.#stt = opts.stt;
    this.#tts = opts.tts;

    this.#store = new Store(join(this.#home, "ompd.db"));
    this.#proposals = new ProposalStore(join(this.#home, "proposals.db"));
    this.#events = new GatewayEvents();

    // The watermark a spoken reply is read from. Recorded off the same fan-out
    // the gateway uses, so the boundary of a turn is observed rather than
    // recomputed by scanning an agent's whole update history.
    this.#events.add({ onUpdate: (agentId, seq) => void this.#lastSeq.set(agentId, seq) });
    // Subscribed to the event fan-out rather than reaching into the
    // supervisor: the supervisor already announces every state transition, and
    // a power assertion is exactly the kind of concern that should observe
    // that stream instead of being wired into the thing producing it.
    this.#sleepGuard = new SleepGuard({
      enabled: this.#config.keepAwake,
      onLog: this.#onLog,
      spawn: opts.spawnAwake,
    });
    this.#events.add({ onAgentsChanged: agents => this.#sleepGuard.update(agents) });

    // Hosts are named here so the provisioner and supervisor share one
    // registry: a container agent's session would otherwise be the only kind
    // the gateway could not answer a mode query for. Keeping every spawn on
    // the daemon's own machine is the whole point of that refusal.
    this.#hosts = new HostRegistry({ spawn: opts.spawnHost });

    // Two directories one letter apart, and confusing them is the bug this
    // comment exists to prevent. `#home` is ompd's OWN state directory,
    // normally `~/.ompd`: the pairing token, the store, the audit trail, and
    // the one directory a container may never mount. `configDir` below is
    // omp's config directory, normally `~/.omp`: where `agent.db` holds the
    // host's provider credentials and where the two loopback auth children
    // write their bearer files. Model access reads the second and must never
    // be pointed at the first.
    //
    // Read-only to this daemon, and only ever by the `omp` children it spawns.
    // Nothing here copies `~/.omp` anywhere, least of all into a guest.
    this.#modelAccess = new DaemonModelAccess({
      ompPath: this.#config.ompPath,
      configDir: join(homedir(), ".omp"),
      brokerPort: this.#config.containerModelBrokerPort,
      model: this.#config.containerModel,
      enabled: this.#config.containerModelAccess,
      onLog: this.#onLog,
      // A grant is the daemon's own act, so no `actorDeviceId`: the device that
      // asked for the agent is already on the `host.provision` row, and
      // attributing the credential decision to it would be a claim about
      // authority nobody made. `detail` carries the model id and the container
      // network; the bearer the guest was issued is never in it, which is the
      // whole reason this callback takes a row rather than the grant.
      // A straight pass-through with no cast and no runtime check, because
      // `ModelAccessAuditRow.action` is the same closed union `Store.audit`
      // takes. Worth saying, since the two types are declared in different
      // packages: if one ever grows a member the other lacks, the compiler is
      // what stops it here rather than a guard nobody remembers to keep.
      onAudit: row => this.#store.audit({ action: row.action, outcome: row.outcome, detail: row.detail }),
    });

    // The backends are named here rather than left to the provisioner's
    // defaults for one reason: they have to spawn through the registry above,
    // or a container agent's session would be the only kind the gateway could
    // not answer a mode query for.
    this.#provisioner = new HostProvisioner({
      store: this.#store,
      workspace: opts.repoRoot ?? process.cwd(),
      backends: {
        local: new LocalBackend({ ompPath: this.#config.ompPath, spawn: this.#hosts.spawn }),
        // Runtime and image come from the validated config on disk, not from
        // the environment. See `containerBackendSettings`.
        container: new ContainerBackend({
          workspace: opts.repoRoot ?? process.cwd(),
          home: this.#home,
          spawn: this.#hosts.spawn,
          // Not optional in the daemon, only in the type: every container this
          // process provisions goes through the broker, or fails saying why.
          modelAccess: this.#modelAccess,
          ...containerBackendSettings(this.#config),
        }),
      },
      onLog: this.#onLog,
    });

    const policy = new DefaultPolicy({ mode: this.#config.policyMode });
    let sendWebViewAction: WebViewDispatch["send"] = () => false;
    let requestWebViewApproval: WebViewApprovalGate["request"] = () =>
      Promise.resolve({ allowed: false, reason: "approval supervisor is not available" });
    this.#webViewBridge = new WebViewBridge({
      policy,
      store: this.#store,
      dispatch: {
        send: (agentId, requestId, action) => sendWebViewAction(agentId, requestId, action),
      },
      approvals: {
        request: input => requestWebViewApproval(input),
      },
    });

    this.#supervisor = new Supervisor({
      store: this.#store,
      policy,
      events: this.#events,
      approvalTimeoutMs: opts.approvalTimeoutMs,
      ompPath: this.#config.ompPath,
      spawnHost: this.#hosts.spawn,
      provisioner: this.#provisioner,
      // The daemon's real state directory, not the `~/.ompd` the supervisor
      // would otherwise assume. A daemon started with `OMPD_HOME` elsewhere
      // has to refuse mounts of *that* directory, and a default cannot know it.
      home: this.#home,
      onLog: this.#onLog,
      mcpServersFor: (agentId, host) => {
        const server = this.#webViewMcpServer;
        if (server === undefined) throw new Error("webview MCP server is not started");
        // Offered only to a host that can actually reach it. The server binds
        // `127.0.0.1` and `urlFor` hands out `http://127.0.0.1:<port>/...`,
        // which means the daemon's machine from a local host and the CONTAINER
        // from a provisioned one. Handing it to a container did not degrade the
        // browser tool, it failed the whole session: omp answers `session/new`
        // with `ompd-webview: Unable to connect. Is the computer able to access
        // the url?`, so every container create returned HTTP 500 while the same
        // request with no `mcpServers` succeeded.
        //
        // Omitted rather than rewritten to a container-reachable address on
        // purpose. Making it reachable means binding this surface off loopback,
        // and that is a security decision about a tool that drives the
        // operator's own browser -- not something to slip in as the fix for a
        // 500. So the absence is stated here and in the log rather than being
        // quietly papered over, and `docs/running.md` says the browser tool is
        // a local-host capability.
        if (host.kind !== "local") {
          this.#onLog?.(
            `agent ${agentId}: no browser tool on this ${host.kind} host. The WebView MCP server is bound to ` +
              `the daemon's loopback, which a provisioned host cannot reach; everything else about the session ` +
              `is unaffected.`,
          );
        }
        return webViewMcpServersFor(server, agentId, host);
      },
    });
    const intentPeer =
      opts.intentPeer ??
      (this.#config.intentPeerUrl !== ""
        ? new HttpIntentPeer({
            url: this.#config.intentPeerUrl,
            token: this.#config.intentPeerToken,
          })
        : undefined);
    if (intentPeer !== undefined) {
      this.#queuedIntentDrainer = new QueuedIntentDrainer({
        supervisor: this.#supervisor,
        peer: intentPeer,
        onError: error => this.#onLog(`queued intent drain failed: ${error.message}`),
      });
      this.#intentPollIntervalMs =
        opts.intentPollIntervalMs ??
        (this.#config.intentPollIntervalMs > 0 ? this.#config.intentPollIntervalMs : undefined);
    }
    requestWebViewApproval = ({ agentId, tool, title, action }) =>
      this.#supervisor.gateAction({ agentId, tool, title, input: action });

    // Timer-driven runs act as the machine's own operator. The supervisor
    // re-reads the device row on every call, so revoking that device stops
    // scheduled runs too rather than leaving a privileged ghost behind.
    this.#scheduler = new Scheduler({
      store: this.#store,
      supervisor: this.#supervisor,
      actor: { deviceId: LOCAL_OPERATOR_DEVICE_ID, scopes: [...LOCAL_OPERATOR_SCOPES] },
    });
    this.#evolution = new EvolutionEngine({
      store: this.#store,
      proposals: this.#proposals,
      repoRoot: opts.repoRoot ?? process.cwd(),
    });
    this.#tasks = new TaskManager({ store: this.#store, supervisor: this.#supervisor });
    this.#sessionIndex = new SessionIndex({ store: this.#store });

    this.#gateway = new Gateway({
      supervisor: this.#supervisor,
      store: this.#store,
      events: this.#events,
      onError: err => this.#onLog(`unhandled request error: ${err.stack ?? err.message}`),
      host: this.#config.host,
      port: this.#config.port,
      version: OMPD_VERSION,
      // Lets `ompd start` tell "that is me already running" from "something
      // else owns this port", instead of adopting any healthy listener.
      homeId: homeIdFor(this.#home),
      routines: this.#scheduler,
      sessions: this.#hosts,
      sessionIndex: this.#sessionIndex,
      endpoints: () => this.#reachableEndpoints(),
      // Read from the config the daemon booted with, so widening or narrowing
      // what a phone may browse is a config edit and a restart, never
      // something a device can talk this daemon into at runtime.
      filesystem: new Filesystem({ roots: this.#config.fsRoots }),
      onWebViewResult: (agentId, requestId, result) => this.#webViewBridge.resolveResult(agentId, requestId, result),
      onWebViewUnavailable: agentId => this.#webViewBridge.cancelAgent(agentId, NO_TARGET),
      staticRoot: opts.staticRoot ?? defaultStaticRoot(),
      skills: { list: listSkillCatalog },
      connectors: { list: listConnectorCatalog },
      tasks: this.#tasks,
      syncConfig: {
        read: () => {
          const config = loadConfig(this.#home);
          return { policyMode: config.policyMode, keepAwake: config.keepAwake };
        },
        apply: settings => this.#applySyncConfig(settings),
      },
      // A rotation can be driven from any device, including a phone. The one
      // credential that also lives on disk has to follow, or `ompd rotate`
      // from the console leaves the CLI on this machine holding a token the
      // daemon has just withdrawn.
      onTokenRotated: (deviceId, token) => {
        if (deviceId !== LOCAL_OPERATOR_DEVICE_ID) return undefined;
        writeFileSync(this.tokenPath, `${token}\n`, { mode: 0o600 });
        chmodSync(this.tokenPath, 0o600);
        this.#onLog(`rotated the local operator token; rewrote ${this.tokenPath} (mode 0600)`);
        return this.tokenPath;
      },
      // A typed prompt from a device turns its voice off for that agent. The
      // modality follows what the operator just demonstrated they want, which
      // needs no setting and no timer.
      onTextPrompt: (agentId, actor) => this.#voiced.delete(voiceKey(agentId, actor.deviceId)),
      voice: this.#voiceEnabled ? (send, actor) => this.#openVoice(send, actor) : undefined,
      ...(this.#config.replicaSyncToken !== ""
        ? {
            federation: {
              replica: this.#config.replica,
              syncToken: this.#config.replicaSyncToken,
            },
          }
        : {}),
    });
    sendWebViewAction = (agentId, requestId, action) => this.#gateway.sendWebViewAction(agentId, requestId, action);
  }

  #applySyncConfig(settings: { policyMode: OmpdConfig["policyMode"]; keepAwake: boolean }): void {
    const path = join(this.#home, "config.json");
    let current: Record<string, unknown> = {};
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${path} must contain a JSON object`);
      }
      current = parsed as Record<string, unknown>;
    }
    const next = { ...current, ...settings };
    loadConfig(this.#home, next);
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
      chmodSync(path, 0o600);
    } finally {
      rmSync(temp, { force: true });
    }
    this.#config = { ...this.#config, ...settings };
    this.#onLog("imported policy configuration; restart ompd to apply it to active policy and sleep guard");
  }

  /**
   * Every way a device can reach this daemon right now, recomputed per
   * request rather than cached at construction so a hub dialed after boot is
   * reflected without a restart.
   *
   * Identity is read here, never created: minting one as a side effect of
   * listing endpoints would hand a hub-less daemon a daemon id nobody asked
   * for. `loadIdentity` only runs when `hubUrl` is set, and only once the
   * identity file is confirmed to already exist.
   */
  #reachableEndpoints(): EndpointOffer[] {
    const { host, hubUrl } = this.#config;
    // `#config.port` may be `0`, a request for whatever the OS hands back;
    // the seam has to name the address the gateway actually bound.
    const port = this.#boundPort ?? this.#config.port;
    const daemonId =
      hubUrl !== "" && existsSync(identityPath(this.#home)) ? loadIdentity(this.#home).daemonId : undefined;
    return reachableEndpoints({ host, port, hubUrl, daemonId });
  }

  /**
   * Build the voice bridge for one socket and register it against its device.
   *
   * The registry is what makes a spoken reply survive a reconnect: the pair
   * that asked to be spoken to is remembered by device, and this is where the
   * device's current socket is found again.
   */
  #openVoice(send: (frame: ServerFrame) => void, actor: Actor): VoiceHandler {
    const bridge = new VoiceBridge({
      send,
      stt: this.#stt,
      tts: this.#tts,
      // Speech is a prompt like any other: the supervisor authorizes it
      // against the device row rather than trusting the bridge.
      //
      // The promise is returned rather than swallowed. The bridge awaits this
      // callback inside the same try that guards transcription and emits
      // exactly one error frame for either, so returning it is what makes a
      // rejected prompt visible to the phone. Catching here would log the
      // failure and leave the operator watching a transcript that never
      // became a turn.
      onTranscript: async (agentId, text, speaker) => {
        // Speaking is what puts this pair in voice mode, and it is recorded
        // before the turn rather than after, so a reply still reaches a device
        // whose socket dropped while the agent was thinking.
        this.#voiced.add(voiceKey(agentId, speaker.deviceId));
        const from = this.#lastSeq.get(agentId) ?? 0;
        await this.#supervisor.prompt(agentId, text, speaker);
        await this.#announceReply(agentId, speaker.deviceId, from);
      },
      onLog: this.#onLog,
    });

    const forDevice = this.#bridges.get(actor.deviceId) ?? new Set<VoiceBridge>();
    forDevice.add(bridge);
    this.#bridges.set(actor.deviceId, forDevice);

    return {
      handleFrame: (frame, who) => bridge.handleFrame(frame, who),
      close: () => {
        forDevice.delete(bridge);
        if (forDevice.size === 0) this.#bridges.delete(actor.deviceId);
        // Voice mode itself is deliberately not cleared. The device is still
        // the one having a spoken conversation; it just has no socket this
        // instant.
        bridge.close();
      },
    };
  }

  /**
   * The speakable form of a turn's answer, or null when there is nothing worth
   * saying.
   *
   * Derived without touching a speech engine, deliberately. Synthesis is one
   * consumer of this text and increasingly the less important one: a phone
   * with its own voice wants the prose, not the audio, and a daemon on a
   * machine with no TTS at all still knows what the agent said. Keeping the
   * derivation here rather than inside the bridge is what lets that text be
   * sent on its own.
   *
   * Only the updates this turn produced are read, so an agent answering its
   * tenth question does not recite the previous nine.
   */
  spokenReply(agentId: AgentId, fromSeq: number): SpokenReply | null {
    const records = this.#store.updatesSince(agentId, fromSeq);
    if (records.length === 0) return null;

    const reply = joinAssistantText(records.map(record => record.payload));
    if (reply.length === 0) return null;

    // OMP's own markdown-to-speech transform, so the daemon and the terminal
    // say the same words. A turn that was only a code fence produces no
    // speakable segments, and silence is the right answer there.
    const spoken = speakableSegments(reply).join(" ");
    if (spoken.length === 0) return null;

    // Capped at the source. A client is going to read this out; handing it an
    // unbounded transcript would have a phone talking for a quarter of an hour
    // with no way to know it was going to.
    const text = spoken.length <= SAY_MAX_CHARS ? spoken : `${truncateOnWord(spoken, SAY_MAX_CHARS)}...`;

    // The last update the text actually derives from, so a client can tell
    // turns apart and refuse to say one twice.
    const seq = records[records.length - 1]?.seq ?? fromSeq;
    return { text, seq };
  }

  /**
   * Announce a turn's answer as prose, and speak it to a device that asked to
   * be spoken to.
   *
   * The text goes out either way, because that is the path a phone with its
   * own voice uses and it needs no speech engine on this machine. Synthesis is
   * the fallback for a client that has no voice of its own, and only a device
   * that spoke first gets it.
   */
  async #announceReply(agentId: AgentId, deviceId: string, fromSeq: number): Promise<void> {
    const reply = this.spokenReply(agentId, fromSeq);
    if (reply === null) return;

    this.#events.emitSay({ agentId, seq: reply.seq, text: reply.text });

    if (!this.#voiced.has(voiceKey(agentId, deviceId))) return;
    // Every live socket this device holds. Usually one; two means the operator
    // has the app open twice and both should hear the answer.
    for (const bridge of this.#bridges.get(deviceId) ?? []) {
      // `speak` emits its own error frame on synthesis failure, which is not
      // this function's to re-report.
      await bridge.speak(agentId, reply.text);
    }
  }

  get home(): string {
    return this.#home;
  }

  get config(): OmpdConfig {
    return { ...this.#config };
  }

  get tokenPath(): string {
    return join(this.#home, "token");
  }

  get store(): Store {
    return this.#store;
  }

  get supervisor(): Supervisor {
    return this.#supervisor;
  }

  get gateway(): Gateway {
    return this.#gateway;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  get provisioner(): HostProvisioner {
    return this.#provisioner;
  }

  get evolution(): EvolutionEngine {
    return this.#evolution;
  }

  get sleepGuard(): SleepGuard {
    return this.#sleepGuard;
  }

  /**
   * Bring the daemon up. Idempotent: a second call returns the first result
   * rather than binding a second port.
   */
  async start(): Promise<OmpdStartInfo> {
    this.#starting ??= this.#start();
    return this.#starting;
  }

  async #start(): Promise<OmpdStartInfo> {
    // Before anything binds or dials: refuse to be a second daemon on a home
    // that already has one. Two processes on one identity evict each other at
    // the hub forever, which is how a paired phone came to see no sessions,
    // and `--foreground` (how launchd runs it, and how a hand start bypasses
    // the CLI's own checks) otherwise reaches this method with no guard at
    // all. Throws before any state is opened or written.
    await assertSoleDaemon({ home: this.#home, host: this.#config.host, port: this.#config.port });
    // No ACP host survives a daemon process. Durable `idle`/`busy` rows from
    // the previous process are therefore not live agents, even if shutdown
    // never ran (power loss, SIGKILL, old versions that failed to settle
    // them). Advertising one as live sends a phone to a host pid that does not
    // exist. A replica keeps mirrored remote rows by design; only the owning
    // daemon can make this local-host assertion.
    if (!this.#config.replica) {
      let interruptedAgents = 0;
      for (const agent of this.#store.listAgents()) {
        if (TERMINAL_AGENT_STATES.includes(agent.state)) continue;
        this.#store.setAgentState(agent.id, "stopped");
        interruptedAgents += 1;
      }
      if (interruptedAgents > 0) {
        this.#onLog?.(`settled ${interruptedAgents} agent(s) whose ACP hosts belonged to a previous daemon`);
      }

      // Settling the agent rows is not the same as reclaiming what they were
      // running on. A container host outlives the daemon that made it: its
      // command is `tail -f /dev/null`, so `--rm` never fires, and before
      // `HostRef.resolved` existed there was nothing recorded to address it
      // with. Reclaim them here, from the store, while the rows are still
      // readable. Failures are logged and audited rather than fatal: a daemon
      // that will not start because a stale container cannot be removed is
      // worse than one that starts and says so.
      const stale = this.#store.listAgents().map(agent => agent.host);
      const { reclaimed, unreclaimable } = await this.#provisioner.reconcile(stale).catch((err: unknown) => {
        this.#onLog?.(`host reconciliation failed: ${String(err)}`);
        return { reclaimed: [] as string[], unreclaimable: [] as string[] };
      });
      if (reclaimed.length > 0) {
        this.#onLog?.(`reclaimed ${reclaimed.length} host(s) left by a previous daemon`);
      }
      if (unreclaimable.length > 0) {
        this.#onLog?.(
          `${unreclaimable.length} host(s) could not be reclaimed automatically and may still be running: ` +
            unreclaimable.join(", "),
        );
      }
    }

    if (this.#voiceEnabled && (this.#stt === undefined || this.#tts === undefined)) {
      // Probed once here rather than per socket: selection shells out to find
      // the speech binaries, and doing that on every connection would put a
      // subprocess in the path of opening a page. Engines handed in at
      // construction skip the probe entirely.
      const [stt, tts] = await Promise.all([
        selectSttEngine({ onLog: this.#onLog }),
        selectTtsEngine({ onLog: this.#onLog }),
      ]);
      this.#stt ??= stt;
      this.#tts ??= tts;
    }

    this.#webViewMcpServer ??= startWebViewMcpServer(this.#webViewBridge);

    const bootstrap = this.#bootstrapLocalOperator();
    const port = await this.#gateway.listen();
    this.#boundPort = port;
    const url = `http://${this.#config.host}:${port}`;
    // Published only once the port is real, so nothing can read an address
    // that was never bound. This is what lets the CLI find a daemon started
    // on a port the config file has never heard of.
    writeFileSync(endpointPath(this.#home), `${url}\n`);

    // Dialed after the gateway is listening, so a session that arrives
    // immediately has something to terminate into. A hub that is down is not a
    // startup failure: the dialer retries forever and the daemon is fully
    // usable over loopback meanwhile.
    if (this.#config.hubUrl !== "") {
      const identity = loadIdentity(this.#home);
      this.#tunnel = createTunnelDialer({
        hubUrl: this.#config.hubUrl,
        identity,
        gateway: this.#gateway,
        store: this.#store,
        onLog: this.#onLog,
      });
      this.#tunnel.start();
      this.#onLog(`dialing hub ${this.#config.hubUrl} as ${identity.daemonId}`);
    }
    // A run left mid-flight by a process that was killed cannot settle itself,
    // and until something does, `hasActiveRun` keeps a singleton routine
    // silent. Reconciled before the scheduler is armed, so nothing this
    // rewrites can be a run of this daemon's own.
    const interrupted = this.#store.failInterruptedRuns("the daemon exited while this run was in flight");
    if (interrupted > 0) {
      this.#onLog?.(`settled ${interrupted} run(s) left mid-flight by a previous daemon`);
    }
    this.#scheduler.start();
    if (this.#queuedIntentDrainer !== undefined) {
      if (this.#intentPollIntervalMs === undefined) this.#queuedIntentDrainer.start();
      else this.#queuedIntentDrainer.start(this.#intentPollIntervalMs);
    }

    return { port, url, endpoints: this.#reachableEndpoints(), bootstrap };
  }

  /**
   * Take the daemon down in the one order that does not drop work.
   *
   * Idempotent by memoising the first attempt, so a second signal, a CLI
   * shutdown racing a signal, and a test calling it twice all await the same
   * teardown instead of running it again against half-closed subsystems.
   */
  async stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    // A signal can arrive while `start` is still probing engines, binding, or
    // writing the token file. Tearing down underneath it would close the store
    // and then let the rest of startup run against it, so teardown waits for
    // startup to settle either way: a start that failed still leaves a
    // half-built daemon that has to come down.
    if (this.#starting !== undefined) await this.#starting.catch(() => undefined);

    try {
      // 1. No new scheduled work, and wait for any in-flight drain before
      //    the supervisor it touches is shut down.
      await this.#queuedIntentDrainer?.stop();
      this.#scheduler.stop();
      // 2. Settle the runs already in flight, before anything they depend on
      //    goes away: cancelling a turn needs the host serving it, and a run
      //    that cannot write its terminal record leaves a row claiming the
      //    routine is still going, which silences a singleton for good. The
      //    scheduler refuses fires from here on, so a request the gateway is
      //    still serving cannot slip a new run in behind this.
      await this.#scheduler.drain();
      // 3. No new client work. Sockets die here, which is survivable: agent
      //    lifetime never belonged to a connection.
      await this.#gateway.close();
      // Between the two: the tunnel is a client of the gateway, so it stops
      // once the gateway has, and before the hosts it was carrying frames for.
      this.#tunnel?.stop();
      this.#tunnel = undefined;
      // 4. Only now tear down what is running. Any earlier and a request could
      //    still arrive for a host that had already been killed.
      await this.#supervisor.shutdown();
      // Every container destroyed here releases its grant against a broker
      // that is still listening, which is why model access is closed in the
      // `finally` below rather than on this line: a release against a closed
      // broker is a revocation that never happened.
      await this.#provisioner.close();
      this.#webViewMcpServer?.close();
      this.#webViewMcpServer = undefined;

      // Retracted after the gateway is closed, never before: a file saying
      // "here" while the port is still accepting would be the wrong lie in the
      // more dangerous direction.
      rmSync(endpointPath(this.#home), { force: true });

      this.#proposals.close();
      this.#store.close();
    } finally {
      // Unconditional, both of them, and for the same reason: these are the
      // steps whose effect is on the operating system rather than on this
      // process, so a teardown that threw part-way through must not skip them.
      // Everything above leaks at worst a file handle this process was about
      // to lose anyway.
      //
      // The sleep guard first because it is synchronous and cannot fail: a
      // machine left unable to sleep is not something to risk on the outcome
      // of an await.
      this.#sleepGuard.release();
      // Then model access, which is two spawned `omp` children and a listener
      // bound on a container network's gateway address. Orphaning those is the
      // worst outcome in this method: the children front the operator's own
      // credential vault, and the listener would go on honouring live grants
      // with no daemon left to revoke them. Last, so it runs after every
      // container destroy above has had its release land on a live broker.
      await this.#modelAccess.close();
    }
  }

  /**
   * Stop once on SIGINT or SIGTERM.
   *
   * Opt-in rather than automatic, because a library that hijacks process
   * signals on construction is unusable inside anything else. The CLI calls it;
   * a test does not have to.
   */
  installSignalHandlers(opts: SignalHandlerOptions = {}): void {
    const exit = opts.exit ?? ((code: number) => process.exit(code));
    let handled = false;

    const onSignal = (signal: string): void => {
      // A second Ctrl-C must not start a second teardown. `stop` is already
      // idempotent; this keeps the second signal from also calling `exit`.
      if (handled) return;
      handled = true;
      this.#onLog(`received ${signal}, shutting down`);
      void this.stop().then(
        () => exit(0),
        (err: unknown) => {
          this.#onLog(`shutdown failed: ${err instanceof Error ? err.message : err}`);
          exit(1);
        },
      );
    };

    process.once("SIGINT", () => onSignal("SIGINT"));
    process.once("SIGTERM", () => onSignal("SIGTERM"));
  }

  /**
   * Give the machine's own operator a usable token, reusing the one on disk.
   *
   * Token hashes are persisted, so the credential in `<home>/token` outlives
   * the process that wrote it. A restart that reissued anyway would rewrite a
   * file nothing asked it to touch and invalidate whatever the operator had
   * already copied into a shell profile or a second terminal. So the file is
   * checked against the registry first: if it still names a live credential
   * for this device, the start says nothing and changes nothing.
   *
   * The row is created once. Only a missing, stale, or unreadable file mints.
   */
  #bootstrapLocalOperator(): LocalOperatorBootstrap | null {
    const existing = this.#store.getDevice(LOCAL_OPERATOR_DEVICE_ID);

    if (existing?.revokedAt) {
      // Deliberately not resurrected. Revocation that a restart undid would not
      // be revocation.
      this.#onLog(
        `the local operator device was revoked at ${existing.revokedAt}; ` +
          `CLI commands need a token from a paired device until it is removed`,
      );
      return null;
    }

    const created = existing === null;
    if (created) {
      const device: Device = {
        id: LOCAL_OPERATOR_DEVICE_ID,
        name: "local operator",
        // No keypair: this device's authority is filesystem access, and a key
        // generated here and stored beside the token would only look like one.
        publicKey: "local",
        scopes: [...LOCAL_OPERATOR_SCOPES],
        createdAt: new Date().toISOString(),
      };
      this.#store.addDevice(device);
      this.#store.audit({
        action: "device.pair",
        actorDeviceId: device.id,
        outcome: "ok",
        detail: { name: device.name, scopes: device.scopes, origin: "local_bootstrap" },
      });
    }

    const tokenPath = this.tokenPath;
    if (!created && this.#reuseLocalOperatorToken(tokenPath)) {
      return { deviceId: LOCAL_OPERATOR_DEVICE_ID, tokenPath, created: false, reused: true };
    }

    const token = this.#gateway.issueToken(LOCAL_OPERATOR_DEVICE_ID);
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    // The mode above only applies at creation, so a file that already existed
    // keeps whatever mode it had. Asserting it here is what keeps a token from
    // staying world-readable because it was once created that way.
    chmodSync(tokenPath, 0o600);

    this.#onLog(
      created
        ? `minted the local operator device and wrote its token to ${tokenPath} (mode 0600)`
        : `the local operator token was missing or no longer valid; wrote a new one to ${tokenPath} (mode 0600)`,
    );

    return { deviceId: LOCAL_OPERATOR_DEVICE_ID, tokenPath, created, reused: false };
  }

  /**
   * True when `<home>/token` already holds a live credential for the operator
   * device, in which case the file is left exactly as it is.
   *
   * Its mode is still asserted. A token that survives restarts is worth more
   * to whoever can read it than one that did not, so the one thing this path
   * will not do is leave a long-lived credential world-readable because some
   * earlier command relaxed it.
   */
  #reuseLocalOperatorToken(tokenPath: string): boolean {
    if (!existsSync(tokenPath)) return false;

    let token: string;
    try {
      token = readFileSync(tokenPath, "utf8").trim();
    } catch {
      return false;
    }
    if (token.length === 0) return false;
    if (!this.#gateway.hasLiveToken(LOCAL_OPERATOR_DEVICE_ID, token)) return false;

    chmodSync(tokenPath, 0o600);
    return true;
  }
}

/**
 * The workspace's built web client, or undefined when it has not been built.
 *
 * Resolved from this file rather than the cwd, so the daemon serves the UI
 * shipped alongside it no matter where it was started from. Inside a compiled
 * binary this resolves into the bundle and finds nothing, which is correct:
 * `packages/web/dist` is a local build artifact that no clone starts with, so
 * the console is served when it has been built and the API is served always.
 */
function defaultStaticRoot(): string | undefined {
  const dist = resolve(import.meta.dir, "../../web/dist");
  return existsSync(join(dist, "index.html")) ? dist : undefined;
}
