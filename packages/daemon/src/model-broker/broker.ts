/**
 * The narrow model broker a container agent talks to.
 *
 * A container agent has full, unrestricted internet egress: TCP to
 * `api.anthropic.com:443` connects, DNS resolves public names, and Apple
 * `container` rejects both `--cap-drop` and `--security-opt`, so the guest holds
 * the full capability set with no confinement to fall back on. That single
 * measured fact settles the design. Any credential that reaches the guest can
 * be read out of its filesystem and used from anywhere, forever, so a provider
 * key must never be injected. The guest gets a proxy instead.
 *
 * What it gets is deliberately not a proxy in the general sense. This is an
 * allowlist of two routes in front of omp's own `auth-gateway`, which is where
 * the real credential lives and stays. The guest holds a bearer that is random,
 * scoped to one model, pinned to one container network's address range, capped
 * on requests, tokens and concurrency, expiring, revoked when the container is
 * released, and worthless on any other machine. Exfiltrating it buys an
 * attacker a few turns of one model against this host until the container goes
 * away.
 *
 * Two consequences worth stating because they are easy to undo by accident:
 *
 * The bearer is stored as a SHA-256 digest and nothing else. The plaintext is
 * returned once, from `issue`, and never retained here. Nothing this class logs
 * ever contains a token, a bearer, or a byte of a request or response body, and
 * a refusal names its reason without naming the credential that failed.
 *
 * The listener binds the container network's own gateway address, never
 * `0.0.0.0`. A wildcard bind was measured reachable from every container
 * network on the host and from the host's LAN, which would hand one container's
 * grant to every other container and to the local network. The gateway address
 * is reachable only from containers on that one network, which is exactly the
 * blast radius a per-container grant is supposed to have.
 *
 * The ceilings are not all the same kind of promise, and the difference decides
 * how to size the blast radius of a stolen bearer. `maxConcurrent` and
 * `maxRequests` are exact: each request reserves both in the same synchronous
 * block that checks them, before the handler yields for the first time, so a
 * burst of concurrent requests cannot all read a stale count and all slip past.
 * `maxTokens` is not exact and cannot be. A turn's cost is only knowable from
 * the response, so the check at admission lets through a turn that then
 * overshoots, and a response whose usage this process cannot read -- no `usage`
 * block, a truncated or malformed stream, a body past the metering buffer --
 * advances the counter by nothing while still spending a request. `maxTokens`
 * therefore bounds spend loosely and `maxRequests` is the ceiling that always
 * binds. Size the exposure in requests.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";
import type { Server } from "bun";
import { addressInIpv4Cidr, isIpv4Cidr, normalizeIpv4 } from "./cidr.ts";

/** 32 random bytes, the same width as every other credential this daemon mints. */
const TOKEN_BYTES = 32;

/**
 * The whole routable surface. An allowlist of exact strings, not a prefix test
 * and not a passthrough, because the point of this process is that a guest
 * cannot reach anything the daemon did not decide to expose. A prefix test
 * would admit every route omp's gateway grows later, sight unseen, and the
 * gateway speaks OpenAI Chat Completions, OpenAI Responses and pi-native as
 * well as Anthropic Messages, plus `GET /v1/models`, which would tell a guest
 * every provider this host holds a credential for.
 */
const ALLOWED_ROUTES: Record<string, true> = { "/v1/messages": true, "/v1/messages/count_tokens": true };

/**
 * The only request headers forwarded to the gateway.
 *
 * This was a denylist -- `authorization` plus the hop-by-hop set -- and the
 * problem with that shape is what it bets on. The gateway is an external `omp`
 * child process whose inbound-header handling this repo neither pins nor
 * versions, so a denylist is a standing bet that no omp release ever grows a
 * header selecting a credential, a provider, an organisation or a project. The
 * bet was already losing: `x-api-key`, `openai-organization` and
 * `openai-project` each mean something to one provider or another, a guest can
 * set every one of them, and every one of them reached the gateway.
 *
 * So it is inverted. What stays is what an Anthropic Messages turn genuinely
 * needs from the caller: the content type of the body, the response shape the
 * client is asking for, and the two Anthropic protocol version headers, which
 * select wire-format behaviour rather than a credential and which omp's own
 * client sends. Everything else is dropped, `authorization` included, and the
 * gateway's own bearer is set afterwards.
 *
 * The cost of this list being too narrow is a header a turn wanted arriving
 * absent, which surfaces as a broken request that names itself. The cost of the
 * denylist being too narrow was a guest choosing which of this host's
 * credentials the gateway spends. Those are not the same size of mistake, so
 * add to this list only with the reason written beside it.
 *
 * The hop-by-hop request headers are now absent by construction rather than by
 * exclusion, and two of them are worth keeping on the record: a copied
 * `content-length` is a request smuggling primitive, because the body is
 * re-sent from a buffer and `fetch` computes the real length itself, and `host`
 * names the bridge address while the upstream is loopback.
 */
const FORWARDED_REQUEST_HEADERS: Record<string, true> = {
  accept: true,
  "anthropic-beta": true,
  "anthropic-version": true,
  "content-type": true,
};

/**
 * The same, for the response, plus `content-encoding`.
 *
 * Measured on Bun 1.3.14: `fetch` transparently decompresses a gzipped response
 * body while `Response.headers` still advertises `content-encoding: gzip` and
 * the compressed `content-length`. Copying those onto the decoded bytes ships a
 * response the guest cannot decode, and it fails as a corrupt body rather than
 * as anything that names this line. The decoded body is described honestly by
 * dropping both.
 */
const HOP_BY_HOP_RESPONSE_HEADERS: Record<string, true> = {
  connection: true,
  "content-encoding": true,
  "content-length": true,
  "keep-alive": true,
  "proxy-authenticate": true,
  te: true,
  trailer: true,
  "transfer-encoding": true,
  upgrade: true,
};

/**
 * Hosts that name every interface rather than one. The non-numeric spellings
 * live here; the numeric ones go through `normalizeIpv4` in `isWildcardHost`,
 * since `0.0.0.0` has more than one valid spelling and a table of strings would
 * miss whichever one a caller used.
 */
