/**
 * Prove that a container agent completes a real model turn on Apple
 * `container`, holding nothing it could reuse anywhere else.
 *
 * Two scripts already cover parts of this, and neither covers the part that
 * decides whether the feature works on this machine.
 * `check-container-host.ts` is docker's: it reads docker's own `inspect`
 * fields, asserts flags Apple's runtime rejects outright, and pins
 * `containerRuntime: "docker"` precisely so that everything it claims is
 * something it can check. `check-native-container.ts` probes runtime
 * confinement with no ompd daemon at all, so nothing in it involves a grant, a
 * broker or a prompt. What has never been watched end to end is the claim the
 * whole feature rests on: on the runtime this daemon selects by default on
 * darwin, an agent provisioned through `POST /v1/agents` answers a real
 * prompt, and the credential that answered it never entered the guest.
 *
 * The path being proved, in the order the bytes travel:
 *
 *   guest omp -> POST /v1/messages with a per-container bearer
 *             -> ompd's model broker, bound to this container network's own
 *                gateway address and to nothing else
 *             -> `omp auth-gateway` on the host's loopback
 *             -> `omp auth-broker` on the host's loopback
 *             -> the provider, against the operator's own credential
 *
 * Why no credential is injected instead, since that would be one line: the
 * guest keeps full unrestricted internet egress, and Apple `container` rejects
 * `--cap-drop`, `--security-opt` and `--pids-limit`, so anything reusable that
 * reaches the guest can be taken off this machine and the sandbox offers
 * nothing to fall back on. A scoped bearer is worth exactly one model on
 * exactly one endpoint for as long as the container lives, and the phases
 * below assert that rather than assuming it: the credential-shape scan is
 * proved against a planted decoy before it is trusted to report nothing, and
 * the revocation probe refuses to read an unreachable listener as a pass.
 *
 * This run spends real model credit. It asks for one token of text and no
 * tool, so the spend is small, but it is the operator's own and it is the
 * reason this script is hand-run rather than part of the suite.
 *
 * Everything it creates is removed again, including on the failure path: both
 * containers, both networks, the guest homes the daemon seeded, the workspace
 * and the daemon home. The teardown phase also re-reads the process table it
 * snapshotted at the start, because a run that quietly woke Docker Desktop or
 * OrbStack would have proved nothing about Apple's runtime.
 *
 * Usage:
 *   bun run scripts/check-container-model-turn.ts [--help]
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { assistantTextOf } from "../packages/acp/src/index.ts";
import { type Agent, type AgentState, type AuditEntry, TERMINAL_AGENT_STATES } from "../packages/core/src/index.ts";
import { Ompd } from "../packages/daemon/src/index.ts";
import { addressInIpv4Cidr, isIpv4Cidr } from "../packages/daemon/src/model-broker/cidr.ts";
import { GUEST_HOME_MOUNT } from "../packages/daemon/src/provisioner/guest-config.ts";

/**
 * Apple's runtime, named as a constant and never selected.
 *
 * `containerRuntime` is pinned to it below rather than left empty, even though
 * empty already resolves to `container` on darwin. The difference is what a
 * failure means: an unpinned run on a machine whose apiserver is down would be
 * refused by `selectRuntime` with a message about runtimes, and this script
 * would then be reporting on a runtime it never reached. Pinned, every
 * assertion here is about the one runtime named in the title.
 */
const RUNTIME = "container";

/**
 * The operator's own omp config, read and never copied.
 *
 * The one thing taken from it is `modelRoles.default`, and only so preflight
 * can say which model the container will be granted before anything is
 * provisioned. The credential vault beside it is never opened, mounted or
 * copied by anything below.
 */
const HOST_OMP_CONFIG = join(homedir(), ".omp", "agent", "config.yml");

/** The guest's own view of the home the daemon seeded for it. */
const GUEST_TOKEN_PATH = `${GUEST_HOME_MOUNT}/.omp/model-token`;
const GUEST_MODELS_YML = `${GUEST_HOME_MOUNT}/.omp/agent/models.yml`;

/** Where the decoy that proves the credential scan can fail is planted and removed. */
const GUEST_DECOY_PATH = `${GUEST_HOME_MOUNT}/credential-shape-decoy.txt`;

/** A value with a real credential's shape and no credential in it. */
const DECOY_VALUE = "sk-ant-oat01-DECOYDECOYDECOYDECOY";

/**
 * Value shapes a reusable provider credential has, as one `grep -E` pattern.
 *
 * The same pattern `check-container-host.ts` scans with, and for the same
 * reason: value prefixes only, never a schema word. `refresh_token` and
 * `oauth` both appear in the DDL of omp's own `auth_credentials` table, so a
 * fresh guest `agent.db` carries them with no credential anywhere near it, and
 * a scan built on them would report a finding on every clean run.
 *
 * Not taken on faith in either direction. It is run against a planted decoy
 * before it is trusted to report nothing, both over the guest's home and over
 * the guest's environment, and the decoy run uses the same pattern and the
 * same pipeline as the real one.
 */
const CREDENTIAL_SHAPES = "sk-ant-|sk-proj-|sk-or-v1-|github_pat_|ghp_|gho_|AIzaSy|xoxb-|xoxp-";

/**
 * The environment variable this run plants on itself.
 *
 * `check-container-host.ts` sets no environment canary -- its canary is a file
 * in the operator's home -- so the name comes from `check-native-container.ts`,
 * which established `CANARY_CREDENTIAL` for exactly this question. Reusing it
 * keeps one name for one idea across the scripts that ask it.
 *
 * A canary rather than an existing variable, because "the guest could not see
 * $PATH" would be a statement about $PATH. The daemon inherits this process's
 * environment and spawns `container run` from it, so the variable is provably
 * one hop away from the guest, and its absence inside is a result.
 */
const CANARY_ENV = "CANARY_CREDENTIAL";

/**
 * Command basenames that mean a foreign container runtime is involved.
 *
 * Split into exact names and prefixes because macOS `ps` truncates `comm` at
 * 15 characters even under `-ww`: measured on this host, Docker Desktop's
 * helpers arrive as `com.docker.back` and QEMU as `qemu-system-aar`, so an
 * exact match on the full name would never fire for either. `OrbStack` is here
 * for the opposite reason: it is what the `docker` CLI actually starts on a Mac
 * with OrbStack installed, so a run that woke it is exactly the foreign
 * involvement this refuses, whatever the CLI was called.
 *
 * The exact set is exact on purpose. A case-insensitive substring test for
 * "orb" matches `CoreSimulatorBridge`, which is running on this machine right
 * now and has nothing to do with containers.
 */
