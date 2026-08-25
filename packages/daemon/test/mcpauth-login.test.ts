/**
 * Discovery and the browser round trip, against a real authorization server.
 *
 * Nothing is mocked. `beginLogin` binds a real loopback listener, the test plays
 * the browser with `fetch`, and the fake verifies the PKCE challenge the way a
 * provider does, so a login that "works" here worked over HTTP with real
 * redirects and a real code exchange.
 *
 * The discovery tests are shaped around the two things that actually vary in
 * the wild: which of the well-known documents a server publishes, and where.
 * A client that only handles one of the shapes handles about half of the
 * servers, and the ones it drops are indistinguishable from "this server has no
 * OAuth" unless the probe order is observable. Here it is: the fake records
 * every well-known path it was asked for.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { discoverAuth, registerClient } from "../src/mcpauth/discovery.ts";
import { type BeginLoginOptions, beginLogin, grantIdFor, type PendingLogin } from "../src/mcpauth/login.ts";
import { FakeAuthorizationServer, type FakeAuthorizationServerOptions } from "./fake-authorization-server.ts";

const servers: FakeAuthorizationServer[] = [];
const pending: PendingLogin[] = [];

afterEach(() => {
  for (const login of pending.splice(0)) login.cancel("test teardown");
  for (const server of servers.splice(0)) server.stop();
});

function serve(opts: FakeAuthorizationServerOptions = {}): FakeAuthorizationServer {
  const server = new FakeAuthorizationServer(opts);
  servers.push(server);
  return server;
}

/** Play the browser: follow the authorization redirect back to the loopback callback. */
async function walkBrowser(authorizationUrl: string): Promise<Response> {
  const authorize = await fetch(authorizationUrl, { redirect: "manual" });
  expect(authorize.status).toBe(302);
  const location = authorize.headers.get("location");
  expect(location).toBeString();
  return await fetch(location ?? "");
}

async function login(fake: FakeAuthorizationServer, overrides: Partial<BeginLoginOptions> = {}): Promise<PendingLogin> {
  const started = await beginLogin({ resourceUrl: fake.mcpUrl, serverName: "fake", ...overrides });
  pending.push(started);
  // A login this test abandons is cancelled in teardown, and a rejection nobody
  // has attached to yet is reported as an unhandled error against whichever
  // test happens to be running. Attaching here does not stop a test asserting
  // on the same rejection.
  void started.completed.catch(() => undefined);
  return started;
}

