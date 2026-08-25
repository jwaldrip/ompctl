/**
 * The composed path, end to end inside one process.
 *
 * The seven other `mcpauth-*` suites each prove one piece against stubs. This
 * one proves the pieces are actually wired to each other in a real `Ompd`: a
 * grant in the store, a listener on the configured port, a request from
 * something shaped like an OMP session, a live bearer arriving at an upstream
 * that never sees a refresh token, and a `/v1/mcp-auth` route that answers with
 * no credential in it.
 *
 * A real `Bun.serve` stands in for the remote MCP server and a real
 * authorization server, because the failures this subsystem exists to prevent
 * are HTTP-shaped and a mocked `fetch` cannot have them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpAuthStatus } from "@ompd/core";
import { Ompd } from "../src/daemon.ts";
import { MCP_AUTH_HEADER } from "../src/mcpauth/proxy.ts";
import { McpAuthStore } from "../src/mcpauth/store.ts";
import { openVault } from "../src/mcpauth/vault.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const running: Ompd[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/**
 * A port nobody is on, claimed and released.
 *
 * The broker's port is deliberately fixed rather than OS-assigned, because it
 * appears inside URLs written into OMP's config. A test therefore cannot pass
 * `0`, and hard-coding 7778 would collide with the developer's own daemon. So:
 * ask the OS for one, note it, give it back.
 */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("Bun.serve bound no port");
  return port;
}

interface Upstream {
  url: string;
  /** Every Authorization header the upstream actually received, in order. */
  seen: string[];
  stop(): void;
}

/** A remote MCP server that answers `tools/call` only to a specific bearer. */
function upstreamMcp(expected: string): Upstream {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const authorization = req.headers.get("authorization") ?? "";
      seen.push(authorization);
      if (authorization !== `Bearer ${expected}`) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const frame = (await req.json()) as { id?: unknown; method?: unknown };
      return Response.json({
        jsonrpc: "2.0",
        id: frame.id,
        result: { content: [{ type: "text", text: `served ${String(frame.method)}` }] },
      });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/mcp`, seen, stop: () => server.stop(true) };
}

/** A token endpoint that swaps one refresh token for a fresh access token, rotating as it goes. */
function tokenEndpoint(opts: { access: string; refresh: string; successor: string }): {
  url: string;
  exchanges: number;
  stop(): void;
} {
  const state = { exchanges: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = new URLSearchParams(await req.text());
      if (body.get("grant_type") !== "refresh_token" || body.get("refresh_token") !== opts.refresh) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      state.exchanges += 1;
      return Response.json({
        access_token: opts.access,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: opts.successor,
      });
    },
  });
  servers.push(server);
  return {
    url: `http://127.0.0.1:${server.port}/token`,
    get exchanges() {
      return state.exchanges;
    },
    stop: () => server.stop(true),
  };
}

