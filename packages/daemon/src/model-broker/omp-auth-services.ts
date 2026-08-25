/**
 * The two loopback omp services that stand between a container agent and a
 * provider credential.
 *
 * A guest cannot be handed an API key. It has unrestricted egress and, on
 * Apple container, the full capability set, so anything reusable that reaches
 * it can leave the machine and the sandbox has nothing left to fall back on.
 * What a guest gets instead is a scoped bearer for one model on one endpoint,
 * and behind that endpoint sit omp's own two services, both bound to loopback
 * where no container can reach them:
 *
 *   `omp auth-broker serve`   the credential vault over the operator's
 *                             existing `~/.omp/agent/agent.db`. It holds the
 *                             OAuth refresh tokens and performs the refreshes.
 *   `omp auth-gateway serve`  a forward proxy that resolves a broker-backed
 *                             credential and dispatches to the provider. Its
 *                             clients never see the access token, which is the
 *                             property this whole arrangement is built on.
 *
 * This module owns their lifecycle and nothing else. It does not proxy, does
 * not mint grants, and never reads a provider credential. The one secret it
 * touches is the gateway's own inbound bearer. It reads that from disk on every
 * call rather than caching it for use, so `omp auth-gateway token --regenerate`
 * takes effect on the next request; and it keeps the values it has read in a
 * small bounded set for exactly one purpose, which is redacting them out of a
 * child's output by identity rather than by pattern. That retention is a
 * deliberate trade and it adds no exposure that was not already there: the same
 * plaintext is in this process's heap on every forwarded request either way,
 * and what the set buys in exchange for its lifetime is the one part of `scrub`
 * that is exact instead of best-effort.
 *
 * The start ordering is not cosmetic. The gateway is itself a broker client
 * and refuses to boot without a broker to talk to: measured against omp
 * 18.0.4, a gateway spawned without `OMP_AUTH_BROKER_URL` exits immediately
 * with "`omp auth-gateway serve` requires OMP_AUTH_BROKER_URL". So the broker
 * has to be answering its health endpoint before the gateway is spawned, and
 * a broker that later dies takes the gateway down with it, because the URL the
 * gateway was handed at spawn time is the only one it will ever use.
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

/** Both services bind here and nowhere else. A container cannot reach host loopback. */
const LOOPBACK = "127.0.0.1";

/** Unauthenticated liveness endpoints. Every other route on either service wants a bearer. */
const BROKER_HEALTH_PATH = "/v1/healthz";
const GATEWAY_HEALTH_PATH = "/healthz";

/** The gateway writes this on first start, mode 0600, inside its config dir. */
const GATEWAY_TOKEN_FILE = "auth-gateway.token";

/**
 * How long a service gets to answer its health endpoint before the start is
 * called a failure. Generous, because the broker opens the operator's vault
 * and the gateway pulls a snapshot from it before either is ready, and because
 * the cost of being wrong is a container agent that cannot answer a prompt.
 */
const DEFAULT_READY_TIMEOUT_MS = 60_000;

/** Health polls are cheap and local; the broker answered in well under a second when measured. */
const HEALTH_POLL_INTERVAL_MS = 200;

/** One health probe's own budget, so a wedged connect cannot eat the whole readiness window. */
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;

/** Time a service gets to honour SIGTERM before it is killed outright. */
const CLOSE_GRACE_MS = 2_000;

const SIGTERM = 15;
const SIGKILL = 9;

/** Longest forwarded or quoted line. A daemon log is not a place for a wrapped stack frame. */
const MAX_LOG_LINE_CHARS = 500;

/** Child output kept per service, so a failure can say what the child said. */
const FAILURE_TAIL_LINES = 12;

/** One marker for every redaction, so a scrubbed line reads the same wherever it came from. */
const REDACTED = "[redacted]";

/**
 * Bounds on the set of secrets `scrub` removes by exact match.
 *
 * The floor keeps a short value out of the set. omp's own gateway bearer is 43
 * base64url characters, and a token file holding two characters is not a
 * credential anything can rely on, but it IS a substring of half the English
 * language: putting it in the set would turn every line that happens to contain
 * those two characters into confetti.
 *
 * The ceiling bounds what rotation can accumulate. Every regenerate adds a
 * value and none can be dropped on rotation, because a line written before it
 * may still be in flight carrying the old one. Eight is more than a daemon's
 * lifetime sees and it caps the per-line cost at eight substring scans.
 */
