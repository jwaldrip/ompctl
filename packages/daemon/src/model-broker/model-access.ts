/**
 * The daemon's implementation of the provisioner's model-access seam.
 *
 * `ompd new <dir> --container` used to reach `idle` and then fail every prompt
 * with "No model selected", because the guest had no provider credential and no
 * selected model. This class is what closes that gap, and the shape of it is
 * dictated by one measured fact: a container agent has full unrestricted
 * internet egress and Apple `container` rejects `--cap-drop`, so any credential
 * that reaches the guest can be read out of its filesystem and used from
 * anywhere, forever. Injection is therefore off the table. The guest gets a
 * scoped bearer for one model on a broker the daemon owns, and the real
 * credential never leaves the host's loopback.
 *
 * Three services in a line: this class holds `OmpAuthServices` (omp's own
 * `auth-broker` plus `auth-gateway`, both bound to `127.0.0.1`) and one
 * `ModelBroker` per container network, bound to that network's gateway address.
 * The guest talks to the broker; the broker forwards to the gateway; the gateway
 * resolves the operator's existing credential. Nothing from `~/.omp` is copied
 * or mounted anywhere near a guest.
 *
 * The rule that shapes every failure path below: this class NEVER degrades
 * quietly. Every unusable configuration throws, and every message names the
 * config key or the file an operator has to change. Returning `null` from
 * `grant` would satisfy the interface and produce a container that provisions,
 * reaches `idle`, and cannot answer a single prompt, which is precisely the
 * defect this whole seam exists to remove. There is no fake model, no local
 * fallback, and no invented default anywhere in here.
 *
 * One broker per container network, not one per daemon: `ModelBroker` commits to
 * a single address for its lifetime, because a wildcard bind was measured
 * reachable from every container network on the host and from the host's LAN.
 * Two containers on one network share a broker; a container on a second network
 * gets its own, on its own gateway address.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import type { GuestModelAccess } from "../provisioner/guest-config.ts";
import type { GuestBridge, ModelAccessProvider } from "../provisioner/types.ts";
import { ModelBroker, type ModelGrantLimits } from "./broker.ts";
import { addressInIpv4Cidr, normalizeIpv4 } from "./cidr.ts";
import { OmpAuthServices } from "./omp-auth-services.ts";

/** The daemon config keys an operator changes, named verbatim in every failure. */
const ENABLED_KEY = "containerModelAccess";
const MODEL_KEY = "containerModel";

/** Where the host's own model choice lives, relative to the omp config dir. */
const HOST_CONFIG_RELATIVE = join("agent", "config.yml");

/**
 * Ceilings, not a billing policy.
 *
 * Real spend is attributed host-side, against the credential `auth-gateway`
 * resolved, and these numbers buy nothing there. What they buy is a bound on a
 * runaway loop: an agent that has lost the plot, or a bearer that has been
 * lifted out of a guest, spends this much and then gets a 402 instead of
 * spending the operator's quota until somebody notices. They are set high
 * enough that a working session never meets one, because a ceiling a real
 * session hits is indistinguishable from the broker being broken.
 */
const DEFAULT_MAX_REQUESTS = 2_000;
const DEFAULT_MAX_TOKENS = 5_000_000;
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * A day. Long enough that a container left running overnight still answers in
 * the morning, short enough that a bearer taken off this machine is worthless
 * within one.
 */
const DEFAULT_GRANT_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * A trailing thinking level on a model reference, as in
 * `anthropic/claude-opus-5:high`.
 *
 * The level is omp's own per-role setting and is not part of any model id. The
 * gateway matches the top-level `model` field against its bundled catalog, and
 * every one of the 189 ids that catalog returned on this host is plain
 * `provider/model` with no colon, so a reference carrying `:high` matches
 * nothing and the container fails every prompt. Bounded to one trailing segment
 * containing neither a colon nor a slash, so it strips a level and never eats
 * part of a provider or model name.
 */
const THINKING_LEVEL = /:[^:/]+$/;

/**
 * The two lifecycle events this class records.
 *
 * Narrow on purpose. The daemon's audit trail takes a closed union, so a literal
 * type here means the compiler enforces what would otherwise be a promise in a
 * comment, and the wiring on the other side is a pass-through with no runtime
 * guard.
 */
export type ModelAccessAuditAction = "model.grant" | "model.revoke";

/**
 * One audit row.
 *
 * `detail` carries the model id, the container network, and on a failure the
 * reason. It NEVER carries the granted bearer, the gateway's bearer, or any
 * other credential: the only place the granted token is ever written is the
 * guest's own 0600 token file, and nothing in this file interpolates it into a
 * string.
 */
