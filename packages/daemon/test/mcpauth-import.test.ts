/**
 * Taking over OMP's existing MCP OAuth credentials, tested against a synthetic
 * `agent.db` built with the real schema.
 *
 * Nothing here goes near `~/.omp`. That is not squeamishness: this import reads
 * a database another process owns, so a test that read the operator's real one
 * would be exercising the exact behaviour the module exists to make safe while
 * proving nothing about it.
 *
 * The fixture is deliberately awkward in the ways the real table is. Rows are
 * written in WAL mode with the writer still connected, because that is the state
 * a running OMP leaves and because a copy of `agent.db` without its `-wal` does
 * not read stale, it fails to open. Several rows share one URL, because five of
 * them do on this machine. Some carry `tokenUrl` and `clientId` and some carry
 * only `{access, refresh, expires}`, because that split is the entire reason
 * nine of the twenty-seven cannot be refreshed by any OMP session.
 *
 * Secrets are asserted on bytes. Every fixture refresh token is a distinctive
 * string, and the checks read what a caller would actually get -- a serialised
 * row, an error message, an outcome -- rather than asking a redaction helper
 * whether it did its job.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpAuthState } from "@ompd/core";
import {
  deriveGrantId,
  detectRunningOmpAuthBroker,
  type ImportPlan,
  importGrants,
  type OmpCredentialRow,
  planImport,
  readOmpCredentials,
} from "../src/mcpauth/import.ts";
import type {
  AuthorizationServerMetadata,
  DiscoveredAuth,
  GrantInput,
  GrantRecord,
  GrantStore,
} from "../src/mcpauth/types.ts";

/** The `auth_credentials` and `schema_version` shapes, verbatim from a real store. */
const SCHEMA = [
  "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, " +
    "credential_type TEXT NOT NULL, data TEXT NOT NULL, disabled_cause TEXT DEFAULT NULL, " +
    "identity_key TEXT DEFAULT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE schema_version (version INTEGER)",
];

const notes = "https://mcp.notes.test/mcp";
const GMAIL = "https://mail.vendor.test/mcp";

interface SeedRow {
  provider: string;
  credentialType?: string;
  data: Record<string, unknown>;
  disabledCause?: string;
  identityKey?: string;
  createdAt?: number;
  updatedAt: number;
}

interface Fixture {
  path: string;
  /** Held open on purpose: closing would checkpoint the WAL the copy has to carry. */
  db: Database;
}

const dirs: string[] = [];
const open: Database[] = [];

function seed(rows: SeedRow[], version = 6): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ompd-mcpauth-fixture-"));
  dirs.push(dir);
  const agent = join(dir, "agent");
  mkdirSync(agent, { recursive: true });
  const path = join(agent, "agent.db");
  const db = new Database(path, { create: true });
  open.push(db);
  db.exec("pragma journal_mode = wal");
  for (const statement of SCHEMA) db.exec(statement);
  db.query("insert into schema_version (version) values (?)").run(version);
  const insert = db.query(
    "insert into auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, " +
      "updated_at) values (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const row of rows) {
    insert.run(
      row.provider,
      row.credentialType ?? "oauth",
      JSON.stringify(row.data),
      row.disabledCause ?? null,
      row.identityKey ?? null,
      row.createdAt ?? row.updatedAt,
      row.updatedAt,
    );
  }
  return { path, db };
}

function metadata(over: Partial<AuthorizationServerMetadata> = {}): AuthorizationServerMetadata {
  return {
    issuer: "https://mcp.notes.test",
    token_endpoint: "https://mcp.notes.test/oauth/token",
    authorization_endpoint: "https://mcp.notes.test/oauth/authorize",
    registration_endpoint: "https://mcp.notes.test/oauth/register",
    grant_types_supported: ["authorization_code", "refresh_token"],
    ...over,
  };
}

function discovered(over: Partial<DiscoveredAuth> = {}): DiscoveredAuth {
  return {
    resource: notes,
    issuer: "https://mcp.notes.test",
    metadata: metadata(),
    supportsRefresh: true,
    ...over,
  };
}

interface StubStore {
  store: GrantStore;
  saved: GrantInput[];
  states: { id: string; state: McpAuthState; detail?: string }[];
}

/**
 * A store that records what the import asked of it.
 *
 * Everything the import must not call throws rather than returning a benign
 * default, so a future change that starts mutating OMP-derived rows through this
 * interface fails here instead of passing quietly.
 */
