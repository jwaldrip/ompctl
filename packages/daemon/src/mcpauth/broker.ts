/**
 * The thing that hands out access tokens, and the only thing that ever redeems
 * a refresh token.
 *
 * Three properties carry this class, and each of them exists because its
 * absence is already documented as having broken something:
 *
 * 1. **One exchange per grant at a time.** OMP's refresh lease is keyed by
 *    credential *row*, so five rows holding five members of one rotating family
 *    were never serialised against each other, and one of them recorded
 *    `invalid_grant: Refresh token reuse detected; session revoked`. Here the
 *    singleflight is keyed by grant id, and the grant id is derived from
 *    (resource, account), so two callers for one family share one exchange by
 *    construction rather than by luck.
 * 2. **The successor is on disk before the token is in a caller's hands.**
 *    Redeeming a rotating refresh token kills it at the provider the instant the
 *    response is written. A successor that only ever existed in this process is
 *    a grant one crash away from needing a person at a browser.
 * 3. **The failure classification is the whole decision.** `definitive` stops
 *    and asks for a human. `transient` keeps everything and backs off. There is
 *    no third path, and in particular there is no keepalive: nothing in this
 *    class renews anything except the refresh grant, so a provider that never
 *    issued a refresh token is reported as `no_refresh_grant` rather than
 *    quietly polled at until the access token dies anyway.
 *
 * Access tokens live in a `Map` and nowhere else. One on disk would be a
 * credential sitting in a file for no reason: it is re-mintable from material
 * the daemon already has, and a process restart is not a security event worth
 * paying for with an at-rest secret.
 */

import type { McpAuthSummary } from "@ompd/core";
import { toRefreshOutcome } from "./token-endpoint.ts";
import {
  type AccessTokenResult,
  type Clock,
  type GrantRecord,
  type GrantStore,
  type McpAuthBroker,
  type MintedAccessToken,
  type RefreshOutcome,
  systemClock,
  type TokenEndpointClient,
  TokenEndpointError,
} from "./types.ts";

/** Refresh this far before expiry, so a request in flight when the token dies still carries a live one. */
const DEFAULT_REFRESH_SKEW_MS = 60_000;
/** How often the proactive loop looks for tokens approaching the skew window. */
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
/** First retry after a transient failure. Doubles from here. */
const BACKOFF_BASE_MS = 1_000;
/**
 * Longest gap between retries.
 *
 * Five minutes rather than an hour because a `degraded` grant is meant to heal
 * itself without anybody noticing, and an hour is long enough that a person
 * notices first.
 */
const BACKOFF_CEILING_MS = 300_000;
/**
 * Proportional jitter applied to every deadline this class computes.
 *
 * A daemon that came up once holds N grants whose access tokens were all minted
 * in the same second and all expire in the same second. Without jitter they all
 * decide to refresh in the same second too, and the provider sees a spike from
 * one client for no reason.
 */
const JITTER_FRACTION = 0.2;

export interface McpAuthBrokerOptions {
  grants: GrantStore;
  tokens: TokenEndpointClient;
  clock?: Clock;
  /** Structured-enough logging. Never called with anything derived from a secret. */
  onLog?: (line: string) => void;
  refreshSkewMs?: number;
  sweepIntervalMs?: number;
  /** Injected so a test can pin the jitter. Not a security boundary; nothing here is a secret. */
  random?: () => number;
  /**
   * Whether an OMP session pointed at the loopback endpoint would actually
   * reach this grant.
   *
   * Injected because this class cannot know. Whether a grant is wired is a fact
   * about `~/.omp/agent/mcp.json`, which another part of the daemon owns, and
   * the honest default for "nothing has told us" is `false`. Reporting `true`
   * from a guess is how a status table says a grant is in use when no session
   * can see it.
   */
  isWired?: (grant: GrantRecord) => boolean;
}

export class McpAuthBrokerImpl implements McpAuthBroker {
  readonly #grants: GrantStore;
  readonly #tokens: TokenEndpointClient;
  readonly #clock: Clock;
  readonly #onLog: ((line: string) => void) | undefined;
  readonly #skewMs: number;
  readonly #sweepMs: number;
  readonly #random: () => number;
  readonly #isWired: (grant: GrantRecord) => boolean;

