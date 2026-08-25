/**
 * The broker against a real authorization server.
 *
 * Real HTTP, the real `HttpTokenEndpointClient`, and a fake provider that
 * misbehaves on request. The only two things replaced are the clock, because a
 * test that proves "refresh happens before expiry" by sleeping for an hour
 * proves nothing on a loaded machine, and the store, because SQLite persistence
 * is a sibling's contract and not what any assertion here is about.
 *
 * Every test is here because of a specific way this can go wrong in
 * production, not to cover a line. The concurrency test, the omitted successor
 * test, and the deactivated subject test each correspond to a failure mode that
 * has already cost somebody a credential.
 *
 * Waits are on the broker's own log signal rather than on a duration, so a
 * failure reads as "the refresh never happened" rather than as a timeout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { McpAuthState } from "@ompd/core";
import { McpAuthBrokerImpl } from "../src/mcpauth/broker.ts";
import { grantIdFor } from "../src/mcpauth/login.ts";
import {
  type ClientAuthMethod,
  DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS,
  HttpTokenEndpointClient,
  pickClientAuthMethod,
} from "../src/mcpauth/token-endpoint.ts";
import type { Clock, GrantInput, GrantRecord, GrantSecrets, GrantStore, LoadedGrant } from "../src/mcpauth/types.ts";
import { FakeAuthorizationServer, type FakeAuthorizationServerOptions } from "./fake-authorization-server.ts";

/** One hour, which is what the fake issues and what most real providers issue. */
const TOKEN_LIFETIME_MS = 3_600_000;
/** The broker's default skew, with the jitter pinned out by `random: () => 0.5`. */
const SKEW_MS = 60_000;

/**
 * The store, in memory, honouring the two parts of its contract the broker
 * depends on: `save` is a fresh authorization, and `rotateRefreshToken` treats
 * `undefined` as "no successor was issued, keep what is stored".
 */
class MemoryGrantStore implements GrantStore {
  readonly rows = new Map<string, GrantRecord>();
  readonly secrets = new Map<string, GrantSecrets>();
  /** Every rotation, so a test asserts what was written rather than what was returned. */
  readonly rotations: { id: string; refreshToken: string | undefined; at: number }[] = [];
  /** Makes persistence fail, to prove the broker treats it as on the critical path. */
  rotationFails = false;

  list(): GrantRecord[] {
    return [...this.rows.values()];
  }

  get(id: string): GrantRecord | undefined {
    return this.rows.get(id);
  }

  load(id: string): LoadedGrant | undefined {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    return { ...row, secrets: { ...(this.secrets.get(id) ?? {}) } };
  }

