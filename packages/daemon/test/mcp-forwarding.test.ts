import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@oh-my-pi/pi-utils/acp";
import type { HostRef } from "@ompd/core";
import { Ompd } from "../src/daemon.ts";
import {
  type AttachOperatorMcpResult,
  attachOperatorMcpServers,
  parseFailedServerNames,
  resolveOperatorMcpServers,
  toNameValuePairs,
} from "../src/mcp-forwarding.ts";
import { createFakeHost } from "./fake-host.ts";

const scratchDirs: string[] = [];
const runningDaemons: Ompd[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function indexedFakeHost(home: string) {
  const sessionsRoot = join(home, "sessions");
  let nextSession = 0;
  const fake = createFakeHost({
    nextSessionId: () => `fake-sess-${++nextSession}`,
  });
  return { fake, sessionsRoot };
}

async function tokenOf(home: string): Promise<string> {
  return (await Bun.file(join(home, "token")).text()).trim();
}
async function waitForMcpAttachSettled(
  daemon: Ompd,
  agentId: string,
  timeoutMs = 5_000,
): Promise<AttachOperatorMcpResult | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = daemon.getMcpAttach(agentId);
    if (task !== undefined) {
      return await task;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error(`Timed out waiting for MCP attach to register for agent ${agentId} within ${timeoutMs}ms`);
}

async function waitForMcpAttach(daemon: Ompd, agentId: string, timeoutMs = 5_000): Promise<AttachOperatorMcpResult> {
  const result = await waitForMcpAttachSettled(daemon, agentId, timeoutMs);
  if (!result) {
    throw new Error(`Expected MCP attach to settle with attached servers for agent ${agentId}, got ${String(result)}`);
  }
  return result;
}

/**
 * Wait until the daemon has actually offered a server list for this session.
 *
 * The offer is what the security tests below assert on, rather than what
 * successfully connected. Two reasons. A server that is offered and merely
 * fails to connect is still a breach, so the offer is the stronger claim. And
 * whether a fixture connects at all is a property of the fixture: a stdio
 * entry pointed at `/bin/sh -c "exit 0"` is not an MCP server, and whether it
 * lands inside the 250ms startup race before exiting differs by platform,
 * which is why asserting on `attached` passed on macOS and failed on Linux.
 */
async function waitForMcpOffer(
  fake: { resumeRequests: Array<{ mcpServers?: unknown }> },
  timeoutMs = 5_000,
): Promise<Array<{ name: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const offered = fake.resumeRequests[0]?.mcpServers;
    if (Array.isArray(offered)) return offered as Array<{ name: string }>;
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
  throw new Error(`the daemon never offered an mcpServers list within ${timeoutMs}ms`);
}

afterEach(async () => {
  for (const daemon of runningDaemons.splice(0)) await daemon.stop();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mcp-forwarding helpers", () => {
  test("toNameValuePairs converts dictionaries and preserves arrays", () => {
    expect(toNameValuePairs(undefined)).toEqual([]);
    expect(toNameValuePairs({ FOO: "bar", NUM: 123 })).toEqual([
      { name: "FOO", value: "bar" },
      { name: "NUM", value: "123" },
    ]);
    expect(toNameValuePairs([{ name: "A", value: "1" }])).toEqual([{ name: "A", value: "1" }]);
  });

  test("parseFailedServerNames extracts server names and error reasons", () => {
    const batch: McpServer[] = [
      { type: "stdio", name: "goodTool", command: "/bin/sh", env: [] },
      { type: "http", name: "badTool", url: "http://127.0.0.1:1234", headers: [] },
      { type: "http", name: "gitlab:gitlab", url: "http://127.0.0.1:5678", headers: [] },
    ];
    const details = "badTool: HTTP 401: Unauthorized; gitlab:gitlab: HTTP 403: Forbidden";
    const parsed = parseFailedServerNames(details, batch);
    expect(parsed).toEqual([
      { name: "badTool", reason: "HTTP 401: Unauthorized" },
      { name: "gitlab:gitlab", reason: "HTTP 403: Forbidden" },
    ]);
    expect(parsed.find(p => p.name === "goodTool")).toBeUndefined();
  });
});

describe("resolveOperatorMcpServers unit logic", () => {
  const localHost: HostRef = { kind: "local", id: "1", spec: { kind: "local" } };
  const containerHost: HostRef = { kind: "container", id: "c1", spec: { kind: "container" } };

  test("non-local host receives no operator servers and logs reason", async () => {
    const logs: string[] = [];
    const servers = await resolveOperatorMcpServers({
      agentId: "agent-1",
      host: containerHost,
      cwd: "/test/cwd",
      onLog: line => logs.push(line),
      loadConfigs: async () => ({
        configs: {
          testServer: { type: "stdio", command: "/bin/sh" },
        },
      }),
    });
    expect(servers).toEqual([]);
    expect(logs.some(l => l.includes("no operator MCP servers forwarded on this container host"))).toBe(true);
  });

  test("disabled forwarding setting skips operator servers", async () => {
    const logs: string[] = [];
    const servers = await resolveOperatorMcpServers({
      agentId: "agent-1",
      host: localHost,
      cwd: "/test/cwd",
      enabled: false,
      onLog: line => logs.push(line),
      loadConfigs: async () => ({
        configs: {
          testServer: { type: "stdio", command: "/bin/sh" },
        },
      }),
    });
    expect(servers).toEqual([]);
    expect(logs.some(l => l.includes("operator MCP server forwarding is disabled by daemon config"))).toBe(true);
  });

  test("daemon reserved names are dropped unconditionally", async () => {
    const logs: string[] = [];
    const servers = await resolveOperatorMcpServers({
      agentId: "agent-1",
      host: localHost,
      cwd: "/test/cwd",
      onLog: line => logs.push(line),
      loadConfigs: async () => ({
        configs: {
          "ompd-webview": { type: "http", url: "http://127.0.0.1:9000" },
          ompctl: { type: "stdio", command: "/bin/sh" },
          customTool: { type: "stdio", command: "/bin/sh" },
        },
      }),
    });
    expect(servers.find(s => s.name === "ompd-webview")).toBeUndefined();
    expect(servers.find(s => s.name === "ompctl")).toBeUndefined();
    expect(servers.find(s => s.name === "customTool")).toBeDefined();
    expect(logs.some(l => l.includes('operator MCP server "ompctl" dropped because "ompctl" is reserved'))).toBe(true);
    expect(
      logs.some(l => l.includes('operator MCP server "ompd-webview" dropped because "ompd-webview" is reserved')),
    ).toBe(true);
  });

  test("withholds invalid configs and resolves valid stdio and http servers", async () => {
    const logs: string[] = [];
    const servers = await resolveOperatorMcpServers({
      agentId: "agent-1",
      host: localHost,
      cwd: "/test/cwd",
      onLog: line => logs.push(line),
      loadConfigs: async () => ({
        configs: {
          validStdio: { type: "stdio", command: "/bin/sh", args: ["-c", "echo 1"], env: { K: "V" } },
          emptyCommandStdio: { type: "stdio", command: "  " },
          validHttp: { type: "http", url: "http://127.0.0.1:8080/mcp", headers: { auth: "secret" } },
          emptyUrlHttp: { type: "http", url: "" },
          disabledServer: { type: "stdio", command: "/bin/sh", enabled: false },
        },
      }),
    });

    expect(servers.find(s => s.name === "validStdio")).toEqual({
      type: "stdio",
      name: "validStdio",
      command: "/bin/sh",
      args: ["-c", "echo 1"],
      env: [{ name: "K", value: "V" }],
    });
    expect(servers.find(s => s.name === "validHttp")).toEqual({
      type: "http",
      name: "validHttp",
      url: "http://127.0.0.1:8080/mcp",
      headers: [{ name: "auth", value: "secret" }],
    });
    expect(servers.find(s => s.name === "emptyCommandStdio")).toBeUndefined();
    expect(servers.find(s => s.name === "emptyUrlHttp")).toBeUndefined();
    expect(servers.find(s => s.name === "disabledServer")).toBeUndefined();
    expect(logs.some(l => l.includes('operator MCP server "emptyCommandStdio" withheld: command is missing'))).toBe(
      true,
    );
    expect(logs.some(l => l.includes('operator MCP server "emptyUrlHttp" withheld: url is missing'))).toBe(true);
  });
});

describe("attachOperatorMcpServers unit logic", () => {
  const daemonServers: McpServer[] = [
    { type: "http", name: "ompd-webview", url: "http://127.0.0.1:9000/mcp", headers: [] },
  ];

  test("attaches all candidate servers in one call when healthy", async () => {
    const resumeCalls: unknown[][] = [];
    const client = {
      resumeSession: async (_sess: string, _cwd: string, servers: unknown[]) => {
        resumeCalls.push(servers);
        return {};
      },
    };

    const candidates: McpServer[] = [
      { type: "stdio", name: "server1", command: "/bin/sh", env: [] },
      { type: "stdio", name: "server2", command: "/bin/sh", env: [] },
    ];

    const result = await attachOperatorMcpServers({
      client,
      sessionId: "sess-1",
      cwd: "/test/cwd",
      daemonServers,
      candidateServers: candidates,
    });

    expect(result.attached).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toEqual([...daemonServers, ...candidates]);
  });

  test("isolates connect-time failure using parsed error details", async () => {
    const resumeCalls: unknown[][] = [];
    const client = {
      resumeSession: async (_sess: string, _cwd: string, servers: unknown[]) => {
        resumeCalls.push(servers);
        const serverList = servers as McpServer[];
        if (serverList.some(s => s.name === "badServer")) {
          throw new Error("badServer: HTTP 401: Unauthorized");
        }
        return {};
      },
    };

    const candidates: McpServer[] = [
      { type: "stdio", name: "goodServer1", command: "/bin/sh", env: [] },
      { type: "http", name: "badServer", url: "http://127.0.0.1:401", headers: [] },
      { type: "stdio", name: "goodServer2", command: "/bin/sh", env: [] },
    ];

    const logs: string[] = [];
    const result = await attachOperatorMcpServers({
      client,
      sessionId: "sess-2",
      cwd: "/test/cwd",
      daemonServers,
      candidateServers: candidates,
      onLog: line => logs.push(line),
    });

    expect(result.attached.map(s => s.name)).toEqual(["goodServer1", "goodServer2"]);
    expect(result.failed).toEqual([{ name: "badServer", reason: "HTTP 401: Unauthorized" }]);
    expect(logs.some(l => l.includes('operator MCP server "badServer" failed to attach: HTTP 401: Unauthorized'))).toBe(
      true,
    );
    expect(logs.some(l => l.includes("attached 2 operator MCP server(s): goodServer1, goodServer2"))).toBe(true);
  });

  test("uses binary bisection when error details do not name the failing server", async () => {
    const resumeCalls: unknown[][] = [];
    const client = {
      resumeSession: async (_sess: string, _cwd: string, servers: unknown[]) => {
        resumeCalls.push(servers);
        const serverList = servers as McpServer[];
        // s2 causes a generic crash without its name in the error message
        if (serverList.some(s => s.name === "s2")) {
          throw new Error("Internal error: connection reset by peer");
        }
        return {};
      },
    };

    const candidates: McpServer[] = [
      { type: "stdio", name: "s1", command: "/bin/sh", env: [] },
      { type: "stdio", name: "s2", command: "/bin/sh", env: [] },
      { type: "stdio", name: "s3", command: "/bin/sh", env: [] },
      { type: "stdio", name: "s4", command: "/bin/sh", env: [] },
    ];

    const result = await attachOperatorMcpServers({
      client,
      sessionId: "sess-3",
      cwd: "/test/cwd",
      daemonServers,
      candidateServers: candidates,
    });

    expect(result.attached.map(s => s.name)).toEqual(["s1", "s3", "s4"]);
    expect(result.failed.map(f => f.name)).toEqual(["s2"]);
  });

  test("restores session with daemon servers when all operator servers fail", async () => {
    const resumeCalls: unknown[][] = [];
    const client = {
      resumeSession: async (_sess: string, _cwd: string, servers: unknown[]) => {
        resumeCalls.push(servers);
        const serverList = servers as McpServer[];
        if (serverList.some(s => s.name === "broken1" || s.name === "broken2")) {
          throw new Error("broken: failed to connect");
        }
        return {};
      },
    };

    const candidates: McpServer[] = [
      { type: "stdio", name: "broken1", command: "/bin/sh", env: [] },
      { type: "stdio", name: "broken2", command: "/bin/sh", env: [] },
    ];

    const result = await attachOperatorMcpServers({
      client,
      sessionId: "sess-4",
      cwd: "/test/cwd",
      daemonServers,
      candidateServers: candidates,
    });

    expect(result.attached).toHaveLength(0);
    expect(result.failed).toHaveLength(2);
    // The final call must restore daemonServers alone so the ACP session is not left disconnected
    const finalCall = resumeCalls[resumeCalls.length - 1];
    expect(finalCall).toEqual(daemonServers);
  });
});

describe("daemon integration: operator MCP server reachability", () => {
  test("forwardOperatorMcp defaults to false in daemon config", async () => {
    const home = tempDir("ompd-fwd-default-");
    const projectDir = tempDir("ompd-project-def-");

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          myTool: { type: "stdio", command: "/bin/sh", args: ["-c", "exit 0"] },
        },
      }),
    );

    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0 },
      spawnHost: fake.factory,
      voice: false,
    });
    runningDaemons.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const res = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "default-config-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);

    // With default config, no resume request is issued for operator servers
    const body = (await res.json()) as { agent: { id: string } };
    expect(body.agent.id).toBeDefined();
    const initialServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    expect(initialServers.find(s => s.name === "ompd-webview")).toBeDefined();
    expect(initialServers.find(s => s.name === "myTool")).toBeUndefined();
  });

  test("when enabled, session is created with daemon servers and operator servers attach post-creation", async () => {
    const home = tempDir("ompd-fwd-reach-");
    const projectDir = tempDir("ompd-project-");

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          myTool: {
            type: "stdio",
            command: "/bin/sh",
            args: ["-c", "exit 0"],
          },
        },
      }),
    );

    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0, forwardOperatorMcp: true },
      spawnHost: fake.factory,
      voice: false,
    });
    runningDaemons.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const res = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "worker-with-mcp", cwd: projectDir }),
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: { id: string } };

    // Wait for the post-attach promise
    const attachResult = await waitForMcpAttach(daemon, agent.id);
    expect(attachResult.attached.find(s => s.name === "myTool")).toBeDefined();

    // Verify session/new had ONLY daemon servers
    const initialServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    expect(initialServers.find(s => s.name === "ompd-webview")).toBeDefined();
    expect(initialServers.find(s => s.name === "myTool")).toBeUndefined();

    // Verify session/resume attached myTool alongside ompd-webview
    expect(fake.resumeRequests).toHaveLength(1);
    const resumeServers = fake.resumeRequests[0]?.mcpServers as Array<{ name: string }>;
    expect(resumeServers.find(s => s.name === "ompd-webview")).toBeDefined();
    expect(resumeServers.find(s => s.name === "myTool")).toBeDefined();
  });

  test("security: non-orchestrator local session does not receive ompctl even if operator config has it", async () => {
    const home = tempDir("ompd-fwd-sec-");
    const projectDir = tempDir("ompd-project-sec-");

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          ompctl: {
            type: "stdio",
            command: "/bin/sh",
            args: ["-c", "exit 0"],
          },
          safeTool: {
            type: "stdio",
            command: "/bin/sh",
            args: ["-c", "exit 0"],
          },
        },
      }),
    );

    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0, forwardOperatorMcp: true },
      spawnHost: fake.factory,
      voice: false,
    });
    runningDaemons.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const res = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "non-orch-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: { id: string } };

    // The offer, not the connection: see `waitForMcpOffer`. `ompctl` must never
    // be handed to a session without the orchestrator label, whether or not it
    // would have connected.
    const resumeServers = await waitForMcpOffer(fake);
    expect(resumeServers.find(s => s.name === "ompctl")).toBeUndefined();
    expect(resumeServers.find(s => s.name === "safeTool")).toBeDefined();
    expect(resumeServers.find(s => s.name === "ompd-webview")).toBeDefined();
  });

  test("name collision resolves to daemon-owned server for ompd-webview", async () => {
    const home = tempDir("ompd-fwd-collision-");
    const projectDir = tempDir("ompd-project-col-");

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "ompd-webview": {
            type: "http",
            url: "http://127.0.0.1:49999/rogue-webview",
          },
        },
      }),
    );

    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0, forwardOperatorMcp: true },
      spawnHost: fake.factory,
      voice: false,
    });
    runningDaemons.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const res = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "collision-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: { id: string } };
    await waitForMcpAttachSettled(daemon, agent.id);

    // Operator ompd-webview was dropped, so only the daemon-owned server is present
    const sessionServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string; url?: string }>;
    const webviewServers = sessionServers.filter(s => s.name === "ompd-webview");
    expect(webviewServers).toHaveLength(1);
    expect(webviewServers[0]?.url).not.toContain("49999");
    expect(webviewServers[0]?.url).toContain("/mcp/");
  });
  test("server disabled in operator config is not forwarded", async () => {
    const home = tempDir("ompd-fwd-disabled-");
    const projectDir = tempDir("ompd-project-dis-");

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          enabledTool: {
            type: "stdio",
            command: "/bin/sh",
          },
          disabledTool: {
            type: "stdio",
            command: "/bin/sh",
            enabled: false,
          },
        },
      }),
    );

    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0, forwardOperatorMcp: true },
      spawnHost: fake.factory,
      voice: false,
    });
    runningDaemons.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const res = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "dis-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: { id: string } };

    const attachResult = await waitForMcpAttach(daemon, agent.id);
    expect(attachResult.attached.find(s => s.name === "enabledTool")).toBeDefined();
    expect(attachResult.attached.find(s => s.name === "disabledTool")).toBeUndefined();
  });

  test("connect-time failing server does not block session creation, healthy servers attach, session usable", async () => {
    const home = tempDir("ompd-fwd-resilient-home-");
    const projectDir = tempDir("ompd-fwd-resilient-proj-");

    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          failingServer: {
            type: "http",
            url: "http://127.0.0.1:401/unauthorized",
          },
          healthyServer: {
            type: "stdio",
            command: "/bin/sh",
            args: ["-c", "exit 0"],
          },
        },
      }),
    );

    const { fake, sessionsRoot } = indexedFakeHost(home);

    // Simulate ACP behavior: failingServer throws HTTP 401 at resume time
    fake.onResume((_sessionId, _cwd, servers) => {
      const list = servers as Array<{ name: string }>;
      if (list.some(s => s.name === "failingServer")) {
        throw new Error("failingServer: HTTP 401: Unauthorized");
      }
      return {};
    });

    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0, forwardOperatorMcp: true },
      spawnHost: fake.factory,
      voice: false,
    });
    runningDaemons.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    // Session creation MUST succeed and not reject or return 500
    const res = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "resilient-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);
    const { agent } = (await res.json()) as { agent: { id: string; state: string } };
    expect(agent.state).toBe("idle");

    // Wait for post-attach to complete
    const attachResult = await waitForMcpAttach(daemon, agent.id);
    expect(attachResult.attached.find(s => s.name === "healthyServer")).toBeDefined();
    expect(attachResult.failed.find(s => s.name === "failingServer")).toBeDefined();

    // Verify session is usable for prompts
    const promptRes = await fetch(`${info.url}/v1/agents/${agent.id}/prompt`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello" }),
    });
    expect(promptRes.status).toBe(200);
  });
});
