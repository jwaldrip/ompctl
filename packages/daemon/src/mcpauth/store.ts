/**
 * Durable grant storage for the MCP auth broker.
 *
 * One table, and one deliberate asymmetry inside it: every non-secret field is
 * a column that a human can read with `sqlite3`, and the two fields worth
 * stealing live in a single sealed blob. That split is what makes an operator
 * able to debug this subsystem -- which server, which issuer, which state, how
 * many failures, when the last refresh landed -- without the database being a
 * credential store anyone can read.
 *
 * The blob is sealed with the grant id as additional authenticated data, so a
 * `secret_blob` copied from one row into another does not open. Without that
 * binding, `UPDATE ... SET secret_blob = (SELECT secret_blob FROM ...)` would
 * be a working way to point one grant's refresh token at another grant's token
 * endpoint, and the vault would happily decrypt it.
 *
 * `list` and `get` are written with explicit column lists that do not name
 * `secret_blob`. Not as a convention: as the mechanism. `SELECT *` here would
 * put a sealed secret into every wire summary and every log line that ever
 * stringified a record, and nothing in the type system would notice.
 */

import { Database } from "bun:sqlite";
import type { McpAuthState } from "@ompd/core";
import type { GrantInput, GrantRecord, GrantSecrets, GrantStore, LoadedGrant, SecretVault } from "./types.ts";

/**
 * `id` is derived from the resource URL and account rather than random, so the
 * primary key already makes (resource_url, account) unique -- a second unique
 * index over those columns would restate the same invariant in a way that could
 * drift from the derivation.
 *
 * `secret_blob` is NOT NULL even for a grant that carries no secrets at all: an
 * empty `{}` is sealed like anything else, so there is one read path rather than
 * a nullable one whose null branch is exercised only by the rare grant.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS mcp_auth_grants (
  id TEXT PRIMARY KEY,
  server_name TEXT NOT NULL,
  resource_url TEXT NOT NULL,
  issuer TEXT NOT NULL,
  token_url TEXT NOT NULL,
  authorization_url TEXT,
  registration_url TEXT,
  client_id TEXT NOT NULL,
  scopes TEXT NOT NULL,
  account TEXT,
  state TEXT NOT NULL,
  detail TEXT,
  supports_refresh INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  last_refresh_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  secret_blob TEXT NOT NULL
);
`;

/**
 * Every column except `secret_blob`, named once.
 *
 * The reads that must not decrypt use this list, so the sealed blob is left out
 * by construction rather than by each call site remembering to leave it out.
 */
const RECORD_COLUMNS = `id, server_name, resource_url, issuer, token_url, authorization_url, registration_url,
  client_id, scopes, account, state, detail, supports_refresh, failures, next_attempt_at, last_refresh_at,
  created_at, updated_at`;

interface GrantRow {
  id: string;
  server_name: string;
  resource_url: string;
  issuer: string;
  token_url: string;
  authorization_url: string | null;
  registration_url: string | null;
  client_id: string;
  scopes: string;
  account: string | null;
  state: string;
  detail: string | null;
  supports_refresh: number;
  failures: number;
  next_attempt_at: number | null;
  last_refresh_at: number | null;
  created_at: string;
  updated_at: string;
}

export class McpAuthStore implements GrantStore {
  #db: Database;
  #vault: SecretVault;

  constructor(path: string, vault: SecretVault) {
    this.#db = new Database(path, { create: true });
    this.#db.run(SCHEMA);
    this.#vault = vault;
  }

  /** Ordered by the name an operator sees in MCP config, since that is how they will ask about a grant. */
  list(): GrantRecord[] {
    const rows = this.#db
      .query(`SELECT ${RECORD_COLUMNS} FROM mcp_auth_grants ORDER BY server_name`)
      .all() as GrantRow[];
    return rows.map(rowToRecord);
  }

  get(id: string): GrantRecord | undefined {
    const row = this.#db.query(`SELECT ${RECORD_COLUMNS} FROM mcp_auth_grants WHERE id=?`).get(id) as GrantRow | null;
    return row === null ? undefined : rowToRecord(row);
  }

