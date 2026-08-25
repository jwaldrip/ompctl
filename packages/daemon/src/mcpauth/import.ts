/**
 * The one-time move of OMP's existing MCP OAuth credentials into the daemon.
 *
 * This module is read-only against `~/.omp`, and not as a convention: the only
 * paths it ever opens for writing are inside a temp directory it created with
 * `mkdtempSync`, and the only handle it opens on a database is `readonly` on a
 * copy. There is no code path here that can reach the operator's agent
 * directory with a writable file descriptor, so "importing copies, it never
 * moves" is a property of the file rather than a promise about it.
 *
 * Why a copy and not the live file. `agent.db` belongs to a process that may be
 * mid-transaction while this runs; opening it, even readonly, takes locks and
 * participates in that process's WAL. Copying it first means a concurrent OMP
 * write cannot be disturbed by anything happening here. And copying `-wal` and
 * `-shm` alongside it is not tidiness: in WAL mode the most recent commits live
 * in the `-wal` file, so a copy of `agent.db` alone is either missing them or
 * unreadable outright.
 *
 * Why the schema version is a hard gate. This reads a table whose shape is
 * OMP's to change. A migration that guesses at an unrecognised schema is how a
 * person's credentials get misread, half-imported, and reported as fine, so an
 * unknown version stops the import and says which version it found.
 *
 * Why it refuses while an `omp auth-broker serve` is listening. The whole point
 * of this subsystem is that exactly one process ever redeems a given refresh
 * token: rotating families are invalidated at the provider the moment a
 * successor is issued, and two redeemers produce precisely the
 * `invalid_grant: Refresh token reuse detected; session revoked` this machine
 * already recorded once. Importing into a second refresher would recreate that
 * by hand.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clock, DiscoveredAuth, GrantStore } from "./types.ts";
import { systemClock } from "./types.ts";

/**
 * The `auth_credentials` schema versions this build has actually been read
 * against. Version 6 is what is on this machine; nothing else is guessed at.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [6];

/** Where `omp auth-broker serve` listens. */
export const OMP_AUTH_BROKER_PORT = 8765;

/** `mcp_oauth:profile:<profile>:<url>`, which is how OMP keys an MCP OAuth credential. */
const PROVIDER_PATTERN = /^mcp_oauth:profile:(?<profile>[^:]+):(?<url>.+)$/;

/**
 * Epoch milliseconds above this, epoch seconds below it.
 *
 * `1e11` seconds is the year 5138 and `1e11` milliseconds is 1973, so no real
 * timestamp is ambiguous. OMP's `expires` is written by JavaScript and is
 * therefore milliseconds in practice, but a token endpoint's `expires_in`
 * arriving in seconds and being stored unconverted is a common enough bug that
 * treating one as the other silently would report every live grant as expired.
 */
const MILLISECOND_FLOOR = 1e11;

/** The credential material OMP may have retained, kept non-enumerable on its row. */
export interface OmpCredentialSecrets {
  refreshToken?: string;
  clientSecret?: string;
  /** OMP's recorded registered client method. Never inferred from current metadata. */
  clientAuthMethod?: "client_secret_basic" | "client_secret_post" | "none";
}

/**
 * One `mcp_oauth:*` row, as this import needs it.
 *
 * The access token is deliberately not here in any form beyond `hasAccess`. The
 * daemon re-mints one on first use, so carrying the value would put a bearer
 * token through a report, a plan and a log for no reason at all.
 *
 * `secrets` is defined non-enumerable, which is what makes the secrets
 * discipline structural instead of aspirational: `JSON.stringify(row)`,
 * `{ ...row }`, `Object.entries(row)` and `console.log(row)` all produce the
 * row without them. Reaching the values takes naming the field.
 */
export interface OmpCredentialRow {
  id: number;
  profile: string;
  resourceUrl: string;
  credentialType: string;
  identityKey?: string;
  /** OMP's own reason for having stopped using this row, verbatim. Never a token. */
  disabledCause?: string;
  createdAt: number;
  updatedAt: number;
  hasAccess: boolean;
  hasRefresh: boolean;
  /** Epoch ms, normalised. Absent when the row recorded no expiry. */
  expiresAt?: number;
  tokenUrl?: string;
  clientId?: string;
  resource?: string;
  authorizationUrl?: string;
  /** Granted scopes as the provider reported them, when the row kept them. */
  scope?: string;
  /** True when `data` did not parse. Nothing else on the row can be trusted. */
  unreadable: boolean;
  secrets: OmpCredentialSecrets;
}

