/**
 * The grant store, tested against the two claims it makes that are worth
 * doubting: that the refresh token is not in the database file, and that a
 * rotation cannot lose a successor.
 *
 * The at-rest test reads the `.db` and its WAL as bytes and looks for the
 * token. That is deliberate. Asserting on what a redaction helper returns, or
 * on what `get()` omits, proves only that the code agrees with itself; the
 * question is what a copied file hands to whoever copied it, and the only
 * answer that settles it is the bytes.
 *
 * Every store here is built on a `file` vault in a throwaway home, so nothing
 * touches the developer's login keychain.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpAuthStore } from "../src/mcpauth/store.ts";
import type { GrantInput, GrantSecrets, SecretVault } from "../src/mcpauth/types.ts";
import { openVault } from "../src/mcpauth/vault.ts";

const homes: string[] = [];
const stores: McpAuthStore[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ompd-mcpauth-store-"));
  homes.push(home);
  return home;
}

/**
 * A home, its vault, and a store on it, with the pieces a reopen needs.
 *
 * The vault is created once and reused across reopens on purpose: a second
 * `openVault` on the same home would resolve the same key from the same file,
 * and a test that relied on that would be testing the vault rather than the
 * store.
 */
function fresh(): { home: string; vault: SecretVault; path: string; store: McpAuthStore } {
  const home = freshHome();
  const vault = openVault(home, { backend: "file" });
  const path = join(home, "mcp-auth.db");
  const store = new McpAuthStore(path, vault);
  stores.push(store);
  return { home, vault, path, store };
}

function reopen(path: string, vault: SecretVault): McpAuthStore {
  const store = new McpAuthStore(path, vault);
  stores.push(store);
  return store;
}

/**
 * `mcpauth_` plus the first 16 hex of sha256(resourceUrl + "\n" + account).
 *
 * Spelled out here rather than imported, because the fixtures have to carry the
 * same ids the broker and the config bridge mint, and a helper shared with the
 * code under test would make a wrong formula agree with itself.
 */
function grantId(resourceUrl: string, account?: string): string {
  const digest = createHash("sha256")
    .update(`${resourceUrl}\n${account ?? ""}`)
    .digest("hex");
  return `mcpauth_${digest.slice(0, 16)}`;
}

function grantInput(serverName: string, resourceUrl: string, secrets: GrantSecrets, account?: string): GrantInput {
  const input: GrantInput = {
    id: grantId(resourceUrl, account),
    serverName,
    resourceUrl,
    issuer: "https://auth.example.test",
    tokenUrl: "https://auth.example.test/token",
    authorizationUrl: "https://auth.example.test/authorize",
    registrationUrl: "https://auth.example.test/register",
    clientId: "client-abc",
    clientAuthMethod: "none",
    scopes: "mcp:read mcp:write",
    supportsRefresh: true,
    secrets,
  };
  if (account !== undefined) input.account = account;
  return input;
}

/** Every byte the store wrote: the database, plus the WAL and index if they survived the close. */
function onDiskBytes(path: string): Buffer {
  const parts = [path, `${path}-wal`, `${path}-shm`].filter(existsSync).map(file => readFileSync(file));
  return Buffer.concat(parts);
}

afterEach(() => {
  while (stores.length) {
    try {
      stores.pop()?.close();
    } catch {
      // Already closed by a test that was making a point about closing.
    }
  }
  while (homes.length) rmSync(homes.pop() ?? "", { recursive: true, force: true });
});