const WILDCARD_HOSTS: Record<string, true> = {
  "": true,
  "*": true,
  "::": true,
  "::0": true,
  "[::]": true,
  "0:0:0:0:0:0:0:0": true,
};

/** How many times a bind is retried before the address is called absent. */
const DEFAULT_BIND_ATTEMPTS = 20;

/** Gap between bind attempts. Twenty of these is five seconds of patience. */
const DEFAULT_BIND_DELAY_MS = 250;

/**
 * Ceiling on a forwarded request body. A model request is a conversation, so a
 * megabyte or two is ordinary and a hard refusal has to sit well clear of that.
 * It exists at all because the body is buffered to check its `model` field, and
 * an unbounded buffer of guest-supplied bytes is an unbounded allocation inside
 * the daemon on behalf of the least trusted thing on the machine.
 */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Ceiling on the response bytes held to read a non-streaming `usage` block.
 * A single Messages reply is small; anything past this is not a reply this
 * accounting understands, so it is passed through and not counted rather than
 * accumulated in memory.
 */
const MAX_METERED_JSON_BYTES = 1024 * 1024;

/**
 * 255 seconds, Bun's ceiling, for the same reason the gateway uses it: the
 * default 10s kills any request whose handler is legitimately waiting, and a
 * non-streaming model turn is exactly that. A turn measured through the real
 * gateway on this host took 1569 ms for fifteen output tokens; a long one on a
 * slow provider is nowhere near 10s of headroom.
 */
const IDLE_TIMEOUT_SECONDS = 255;

/** Longest path echoed into a log line. */
const MAX_LOGGED_PATH = 120;

/**
 * Why an in-flight upstream request was cancelled, carried as the abort reason
 * so the rejection a revoked grant's handler catches says what happened rather
 * than surfacing as a bare `AbortError` indistinguishable from a network fault.
 *
 * It has to stay a constant with nothing caller-supplied in it. Measured on Bun
 * 1.3.14: aborting a `fetch` whose response is already streaming makes Bun print
 * the abort reason, with a stack, straight to this process's stderr. It is not
 * an unhandled rejection and not the `Bun.serve` `error` hook -- neither fires,
 * and there is no userland hook that suppresses it. So whatever is in here is
 * written to the daemon's log stream outside `#log`, past every rule this class
 * keeps about what may reach a log line. A token or a grant detail in this
 * string would be a credential in the operator's logs.
 */
const REVOKED_ABORT_REASON = "the model grant was revoked while the request was in flight";

export interface ModelGrant {
  /** Returned once; the caller writes it into the guest's token file. */
  token: string;
  /** `http://<gateway>:<port>`, the address the guest's `models.yml` points at. */
  endpoint: string;
  /** The single allowlisted model id. */
  model: string;
}

export interface ModelGrantLimits {
  /**
   * Requests this grant may have FORWARDED to the gateway. Exact, and it counts
   * only forwarded requests: one refused here -- wrong model, unparseable body,
   * over the body cap -- costs the guest nothing, because it cost the operator
   * nothing. A guest can therefore be refused as often as it likes, which is a
   * load question about this daemon and not a quota question about the provider.
   */
  maxRequests: number;
  /**
   * Input plus output tokens this grant may consume, best-effort and checked at
   * admission only. It overshoots by whatever the in-flight turns spend, and a
   * reply whose usage cannot be read advances it by nothing: see `meter`.
   * `maxRequests` is the ceiling that always binds.
   */
  maxTokens: number;
  /** In-flight ceiling. Exact, reserved where it is checked. */
  maxConcurrent: number;
}

export interface ModelBrokerOptions {
  /** Loopback auth-gateway base, no trailing slash. */
  upstreamUrl: () => string;
  /** Reads the gateway token file at call time, so a rotation is picked up. */
  upstreamBearer: () => Promise<string>;
  /** MUST never receive a token. */
  onLog?: (line: string) => void;
  /** Clock seam, so a test can prove expiry without waiting for it. */
  now?: () => number;
}

/**
 * One live grant. The plaintext token is deliberately absent: only its digest
 * is here, so neither this process's heap nor anything that reads it yields a
 * presentable credential.
 */
interface Grant {
  /** SHA-256 of the token, as raw bytes so `timingSafeEqual` can take it directly. */
  digest: Buffer;
  model: string;
  /**
   * The range the peer must be in, or null for a grant whose peer check is
   * deliberately off. Null is the only way to reach the skip: see `issue`.
   */
  peerCidr: string | null;
  limits: ModelGrantLimits;
  expiresAtMs: number;
  inFlight: number;
  requestsUsed: number;
  tokensUsed: number;
  /**
   * Cancels every upstream request this grant still has in flight, and is
   * aborted by `revoke` and `revokeAll`.
   *
   * Without it, revocation only stopped the next request from authenticating.
   * A turn already dispatched to the gateway kept running: the provider kept
   * working, the operator kept paying, and both outlived the container that
   * asked for it, because `close`'s `stop(true)` drops the server-side
   * connection without touching the `fetch` the handler is awaiting. One
   * controller per grant rather than one per request, because the lifecycle
   * event that matters is "this container's grant is over", and that has to
   * reach requests the revoking code has no handle on.
   *
   * Expiry deliberately does not abort. A grant past its TTL cannot admit
   * another turn, but the turn it already admitted was admitted legitimately
   * and is bounded by `maxConcurrent`; killing it would make a long turn fail
   * on a clock rather than on anything the guest did. Revocation is the event
   * that means the container is gone and the spend is now pure waste.
   */
  abort: AbortController;
}

export class ModelBroker {
  #upstreamUrl: () => string;
  #upstreamBearer: () => Promise<string>;
  #onLog: ((line: string) => void) | undefined;
  #now: () => number;

  /** Keyed by hex digest of the token. */
  #grants = new Map<string, Grant>();

  /**
   * `never` for the websocket data type: this listener serves two POST routes
   * and never upgrades, so there is no socket payload for it to carry. Bun's
   * `Server` is generic over that payload with no default.
   */
  #server: Server<never> | undefined;
  /** The in-flight bind, retained so a second `listen` joins it rather than racing it. */
  #pending: Promise<void> | undefined;
  /** Host as asked for, recorded before the bind succeeds. */
  #host: string | null = null;
  /** Port as asked for, which may be 0 until the bind resolves a real one. */
  #port: number | null = null;