/** One grant the import intends to create. */
export interface PlannedImport {
  row: OmpCredentialRow;
  /** The name the grant is recorded under. */
  serverName: string;
  /** Which account at the provider, when OMP recorded one. Part of the grant id. */
  account?: string;
}

/** A row the import did not take, and the reason a person will read. */
export interface SkippedRow {
  id: number;
  profile: string;
  resourceUrl: string;
  reason: string;
}

/**
 * What the import is going to do, in full.
 *
 * `dropped` and `notImportable` exist because "imported 8 of 27" with no
 * reasons is not a migration report, it is a shrug. Every row that came out of
 * the database appears in exactly one of the three lists.
 */
export interface ImportPlan {
  imports: PlannedImport[];
  /** Not considered: unreadable, another profile, disabled by OMP, or superseded. */
  dropped: SkippedRow[];
  /** Selected, but carrying nothing renewable. Reported rather than imported broken. */
  notImportable: SkippedRow[];
}

export interface PlanImportOptions {
  /** Restrict to these OMP profiles. Default: every profile present in the rows. */
  profiles?: readonly string[];
  /** Names the grant. Default: the resource URL's host with dots as dashes. */
  serverName?: (row: OmpCredentialRow) => string;
}

export interface ImportDeps {
  /**
   * RFC 9728 then RFC 8414 discovery for one MCP endpoint.
   *
   * Injected because it is the only thing in an import that touches the
   * network, and because it is what recovers the token endpoint for the rows
   * that have none -- which is the entire reason those grants are dead in OMP.
   */
  discover: (resourceUrl: string) => Promise<DiscoveredAuth>;
  grants: GrantStore;
  clock?: Clock;
  /** Injected so a test never opens a socket. Defaults to the real probe. */
  probe?: () => Promise<boolean>;
  /** Import anyway, with the second-redeemer risk taken on knowingly. */
  force?: boolean;
}

export type ImportOutcome =
  | {
      ok: true;
      grantId: string;
      resourceUrl: string;
      serverName: string;
      /** True when discovery supplied the token endpoint because the row had none. */
      tokenUrlRecovered: boolean;
      /** False when OMP recorded no client id, which no discovery can supply. */
      clientIdKnown: boolean;
      supportsRefresh: boolean;
      /** Whether the access token OMP held was already dead. Informational; it is never copied. */
      accessExpired: boolean;
    }
  | { ok: false; resourceUrl: string; serverName: string; reason: string };

export type ImportRun =
  | { ok: true; outcomes: ImportOutcome[]; dropped: SkippedRow[]; notImportable: SkippedRow[] }
  | { ok: false; reason: "omp_auth_broker_running"; detail: string };

/**
 * The stable grant id.
 *
 * Derived rather than random so importing the same grant twice converges
 * instead of forking, and so the loopback URL written into MCP config survives
 * a restart and a re-import unchanged. Several slices mint these; they have to
 * agree byte for byte, so the input is spelled out here and nowhere else.
 */
export function deriveGrantId(resourceUrl: string, account?: string): string {
  const digest = createHash("sha256")
    .update(`${resourceUrl}\n${account ?? ""}`)
    .digest("hex");
  return `mcpauth_${digest.slice(0, 16)}`;
}

/**
 * Every `mcp_oauth:*` row in OMP's credential store, read from a copy.
 *
 * The copy is what makes a concurrent OMP write impossible to disturb, and it
 * is deleted in a `finally` whether the read threw or not: a temp copy of a
 * credential database left behind would be exactly the "database file as a
 * credential" problem the vault exists to avoid.
 */