  save(input: GrantInput): GrantRecord {
    const stamp = new Date().toISOString();
    const row: GrantRecord = {
      id: input.id,
      serverName: input.serverName,
      resourceUrl: input.resourceUrl,
      issuer: input.issuer,
      tokenUrl: input.tokenUrl,
      authorizationUrl: input.authorizationUrl,
      registrationUrl: input.registrationUrl,
      clientId: input.clientId,
      ...(input.clientAuthMethod === undefined ? {} : { clientAuthMethod: input.clientAuthMethod }),
      scopes: input.scopes,
      account: input.account,
      // A fresh authorization keeps nothing from a previous row, which is
      // exactly how a `reauth_required` grant becomes usable again.
      state: "healthy",
      supportsRefresh: input.supportsRefresh,
      failures: 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    this.rows.set(input.id, row);
    this.secrets.set(input.id, { ...input.secrets });
    return row;
  }

  rotateRefreshToken(id: string, refreshToken: string | undefined, at: number): void {
    if (this.rotationFails) throw new Error("simulated store failure");
    this.rotations.push({ id, refreshToken, at });
    const row = this.rows.get(id);
    if (row === undefined) return;
    row.lastRefreshAt = at;
    row.updatedAt = new Date(at).toISOString();
    if (refreshToken === undefined) return;
    this.secrets.set(id, { ...(this.secrets.get(id) ?? {}), refreshToken });
  }

  setState(id: string, state: McpAuthState, detail?: string): void {
    const row = this.rows.get(id);
    if (row === undefined) return;
    row.state = state;
    row.detail = detail;
  }

  recordFailure(id: string, detail: string, nextAttemptAt: number): void {
    const row = this.rows.get(id);
    if (row === undefined) return;
    row.failures += 1;
    row.detail = detail;
    row.nextAttemptAt = nextAttemptAt;
  }

  clearFailures(id: string): void {
    const row = this.rows.get(id);
    if (row === undefined) return;
    row.failures = 0;
    row.nextAttemptAt = undefined;
  }

  remove(id: string): boolean {
    this.secrets.delete(id);
    return this.rows.delete(id);
  }

  close(): void {}
}

interface TestClock extends Clock {
  advance(ms: number): void;
}

interface Harness {
  fake: FakeAuthorizationServer;
  store: MemoryGrantStore;
  broker: McpAuthBrokerImpl;
  clock: TestClock;
  logs: string[];
  /** Save a grant exactly as `login.ts` would, and return its id. */
  grant(refreshToken: string, overrides?: Partial<GrantInput>): string;
  /** Resolves on the next log line containing `pattern`. The broker's own signal, not a duration. */
  nextLog(pattern: string): Promise<string>;
}

const open: Harness[] = [];

afterEach(() => {
  for (const harness of open.splice(0)) {
    harness.broker.stop();
    harness.fake.stop();
  }
});

function harness(
  opts: {
    server?: FakeAuthorizationServerOptions;
    sweepIntervalMs?: number;
    random?: () => number;
    authMethod?: ClientAuthMethod;
  } = {},
): Harness {
  const fake = new FakeAuthorizationServer(opts.server);
  const store = new MemoryGrantStore();
  let now = 1_700_000_000_000;
  const clock: TestClock = {
    now: () => now,
    advance: ms => {
      now += ms;
    },
  };

  const logs: string[] = [];
  const waiters: { pattern: string; resolve: (line: string) => void }[] = [];
  const broker = new McpAuthBrokerImpl({
    grants: store,
    // The real client, over real HTTP, against the fake. Half of what these
    // tests assert is the classification of a 503 versus an `invalid_grant`,
    // and stubbing the client would assert that against itself.
    tokens: new HttpTokenEndpointClient(),
    clock,
    onLog: line => {
      logs.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter === undefined || !line.includes(waiter.pattern)) continue;
        waiters.splice(i, 1);
        waiter.resolve(line);
      }
    },
    // Pins the jitter to exactly zero, so every deadline here is an exact
    // number rather than a range.
    random: opts.random ?? (() => 0.5),
    sweepIntervalMs: opts.sweepIntervalMs,
  });

  const built: Harness = {
    fake,
    store,
    broker,
    clock,
    logs,
    grant: (refreshToken, overrides) => {
      const id = overrides?.id ?? grantIdFor(fake.mcpUrl, overrides?.account);
      store.save({
        id,
        serverName: "fake",
        resourceUrl: fake.mcpUrl,
        issuer: fake.issuer,
        tokenUrl: `${fake.issuer}/token`,
        authorizationUrl: `${fake.issuer}/authorize`,
        clientId: "client_test",
        clientAuthMethod: opts.authMethod ?? "none",
        scopes: "mcp offline_access",
        supportsRefresh: true,
        secrets: { refreshToken },
        ...overrides,
      });
      return id;
    },
    nextLog: pattern => {
      const settled = Promise.withResolvers<string>();
      waiters.push({ pattern, resolve: settled.resolve });
      return settled.promise;
    },
  };
  open.push(built);
  return built;
}