const MIN_KNOWN_SECRET_CHARS = 8;
const MAX_KNOWN_SECRETS = 8;

/**
 * The slice of a spawned process this module drives, so a test can hand it a
 * child of its own choosing without spawning omp. `Bun.spawn`'s subprocess
 * satisfies it as-is.
 */
export interface AuthServiceProcess {
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  kill(signal?: number): void;
}

export type SpawnLike = (argv: string[], options: { env: Record<string, string | undefined> }) => AuthServiceProcess;

export interface OmpAuthServicesOptions {
  /** Resolved omp binary, from daemon config. Argv[0] for both children. */
  ompPath: string;
  /** omp config dir, normally `${homedir()}/.omp`. Both token files live directly under it. */
  configDir: string;
  /** Default 0, meaning pick a free loopback port. */
  brokerPort?: number;
  /** Default 0, meaning pick a free loopback port. */
  gatewayPort?: number;
  /**
   * Never receives a bearer this module has read: those are removed by
   * identity. Everything else in a child's output is removed by pattern, which
   * is best-effort rather than a guarantee. See `scrub`.
   */
  onLog?: (line: string) => void;
  /** Injectable for tests. */
  spawn?: SpawnLike;
  /**
   * How long each service gets to become healthy. Additive to the module
   * contract and optional, so nothing wiring this up has to pass it; it exists
   * because a test that fakes `spawn` would otherwise sit through the full
   * minute to reach the timeout path.
   */
  readyTimeoutMs?: number;
}

/** The subcommand name, which is also how the service is named in a log line and an error. */
type ServiceName = "auth-broker" | "auth-gateway";

interface Service {
  readonly name: ServiceName;
  readonly port: number;
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  readonly url: string;
  readonly child: AuthServiceProcess;
  /** Last lines the child wrote, already scrubbed, for a failure message. */
  readonly tail: string[];
  exited: boolean;
  exitCode: number | null;
}

export class OmpAuthServices {
  #ompPath: string;
  #configDir: string;
  #brokerPort: number;
  #gatewayPort: number;
  #onLog: (line: string) => void;
  #spawn: SpawnLike;
  #readyTimeoutMs: number;

  #broker: Service | null = null;
  #gateway: Service | null = null;
  /** The one in-flight start, shared by every concurrent caller of `ensure`. */
  #starting: Promise<{ gatewayUrl: string }> | null = null;
  /**
   * Every secret this module has read, oldest first.
   *
   * It exists so `scrub` can remove a credential by identity. A pattern can
   * only guess at what a credential looks like; this set knows, for the one
   * secret this module reads. See the header for why holding it costs nothing
   * that was not already held.
   */
  readonly #known = new Set<string>();