describe("discovery: finding the authorization server", () => {
  test("prefers the per-resource protected-resource document", async () => {
    const fake = serve({ protectedResourceDocuments: ["path"] });
    const auth = await discoverAuth(fake.mcpUrl);

    expect(auth.issuer).toBe(fake.issuer);
    expect(auth.resource).toBe(fake.mcpUrl);
    expect(auth.metadata.token_endpoint).toBe(`${fake.issuer}/token`);
    expect(fake.metadataRequests[0]).toBe("/.well-known/oauth-protected-resource/mcp");
  });

  test("falls back to the per-host protected-resource document", async () => {
    const fake = serve({ protectedResourceDocuments: ["root"] });
    const auth = await discoverAuth(fake.mcpUrl);

    expect(auth.issuer).toBe(fake.issuer);
    // The specific path was tried first and answered 404; the root document is
    // the fallback, not the first guess.
    expect(fake.metadataRequests.slice(0, 2)).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]);
  });

  test("reads the RFC 8414 insert form, the append form, and the OpenID document", async () => {
    for (const shape of ["root-insert", "path-suffix", "openid"] as const) {
      const fake = serve({ asDocuments: [shape] });
      const auth = await discoverAuth(fake.mcpUrl);
      expect(auth.metadata.token_endpoint).toBe(`${fake.issuer}/token`);
      expect(auth.issuer).toBe(fake.issuer);
    }
  });

  test("probes the three authorization server locations in the order the specs put them", async () => {
    const fake = serve({ asDocuments: ["openid"] });
    await discoverAuth(fake.mcpUrl);

    expect(fake.metadataRequests).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/tenant",
      "/tenant/.well-known/oauth-authorization-server",
      "/tenant/.well-known/openid-configuration",
    ]);
  });

  test("keeps looking past a document that answers 200 without a token endpoint", async () => {
    const fake = serve({
      asDocuments: ["root-insert", "path-suffix"],
      asDocumentsWithoutTokenEndpoint: ["root-insert"],
    });
    const auth = await discoverAuth(fake.mcpUrl);

    // "First document carrying a token endpoint wins", not "first 200 wins". A
    // client that stopped at the first 200 would report this server as having
    // no token endpoint at all.
    expect(auth.metadata.token_endpoint).toBe(`${fake.issuer}/token`);
    expect(fake.metadataRequests).toContain("/.well-known/oauth-authorization-server/tenant");
    expect(fake.metadataRequests).toContain("/tenant/.well-known/oauth-authorization-server");
  });

  test("falls back to the MCP origin when no protected-resource document exists", async () => {
    const fake = serve({ protectedResourceDocuments: [], asDocuments: ["origin-openid"] });
    const auth = await discoverAuth(fake.mcpUrl);

    // Several deployed MCP servers publish no RFC 9728 document and serve
    // authorization server metadata from the origin they answer requests on.
    expect(auth.issuer).toBe(fake.origin);
    expect(auth.metadata.token_endpoint).toBe(`${fake.issuer}/token`);
    expect(auth.resource).toBe(fake.mcpUrl);
    expect(fake.metadataRequests).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]);
  });

  test("stands the MCP URL in when the document publishes no resource indicator", async () => {
    const fake = serve();
    fake.omitResourceIndicator = true;
    expect((await discoverAuth(fake.mcpUrl)).resource).toBe(fake.mcpUrl);
  });

  test("refuses metadata that declares an issuer the resource server did not name", async () => {
    const fake = serve();
    fake.issuerOverride = "https://not-this-server.example";

    // RFC 8414 section 3.3. A resource server pointing at an issuer that then
    // claims to be somebody else is how a token gets minted for the wrong
    // audience, so the document is refused rather than used.
    await expect(discoverAuth(fake.mcpUrl)).rejects.toThrow(/different issuer/);
  });

  test("reports no refresh support when the metadata does not advertise it", async () => {
    const supporting = serve();
    expect((await discoverAuth(supporting.mcpUrl)).supportsRefresh).toBe(true);

    const withoutRefresh = serve({ advertiseRefreshGrant: false });
    // Absent or narrower metadata is never read as a yes: RFC 8414's default
    // does not include the refresh grant, and a broker told otherwise would
    // report `healthy` for something it can never renew.
    expect((await discoverAuth(withoutRefresh.mcpUrl)).supportsRefresh).toBe(false);
  });

  test("names what it probed when nothing is there", async () => {
    const fake = serve({ protectedResourceDocuments: [], asDocuments: [] });
    await expect(discoverAuth(fake.mcpUrl)).rejects.toThrow(/probed .*well-known/);
  });
});

describe("discovery: dynamic client registration", () => {
  test("registers a client and asks for the refresh grant", async () => {
    const fake = serve();
    const auth = await discoverAuth(fake.mcpUrl);
    const client = await registerClient(auth.metadata, "http://127.0.0.1:1/callback", "ompd test");

    expect(client.clientId).toStartWith("client_");
    expect(fake.registrations).toBe(1);
  });

  test("says so plainly when the server publishes no registration endpoint", async () => {
    const fake = serve();
    const auth = await discoverAuth(fake.mcpUrl);
    const { registration_endpoint: _dropped, ...withoutRegistration } = auth.metadata;

    await expect(registerClient(withoutRegistration, "http://127.0.0.1:1/callback", "ompd test")).rejects.toThrow(
      /no registration_endpoint/,
    );
  });
});