export function readOmpCredentials(agentDbPath: string): OmpCredentialRow[] {
  const staging = mkdtempSync(join(tmpdir(), "ompd-mcpauth-import-"));
  try {
    const copy = join(staging, "agent.db");
    copyFileSync(agentDbPath, copy);
    // In WAL mode the newest commits are in `-wal`, and a readonly open needs
    // `-shm` to read them. Copying only `agent.db` does not read stale here, it
    // fails to open at all -- which is a better failure than a stale one, and a
    // reason to copy all three rather than rely on that.
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${agentDbPath}${suffix}`)) copyFileSync(`${agentDbPath}${suffix}`, `${copy}${suffix}`);
    }
    const db = new Database(copy, { readonly: true });
    try {
      assertSupportedSchema(db, agentDbPath);
      const rows = db
        .query(
          "select id, provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at " +
            "from auth_credentials",
        )
        .all();
      return rows.flatMap(row => parseCredentialRow(row));
    } finally {
      db.close();
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Decide which rows become grants.
 *
 * Grouping is by resource URL because that, plus the account, is what a grant
 * is: OMP's five rows for one `mail.vendor.test` are five members of one
 * rotating family that its row-keyed refresh lease never serialised, and
 * importing all five would rebuild that race inside the daemon.
 */
export function planImport(rows: readonly OmpCredentialRow[], opts: PlanImportOptions = {}): ImportPlan {
  const dropped: SkippedRow[] = [];
  const notImportable: SkippedRow[] = [];
  const byUrl: Record<string, OmpCredentialRow[]> = {};

  for (const row of rows) {
    if (row.unreadable) {
      // Deliberately says nothing about the contents: the field that failed to
      // parse is the one holding the tokens.
      dropped.push(skip(row, "its stored credential data did not parse"));
      continue;
    }
    if (opts.profiles !== undefined && !opts.profiles.includes(row.profile)) {
      dropped.push(skip(row, `profile ${row.profile} was not selected for import`));
      continue;
    }
    if (row.disabledCause !== undefined) {
      dropped.push(skip(row, `OMP had already disabled it: ${row.disabledCause}`));
      continue;
    }
    const group = byUrl[row.resourceUrl] ?? [];
    group.push(row);
    byUrl[row.resourceUrl] = group;
  }

  const imports: PlannedImport[] = [];
  for (const group of Object.values(byUrl)) {
    // Newest wins, with the row id as the tiebreak so two rows written in the
    // same millisecond still order deterministically.
    const ordered = [...group].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
    const [winner, ...rest] = ordered;
    if (winner === undefined) continue;
    for (const loser of rest) {
      dropped.push(skip(loser, `superseded by the newer row ${winner.id} for the same URL`));
    }
    if (!winner.hasRefresh) {
      notImportable.push(skip(winner, "it holds no refresh token, so only a fresh authorization can renew it"));
      continue;
    }
    imports.push({
      row: winner,
      serverName: opts.serverName?.(winner) ?? defaultServerName(winner.resourceUrl),
      ...(winner.identityKey !== undefined ? { account: winner.identityKey } : {}),
    });
  }

  imports.sort((a, b) => a.row.id - b.row.id);
  dropped.sort((a, b) => a.id - b.id);
  notImportable.sort((a, b) => a.id - b.id);
  return { imports, dropped, notImportable };
}

/**
 * Create the grants.
 *
 * OMP's rows are never touched: this module holds no writable handle on
 * anything under the agent directory, so a half-finished import leaves OMP
 * exactly as capable (or as stuck) as it was. That is also what makes retrying
 * safe -- the grant id is derived, so a second run converges on the same rows.
 *
 * A discovery failure fails one grant and is reported. Twenty-six working
 * providers must not be held hostage by one that is down.
 */
export async function importGrants(plan: ImportPlan, deps: ImportDeps): Promise<ImportRun> {
  if (deps.force !== true) {
    const running = await (deps.probe ?? detectRunningOmpAuthBroker)();
    if (running) {
      return {
        ok: false,
        reason: "omp_auth_broker_running",
        detail:
          `an OMP auth broker is answering on 127.0.0.1:${OMP_AUTH_BROKER_PORT}; importing now would leave two ` +
          "processes redeeming one rotating refresh token family, which is what revokes it",
      };
    }
  }

  const clock = deps.clock ?? systemClock;
  const outcomes: ImportOutcome[] = [];
  for (const planned of plan.imports) {
    const { row, serverName, account } = planned;
    let discovered: DiscoveredAuth;
    try {
      discovered = await deps.discover(row.resourceUrl);
    } catch (err) {
      outcomes.push({
        ok: false,
        resourceUrl: row.resourceUrl,
        serverName,
        reason: `authorization metadata discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const tokenUrl = row.tokenUrl ?? discovered.metadata.token_endpoint;
    if (tokenUrl === undefined || tokenUrl.length === 0) {
      outcomes.push({
        ok: false,
        resourceUrl: row.resourceUrl,
        serverName,
        reason: "neither the stored credential nor discovery named a token endpoint",
      });
      continue;
    }

    const authorizationUrl = row.authorizationUrl ?? discovered.metadata.authorization_endpoint;
    const registrationUrl = discovered.metadata.registration_endpoint;
    const grantId = deriveGrantId(row.resourceUrl, account);
    const clientIdKnown = row.clientId !== undefined && row.clientId.length > 0;
    const clientAuthMethod = row.secrets.clientAuthMethod;
    const clientAuthMethodKnown = clientAuthMethod !== undefined;
    deps.grants.save({
      id: grantId,
      serverName,
      resourceUrl: row.resourceUrl,
      issuer: discovered.issuer,
      tokenUrl,
      ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
      ...(registrationUrl !== undefined ? { registrationUrl } : {}),
      clientId: row.clientId ?? "",
      ...(clientAuthMethod !== undefined ? { clientAuthMethod } : {}),
      scopes: row.scope ?? "",
      ...(account !== undefined ? { account } : {}),
      supportsRefresh: discovered.supportsRefresh,
      secrets: {
        ...(row.secrets.refreshToken !== undefined ? { refreshToken: row.secrets.refreshToken } : {}),
        ...(row.secrets.clientSecret !== undefined ? { clientSecret: row.secrets.clientSecret } : {}),
      },
    });

    if (!clientIdKnown) {
      deps.grants.setState(
        grantId,
        "reauth_required",
        "OMP stored no OAuth client id for this credential, so its refresh token cannot be redeemed; reauthorize to establish one",
      );
    } else if (!clientAuthMethodKnown) {
      deps.grants.setState(
        grantId,
        "reauth_required",
        "OMP stored no OAuth client authentication method for this credential; reauthorize to establish one",
      );
    }

    outcomes.push({
      ok: true,
      grantId,
      resourceUrl: row.resourceUrl,
      serverName,
      tokenUrlRecovered: row.tokenUrl === undefined,
      clientIdKnown,
      supportsRefresh: discovered.supportsRefresh,
      accessExpired: row.expiresAt !== undefined && row.expiresAt <= clock.now(),
    });
  }

  return { ok: true, outcomes, dropped: plan.dropped, notImportable: plan.notImportable };
}