  constructor(opts: OmpAuthServicesOptions) {
    this.#ompPath = opts.ompPath;
    this.#configDir = opts.configDir;
    this.#brokerPort = opts.brokerPort ?? 0;
    this.#gatewayPort = opts.gatewayPort ?? 0;
    this.#onLog = opts.onLog ?? (() => {});
    this.#spawn = opts.spawn ?? defaultSpawn;
    this.#readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  /**
   * Bring both services up, or answer with the ones already up.
   *
   * Single-flighted, because the first two container provisions can land at
   * the same moment and two brokers over one SQLite vault is not a thing
   * anybody wants to debug. Concurrent callers share the one start; a caller
   * arriving after it succeeded gets the cached url and nothing is spawned.
   * A service that has since exited is restarted rather than reported, so this
   * never answers with a url nothing is listening on.
   */
  async ensure(): Promise<{ gatewayUrl: string }> {
    const inFlight = this.#starting;
    if (inFlight !== null) return await inFlight;

    const broker = this.#broker;
    const gateway = this.#gateway;
    if (broker !== null && !broker.exited && gateway !== null && !gateway.exited) {
      return { gatewayUrl: gateway.url };
    }

    const started = this.#start();
    this.#starting = started;
    try {
      return await started;
    } finally {
      // Guarded, because `close` may already have replaced it with null.
      if (this.#starting === started) this.#starting = null;
    }
  }

  /**
   * The gateway's inbound bearer.
   *
   * Read from disk on every call and never cached, so rotating the file with
   * `omp auth-gateway token --regenerate` takes effect on the next request
   * rather than on the next daemon restart. The value is returned and never
   * logged, never put in an error message, and never written anywhere.
   */
  async gatewayBearer(): Promise<string> {
    const path = join(this.#configDir, GATEWAY_TOKEN_FILE);

    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(
        `omp auth-gateway has no bearer token at ${path} (${err instanceof Error ? err.message : String(err)}). ` +
          "The gateway writes that file on its first start, so either it has never run or configDir is wrong.",
      );
    }

    const token = contents.trim();
    if (token.length === 0) {
      throw new Error(
        `omp auth-gateway's bearer token at ${path} is empty. ` +
          "Recreate it with `omp auth-gateway token --regenerate`.",
      );
    }
    // Learned here rather than at the call sites, because this is the only
    // place the value enters this process, and a caller that forgot to say so
    // would leave the exact-match layer reading a stale set.
    this.#remember(token);
    return token;
  }

  status(): { brokerUrl: string | null; gatewayUrl: string | null; running: boolean } {
    const broker = this.#broker;
    const gateway = this.#gateway;
    const brokerUrl = broker === null || broker.exited ? null : broker.url;
    const gatewayUrl = gateway === null || gateway.exited ? null : gateway.url;
    return { brokerUrl, gatewayUrl, running: brokerUrl !== null && gatewayUrl !== null };
  }

  /**
   * Stop both services. Safe to call twice, and safe to call on something that
   * never started.
   *
   * Not a poison pill: a later `ensure` starts fresh. Refusing to restart
   * would mean a daemon that closed these on a host release could never
   * provision another container, and there is nothing to protect by refusing.
   */
  async close(): Promise<void> {
    // A close landing mid-start has to let that start finish. Otherwise the
    // child it is a moment away from spawning outlives this call with nothing
    // holding a handle to it. Whether that start succeeded is not this
    // caller's problem.
    const starting = this.#starting;
    if (starting !== null) await starting.catch(() => {});
    this.#starting = null;

    // Gateway first: it is the broker's client, and stopping the thing it
    // depends on underneath it only produces noise on the way down.
    const services = [this.#gateway, this.#broker];
    this.#gateway = null;
    this.#broker = null;
    for (const service of services) await stop(service);
  }

  /**
   * Broker, then gateway, each waited on before the next step.
   *
   * Whatever became healthy is kept even when a later step fails, so a retry
   * only has to start what is actually missing. Whatever failed is stopped
   * before the throw, by `#startService` when it never became healthy and here
   * when it came up but would not accept its own bearer, so a failed start
   * never leaves a child running that nothing holds.
   */
  async #start(): Promise<{ gatewayUrl: string }> {
    // Read the gateway's bearer before either child is spawned, purely so
    // `scrub` knows it by identity while their startup output is being drained.
    // Without this the value is not learned until `#verifyBearerAccepted`,
    // which runs after both children have already written everything they write
    // at boot: exactly the window in which a gateway complaining about its own
    // token would quote it. Swallowed, because on a genuinely first start the
    // file does not exist yet -- the gateway is about to write it -- and that
    // residual window is one of the reasons the pattern layer in `scrub` is not
    // optional. A missing token file becomes a reported failure in
    // `#verifyBearerAccepted`, which is where it belongs.
    try {
      await this.gatewayBearer();
    } catch {
      // Nothing to learn yet.
    }

    if (this.#broker === null || this.#broker.exited) {
      // A broker that has gone away takes the gateway with it. The gateway was
      // handed the broker's url in its environment at spawn time and a
      // replacement broker will not be on the same port, so a gateway left
      // pointing at the old one is a healthy-looking service that can resolve
      // no credential at all.
      await stop(this.#gateway);
      this.#gateway = null;
      await stop(this.#broker);
      this.#broker = null;
      this.#broker = await this.#startService("auth-broker", this.#brokerPort, BROKER_HEALTH_PATH, {});
    }
    const broker = this.#broker;

    if (this.#gateway === null || this.#gateway.exited) {
      await stop(this.#gateway);
      this.#gateway = null;
      const gateway = await this.#startService("auth-gateway", this.#gatewayPort, GATEWAY_HEALTH_PATH, {
        OMP_AUTH_BROKER_URL: broker.url,
      });
      try {
        await this.#verifyBearerAccepted(gateway);
      } catch (err) {
        await stop(gateway);
        this.#gateway = null;
        throw err;
      }
      this.#gateway = gateway;
    }
    return { gatewayUrl: this.#gateway.url };
  }

  async #startService(
    name: ServiceName,
    configuredPort: number,
    healthPath: string,
    extraEnv: Record<string, string>,
  ): Promise<Service> {
    const port = configuredPort > 0 ? configuredPort : await freeLoopbackPort();
    const argv = [this.#ompPath, name, "serve", `--bind=${LOOPBACK}:${port}`];

    let child: AuthServiceProcess;
    try {
      child = this.#spawn(argv, { env: this.#childEnv(extraEnv) });
    } catch (err) {
      // `Bun.spawn` throws synchronously for a missing or unexecutable binary,
      // which is the ordinary "omp is not where the config says" failure.
      throw new Error(
        `omp ${name} could not be started from ${this.#ompPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const service: Service = {
      name,
      port,
      url: `http://${LOOPBACK}:${port}`,
      child,
      tail: [],
      exited: false,
      exitCode: null,
    };
    void child.exited.then(code => {
      service.exited = true;
      service.exitCode = code;
    });

    // Both streams are drained, and neither is optional. omp writes its
    // ordinary JSON log to stdout and its fatal reasons to stderr, so
    // discarding stdout would throw away the operational record and, worse,
    // eventually block the child on a full pipe. Draining continues for the
    // service's whole life; only the line length is capped.
    void this.#drain(service, child.stdout);
    void this.#drain(service, child.stderr);

    try {
      await this.#waitHealthy(service, healthPath);
    } catch (err) {
      await stop(service);
      throw err;
    }

    this.#onLog(`omp ${name} is listening on ${LOOPBACK}:${port}`);
    return service;
  }

  async #waitHealthy(service: Service, healthPath: string): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    for (;;) {
      if (service.exited) {
        const how = service.exitCode === null ? "no exit code" : `exit code ${service.exitCode}`;
        throw failure(service, `it exited (${how}) before answering GET ${healthPath}`);
      }
      if (await healthy(`${service.url}${healthPath}`)) return;
      if (Date.now() >= deadline) {
        throw failure(service, `it did not answer GET ${healthPath} within ${this.#readyTimeoutMs} ms`);
      }
      await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
    }
  }

  /**
   * Prove the gateway accepts the bearer this class will hand out.
   *
   * A gateway answering `/healthz` is not yet a gateway anything can use.
   * `/healthz` is unauthenticated, so it comes up green even when the token
   * file this daemon reads and the token file the gateway wrote are two
   * different files, and that is not a hypothetical: an earlier version of
   * this module set `PI_CONFIG_DIR` to an absolute path, omp joined it onto
   * the home directory, and the gateway happily served a health check while
   * minting its bearer somewhere nobody was reading. Nothing failed until a
   * container agent got a 401 with no explanation attached.
   *
   * One authenticated call closes that gap, and `/v1/models` is the right one:
   * it is a read, it costs no provider quota, and answering it at all means
   * the bearer was accepted, the broker was reachable, and the vault opened.
   * The model count is worth a log line because "accepted the bearer, offers
   * zero models" is a different problem from "rejected the bearer", and an
   * operator staring at a container agent that will not answer needs to know
   * which one they have.
   */
  async #verifyBearerAccepted(service: Service): Promise<void> {
    const bearer = await this.gatewayBearer();

    let response: Response;
    try {
      response = await fetch(`${service.url}/v1/models`, {
        headers: { Authorization: `Bearer ${bearer}` },
        // The readiness budget, not the per-probe one. This is a real request
        // against a freshly booted gateway holding a snapshot of every
        // credential on the machine, and failing it spuriously would refuse a
        // container the operator can perfectly well have.
        signal: AbortSignal.timeout(this.#readyTimeoutMs),
      });
    } catch (err) {
      throw failure(service, `GET /v1/models failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const catalogue: unknown = await response.json().catch(() => null);
    if (response.status === 401 || response.status === 403) {
      throw failure(
        service,
        `it rejected the bearer read from ${join(this.#configDir, GATEWAY_TOKEN_FILE)} (HTTP ${response.status}), ` +
          "so that is not the file it wrote its own token to; check configDir against the config dir omp resolves",
      );
    }
    if (!response.ok) throw failure(service, `it answered HTTP ${response.status} for GET /v1/models`);

    const models =
      typeof catalogue === "object" && catalogue !== null && "data" in catalogue && Array.isArray(catalogue.data)
        ? catalogue.data.length
        : 0;
    this.#onLog(`omp ${service.name} accepted its bearer and offers ${models} models`);
  }

  /**
   * The environment both children run in.
   *
   * The absent variable is the point of the whole arrangement rather than an
   * oversight. omp resolves the broker bearer as `OMP_AUTH_BROKER_TOKEN`, then
   * `auth.broker.token` from config.yml, then `<config-dir>/auth-broker.token`,
   * so leaving the variable unset is what makes the gateway open the 0600
   * token file itself, in its own process. Setting it would put a live
   * credential in an environment block that shows up in `ps -E`, in a crash
   * dump, and in anything that logs a child's spawn. It is explicitly unset
   * rather than merely omitted, because this daemon may have inherited one
   * naming somebody else's broker.
   *
   * `OMP_AUTH_BROKER_URL` is unset for the same reason and set explicitly for
   * the gateway. It is a url and not a secret, but an inherited one would let
   * an ambient environment variable decide which vault a container agent's
   * credentials come out of.
   *
   * `PI_CONFIG_DIR` is deliberately left alone, which took one measured
   * mistake to learn. omp joins that variable onto the home directory rather
   * than resolving it, so setting it to an absolute `configDir` puts the
   * children's token files under `$HOME/Users/...` and nothing says so. It is
   * also the wrong instrument: the children must resolve the operator's own
   * config, profile and vault exactly as every other omp invocation on this
   * machine does, because opening that vault is the entire job. `configDir`
   * therefore names where the token files are expected to be, and
   * `#verifyBearerAccepted` is what catches it being wrong.
   */
  #childEnv(extra: Record<string, string>): Record<string, string | undefined> {
    return {
      ...process.env,
      // No `PI_CONFIG_DIR`. See above.
      OMP_AUTH_BROKER_TOKEN: undefined,
      OMP_AUTH_BROKER_URL: undefined,
      ...extra,
    };
  }

  /** Read one stream as lines, scrub each one, keep a tail, and forward it. */
  async #drain(service: Service, stream: ReadableStream<Uint8Array> | null): Promise<void> {
    if (stream === null) return;
    const decoder = new TextDecoder();
    let buffered = "";
    const emit = (raw: string): void => {
      const line = scrub(raw, this.#known);
      if (line.length === 0) return;
      service.tail.push(line);
      if (service.tail.length > FAILURE_TAIL_LINES) service.tail.shift();
      this.#onLog(`omp ${service.name}: ${line}`);
    };
    try {
      for await (const chunk of stream) {
        buffered += decoder.decode(chunk, { stream: true });
        const parts = buffered.split("\n");
        buffered = parts.pop() ?? "";
        for (const part of parts) emit(part);
      }
    } catch {
      // The child went away mid-read. Its exit is reported by whoever is
      // waiting on it, and a partial line adds nothing to that.
    }
    if (buffered.length > 0) emit(buffered);
  }

  /**
   * Add one value to the set `scrub` matches exactly.
   *
   * Insertion order is the eviction order, which is why this is a `Set`: the
   * oldest known secret is the one least likely to still appear in a line a
   * child is about to write.
   */
  #remember(secret: string): void {
    if (secret.length < MIN_KNOWN_SECRET_CHARS) return;
    if (this.#known.has(secret)) return;
    this.#known.add(secret);
    while (this.#known.size > MAX_KNOWN_SECRETS) {
      const oldest = this.#known.values().next();
      if (oldest.done === true) return;
      this.#known.delete(oldest.value);
    }
  }
}

const defaultSpawn: SpawnLike = (argv, options) =>
  Bun.spawn(argv, {
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env,
  });

/**
 * Ask the kernel for a loopback port nobody is using, then hand it straight
 * back so the child can take it.
 *
 * There is a window between the close and the child's own bind where something
 * else on the machine could claim the port. That race is accepted deliberately.
 * The alternative is a fixed port, which turns two ompd daemons, or one daemon
 * and an operator's own `omp auth-broker serve`, into a permanent collision
 * instead of a rare one. When the race is lost the child exits with an
 * address-in-use error, and the readiness wait reports it with the service and
 * the port named, which is enough to see what happened and try again.
 */
async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, LOOPBACK, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error(`could not read a loopback port from a listener on ${LOOPBACK}:0`)));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * One health probe.
 *
 * Both services answer `{"ok":true,"version":"18.0.4"}` on their unauthenticated
 * endpoint. Reading the flag rather than stopping at the 200 means a service
 * that is listening but reporting itself unhealthy cannot be mistaken for
 * ready. If a future omp stops answering that flag this times out instead,
 * with the path named, which is a visible failure rather than a silent one.
 */
async function healthy(url: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) });
  } catch {
    // Nothing listening yet, or not answering. Both mean "not ready".
    return false;
  }
  // Drained before the status is read, so a refusal does not leave a half-read
  // response holding a socket open for the rest of the poll loop.
  let body: string;
  try {
    body = await response.text();
  } catch {
    return false;
  }
  if (!response.ok) return false;
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && "ok" in parsed && parsed.ok === true;
  } catch {
    return false;
  }
}

