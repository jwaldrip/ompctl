/**
 * A real authorization server, on a real socket, that behaves badly on request.
 *
 * Every interesting property of the broker is a property of how it reacts to a
 * provider, and the reactions worth testing are the ones a provider only
 * exhibits at 3am: a rotating refresh token whose predecessor was replayed, a
 * subject deactivated between two renewals, a response that quietly omits the
 * successor, a five-minute 503. Mocking `fetch` would test the broker against
 * this file's *opinion* of HTTP; `Bun.serve` tests it against HTTP.
 *
 * The one rule this fake keeps religiously, because it is the rule real
 * providers keep and the rule a careless fake breaks: **a refused request does
 * not consume the presented refresh token.** A fake that burned the token on
 * every 503 would make a passing backoff test meaningless, because the retry
 * could never have worked.
 *
 * The authorization server lives under `/tenant` rather than at the root so the
 * three RFC 8414 / OpenID document locations are three distinct URLs, which is
 * the only way discovery's ordering can actually be observed.
 */

import { createHash } from "node:crypto";
import type { Server } from "bun";

/** Where a given metadata document is served. All three are deployed in the wild. */
export type AsDocumentShape =
  /** RFC 8414: the well-known segment inserted between host and issuer path. */
  | "root-insert"
  /** RFC 8414 as many servers actually deploy it: appended to the issuer path. */
  | "path-suffix"
  /** OpenID Connect Discovery, appended to the issuer path. */
  | "openid"
  /** OpenID Connect Discovery at the origin, for servers that publish no RFC 9728 document. */
  | "origin-openid";

/** RFC 9728 documents can be per-resource or per-host. */
export type ProtectedResourceShape = "path" | "root";

export interface TokenRequestRecord {
  grantType: string;
  refreshToken?: string;
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  clientId?: string;
  scope?: string;
  resource?: string;
  /** Whether `client_secret` rode in the form body. */
  clientSecretInBody: boolean;
  /** Whether an HTTP Basic `Authorization` header was present. */
  basicAuth: boolean;
}

export interface AuthorizeRequestRecord {
  clientId: string | null;
  redirectUri: string | null;
  state: string | null;
  scope: string | null;
  resource: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
}

export interface FakeAuthorizationServerOptions {
  /** Which RFC 9728 documents exist. Empty models a server that publishes none. */
  protectedResourceDocuments?: ProtectedResourceShape[];
  /** Which authorization server documents exist, and where. */
  asDocuments?: AsDocumentShape[];
  /** Documents served without a `token_endpoint`, to prove discovery keeps looking. */
  asDocumentsWithoutTokenEndpoint?: AsDocumentShape[];
  /** Whether `grant_types_supported` names `refresh_token`. */
  advertiseRefreshGrant?: boolean;
  /** Whether a redeemed refresh token is replaced by a successor. */
  rotateRefreshTokens?: boolean;
  /** Whether a refresh token is only issued when `offline_access` was requested. */
  requireOfflineAccessForRefresh?: boolean;
  accessTokenLifetimeSeconds?: number;
  scopesSupported?: string[];
}

/** The state of one refresh token, as the server sees it. */
export type RefreshTokenState = "live" | "consumed" | "revoked" | "unknown";

interface RefreshTokenEntry {
  family: string;
  consumed: boolean;
}

interface FamilyEntry {
  revoked: boolean;
  scope: string;
}

interface CodeEntry {
  challenge: string;
  redirectUri: string;
  scope: string;
  used: boolean;
}

export class FakeAuthorizationServer {
  readonly origin: string;
  /** The issuer the protected-resource document names. Deliberately path-bearing. */
  readonly issuer: string;
  /** The MCP endpoint this server protects. */
  readonly mcpUrl: string;

  /** Every POST to the token endpoint, in order, including the refused ones. */
  readonly tokenRequests: TokenRequestRecord[] = [];
  /** Every GET to the authorization endpoint. */
  readonly authorizeRequests: AuthorizeRequestRecord[] = [];
  /** Every well-known path that was probed, in order. Discovery's ordering is observable here. */
  readonly metadataRequests: string[] = [];
  registrations = 0;

