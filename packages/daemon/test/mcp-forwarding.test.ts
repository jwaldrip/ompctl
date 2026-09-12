import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRef } from "@ompd/core";
import { Ompd } from "../src/daemon.ts";
import { forwardOperatorMcpServers, isCommandExecutable, probeTcp, toNameValuePairs } from "../src/mcp-forwarding.ts";
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
  const group = join(sessionsRoot, "-fake");
  let nextSession = 0;
  const fake = createFakeHost({
    nextSessionId: () => {
      const id = `01fake${String(++nextSession).padStart(8, "0")}`;
      mkdirSync(join(group, id), { recursive: true });
      return id;
    },
  });
  return { fake, sessionsRoot };
}

async function tokenOf(home: string): Promise<string> {
  return (await Bun.file(join(home, "token")).text()).trim();
}

afterEach(async () => {
  for (const daemon of runningDaemons.splice(0)) await daemon.stop();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mcp-forwarding helpers", () => {
  test("isCommandExecutable identifies executable files and searches PATH", () => {
    expect(isCommandExecutable("")).toBe(false);
    expect(isCommandExecutable("/nonexistent-bin")).toBe(false);
    expect(isCommandExecutable("/bin/sh")).toBe(true);

    const dir = tempDir("ompd-cmd-test-");
    const scriptPath = join(dir, "my-tool");
    writeFileSync(scriptPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    expect(isCommandExecutable(scriptPath)).toBe(true);

    // Searching via custom PATH
    expect(isCommandExecutable("my-tool", dir)).toBe(true);
    expect(isCommandExecutable("missing-tool", dir)).toBe(false);

    // Non-executable file
    const nonExecPath = join(dir, "no-exec");
    writeFileSync(nonExecPath, "data", { mode: 0o644 });
    expect(isCommandExecutable(nonExecPath)).toBe(false);
  });

  test("probeTcp checks open and closed ports", async () => {
    // Port 49999 is closed on loopback, should fail fast
    const closedOk = await probeTcp("127.0.0.1", 49999, 200);
    expect(closedOk).toBe(false);

    // Create a temporary listening HTTP server
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    try {
      const openOk = await probeTcp("127.0.0.1", port, 500);
      expect(openOk).toBe(true);
    } finally {
      server.close();
    }
  });

  test("toNameValuePairs converts dictionaries and preserves arrays", () => {
    expect(toNameValuePairs(undefined)).toEqual([]);
    expect(toNameValuePairs({ FOO: "bar", NUM: 123 })).toEqual([
      { name: "FOO", value: "bar" },
      { name: "NUM", value: "123" },
    ]);
    expect(toNameValuePairs([{ name: "A", value: "1" }])).toEqual([{ name: "A", value: "1" }]);
  });
});

describe("forwardOperatorMcpServers unit logic", () => {
  const localHost: HostRef = { kind: "local", id: "1", spec: { kind: "local" } };
  const containerHost: HostRef = { kind: "container", id: "c1", spec: { kind: "container" } };

  test("non-local host receives no operator servers and logs reason", async () => {
    const logs: string[] = [];
    const servers = await forwardOperatorMcpServers({
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
    const servers = await forwardOperatorMcpServers({
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
    const servers = await forwardOperatorMcpServers({
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

  test("withholds fast-failing servers while preserving healthy ones", async () => {
    const logs: string[] = [];
    const servers = await forwardOperatorMcpServers({
      agentId: "agent-1",
      host: localHost,
      cwd: "/test/cwd",
      onLog: line => logs.push(line),
      loadConfigs: async () => ({
        configs: {
          healthyStdio: { type: "stdio", command: "/bin/sh", args: ["-c", "exit 0"] },
          deadStdio: { type: "stdio", command: "/nonexistent-bin-xyz" },
          closedHttp: { type: "http", url: "http://127.0.0.1:49999" },
        },
      }),
      probeHttp: async url => ({ ok: !url.includes("49999"), reason: "connection to 127.0.0.1:49999 failed" }),
      probeStdio: async cmd => ({ ok: cmd === "/bin/sh", reason: 'command "/nonexistent-bin-xyz" not found' }),
    });

    expect(servers.find(s => s.name === "healthyStdio")).toBeDefined();
    expect(servers.find(s => s.name === "deadStdio")).toBeUndefined();
    expect(servers.find(s => s.name === "closedHttp")).toBeUndefined();
    expect(
      logs.some(l => l.includes('operator MCP server "deadStdio" withheld: command "/nonexistent-bin-xyz" not found')),
    ).toBe(true);
    expect(
      logs.some(l => l.includes('operator MCP server "closedHttp" withheld: connection to 127.0.0.1:49999 failed')),
    ).toBe(true);
  });
});

describe("daemon integration: operator MCP server reachability", () => {
  test("an operator-configured server reaches a daemon-created session", async () => {
    const home = tempDir("ompd-fwd-reach-");
    const projectDir = tempDir("ompd-project-");

    // Write a project-level .mcp.json in projectDir defining a custom local MCP server
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
      body: JSON.stringify({ name: "worker-with-mcp", cwd: projectDir }),
    });
    expect(res.status).toBe(201);

    const sessionServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    const myTool = sessionServers.find(s => s.name === "myTool");
    expect(myTool).toBeDefined();
  });

  test("security: non-orchestrator local session does not receive ompctl even if operator config has it", async () => {
    const home = tempDir("ompd-fwd-sec-");
    const projectDir = tempDir("ompd-project-sec-");

    // Operator config includes both ompctl and a legitimate tool
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
      body: JSON.stringify({ name: "non-orch-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);

    const sessionServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    // Must NOT receive ompctl from operator config
    expect(sessionServers.find(s => s.name === "ompctl")).toBeUndefined();
    // Must still receive safeTool and ompd-webview
    expect(sessionServers.find(s => s.name === "safeTool")).toBeDefined();
    expect(sessionServers.find(s => s.name === "ompd-webview")).toBeDefined();
  });

  test("name collision resolves to daemon-owned server for ompd-webview", async () => {
    const home = tempDir("ompd-fwd-collision-");
    const projectDir = tempDir("ompd-project-col-");

    // Operator config tries to override ompd-webview
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
      body: JSON.stringify({ name: "collision-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);

    const sessionServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string; url?: string }>;
    const webviewServers = sessionServers.filter(s => s.name === "ompd-webview");
    expect(webviewServers).toHaveLength(1);
    // The server present must be the daemon's webview server, not the operator's rogue URL
    expect(webviewServers[0]?.url).not.toContain("49999");
    expect(webviewServers[0]?.url).toContain("/mcp/");
  });

  test("server disabled in operator config is not forwarded", async () => {
    const home = tempDir("ompd-fwd-disabled-");
    const projectDir = tempDir("ompd-project-dis-");

    // Operator config has enabled tool and disabled tool
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
      body: JSON.stringify({ name: "dis-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);

    const sessionServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    expect(sessionServers.find(s => s.name === "enabledTool")).toBeDefined();
    expect(sessionServers.find(s => s.name === "disabledTool")).toBeUndefined();
  });

  test("fast-failing operator servers (closed port, missing command) do not prevent session creation", async () => {
    const home = tempDir("ompd-fwd-fastfail-home-");
    const projectDir = tempDir("ompd-fwd-fastfail-proj-");

    // Write a project-level .mcp.json containing:
    // 1. A closed port HTTP server
    // 2. A non-existent stdio command
    // 3. A healthy stdio command
    writeFileSync(
      join(projectDir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          closedPortServer: {
            type: "http",
            url: "http://127.0.0.1:49999",
          },
          missingCommandServer: {
            type: "stdio",
            command: "/nonexistent-bin-xyz",
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
      body: JSON.stringify({ name: "resilient-worker", cwd: projectDir }),
    });
    expect(res.status).toBe(201);

    const sessionServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    expect(sessionServers.find(s => s.name === "healthyServer")).toBeDefined();
    expect(sessionServers.find(s => s.name === "closedPortServer")).toBeUndefined();
    expect(sessionServers.find(s => s.name === "missingCommandServer")).toBeUndefined();
  });
});
