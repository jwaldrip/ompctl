/**
 * The contract every piece of the MCP auth broker is built against.
 *
 * Why this subsystem exists, from the evidence rather than from theory. On this
 * machine OMP holds 27 `mcp_oauth:profile:*` credential rows. Nine of them
 * carry only `{access, refresh, expires}` -- no `tokenUrl` -- and OMP's own
 * refresh predicate is `Boolean(current.refresh && material?.tokenUrl)`, so
 * those nine cannot be refreshed by any OMP session, ever. Five more are for a
 * single URL, and OMP's refresh lease is keyed by credential *row* id, so two
 * rows holding two members of one rotating family are not serialised against
 * each other; one of them recorded `invalid_grant: Refresh token reuse
 * detected; session revoked`. Every one of those servers advertises
 * `refresh_token` in its authorization-server metadata. The grants were fine.
 * The bookkeeping around them was not.
 *
 * So: one long-lived process owns exactly one grant per (resource, account),
 * stores the material needed to renew it -- token endpoint included -- and is
 * the only thing that ever redeems a refresh token. Sessions hold nothing.
 *
 * The load-bearing detail that makes "sessions hold nothing" true rather than
 * aspirational: OMP binds a stored credential to a server by URL
 * (`mcp_oauth:profile:<profile>:<url>`). A session pointed at
 * `http://127.0.0.1:<port>/mcp/<id>` matches no stored credential, so it has
 * nothing to refresh and cannot race the daemon by construction.
 */

import type { McpAuthState, McpAuthSummary } from "@ompd/core";

/**
 * Time, injected.
 *
 * Every deadline in this subsystem is a comparison against a token expiry, and
 * a test that proves "refresh happens before expiry" by sleeping is a test that
 * proves nothing on a loaded machine. There is no global clock seam in the
 * daemon; this one is scoped to the code whose correctness is defined in terms
 * of time.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

/** Which mechanism actually protected the bytes. Reported, never assumed. */
export type VaultBackend = "keychain" | "libsecret" | "file";

/**
 * Envelope encryption for the only two values in this subsystem that are worth
 * stealing: the refresh token and the OAuth client secret.
 *
 * A vault, not a hash: unlike every other secret this daemon persists, a
 * refresh token has to be readable again to be useful, so the `auth_tokens`
 * store-the-hash pattern does not apply and cannot be stretched to fit.
 *
 * The master key lives outside the database. On macOS that is the login
 * keychain; on Linux, libsecret when it is present; otherwise a `0600` file in
 * the `0700` daemon home. Be honest about what that buys: a process already
 * running as this user can reach all three. What it stops is the database file
 * itself being a credential -- a backup, a synced folder, a copied `.db`, a
 * support bundle, a stray `SELECT *`.
 */
export interface SecretVault {
  readonly backend: VaultBackend;
  /** Encrypt to a self-describing, base64 envelope. `aad` binds the ciphertext to its row. */
  seal(plaintext: string, aad: string): string;
  /** Decrypt an envelope produced by `seal` with the same `aad`. Throws if either was tampered with. */
  open(envelope: string, aad: string): string;
}

// ---------------------------------------------------------------------------
// OAuth metadata and exchanges
// ---------------------------------------------------------------------------

/** RFC 9728 protected resource metadata, narrowed to the fields the broker reads. */
export interface ProtectedResourceMetadata {
  resource?: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
}

/** RFC 8414 authorization server metadata, narrowed to the fields the broker reads. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint: string;
  registration_endpoint?: string;
  grant_types_supported?: string[];
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

/** Everything discovery could establish about one MCP endpoint's authorization. */
export interface DiscoveredAuth {
  /** The `resource` value to bind tokens to (RFC 8707), as the resource server states it. */
  resource: string;
  issuer: string;
  metadata: AuthorizationServerMetadata;
  /** True when `grant_types_supported` names `refresh_token`. Absent metadata is not a yes. */
  supportsRefresh: boolean;
}

/** A token endpoint's success response, RFC 6749 section 5.1. */
export interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/** The authentication method registered for this OAuth client at its token endpoint. */
export type ClientAuthMethod = "client_secret_basic" | "client_secret_post" | "none";

/**
 * How a refresh attempt ended, classified before anything is written.
 *
 * The classification is the decision. `definitive` stops retrying and asks for
 * a human; `transient` keeps the grant and backs off. Getting these the wrong
 * way round is how a network blip deletes a credential, and how a revoked grant
 * hammers a token endpoint forever.
 */
export type RefreshOutcome =
  | { kind: "ok"; token: MintedAccessToken; rotated?: string }
  | { kind: "definitive"; reason: string }
  | { kind: "transient"; reason: string };

/** An access token and when it dies. Held in memory only, never persisted. */
export interface MintedAccessToken {
  accessToken: string;
  tokenType: string;
  /** Epoch ms. Derived from `expires_in` at receipt, or a conservative default when absent. */
  expiresAt: number;
  scope?: string;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * One durable grant. The non-secret half is columns; the secret half is one
 * sealed envelope.
 *
 * `id` is derived from the resource URL and account rather than random, so
 * importing the same grant twice converges instead of forking, and so the
 * loopback URL written into MCP config stays stable across daemon restarts and
 * across re-imports.
 */
export interface GrantRecord {
  id: string;
  serverName: string;
  resourceUrl: string;
  issuer: string;
  tokenUrl: string;
  authorizationUrl?: string;
  registrationUrl?: string;
  clientId: string;
  /**
   * The exact method registered for this client. Absent only in a database from
   * before this field existed; the broker refuses such a row rather than guessing.
   */
  clientAuthMethod?: ClientAuthMethod;