  // Controls. All mutable: a test flips one between two calls.
  advertiseRefreshGrant: boolean;
  rotateRefreshTokens: boolean;
  requireOfflineAccessForRefresh: boolean;
  /** Answer the response without a `refresh_token`, leaving the presented one valid. */
  omitRefreshTokenInResponse = false;
  /** When false, every refresh is refused with a non-standard code and the token survives. */
  subjectActive = true;
  /** Answer 503 for this many more token requests, consuming nothing. */
  outageResponses = 0;
  /** Quote the presented refresh token in error descriptions, the way a careless provider does. */
  echoRefreshTokenInErrors = false;
  /** Refuse at the authorization endpoint, as a person clicking "no" does. */
  denyAuthorization = false;
  /** Declare an issuer the protected-resource document did not name, which RFC 8414 section 3.3 forbids. */
  issuerOverride: string | undefined;
  /** Publish a protected-resource document with no `resource`, so the MCP URL has to stand in. */
  omitResourceIndicator = false;
  /** What the authorization server claims to support. Anything without S256 must be refused outright. */
  codeChallengeMethods = ["S256"];
  accessTokenLifetimeSeconds: number;
  /** Answer without `expires_in`, which RFC 6749 permits and which forces the client to assume. */
  omitExpiresIn = false;
  scopesSupported: string[];
  protectedResourceDocuments: Set<ProtectedResourceShape>;
  asDocuments: Set<AsDocumentShape>;
  asDocumentsWithoutTokenEndpoint: Set<AsDocumentShape>;

  /** The most recently minted access token, so a test can assert on the exact string. */
  lastAccessToken = "";

  readonly #server: Server<unknown>;
  readonly #refreshTokens = new Map<string, RefreshTokenEntry>();
  readonly #families = new Map<string, FamilyEntry>();
  readonly #codes = new Map<string, CodeEntry>();
  #seq = 0;