describe("what reaches the disk", () => {
  test("the refresh token is not in the database file", () => {
    const { path, store } = fresh();
    const refreshToken = `rt_${randomBytes(32).toString("hex")}`;
    const clientSecret = `cs_${randomBytes(32).toString("hex")}`;
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken, clientSecret });
    store.save(input);

    // The mirror, first: a store that simply dropped the secrets would pass the
    // byte assertion below for the wrong reason.
    expect(store.load(input.id)?.secrets).toEqual({ refreshToken, clientSecret });

    store.close();
    stores.pop();

    const bytes = onDiskBytes(path).toString("latin1");
    expect(bytes).not.toContain(refreshToken);
    expect(bytes).not.toContain(clientSecret);
    // And the row really is there, so the absence above is encryption rather
    // than an empty database.
    expect(bytes).toContain("https://notes.example.test/mcp");
  });

  test("a secret blob moved between rows does not open", () => {
    // Without the grant id as additional authenticated data, one UPDATE would
    // point grant B's token endpoint at grant A's refresh token, and the vault
    // would decrypt it without complaint.
    const { path, vault, store } = fresh();
    const a = grantInput("alpha", "https://alpha.example.test/mcp", { refreshToken: "rt_alpha" });
    const b = grantInput("bravo", "https://bravo.example.test/mcp", { refreshToken: "rt_bravo" });
    store.save(a);
    store.save(b);
    store.close();
    stores.pop();

    const raw = new Database(path);
    raw.run(`UPDATE mcp_auth_grants SET secret_blob=(SELECT secret_blob FROM mcp_auth_grants WHERE id=?) WHERE id=?`, [
      a.id,
      b.id,
    ]);
    raw.close();

    const reopened = reopen(path, vault);
    expect(() => reopened.load(b.id)).toThrow(/failed authentication/);
    // A's own row is untouched and still opens, so the throw above is the
    // binding rather than a vault that stopped working.
    expect(reopened.load(a.id)?.secrets.refreshToken).toBe("rt_alpha");
  });

  test("list and get never decrypt", () => {
    // A summary path that decrypted would put a refresh token in memory on
    // every status call, and in a log line the first time one was stringified.
    const home = freshHome();
    const inner = openVault(home, { backend: "file" });
    let opens = 0;
    const counting: SecretVault = {
      backend: inner.backend,
      seal: inner.seal,
      open: (envelope, aad) => {
        opens += 1;
        return inner.open(envelope, aad);
      },
    };
    const store = new McpAuthStore(join(home, "mcp-auth.db"), counting);
    stores.push(store);

    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);
    expect(store.list()).toHaveLength(1);
    expect(store.get(input.id)?.serverName).toBe("notes");
    expect(opens).toBe(0);

    expect(store.load(input.id)?.secrets.refreshToken).toBe("rt_one");
    expect(opens).toBe(1);
  });
});

describe("rotation", () => {
  test("a successor replaces the stored token", () => {
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", {
      refreshToken: "rt_one",
      clientSecret: "cs_static",
    });
    store.save(input);

    store.rotateRefreshToken(input.id, "rt_two", 1_700_000_000_000);

    const loaded = store.load(input.id);
    expect(loaded?.secrets.refreshToken).toBe("rt_two");
    // The client secret rides in the same blob and is not a casualty of a
    // read-modify-write that rebuilt the object instead of editing it.
    expect(loaded?.secrets.clientSecret).toBe("cs_static");
    expect(loaded?.lastRefreshAt).toBe(1_700_000_000_000);
  });

  test("no successor preserves the stored token and still records the refresh", () => {
    // RFC 6749 section 6: a token response that omits `refresh_token` leaves
    // the current one valid. Blanking it would destroy a live credential on the
    // say-so of a response that said nothing about it.
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);
    store.recordFailure(input.id, "network unreachable", 1_700_000_000_000);

    store.rotateRefreshToken(input.id, undefined, 1_700_000_500_000);

    const loaded = store.load(input.id);
    expect(loaded?.secrets.refreshToken).toBe("rt_one");
    expect(loaded?.lastRefreshAt).toBe(1_700_000_500_000);
    expect(loaded?.failures).toBe(0);
    expect(loaded?.nextAttemptAt).toBeUndefined();
    expect(loaded?.detail).toBeUndefined();
  });

  test("no successor on a grant that never had one leaves it absent", () => {
    // Not `""`, not `null`. A blank refresh token that looked present would be
    // redeemed, rejected as `invalid_grant`, and reported as a revoked grant
    // rather than one that never had a refresh token.
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { clientSecret: "cs_static" });
    store.save(input);

    store.rotateRefreshToken(input.id, undefined, 1_700_000_000_000);

    expect(store.load(input.id)?.secrets.refreshToken).toBeUndefined();
  });

  test("a rotation survives a reopen", () => {
    const { path, vault, store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);
    store.rotateRefreshToken(input.id, "rt_two", 1_700_000_000_000);
    store.close();
    stores.pop();

    expect(reopen(path, vault).load(input.id)?.secrets.refreshToken).toBe("rt_two");
  });

  test("recording a refresh against an unknown grant throws", () => {
    // The caller has just redeemed a rotating refresh token. A silent no-op
    // would mean the successor was handed to this method and dropped, and the
    // grant is then dead with nothing recording why.
    const { store } = fresh();
    expect(() => store.rotateRefreshToken(grantId("https://gone.example.test/mcp"), "rt_two", 1)).toThrow(/no grant/);
  });
});