export interface ModelAccessAuditRow {
  action: ModelAccessAuditAction;
  outcome: "ok" | "error";
  detail: Record<string, unknown>;
}

/** What `ompd doctor` can ask without provisioning anything. */
export interface ModelAccessStatus {
  enabled: boolean;
  model: string | null;
  gatewayUrl: string | null;
  liveGrants: number;
}

export interface DaemonModelAccessOptions {
  /** Resolved omp binary, from daemon config. Argv[0] for both loopback services. */
  ompPath: string;
  /** omp config dir, normally `${homedir()}/.omp`. Read from, never copied. */
  configDir: string;
  /** The port a broker binds on a container network's gateway address. */
  brokerPort: number;
  /** A provider-qualified model id, or `""` to resolve the host's own default. */
  model: string;
  /** Daemon config `containerModelAccess`. */
  enabled: boolean;
  /** Overrides for the ceilings above. Absent members keep the default. */
  limits?: Partial<ModelGrantLimits>;
  grantTtlMs?: number;
  /** MUST never receive a token. */
  onLog?: (line: string) => void;
  /** MUST never receive a token. */
  onAudit?: (row: ModelAccessAuditRow) => void;
  /** Injectable for tests. */
  services?: OmpAuthServices;
  /** Injectable for tests. Satisfies the first container network only. */
  broker?: ModelBroker;
}

/** What this class retains about a live grant. Deliberately not the token. */
interface Issued {
  model: string;
  /** `host:port` of the broker holding it, so a release goes to exactly one. */
  address: string;
}

export class DaemonModelAccess implements ModelAccessProvider {
  readonly #configDir: string;
  readonly #brokerPort: number;
  readonly #model: string;
  readonly #enabled: boolean;
  readonly #limits: Partial<ModelGrantLimits>;
  readonly #grantTtlMs: number | undefined;
  readonly #onLog: (line: string) => void;
  readonly #onAudit: (row: ModelAccessAuditRow) => void;
  readonly #services: OmpAuthServices;

  /** Consumed by the first container network that needs a broker. */
  #spare: ModelBroker | undefined;
  /** Keyed by `host:port`. One entry per container network. */
  readonly #brokers = new Map<string, ModelBroker>();
  /** Addresses whose bind has completed, so a second container does not re-bind. */
  readonly #bound = new Set<string>();

  /**
   * Live grants, keyed by the SHA-256 of the token in hex.
   *
   * The digest rather than the token, for the same reason `ModelBroker` stores a
   * digest: a plaintext bearer retained for the container's whole life is a
   * credential sitting in the daemon's heap for no reason. The digest is enough
   * to name the right broker and the right model on release, which is all this
   * map is for.
   */
  readonly #issued = new Map<string, Issued>();

  /**
   * The gateway url from the most recent `ensure`, read live by every broker.
   *
   * A field rather than a captured value because `OmpAuthServices.ensure`
   * restarts a dead child on a fresh port. A broker holding the url it was
   * constructed with would go on forwarding to a port nothing is listening on,
   * and the guest would see a 502 on every prompt for the rest of the
   * container's life.
   */
  #gatewayUrl = "";

  /** The last model actually resolved, so `status` can answer without I/O. */
  #resolvedModel: string | null = null;

  constructor(opts: DaemonModelAccessOptions) {
    this.#configDir = opts.configDir;
    this.#brokerPort = opts.brokerPort;
    this.#model = opts.model;
    this.#enabled = opts.enabled;
    this.#limits = opts.limits ?? {};
    this.#grantTtlMs = opts.grantTtlMs;
    this.#onLog = opts.onLog ?? (() => {});
    this.#onAudit = opts.onAudit ?? (() => {});
    this.#spare = opts.broker;
    this.#services =
      opts.services ??
      new OmpAuthServices({
        ompPath: opts.ompPath,
        // The omp config dir is passed so the token files can be READ. It is
        // deliberately not turned into a `PI_CONFIG_DIR` override for the
        // children: omp joins that variable onto the home directory rather than
        // resolving it, which sent the children's token files to a doubled path
        // and produced a health check that passed over a gateway answering 401.
        configDir: opts.configDir,
        onLog: line => {
          this.#onLog(line);
        },
      });
  }