  constructor(opts: ModelBrokerOptions) {
    this.#upstreamUrl = opts.upstreamUrl;
    this.#upstreamBearer = opts.upstreamBearer;
    this.#onLog = opts.onLog;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Bind `host:port`, retrying while the bridge address is absent.
   *
   * The retry is not defensive padding, it is the ordering constraint. Apple
   * `container` reports a network's gateway address from `network inspect`
   * immediately after `network create`, but the address is not assigned to any
   * interface on the host until a container is actually running on that
   * network: until then `bind()` fails `EADDRNOTAVAIL (49)`. Provisioning has to
   * go create network -> inspect -> seed the guest's config -> run the
   * container -> bind, and the seeding step needs the endpoint and the token
   * before the container exists. So this method is called early, its address is
   * recorded synchronously below so `issue` can name the endpoint, and it spends
   * the intervening window retrying until the container comes up and the address
   * appears.
   *
   * Calling it again with the same address joins the same bind rather than
   * starting another, which is how the provisioner awaits it after
   * `container run` returns.
   *
   * A wildcard host is refused outright. Measured, a `0.0.0.0` bind is reachable
   * from every container network on the host AND from the host's LAN, which
   * would hand one container's grant to every other container and to anything on
   * the local network. Callers guard their own call sites, and the guard still
   * belongs here: this is where the socket is opened, and it is the only place
   * that cannot be bypassed by a new caller.
   */
  listen(input: { host: string; port: number; attempts?: number; delayMs?: number }): Promise<void> {
    if (isWildcardHost(input.host)) {
      return Promise.reject(
        new Error(
          `model broker refuses to bind the wildcard host ${JSON.stringify(input.host)}: a wildcard bind answers ` +
            `on every container network on this host and on the host's LAN, so one container's grant would be ` +
            `presentable by all of them. Bind the container network's own gateway address, or loopback when the ` +
            `runtime keeps its bridge inside a VM.`,
        ),
      );
    }
    const committed = this.#host === null ? null : `${this.#host}:${String(this.#port)}`;
    const address = `${input.host}:${input.port}`;
    if (committed !== null && committed !== address) {
      return Promise.reject(
        new Error(
          `model broker is already committed to ${committed} and cannot also serve ${address}: one broker ` +
            `serves one container network, so a second network needs a second broker`,
        ),
      );
    }
    // Synchronous, and before the first attempt: `issue` is called during the
    // window when this address does not exist yet, and it has to be able to
    // name the endpoint the guest will point at.
    this.#host = input.host;
    this.#port = input.port;

    if (this.#server !== undefined) return Promise.resolve();
    const joined = this.#pending;
    if (joined !== undefined) return joined;

    const started = this.#attach(
      input.host,
      input.port,
      input.attempts ?? DEFAULT_BIND_ATTEMPTS,
      input.delayMs ?? DEFAULT_BIND_DELAY_MS,
    );
    this.#pending = started;
    // The first call is made to open the window `issue` needs and is awaited
    // later, once the container is up. Marking the retained promise handled
    // keeps that first, unawaited call from surfacing as an unhandled rejection
    // while still rejecting for whoever does await it.
    started.catch(() => {});
    return started;
  }

  /**
   * Mint a grant. `peerCidr` is the container network's own CIDR, e.g.
   * `"192.168.65.0/24"`.
   *
   * Every input is checked here rather than at first use, because the failure
   * this guards against is a container that reaches `idle` and then cannot
   * answer a single prompt. A CIDR that does not parse, a ceiling of zero or an
   * already-elapsed TTL each produce exactly that: a guest that is configured,
   * connected, and refused on every request. Provisioning has to fail loudly
   * instead.
   *
   * `peerCidr: null` turns the peer check off for that grant, and is the only
   * way to turn it off. It exists for runtimes that keep the bridge inside a VM
   * (Docker Desktop), where the guest reaches the broker through
   * `host.docker.internal`, the peer arrives NAT'd, and there is no address
   * range left to compare against. On that path the grant is held by the bearer,
   * the model allowlist, the ceilings and the TTL, and nothing else.
   *
   * The reason it is a null and not a permissive `0.0.0.0/0` is that the two are
   * different facts. A null is a decision a caller had to spell out. A
   * `0.0.0.0/0` is a value, indistinguishable in here from a range misread out
   * of `network inspect`, and it would let an accident become an open door. So a
   * malformed range still throws rather than degrading into a skip: the skip is
   * unreachable except from an explicit null.
   */
  issue(input: { model: string; peerCidr: string | null; limits: ModelGrantLimits; ttlMs: number }): ModelGrant {
    const host = this.#host;
    if (host === null) {
      throw new Error(
        "model broker has no address: call `listen` before `issue`, because a grant has to name the endpoint " +
          "the guest will point at and only `listen` knows what that is",
      );
    }
    // The bound port wins when there is one. Before the bind resolves, the
    // asked-for port is all there is, and 0 is not an answer: an ephemeral port
    // is not knowable until the socket exists, so granting one here would hand
    // the guest `http://host:0`. Refused rather than guessed, because the guest
    // would come up pointed at nothing and fail every prompt.
    const port = this.#server?.port ?? this.#port;
    if (port === null || port === 0) {
      throw new Error(
        `model broker cannot grant an endpoint on ${host}:0: an ephemeral port is not known until the bind ` +
          `completes, so either name a port or await \`listen\` before issuing`,
      );
    }
    if (input.model.trim() === "") {
      throw new Error("model broker cannot grant an empty model id: nothing would be allowlisted");
    }
    if (input.peerCidr !== null && !isIpv4Cidr(input.peerCidr)) {
      throw new Error(
        `model broker cannot grant to peer range ${JSON.stringify(input.peerCidr)}: it is not an IPv4 CIDR, so ` +
          `the peer check would refuse every request and the container could never answer a prompt. Pass null if ` +
          `the peer check is meant to be off; a range that does not parse is never read as a skip.`,
      );
    }
    for (const [name, value] of [
      ["maxRequests", input.limits.maxRequests],
      ["maxTokens", input.limits.maxTokens],
      ["maxConcurrent", input.limits.maxConcurrent],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(
          `model broker cannot grant with ${name} ${String(value)}: a ceiling below one refuses every request, ` +
            `so the container would be provisioned unable to answer`,
        );
      }
    }
    if (!Number.isFinite(input.ttlMs) || input.ttlMs < 1) {
      throw new Error(
        `model broker cannot grant with ttlMs ${String(input.ttlMs)}: the grant would already have expired`,
      );
    }

    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    const digest = createHash("sha256").update(token).digest();
    const endpoint = `http://${host}:${port}`;
    const grant: Grant = {
      digest,
      model: input.model,
      peerCidr: input.peerCidr,
      // Copied, so a caller mutating its own limits object afterwards cannot
      // raise a ceiling this broker is enforcing.
      limits: {
        maxRequests: input.limits.maxRequests,
        maxTokens: input.limits.maxTokens,
        maxConcurrent: input.limits.maxConcurrent,
      },
      expiresAtMs: this.#now() + input.ttlMs,
      inFlight: 0,
      requestsUsed: 0,
      tokensUsed: 0,
      abort: new AbortController(),
    };
    this.#log(
      `granted ${input.model} on ${endpoint} to ` +
        // Named rather than left to be inferred from an absent range: turning
        // the peer check off is a real widening of what can present this grant,
        // and it should be legible in the log without reading the call site.
        `${input.peerCidr ?? "any peer, peer check off for this grant"} ` +
        `(${input.limits.maxRequests} requests, ${input.limits.maxTokens} tokens, ` +
        `${input.limits.maxConcurrent} concurrent, ${input.ttlMs}ms)`,
    );
    // Last, deliberately, and after the log rather than before it. `#onLog` is
    // a caller-supplied sink, so it can throw, and a throw between the insert
    // and the return would leave a grant live in this map that nobody holds the
    // token for: presentable by whoever the token was already written for,
    // revocable by nobody, and gone from the audit trail. Every step that can
    // fail happens above this line, so a failed `issue` mints nothing.
    this.#grants.set(digest.toString("hex"), grant);
    // The plaintext leaves here once and is never stored. The caller writes it
    // into the guest's 0600 token file and forgets it too.
    return { token, endpoint, model: input.model };
  }