  /** Memory only. Never persisted, never logged, never in a summary. */
  readonly #access = new Map<string, MintedAccessToken>();
  /**
   * The effective skew for each grant's currently held token, rolled once per
   * mint. Stable per token so the decision "is this token still good enough" is
   * not a coin flip on each call.
   */
  readonly #skew = new Map<string, number>();
  /** The singleflight. One entry per grant with an exchange in flight. */
  readonly #inflight = new Map<string, Promise<RefreshOutcome>>();

  #timer: Timer | null = null;
  #sweeping = false;

  constructor(opts: McpAuthBrokerOptions) {
    this.#grants = opts.grants;
    this.#tokens = opts.tokens;
    this.#clock = opts.clock ?? systemClock;
    this.#onLog = opts.onLog;
    this.#skewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.#sweepMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.#random = opts.random ?? Math.random;
    this.#isWired = opts.isWired ?? (() => false);
  }

  async accessTokenFor(id: string): Promise<AccessTokenResult> {
    const grant = this.#grants.get(id);
    if (grant === undefined) {
      return { ok: false, state: "reauth_required", detail: `no grant is registered as ${id}` };
    }

    const now = this.#clock.now();
    const cached = this.#access.get(id);
    if (cached !== undefined && now + this.#skewFor(id) < cached.expiresAt) {
      return { ok: true, accessToken: cached.accessToken, tokenType: cached.tokenType };
    }

    // Two states are remembered rather than re-litigated: a provider that
    // refused definitively, and a grant nothing here can renew. Until a person
    // authorizes again -- which replaces the row through `save` -- there is
    // nothing to ask the token endpoint, and asking anyway turns a dead grant
    // into a request loop against a provider that has already answered. It also
    // keeps the proxy's per-request path from decrypting a vault envelope for a
    // grant that cannot work.
    if (grant.state === "reauth_required" || grant.state === "no_refresh_grant") {
      return { ok: false, state: grant.state, detail: grant.detail ?? `this grant is ${grant.state}` };
    }

    if (grant.nextAttemptAt !== undefined && now < grant.nextAttemptAt) {
      const remaining = Math.ceil((grant.nextAttemptAt - now) / 1000);
      return {
        ok: false,
        state: grant.state === "healthy" ? "degraded" : grant.state,
        detail: grant.detail ?? `backing off for ${remaining}s after ${grant.failures} failures`,
      };
    }

    const outcome = await this.#refresh(id);
    if (outcome.kind === "ok") {
      return { ok: true, accessToken: outcome.token.accessToken, tokenType: outcome.token.tokenType };
    }
    // The state is read back rather than derived from the outcome: `definitive`
    // covers both "the provider refused" and "there is nothing to refresh
    // with", and those are different states to a person reading a status table.
    return { ok: false, state: this.#grants.get(id)?.state ?? "degraded", detail: outcome.reason };
  }

  async refreshNow(id: string): Promise<RefreshOutcome> {
    // Ignores backoff by construction: the backoff gate lives in
    // `accessTokenFor`, not in the exchange, so an operator typing
    // `ompd mcp-auth refresh` is not told to wait four minutes. It still joins
    // the singleflight, because "force a refresh" must not mean "redeem the
    // refresh token twice".
    return await this.#refresh(id);
  }

  invalidate(id: string): void {
    this.#access.delete(id);
    this.#skew.delete(id);
  }

  summaries(): McpAuthSummary[] {
    return this.#grants.list().map(grant => {
      const token = this.#access.get(grant.id);
      // Assembled field by field rather than spread. A spread would carry
      // whatever a future column adds, and the one promise this type makes is
      // that it can be pasted into a bug report.
      const summary: McpAuthSummary = {
        id: grant.id,
        serverName: grant.serverName,
        resourceUrl: grant.resourceUrl,
        issuer: grant.issuer,
        state: grant.state,
        scopes: grant.scopes,
        failures: grant.failures,
        supportsRefresh: grant.supportsRefresh,
        wired: this.#isWired(grant),
      };
      if (grant.detail !== undefined) summary.detail = grant.detail;
      if (grant.account !== undefined) summary.account = grant.account;
      if (grant.lastRefreshAt !== undefined) summary.lastRefreshAt = new Date(grant.lastRefreshAt).toISOString();
      if (grant.nextAttemptAt !== undefined) summary.nextAttemptAt = new Date(grant.nextAttemptAt).toISOString();
      // The expiry, not the token. A client needs to know when the daemon will
      // renew; it never needs the bytes.
      if (token !== undefined) summary.accessExpiresAt = new Date(token.expiresAt).toISOString();
      return summary;
    });
  }

  start(): void {
    if (this.#timer !== null) return;
    // A `refreshing` row is a lie the moment this process starts: no exchange
    // can be in flight in a daemon that has just come up, so a grant a crash
    // left in that state would report an in-flight refresh forever. `degraded`
    // is the truthful version -- the last attempt did not finish, and the next
    // request will try again -- and it costs nothing, because the failure
    // counter and the backoff are untouched.
    for (const grant of this.#grants.list()) {
      if (grant.state !== "refreshing") continue;
      this.#grants.setState(grant.id, "degraded", "a refresh was interrupted by a restart");
    }
    this.#timer = setInterval(() => void this.#sweep(), this.#sweepMs);
    // A refresh loop must never be the reason a process cannot exit.
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Refresh the grants that are about to need it.
   *
   * Only grants with a token already in memory. A grant nobody has asked for
   * has no cached token, and minting one on a schedule would redeem -- and on a
   * rotating provider, burn -- a refresh token to produce an access token no
   * session wanted. The point of refreshing ahead is that a session in flight
   * never waits on a token exchange, and a session that does not exist is not
   * waiting on anything.
   */
  async #sweep(): Promise<void> {
    if (this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (const grant of this.#grants.list()) {
        if (grant.state === "reauth_required" || grant.state === "no_refresh_grant") continue;
        const token = this.#access.get(grant.id);
        if (token === undefined) continue;
        const now = this.#clock.now();
        if (grant.nextAttemptAt !== undefined && now < grant.nextAttemptAt) continue;
        if (now + this.#skewFor(grant.id) < token.expiresAt) continue;
        await this.#refresh(grant.id);
      }
    } finally {
      this.#sweeping = false;
    }
  }

  /**
   * The singleflight.
   *
   * Not an optimisation. Two callers redeeming one rotating refresh token is
   * exactly the behaviour a provider's reuse detection is built to punish, and
   * it punishes it by revoking the whole family -- so the second caller does not
   * merely waste a request, it destroys the first caller's grant too.
   */
  #refresh(id: string): Promise<RefreshOutcome> {
    const existing = this.#inflight.get(id);
    if (existing !== undefined) return existing;
    // Wrapped so the `await` suspends before the `finally` can run: an
    // `#exchange` that returns without ever awaiting would otherwise clear the
    // map entry before it was ever set, leaving a stale promise behind forever.
    const flight = (async () => {
      try {
        return await this.#exchange(id);
      } finally {
        this.#inflight.delete(id);
      }
    })();
    this.#inflight.set(id, flight);
    return flight;
  }

  async #exchange(id: string): Promise<RefreshOutcome> {
    const grant = this.#grants.load(id);
    if (grant === undefined) {
      return { kind: "definitive", reason: `no grant is registered as ${id}` };
    }

    // The one gate between this class and a token endpoint that cannot help.
    // Every entry point -- `accessTokenFor`, `refreshNow`, the sweep -- reaches
    // the network through here, so there is a single place that decides a grant
    // is unrenewable and no path around it.
    const refreshToken = grant.secrets.refreshToken;
    if (!grant.supportsRefresh || refreshToken === undefined || refreshToken === "") {
      const reason = grant.supportsRefresh
        ? "the provider issued no refresh token"
        : "the authorization server does not advertise the refresh grant";
      this.invalidate(id);
      this.#grants.setState(id, "no_refresh_grant", reason);
      this.#log(`${id}: ${reason}`);
      return { kind: "definitive", reason };
    }

    // A refresh token is bound to the client it was issued to. Redeeming one
    // without naming that client is not "a request that might work": at a
    // public client the endpoint refuses it, and at a lenient one it is a
    // request for a token under an identity the provider never granted. There
    // is no way to recover a client id that was never recorded -- registering a
    // new one through DCR produces a *different* client, and binding an old
    // rotating refresh token to it is exactly the confusion this refuses -- so
    // the honest state is the one that asks for a person.
    if (grant.clientId === "") {
      const reason = "no OAuth client id is recorded for this grant, so its refresh token cannot be redeemed";
      this.invalidate(id);
      this.#grants.setState(id, "reauth_required", reason);
      this.#log(`${id}: ${reason}`);
      return { kind: "definitive", reason };
    }

    this.#grants.setState(id, "refreshing");
    try {
      const response = await this.#tokens.refresh({
        tokenUrl: grant.tokenUrl,
        refreshToken,
        clientId: grant.clientId,
        clientSecret: grant.secrets.clientSecret,
        // RFC 8707. The stored resource URL is the indicator the tokens were
        // bound to at authorization; renewing without it can hand back a token
        // for a different audience, which the upstream then rejects with a 401
        // indistinguishable from expiry.
        resource: grant.resourceUrl,
        // No `scope`. RFC 6749 section 6 lets a refresh narrow the scope and
        // never widen it, so asking for the stored string back buys nothing and
        // starts failing the day a provider renames a scope.
      });

      const at = this.#clock.now();
      const outcome = toRefreshOutcome(response, at);
      // `toRefreshOutcome` only ever classifies a successful response; the check
      // is what lets the compiler see the token.
      if (outcome.kind !== "ok") return outcome;

      // Before the caller sees the token, and in this order. `rotateRefreshToken`
      // is transactional and treats `undefined` as "the response carried no
      // successor, keep what is stored".
      this.#grants.rotateRefreshToken(id, outcome.rotated, at);
      this.#grants.clearFailures(id);
      this.#grants.setState(id, "healthy");
      this.#access.set(id, outcome.token);
      this.#skew.set(id, this.#jittered(this.#skewMs));
      const seconds = Math.round((outcome.token.expiresAt - at) / 1000);
      this.#log(`${id}: refreshed, expires in ${seconds}s${outcome.rotated === undefined ? "" : ", token rotated"}`);
      return outcome;
    } catch (err) {
      return this.#recordFailure(id, err);
    }
  }

  #recordFailure(id: string, err: unknown): RefreshOutcome {
    // Everything that is not an explicitly terminal OAuth code is transient,
    // including anything that is not a `TokenEndpointError` at all: an
    // unexpected throw is a bug in this daemon, and a bug in this daemon is not
    // evidence that a provider revoked a grant.
    const definitive = err instanceof TokenEndpointError && err.definitive;
    const reason = err instanceof Error ? err.message : String(err);

    if (definitive) {
      // The cached access token goes too. Serving one while the grant is known
      // dead just moves the failure to a moment nobody is watching.
      this.invalidate(id);
      this.#grants.setState(id, "reauth_required", reason);
      this.#log(`${id}: reauthorization required (${reason})`);
      return { kind: "definitive", reason };
    }

    // The grant is untouched: same refresh token, same client secret, same row.
    // A transient failure that cleared credentials would turn a five-second
    // outage into a browser trip.
    const failures = (this.#grants.get(id)?.failures ?? 0) + 1;
    const nextAttemptAt = this.#clock.now() + this.#backoffFor(failures);
    this.#grants.recordFailure(id, reason, nextAttemptAt);
    this.#grants.setState(id, "degraded", reason);
    const waitMs = nextAttemptAt - this.#clock.now();
    this.#log(`${id}: transient failure ${failures}, next attempt in ${waitMs}ms (${reason})`);
    return { kind: "transient", reason };
  }

  /** 1s, 2s, 4s, 8s, ... to a five minute ceiling, jittered. */
  #backoffFor(failures: number): number {
    const doubled = BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1);
    return this.#jittered(Math.min(doubled, BACKOFF_CEILING_MS));
  }

  #jittered(ms: number): number {
    return Math.round(ms * (1 + (this.#random() * 2 - 1) * JITTER_FRACTION));
  }

  #skewFor(id: string): number {
    const existing = this.#skew.get(id);
    if (existing !== undefined) return existing;
    const fresh = this.#jittered(this.#skewMs);
    this.#skew.set(id, fresh);
    return fresh;
  }

  #log(line: string): void {
    this.#onLog?.(`mcpauth ${line}`);
  }
}
