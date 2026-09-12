import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostRef } from "@ompd/core";
import {
  Ompd,
  orchestratorMcpServerDescriptor,
  orchestratorMcpServersFor,
  resolveOrchestratorSpawn,
} from "../src/daemon.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const running: Ompd[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function indexedFakeHost(home: string) {
  const sessionsRoot = join(home, "sessions");
  const group = join(sessionsRoot, "-fake");
  let nextSession = 0;
  const fake = createFakeHost({
    nextSessionId: () => {
      nextSession += 1;
      const sessionId = `00000000-0000-7000-8000-${String(nextSession).padStart(12, "0")}`;
      mkdirSync(group, { recursive: true });
      writeFileSync(
        join(group, `2026-09-10T00-00-00-000Z_${sessionId}.jsonl`),
        `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-10T00:00:00.000Z", cwd: home })}\n`,
      );
      return sessionId;
    },
  });
  return { fake, sessionsRoot };
}

async function tokenOf(home: string): Promise<string> {
  return (await Bun.file(join(home, "token")).text()).trim();
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("orchestrator wiring", () => {
  test("an ordinary agent gets no ompctl server and an orchestrator-labelled one does", async () => {
    const home = tempDir("ompd-orch-wiring-");
    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0 },
      spawnHost: fake.factory,
      voice: false,
    });
    running.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const ordinaryRes = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "ordinary-worker", cwd: home }),
    });
    expect(ordinaryRes.status).toBe(201);
    const ordinaryServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{ name: string }>;
    expect(ordinaryServers.find(s => s.name === "ompctl")).toBeUndefined();
    expect(ordinaryServers.find(s => s.name === "ompd-webview")).toBeDefined();

    const orchRes = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "orch-worker",
        cwd: home,
        labels: { role: "orchestrator" },
      }),
    });
    expect(orchRes.status).toBe(201);
    const { agent } = (await orchRes.json()) as { agent: { id: string } };

    const orchServers = (fake.newRequests[1]?.mcpServers ?? []) as Array<{
      type?: string;
      name: string;
      command?: string;
      args?: string[];
      env?: Array<{ name: string; value: string }>;
    }>;
    const orchServer = orchServers.find(s => s.name === "ompctl");
    expect(orchServer).toBeDefined();
    expect(orchServer?.type).toBe("stdio");
    expect(orchServer?.command).toBe(process.execPath);
    expect(orchServer?.args).toEqual([expect.stringContaining("main.ts"), "mcp"]);
    expect(orchServer?.env).toEqual([
      { name: "OMPD_HOME", value: home },
      { name: "OMPD_AGENT_ID", value: agent.id },
    ]);
  });

  test("agents with non-orchestrator roles do not get ompctl server", () => {
    const home = "/test/home";
    const localHost: HostRef = { kind: "local", id: "1", spec: { kind: "local" } };

    expect(orchestratorMcpServersFor(home, "agt_1", localHost)).toEqual([]);
    expect(orchestratorMcpServersFor(home, "agt_1", localHost, {})).toEqual([]);
    expect(orchestratorMcpServersFor(home, "agt_1", localHost, { role: "worker" })).toEqual([]);
    expect(orchestratorMcpServersFor(home, "agt_1", localHost, { role: "subagent" })).toEqual([]);
  });

  test("a non-local host yields no descriptor", () => {
    const home = tempDir("ompd-orch-nonlocal-");
    const containerHost: HostRef = {
      kind: "container",
      id: "cnt_1",
      spec: { kind: "container" },
    };
    const containerOffered = orchestratorMcpServersFor(home, "agt_orch", containerHost, { role: "orchestrator" });
    expect(containerOffered).toEqual([]);
  });

  test("any non-local kind yields no descriptor, not just container", () => {
    const home = tempDir("ompd-orch-cloud-");
    const cloudHost: HostRef = {
      kind: "cloud",
      id: "cld_1",
      spec: { kind: "cloud" },
    };
    const cloudOffered = orchestratorMcpServersFor(home, "agt_orch", cloudHost, { role: "orchestrator" });
    expect(cloudOffered).toEqual([]);
  });

  test("a local host is offered orchestrator descriptor", () => {
    const home = "/test/home";
    const localHost: HostRef = { kind: "local", id: "1", spec: { kind: "local" } };
    const offered = orchestratorMcpServersFor(home, "agt_orch", localHost, { role: "orchestrator" });
    expect(offered).toHaveLength(1);
    expect(offered[0]?.name).toBe("ompctl");
    expect(offered[0]?.type).toBe("stdio");
  });

  test("spawn resolution handles bunfs and overrides", () => {
    const overridden = resolveOrchestratorSpawn({ cliEntry: "/custom/path/main.ts" });
    expect(overridden.command).toBe(process.execPath);
    expect(overridden.args).toEqual(["/custom/path/main.ts", "mcp"]);

    const origEnv = process.env.OMPD_CLI_ENTRY;
    try {
      process.env.OMPD_CLI_ENTRY = "/env/path/main.ts";
      const fromEnv = resolveOrchestratorSpawn();
      expect(fromEnv.command).toBe(process.execPath);
      expect(fromEnv.args).toEqual(["/env/path/main.ts", "mcp"]);
    } finally {
      if (origEnv === undefined) {
        delete process.env.OMPD_CLI_ENTRY;
      } else {
        process.env.OMPD_CLI_ENTRY = origEnv;
      }
    }
  });

  test("cliEntry override in Ompd constructor flows to orchestrator descriptor", async () => {
    const home = tempDir("ompd-orch-custom-cli-");
    const { fake, sessionsRoot } = indexedFakeHost(home);
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot,
      overrides: { port: 0 },
      spawnHost: fake.factory,
      voice: false,
      cliEntry: "/custom/cli/main.ts",
    });
    running.push(daemon);
    const info = await daemon.start();
    const operator = await tokenOf(home);

    const orchRes = await fetch(`${info.url}/v1/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${operator}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: "orch-custom",
        cwd: home,
        labels: { role: "orchestrator" },
      }),
    });
    expect(orchRes.status).toBe(201);

    const orchServers = (fake.newRequests[0]?.mcpServers ?? []) as Array<{
      type?: string;
      name: string;
      command?: string;
      args?: string[];
    }>;
    const orchServer = orchServers.find(s => s.name === "ompctl");
    expect(orchServer).toBeDefined();
    expect(orchServer?.args).toEqual(["/custom/cli/main.ts", "mcp"]);
  });

  test("descriptor environment contains OMPD_HOME and OMPD_AGENT_ID", () => {
    const home = "/test/home";
    const agentId = "agt_test123";
    const descriptor = orchestratorMcpServerDescriptor(home, agentId);
    expect(descriptor.type).toBe("stdio");
    if (descriptor.type === "stdio") {
      expect(descriptor.env).toEqual([
        { name: "OMPD_HOME", value: home },
        { name: "OMPD_AGENT_ID", value: agentId },
      ]);
    }
  });

  test("omitting labels returns empty server array", () => {
    const home = "/test/home";
    const localHost: HostRef = { kind: "local", id: "1", spec: { kind: "local" } };
    expect(orchestratorMcpServersFor(home, "agt_1", localHost, undefined)).toEqual([]);
  });
});