describe("beginLogin: the browser round trip", () => {
  test("completes a full PKCE authorization and returns a refreshable grant", async () => {
    const fake = serve();
    const started = await login(fake, { account: "someone@example.com", scope: "mcp" });

    expect(started.redirectUri).toStartWith("http://127.0.0.1:");
    const answered = await walkBrowser(started.authorizationUrl);
    expect(answered.status).toBe(200);

    const grant = await started.completed;
    expect(grant.id).toBe(grantIdFor(fake.mcpUrl, "someone@example.com"));
    expect(grant.serverName).toBe("fake");
    expect(grant.issuer).toBe(fake.issuer);
    expect(grant.tokenUrl).toBe(`${fake.issuer}/token`);
    expect(grant.authorizationUrl).toBe(`${fake.issuer}/authorize`);
    expect(grant.registrationUrl).toBe(`${fake.issuer}/register`);
    expect(grant.account).toBe("someone@example.com");
    expect(grant.clientId).toStartWith("client_");
    expect(fake.registrations).toBe(1);
    // The scopes the provider granted: what the caller asked for, plus the
    // `offline_access` this flow adds on its own, which is the whole reason
    // there is a refresh token to store.
    expect(started.requestedScope).toBe("mcp offline_access");
    expect(grant.scopes).toBe("mcp offline_access");
    expect(grant.secrets.refreshToken).toStartWith("rt_");
    expect(grant.supportsRefresh).toBe(true);
  });

  test("asks for offline_access and binds the request to the resource", async () => {
    const fake = serve();
    const started = await login(fake);
    const url = new URL(started.authorizationUrl);

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeString();
    expect(url.searchParams.get("state")).toBeString();
    // RFC 8707: the token is bound to the resource it is for.
    expect(url.searchParams.get("resource")).toBe(fake.mcpUrl);
    // A provider that supports refresh but was never asked for offline access
    // issues no refresh token, and the operator then gets a
    // `no_refresh_grant` that is our fault and looks like theirs.
    expect(started.requestedScope?.split(" ")).toContain("offline_access");
    expect(url.searchParams.get("scope")).toContain("offline_access");
  });

  test("sends a verifier that hashes to the challenge it advertised", async () => {
    const fake = serve();
    const started = await login(fake);
    await walkBrowser(started.authorizationUrl);
    await started.completed;

    const challenge = fake.authorizeRequests[0]?.codeChallenge ?? "";
    const verifier = fake.tokenRequests[0]?.codeVerifier ?? "";
    expect(challenge).not.toBe("");
    // The fake verifies this itself, so a successful exchange already proves it.
    // Asserted here as well because the interesting failure is the inverse
    // mistake -- sending the challenge as the verifier -- which a fake that
    // only compared strings for equality would let through.
    expect(verifier).not.toBe(challenge);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(fake.tokenRequests[0]?.redirectUri).toBe(started.redirectUri);
  });

  test("uses a supplied client instead of registering one", async () => {
    const fake = serve();
    const started = await login(fake, { clientId: "client_preregistered" });
    await walkBrowser(started.authorizationUrl);

    expect((await started.completed).clientId).toBe("client_preregistered");
    expect(fake.registrations).toBe(0);
  });

  test("answers exactly one callback, then stops accepting connections", async () => {
    const fake = serve();
    const started = await login(fake);
    await walkBrowser(started.authorizationUrl);
    await started.completed;

    // The browser's connection is still open, so a replayed callback reaches
    // the handler. It is refused rather than exchanged: the code in the first
    // one has already been spent.
    const replayed = await fetch(`${started.redirectUri}?code=code_9&state=whatever`);
    expect(replayed.status).toBe(409);
    expect(fake.tokenRequests).toHaveLength(1);

    // And nothing new is admitted. Checked at the socket rather than with
    // `fetch`, which would reuse the connection above and prove nothing about
    // whether the listener is still there.
    const port = Number(new URL(started.redirectUri).port);
    await expect(Bun.connect({ hostname: "127.0.0.1", port, socket: { data: () => undefined } })).rejects.toThrow();
  });
});