  /**
   * Withdraw one grant.
   *
   * A hash-map lookup, not the constant-time walk authentication uses, and the
   * difference is not an oversight: this is called by the daemon with a token
   * the daemon itself minted, so there is no attacker supplying the input and
   * nothing for a timing difference to leak to.
   */
  revoke(token: string): void {
    const key = createHash("sha256").update(token).digest("hex");
    const grant = this.#grants.get(key);
    if (grant === undefined) return;
    this.#grants.delete(key);
    // Read before the abort, because the release the abort triggers runs the
    // handler's `finally` and decrements this on its way out.
    const cancelled = grant.inFlight;
    grant.abort.abort(new Error(REVOKED_ABORT_REASON));
    this.#log(
      `revoked a grant for ${grant.model} (${grant.requestsUsed} requests, ${grant.tokensUsed} tokens used` +
        `${cancelled === 0 ? "" : `, cancelling ${cancelled} in flight`})`,
    );
  }

  revokeAll(): void {
    const count = this.#grants.size;
    if (count === 0) return;
    let cancelled = 0;
    for (const grant of this.#grants.values()) {
      cancelled += grant.inFlight;
      grant.abort.abort(new Error(REVOKED_ABORT_REASON));
    }
    this.#grants.clear();
    this.#log(
      `revoked ${count} grant${count === 1 ? "" : "s"}` +
        `${cancelled === 0 ? "" : `, cancelling ${cancelled} in flight`}`,
    );
  }

  /**
   * How many grants can still authenticate. Expired ones are dropped while
   * counting: a grant past its TTL can never authenticate again, so keeping it
   * would only be dead weight in the walk every request pays for.
   */
  liveGrants(): number {
    const now = this.#now();
    for (const [key, grant] of this.#grants) {
      if (grant.expiresAtMs <= now) this.#grants.delete(key);
    }
    return this.#grants.size;
  }

  /**
   * Stop serving. Grants are left alone on purpose: `revokeAll` is the audited
   * lifecycle event that ends them, and folding it in here would make whether
   * the audit records a revocation depend on shutdown ordering. The daemon calls
   * both.
   *
   * That split is also why this does not abort in-flight upstream work.
   * Cancellation rides on revocation, which is the event that means the grant
   * is over; `close` only stops the listener, and a broker whose bind failed is
   * meant to be reusable. Aborting here would leave a still-live grant holding
   * a permanently aborted controller, so every later turn on it would fail
   * instantly with nothing in the log to explain why.
   */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#pending = undefined;
    this.#host = null;
    this.#port = null;
    // `true` closes connections in flight rather than waiting them out. A
    // shutdown that waits for an SSE stream to end waits for the model.
    await server?.stop(true);
  }

  /** Bind, then record the server. Failure leaves the broker reusable. */
  async #attach(host: string, port: number, attempts: number, delayMs: number): Promise<void> {
    try {
      this.#server = await this.#bind(host, port, attempts, delayMs);
      this.#log(`listening on ${host}:${port}`);
    } catch (err) {
      // One broker serves one daemon, so a failed bind must not poison it: the
      // next container provisions onto a different network and therefore a
      // different address, and it has to be able to try.
      this.#pending = undefined;
      this.#host = null;
      this.#port = null;
      throw err;
    }
  }

  async #bind(host: string, port: number, attempts: number, delayMs: number): Promise<Server<never>> {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return Bun.serve({
          hostname: host,
          port,
          idleTimeout: IDLE_TIMEOUT_SECONDS,
          fetch: (req, server) => this.#fetch(req, server),
          /**
           * A handler that throws is a bug here, and Bun's own 500 says only
           * "Internal error" with a stack that goes nowhere. A guest reading
           * that cannot tell it apart from a refusal, and neither can whoever
           * reads the log afterwards.
           */
          error: (err: Error) => {
            this.#log(`request handler failed: ${err.message}`);
            return Response.json({ error: "internal_error" }, { status: 500 });
          },
        });
      } catch {
        // Retried on any bind failure, not just on the address-absent one, and
        // that is forced rather than lazy. Measured on Bun 1.3.14: `Bun.serve`
        // reports `code: "EADDRINUSE"`, `errno: 0` and "Is port N in use?" for
        // an address no interface holds, identically to a genuinely occupied
        // port. Gating the retry on `EADDRNOTAVAIL` would gate it on a code Bun
        // never produces, so the retry would never fire and the ordering this
        // whole method exists for would be broken.
        if (attempt < attempts) await delay(delayMs);
      }
    }
    throw new Error(
      `model broker could not bind ${host}:${port} after ${attempts} attempts over ${attempts * delayMs}ms: ` +
        `${await bindFailureReason(host, port)}. The address is a container network's own gateway, which exists ` +
        `only while a container is running on that network, so this is what a container that never started looks ` +
        `like from here.`,
    );
  }

  async #fetch(req: Request, server: Server<never>): Promise<Response> {
    const method = req.method;
    // `pathname` only. A query string is discarded rather than forwarded: no
    // allowlisted route reads one, and forwarding it would be a channel into
    // the gateway that nothing here has looked at.
    const path = new URL(req.url).pathname;

    // `=== true` rather than a bare truthiness test, so an inherited property
    // name like `constructor` reads as absent rather than as a routable path.
    //
    // This is the only refusal that puts the method and path through `forLog`,
    // and the only one that needs to: past this line they are `POST` and one of
    // two constants, so every later log line quotes values the daemon chose.
    if (method !== "POST" || ALLOWED_ROUTES[path] !== true) {
      return await this.#deny(req, 404, "not_found", `${forLog(method)} ${forLog(path)} is not an allowlisted route`);
    }

    const presented = bearerFrom(req.headers.get("authorization"));
    if (presented === null) {
      return await this.#deny(req, 401, "unauthorized", `${method} ${path} carried no bearer credential`);
    }
    const grant = this.#match(presented);
    if (grant === null) {
      return await this.#deny(
        req,
        401,
        "unauthorized",
        `${method} ${path} presented a credential no live grant matches`,
      );
    }
    if (grant.expiresAtMs <= this.#now()) {
      this.#grants.delete(grant.digest.toString("hex"));
      return await this.#deny(
        req,
        401,
        "unauthorized",
        `${method} ${path} presented an expired grant for ${grant.model}`,
      );
    }

    // Skipped only for a grant that was minted with an explicit null range, and
    // reached by testing that null rather than by testing whether a range
    // happens to match everything. A grant with a range gets the full check even
    // if the range is odd, so no misread `network inspect` output can turn into
    // an open door.
    //
    // Otherwise it fails closed: an unknown peer is not a peer inside the range,
    // and the range is the only thing standing between this grant and every
    // other container on the host.
    const granted = grant.peerCidr;
    if (granted !== null) {
      const socket = server.requestIP(req);
      const peer = socket === null ? null : normalizeIpv4(socket.address);
      if (peer === null) {
        return await this.#deny(
          req,
          403,
          "forbidden",
          `${method} ${path} arrived from a peer whose address could not be determined`,
        );
      }
      if (!addressInIpv4Cidr(peer, granted)) {
        return await this.#deny(
          req,
          403,
          "forbidden",
          `${method} ${path} arrived from ${peer}, outside the granted range ${granted}`,
        );
      }
    }

    // Admission and reservation, in one synchronous block, and that is the
    // whole mechanism rather than a detail of it.
    //
    // These ceilings used to be checked here and incremented after
    // `readBounded` and `#upstreamBearer`, both of which yield, so a request
    // parked on either had passed the check without moving the count. What that
    // takes to exercise is worth recording, because it is not volume: measured
    // on Bun 1.3.14, fifty concurrent `fetch` calls never overshot, since each
    // body is already complete when the handler starts and the read resolves in
    // a microtask. Fifty connections that send their head and then dribble the
    // body do overshoot, every time -- Bun calls the handler as soon as the head
    // lands, so all fifty sit inside `readBounded` already admitted, and the old
    // code forwarded all fifty against `maxConcurrent: 2`. The guest owns its
    // socket, so the guest owns that window.
    //
    // Reserving in the same synchronous block that checks makes the count each
    // request reads include every request already admitted, because nothing can
    // run in between.
    //
    // Which is also a constraint on the code above: everything from the route
    // test through the peer check is deliberately await-free, and an `await`
    // introduced anywhere in it reopens the burst. Nothing would fail loudly if
    // it were; the ceilings would simply stop being ceilings.
    if (grant.inFlight >= grant.limits.maxConcurrent) {
      return await this.#deny(
        req,
        429,
        "too_many_requests",
        `${method} ${path} exceeds the ${grant.limits.maxConcurrent}-request concurrency ceiling`,
      );
    }
    if (grant.requestsUsed >= grant.limits.maxRequests) {
      return await this.#deny(
        req,
        402,
        "quota_exhausted",
        `${method} ${path} exhausted the ${grant.limits.maxRequests}-request ceiling`,
      );
    }
    if (grant.tokensUsed >= grant.limits.maxTokens) {
      return await this.#deny(
        req,
        402,
        "quota_exhausted",
        `${method} ${path} exhausted the ${grant.limits.maxTokens}-token ceiling (${grant.tokensUsed} counted)`,
      );
    }
    grant.inFlight += 1;
    grant.requestsUsed += 1;

    // Two ways to give that reservation back, and which one an exit takes is
    // the difference between a ceiling that tightens and one that eats a
    // well-behaved container's budget.
    //
    // `refund` is for a request refused locally after the reservation: an
    // over-cap body, a body that is not JSON, a body naming another model, an
    // unreadable gateway credential. Not one of those reached the gateway, so
    // neither the slot nor the request was spent, and keeping the request would
    // let a guest that never got a turn spend its whole ceiling on refusals.
    //
    // `release` is for a request that was dispatched. It hands back the slot
    // and keeps the request spent, because the gateway may have done the work
    // and charged for it whatever came back. This ceiling is then only ever
    // wrong in the tightening direction, which is the side to be wrong on.
    //
    // Both are idempotent, because `release` is also handed to the meter, which
    // calls it when the response stream ends; see `meter` for which hook that
    // actually is on this runtime.
    let settled = false;
    const refund = () => {
      if (settled) return;
      settled = true;
      grant.inFlight -= 1;
      grant.requestsUsed -= 1;
    };
    const release = () => {
      if (settled) return;
      settled = true;
      grant.inFlight -= 1;
    };

    // Defaulted to the exit that costs the guest least, so a refusal added
    // later inside this block refunds without anyone remembering that it has
    // to. That direction leaves a guest holding a request it never spent; the
    // other one leaks a concurrency slot for the life of the container.
    let reached: "local" | "gateway" | "stream" = "local";
    try {
      const body = await readBounded(req, MAX_REQUEST_BODY_BYTES);
      if (body === null) {
        return await this.#deny(
          req,
          413,
          "payload_too_large",
          `${method} ${path} body exceeds the ${MAX_REQUEST_BODY_BYTES}-byte ceiling`,
        );
      }
      // Parsed once, here, and the same bytes are forwarded verbatim.
      // Re-encoding the parsed object instead would let a body that parses
      // differently at the two ends past the model check.
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return await this.#deny(req, 400, "bad_request", `${method} ${path} body is not JSON`);
      }
      const asked = isRecord(parsed) ? parsed.model : undefined;
      if (typeof asked !== "string") {
        return await this.#deny(req, 400, "bad_request", `${method} ${path} body names no model`);
      }
      // The granted model is named; the requested one is not. It is body
      // content, and body content does not go in a log line.
      if (asked !== grant.model) {
        return await this.#deny(
          req,
          403,
          "forbidden",
          `${method} ${path} asked for a model other than the granted ${grant.model}`,
        );
      }

      let upstreamBearer: string;
      try {
        upstreamBearer = await this.#upstreamBearer();
      } catch (err) {
        // Relaying the reason is safe only because the credential reader's
        // contract is that it never surfaces the credential, including in its
        // own errors. Its failures are "the token file is not there", which is
        // the one thing an operator needs to read here.
        this.#log(`the upstream credential is unavailable: ${reasonOf(err)}`);
        return Response.json({ error: "bad_gateway" }, { status: 502 });
      }

      reached = "gateway";
      try {
        const upstream = await fetch(`${this.#upstreamUrl()}${path}`, {
          method: "POST",
          headers: forwardHeaders(req.headers, upstreamBearer),
          body,
          // How revocation reaches a turn that is already running. Without it,
          // `revoke` only stopped the next request from authenticating: this
          // one kept going against the provider, on the operator's quota,
          // after the container that asked for it was destroyed.
          signal: grant.abort.signal,
        });
        const headers = responseHeaders(upstream.headers);
        const upstreamBody = upstream.body;
        if (upstreamBody === null) {
          return new Response(null, { status: upstream.status, statusText: upstream.statusText, headers });
        }
        // Streamed through unchanged, byte for byte, so SSE arrives
        // incrementally rather than at the end of the turn. The meter reads the
        // bytes on their way past and never holds them up.
        const metered = upstreamBody.pipeThrough(meter(grant, upstream.headers.get("content-type"), release));
        reached = "stream";
        return new Response(metered, { status: upstream.status, statusText: upstream.statusText, headers });
      } catch (err) {
        // A revoked grant is reported as the revocation it is rather than as a
        // gateway fault: the abort is this daemon's own decision, and calling it
        // a 502 sends an operator to read the gateway's logs for a failure that
        // is not there. 401 because it is now true of the credential -- the
        // grant it named has been deleted.
        if (grant.abort.signal.aborted) {
          this.#log(`cancelled an in-flight ${path}: ${REVOKED_ABORT_REASON}`);
          return Response.json({ error: "unauthorized" }, { status: 401 });
        }
        this.#log(`forwarding ${path} to the auth gateway failed: ${reasonOf(err)}`);
        return Response.json({ error: "bad_gateway" }, { status: 502 });
      }
    } finally {
      // The stream owns the slot once it has it, and gives it back when the
      // body ends, is cancelled, or errors mid-flight. Every other exit lands
      // here: a local refusal refunds, and anything dispatched -- a bodyless
      // reply, a failed forward, an aborted one -- releases. So no failure
      // upstream can wedge the concurrency ceiling closed for the life of the
      // container, and no refusal here can quietly spend the guest's budget.
      if (reached === "local") refund();
      else if (reached === "gateway") release();
    }
  }

  /**
   * The grant whose digest matches, or null.
   *
   * Every live grant is compared and the loop never breaks early, so the number
   * of comparisons a request costs does not depend on which grant matched or on
   * whether one did. Both operands are 32-byte digests, which is also why
   * `timingSafeEqual` is safe to call here at all: it throws on a length
   * mismatch, and a digest has no length to leak.
   */
  #match(token: string): Grant | null {
    const digest = createHash("sha256").update(token).digest();
    let found: Grant | null = null;
    for (const grant of this.#grants.values()) {
      if (timingSafeEqual(digest, grant.digest)) found = grant;
    }
    return found;
  }

  /**
   * Log a refusal and answer it, having first read whatever the guest was still
   * sending.
   *
   * The drain is the load-bearing part. Measured on Bun 1.3.14: a handler that
   * answers a request whose body it never consumed desyncs the connection. The
   * refusal itself arrives correctly, and then the NEXT request on that
   * keep-alive connection never completes -- reproduced with a 33 MiB body
   * against a 404, a 401 and a 413 alike, each time hanging the following
   * request until it timed out. omp's Anthropic client reuses connections, so
   * one refused request would wedge every request after it and the guest would
   * reach `idle` and then hang: exactly the failure this broker exists to
   * remove, reintroduced by a missing `await`.
   *
   * The bytes are read and dropped, never retained, so the memory ceiling the
   * body cap protects is untouched. What it costs is loopback traffic from our
   * own container, which is not a resource worth defending.
   *
   * Every refusal goes through here rather than each site remembering to drain,
   * because a refusal that forgets is not a bug you notice: it is a hang two
   * requests later.
   */
  async #deny(req: Request, status: number, error: string, reason: string): Promise<Response> {
    this.#log(`refused: ${reason}`);
    await drainBody(req);
    return Response.json({ error }, { status });
  }

  #log(line: string): void {
    this.#onLog?.(`model broker: ${line}`);
  }
}