describe("McpAuthBroker: minting and caching", () => {
  test("mints on first use, serves that token until the skew window, then refreshes", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);

    const first = await h.broker.accessTokenFor(id);
    expect(first).toEqual({ ok: true, accessToken: h.fake.lastAccessToken, tokenType: "Bearer" });
    expect(h.fake.refreshRequests).toHaveLength(1);
    expect(h.store.get(id)?.state).toBe("healthy");
    expect(h.store.get(id)?.lastRefreshAt).toBe(h.clock.now());

    // One second short of the skew window: the cached token is still good, and
    // a second exchange here would be a refresh token burned for nothing.
    h.clock.advance(TOKEN_LIFETIME_MS - SKEW_MS - 1000);
    const cached = await h.broker.accessTokenFor(id);
    expect(cached).toEqual(first);
    expect(h.fake.refreshRequests).toHaveLength(1);

    // Into the window: refreshed, and it is a different token.
    h.clock.advance(2000);
    const renewed = await h.broker.accessTokenFor(id);
    expect(renewed).toEqual({ ok: true, accessToken: h.fake.lastAccessToken, tokenType: "Bearer" });
    expect(h.fake.refreshRequests).toHaveLength(2);
    expect(renewed).not.toEqual(first);
  });

  test("the request carries the RFC 8707 resource indicator and the stored client id", async () => {
    const h = harness();
    const id = h.grant(h.fake.issueGrant().refreshToken);
    await h.broker.accessTokenFor(id);

    const request = h.fake.refreshRequests[0];
    expect(request?.resource).toBe(h.fake.mcpUrl);
    expect(request?.clientId).toBe("client_test");
    // No client secret was stored, so neither form of client authentication
    // should have been attempted.
    expect(request?.clientSecretInBody).toBe(false);
    expect(request?.basicAuth).toBe(false);
  });

  test("assumes a short life when the provider states none", async () => {
    const h = harness();
    const id = h.grant(h.fake.issueGrant().refreshToken);
    h.fake.omitExpiresIn = true;

    await h.broker.accessTokenFor(id);
    // RFC 6749 makes `expires_in` optional and recommends assuming nothing.
    // Assuming a long life means serving a dead token and reading the resulting
    // 401 as the upstream's fault.
    const expiresAt = h.clock.now() + DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS * 1000;
    expect(h.broker.summaries()[0]?.accessExpiresAt).toBe(new Date(expiresAt).toISOString());
  });

  test("sends a client secret in the body, and never anywhere it could be read", async () => {
    const h = harness();
    const secret = "client-secret-worth-stealing";
    const id = h.grant("", {
      clientAuthMethod: "client_secret_post",
      secrets: { refreshToken: h.fake.issueGrant().refreshToken, clientSecret: secret },
    });

    expect((await h.broker.accessTokenFor(id)).ok).toBe(true);
    expect(h.fake.refreshRequests[0]?.clientSecretInBody).toBe(true);
    expect(h.fake.refreshRequests[0]?.basicAuth).toBe(false);
    expect(h.logs.join("\n")).not.toContain(secret);
    expect(JSON.stringify(h.broker.summaries())).not.toContain(secret);
  });

  test("sends HTTP Basic when that is what the server advertised", async () => {
    const h = harness({ authMethod: "client_secret_basic" });
    const secret = "client-secret-worth-stealing";
    const id = h.grant("", { secrets: { refreshToken: h.fake.issueGrant().refreshToken, clientSecret: secret } });

    expect((await h.broker.accessTokenFor(id)).ok).toBe(true);
    // The header, not the body. RFC 6749 section 2.3.1 requires servers to
    // support this form and only permits them to support the other.
    expect(h.fake.refreshRequests[0]?.basicAuth).toBe(true);
    expect(h.fake.refreshRequests[0]?.clientSecretInBody).toBe(false);
    expect(h.logs.join("\n")).not.toContain(secret);
  });

  test("form-encodes every Basic credential component before base64", async () => {
    let authorization = "";
    const fetchImpl = (async (_url, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({ access_token: "access", expires_in: 60 });
    }) as typeof fetch;
    const client = new HttpTokenEndpointClient({ fetchImpl });

    await client.refresh({
      tokenUrl: "https://issuer.example.test/token",
      refreshToken: "refresh",
      clientId: "id with space!'()*",
      clientSecret: "secret with space!'()*",
      clientAuthMethod: "client_secret_basic",
    });
    const encoded = Buffer.from("id+with+space%21%27%28%29*:secret+with+space%21%27%28%29*", "utf8").toString("base64");
    expect(authorization).toBe(`Basic ${encoded}`);
  });
  test("refuses to infer a pre-registered client method from ambiguous metadata", () => {
    const both = { token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"] };
    const postOnly = { token_endpoint_auth_methods_supported: ["client_secret_post"] };
    const publicOnly = { token_endpoint_auth_methods_supported: ["none"] };

    expect(pickClientAuthMethod(publicOnly, false)).toBe("none");
    expect(pickClientAuthMethod(postOnly, true)).toBe("client_secret_post");
    expect(() => pickClientAuthMethod(both, true)).toThrow(/ambiguous/);
    expect(() => pickClientAuthMethod(both, false)).toThrow(/does not advertise public/);
    expect(() => pickClientAuthMethod({}, true)).toThrow(/ambiguous or unsupported/);
  });

  test("uses none for a public client and fails closed when the persisted method is wrong", async () => {
    const publicClient = harness({ server: { requiredTokenAuthMethod: "none" } });
    const publicId = publicClient.grant(publicClient.fake.issueGrant().refreshToken);
    expect((await publicClient.broker.accessTokenFor(publicId)).ok).toBe(true);
    expect(publicClient.fake.refreshRequests[0]).toMatchObject({ basicAuth: false, clientSecretInBody: false });

    const wrongMethod = harness({ server: { requiredTokenAuthMethod: "client_secret_basic" } });
    const wrongId = wrongMethod.grant(wrongMethod.fake.issueGrant().refreshToken);
    expect(await wrongMethod.broker.accessTokenFor(wrongId)).toMatchObject({ ok: false, state: "reauth_required" });
    expect(wrongMethod.fake.tokenRequests).toHaveLength(1);
  });
});