describe("beginLogin: refusing what it should refuse", () => {
  test("discards a callback carrying the wrong state, and exchanges nothing", async () => {
    const fake = serve();
    const started = await login(fake);
    // A code that exists, so the only thing wrong is the state. The exchange
    // would otherwise succeed, which is what makes this a real test of the
    // check rather than of a malformed request.
    await fetch(started.authorizationUrl, { redirect: "manual" });

    const answered = await fetch(`${started.redirectUri}?code=code_2&state=not-the-state-we-issued`);
    expect(answered.status).toBe(400);
    await expect(started.completed).rejects.toThrow(/wrong state/);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  test("surfaces a refusal at the authorization endpoint", async () => {
    const fake = serve();
    fake.denyAuthorization = true;
    const started = await login(fake);

    const answered = await walkBrowser(started.authorizationUrl);
    expect(answered.status).toBe(400);
    await expect(started.completed).rejects.toThrow(/access_denied/);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  test("times out and closes rather than leaking a listener", async () => {
    const fake = serve();
    // The duration is a parameter of the code under test, and the wait is on
    // the promise the code exposes rather than on a guessed delay.
    const started = await login(fake, { timeoutMs: 10 });

    await expect(started.completed).rejects.toThrow(/was not completed within/);
    await expect(fetch(`${started.redirectUri}?code=code_1&state=x`)).rejects.toThrow();
  });

  test("refuses a server that cannot do S256", async () => {
    const fake = serve();
    fake.codeChallengeMethods = ["plain"];

    // Refused rather than downgraded. A verifier sent in the clear is not PKCE,
    // and silently accepting weaker crypto is how it stays unnoticed.
    await expect(beginLogin({ resourceUrl: fake.mcpUrl, serverName: "fake" })).rejects.toThrow(/S256/);
  });
});

describe("beginLogin: honesty about what the provider gave us", () => {
  test("records a grant as not refreshable when no refresh token was issued", async () => {
    const fake = serve();
    // The metadata still advertises the refresh grant. The provider simply did
    // not issue a token, which is the other half of `no_refresh_grant`.
    fake.omitRefreshTokenInResponse = true;
    const started = await login(fake);
    await walkBrowser(started.authorizationUrl);

    const grant = await started.completed;
    expect(grant.secrets.refreshToken).toBeUndefined();
    expect(grant.supportsRefresh).toBe(false);
  });

  test("does not ask for offline_access a server never advertised, and reports the consequence", async () => {
    const fake = serve({ scopesSupported: ["mcp"] });
    const started = await login(fake);

    expect(started.requestedScope).toBeUndefined();
    expect(new URL(started.authorizationUrl).searchParams.get("scope")).toBeNull();

    await walkBrowser(started.authorizationUrl);
    const grant = await started.completed;
    // The fake issues a refresh token only to a client that asked for offline
    // access, exactly as real providers do. Nobody asked, so nobody got one,
    // and the grant says so instead of claiming to be refreshable.
    expect(grant.secrets.refreshToken).toBeUndefined();
    expect(grant.supportsRefresh).toBe(false);
  });
});

describe("grant ids", () => {
  test("are derived, stable, and distinct per account", () => {
    const url = "https://mcp.example.com/mcp";
    expect(grantIdFor(url)).toBe(grantIdFor(url));
    expect(grantIdFor(url)).toMatch(/^mcpauth_[0-9a-f]{16}$/);
    expect(grantIdFor(url, "a@example.com")).not.toBe(grantIdFor(url, "b@example.com"));
    // The documented derivation, byte for byte, because two independent parts
    // of the daemon mint these and they have to agree.
    const digest = createHash("sha256").update(`${url}\n`).digest("hex");
    expect(grantIdFor(url)).toBe(`mcpauth_${digest.slice(0, 16)}`);
  });
});