/**
 * SIGTERM, then SIGKILL if it is ignored. Safe on a service already gone.
 *
 * The broker is the canonical writer of the operator's credential vault, so it
 * gets a real chance to close SQLite cleanly before anything harsher. Measured:
 * both services honour SIGTERM and exit 143 immediately.
 */
async function stop(service: Service | null): Promise<void> {
  if (service === null || service.exited) return;

  try {
    service.child.kill(SIGTERM);
  } catch {
    // Already gone. Nothing to stop.
    return;
  }

  const grace = Promise.withResolvers<"grace">();
  const timer = setTimeout(() => grace.resolve("grace"), CLOSE_GRACE_MS);
  const outcome = await Promise.race([service.child.exited.then(() => "exited" as const), grace.promise]);
  clearTimeout(timer);
  if (outcome === "exited") return;

  try {
    service.child.kill(SIGKILL);
  } catch {
    // It exited in the gap between the race and this call.
  }
  await service.child.exited;
}

/**
 * A start failure, phrased for the operator who has just been told a container
 * agent could not be provisioned.
 *
 * It names the service, the port it was told to bind, what went wrong, and the
 * most useful thing the child itself said, because "the gateway did not become
 * ready" on its own does not distinguish a port collision from a missing broker
 * url from a vault omp cannot open.
 */