  /** Space-separated granted scopes, as the provider reported them. */
  scopes: string;
  account?: string;
  state: McpAuthState;
  detail?: string;
  supportsRefresh: boolean;
  failures: number;
  /** Epoch ms before which no refresh is attempted. Absent when not backing off. */
  nextAttemptAt?: number;
  /** Epoch ms of the last successful token exchange. */
  lastRefreshAt?: number;
  createdAt: string;
  updatedAt: string;
}

/** The half of a grant that never leaves the vault in plaintext. */
export interface GrantSecrets {
  refreshToken?: string;
  clientSecret?: string;
}

/** A grant plus its decrypted secrets. Never serialised, never logged, never returned over the wire. */
export interface LoadedGrant extends GrantRecord {
  secrets: GrantSecrets;
}

/** What `saveGrant` accepts when a grant is first created or re-authorized. */
export interface GrantInput {
  id: string;
  serverName: string;
  resourceUrl: string;
  issuer: string;
  tokenUrl: string;
  authorizationUrl?: string;
  registrationUrl?: string;
  clientId: string;
  /** Recorded at authorization/import, never inferred again during refresh. */
  clientAuthMethod?: ClientAuthMethod;
  scopes: string;
  account?: string;
  supportsRefresh: boolean;
  secrets: GrantSecrets;
}

/**
 * Durable grant storage.
 *
 * `rotateRefreshToken` is the one method whose contract is subtle, and it is
 * the whole reason this is an interface rather than three functions. Redeeming
 * a rotating refresh token invalidates it at the provider the instant the
 * response is written; if the successor is lost between there and disk, the
 * grant is dead and only a human can revive it. So the successor is written
 * inside a transaction, before the caller is allowed to treat the refresh as
 * having happened, and a response that carries no successor leaves the current
 * token exactly as it was (RFC 6749 section 6: the refresh token stays valid
 * unless a new one is issued).
 */
export interface GrantStore {
  list(): GrantRecord[];
  get(id: string): GrantRecord | undefined;
  /** Decrypts. Callers hold the result for as short a time as they can. */
  load(id: string): LoadedGrant | undefined;
  /** Insert or replace by id, preserving nothing from a previous row: this is a fresh authorization. */
  save(input: GrantInput): GrantRecord;
  /**
   * Atomically record the result of a refresh.
   *
   * `refreshToken` is the successor. Pass `undefined` when the response omitted
   * one, which preserves the stored token rather than blanking it.
   */
  rotateRefreshToken(id: string, refreshToken: string | undefined, at: number): void;
  /** Move a grant's state, with the one-line reason a human will read. */
  setState(id: string, state: McpAuthState, detail?: string): void;
  /** Record a transient failure and when to try again. */
  recordFailure(id: string, detail: string, nextAttemptAt: number): void;
  /** Zero the failure counter and clear any backoff. */
  clearFailures(id: string): void;
  remove(id: string): boolean;
  close(): void;
}

// ---------------------------------------------------------------------------
// Broker
// ---------------------------------------------------------------------------

/**
 * The thing that hands out access tokens.
 *
 * `accessTokenFor` is the only door. It returns a live token or explains why it
 * cannot, and it never returns an expired one hoping the upstream is lenient.
 * Concurrent callers for the same grant share one exchange: the singleflight is
 * not an optimisation here, it is what stops two callers redeeming the same
 * rotating refresh token and getting the family revoked.
 */
export interface McpAuthBroker {
  /** A live access token for `id`, refreshing if needed. */
  accessTokenFor(id: string): Promise<AccessTokenResult>;
  /** Force one refresh now, ignoring backoff. What `ompd mcp-auth refresh` calls. */
  refreshNow(id: string): Promise<RefreshOutcome>;
  /** Drop the in-memory access token for `id`, so the next call re-mints. What a 401 triggers. */
  invalidate(id: string): void;
  /** Wire-safe status for every grant. */
  summaries(): McpAuthSummary[];
  /** Start the proactive refresh loop. */
  start(): void;
  stop(): void;
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; tokenType: string }
  | { ok: false; state: McpAuthState; detail: string };

/**
 * The seam every test uses instead of the network: one function that turns a
 * refresh token into a token response, or throws.
 */
export interface TokenEndpointClient {
  refresh(input: RefreshRequest): Promise<TokenResponse>;
}

export interface RefreshRequest {
  tokenUrl: string;
  refreshToken: string;
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  clientSecret?: string;
  /** RFC 8707 resource indicator, sent when the resource server published one. */
  resource?: string;
  scope?: string;
  signal?: AbortSignal;
}

/**
 * A token endpoint's error, classified.
 *
 * `error` is the RFC 6749 code when the body carried one. `definitive` is the
 * decision derived from it plus the status, and it is deliberately conservative
 * in one direction only: an unrecognised failure is transient, because wrongly
 * keeping a dead grant costs a retry and wrongly discarding a live one costs a
 * person a browser trip.
 */
export class TokenEndpointError extends Error {
  readonly status: number;
  readonly error?: string;
  readonly definitive: boolean;

  constructor(message: string, opts: { status: number; error?: string; definitive: boolean }) {
    super(message);
    this.name = "TokenEndpointError";
    this.status = opts.status;
    this.error = opts.error;
    this.definitive = opts.definitive;
  }
}

/**
 * RFC 6749 section 5.2 codes that mean the grant is gone, plus the two the
 * spec does not name but every rotating provider returns.
 *
 * `invalid_grant` covers expiry, revocation, and reuse detection. The others
 * are here because a client that is no longer registered or no longer
 * authorized will never succeed by retrying either.
 */
export const DEFINITIVE_OAUTH_ERRORS: readonly string[] = [
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
];