/**
 * The real errno behind a bind that failed, recovered by asking `node:net` the
 * same question.
 *
 * `Bun.serve` collapses every bind failure into `EADDRINUSE` with `errno: 0` and
 * the message "Failed to start server. Is port N in use?", measured identically
 * for an occupied port and for an address no interface holds. Those are opposite
 * problems with opposite fixes, and the one this broker hits is the address one,
 * so Bun's message sends an operator hunting a port conflict that does not
 * exist. `node:net` still reports the truth: `EADDRNOTAVAIL (49)` against an
 * absent address, `EADDRINUSE (48)` against a taken port.
 *
 * One throwaway listen, only on the final failure, off every hot path.
 */
async function bindFailureReason(host: string, port: number): Promise<string> {
  return await new Promise<string>(resolve => {
    const probe = createServer();
    probe.once("error", (err: NodeJS.ErrnoException) => {
      resolve(`${err.code ?? "an unnamed error"} (errno ${err.errno ?? "unknown"})`);
    });
    probe.listen(port, host, () => {
      // The address came up between the last attempt and this probe. Worth
      // saying plainly, because it means the retry window was too short rather
      // than the address being wrong.
      probe.close(() => resolve("the address bound on a probe immediately afterwards, so the wait was too short"));
    });
  });
}