function build(home: string, mcpAuthPort: number): Ompd {
  const daemon = new Ompd({
    home,
    overrides: { port: 0, mcpAuthPort },
    spawnHost: createFakeHost().factory,
    // Never the operator's real login keychain: a test that seeds a vault must
    // seed the same one the daemon opens, and on a Mac that would be theirs.
    mcpAuthVault: "file",
    voice: false,
  });
  running.push(daemon);
  return daemon;
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the composed broker", () => {
  test("a session reaches an upstream with a token the daemon minted, and never holds one itself", async () => {
    const home = tempDir("ompd-mcpauth-e2e-");
    const access = `at_${randomBytes(16).toString("hex")}`;
    const refresh = `rt_${randomBytes(16).toString("hex")}`;
    const upstream = upstreamMcp(access);
    const token = tokenEndpoint({ access, refresh, successor: `${refresh}_next` });

    // Seed a grant the way an import or a login would, through the same store
    // and the same vault the daemon will open.
    const seedVault = openVault(home, { backend: "file" });
    const seed = new McpAuthStore(join(home, "mcp-auth.db"), seedVault);
    const grant = seed.save({
      id: "mcpauth_e2e0000000000001",
      serverName: "fixture",
      resourceUrl: upstream.url,
      issuer: "http://127.0.0.1/issuer",
      tokenUrl: token.url,
      clientId: "client-fixture",
      scopes: "mcp:tools",
      supportsRefresh: true,
      secrets: { refreshToken: refresh },
    });
    seed.close();

    const port = freePort();
    const daemon = build(home, port);
    const info = await daemon.start();

    // The caller credential is on disk, 0600, and is what an MCP config's
    // `!command` would read.
    const callerTokenPath = join(home, "mcp-auth.token");
    expect(existsSync(callerTokenPath)).toBe(true);
    expect(statSync(callerTokenPath).mode & 0o777).toBe(0o600);
    const callerToken = readFileSync(callerTokenPath, "utf8").trim();

    const response = await fetch(`http://127.0.0.1:${port}/mcp/${grant.id}`, {
      method: "POST",
      headers: { [MCP_AUTH_HEADER]: callerToken, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 7, result: { content: [{ text: "served tools/list" }] } });

    // The daemon redeemed the refresh token exactly once and the upstream saw
    // the resulting bearer. The session supplied only the loopback credential.
    expect(token.exchanges).toBe(1);
    expect(upstream.seen).toEqual([`Bearer ${access}`]);
    expect(upstream.seen.join("|")).not.toContain(refresh);
    expect(upstream.seen.join("|")).not.toContain(callerToken);

    // The rotated successor is what survives, and the access token is not
    // written down anywhere.
    const bytes = readFileSync(join(home, "mcp-auth.db"));
    expect(bytes.includes(Buffer.from(`${refresh}_next`))).toBe(false);
    expect(bytes.includes(Buffer.from(access))).toBe(false);

    void info;
  });

  test("GET /v1/mcp-auth reports the listener, the vault and the grants, with nothing secret in it", async () => {
    const home = tempDir("ompd-mcpauth-status-");
    const access = `at_${randomBytes(16).toString("hex")}`;
    const refresh = `rt_${randomBytes(16).toString("hex")}`;
    const upstream = upstreamMcp(access);
    const token = tokenEndpoint({ access, refresh, successor: `${refresh}_next` });

    const seed = new McpAuthStore(join(home, "mcp-auth.db"), openVault(home, { backend: "file" }));
    seed.save({
      id: "mcpauth_status000000001",
      serverName: "fixture",
      resourceUrl: upstream.url,
      issuer: "http://127.0.0.1/issuer",
      tokenUrl: token.url,
      clientId: "client-fixture",
      scopes: "mcp:tools",
      supportsRefresh: true,
      secrets: { refreshToken: refresh },
    });
    seed.close();

    const port = freePort();
    const daemon = build(home, port);
    const info = await daemon.start();
    const bearer = readFileSync(join(home, "token"), "utf8").trim();

    const res = await fetch(`${info.url}/v1/mcp-auth`, { headers: { authorization: `Bearer ${bearer}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpAuthStatus;

    expect(body.endpoint).toBe(`http://127.0.0.1:${port}`);
    expect(body.listenError).toBeUndefined();
    expect(body.vault).toBe("file");
    expect(body.grants).toHaveLength(1);
    expect(body.grants[0]).toMatchObject({
      id: "mcpauth_status000000001",
      serverName: "fixture",
      state: "healthy",
      supportsRefresh: true,
      // Nothing has pointed OMP's config at it yet, and the status says so
      // rather than implying a session would reach it.
      wired: false,
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(refresh);
    expect(serialized).not.toContain(access);
  });

  test("an unauthenticated caller gets nothing from the route, and a taken port is reported rather than moved", async () => {
    const home = tempDir("ompd-mcpauth-refuse-");
    const port = freePort();

    // Something else is already on the port the daemon was told to use.
    const squatter = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("not the broker") });
    servers.push(squatter);

    const daemon = build(home, port);
    const info = await daemon.start();
    const bearer = readFileSync(join(home, "token"), "utf8").trim();

    const anonymous = await fetch(`${info.url}/v1/mcp-auth`);
    expect(anonymous.status).toBe(401);

    const res = await fetch(`${info.url}/v1/mcp-auth`, { headers: { authorization: `Bearer ${bearer}` } });
    const body = (await res.json()) as McpAuthStatus;

    // The daemon is up and serving; the broker is not, and says why. Binding
    // elsewhere would leave every written config entry pointing at nothing.
    expect(body.endpoint).toBeUndefined();
    expect(body.listenError).toContain(String(port));
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("not the broker");
  });

  test("the loopback caller credential survives a restart, because MCP config references it by path", async () => {
    const home = tempDir("ompd-mcpauth-restart-");
    const port = freePort();

    const first = build(home, port);
    await first.start();
    const before = readFileSync(join(home, "mcp-auth.token"), "utf8").trim();
    await first.stop();
    running.length = 0;

    const second = build(home, port);
    await second.start();
    const after = readFileSync(join(home, "mcp-auth.token"), "utf8").trim();

    expect(after).toBe(before);
    // And the digest the listener compares against is the digest of that file,
    // so a session holding a resolved header keeps working across the restart.
    const res = await fetch(`http://127.0.0.1:${port}/mcp/mcpauth_absent`, {
      method: "POST",
      headers: { [MCP_AUTH_HEADER]: after, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    // 404 rather than 401: the credential was accepted, the grant does not exist.
    expect(res.status).toBe(404);
    expect(createHash("sha256").update(after).digest("hex")).toHaveLength(64);
  });
});