function stubStore(): StubStore {
  const saved: GrantInput[] = [];
  const states: { id: string; state: McpAuthState; detail?: string }[] = [];
  const refuse = (method: string): never => {
    throw new Error(`import called ${method}, which it has no business calling`);
  };
  const store: GrantStore = {
    list: () => saved.map(input => ({ ...input, state: "healthy" }) as unknown as GrantRecord),
    get: id => saved.filter(input => input.id === id).map(input => input as unknown as GrantRecord)[0],
    load: () => refuse("load"),
    save: input => {
      saved.push(input);
      return input as unknown as GrantRecord;
    },
    rotateRefreshToken: () => refuse("rotateRefreshToken"),
    setState: (id, state, detail) => {
      states.push(detail === undefined ? { id, state } : { id, state, detail });
    },
    recordFailure: () => refuse("recordFailure"),
    clearFailures: () => refuse("clearFailures"),
    remove: () => refuse("remove"),
    close: () => {},
  };
  return { store, saved, states };
}

/** A plan for a single row, so an importGrants test can be about one thing. */
function planFor(rows: OmpCredentialRow[]): ImportPlan {
  return planImport(rows);
}

afterEach(() => {
  while (open.length > 0) open.pop()?.close();
  while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("reading OMP's credential store", () => {
  test("the schema version is a hard gate that names both versions", () => {
    const f = seed([], 7);
    expect(() => readOmpCredentials(f.path)).toThrow(/version 7/);
    expect(() => readOmpCredentials(f.path)).toThrow(/version 6 only/);
  });

  test("a store with no schema_version row is refused too", () => {
    const dir = mkdtempSync(join(tmpdir(), "ompd-mcpauth-noversion-"));
    dirs.push(dir);
    const path = join(dir, "agent.db");
    const db = new Database(path, { create: true });
    open.push(db);
    for (const statement of SCHEMA) db.exec(statement);
    expect(() => readOmpCredentials(path)).toThrow(/version unknown/);
  });

  test("rows still in the WAL are read, which is why the copy carries it", () => {
    // The writer is still connected and nothing has been checkpointed, exactly
    // as a running OMP leaves it.
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    expect(existsSync(`${f.path}-wal`)).toBe(true);
    expect(readOmpCredentials(f.path).map(row => row.resourceUrl)).toEqual([notes]);
  });

  test("only mcp_oauth rows are returned", () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 },
      { provider: "anthropic:oauth", data: { access: "not-an-mcp-credential" }, updatedAt: 11 },
      { provider: "mcp_oauth:malformed", data: shortData(), updatedAt: 12 },
    ]);
    expect(readOmpCredentials(f.path).map(row => row.resourceUrl)).toEqual([notes]);
  });

  test("both real data shapes parse, and the profile comes out of the provider key", () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 },
      { provider: `mcp_oauth:profile:work:${GMAIL}`, data: longData(), identityKey: "j@example.com", updatedAt: 11 },
    ]);
    const rows = readOmpCredentials(f.path);

    const short = rows.find(row => row.resourceUrl === notes);
    expect(short).toMatchObject({ profile: "default", hasAccess: true, hasRefresh: true, unreadable: false });
    expect(short?.tokenUrl).toBeUndefined();
    expect(short?.clientId).toBeUndefined();
    expect(short?.expiresAt).toBe(1_700_000_000_000);

    const long = rows.find(row => row.resourceUrl === GMAIL);
    expect(long).toMatchObject({
      profile: "work",
      identityKey: "j@example.com",
      tokenUrl: "https://mail.vendor.test/oauth/token",
      clientId: "client-abc",
      resource: GMAIL,
      authorizationUrl: "https://mail.vendor.test/oauth/authorize",
      hasRefresh: true,
    });
  });

  test("an epoch-seconds expiry is normalised rather than read as long dead", () => {
    const f = seed([
      {
        provider: `mcp_oauth:profile:default:${notes}`,
        data: { ...shortData(), expires: 1_700_000_000 },
        updatedAt: 1,
      },
    ]);
    expect(readOmpCredentials(f.path)[0]?.expiresAt).toBe(1_700_000_000_000);
  });

  test("a row whose data is not JSON is marked unreadable and its contents stay out of everything", () => {
    const f = seed([]);
    f.db
      .query(
        "insert into auth_credentials (provider, credential_type, data, created_at, updated_at) values (?, ?, ?, ?, ?)",
      )
      .run(`mcp_oauth:profile:default:${notes}`, "oauth", "{refresh: refresh-secret-raw", 1, 1);
    const rows = readOmpCredentials(f.path);
    expect(rows[0]).toMatchObject({ unreadable: true, hasRefresh: false });
    expect(JSON.stringify(rows)).not.toContain("refresh-secret-raw");
  });

  test("the operator's database is not modified, and no copy is left behind", () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const before = { bytes: readFileSync(f.path), mtimeMs: statSync(f.path).mtimeMs };
    const leftoverBefore = importTempDirs();

    readOmpCredentials(f.path);
    const f2 = seed([], 99);
    expect(() => readOmpCredentials(f2.path)).toThrow();

    expect(readFileSync(f.path).equals(before.bytes)).toBe(true);
    expect(statSync(f.path).mtimeMs).toBe(before.mtimeMs);
    // Including the throwing path: a temp copy of a credential database left
    // behind is the "database file as a credential" problem the vault exists to
    // avoid.
    expect(importTempDirs()).toEqual(leftoverBefore);
  });

  test("a serialised row carries no secret, only whether one is there", () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: longData(), updatedAt: 10 }]);
    const rows = readOmpCredentials(f.path);

    // The secrets really are reachable, so this is not passing because the
    // fixture never had any.
    expect(rows[0]?.secrets.refreshToken).toBe("refresh-secret-longshape");
    expect(rows[0]?.secrets.clientSecret).toBe("client-secret-longshape");
    expect(rows[0]?.hasRefresh).toBe(true);

    for (const rendered of [
      JSON.stringify(rows),
      JSON.stringify({ ...(rows[0] as object) }),
      String(Object.entries(rows[0] ?? {})),
    ]) {
      expect(rendered).not.toContain("refresh-secret-longshape");
      expect(rendered).not.toContain("client-secret-longshape");
      expect(rendered).not.toContain("access-secret-longshape");
    }
  });
});