function failure(service: Service, reason: string): Error {
  const said = lastMeaningful(service.tail);
  const suffix = said === undefined ? "" : ` (${said})`;
  return new Error(`omp ${service.name} on ${LOOPBACK}:${service.port} did not become ready: ${reason}${suffix}`);
}

/**
 * The line worth quoting out of a child's tail.
 *
 * Bun prints a fatal error as a source excerpt followed by an `error:` line, so
 * the last `error:` line is the actual reason and everything around it is the
 * bundle's own source. Falling back to the last line covers a child that died
 * without one.
 */
function lastMeaningful(tail: readonly string[]): string | undefined {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i];
    if (line !== undefined && /^error\b/i.test(line)) return line;
  }
  return tail.at(-1);
}

/**
 * Remove what is, or looks like, a secret from a child's line, then cap it.
 *
 * Two layers, and they are not equally strong. Saying which is which is the
 * point of this comment, because an earlier version of it claimed an absolute
 * that regexes over another process's output cannot deliver.
 *
 * The first layer is exact. Every secret this module has read is removed by
 * identity, so it does not matter what alphabet the value uses, whether it is
 * quoted, or whether it sits behind a field name anybody anticipated. What it
 * does depend on is having been read first, which is why `#start` reads the
 * gateway's bearer before either child is spawned.
 *
 * The second layer is patterns, and a pattern cannot establish an invariant. It
 * catches `Authorization: Bearer <...>`, the `token=<...>` family, a JWT, an
 * opaque token carrying separators, and any long unbroken base64url run, and it
 * leans hard towards over-redacting: a line that lost a commit hash costs
 * nothing, a line that carried a bearer costs the whole boundary. It is still
 * best-effort. A credential in a shape none of these recognise, written by a
 * child before this module has read that value, reaches `#onLog` and the failure
 * tail as the child wrote it. Nothing in a regex over the output of a process
 * whose version nobody here pins changes that, and a comment claiming otherwise
 * would be worse than the gap, because it would stop anyone looking for it.
 *
 * So the guarantee worth leaning on is not this one. The guest's bearer is
 * minted by `ModelBroker`, written to exactly one 0600 file, and never
 * interpolated into a line by anything in this daemon; the gateway's bearer is
 * returned by `gatewayBearer` and written nowhere. Neither depends on this
 * function. What this function is for is defence in depth over a child nobody
 * here controls: measured against omp 18.0.4 the broker announces the path its
 * bearer came from and not the bearer, and this is what stands between that
 * changing in some later version and a credential in the daemon log.
 */