  /**
   * Mint access for a container that does not exist yet.
   *
   * Called after the network exists and before `container run`, which is the
   * only window in which it can be called: the guest's config has to name an
   * endpoint and carry a bearer before the container starts, and on the
   * `host-bridge` shape that endpoint cannot be bound until it has. Hence the
   * split with `activate`.
   *
   * The runtime layer has already decided which of three shapes applies and
   * says so in `bridge`. Nothing here sniffs the runtime: a discriminated union
   * arriving from the one place that ran `network inspect` is the difference
   * between "this runtime has no host-reachable bridge" and "we did not
   * recognise this runtime's inspect output", and those two want opposite
   * answers.
   */
  async grant(input: { network: string | null; bridge: GuestBridge }): Promise<GuestModelAccess> {
    const { network, bridge } = input;

    if (!this.#enabled) {
      // Not `null`. `null` is a legal answer to this interface and it would end
      // the provision, but it would end it with "not configured" rather than
      // with something an operator can act on. A container agent that cannot
      // reach a model is useless, so being switched off is a hard refusal with
      // the key to flip, not a shrug.
      this.#fail("model.grant", { model: this.#configuredModel(), network }, [
        `container model access is disabled, so a container agent would provision with no model and fail every`,
        `prompt. Set \`${ENABLED_KEY}\` to true in the daemon config, or create this agent without --container.`,
      ]);
    }

    if (bridge.kind === "unsupported") {
      // Verbatim, and deliberately not wrapped in a sentence of my own. The
      // runtime layer is the only thing that knows which runtime it asked, what
      // it ran, and what came back, and it has already written that for an
      // operator. Composing a second message around it would bury the part that
      // says what to do. Failing closed here is the whole point: a runtime with
      // no host-reachable address must refuse the provision, never provision a
      // container that silently has no model.
      this.#fail("model.grant", { model: this.#configuredModel(), network }, [bridge.reason]);
    }

    const plan = this.#planFor(bridge, network);
    const model = await this.#resolveModel(network);
    const address = `${plan.bindHost}:${this.#brokerPort}`;

    let gatewayUrl: string;
    try {
      gatewayUrl = (await this.#services.ensure()).gatewayUrl;
    } catch (err) {
      // The reason is relayed because `OmpAuthServices` scrubs its children's
      // output before it reaches a message, precisely so its failures can be
      // surfaced. Anything added upstream has to keep that property.
      this.#fail("model.grant", { model, network }, [
        `the loopback omp auth services a container's model access depends on would not start: ${reasonOf(err)}`,
      ]);
    }
    this.#gatewayUrl = gatewayUrl;

    const broker = this.#brokerFor(address);
    // Started here and awaited in `activate`. On the `host-bridge` shape the
    // bind cannot succeed yet -- the gateway address is not assigned to any
    // interface on the host until a container is attached to the network -- but
    // calling `listen` now records the address, which is what lets `issue`
    // below run at all. The rejection is swallowed rather than left floating:
    // `activate` awaits the same bind and is where a failure belongs, and
    // `ModelBroker` marks only its retry promise handled, not the immediate
    // refusal it gives for an address it is already committed to.
    broker.listen({ host: plan.bindHost, port: this.#brokerPort }).catch(() => {});

    let token: string;
    try {
      token = broker.issue({
        model,
        peerCidr: plan.peerCidr,
        limits: {
          maxRequests: this.#limits.maxRequests ?? DEFAULT_MAX_REQUESTS,
          maxTokens: this.#limits.maxTokens ?? DEFAULT_MAX_TOKENS,
          maxConcurrent: this.#limits.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        },
        ttlMs: this.#grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
      }).token;
    } catch (err) {
      // `issue` refuses before it mints. Every check it makes happens before the
      // token is generated, and the insertion into its own grant map is the last
      // statement it runs, after the log line, so a throw from anywhere in it --
      // an input it rejected or a log sink that failed -- leaves nothing live.
      // Its messages name the input that was wrong and never the token.
      this.#fail("model.grant", { model, network }, [`the model broker refused to mint a grant: ${reasonOf(err)}`]);
    }

    // Built here, from the plan, and deliberately NOT taken from the
    // `ModelGrant` that `issue` returned.
    //
    // This is the single most likely bug in this file, and the `host-alias`
    // shape makes it worse rather than better: there the address the broker
    // binds and the address the guest must dial are different strings on
    // purpose, so the grant's own endpoint is not merely stale, it is wrong by
    // construction. `issue` computes its endpoint from the bound address, and
    // reading it back would hand a Docker Desktop guest `http://127.0.0.1:<port>`
    // -- its own loopback, inside the container, where nothing is listening.
    const endpoint = `http://${plan.guestHost}:${this.#brokerPort}`;

    // Recorded, then announced, and the whole announcement is unwound if it
    // throws.
    //
    // Everything from here to the return is bookkeeping over a bearer that
    // already exists, and `issue` has no way to know it minted one for a caller
    // that never received it. So a throw anywhere in this block leaves a live
    // credential the provisioner never saw, cannot release, and which nothing
    // withdraws until its TTL expires a day later. Both sinks belong to this
    // daemon, which makes a throw here a defect in its own wiring rather than
    // anything a container can cause, but "a credential nobody can revoke" is
    // not a consequence a defect gets to have.
    const digest = createHash("sha256").update(token).digest("hex");
    this.#issued.set(digest, { model, address });
    try {
      this.#onAudit({ action: "model.grant", outcome: "ok", detail: { model, network, bridge: bridge.kind } });
      this.#log(`granted ${model} to container network ${network ?? "(unnamed)"} on ${endpoint}`);
      if (plan.peerCidr === null) {
        // Said out loud, every time, because it is the one confinement property
        // this daemon knowingly gives up. See `#planFor` for the residual risk
        // it leaves and what is left holding the line.
        this.#log(
          `the peer-address check is OFF for this grant: the ${bridge.kind} shape NATs every request, so the ` +
            `broker cannot tell one caller on ${plan.bindHost} from another. The bearer, the single allowlisted ` +
            `model and the request, token, body and concurrency ceilings are what confine it.`,
        );
      }
    } catch (err) {
      this.#unwind(digest, token, address);
      // Thrown directly rather than through `#fail`: `#fail` records a refusal
      // through the sink that has just failed, which would replace this reason
      // with that one and lose the only account of what happened.
      throw new Error(
        `the model grant for ${model} on ${address} was minted and then withdrawn, because recording it failed: ` +
          `${reasonOf(err)}. The audit and log sinks are this daemon's own, so that is a defect in its wiring and ` +
          `not something a container did. The grant is undone rather than kept, because a token this daemon minted ` +
          `and never returned is a live credential nothing can release.`,
      );
    }

    return { endpoint, token, model };
  }

  /**
   * Undo a grant that was minted and never handed over.
   *
   * Revoking it is the whole job, and it cannot fail to take. `#brokerFor` wires
   * the broker's log sink through a wrapper that swallows, so the sink that just
   * threw cannot throw again from inside `revoke`; and `ModelBroker.revoke`
   * drops the digest from its own map before it logs anything, so the credential
   * is dead even if some future version of it throws for a reason this file does
   * not own. The `catch` is for that second case, and the error worth reporting
   * is the first one either way.
   *
   * The listener is deliberately left up. A broker holding no grants answers 401
   * to everything, the address stays in `#brokers` exactly as it does when
   * `issue` itself refuses, and `release` and `close` stay the only two places
   * that take a listener down. That last part matters here: `grant` starts the
   * bind and does not await it, so closing the socket from inside a failing
   * grant would race an in-flight retry for no gain.
   */
  #unwind(digest: string, token: string, address: string): void {
    this.#issued.delete(digest);
    try {
      this.#brokers.get(address)?.revoke(token);
    } catch {
      // The log sink is what failed. The grant was gone before it was called.
    }
  }

  /**
   * Bind the endpoint the guest was already handed, now that the container is up.
   *
   * Binding waits until here for a measured reason rather than a cautious one:
   * on the `host-bridge` shape, `network inspect` reports a network's gateway
   * address immediately after the network is created, but that address is not
   * assigned to any interface on the host until a container is actually running
   * on the network, and `bind()` fails `EADDRNOTAVAIL` until then. Since the
   * guest's config has to name the endpoint before the container exists, the
   * only possible order is grant, run, bind.
   *
   * The `host-alias` shape binds loopback, which is always available, so its
   * bind has usually already succeeded in `grant`. It still comes through here,
   * because a caller that skipped it for one shape and not the other is a
   * caller that will eventually skip the one that matters.
   *
   * Idempotent per bind address. A second container on the same network, or any
   * number of Docker Desktop containers sharing loopback, find the address
   * already bound and do nothing; a container on a different host bridge has a
   * different gateway, so it gets its own broker and its own bind.
   */
  async activate(input: { bridge: GuestBridge }): Promise<void> {
    if (!this.#enabled) return;

    if (input.bridge.kind === "unsupported") {
      // Unreachable through the provisioner, which fails the provision on the
      // refusal `grant` already gave for this bridge. Reached only by a caller
      // that ignored that failure, and binding on its behalf would put a
      // listener up for a container that was never provisioned.
      throw new Error(
        `the container runtime has no host-reachable bridge, so there is nothing to bind: ${input.bridge.reason}`,
      );
    }

    const plan = this.#planFor(input.bridge, null);
    const address = `${plan.bindHost}:${this.#brokerPort}`;
    if (this.#bound.has(address)) return;

    const broker = this.#brokers.get(address);
    if (broker === undefined) {
      // Nothing granted on this address, so there is no broker and no grant for
      // one to serve. Binding a listener here would open a port that forwards on
      // behalf of nobody, which is worse than failing.
      throw new Error(
        `no model grant was issued for ${address}, so there is nothing to bind there: \`activate\` must follow a ` +
          `successful \`grant\` for the same bridge`,
      );
    }

    // Joins the bind `grant` started rather than beginning a second one, and if
    // that first attempt already exhausted its retries while the container was
    // still starting, starts a fresh one now that the address exists.
    await broker.listen({ host: plan.bindHost, port: this.#brokerPort });
    this.#bound.add(address);
    this.#log(`model broker is listening on ${address} for guests dialling ${plan.guestHost}`);
  }

  /**
   * Withdraw one grant.
   *
   * Never throws. This runs on every teardown path there is, including the ones
   * already unwinding a failure, and a throw here would turn a container that
   * would not start into a container that will not go away. A token this daemon
   * does not hold is not an error: a daemon restart drops every broker and every
   * grant with it, so a later release of a token minted by the previous process
   * has nothing left to revoke and nothing left to leak.
   */
  async release(input: { token: string }): Promise<void> {
    const key = createHash("sha256").update(input.token).digest("hex");
    const issued = this.#issued.get(key);
    this.#issued.delete(key);

    if (issued === undefined) {
      this.#onAudit({ action: "model.revoke", outcome: "ok", detail: { model: null } });
      this.#log("released a model grant this daemon does not hold; nothing to revoke");
      return;
    }

    // The listener stays up while any grant on this address is still live, and
    // comes down with the last one.
    //
    // Keeping it up matters while a sibling container on the same network still
    // holds a grant: revocation has to be observable as a 401 from a live
    // broker, and a closed listener answers connection-refused, which proves
    // nothing about whether the credential still works.
    //
    // Keeping it up past the last grant does not. Measured: when the last
    // container on a network goes, the runtime tears the bridge down and the
    // gateway address stops existing on the host, so the socket is bound to an
    // address nothing can route to. It answers nobody, it proves nothing, and
    // it is one leaked listener per container network for the life of the
    // daemon. Dropping it from `#bound` too, so the next container that lands
    // on a freshly created network with the same gateway address can bind.
    const broker = this.#brokers.get(issued.address);
    broker?.revoke(input.token);
    this.#onAudit({ action: "model.revoke", outcome: "ok", detail: { model: issued.model } });
    this.#log(`revoked the model grant for ${issued.model} on ${issued.address}`);

    if (broker !== undefined && broker.liveGrants() === 0) {
      this.#brokers.delete(issued.address);
      this.#bound.delete(issued.address);
      await broker.close();
      this.#log(`closed the model broker on ${issued.address}: no grants left`);
    }
  }

  /**
   * Withdraw everything and stop serving. Safe to call twice, and safe on an
   * instance that never granted anything.
   *
   * Not a poison pill: the services underneath restart on a later `ensure`, and
   * a broker map that has been emptied refills. A daemon that closed these on a
   * host release must still be able to provision the next container.
   */
  async close(): Promise<void> {
    const brokers = [...this.#brokers.values()];
    this.#brokers.clear();
    this.#bound.clear();
    this.#issued.clear();
    this.#spare = undefined;

    for (const broker of brokers) {
      // `revokeAll` before `close`, because `close` deliberately leaves grants
      // alone: it stops the listener, and a grant left live behind a stopped
      // listener would come back with the broker if one were ever reattached.
      broker.revokeAll();
      await broker.close();
    }
    await this.#services.close();
    this.#gatewayUrl = "";
    if (brokers.length > 0) this.#log(`closed ${brokers.length} model broker${brokers.length === 1 ? "" : "s"}`);
  }

  /**
   * What `ompd doctor` reports. Field reads only: no I/O, no spawn, no throw, so
   * it is safe to call on a daemon whose model access has never been used or has
   * already failed.
   */
  status(): ModelAccessStatus {
    let liveGrants = 0;
    for (const broker of this.#brokers.values()) liveGrants += broker.liveGrants();
    return {
      enabled: this.#enabled,
      model: this.#configuredModel() ?? this.#resolvedModel,
      gatewayUrl: this.#services.status().gatewayUrl,
      liveGrants,
    };
  }

  /**
   * The three addresses a bridge shape decides: where the broker binds, what the
   * guest dials, and which peers may speak to it.
   *
   * On `host-bridge` all three come from the network itself. The bind address
   * and the guest's address are the same string -- the container network's own
   * gateway -- and peers arrive un-NAT'd, so the broker can and does refuse
   * anything outside that network's subnet. That is the strong shape and it is
   * the default on darwin.
   *
   * On `host-alias` they diverge, and one of them is given up.
   *
   * Docker Desktop runs its bridge inside a Linux VM, so the gateway is not an
   * address on this host and cannot be bound. The broker binds loopback and the
   * guest dials `host.docker.internal`, which Desktop forwards to it. Because
   * that forward is a NAT, every request arrives from the host's own loopback
   * and the broker can no longer tell one caller from another. The peer check is
   * therefore off, passed through as an explicit `null` rather than as a
   * permissive range: a `0.0.0.0/0` would be indistinguishable, inside the
   * broker, from a subnet misread out of a foreign `network inspect`, and a
   * confinement property must never be lost by accident.
   *
   * NAMED RESIDUAL RISK, `host-alias` only: the broker is reachable by every
   * process and every local user on this machine, where on `host-bridge` it is
   * reachable only from containers on one network. What still holds the line is
   * the bearer -- 32 random bytes, minted per container, living only in a 0600
   * file inside a 0700 directory, never in an argv, an environment variable, a
   * log line or the store -- plus a single allowlisted model, a two-route
   * allowlist, and ceilings on requests, tokens, concurrency and body size. It
   * is revoked when the container stops and it dies with the daemon. So the
   * exposure is: a local process that can already read another user's 0600 file
   * can spend some of this host's model quota until the container goes away.
   * That is materially weaker than the bridge shape and materially stronger than
   * injecting a provider credential, which is the only alternative that makes
   * Desktop work at all.
   *
   * The bind address is validated rather than trusted. A wildcard bind was
   * measured reachable from every container network on the host AND from the
   * host's LAN, so a `bindHost` that widened past loopback would silently hand
   * one container's grant to the local network. `ModelBroker.listen` refuses a
   * wildcard too; this is the same refusal one layer earlier, where the shape
   * that chose the address can be named in the message.
   */
  #planFor(
    bridge: Extract<GuestBridge, { kind: "host-bridge" | "host-alias" }>,
    network: string | null,
  ): { bindHost: string; guestHost: string; peerCidr: string | null } {
    if (bridge.kind === "host-bridge") {
      if (!bindable(bridge.gateway)) {
        this.#fail("model.grant", { model: this.#configuredModel(), network, bridge: bridge.kind }, [
          `the container network's gateway address ${JSON.stringify(bridge.gateway)} is not an address a broker may`,
          `bind: a wildcard or empty host would be reachable from every container network on this machine and from`,
          `the local network, which would hand one container's grant to all of them.`,
        ]);
      }
      return { bindHost: bridge.gateway, guestHost: bridge.gateway, peerCidr: bridge.cidr };
    }

    if (!loopback(bridge.bindHost)) {
      this.#fail("model.grant", { model: this.#configuredModel(), network, bridge: bridge.kind }, [
        `the ${bridge.kind} shape may only bind loopback, and ${JSON.stringify(bridge.bindHost)} is not a loopback`,
        `address. On this shape the peer-address check is already unavailable, so the bind address is the only`,
        `thing narrowing who can reach the broker and it may not widen.`,
      ]);
    }
    if (!HOSTNAME.test(bridge.hostname)) {
      this.#fail("model.grant", { model: this.#configuredModel(), network, bridge: bridge.kind }, [
        `${JSON.stringify(bridge.hostname)} is not a hostname a guest can be pointed at: it goes into a URL and`,
        `into the guest's models.yml, and the guest has to resolve it. It has to be dot-separated labels of`,
        `letters and digits, with dashes allowed inside a label but not at either end, no empty label, at most`,
        `63 characters per label and 253 overall.`,
      ]);
    }
    return { bindHost: bridge.bindHost, guestHost: bridge.hostname, peerCidr: null };
  }

  /**
   * The model every grant allowlists.
   *
   * `containerModel` wins when it is set, otherwise the host's own
   * `modelRoles.default`, and there is no third option. Inventing a default here
   * would produce a container pointed at a model the operator's gateway may hold
   * no credential for, which fails at the first prompt with a message about the
   * model rather than about the missing configuration.
   */
  async #resolveModel(network: string | null): Promise<string> {
    const configured = this.#configuredModel();
    if (configured !== null) {
      this.#resolvedModel = configured;
      return configured;
    }

    const path = join(this.#configDir, HOST_CONFIG_RELATIVE);
    let text: string;
    try {
      text = await Bun.file(path).text();
    } catch (err) {
      this.#fail("model.grant", { model: null, network }, [
        `no model could be resolved for a container agent: \`${MODEL_KEY}\` is unset in the daemon config and the`,
        `host's own choice could not be read from ${path} (${reasonOf(err)}). Set \`${MODEL_KEY}\` to a`,
        `provider-qualified model id such as "anthropic/claude-haiku-4-5", or select a model in omp.`,
      ]);
    }

    let parsed: unknown;
    try {
      parsed = Bun.YAML.parse(text);
    } catch (err) {
      this.#fail("model.grant", { model: null, network }, [
        `no model could be resolved for a container agent: \`${MODEL_KEY}\` is unset in the daemon config and`,
        `${path} is not valid YAML (${reasonOf(err)}).`,
      ]);
    }

    // Narrowed a step at a time rather than asserted, because this is a file a
    // human edits: every level of it can legitimately be absent, and a wrong
    // guess about its shape here is a container that cannot answer.
    let candidate: unknown;
    if (typeof parsed === "object" && parsed !== null && "modelRoles" in parsed) {
      const roles: unknown = parsed.modelRoles;
      if (typeof roles === "object" && roles !== null && "default" in roles) candidate = roles.default;
    }
    // Only the plain string form. omp also accepts a per-role object carrying
    // fallbacks, and picking one member out of that would be guessing which of
    // several models the operator meant to give away to a container.
    if (typeof candidate !== "string" || candidate.trim() === "") {
      this.#fail("model.grant", { model: null, network }, [
        `no model could be resolved for a container agent: \`${MODEL_KEY}\` is unset in the daemon config and`,
        `\`modelRoles.default\` in ${path} is not set to a model id. Set either one; a provider-qualified id such`,
        `as "anthropic/claude-haiku-4-5" is the form the gateway matches.`,
      ]);
    }

    const model = candidate.trim().replace(THINKING_LEVEL, "");
    if (model === "") {
      this.#fail("model.grant", { model: null, network }, [
        `\`modelRoles.default\` in ${path} is only a thinking level and names no model. Set it to a`,
        `provider-qualified model id, or set \`${MODEL_KEY}\` in the daemon config.`,
      ]);
    }
    this.#resolvedModel = model;
    return model;
  }

  /** The daemon's own `containerModel`, or null when it is unset. */
  #configuredModel(): string | null {
    const configured = this.#model.trim().replace(THINKING_LEVEL, "");
    return configured === "" ? null : configured;
  }

  /**
   * The broker for one container network, created on first use.
   *
   * The injected broker, when there is one, satisfies the first network that
   * asks. A `ModelBroker` commits to one address for its lifetime, so handing
   * the same instance to a second network would only produce the refusal it is
   * designed to give.
   */
  #brokerFor(address: string): ModelBroker {
    const existing = this.#brokers.get(address);
    if (existing !== undefined) return existing;

    const spare = this.#spare;
    this.#spare = undefined;
    const broker =
      spare ??
      new ModelBroker({
        // Read live rather than captured: see `#gatewayUrl`. The broker reads
        // the bearer before it reads this on every forwarded request, so a
        // restart that moved the gateway to a new port is picked up in the same
        // request that noticed it.
        upstreamUrl: () => this.#gatewayUrl,
        upstreamBearer: async () => {
          // `ensure` before the read, so a gateway that has died since the last
          // request is restarted rather than 502-ing for the rest of the
          // container's life. It is idempotent and single-flighted, so the
          // healthy path is a field check and concurrent requests share one
          // restart.
          this.#gatewayUrl = (await this.#services.ensure()).gatewayUrl;
          return await this.#services.gatewayBearer();
        },
        // Isolated, and this is the one place in this file where swallowing is
        // the right answer rather than the lazy one.
        //
        // `ModelBroker` logs from inside `revoke`, `revokeAll`, `listen` and
        // every request path, and each of those has already changed its own
        // state by the time it writes the line: `revoke` deletes the grant and
        // then says it did. A throw carried back into the broker therefore
        // abandons an operation that has already half happened, and the one
        // that matters most here is `revoke`, because `#unwind` calls it to undo
        // a grant nothing else can withdraw. `issue` is the exception rather
        // than the rule -- it inserts into its grant map last, after its log
        // line, so a throw there mints nothing -- and that is a property of the
        // broker as it stands rather than one this file may assume of the next
        // version of it.
        //
        // There is also nowhere to report the throw. The sink that would carry
        // the report is the one that just failed. So the trade is a lost log
        // line against a lost lifecycle event, and the line is the cheaper of
        // the two by a wide margin. A broken sink is still loud: the direct
        // `#log` calls in `grant` are not wrapped, and they turn it into a
        // refusal that names it.
        onLog: line => {
          try {
            this.#log(line);
          } catch {
            // Deliberately dropped. See above.
          }
        },
      });
    this.#brokers.set(address, broker);
    return broker;
  }

  /**
   * Record a refusal and throw it.
   *
   * One place, so the audit row and the operator's error can never drift apart,
   * and so the invariant that matters is checkable by reading one function: the
   * only strings that reach `detail.reason` are the ones assembled at the call
   * sites above. Every one of them is either written here or relayed from
   * `ModelBroker` or `OmpAuthServices`, both of which are contractually
   * token-free in their own messages. No token is interpolated into a log line,
   * an audit row, or an error anywhere in this file.
   *
   * `lines` rather than one string only so the call sites can wrap inside the
   * line-width limit without embedding the wrapping in the message.
   */
  #fail(action: ModelAccessAuditAction, detail: Record<string, unknown>, lines: readonly string[]): never {
    const reason = lines.join(" ");
    this.#onAudit({ action, outcome: "error", detail: { ...detail, reason } });
    this.#log(reason);
    throw new Error(reason);
  }

  #log(line: string): void {
    this.#onLog(`model access: ${line}`);
  }
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every spelling of "bind everything" this daemon refuses.
 *
 * Written out rather than pattern-matched because the set is small, closed, and
 * exactly the thing a reader wants to see enumerated. The IPv6 forms matter as
 * much as `0.0.0.0`: on a dual-stack host a `::` bind accepts IPv4 too, so
 * refusing only the quad would leave the wide bind one spelling away.
 */