describe("deciding what to import", () => {
  test("the newest non-disabled row per URL wins and everything dropped says why", () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 100 },
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 300 },
      {
        provider: `mcp_oauth:profile:default:${GMAIL}`,
        data: longData(),
        updatedAt: 500,
        disabledCause: "invalid_grant: Refresh token reuse detected; session revoked",
      },
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 200 },
    ]);
    const plan = planImport(readOmpCredentials(f.path));

    // Row 2 is the newest that OMP had not already given up on.
    expect(plan.imports.map(entry => entry.row.id)).toEqual([2]);
    expect(plan.dropped.map(row => ({ id: row.id, reason: row.reason }))).toEqual([
      { id: 1, reason: "superseded by the newer row 2 for the same URL" },
      { id: 3, reason: "OMP had already disabled it: invalid_grant: Refresh token reuse detected; session revoked" },
      { id: 4, reason: "superseded by the newer row 2 for the same URL" },
    ]);
    expect(plan.notImportable).toEqual([]);
  });

  test("ties on updated_at break on row id, so the plan is deterministic", () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 42 },
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 42 },
    ]);
    expect(planImport(readOmpCredentials(f.path)).imports.map(entry => entry.row.id)).toEqual([2]);
  });

  test("a row with no refresh token is reported not importable, never imported broken", () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${notes}`, data: { access: "a", expires: 1 }, updatedAt: 10 },
    ]);
    const plan = planImport(readOmpCredentials(f.path));
    expect(plan.imports).toEqual([]);
    expect(plan.notImportable).toEqual([
      {
        id: 1,
        profile: "default",
        resourceUrl: notes,
        reason: "it holds no refresh token, so only a fresh authorization can renew it",
      },
    ]);
  });

  test("a profile filter drops the others with the profile named", () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 },
      { provider: `mcp_oauth:profile:work:${GMAIL}`, data: longData(), updatedAt: 11 },
    ]);
    const plan = planImport(readOmpCredentials(f.path), { profiles: ["default"] });
    expect(plan.imports.map(entry => entry.row.resourceUrl)).toEqual([notes]);
    expect(plan.dropped[0]?.reason).toBe("profile work was not selected for import");
  });

  test("the account comes from identity_key, because it is part of the grant id", () => {
    const f = seed([
      {
        provider: `mcp_oauth:profile:default:${notes}`,
        data: longData(),
        identityKey: "jason@example.com",
        updatedAt: 10,
      },
    ]);
    const plan = planImport(readOmpCredentials(f.path));
    expect(plan.imports[0]?.account).toBe("jason@example.com");
    expect(plan.imports[0]?.serverName).toBe("mcp-notes-test");
  });
});

describe("the grant id", () => {
  test("is the derived value the whole subsystem agrees on", () => {
    expect(deriveGrantId(notes)).toBe("mcpauth_3013eb5c28e0fde5");
    expect(deriveGrantId(notes, "jason@example.com")).toBe("mcpauth_261ac2c529ca5cef");
    // Spelled out independently: `mcpauth_` plus the first 16 hex of
    // sha256(url + "\n" + account).
    expect(deriveGrantId(GMAIL, "a@b")).toBe(
      `mcpauth_${createHash("sha256").update(`${GMAIL}\na@b`).digest("hex").slice(0, 16)}`,
    );
  });

  test("distinguishes accounts and is stable across calls", () => {
    expect(deriveGrantId(notes)).toBe(deriveGrantId(notes));
    expect(deriveGrantId(notes)).not.toBe(deriveGrantId(notes, "someone"));
  });
});

describe("creating the grants", () => {
  test("a row missing its token endpoint has one recovered from discovery", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => discovered(),
      grants: store.store,
      probe: async () => false,
    });
    if (!run.ok) throw new Error("expected the import to run");

    expect(run.outcomes).toEqual([
      {
        ok: true,
        grantId: "mcpauth_3013eb5c28e0fde5",
        resourceUrl: notes,
        serverName: "mcp-notes-test",
        tokenUrlRecovered: true,
        clientIdKnown: false,
        supportsRefresh: true,
        accessExpired: true,
      },
    ]);
    expect(store.saved[0]).toMatchObject({
      id: "mcpauth_3013eb5c28e0fde5",
      tokenUrl: "https://mcp.notes.test/oauth/token",
      authorizationUrl: "https://mcp.notes.test/oauth/authorize",
      registrationUrl: "https://mcp.notes.test/oauth/register",
      issuer: "https://mcp.notes.test",
      supportsRefresh: true,
      clientId: "",
    });
    expect(store.saved[0]?.secrets.refreshToken).toBe("refresh-secret-shortshape");
  });

  test("a grant with no client id is not reported healthy, because it cannot refresh", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const store = stubStore();
    await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => discovered(),
      grants: store.store,
      probe: async () => false,
    });
    expect(store.states).toHaveLength(1);
    expect(store.states[0]).toMatchObject({ id: "mcpauth_3013eb5c28e0fde5", state: "reauth_required" });
    expect(store.states[0]?.detail).toContain("no OAuth client id");
  });

  test("a row that already carries its own material keeps it, and still takes supportsRefresh from discovery", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 10 }]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () =>
        discovered({
          issuer: "https://mail.vendor.test",
          metadata: metadata({ token_endpoint: "https://discovery.example/token", grant_types_supported: [] }),
          supportsRefresh: false,
        }),
      grants: store.store,
      probe: async () => false,
      clock: { now: () => 0 },
    });
    if (!run.ok) throw new Error("expected the import to run");

    expect(store.saved[0]).toMatchObject({
      tokenUrl: "https://mail.vendor.test/oauth/token",
      clientId: "client-abc",
      scopes: "read write",
      supportsRefresh: false,
    });
    expect(store.saved[0]?.secrets.clientSecret).toBe("client-secret-longshape");
    expect(run.outcomes[0]).toMatchObject({ tokenUrlRecovered: false, clientIdKnown: true, accessExpired: false });
    // A stored client id is enough to attempt a refresh, so nothing is forced.
    expect(store.states).toEqual([]);
  });

  test("neither the row nor discovery naming a token endpoint fails that grant only", async () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 },
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 11 },
    ]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async url => {
        if (url === notes) throw new Error("connect ECONNREFUSED");
        return discovered();
      },
      grants: store.store,
      probe: async () => false,
    });
    if (!run.ok) throw new Error("expected the import to run");

    expect(run.outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
    const failed = run.outcomes.find(outcome => !outcome.ok);
    expect(failed).toMatchObject({ ok: false, resourceUrl: notes });
    expect(store.saved.map(input => input.resourceUrl)).toEqual([GMAIL]);
  });

  test("discovery that returns no token endpoint is a per-grant failure, not a save", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => discovered({ metadata: metadata({ token_endpoint: "" }) }),
      grants: store.store,
      probe: async () => false,
    });
    if (!run.ok) throw new Error("expected the import to run");
    expect(run.outcomes[0]).toMatchObject({ ok: false, reason: expect.stringContaining("token endpoint") });
    expect(store.saved).toEqual([]);
  });

  test("the plan's reasons are carried through so the run is a complete report", async () => {
    const f = seed([
      { provider: `mcp_oauth:profile:default:${notes}`, data: { access: "a" }, updatedAt: 10 },
      { provider: `mcp_oauth:profile:default:${GMAIL}`, data: longData(), updatedAt: 11, disabledCause: "revoked" },
    ]);
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => discovered(),
      grants: stubStore().store,
      probe: async () => false,
    });
    if (!run.ok) throw new Error("expected the import to run");
    expect(run.outcomes).toEqual([]);
    expect(run.notImportable).toHaveLength(1);
    expect(run.dropped).toHaveLength(1);
  });

  test("no secret reaches an outcome, a state detail, or a failure reason", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => discovered(),
      grants: store.store,
      probe: async () => false,
    });
    const rendered = `${JSON.stringify(run)}${JSON.stringify(store.states)}`;
    expect(rendered).not.toContain("refresh-secret-shortshape");
    expect(rendered).not.toContain("access-secret-shortshape");
    // The value did reach the store, which is the only place it belongs.
    expect(store.saved[0]?.secrets.refreshToken).toBe("refresh-secret-shortshape");
  });
});

describe("refusing to become a second redeemer", () => {
  test("an answering OMP auth broker stops the import, as a typed result", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => {
        throw new Error("discovery must not be reached when the import refuses");
      },
      grants: store.store,
      probe: async () => true,
    });

    expect(run.ok).toBe(false);
    if (run.ok) throw new Error("unreachable");
    expect(run.reason).toBe("omp_auth_broker_running");
    expect(run.detail).toContain("8765");
    expect(store.saved).toEqual([]);
  });

  test("force takes the risk knowingly and never even probes", async () => {
    const f = seed([{ provider: `mcp_oauth:profile:default:${notes}`, data: shortData(), updatedAt: 10 }]);
    const store = stubStore();
    const run = await importGrants(planFor(readOmpCredentials(f.path)), {
      discover: async () => discovered(),
      grants: store.store,
      probe: async () => {
        throw new Error("force must not probe");
      },
      force: true,
    });
    expect(run.ok).toBe(true);
    expect(store.saved).toHaveLength(1);
  });

  test("a closed port is not a broker, and neither is a listener that fails the health route", async () => {
    // Port 1 on loopback: nothing is there, so the connect probe answers without
    // a request and without waiting out a timeout.
    expect(await detectRunningOmpAuthBroker({ port: 1, timeoutMs: 200 })).toBe(false);

    const server = Bun.serve({ port: 0, fetch: () => new Response("who are you", { status: 404 }) });
    try {
      expect(await detectRunningOmpAuthBroker({ port: server.port, timeoutMs: 500 })).toBe(false);
    } finally {
      await server.stop(true);
    }
  });

  test("a broker answering the health route is detected", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: req =>
        new URL(req.url).pathname === "/v1/healthz" ? new Response("ok") : new Response("", { status: 404 }),
    });
    try {
      expect(await detectRunningOmpAuthBroker({ port: server.port, timeoutMs: 1000 })).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

/** `{access, refresh, expires}`: the shape nine of this machine's rows have. */
function shortData(): Record<string, unknown> {
  return {
    access: "access-secret-shortshape",
    refresh: "refresh-secret-shortshape",
    expires: 1_700_000_000_000,
  };
}

/** The shape that carries its own refresh material, which is why those rows still work. */
function longData(): Record<string, unknown> {
  return {
    access: "access-secret-longshape",
    refresh: "refresh-secret-longshape",
    expires: 1_700_000_000_000,
    tokenUrl: "https://mail.vendor.test/oauth/token",
    clientId: "client-abc",
    clientSecret: "client-secret-longshape",
    resource: GMAIL,
    authorizationUrl: "https://mail.vendor.test/oauth/authorize",
    scope: "read write",
  };
}

/** Temp directories this module creates while reading, so a leak is visible. */
function importTempDirs(): string[] {
  return readdirSync(tmpdir())
    .filter(name => name.startsWith("ompd-mcpauth-import-"))
    .sort();
}