function scrub(raw: string, known: Iterable<string>): string {
  let text = raw.trimEnd();
  // Exact first, so a known credential is gone before a pattern can half-match
  // it and leave a recognisable fragment of it behind.
  for (const secret of known) {
    if (text.includes(secret)) text = text.split(secret).join(REDACTED);
  }

  const redacted = text
    // `Authorization: Bearer <token>`, in any casing. The length floor is what
    // keeps this off English: the broker logs the sentence "auth-broker bearer
    // token loaded", and redacting the word "token" out of the one line that
    // says where its credential came from would cost the most useful
    // diagnostic on the whole path to protect nothing.
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, `bearer ${REDACTED}`)
    // `token=<value>`, `"secret":"<value>"`, `--api-key <value>`, and the rest
    // of that family, quoted or not.
    .replace(
      /([A-Za-z0-9_-]*(?:token|secret|password|api[-_]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      `$1${REDACTED}`,
    )
    // A JWT: three base64url segments joined by dots, the first starting `ey`
    // because that is what a `{"` header base64s to. Called out separately from
    // the rule below because a short one -- three ten-character segments, which
    // is a perfectly ordinary signed handle -- clears neither that rule's total
    // nor its per-run floor, and clears no other rule here either.
    .replace(/ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED)
    // An opaque token carrying separators: `ya29.a0AfB1...`, a padded base64
    // value, anything of that shape. This is the gap a review named, and it is
    // a real one: every separator ends the run the rule below is measuring, so
    // a dotted OAuth token with no `Bearer` in front of it and no
    // credential-like field name behind it matched none of the three rules this
    // function used to have.
    .replace(SEGMENTED_RUN, match => (opaque(match) ? REDACTED : match))
    // Whatever is left that simply looks like a credential: an unbroken run of
    // base64url characters at least as long as omp's own 43-character bearer.
    .replace(/[A-Za-z0-9_-]{32,}/g, REDACTED);
  return redacted.length > MAX_LOG_LINE_CHARS ? redacted.slice(0, MAX_LOG_LINE_CHARS) : redacted;
}

/** Runs of base64url characters joined by the separators real tokens use. Deciding is `opaque`. */
const SEGMENTED_RUN = /[A-Za-z0-9_-]+(?:[.+/=~][A-Za-z0-9_-]+)+/g;
const SEGMENT_SEPARATOR = /[.+/=~]/;

/** Total width and longest-run floors a separated run has to clear to be treated as a credential. */
const SEGMENTED_MIN_CHARS = 32;
const SEGMENT_MIN_RUN_CHARS = 16;

/**
 * Whether a separated run is a credential rather than a path, a url, a version
 * or a dotted identifier.
 *
 * Both floors are load-bearing. Total width alone would redact
 * `/Users/jwaldrip/dev/src/github.com/jwaldrip/ompctl`, fifty characters of
 * exactly this shape and the single most useful thing a child can say about
 * where it looked for something. The longest-run floor is what separates them:
 * a path is many short segments, an opaque credential has at least one long
 * high-entropy one. `ya29.a0AfB1...` clears both floors; that path's longest
 * segment is eight characters and clears neither.
 */
function opaque(candidate: string): boolean {
  if (candidate.length < SEGMENTED_MIN_CHARS) return false;
  let longest = 0;
  for (const run of candidate.split(SEGMENT_SEPARATOR)) longest = Math.max(longest, run.length);
  return longest >= SEGMENT_MIN_RUN_CHARS;
}