/**
 * Whether `host` names every interface rather than one.
 *
 * Spelled out rather than pattern-matched, because "never `0.0.0.0`" is a
 * property of the address and not of the string: the IPv6 wildcard, the empty
 * string that some servers read as one, and the IPv4-mapped form all bind the
 * same set of interfaces under different names. The numeric case goes through
 * `normalizeIpv4` so `::ffff:0.0.0.0` is caught with `0.0.0.0`, and loopback is
 * deliberately not on this list: binding `127.0.0.1` is the correct choice for a
 * runtime whose bridge lives inside a VM.
 */
function isWildcardHost(host: string): boolean {
  const trimmed = host.trim();
  if (WILDCARD_HOSTS[trimmed.toLowerCase()] === true) return true;
  return normalizeIpv4(trimmed) === "0.0.0.0";
}

/** The token in an `Authorization: Bearer` header, or null. */
function bearerFrom(header: string | null): string | null {
  if (header === null) return null;
  // Scheme names are case-insensitive per RFC 7235, and the prefix is ASCII, so
  // lowercasing cannot move the offset the slice uses.
  if (!header.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  return token === "" ? null : token;
}

/**
 * The request body, or null when it is over `cap`.
 *
 * Over the cap it keeps reading and stops retaining. That is the shape the
 * connection requires, not thrift: answering a request whose body has not been
 * consumed desyncs the keep-alive connection and hangs the next request on it,
 * measured on Bun 1.3.14 (see `#deny`). Cancelling the reader instead of
 * draining it does the same thing. Dropping the chunks holds the memory ceiling,
 * which is the resource actually at stake; the bytes still cross loopback, and
 * a container we already run is welcome to waste that.
 *
 * There is no `content-length` shortcut for the same reason. A declared length
 * over the cap could be refused without reading a byte, and the request after
 * it would hang.
 */
async function readBounded(req: Request, cap: number): Promise<Uint8Array | null> {
  const stream = req.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (over) continue;
      if (total > cap) {
        over = true;
        // Released now rather than at the end: there is no reason to hold 32 MiB
        // alive while the rest of a body this size arrives.
        chunks.length = 0;
        continue;
      }
      chunks.push(value);
    }
  } catch {
    // A body that errors mid-read is a connection going away, and there is
    // nothing to forward. Treated as over-cap so the caller refuses rather than
    // forwarding a truncated request as if it were whole.
    return null;
  } finally {
    reader.releaseLock();
  }
  if (over) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Read and drop whatever is left of a request body.
 *
 * A no-op when the body is absent or already locked, which is the case whenever
 * `readBounded` has run: the caller does not have to know which refusals happen
 * before the body is read and which after.
 */