describe("McpAuthBroker: rotation", () => {
  test("persists the successor and presents it on the next refresh", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);

    await h.broker.accessTokenFor(id);
    const successor = h.store.secrets.get(id)?.refreshToken ?? "";
    expect(successor).not.toBe("");
    expect(successor).not.toBe(refreshToken);
    expect(h.store.rotations).toEqual([{ id, refreshToken: successor, at: h.clock.now() }]);
    // The provider has already killed the predecessor. Had the successor not
    // reached the store, this grant would now be unrecoverable.
    expect(h.fake.refreshTokenState(refreshToken)).toBe("consumed");
    expect(h.fake.refreshTokenState(successor)).toBe("live");

    h.clock.advance(TOKEN_LIFETIME_MS);
    await h.broker.accessTokenFor(id);
    expect(h.fake.refreshRequests[1]?.refreshToken).toBe(successor);
  });

  test("a store that cannot persist the successor is a failed refresh, not a served token", async () => {
    const h = harness();
    const id = h.grant(h.fake.issueGrant().refreshToken);
    h.store.rotationFails = true;

    const result = await h.broker.accessTokenFor(id);
    // The provider rotated and we could not record it. Handing the caller a
    // token here would be handing out an access token whose grant is already
    // lost, and hiding that until the token expired.
    expect(result).toMatchObject({ ok: false, state: "degraded" });
    expect(h.store.rotations).toHaveLength(0);
    // Nothing was cached either. A token held here would be served for the next
    // hour on top of a grant whose successor was never recorded: the same
    // failure, later and quieter.
    expect(await h.broker.accessTokenFor(id)).toMatchObject({ ok: false, state: "degraded" });
  });

  test("a response with no refresh_token leaves the stored one usable", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);
    h.fake.omitRefreshTokenInResponse = true;

    const first = await h.broker.accessTokenFor(id);
    expect(first.ok).toBe(true);
    // RFC 6749 section 6: nothing was issued, so nothing changed. Writing an
    // empty string here would blank a working credential.
    expect(h.store.rotations).toEqual([{ id, refreshToken: undefined, at: h.clock.now() }]);
    expect(h.store.secrets.get(id)?.refreshToken).toBe(refreshToken);
    expect(h.fake.refreshTokenState(refreshToken)).toBe("live");

    h.clock.advance(TOKEN_LIFETIME_MS);
    const second = await h.broker.accessTokenFor(id);
    expect(second.ok).toBe(true);
    expect(h.fake.refreshRequests[1]?.refreshToken).toBe(refreshToken);
  });
});