const WILDCARD_HOSTS: Record<string, true> = {
  "0.0.0.0": true,
  "::": true,
  "::0": true,
  "[::]": true,
  "0:0:0:0:0:0:0:0": true,
  "*": true,
};

/** IPv4 loopback. `::1` is handled separately; there is no CIDR arithmetic for it here. */
const LOOPBACK_V4 = "127.0.0.0/8";

/**
 * What a guest may be told to dial.
 *
 * Two jobs, and the second is why this is a grammar rather than a character
 * class. The value is interpolated into a URL and written into the guest's
 * `models.yml`, so it may carry no scheme, no port, no path and no credentials:
 * nothing that could turn `http://<host>:<port>` into a different address than
 * it reads as. A restricted character set does that much, and the character set
 * here is still restricted to exactly what a hostname can hold.
 *
 * What a character set does not do is keep out a value that cannot resolve.
 * `.`, `-`, `a..b`, `-lead` and `trail-` all satisfy one, and each of them
 * provisions a container whose every prompt fails on a name its resolver
 * rejects. That is the same defect this whole seam exists to remove, and it is
 * harder to read than a refusal naming the form. So this is RFC 1123's grammar
 * instead: labels of letters and digits, dashes allowed only inside a label, no
 * empty label, 63 characters per label and 253 overall.
 *
 * `host.docker.internal`, the only value this path produces in practice, passes.
 * Underscore no longer does, and that is the one deliberate narrowing: a
 * resolver will not accept it either, so allowing it only moves the failure
 * from a refusal here to a container that cannot reach its broker.
 */
const HOSTNAME =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/**
 * Whether a listener may bind `host` at all.
 *
 * Anything that resolves to the all-zero address is refused, however it is
 * spelled. A wildcard bind was measured reachable from every container network
 * on this host and from the host's LAN, which would hand one container's grant
 * to every other container and to the local network. A hostname is allowed
 * through: `normalizeIpv4` answers null for one, and it is not this function's
 * job to decide what a name resolves to.
 */
function bindable(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed === "") return false;
  if (WILDCARD_HOSTS[trimmed.toLowerCase()] === true) return false;
  // `::ffff:0.0.0.0` is the same wildcard wearing an IPv6 hat, and it reaches
  // here having matched none of the literals above.
  return normalizeIpv4(trimmed) !== "0.0.0.0";
}

/**
 * Whether `host` is a loopback literal.
 *
 * A literal, deliberately: `localhost` is refused even though it almost always
 * resolves to loopback, because "almost always" is decided by a file any local
 * process with the right permissions can edit, and this is the only thing
 * narrowing who can reach a broker on the `host-alias` shape.
 */
function loopback(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed === "::1" || trimmed === "[::1]") return true;
  return addressInIpv4Cidr(trimmed, LOOPBACK_V4);
}