  /**
   * The one read that decrypts.
   *
   * Separate from `get` so that holding a decrypted refresh token is always a
   * deliberate call rather than something a caller receives for asking about a
   * grant's state.
   */
  load(id: string): LoadedGrant | undefined {
    const row = this.#db.query(`SELECT ${RECORD_COLUMNS}, secret_blob FROM mcp_auth_grants WHERE id=?`).get(id) as
      | (GrantRow & { secret_blob: string })
      | null;
    if (row === null) return undefined;
    return { ...rowToRecord(row), secrets: JSON.parse(this.#vault.open(row.secret_blob, id)) as GrantSecrets };
  }

  /**
   * A fresh authorization, replacing any previous row for this id outright.
   *
   * `INSERT OR REPLACE` rather than an upsert that merges, because the contract
   * is that nothing survives: a re-authorization that inherited the old row's
   * failure count and backoff deadline would arrive already in trouble, and one
   * that inherited `last_refresh_at` would claim a refresh this credential
   * never had.
   *
   * The initial state is derived from one mechanical fact -- whether there is a
   * refresh token to redeem. `supportsRefresh` records what the authorization
   * server advertised and is left for the broker to act on, but a grant with no
   * stored refresh token cannot be renewed no matter what the metadata claimed,
   * and reporting it as `healthy` until the access token died would hide the
   * one thing an operator needs to know: this one needs a browser trip.
   */
  save(input: GrantInput): GrantRecord {
    const now = new Date().toISOString();
    const record: GrantRecord = {
      id: input.id,
      serverName: input.serverName,
      resourceUrl: input.resourceUrl,
      issuer: input.issuer,
      tokenUrl: input.tokenUrl,
      clientId: input.clientId,
      scopes: input.scopes,
      state: input.secrets.refreshToken === undefined ? "no_refresh_grant" : "healthy",
      supportsRefresh: input.supportsRefresh,
      failures: 0,
      createdAt: now,
      updatedAt: now,
    };
    if (input.authorizationUrl !== undefined) record.authorizationUrl = input.authorizationUrl;
    if (input.registrationUrl !== undefined) record.registrationUrl = input.registrationUrl;
    if (input.account !== undefined) record.account = input.account;

    this.#db
      .query(
        `INSERT OR REPLACE INTO mcp_auth_grants
           (id, server_name, resource_url, issuer, token_url, authorization_url, registration_url,
            client_id, scopes, account, state, detail, supports_refresh, failures, next_attempt_at,
            last_refresh_at, created_at, updated_at, secret_blob)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,0,NULL,NULL,?,?,?)`,
      )
      .run(
        record.id,
        record.serverName,
        record.resourceUrl,
        record.issuer,
        record.tokenUrl,
        record.authorizationUrl ?? null,
        record.registrationUrl ?? null,
        record.clientId,
        record.scopes,
        record.account ?? null,
        record.state,
        record.supportsRefresh ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        this.#vault.seal(JSON.stringify(input.secrets), record.id),
      );
    return record;
  }

  /**
   * Record the result of a refresh, atomically.
   *
   * `undefined` means the response carried no successor, which under RFC 6749
   * section 6 leaves the refresh token this grant already holds valid. Blanking
   * it there would destroy a live credential on the say-so of a response that
   * said nothing about it.
   *
   * The read-modify-write of the sealed blob is one transaction because the two
   * halves cannot be separated safely. A rotating provider invalidates the old
   * refresh token the instant it issues the successor, so a crash between
   * reading the blob and writing it back leaves a grant whose only stored token
   * is already dead -- unrecoverable without a person and a browser.
   *
   * An unknown id throws. The caller has just redeemed a rotating token; a
   * silent no-op would mean the successor was handed to this method and dropped.
   *
   * `state` is deliberately not touched. Exactly one method moves a grant's
   * state, and it is `setState`, so a successful refresh is two explicit writes
   * rather than a state transition hidden inside a material update.
   */
  rotateRefreshToken(id: string, refreshToken: string | undefined, at: number): void {
    this.#db.transaction(() => {
      const row = this.#db.query(`SELECT secret_blob FROM mcp_auth_grants WHERE id=?`).get(id) as {
        secret_blob: string;
      } | null;
      if (row === null) {
        throw new Error(`mcp-auth store: no grant ${id} to record a refresh against`);
      }

      const secrets = JSON.parse(this.#vault.open(row.secret_blob, id)) as GrantSecrets;
      if (refreshToken !== undefined) secrets.refreshToken = refreshToken;

      this.#db
        .query(
          `UPDATE mcp_auth_grants
             SET secret_blob=?, last_refresh_at=?, failures=0, next_attempt_at=NULL, detail=NULL, updated_at=?
           WHERE id=?`,
        )
        .run(this.#vault.seal(JSON.stringify(secrets), id), at, new Date().toISOString(), id);
    })();
  }

  setState(id: string, state: McpAuthState, detail?: string): void {
    this.#db
      .query(`UPDATE mcp_auth_grants SET state=?, detail=?, updated_at=? WHERE id=?`)
      .run(state, detail ?? null, new Date().toISOString(), id);
  }

  /**
   * A transient failure and when to try again.
   *
   * `failures` is incremented in SQL rather than read, added to, and written
   * back, so a count is never lost to an interleaving.
   */
  recordFailure(id: string, detail: string, nextAttemptAt: number): void {
    this.#db
      .query(`UPDATE mcp_auth_grants SET failures=failures+1, detail=?, next_attempt_at=?, updated_at=? WHERE id=?`)
      .run(detail, nextAttemptAt, new Date().toISOString(), id);
  }

  clearFailures(id: string): void {
    this.#db
      .query(`UPDATE mcp_auth_grants SET failures=0, next_attempt_at=NULL, detail=NULL, updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), id);
  }

  remove(id: string): boolean {
    return this.#db.query(`DELETE FROM mcp_auth_grants WHERE id=?`).run(id).changes > 0;
  }

  close(): void {
    this.#db.close();
  }
}

/**
 * A row to a record, with absent optionals absent rather than null.
 *
 * `exactOptionalPropertyTypes` aside, the difference is load bearing for the
 * wire: a summary serialised with `"detail": null` reads as a grant with an
 * empty reason, while an omitted key reads as a grant with nothing to say.
 */
function rowToRecord(row: GrantRow): GrantRecord {
  const record: GrantRecord = {
    id: row.id,
    serverName: row.server_name,
    resourceUrl: row.resource_url,
    issuer: row.issuer,
    tokenUrl: row.token_url,
    clientId: row.client_id,
    scopes: row.scopes,
    state: row.state as McpAuthState,
    supportsRefresh: row.supports_refresh === 1,
    failures: row.failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.authorization_url !== null) record.authorizationUrl = row.authorization_url;
  if (row.registration_url !== null) record.registrationUrl = row.registration_url;
  if (row.account !== null) record.account = row.account;
  if (row.detail !== null) record.detail = row.detail;
  if (row.next_attempt_at !== null) record.nextAttemptAt = row.next_attempt_at;
  if (row.last_refresh_at !== null) record.lastRefreshAt = row.last_refresh_at;
  return record;
}