const FOREIGN_EXACT: Record<string, true> = { docker: true, dockerd: true, podman: true, orb: true, orbctl: true };
const FOREIGN_PREFIX = ["com.docker", "vfkit", "qemu", "OrbStack"];

/**
 * How long the model turn gets.
 *
 * The prompt asks for one token of text and no tool, so two minutes of silence
 * is a broken grant rather than a slow answer, and a run whose model access
 * does not work should say so quickly instead of sitting out a long deadline
 * with nothing to show for it.
 */
const MODEL_TURN_TIMEOUT_MS = 120_000;

/** How long the agent gets to come back to `idle` once the reply has landed. */
const SETTLE_TIMEOUT_MS = 120_000;

/** How long a probe waits for an answer from the broker before calling it absent. */
const PROBE_TIMEOUT_MS = 5_000;

/** Regenerated per run, so a reply cannot be a cached or replayed one. */
const NONCE = `MODELTURN-${randomBytes(5).toString("hex")}`;

const USAGE = `Prove a container agent completes a real model turn on Apple \`container\`.

Usage:
  bun run scripts/check-container-model-turn.ts [--help]

Starts a dedicated ompd on its own port and its own home, provisions one
container agent through the daemon's HTTP API, and sends it one prompt. That
prompt is answered by the operator's own model credential through the daemon's
broker, so the run spends real model credit. Everything it creates is removed
again, including when a phase fails.`;

interface Options {
  help: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** A permission request the guest's omp raised, which this run never asked for. */
interface ApprovalFrame {
  requestId: string;
  agentId: string;
  tool: string;
}

/**
 * A phase that refused to continue.
 *
 * Thrown rather than returned, so the summary and the teardown both still run.
 * A bare `return` out of the middle of the run skips the tally, which turns a
 * refusal at preflight into a script that prints nothing about what it checked.
 */
class StopRun extends Error {}

const checks: Check[] = [];
let step = 0;

function record(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  return ok;
}

function phase(title: string): void {
  step += 1;
  console.log(`\n-- ${step}. ${title}`);
}

async function run(argv: string[]): Promise<RunResult> {
  const child = spawn(argv[0] ?? "", argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  child.on("error", err => resolve({ code: 127, stdout, stderr: String(err) }));
  child.on("close", code => resolve({ code: code ?? 0, stdout, stderr }));
  return await promise;
}

/** One command inside a running container, through the runtime's own exec. */
async function exec(containerId: string, argv: string[]): Promise<RunResult> {
  return await run([RUNTIME, "exec", containerId, ...argv]);
}

function parseOptions(argv: string[]): Options {
  let help = false;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return { help };
}

/** Non-empty lines, which is what every `ls`-shaped probe below actually wants. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line !== "");
}

/** The operator's home written as `~`, so a printed path is short and not theirs to read twice. */
function shortHome(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function indent(text: string): string {
  const body = text.trimEnd();
  return body === "" ? "    (none)" : body.replace(/^/gm, "    ");
}

/**
 * A free loopback port for the daemon's model broker.
 *
 * Asked for rather than left at the 7788 default, because a hand-run check must
 * not fight the operator's own daemon over one fixed port. The broker binds a
 * container network's gateway address rather than loopback, so the two would
 * not literally collide, but a check that fails on a bind error for a reason
 * unrelated to what it is testing is a check nobody trusts.
 */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  // Typed optional because a Bun server can be bound to a unix socket instead.
  // This one asked for a TCP port, so an absent one means the bind did not do
  // what it was told and nothing below would be testing the right listener.
  const port = probe.port;
  await probe.stop(true);
  if (port === undefined) throw new Error("Bun.serve bound no TCP port, so no broker port could be reserved");
  return port;
}

/**
 * The model the daemon will grant this container, or the reason it cannot.
 *
 * `containerModel` is left empty on purpose so this run resolves the operator's
 * own `modelRoles.default`, which is the resolution order a real container
 * provision follows. The daemon resolves it again for itself and refuses to
 * provision when nothing resolves, so this is not the authority; it exists so a
 * missing default is named here, at preflight, rather than arriving later as a
 * provisioning error whose cause has to be inferred. There is no fallback and
 * no invented default: an unresolvable model ends the run.
 */
function resolveContainerModel(configured: string): { model: string; from: string } | { error: string } {
  if (configured !== "") return { model: configured, from: "containerModel" };
  if (!existsSync(HOST_OMP_CONFIG)) {
    return {
      error:
        `containerModel is empty and ${HOST_OMP_CONFIG} does not exist, so there is no modelRoles.default to ` +
        `fall back to; select a default model in omp or set containerModel`,
    };
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(HOST_OMP_CONFIG, "utf8"));
  } catch (err) {
    return { error: `${HOST_OMP_CONFIG} does not parse as YAML, so modelRoles.default cannot be read: ${String(err)}` };
  }
  // Two guarded reads rather than a helper: `Reflect.get` throws on a
  // primitive, and a config whose `modelRoles` is a string rather than a map is
  // exactly the shape that would make it.
  const roles = parsed !== null && typeof parsed === "object" ? Reflect.get(parsed, "modelRoles") : undefined;
  const fallback = roles !== null && typeof roles === "object" ? Reflect.get(roles, "default") : undefined;
  if (typeof fallback !== "string" || fallback.trim() === "") {
    return {
      error:
        `containerModel is empty and ${HOST_OMP_CONFIG} names no modelRoles.default, so no model resolves; ` +
        `set one of the two rather than expecting a default`,
    };
  }
  return { model: fallback.trim(), from: `${HOST_OMP_CONFIG} modelRoles.default` };
}

async function api(base: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return await fetch(`${base}${path}`, { ...init, headers });
}

/**
 * A client websocket, authenticated and attached, collecting the assistant's
 * own words.
 *
 * Approvals are answered rather than ignored. This script asks for one token of
 * text and no tool, so a permission request means the model reached for a tool
 * anyway; leaving it unanswered would hang the turn until the deadline and
 * report "no reply" for a turn that was waiting on this process. Denying it
 * once lets the turn finish and still answer, and the tool the model reached
 * for is recorded so the failure text says what happened rather than just that
 * nothing arrived.
 */
class Client {
  #ws: WebSocket;
  #errors: string[] = [];
  #approvals: ApprovalFrame[] = [];
  #assistant = "";
  #hello = Promise.withResolvers<string>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", event => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (frame.t === "hello") {
        this.#hello.resolve(String(frame.deviceId));
        return;
      }
      if (frame.t === "approval") {
        const approval: ApprovalFrame = {
          requestId: String(frame.requestId),
          agentId: String(frame.agentId),
          tool: String(frame.tool),
        };
        this.#approvals.push(approval);
        this.send({ t: "decide", agentId: approval.agentId, requestId: approval.requestId, choice: "deny", scope: "once" });
        return;
      }
      if (frame.t === "update") {
        // The assistant's own words, which is the only thing that says a model
        // actually answered. `assistantTextOf` is the daemon's own reader, so a
        // change to the chunk shape cannot make this silently stop collecting.
        const text = assistantTextOf(frame.update);
        if (text !== null) this.#assistant += text;
        return;
      }
      if (frame.t === "error") this.#errors.push(String(frame.message));
    });
  }

  /**
   * Resolves once the daemon has answered `hello`, which is the only proof the
   * token was accepted: an unauthenticated socket is closed rather than
   * refused, and a script that skipped this would read the silence that follows
   * as a model that never answered.
   */
  static async open(base: string, token: string): Promise<Client> {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/v1/socket?token=${token}`);
    const opened = Promise.withResolvers<void>();
    ws.addEventListener("open", () => opened.resolve());
    ws.addEventListener("error", () => opened.reject(new Error("websocket failed to open")));
    await opened.promise;
    const client = new Client(ws);
    await client.#hello.promise;
    return client;
  }

  get errors(): readonly string[] {
    return this.#errors;
  }

  /** Every permission request that arrived, all of them already denied. */
  get approvals(): readonly ApprovalFrame[] {
    return this.#approvals;
  }

  /** Everything the assistant has said on this socket, concatenated. */
  get assistantText(): string {
    return this.#assistant;
  }

  send(frame: Record<string, unknown>): void {
    this.#ws.send(JSON.stringify(frame));
  }

  close(): void {
    this.#ws.close();
  }
}

/**
 * Poll until the agent settles, and report which state it settled in.
 *
 * `failed` and `stopped` end the wait but are not success: a host that died
 * mid-turn also stops producing updates, and reading that as a finished turn
 * would be the same mistake as reading an unreachable broker as a revoked one.
 */
async function settle(base: string, token: string, agentId: string, ms: number): Promise<AgentState> {
  const deadline = Date.now() + ms;
  for (;;) {
    const body = (await (await api(base, token, "/v1/agents")).json()) as { agents: Agent[] };
    const agent = body.agents.find(candidate => candidate.id === agentId);
    const state = agent?.state;
    if (state === "idle" || state === "failed" || state === "stopped") return state;
    if (Date.now() > deadline) throw new Error(`agent ${agentId} never settled (state=${String(state)})`);
    await Bun.sleep(1000);
  }
}

/**
 * Wait for a nonce to appear in the assistant's own reply.
 *
 * `settle` cannot serve here, and reaching for it is the obvious mistake: the
 * agent is `idle` before the prompt is picked up as well as after the turn
 * ends, so polling for `idle` returns immediately and reads a turn that never
 * happened as a turn that succeeded. The reply text is the only evidence a
 * model answered. A terminal state ends the wait early so a broken grant
 * reports in seconds rather than after the whole deadline.
 */
async function awaitNonce(
  base: string,
  token: string,
  agentId: string,
  client: Client,
  needle: string,
  ms: number,
): Promise<{ seen: boolean; state: AgentState | null }> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (client.assistantText.includes(needle)) return { seen: true, state: null };
    const body = (await (await api(base, token, "/v1/agents")).json()) as { agents: Agent[] };
    const state = body.agents.find(candidate => candidate.id === agentId)?.state ?? null;
    if (state === "failed" || state === "stopped") return { seen: false, state };
    if (Date.now() > deadline) return { seen: false, state };
    await Bun.sleep(1000);
  }
}

/** A YAML double-quoted scalar the daemon wrote, read back out of the guest's config. */
function scalarFrom(yaml: string, key: string): string {
  const found = new RegExp(`^\\s*(?:- )?${key}: ("(?:[^"\\\\]|\\\\.)*")\\s*$`, "m").exec(yaml);
  if (found?.[1] === undefined) return "";
  const parsed: unknown = JSON.parse(found[1]);
  return typeof parsed === "string" ? parsed : "";
}