describe("McpAuthBroker: one exchange per grant", () => {
  test("twenty concurrent callers cause exactly one token request", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);

    const results = await Promise.all(Array.from({ length: 20 }, () => h.broker.accessTokenFor(id)));

    // The number that matters. Two of these redeeming the same rotating refresh
    // token is what trips a provider's reuse detection, and reuse detection
    // revokes the whole family rather than just the second request.
    expect(h.fake.refreshRequests).toHaveLength(1);
    expect(results.every(result => result.ok)).toBe(true);
    expect(new Set(results.map(result => (result.ok ? result.accessToken : "failed"))).size).toBe(1);
    expect(h.fake.refreshTokenState(refreshToken)).toBe("consumed");
  });

  test("a replayed predecessor is refused by the provider and reported as reauth_required", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);
    await h.broker.accessTokenFor(id);
    const successor = h.store.secrets.get(id)?.refreshToken ?? "";

    // A second holder of the same family: a restored backup, an imported OMP
    // row, or a second refresher. It presents the predecessor, which this
    // broker has already spent.
    h.store.secrets.set(id, { refreshToken });
    h.broker.invalidate(id);
    const outcome = await h.broker.refreshNow(id);

    expect(outcome.kind).toBe("definitive");
    expect(outcome.kind === "definitive" ? outcome.reason : "").toContain("reuse detected");
    expect(h.store.get(id)?.state).toBe("reauth_required");
    // The family, not just the replayed member. This is why the singleflight
    // above is a correctness property rather than a performance one.
    expect(h.fake.refreshTokenState(successor)).toBe("revoked");
  });
});