describe("state and failures", () => {
  test("a fresh grant with a refresh token is healthy", () => {
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    expect(store.save(input).state).toBe("healthy");
    expect(store.get(input.id)?.state).toBe("healthy");
  });

  test("a fresh grant with no refresh token is reported as having none", () => {
    // The nine credentials on this machine that no OMP session can ever refresh
    // are this case. Reporting them as healthy until the access token died is
    // how they stayed broken.
    const { store } = fresh();
    const input = grantInput("clerk", "https://clerk.example.test/mcp", { clientSecret: "cs_static" });
    expect(store.save(input).state).toBe("no_refresh_grant");
    expect(store.get(input.id)?.state).toBe("no_refresh_grant");
  });

  test("a state change carries its reason, and clearing it removes it", () => {
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);

    store.setState(input.id, "reauth_required", "invalid_grant: session revoked");
    expect(store.get(input.id)?.state).toBe("reauth_required");
    expect(store.get(input.id)?.detail).toBe("invalid_grant: session revoked");

    store.setState(input.id, "healthy");
    expect(store.get(input.id)?.state).toBe("healthy");
    expect(store.get(input.id)?.detail).toBeUndefined();
  });

  test("failures accumulate and then clear", () => {
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);

    store.recordFailure(input.id, "connect ETIMEDOUT", 1_700_000_060_000);
    store.recordFailure(input.id, "connect ETIMEDOUT", 1_700_000_120_000);
    const backingOff = store.get(input.id);
    expect(backingOff?.failures).toBe(2);
    expect(backingOff?.nextAttemptAt).toBe(1_700_000_120_000);
    expect(backingOff?.detail).toBe("connect ETIMEDOUT");

    store.clearFailures(input.id);
    const cleared = store.get(input.id);
    expect(cleared?.failures).toBe(0);
    expect(cleared?.nextAttemptAt).toBeUndefined();
    expect(cleared?.detail).toBeUndefined();
  });
});