  constructor(opts: FakeAuthorizationServerOptions = {}) {
    this.advertiseRefreshGrant = opts.advertiseRefreshGrant ?? true;
    this.rotateRefreshTokens = opts.rotateRefreshTokens ?? true;
    this.requireOfflineAccessForRefresh = opts.requireOfflineAccessForRefresh ?? true;
    this.accessTokenLifetimeSeconds = opts.accessTokenLifetimeSeconds ?? 3600;
    this.scopesSupported = opts.scopesSupported ?? ["mcp", "offline_access"];
    this.protectedResourceDocuments = new Set(opts.protectedResourceDocuments ?? ["path"]);
    this.asDocuments = new Set(opts.asDocuments ?? ["path-suffix"]);
    this.asDocumentsWithoutTokenEndpoint = new Set(opts.asDocumentsWithoutTokenEndpoint ?? []);

    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request => this.#handle(request),
    });
    this.origin = `http://127.0.0.1:${this.#server.port}`;
    this.issuer = `${this.origin}/tenant`;
    this.mcpUrl = `${this.origin}/mcp`;
  }

  stop(): void {
    this.#server.stop(true);
  }

  /**
   * Mint a grant without walking the browser flow.
   *
   * The broker tests are about renewal, not authorization, and making each of
   * them complete a PKCE round trip would put a hundred lines of irrelevant
   * setup between the test and the thing it asserts.
   */
  issueGrant(scope = "mcp offline_access"): { refreshToken: string; family: string } {
    const family = this.#mintFamily(scope);
    return { refreshToken: this.#mintRefreshToken(family), family };
  }

  /** What the server thinks of a refresh token. The assertion that proves a refusal did not consume it. */
  refreshTokenState(token: string): RefreshTokenState {
    const entry = this.#refreshTokens.get(token);
    if (entry === undefined) return "unknown";
    if (this.#families.get(entry.family)?.revoked === true) return "revoked";
    return entry.consumed ? "consumed" : "live";
  }

  /** Token requests that were actually refresh grants. */
  get refreshRequests(): TokenRequestRecord[] {
    return this.tokenRequests.filter(record => record.grantType === "refresh_token");
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.includes("/.well-known/")) {
      this.metadataRequests.push(path);
      return this.#metadata(path);
    }
    if (path === "/tenant/authorize") return this.#authorize(url);
    if (path === "/tenant/register" && request.method === "POST") return this.#register(request);
    if (path === "/tenant/token" && request.method === "POST") return await this.#token(request);
    return new Response("not found", { status: 404 });
  }

  #metadata(path: string): Response {
    if (path === "/.well-known/oauth-protected-resource/mcp" && this.protectedResourceDocuments.has("path")) {
      return json(200, this.#protectedResourceDocument());
    }
    if (path === "/.well-known/oauth-protected-resource" && this.protectedResourceDocuments.has("root")) {
      return json(200, this.#protectedResourceDocument());
    }
    if (path === "/.well-known/oauth-authorization-server/tenant" && this.asDocuments.has("root-insert")) {
      return json(200, this.#asDocument("root-insert"));
    }
    if (path === "/tenant/.well-known/oauth-authorization-server" && this.asDocuments.has("path-suffix")) {
      return json(200, this.#asDocument("path-suffix"));
    }
    if (path === "/tenant/.well-known/openid-configuration" && this.asDocuments.has("openid")) {
      return json(200, this.#asDocument("openid"));
    }
    if (path === "/.well-known/openid-configuration" && this.asDocuments.has("origin-openid")) {
      return json(200, this.#asDocument("origin-openid"));
    }
    return new Response("not found", { status: 404 });
  }

  #protectedResourceDocument(): Record<string, unknown> {
    const document: Record<string, unknown> = {
      resource: this.mcpUrl,
      authorization_servers: [this.issuer],
      scopes_supported: this.scopesSupported,
    };
    if (this.omitResourceIndicator) delete document.resource;
    return document;
  }

  #asDocument(shape: AsDocumentShape): Record<string, unknown> {
    const document: Record<string, unknown> = {
      // A document served at the origin belongs to the origin. Discovery only
      // enforces RFC 8414's issuer match when a protected-resource document
      // named the issuer, and this shape exists for the servers that publish no
      // such document.
      issuer: this.issuerOverride ?? (shape === "origin-openid" ? this.origin : this.issuer),
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      grant_types_supported: this.advertiseRefreshGrant
        ? ["authorization_code", "refresh_token"]
        : ["authorization_code"],
      scopes_supported: this.scopesSupported,
      code_challenge_methods_supported: this.codeChallengeMethods,
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    };
    if (this.asDocumentsWithoutTokenEndpoint.has(shape)) delete document.token_endpoint;
    return document;
  }

  async #register(request: Request): Promise<Response> {
    this.registrations += 1;
    const body = (await request.json()) as { redirect_uris?: unknown };
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (redirects.length === 0) return json(400, { error: "invalid_redirect_uri" });
    return json(201, {
      client_id: `client_${++this.#seq}`,
      client_id_issued_at: 0,
      redirect_uris: redirects,
    });
  }

  #authorize(url: URL): Response {
    const record: AuthorizeRequestRecord = {
      clientId: url.searchParams.get("client_id"),
      redirectUri: url.searchParams.get("redirect_uri"),
      state: url.searchParams.get("state"),
      scope: url.searchParams.get("scope"),
      resource: url.searchParams.get("resource"),
      codeChallenge: url.searchParams.get("code_challenge"),
      codeChallengeMethod: url.searchParams.get("code_challenge_method"),
    };
    this.authorizeRequests.push(record);

    const { redirectUri, state, codeChallenge, codeChallengeMethod } = record;
    if (redirectUri === null || codeChallenge === null || codeChallengeMethod !== "S256") {
      return new Response("invalid authorization request", { status: 400 });
    }

    const back = new URL(redirectUri);
    if (state !== null) back.searchParams.set("state", state);
    if (this.denyAuthorization) {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "the person said no");
      return redirect(back);
    }

    const code = `code_${++this.#seq}`;
    this.#codes.set(code, {
      challenge: codeChallenge,
      redirectUri,
      scope: record.scope ?? "",
      used: false,
    });
    back.searchParams.set("code", code);
    return redirect(back);
  }

  async #token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type") ?? "";
    this.tokenRequests.push({
      grantType,
      refreshToken: form.get("refresh_token") ?? undefined,
      code: form.get("code") ?? undefined,
      codeVerifier: form.get("code_verifier") ?? undefined,
      redirectUri: form.get("redirect_uri") ?? undefined,
      clientId: form.get("client_id") ?? undefined,
      scope: form.get("scope") ?? undefined,
      resource: form.get("resource") ?? undefined,
      clientSecretInBody: form.get("client_secret") !== null,
      basicAuth: request.headers.get("authorization")?.startsWith("Basic ") === true,
    });

    if (this.outageResponses > 0) {
      this.outageResponses -= 1;
      // Nothing is consumed. An outage that burned the caller's refresh token
      // would make every retry hopeless, and `degraded` promises the opposite.
      return json(503, { error: "temporarily_unavailable", error_description: "upstream is having a moment" });
    }

    if (grantType === "authorization_code") return this.#authorizationCodeGrant(form);
    if (grantType === "refresh_token") return this.#refreshGrant(form);
    return json(400, { error: "unsupported_grant_type" });
  }

  #authorizationCodeGrant(form: URLSearchParams): Response {
    const code = form.get("code") ?? "";
    const entry = this.#codes.get(code);
    if (entry === undefined || entry.used) {
      return json(400, { error: "invalid_grant", error_description: "unknown or replayed authorization code" });
    }
    entry.used = true;

    const verifier = form.get("code_verifier") ?? "";
    // RFC 7636: BASE64URL(SHA256(ASCII(verifier))). Computed rather than
    // assumed, so a client that sends the challenge instead of the verifier
    // fails here rather than passing a test it should not.
    if (createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) {
      return json(400, { error: "invalid_grant", error_description: "pkce verification failed" });
    }
    if (form.get("redirect_uri") !== entry.redirectUri) {
      return json(400, { error: "invalid_grant", error_description: "redirect_uri does not match" });
    }

    const family = this.#mintFamily(entry.scope);
    const asked = entry.scope.split(/\s+/).includes("offline_access");
    // A provider issues a refresh token when it supports the grant and was
    // asked for offline access. Both halves matter: this is what makes "the
    // client remembered to ask" a testable property rather than a hope.
    const eligible =
      this.advertiseRefreshGrant && !this.omitRefreshTokenInResponse && (asked || !this.requireOfflineAccessForRefresh);
    return json(200, {
      access_token: this.#mintAccessToken(),
      token_type: "Bearer",
      expires_in: this.omitExpiresIn ? undefined : this.accessTokenLifetimeSeconds,
      refresh_token: eligible ? this.#mintRefreshToken(family) : undefined,
      scope: entry.scope,
    });
  }

  #refreshGrant(form: URLSearchParams): Response {
    const presented = form.get("refresh_token") ?? "";
    const echo = this.echoRefreshTokenInErrors ? ` (presented ${presented})` : "";
    const entry = this.#refreshTokens.get(presented);
    if (entry === undefined) {
      return json(400, { error: "invalid_grant", error_description: `unknown refresh token${echo}` });
    }

    const family = this.#families.get(entry.family);
    if (family === undefined || family.revoked) {
      return json(400, { error: "invalid_grant", error_description: `session revoked${echo}` });
    }

    if (entry.consumed) {
      // Reuse detection, as every rotating provider implements it: the replay
      // does not merely fail, it takes the whole family with it. This is the
      // exact failure one of the OMP credential rows recorded.
      family.revoked = true;
      return json(400, {
        error: "invalid_grant",
        error_description: `Refresh token reuse detected; session revoked${echo}`,
      });
    }

    if (!this.subjectActive) {
      // Refused, and nothing consumed. `account_deactivated` is not an RFC 6749
      // code, which is the point: an unrecognised 4xx has to be treated as
      // transient, and this grant is exactly as valid as it was a moment ago.
      return json(400, { error: "account_deactivated", error_description: `subject is deactivated${echo}` });
    }

    let successor: string | undefined;
    if (this.omitRefreshTokenInResponse) {
      // RFC 6749 section 6: no new refresh token means the presented one stays
      // valid. Consuming it here and issuing nothing would hand out a grant
      // that is already dead.
    } else if (this.rotateRefreshTokens) {
      entry.consumed = true;
      successor = this.#mintRefreshToken(entry.family);
    }

    return json(200, {
      access_token: this.#mintAccessToken(),
      token_type: "Bearer",
      expires_in: this.omitExpiresIn ? undefined : this.accessTokenLifetimeSeconds,
      refresh_token: successor,
      scope: family.scope,
    });
  }

  #mintFamily(scope: string): string {
    const family = `fam_${++this.#seq}`;
    this.#families.set(family, { revoked: false, scope });
    return family;
  }

  #mintRefreshToken(family: string): string {
    const token = `rt_${family}_${++this.#seq}`;
    this.#refreshTokens.set(token, { family, consumed: false });
    return token;
  }

  #mintAccessToken(): string {
    this.lastAccessToken = `at_${++this.#seq}_${crypto.randomUUID()}`;
    return this.lastAccessToken;
  }
}

/** `JSON.stringify` drops `undefined` fields, which is exactly how an omitted `refresh_token` is modelled. */
function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function redirect(to: URL): Response {
  return new Response(null, { status: 302, headers: { location: to.toString() } });
}