describe("McpAuthBroker: failure classification", () => {
  test("a 503 outage degrades the grant, keeps everything, and heals itself", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);
    h.fake.outageResponses = 1;

    const failed = await h.broker.accessTokenFor(id);
    expect(failed).toMatchObject({ ok: false, state: "degraded" });
    expect(h.store.get(id)?.failures).toBe(1);
    expect(h.store.get(id)?.nextAttemptAt).toBe(h.clock.now() + 1000);
    // Nothing cleared, nothing consumed.
    expect(h.store.secrets.get(id)?.refreshToken).toBe(refreshToken);
    expect(h.fake.refreshTokenState(refreshToken)).toBe("live");

    // Inside the backoff window the broker does not touch the network.
    const during = await h.broker.accessTokenFor(id);
    expect(during).toMatchObject({ ok: false, state: "degraded" });
    expect(h.fake.tokenRequests).toHaveLength(1);

    h.clock.advance(1000);
    const healed = await h.broker.accessTokenFor(id);
    expect(healed.ok).toBe(true);
    expect(h.store.get(id)?.failures).toBe(0);
    expect(h.store.get(id)?.nextAttemptAt).toBeUndefined();
    expect(h.store.get(id)?.state).toBe("healthy");
  });

  test("invalid_grant is definitive: reauth_required, and no further network calls", async () => {
    const h = harness();
    // A refresh token the provider has never heard of, which is what a revoked
    // or expired one looks like from here.
    const id = h.grant("rt_expired_long_ago");

    const first = await h.broker.accessTokenFor(id);
    expect(first).toMatchObject({ ok: false, state: "reauth_required" });
    expect(h.store.get(id)?.state).toBe("reauth_required");
    expect(h.fake.tokenRequests).toHaveLength(1);

    for (let attempt = 0; attempt < 3; attempt++) {
      h.clock.advance(60_000);
      expect(await h.broker.accessTokenFor(id)).toMatchObject({ ok: false, state: "reauth_required" });
    }
    // The whole point: a provider that has said no is not asked again until a
    // person authorizes, which replaces the row.
    expect(h.fake.tokenRequests).toHaveLength(1);

    h.grant(h.fake.issueGrant().refreshToken);
    const reauthorized = await h.broker.accessTokenFor(id);
    expect(reauthorized.ok).toBe(true);
    expect(h.fake.tokenRequests).toHaveLength(2);
  });

  test("a deactivated subject is refused without consuming the token, and works again on reactivation", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);
    h.fake.subjectActive = false;

    const refused = await h.broker.accessTokenFor(id);
    // `account_deactivated` is not one of RFC 6749's terminal codes, and an
    // unrecognised 4xx has to keep the grant: this one comes back on its own.
    expect(refused).toMatchObject({ ok: false, state: "degraded" });
    expect(h.fake.refreshTokenState(refreshToken)).toBe("live");
    expect(h.store.secrets.get(id)?.refreshToken).toBe(refreshToken);

    h.fake.subjectActive = true;
    h.clock.advance(1000);
    const allowed = await h.broker.accessTokenFor(id);
    expect(allowed.ok).toBe(true);
    // The same token the first attempt presented. A provider or a fake that
    // consumed it on refusal would have made this impossible, which is what
    // makes "refused, not consumed" a load-bearing rule.
    expect(h.fake.refreshRequests.map(request => request.refreshToken)).toEqual([refreshToken, refreshToken]);
  });

  test("backoff doubles from one second and stops at five minutes", async () => {
    const h = harness();
    const id = h.grant(h.fake.issueGrant().refreshToken);
    const delays: number[] = [];

    for (let attempt = 0; attempt < 12; attempt++) {
      h.fake.outageResponses = 1;
      // `refreshNow` ignores the backoff, which is what lets this loop observe
      // twelve consecutive failures without advancing the clock by an hour.
      const outcome = await h.broker.refreshNow(id);
      expect(outcome.kind).toBe("transient");
      delays.push((h.store.get(id)?.nextAttemptAt ?? 0) - h.clock.now());
    }

    expect(delays.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16_000]);
    expect(delays.at(-1)).toBe(300_000);
    expect(Math.max(...delays)).toBe(300_000);
    // Twelve failures and the grant is still whole.
    expect(h.store.get(id)?.state).toBe("degraded");
    expect(h.store.secrets.get(id)?.refreshToken).not.toBe("");
  });

  test("jitter moves the deadline without changing its order of magnitude", async () => {
    const h = harness({ random: () => 0 });
    const id = h.grant(h.fake.issueGrant().refreshToken);
    h.fake.outageResponses = 1;

    await h.broker.refreshNow(id);
    // `random() === 0` is the bottom of the range: minus twenty percent.
    expect((h.store.get(id)?.nextAttemptAt ?? 0) - h.clock.now()).toBe(800);
  });
});