async function drainBody(req: Request): Promise<void> {
  const stream = req.body;
  if (stream === null || stream.locked) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // Already gone. Nothing left to drain and nothing to report.
  } finally {
    reader.releaseLock();
  }
}

/**
 * The subset of the guest's headers `FORWARDED_REQUEST_HEADERS` names, with the
 * gateway's bearer put on afterwards.
 *
 * Nothing outside that list survives, which is the point: this is the boundary
 * between the least trusted thing on the machine and the process that holds a
 * real provider credential, and the guest chooses every byte of every header it
 * sends.
 */
function forwardHeaders(from: Headers, upstreamBearer: string): Headers {
  const headers = new Headers();
  for (const [name, value] of from) {
    if (FORWARDED_REQUEST_HEADERS[name.toLowerCase()] !== true) continue;
    headers.set(name, value);
  }
  // Set last, and unconditionally, so it cannot be reached by anything above:
  // the guest's bearer stops here, and what goes on is the gateway's, which the
  // guest has never seen and cannot reach the gateway to use. A guest sending
  // two `authorization` headers gets neither -- `Headers` folds duplicates into
  // one entry, and that entry is not on the allowlist.
  headers.set("authorization", `Bearer ${upstreamBearer}`);
  return headers;
}

/** The upstream's headers, minus the ones that describe a hop or a lie. */
function responseHeaders(from: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of from) {
    if (HOP_BY_HOP_RESPONSE_HEADERS[name.toLowerCase()] === true) continue;
    headers.set(name, value);
  }
  return headers;
}