/** `http://host:port` for an endpoint the guest was given, or empty if it is not a URL. */
function originOf(endpoint: string): string {
  if (endpoint === "") return "";
  try {
    const url = new URL(endpoint);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

/** The status of one broker request, or null when nothing answered at all. */
async function brokerStatus(url: string, path: string, init: RequestInit): Promise<number | null> {
  try {
    const res = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.status;
  } catch {
    return null;
  }
}

/** A message body the broker would forward if it accepted the request. Never accepted here. */
function probeBody(model: string): string {
  return JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: `probe ${NONCE}` }] });
}

function isForeignRuntime(name: string): boolean {
  if (FOREIGN_EXACT[name] === true) return true;
  return FOREIGN_PREFIX.some(prefix => name.startsWith(prefix));
}

/**
 * Every foreign-runtime process running right now, keyed by pid.
 *
 * Keyed by pid rather than counted, because the question is not whether docker
 * is running on this machine -- OrbStack and a qemu were both already up when
 * this script was written -- but whether this run started one. That is a set
 * difference between two snapshots, and it needs identities on both sides.
 */
async function foreignProcesses(): Promise<{ read: boolean; total: number; matches: Map<number, string> }> {
  const ps = await run(["ps", "-Awwo", "pid=,comm="]);
  const matches = new Map<number, string>();
  let total = 0;
  for (const line of ps.stdout.split("\n")) {
    const found = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (found === null) continue;
    total += 1;
    const command = found[2] ?? "";
    const name = command.slice(command.lastIndexOf("/") + 1);
    if (isForeignRuntime(name)) matches.set(Number(found[1]), name);
  }
  return { read: ps.code === 0 && total > 0, total, matches };
}

/** `pid name` for each entry, so a failure names what appeared rather than how many. */
function describeProcesses(matches: Map<number, string>): string {
  return [...matches].map(([pid, name]) => `${name}(${pid})`).join(", ");
}

