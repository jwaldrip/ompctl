/**
 * Durable grant storage for Git providers (GitHub and GitLab).
 *
 * Follows the McpAuthStore pattern: metadata columns are plain SQLite text
 * for observability and auditing, while sensitive credentials (access token
 * and refresh token) are sealed into a single AES-256-GCM envelope via the vault.
 *
 * The envelope is sealed with the provider name as additional authenticated data (AAD)
 * to prevent cross-provider ciphertext swapping.
 */

import { Database } from "bun:sqlite";
import type { SecretVault } from "../mcpauth/types.ts";
import type {
  GitProvider,
  LoadedProviderGrant,
  ProviderGrantInput,
  ProviderGrantRecord,
  ProviderGrantSecrets,
} from "./types.ts";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS provider_grants (
  provider TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  secret_blob TEXT NOT NULL
);
`;

const RECORD_COLUMNS = "provider, username, scopes, expires_at, created_at, updated_at";

interface GrantRow {
  provider: string;
  username: string;
  scopes: string;
  expires_at: number | null;
  created_at: string;
  updated_at: string;
}

interface LoadedGrantRow extends GrantRow {
  secret_blob: string;
}

export class ProviderStore {
  readonly #db: Database;
  readonly #vault: SecretVault;

  constructor(path: string, vault: SecretVault) {
    this.#db = new Database(path, { create: true });
    this.#db.run(SCHEMA);
    this.#vault = vault;
  }

  get(provider: GitProvider): ProviderGrantRecord | undefined {
    const row = this.#db
      .query(`SELECT ${RECORD_COLUMNS} FROM provider_grants WHERE provider = ?`)
      .get(provider) as GrantRow | null;
    if (row === null) return undefined;
    return this.#toRecord(row);
  }

  load(provider: GitProvider): LoadedProviderGrant | undefined {
    const row = this.#db
      .query(`SELECT ${RECORD_COLUMNS}, secret_blob FROM provider_grants WHERE provider = ?`)
      .get(provider) as LoadedGrantRow | null;
    if (row === null) return undefined;

    let secrets: ProviderGrantSecrets;
    try {
      const plaintext = this.#vault.open(row.secret_blob, row.provider);
      secrets = JSON.parse(plaintext) as ProviderGrantSecrets;
    } catch {
      return undefined;
    }

    return {
      ...this.#toRecord(row),
      secrets,
    };
  }

  save(input: ProviderGrantInput): ProviderGrantRecord {
    const now = new Date().toISOString();
    const existing = this.get(input.provider);
    const createdAt = existing?.createdAt ?? now;
    const secretBlob = this.#vault.seal(JSON.stringify(input.secrets), input.provider);

    this.#db
      .query(
        `INSERT OR REPLACE INTO provider_grants (
          provider, username, scopes, expires_at, created_at, updated_at, secret_blob
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.provider, input.username, input.scopes, input.expiresAt ?? null, createdAt, now, secretBlob);

    return {
      provider: input.provider,
      username: input.username,
      scopes: input.scopes,
      expiresAt: input.expiresAt,
      createdAt,
      updatedAt: now,
    };
  }

  remove(provider: GitProvider): boolean {
    const res = this.#db.query("DELETE FROM provider_grants WHERE provider = ?").run(provider);
    return res.changes > 0;
  }

  list(): ProviderGrantRecord[] {
    const rows = this.#db.query(`SELECT ${RECORD_COLUMNS} FROM provider_grants`).all() as GrantRow[];
    return rows.map(r => this.#toRecord(r));
  }

  close(): void {
    this.#db.close();
  }

  #toRecord(row: GrantRow): ProviderGrantRecord {
    return {
      provider: row.provider as GitProvider,
      username: row.username,
      scopes: row.scopes,
      expiresAt: row.expires_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