describe("McpAuthBroker: grants nothing can renew", () => {
  test("a provider that does not advertise the refresh grant is reported, not polled", async () => {
    const h = harness({ server: { advertiseRefreshGrant: false } });
    // The refresh token is present and would very likely work. The metadata is
    // what says it will not, and this guard is the only thing that keeps the
    // daemon from finding out the hard way on every request.
    const id = h.grant(h.fake.issueGrant().refreshToken, { supportsRefresh: false });

    const result = await h.broker.accessTokenFor(id);
    expect(result).toMatchObject({ ok: false, state: "no_refresh_grant" });
    expect(h.store.get(id)?.state).toBe("no_refresh_grant");
    expect(h.fake.tokenRequests).toHaveLength(0);

    // Still nothing, however it is asked. There is no keepalive path in the
    // broker, so this state holds until a person authorizes again.
    await h.broker.accessTokenFor(id);
    await h.broker.refreshNow(id);
    expect(h.fake.tokenRequests).toHaveLength(0);
  });

  test("a grant with no refresh token at all is the same state, for the other reason", async () => {
    const h = harness();
    const id = h.grant("", { secrets: {} });

    const result = await h.broker.accessTokenFor(id);
    expect(result).toMatchObject({ ok: false, state: "no_refresh_grant" });
    expect(result.ok === false ? result.detail : "").toContain("issued no refresh token");
    expect(h.fake.tokenRequests).toHaveLength(0);
  });

  test("serves the login bearer for an unrenewable grant without writing it anywhere", async () => {
    const h = harness();
    const id = h.grant("", { secrets: {}, supportsRefresh: false });
    const access = "access-from-login-only";

    h.broker.acceptInitialAccessToken(id, {
      accessToken: access,
      tokenType: "Bearer",
      expiresAt: h.clock.now() + TOKEN_LIFETIME_MS,
    });

    expect(await h.broker.accessTokenFor(id)).toEqual({ ok: true, accessToken: access, tokenType: "Bearer" });
    expect(h.fake.tokenRequests).toHaveLength(0);
    expect(JSON.stringify(h.broker.summaries())).not.toContain(access);
  });
  test("an unknown grant id is refused without a network call", async () => {
    const h = harness();
    const result = await h.broker.accessTokenFor("mcpauth_deadbeefdeadbeef");
    expect(result).toMatchObject({ ok: false, state: "reauth_required" });
    expect(h.fake.tokenRequests).toHaveLength(0);
  });
});

describe("McpAuthBroker: what leaves the process", () => {
  test("summaries carry no token and no refresh material", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);
    await h.broker.accessTokenFor(id);
    const accessToken = h.fake.lastAccessToken;
    const successor = h.store.secrets.get(id)?.refreshToken ?? "";

    const summaries = h.broker.summaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({ id, state: "healthy", failures: 0, supportsRefresh: true });
    // The expiry is reported; the token is not.
    expect(summaries[0]?.accessExpiresAt).toBe(new Date(h.clock.now() + TOKEN_LIFETIME_MS).toISOString());
    // Asserted on the serialised bytes rather than on a redaction helper's own
    // output, so a field added later is covered without anybody remembering to
    // update this test.
    const wire = JSON.stringify(summaries);
    expect(wire).not.toContain(accessToken);
    expect(wire).not.toContain(refreshToken);
    expect(wire).not.toContain(successor);
    // `wired` is false because nothing has told the broker otherwise. A `true`
    // here would be a guess about a file this class cannot see.
    expect(summaries[0]?.wired).toBe(false);
  });

  test("a provider that quotes the refresh token in an error keeps it out of logs and summaries", async () => {
    const h = harness();
    const { refreshToken } = h.fake.issueGrant();
    const id = h.grant(refreshToken);
    h.fake.echoRefreshTokenInErrors = true;
    h.fake.subjectActive = false;

    const refused = await h.broker.accessTokenFor(id);
    const detail = refused.ok === false ? refused.detail : "";
    // The fake really did echo it, so the scrub is tested against a string that
    // genuinely contained the secret rather than one that never did.
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain(refreshToken);
    expect(h.logs.join("\n")).not.toContain(refreshToken);
    expect(h.logs.some(line => line.includes("[redacted]"))).toBe(true);
    expect(JSON.stringify(h.broker.summaries())).not.toContain(refreshToken);
  });

  test("invalidate drops the cached token so the next call re-mints", async () => {
    const h = harness();
    const id = h.grant(h.fake.issueGrant().refreshToken);
    const first = await h.broker.accessTokenFor(id);

    h.broker.invalidate(id);
    const second = await h.broker.accessTokenFor(id);
    expect(second.ok).toBe(true);
    expect(h.fake.refreshRequests).toHaveLength(2);
    expect(second).not.toEqual(first);
  });
});