/**
 * The CIDR Apple's runtime assigned this network, or null.
 *
 * Only Apple's spelling is parsed, because this script only ever asks Apple's
 * runtime. `container.ts` parses both spellings and says why; duplicating the
 * docker branch here would be dead code claiming to cover a runtime this file
 * refuses to run on.
 */
async function networkCidr(network: string): Promise<string | null> {
  if (network === "") return null;
  const inspected = await run([RUNTIME, "network", "inspect", network]);
  if (inspected.code !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch {
    return null;
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  if (typeof first !== "object" || first === null || !("status" in first)) return null;
  const status: unknown = first.status;
  if (typeof status !== "object" || status === null || !("address" in status)) return null;
  const address: unknown = status.address;
  return typeof address === "string" && isIpv4Cidr(address) ? address : null;
}

/**
 * A routable IPv4 on a real interface that is NOT the container bridge.
 *
 * The exclusion is the whole point. While a container is running, Apple's
 * runtime holds the network's gateway address on a host interface -- that is
 * what makes the broker's bind possible at all -- so a naive "first
 * non-internal IPv4" would hand back the very address the broker is listening
 * on, and the probe that is supposed to show the broker is not on the LAN would
 * fail against the address it is deliberately bound to.
 */
function lanAddress(excludeCidr: string | null): { name: string; address: string } | null {
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (excludeCidr !== null && addressInIpv4Cidr(entry.address, excludeCidr)) continue;
      return { name, address: entry.address };
    }
  }
  return null;
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (err) {
    // A readable refusal and the usage, never a stack trace: the first thing
    // anyone does with an unfamiliar check script is run it with a flag it does
    // not have.
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  const home = mkdtempSync(join(tmpdir(), "ompd-model-turn-home-"));
  const workspace = mkdtempSync(join(tmpdir(), "ompd-model-turn-ws-"));
  let daemon: Ompd | undefined;
  let client: Client | undefined;

  /**
   * Everything this run created outside its own two temp directories, so the
   * teardown can take it all back even when a phase threw part way through.
   * The guest homes are here because they are daemon-side `mkdtemp` directories
   * holding a live bearer, and a probe that leaks one is worse than a probe
   * that fails.
   */
  const containers: string[] = [];
  const networks: string[] = [];
  const guestHomes: string[] = [];

  /**
   * The daemon's own log lines, kept as well as printed.
   *
   * The broker's grant and revocation accounting is reported here and nowhere a
   * client can read: there is no API for "was this grant withdrawn", and
   * inventing one to satisfy a check would be the check changing the product.
   * It is also the surface the "no token in a log line" assertion is made
   * against.
   */
  const daemonLog: string[] = [];
  const onLog = (line: string): void => {
    daemonLog.push(line);
    console.log(`  [daemon] ${line}`);
  };

  /**
   * Planted on this process, which the daemon and therefore `container run`
   * inherit. Its absence inside the guest is the assertion; its presence out
   * here is what stops that assertion being a statement about a variable nobody
   * ever set.
   */
  const canary = `ompd-model-turn-${randomBytes(8).toString("hex")}`;
  process.env[CANARY_ENV] = canary;

  let processBefore: Map<number, string> | null = null;

  try {
    phase("preflight");
    const version = await run([RUNTIME, "--version"]);
    if (!record(`${RUNTIME} responds`, version.code === 0, version.stdout.trim() || version.stderr.trim())) {
      throw new StopRun(`${RUNTIME} is not answering, so there is no Apple runtime to check`);
    }
    // Apple's runtime is a launchd service and the CLI is not it. With the
    // apiserver down every later step fails as an XPC error, which reads like a
    // confinement or provisioning failure and is nothing of the kind, so it is
    // separated out here with the exact remedy attached.
    const status = await run([RUNTIME, "system", "status"]);
    const apiserver = `${status.stdout}${status.stderr}`.includes("apiserver is running");
    if (
      !record(
        "the container apiserver is running",
        apiserver,
        apiserver ? "apiserver is running" : `remedy: ${RUNTIME} system start`,
      )
    ) {
      throw new StopRun("Apple's apiserver is down, so nothing below would be measuring this runtime");
    }
    // The broker forwards to `omp auth-gateway` and `omp auth-broker`, both
    // spawned from the daemon's `ompPath`, which defaults to a bare `omp`. A
    // missing binary surfaces as a provisioning failure two phases later with a
    // message about model access, so it is named here instead.
    const omp = await run(["omp", "--version"]);
    if (
      !record(
        "omp is on PATH, so the daemon can spawn the auth services the broker forwards to",
        omp.code === 0,
        omp.stdout.trim() || omp.stderr.trim(),
      )
    ) {
      throw new StopRun("omp is not on PATH, so the broker would have nothing to forward to");
    }

    // Empty `containerModel`, so this resolves the operator's own default, the
    // same way a real provision does.
    const resolved = resolveContainerModel("");
    if ("error" in resolved) {
      record("a model resolves for the container", false, resolved.error);
      throw new StopRun("no model resolves, so the container would provision unable to answer");
    }
    record("a model resolves for the container", true, `${resolved.model} from ${resolved.from}`);
    const expectedModel = resolved.model;

    phase("no foreign runtime is involved");
    const before = await foreignProcesses();
    processBefore = before.matches;
    // A read that returned nothing would make the comparison in the teardown
    // phase vacuous, so whether the process table can be read at all is the
    // check here; the comparison itself is the one that can catch something.
    record(
      "the process table can be read, so the comparison at teardown is not vacuous",
      before.read,
      `${before.total} processes, ${before.matches.size} foreign-runtime process(es) already running: ` +
        `${describeProcesses(before.matches) || "none"}`,
    );
    console.log("  those are this machine's, not this run's; the teardown phase compares against exactly this set");

    phase("start a daemon on its own port and home");
    const brokerPort = await freePort();
    const overrides = {
      port: 0,
      host: "127.0.0.1",
      // Pinned rather than left to the platform default. See `RUNTIME`.
      containerRuntime: RUNTIME,
      // The whole subject of this script. Off would put the guest back to
      // reaching `idle` and failing every prompt.
      containerModelAccess: true,
      // Empty on purpose: resolve the operator's own `modelRoles.default`,
      // which preflight reported above.
      containerModel: "",
      containerModelBrokerPort: brokerPort,
    };
    daemon = new Ompd({ home, overrides, repoRoot: workspace, voice: false, onLog });
    const started = await daemon.start();
    let base = started.url;
    let token = readFileSync(join(home, "token"), "utf8").trim();
    if (
      !record(
        "daemon listening on its own port and home",
        started.port > 0 && token !== "",
        `${base} home=${home} brokerPort=${brokerPort}`,
      )
    ) {
      throw new StopRun("the daemon did not come up, so nothing below can be provisioned");
    }

    phase("provision a container agent through POST /v1/agents");
    const listedBefore = await run([RUNTIME, "ls", "--all"]);
    console.log(`  ${RUNTIME} ls --all before:\n${indent(listedBefore.stdout)}`);

    const created = await api(base, token, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "container-model-turn", cwd: workspace, host: { kind: "container" } }),
    });
    const createdBody = (await created.json()) as { agent?: Agent; error?: string };
    if (createdBody.agent === undefined) {
      // A refusal here is a finding, never a skip. Model access is on, so a
      // daemon that cannot grant it fails the provision by design rather than
      // producing an agent that reaches `idle` and answers nothing, and the
      // reason it gives names the config key that is missing.
      record("agent created", false, `${created.status} ${createdBody.error ?? ""}`);
      throw new StopRun("no container agent was provisioned, so there is nothing to prove a turn against");
    }
    const agent = createdBody.agent;
    const containerId = agent.host.id;
    containers.push(containerId);
    const network = agent.host.resolved?.network ?? "";
    if (network !== "") networks.push(network);
    const guestHomeHost = agent.host.resolved?.guestHome ?? "";
    if (guestHomeHost !== "") guestHomes.push(guestHomeHost);

    record("agent created", created.status === 201, agent.id);
    record("host kind is container", agent.host.kind === "container", `${agent.host.kind}:${containerId.slice(0, 12)}`);
    record("agent reached idle", agent.state === "idle", `state=${agent.state}`);
    record(
      "the host was provisioned on Apple's own runtime",
      agent.host.resolved?.runtime === RUNTIME,
      `runtime=${agent.host.resolved?.runtime ?? "(none recorded)"}`,
    );
    // The two fields that make teardown survive a restart, which the last phase
    // depends on: without them a restarted daemon has nothing to address the
    // container or the seeded home with.
    record(
      "the persisted host ref names its network and its seeded home",
      network !== "" && guestHomeHost !== "",
      `network=${network || "(none)"} guestHome=${guestHomeHost || "(none)"}`,
    );

    const listedAfter = await run([RUNTIME, "ls", "--all"]);
    console.log(`  ${RUNTIME} ls --all after:\n${indent(listedAfter.stdout)}`);
    const runningIds = await run([RUNTIME, "ls", "--quiet"]);
    record("the container is running", lines(runningIds.stdout).includes(containerId), containerId.slice(0, 12));

    phase("the guest was seeded, and seeded with nothing reusable");
    const modelsRead = await exec(containerId, ["cat", GUEST_MODELS_YML]);
    const guestModelsYml = modelsRead.stdout;
    record("the guest has a seeded models.yml", modelsRead.code === 0, GUEST_MODELS_YML);

    const guestEndpoint = scalarFrom(guestModelsYml, "baseUrl");
    const grantedModel = scalarFrom(guestModelsYml, "id");
    const guestOrigin = originOf(guestEndpoint);
    // The Anthropic SDK appends `/v1/messages` itself, so a baseUrl ending in
    // `/v1` produces `/v1/v1/messages`, which the broker's route allowlist
    // refuses with a 404 that reads like a broken broker rather than a wrong
    // endpoint. It has been got wrong once, so it is asserted rather than
    // trusted.
    record(
      "baseUrl carries no trailing /v1",
      guestEndpoint !== "" && !/\/v1\/?$/.test(guestEndpoint),
      `baseUrl=${guestEndpoint || "(unread)"}`,
    );
    record(
      "the guest was pointed at this run's broker port",
      guestOrigin !== "" && new URL(guestOrigin).port === String(brokerPort),
      `endpoint=${guestEndpoint || "(unread)"} configured=${brokerPort}`,
    );
    record(
      "the granted model is the one preflight resolved",
      grantedModel !== "" && grantedModel === expectedModel,
      `granted=${grantedModel || "(unread)"} expected=${expectedModel}`,
    );

    // Read once, from the guest's own view. Held in memory only: never printed,
    // never written to disk, never placed in an argv. It is the live bearer for
    // this container's grant, and the revocation phase needs it after the agent
    // is gone. Reading it here rather than there is deliberate -- three
    // assertions below are about bytes that must appear nowhere except this one
    // file, and they cannot be made without the bytes.
    const tokenRead = await exec(containerId, ["cat", GUEST_TOKEN_PATH]);
    const guestBearer = tokenRead.stdout.trim();
    record(
      "the guest holds a scoped model bearer of its own",
      tokenRead.code === 0 && guestBearer !== "",
      `${guestBearer.length} chars at ${GUEST_TOKEN_PATH}, not shown`,
    );
    const tokenStat = await exec(containerId, ["stat", "-c", "%a", GUEST_TOKEN_PATH]);
    record(
      "the bearer file is 0600 from the guest's view",
      tokenStat.stdout.trim() === "600",
      `mode=${tokenStat.stdout.trim() || "(unread)"}`,
    );
    record(
      "models.yml reads the bearer with !cat rather than embedding it",
      scalarFrom(guestModelsYml, "apiKey") === `!cat ${GUEST_TOKEN_PATH}` &&
        guestBearer !== "" &&
        !guestModelsYml.includes(guestBearer),
      `apiKey is a command over ${GUEST_TOKEN_PATH}`,
    );

    // A check that cannot fail is not a check. The scan is run against a
    // planted decoy first, with the same pattern and the same pipeline, and
    // only then against the real tree. The decoy is written from inside the
    // guest so it lands in exactly the directory being scanned.
    const scanArgv = [
      RUNTIME,
      "exec",
      containerId,
      "sh",
      "-c",
      `grep -rlE '${CREDENTIAL_SHAPES}' ${GUEST_HOME_MOUNT} 2>/dev/null | sort`,
    ];
    await exec(containerId, ["sh", "-c", `printf '%s\\n' '${DECOY_VALUE}' > ${GUEST_DECOY_PATH}`]);
    const decoyScan = await run(scanArgv);
    record(
      "the credential scan detects a planted credential shape",
      decoyScan.stdout.includes(GUEST_DECOY_PATH),
      lines(decoyScan.stdout).join(", ") || "(the scan found nothing, so it proves nothing)",
    );
    await exec(containerId, ["rm", "-f", GUEST_DECOY_PATH]);
    const realScan = await run(scanArgv);
    record(
      "no provider-credential value shape anywhere in the guest's home",
      realScan.stdout.trim() === "",
      lines(realScan.stdout).join(", ") || `scanned ${GUEST_HOME_MOUNT}`,
    );

    // The same question of the environment. Variable names only on the way out,
    // never values: a scan that printed what it found would publish the very
    // thing it exists to prove is absent.
    const envDecoy = await exec(containerId, [
      "sh",
      "-c",
      `DECOY=${DECOY_VALUE} env | grep -E '${CREDENTIAL_SHAPES}' | cut -d= -f1 | sort; echo PROBE-COMPLETE`,
    ]);
    record(
      "the environment scan detects a planted credential shape",
      lines(envDecoy.stdout).includes("DECOY"),
      lines(envDecoy.stdout).join(", "),
    );
    const envScan = await exec(containerId, [
      "sh",
      "-c",
      `env | grep -E '${CREDENTIAL_SHAPES}' | cut -d= -f1 | sort; echo PROBE-COMPLETE`,
    ]);
    const envHits = lines(envScan.stdout).filter(name => name !== "PROBE-COMPLETE");
    record(
      "no provider-credential value shape in the guest's environment",
      lines(envScan.stdout).includes("PROBE-COMPLETE") && envHits.length === 0,
      envHits.join(", ") || "no variable in the guest's environment carries one",
    );

    phase("host credential canaries are absent");
    const hostOmp = join(homedir(), ".omp");
    const hostCanaries = [
      join(hostOmp, "agent", "agent.db"),
      join(hostOmp, "auth-broker.token"),
      join(hostOmp, "auth-gateway.token"),
      join(homedir(), ".ompd"),
    ];
    const presentOnHost = hostCanaries.filter(path => existsSync(path));
    // Without this, "the guest could not read it" would also be true of a path
    // that does not exist anywhere, and every refusal below would be vacuous.
    record(
      "the host really holds credential paths the guest must not reach",
      presentOnHost.length > 0,
      presentOnHost.map(shortHome).join(", ") || "(none of them exist on this machine)",
    );
    for (const path of hostCanaries) {
      // `cat` for a file and `ls` for a directory, in one command, because the
      // list holds both and a `cat` of a directory fails for the wrong reason.
      const reach = await exec(containerId, ["sh", "-c", `cat ${path} >/dev/null 2>&1 || ls -a ${path} >/dev/null 2>&1`]);
      record(
        `the guest cannot reach ${shortHome(path)}`,
        reach.code !== 0,
        `on the host: ${existsSync(path) ? "present" : "absent"}, in the guest: exit ${reach.code}`,
      );
    }

    const hostSeesCanary = await run(["printenv", CANARY_ENV]);
    record(
      `${CANARY_ENV} is in this process's own environment, so its absence in the guest is a result`,
      hostSeesCanary.code === 0 && hostSeesCanary.stdout.trim() === canary,
      `printenv exit ${hostSeesCanary.code}`,
    );
    const guestSeesCanary = await exec(containerId, ["printenv", CANARY_ENV]);
    record(
      "the host's environment did not cross into the guest",
      guestSeesCanary.code !== 0 && !guestSeesCanary.stdout.includes(canary),
      `printenv exit ${guestSeesCanary.code}`,
    );

    phase("a real model turn");
    client = await Client.open(base, token);
    client.send({ t: "attach", agentId: agent.id });
    const askedAt = Date.now();
    client.send({
      t: "prompt",
      agentId: agent.id,
      text: `Reply with exactly this token and nothing else: ${NONCE}\nThat is the entire task. Do not use any tool.`,
    });
    const turn = await awaitNonce(base, token, agent.id, client, NONCE, MODEL_TURN_TIMEOUT_MS);
    const elapsed = ((Date.now() - askedAt) / 1000).toFixed(1);
    record(
      "the container completed a real model turn",
      turn.seen,
      turn.seen
        ? `reply carries ${NONCE} after ${elapsed}s`
        : `no nonce in ${client.assistantText.length} chars of reply after ${elapsed}s; ` +
            `state=${turn.state ?? "unknown"}`,
    );
    if (!turn.seen) {
      // In full, not sliced. A failure here is the whole point of the script,
      // and an operator reading it needs the provider's own words rather than a
      // truncated hint: "quota exhausted", "model not found" and "connection
      // refused" are three different repairs.
      console.log("\n  the turn produced no nonce. everything the daemon and the socket said about it:");
      console.log(`  assistant text: ${client.assistantText || "(nothing)"}`);
      for (const message of client.errors) console.log(`  socket error: ${message}`);
      if (client.errors.length === 0) console.log("  socket error: (none)");
      for (const approval of client.approvals) {
        console.log(`  the model asked to use ${approval.tool}, which this run denied; it was told to use no tool`);
      }
    } else {
      const afterTurn = await settle(base, token, agent.id, SETTLE_TIMEOUT_MS);
      record("the agent settled after the turn", afterTurn === "idle", `state=${afterTurn}`);
    }

    phase("the broker is not reachable from anywhere it should not be");
    // A non-allowlisted route is the liveness signal, and it needs no
    // credential: the broker's routable surface is exactly `POST /v1/messages`
    // and `POST /v1/messages/count_tokens`, and everything else gets a real 404
    // before any credential is looked at.
    const wrongPath = await brokerStatus(guestOrigin, "/v1/healthz", { method: "GET" });
    record(
      "the broker answers a wrong path with 404, so it is listening and refusing rather than absent",
      wrongPath === 404,
      `GET ${guestOrigin || "(no endpoint captured)"}/v1/healthz -> ${wrongPath ?? "nothing answered"}`,
    );
    const unauthenticated = await brokerStatus(guestOrigin, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: probeBody(grantedModel),
    });
    record(
      "an unauthenticated request to the broker is 401",
      unauthenticated === 401,
      `POST /v1/messages with no bearer -> ${unauthenticated ?? "nothing answered"}`,
    );

    const loopbackReach = await brokerStatus(`http://127.0.0.1:${brokerPort}`, "/v1/healthz", { method: "GET" });
    record(
      "the broker does not serve the host's loopback",
      loopbackReach === null,
      `GET http://127.0.0.1:${brokerPort}/v1/healthz -> ${loopbackReach ?? "nothing answered, which is the point"}`,
    );
    const cidr = await networkCidr(network);
    const lan = lanAddress(cidr);
    if (lan === null) {
      console.log(
        `  no non-internal IPv4 outside ${cidr ?? "the container bridge"} on this machine, so a LAN probe would ` +
          "prove nothing and is skipped",
      );
    } else {
      const lanReach = await brokerStatus(`http://${lan.address}:${brokerPort}`, "/v1/healthz", { method: "GET" });
      record(
        "the broker does not serve the host's LAN address",
        lanReach === null,
        `GET http://${lan.address}:${brokerPort}/v1/healthz on ${lan.name} -> ` +
          `${lanReach ?? "nothing answered, which is the point"}`,
      );
    }

    phase("stop revokes the token");
    const logMark = daemonLog.length;
    const stopped = await api(base, token, `/v1/agents/${agent.id}`, { method: "DELETE" });
    record("agent stopped", stopped.status === 200, String(stopped.status));

    // The trap this phase exists to avoid: stopping the last agent on a network
    // takes the container, the network and therefore the gateway address down
    // with it, and the broker closes when its last grant goes. A request that
    // cannot connect after that proves nothing about the grant, and reading it
    // as revocation would be a check that passes hardest when it is broken. So
    // liveness is established first, and the evidence used depends on the
    // answer rather than on hope.
    const stillListening = await brokerStatus(guestOrigin, "/v1/healthz", { method: "GET" });
    if (stillListening === 404) {
      const refused = await brokerStatus(guestOrigin, "/v1/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${guestBearer}`, "content-type": "application/json" },
        body: probeBody(grantedModel),
      });
      record(
        "the bearer is refused now the agent is gone",
        refused === 401,
        `POST /v1/messages with the withdrawn bearer -> ${refused ?? "nothing answered"}`,
      );
    } else {
      console.log(
        "  the broker came down with its last grant, so a network probe cannot tell revoked from gone; the " +
          "daemon's own record is used instead, and the port is proved dead everywhere it could be presented",
      );
      const since = daemonLog.slice(logMark).join("\n");
      const revoked = /model broker: revoked a grant for (\S+) \((\d+) requests?, (\d+) tokens? used\)/.exec(since);
      record(
        "the broker revoked this grant, and served the turn on it",
        revoked !== null && revoked[1] === grantedModel && Number(revoked[2]) > 0,
        revoked === null
          ? "the broker never reported revoking a grant, so the turn may not have gone through it"
          : `${revoked[1]}: ${revoked[2]} requests, ${revoked[3]} tokens (granted ${grantedModel})`,
      );
      const presentable = [guestOrigin, `http://127.0.0.1:${brokerPort}`].filter(url => url !== "");
      const statuses = await Promise.all(
        presentable.map(async url => {
          const seen = await brokerStatus(url, "/v1/messages", {
            method: "POST",
            headers: { authorization: `Bearer ${guestBearer}`, "content-type": "application/json" },
            body: probeBody(grantedModel),
          });
          return `${url} -> ${seen ?? "nothing answered"}`;
        }),
      );
      record(
        "the withdrawn bearer has no listener left to present it to",
        statuses.every(entry => entry.endsWith("nothing answered")),
        statuses.join(", "),
      );
    }

    // The constraint the whole design rests on: the bearer appears in one 0600
    // file inside the guest and nowhere else this daemon writes.
    const auditText = await (await api(base, token, "/v1/audit?limit=200")).text();
    record(
      "no audit row carries the guest's bearer",
      guestBearer !== "" && !auditText.includes(guestBearer),
      `${auditText.length} bytes scanned`,
    );
    record(
      "no daemon log line carries the guest's bearer",
      guestBearer !== "" && !daemonLog.some(line => line.includes(guestBearer)),
      `${daemonLog.length} lines scanned`,
    );
    record(
      "the grant is audited",
      (JSON.parse(auditText) as { entries: AuditEntry[] }).entries.some(entry => entry.action === "model.grant"),
      "model.grant",
    );
    record(
      "the seeded guest home is gone from the host",
      guestHomeHost !== "" && !existsSync(guestHomeHost),
      guestHomeHost || "(none recorded)",
    );

    phase("restart reconciliation destroys a stale container and its grant");
    // The socket belongs to the daemon that is about to go away.
    client.close();
    client = undefined;

    const secondCreated = await api(base, token, "/v1/agents", {
      method: "POST",
      body: JSON.stringify({ name: "container-model-turn-restart", cwd: workspace, host: { kind: "container" } }),
    });
    const secondBody = (await secondCreated.json()) as { agent?: Agent; error?: string };
    if (secondBody.agent === undefined) {
      record("a second container agent was provisioned", false, `${secondCreated.status} ${secondBody.error ?? ""}`);
      throw new StopRun("no second container agent, so restart reconciliation has nothing to reclaim");
    }
    const second = secondBody.agent;
    const secondId = second.host.id;
    containers.push(secondId);
    const secondNetwork = second.host.resolved?.network ?? "";
    if (secondNetwork !== "") networks.push(secondNetwork);
    const secondGuestHome = second.host.resolved?.guestHome ?? "";
    if (secondGuestHome !== "") guestHomes.push(secondGuestHome);
    record("a second container agent was provisioned", secondCreated.status === 201, `${second.id} state=${second.state}`);

    const secondTokenRead = await exec(secondId, ["cat", GUEST_TOKEN_PATH]);
    const secondBearer = secondTokenRead.stdout.trim();
    record(
      "the second guest holds a bearer of its own, not a copy of the first",
      secondBearer !== "" && secondBearer !== guestBearer,
      `${secondBearer.length} chars, not shown`,
    );

    await daemon.stop();
    daemon = undefined;
    // Observed between the two daemons rather than assumed either way, because
    // it decides what the assertion below is actually about. A graceful stop
    // destroys every container this process provisioned, so on that path
    // reconciliation meets a persisted ref whose container is already absent
    // and folds it into success. A container still listed here is one the
    // previous daemon did not reclaim, and then reconciliation is what removes
    // it. Both are worth proving; claiming the second when the first happened
    // would be a claim about a step that did no work.
    const between = await run([RUNTIME, "ls", "--all", "--quiet"]);
    const survivedStop = lines(between.stdout).includes(secondId);
    console.log(
      survivedStop
        ? "  the container outlived the daemon that made it, so reconciliation below is what has to remove it"
        : "  the daemon's own teardown removed it, so reconciliation below meets a ref whose container is gone",
    );

    daemon = new Ompd({ home, overrides, repoRoot: workspace, voice: false, onLog });
    const restarted = await daemon.start();
    base = restarted.url;
    token = readFileSync(join(home, "token"), "utf8").trim();
    record("the daemon restarted on the same home", restarted.port > 0 && token !== "", `${base} home=${home}`);

    const afterRestart = await run([RUNTIME, "ls", "--all", "--quiet"]);
    record(
      "the container the previous daemon made is gone",
      !lines(afterRestart.stdout).includes(secondId),
      `${secondId.slice(0, 12)} removed by ${survivedStop ? "restart reconciliation" : "the daemon's own teardown"}`,
    );
    const netsLeft = await run([RUNTIME, "network", "ls", "--quiet"]);
    record(
      "its network went with it",
      secondNetwork !== "" && !lines(netsLeft.stdout).includes(secondNetwork),
      secondNetwork || "(none recorded)",
    );

    const roster = (await (await api(base, token, "/v1/agents")).json()) as { agents: Agent[] };
    const secondRow = roster.agents.find(candidate => candidate.id === second.id);
    record(
      "the agent is not left claiming to be running",
      secondRow !== undefined && TERMINAL_AGENT_STATES.includes(secondRow.state),
      `state=${secondRow?.state ?? "(no row)"}`,
    );

    const restartAudit = JSON.parse(await (await api(base, token, "/v1/audit?limit=200")).text()) as {
      entries: AuditEntry[];
    };
    const reconciled = restartAudit.entries.filter(
      entry => entry.action === "host.reconcile" && entry.detail.hostId === secondId,
    );
    record(
      "reconciliation addressed the host ref the previous daemon persisted",
      reconciled.some(entry => entry.outcome === "ok"),
      reconciled.map(entry => entry.outcome).join(",") || "(no host.reconcile row names it)",
    );

    // The claim the phase is named for, stated where a reader will meet it. A
    // daemon restart withdraws model access from every container it did not
    // start, and that is by design rather than a gap: the broker's grants live
    // only in the process that minted them, and the bearer is deliberately
    // absent from the `HostRef.resolved` the store persists, so a restarted
    // daemon can still remove the container and the directory while having
    // nothing left that could honour the token.
    const persisted = JSON.stringify(secondRow?.host ?? {});
    record(
      "the persisted host ref carries no bearer, which is why a restart withdraws model access by design",
      secondBearer !== "" && !persisted.includes(secondBearer) && persisted.length > 0,
      `${persisted.length} bytes of HostRef scanned; the grant died with the process that minted it`,
    );

    const secondOrigin = originOf(`http://${cidrGateway(secondNetwork, await networkCidr(secondNetwork))}`);
    const deadEnds = [secondOrigin, `http://127.0.0.1:${brokerPort}`].filter(url => url !== "");
    const deadStatuses = await Promise.all(
      deadEnds.map(async url => {
        const seen = await brokerStatus(url, "/v1/messages", {
          method: "POST",
          headers: { authorization: `Bearer ${secondBearer}`, "content-type": "application/json" },
          body: probeBody(grantedModel),
        });
        return { url, seen };
      }),
    );
    record(
      "the bearer the previous daemon minted succeeds nowhere",
      deadStatuses.every(entry => entry.seen === null || entry.seen === 401),
      deadStatuses.map(entry => `${entry.url} -> ${entry.seen ?? "nothing answered"}`).join(", "),
    );
  } catch (err) {
    if (err instanceof StopRun) {
      console.log(`\n  stopping: ${err.message}`);
    } else {
      // Recorded as a failed check rather than allowed to escape, so the run
      // still prints its tally and still tears down. The stack goes to the
      // console because a bug in this script is a bug someone has to find.
      record("the run completed without an unexpected error", false, err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack !== undefined) console.log(err.stack);
    }
  } finally {
    phase("teardown");
    // Each step is guarded on its own: one failing cleanup must not skip the
    // rest, and a probe that leaks a container or a directory holding a bearer
    // is worse than a probe that fails.
    try {
      client?.close();
    } catch (err) {
      console.log(`  cleanup: closing the socket failed: ${String(err)}`);
    }
    try {
      await daemon?.stop();
    } catch (err) {
      console.log(`  cleanup: stopping the daemon failed: ${String(err)}`);
    }
    for (const id of containers) {
      const still = await run([RUNTIME, "ls", "--all", "--quiet"]);
      if (!lines(still.stdout).includes(id)) continue;
      const forced = await run([RUNTIME, "rm", "--force", id]);
      console.log(`  cleanup: force-removed a surviving container ${id.slice(0, 12)} (exit ${forced.code})`);
    }
    for (const name of networks) {
      const left = await run([RUNTIME, "network", "ls", "--quiet"]);
      if (!lines(left.stdout).includes(name)) continue;
      const removed = await run([RUNTIME, "network", "rm", name]);
      console.log(`  cleanup: removed a surviving network ${name} (exit ${removed.code})`);
    }
    for (const dir of [...guestHomes, workspace, home]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.log(`  cleanup: removing ${dir} failed, remove it by hand: ${String(err)}`);
      }
    }
    console.log("  cleanup: guest homes, workspace and daemon home removed");

    if (processBefore === null) {
      console.log("  no process-table snapshot was taken, so nothing can be said about foreign runtimes");
    } else {
      const after = await foreignProcesses();
      const appeared = new Map([...after.matches].filter(([pid]) => !processBefore.has(pid)));
      record(
        "no docker, podman, orb, vfkit or qemu process was started by this run",
        after.read && appeared.size === 0,
        appeared.size > 0
          ? `appeared during this run: ${describeProcesses(appeared)}`
          : `${processBefore.size} foreign-runtime process(es) were already running and are untouched`,
      );
    }
  }

  const failed = checks.filter(check => !check.ok);
  console.log(`\n${checks.length - failed.length} ok, ${failed.length} failed`);
  return failed.length === 0 ? 0 : 1;
}

/**
 * The gateway address of a network, as `host:port` is not what `network
 * inspect` returns: it answers a CIDR, and the gateway is its first address.
 *
 * Used only after the network has been destroyed, where the point is that
 * nothing answers there any more. An unknown network yields an empty string,
 * which the caller drops from its probe list rather than turning into a URL
 * pointing at nothing in particular.
 */
function cidrGateway(network: string, cidr: string | null): string {
  if (network === "" || cidr === null) return "";
  const base = cidr.split("/")[0] ?? "";
  const octets = base.split(".");
  if (octets.length !== 4) return "";
  return `${octets[0]}.${octets[1]}.${octets[2]}.1`;
}

process.exit(await main());