export interface BrokerProbeOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Is an `omp auth-broker serve` listening.
 *
 * Two steps because they answer different questions. The TCP connect says
 * whether anything is there at all, cheaply and without a request; the health
 * route says whether the thing there is the broker. Something else on 8765 that
 * does not answer `/v1/healthz` reads as "no broker", because refusing the
 * import on any listener would let an unrelated service block it with no way
 * for the operator to tell why.
 */
export async function detectRunningOmpAuthBroker(opts: BrokerProbeOptions = {}): Promise<boolean> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? OMP_AUTH_BROKER_PORT;
  const timeoutMs = opts.timeoutMs ?? 500;
  if (!(await tcpReachable(host, port, timeoutMs))) return false;
  const request = opts.fetch ?? ((url, init) => fetch(url, init));
  try {
    const res = await request(`http://${host}:${port}/v1/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

async function tcpReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = createConnection({ host, port });
  const settle = (reachable: boolean): void => {
    socket.destroy();
    resolve(reachable);
  };
  socket.setTimeout(timeoutMs, () => settle(false));
  socket.once("connect", () => settle(true));
  socket.once("error", () => settle(false));
  return promise;
}

/**
 * The schema gate.
 *
 * Reported with both numbers because "unsupported schema" tells the operator
 * nothing they can act on, and the two things they need are which version their
 * OMP is at and which ones this build has been read against.
 */
function assertSupportedSchema(db: Database, agentDbPath: string): void {
  const rows = db.query("select version from schema_version").all() as { version: number | null }[];
  const versions = rows.map(row => Number(row.version)).filter(version => Number.isFinite(version));
  const found = versions.length === 0 ? undefined : Math.max(...versions);
  if (found !== undefined && SUPPORTED_SCHEMA_VERSIONS.includes(found)) return;
  throw new Error(
    `${agentDbPath} is at auth schema version ${found === undefined ? "unknown" : String(found)}; ` +
      `this build reads version ${SUPPORTED_SCHEMA_VERSIONS.join(", ")} only`,
  );
}

function parseCredentialRow(raw: unknown): OmpCredentialRow[] {
  const record = raw as {
    id: number;
    provider: string;
    credential_type: string;
    data: string;
    disabled_cause: string | null;
    identity_key: string | null;
    created_at: number;
    updated_at: number;
  };
  const groups = PROVIDER_PATTERN.exec(record.provider)?.groups;
  const profile = groups?.profile;
  const resourceUrl = groups?.url;
  if (profile === undefined || resourceUrl === undefined) return [];

  const common = {
    id: record.id,
    profile,
    resourceUrl,
    credentialType: record.credential_type,
    ...(record.identity_key !== null ? { identityKey: record.identity_key } : {}),
    ...(record.disabled_cause !== null ? { disabledCause: record.disabled_cause } : {}),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };

  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(record.data);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    data = parsed as Record<string, unknown>;
  } catch {
    // The message carries no part of `data`: that string is where the tokens are.
    return [withSecrets({ ...common, hasAccess: false, hasRefresh: false, unreadable: true }, {})];
  }

  const refreshToken = stringField(data.refresh);
  const clientSecret = stringField(data.clientSecret);
  const tokenUrl = stringField(data.tokenUrl);
  const clientId = stringField(data.clientId);
  const resource = stringField(data.resource);
  const authorizationUrl = stringField(data.authorizationUrl);
  const clientAuthMethod = clientAuthMethodField(data.clientAuthMethod);
  const scope = stringField(data.scope);
  const expires = Number(data.expires);
  const expiresAt = Number.isFinite(expires)
    ? expires >= MILLISECOND_FLOOR
      ? expires
      : Math.round(expires * 1000)
    : undefined;

  return [
    withSecrets(
      {
        ...common,
        hasAccess: stringField(data.access) !== undefined,
        hasRefresh: refreshToken !== undefined,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(tokenUrl !== undefined ? { tokenUrl } : {}),
        ...(clientId !== undefined ? { clientId } : {}),
        ...(resource !== undefined ? { resource } : {}),
        ...(authorizationUrl !== undefined ? { authorizationUrl } : {}),
        ...(scope !== undefined ? { scope } : {}),
        unreadable: false,
      },
      {
        ...(refreshToken !== undefined ? { refreshToken } : {}),
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        ...(clientAuthMethod !== undefined ? { clientAuthMethod } : {}),
      },
    ),
  ];
}

/**
 * Attach the secrets so nothing that walks the row's own properties can find
 * them. `JSON.stringify`, spread, `Object.entries` and `console.log` all see a
 * row without secrets; only `row.secrets` reaches them.
 */
function withSecrets(row: Omit<OmpCredentialRow, "secrets">, secrets: OmpCredentialSecrets): OmpCredentialRow {
  Object.defineProperty(row, "secrets", { value: secrets, enumerable: false, writable: false, configurable: false });
  return row as OmpCredentialRow;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function clientAuthMethodField(value: unknown): OmpCredentialSecrets["clientAuthMethod"] {
  return value === "client_secret_basic" || value === "client_secret_post" || value === "none" ? value : undefined;
}

function skip(row: OmpCredentialRow, reason: string): SkippedRow {
  return { id: row.id, profile: row.profile, resourceUrl: row.resourceUrl, reason };
}

/**
 * A name for a grant when the caller has none to offer.
 *
 * The credential row does not record what the server was called in MCP config,
 * so this is a label rather than a claim about OMP's naming. The host is the
 * one thing in the URL that identifies the provider to a person reading a list.
 */
function defaultServerName(resourceUrl: string): string {
  try {
    return new URL(resourceUrl).hostname.replaceAll(".", "-");
  } catch {
    return resourceUrl.replaceAll(/[^A-Za-z0-9_.-]+/g, "-");
  }
}