describe("McpAuthBroker: the proactive loop", () => {
  test("start clears a refreshing row a crash left behind", async () => {
    const h = harness({ sweepIntervalMs: 5 });
    const id = h.grant(h.fake.issueGrant().refreshToken);
    // What the row looks like when a daemon died between sending the refresh
    // and writing the answer.
    h.store.setState(id, "refreshing");

    h.broker.start();
    // Nothing is in flight in a process that has just started, so reporting an
    // in-flight refresh would be reporting it forever.
    expect(h.store.get(id)?.state).toBe("degraded");
    expect(h.store.get(id)?.failures).toBe(0);
    expect(h.store.get(id)?.nextAttemptAt).toBeUndefined();
    // And it recovers on the next request rather than needing anybody.
    expect((await h.broker.accessTokenFor(id)).ok).toBe(true);
    expect(h.store.get(id)?.state).toBe("healthy");
  });

  test("refreshes a held token inside the skew window and leaves untouched grants alone", async () => {
    const h = harness({ sweepIntervalMs: 5 });
    const held = h.grant(h.fake.issueGrant().refreshToken);
    // A second grant nobody has asked for, distinguishable in the request log.
    h.grant(h.fake.issueGrant().refreshToken, {
      id: "mcpauth_untouched0000",
      account: "other",
      clientId: "client_untouched",
    });

    await h.broker.accessTokenFor(held);
    expect(h.fake.refreshRequests).toHaveLength(1);

    h.clock.advance(TOKEN_LIFETIME_MS - SKEW_MS);
    const swept = h.nextLog(`${held}: refreshed`);
    h.broker.start();
    await swept;

    expect(h.fake.refreshRequests).toHaveLength(2);
    // A sweep tick demonstrably ran, and it did not mint for the grant nobody
    // asked about. Doing so would redeem -- and on a rotating provider, burn --
    // a refresh token to produce a token no session wanted.
    expect(h.fake.refreshRequests.some(request => request.clientId === "client_untouched")).toBe(false);
  });

  test("stop() ends the loop", async () => {
    const h = harness({ sweepIntervalMs: 5 });
    const id = h.grant(h.fake.issueGrant().refreshToken);
    await h.broker.accessTokenFor(id);

    h.clock.advance(TOKEN_LIFETIME_MS - SKEW_MS);
    const swept = h.nextLog(`${id}: refreshed`);
    h.broker.start();
    await swept;
    h.broker.stop();

    const settled = h.fake.refreshRequests.length;
    h.clock.advance(TOKEN_LIFETIME_MS);
    // The one place a real delay is unavoidable: `stop()` is a claim about a
    // real `setInterval`, and the only evidence for it is several intervals
    // elapsing with nothing happening. Bounded to five ticks of a 5ms loop.
    await Bun.sleep(25);
    expect(h.fake.refreshRequests).toHaveLength(settled);
  });

  test("the sweep respects backoff and resumes once the deadline passes", async () => {
    const h = harness({ sweepIntervalMs: 5 });
    const id = h.grant(h.fake.issueGrant().refreshToken);
    await h.broker.accessTokenFor(id);

    h.fake.outageResponses = 1;
    h.clock.advance(TOKEN_LIFETIME_MS - SKEW_MS);
    const failed = h.nextLog("transient failure");
    h.broker.start();
    await failed;
    expect(h.store.get(id)?.nextAttemptAt).toBe(h.clock.now() + 1000);

    const recovered = h.nextLog(`${id}: refreshed`);
    h.clock.advance(1000);
    await recovered;
    expect(h.store.get(id)?.state).toBe("healthy");
    expect(h.store.get(id)?.failures).toBe(0);
  });
});