describe("saving and removing", () => {
  test("saving the same id twice converges to one row", () => {
    // Grant ids are derived from the resource and account, so importing the
    // same grant twice has to converge instead of forking into two rows that
    // both refresh one rotating family.
    const { store } = fresh();
    const first = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    const second = grantInput("notes-renamed", "https://notes.example.test/mcp", { refreshToken: "rt_two" });
    expect(second.id).toBe(first.id);

    store.save(first);
    store.save(second);

    expect(store.list()).toHaveLength(1);
    expect(store.get(first.id)?.serverName).toBe("notes-renamed");
    expect(store.load(first.id)?.secrets.refreshToken).toBe("rt_two");
  });

  test("a re-authorization inherits no failure state from the row it replaced", () => {
    // A fresh authorization that arrived already backing off would refuse to
    // use a credential a person had just stood in a browser to obtain.
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);
    store.recordFailure(input.id, "connect ETIMEDOUT", 1_700_000_060_000);
    store.setState(input.id, "reauth_required", "invalid_grant");
    store.rotateRefreshToken(input.id, "rt_two", 1_700_000_000_000);

    store.save(grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_three" }));

    const record = store.get(input.id);
    expect(record?.state).toBe("healthy");
    expect(record?.failures).toBe(0);
    expect(record?.detail).toBeUndefined();
    expect(record?.nextAttemptAt).toBeUndefined();
    expect(record?.lastRefreshAt).toBeUndefined();
  });

  test("an account distinguishes two grants for one resource", () => {
    const { store } = fresh();
    const work = grantInput(
      "gmail",
      "https://gmail.example.test/mcp",
      { refreshToken: "rt_work" },
      "work@example.test",
    );
    const personal = grantInput(
      "gmail",
      "https://gmail.example.test/mcp",
      { refreshToken: "rt_personal" },
      "me@example.test",
    );
    expect(work.id).not.toBe(personal.id);

    store.save(work);
    store.save(personal);

    expect(store.list()).toHaveLength(2);
    expect(store.load(work.id)?.secrets.refreshToken).toBe("rt_work");
    expect(store.load(personal.id)?.secrets.refreshToken).toBe("rt_personal");
    expect(store.get(personal.id)?.account).toBe("me@example.test");
  });

  test("removing reports whether there was anything to remove", () => {
    const { store } = fresh();
    const input = grantInput("notes", "https://notes.example.test/mcp", { refreshToken: "rt_one" });
    store.save(input);

    expect(store.remove(input.id)).toBe(true);
    expect(store.remove(input.id)).toBe(false);
    expect(store.get(input.id)).toBeUndefined();
  });

  test("an unknown grant reads as absent rather than throwing", () => {
    const { store } = fresh();
    expect(store.get(grantId("https://gone.example.test/mcp"))).toBeUndefined();
    expect(store.load(grantId("https://gone.example.test/mcp"))).toBeUndefined();
  });
});

describe("surviving a restart", () => {
  test("every grant and every secret comes back", () => {
    // The daemon restarts on every upgrade. A store that lost grants across one
    // would send an operator to a browser for each server, every time.
    const { path, vault, store } = fresh();
    const notes = grantInput("notes", "https://notes.example.test/mcp", {
      refreshToken: "rt_notes",
      clientSecret: "cs_notes",
    });
    notes.clientAuthMethod = "client_secret_basic";
    const inputs = [
      notes,
      grantInput("docs", "https://docs.example.test/mcp", { refreshToken: "rt_docs" }),
      grantInput("clerk", "https://clerk.example.test/mcp", {}),
    ];
    for (const input of inputs) store.save(input);
    store.setState(inputs[1]?.id ?? "", "degraded", "one transient failure");
    store.recordFailure(inputs[1]?.id ?? "", "connect ETIMEDOUT", 1_700_000_060_000);
    store.close();
    stores.pop();

    const reopened = reopen(path, vault);
    expect(reopened.list().map(record => record.serverName)).toEqual(["clerk", "docs", "notes"]);
    for (const input of inputs) {
      expect(reopened.load(input.id)?.secrets).toEqual(input.secrets);
    }

    const docs = reopened.get(inputs[1]?.id ?? "");
    expect(docs?.state).toBe("degraded");
    expect(docs?.failures).toBe(1);
    expect(docs?.nextAttemptAt).toBe(1_700_000_060_000);
    expect(docs?.detail).toBe("connect ETIMEDOUT");
    expect(docs?.authorizationUrl).toBe("https://auth.example.test/authorize");
    expect(docs?.registrationUrl).toBe("https://auth.example.test/register");
    expect(docs?.supportsRefresh).toBe(true);
    expect(reopened.get(notes.id)?.clientAuthMethod).toBe("client_secret_basic");
  });

  test("a legacy row with no recorded auth method is reauth_required before apply can see it", () => {
    const { path, vault, store } = fresh();
    const input = grantInput("legacy", "https://legacy.example.test/mcp", { refreshToken: "rt_legacy" });
    store.save(input);
    store.close();
    stores.pop();

    const raw = new Database(path);
    raw.run(
      `UPDATE mcp_auth_grants
       SET client_auth_method=NULL, state='healthy', detail=NULL
       WHERE id=?`,
      [input.id],
    );
    raw.close();

    const reopened = reopen(path, vault);
    expect(reopened.get(input.id)).toMatchObject({ state: "reauth_required" });
    expect(reopened.get(input.id)?.detail).toContain("not recorded");
  });
});