/**
 * `Transformer` plus the `cancel` hook the streams spec grew and the ambient
 * type has not caught up to.
 *
 * This runtime does not call it. Measured on Bun 1.3.14 by instrumenting both
 * hooks and running every termination this file's tests can produce -- a body
 * that ends, a source that errors mid-stream, an upstream `fetch` aborted while
 * streaming, an upstream `fetch` aborted before its headers arrive -- `flush`
 * fired 33 times and `cancel` fired not once. Bun runs `flush` even when the
 * source errors, which is the opposite of what a spec-compliant implementation
 * does, and it is what actually returns the concurrency slot today.
 *
 * The hook stays anyway, and the reason is the direction of the risk. A Bun
 * that implements `transformer.cancel` will call it INSTEAD of `flush` on an
 * errored or cancelled stream, so the day that lands, a meter without this hook
 * silently stops releasing slots on every failed turn and a container wedges at
 * its concurrency ceiling. The hook costs nothing while unreachable and is the
 * difference between that upgrade being uneventful and it being a hang.
 *
 * Declared rather than cast away because a cast would also silence the excess
 * property checks on the object literal below, which is where a typo in a hook
 * name would otherwise become another silently unreachable hook.
 */
interface CancellableTransformer<I, O> extends Transformer<I, O> {
  cancel?: (reason?: unknown) => void;
}

/**
 * A pass-through that reads `usage` off the bytes going past.
 *
 * What it feeds is a best-effort figure, and the shape of the error is always
 * the same: it counts no more than the turn cost and often less. A response
 * with no usage block, a malformed or truncated one, a stream that errors
 * halfway, a non-SSE body past `MAX_METERED_JSON_BYTES` -- each of those
 * advances `tokensUsed` by nothing at all. None of them throws, and none of
 * them delays a byte of the response.
 *
 * So `maxTokens` is a loose bound and not an enforced one. It is checked at
 * admission, so it overshoots by whatever the turns already in flight go on to
 * spend, and repeating a request whose reply this cannot parse spends request
 * slots while leaving `tokensUsed` where it was. `maxRequests` is the ceiling
 * that always binds, and it is the one to size a grant by.
 *
 * A conservative floor for the unparseable cases was considered and refused: a
 * token count is not derivable from bytes without the provider's tokenizer, and
 * a made-up number in this counter would read exactly like a measured one to
 * whoever trusts it next. Counting nothing is at least legible. Accounting is
 * not the boundary here anyway -- the model allowlist, the peer range and the
 * request ceiling are, and they hold whatever this counts. What this must never
 * do is break a turn to balance its books.
 */
function meter(grant: Grant, contentType: string | null, release: () => void): TransformStream<Uint8Array, Uint8Array> {
  const sse = (contentType ?? "").toLowerCase().includes("text/event-stream");
  const decoder = new TextDecoder();
  /** SSE: the tail of a line split across chunks. */
  let carry = "";
  /** Non-SSE: the body so far, up to the buffer cap. */
  let buffered = "";
  let overflowed = false;

  const add = (count: number) => {
    if (count > 0) grant.tokensUsed += count;
  };

  const readEvent = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === "message_start") {
      const message = event.message;
      if (!isRecord(message)) return;
      const usage = message.usage;
      if (isRecord(usage)) add(tokenCount(usage.input_tokens));
      return;
    }
    if (event.type === "message_delta") {
      const usage = event.usage;
      // A delta's `output_tokens` is the running total, and in practice a
      // stream carries one delta, so adding it is the whole output count. A
      // stream that sent several would be over-counted, which tightens the
      // ceiling rather than loosening it.
      if (isRecord(usage)) add(tokenCount(usage.output_tokens));
    }
  };

  const transformer: CancellableTransformer<Uint8Array, Uint8Array> = {
    transform(chunk, controller) {
      // Forwarded first, always. Metering runs afterwards and inside a guard,
      // so nothing it can do keeps a byte from the guest.
      controller.enqueue(chunk);
      try {
        if (sse) {
          carry += decoder.decode(chunk, { stream: true });
          const lines = carry.split("\n");
          // The last piece may be half a line; it waits for the next chunk.
          carry = lines.pop() ?? "";
          for (const line of lines) readEvent(line.trimEnd());
          return;
        }
        if (overflowed) return;
        buffered += decoder.decode(chunk, { stream: true });
        if (buffered.length > MAX_METERED_JSON_BYTES) {
          // Past the cap the body is not a reply this understands, so it is
          // passed through and not counted rather than accumulated.
          overflowed = true;
          buffered = "";
        }
      } catch {
        // Undecodable bytes are still a perfectly good response body.
      }
    },
    flush() {
      try {
        if (sse) {
          if (carry !== "") readEvent(carry.trimEnd());
        } else if (!overflowed) {
          const parsed: unknown = JSON.parse(buffered);
          const usage = isRecord(parsed) ? parsed.usage : undefined;
          if (isRecord(usage)) add(tokenCount(usage.input_tokens) + tokenCount(usage.output_tokens));
          // A `count_tokens` reply carries a bare `input_tokens` and no `usage`,
          // and is deliberately not counted: that route spends a request slot
          // and no model tokens.
        }
      } catch {
        // A truncated or non-JSON body counts nothing. See above: upward-only.
      }
      // The release that actually happens. Measured on Bun 1.3.14, this runs on
      // every termination this broker can produce, including the ones it has no
      // business running on: a source that errors mid-stream and an upstream
      // `fetch` aborted while streaming both arrive here rather than at
      // `cancel`. A guest also cannot free its slot early or strand one by
      // hanging up -- measured, a client abandoning the response body does not
      // abort `req.signal`, the server drains the rest of the upstream stream,
      // and this runs normally.
      release();
    },
    cancel() {
      // Unreachable on Bun 1.3.14 and kept deliberately: see
      // `CancellableTransformer` for the instrumented counts and for why a
      // runtime that starts honouring this hook would otherwise stop releasing
      // slots on every failed turn. Whatever was counted before the error
      // stands.
      release();
    },
  };
  return new TransformStream<Uint8Array, Uint8Array>(transformer);
}

/** A usage figure, or zero for anything that is not one. */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Guest-supplied text on its way into a log line: bounded, and stripped to
 * printable ASCII. A path is chosen by the least trusted thing on the machine,
 * and a log a guest can pad to any length or write control characters into is a
 * log a guest can forge a line in.
 */
function forLog(text: string): string {
  const clean = text.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > MAX_LOGGED_PATH ? `${clean.slice(0, MAX_LOGGED_PATH)}...` : clean;
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}
