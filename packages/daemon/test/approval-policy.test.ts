import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, SCOPE_APPROVE, SCOPE_PROMPT } from "@ompd/core";
import { loadConfig, Ompd } from "../src/daemon.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const testAgent: Agent = {
  id: "agt_1",
  name: "test",
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/test",
  createdAt: "",
  lastActiveAt: "",
  labels: {},
};

const originalEnv = { ...process.env };

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  scratch.length = 0;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
});

describe("policyMode derivation from OMP approvalMode", () => {
  test("daemon without policyMode resolves trusted when OMP approvalMode is yolo", () => {
    const ompHome = tempDir("omp-scratch-");
    const ompAgentDir = join(ompHome, "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(join(ompAgentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");

    const home = tempDir("ompd-scratch-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777 }));

    process.env.PI_CODING_AGENT_DIR = ompAgentDir;

    const fake = createFakeHost();
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot: join(home, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    expect(daemon.config.policyMode).toBe("trusted");
    expect(loadConfig(home).policyMode).toBe("trusted");
    expect(daemon.policyModeSource).toBe("omp");
  });

  test("daemon without policyMode resolves strict when OMP approvalMode is always-ask", () => {
    const ompHome = tempDir("omp-scratch-");
    const ompAgentDir = join(ompHome, "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(join(ompAgentDir, "config.yml"), "tools:\n  approvalMode: always-ask\n");

    const home = tempDir("ompd-scratch-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777 }));

    process.env.PI_CODING_AGENT_DIR = ompAgentDir;

    const fake = createFakeHost();
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot: join(home, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    expect(daemon.config.policyMode).toBe("strict");
    expect(loadConfig(home).policyMode).toBe("strict");
    expect(daemon.policyModeSource).toBe("omp");
  });

  test("daemon without policyMode resolves standard when OMP config is absent", () => {
    const ompHome = tempDir("omp-scratch-");
    const ompAgentDir = join(ompHome, "agent");
    mkdirSync(ompAgentDir, { recursive: true });

    const home = tempDir("ompd-scratch-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777 }));

    process.env.PI_CODING_AGENT_DIR = ompAgentDir;

    const fake = createFakeHost();
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot: join(home, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    expect(daemon.config.policyMode).toBe("standard");
    expect(loadConfig(home).policyMode).toBe("standard");
    expect(daemon.policyModeSource).toBe("default");
  });

  test("explicit policyMode in daemon config beats OMP config", () => {
    const ompHome = tempDir("omp-scratch-");
    const ompAgentDir = join(ompHome, "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(join(ompAgentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");

    const home = tempDir("ompd-scratch-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777, policyMode: "strict" }));

    process.env.PI_CODING_AGENT_DIR = ompAgentDir;

    const fake = createFakeHost();
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot: join(home, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    expect(daemon.config.policyMode).toBe("strict");
    expect(daemon.policyModeSource).toBe("file");
  });

  test("explicit override beats both daemon config and OMP config", () => {
    const ompHome = tempDir("omp-scratch-");
    const ompAgentDir = join(ompHome, "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(join(ompAgentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");

    const home = tempDir("ompd-scratch-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777, policyMode: "strict" }));

    process.env.PI_CODING_AGENT_DIR = ompAgentDir;

    const fake = createFakeHost();
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      overrides: { policyMode: "standard" },
      sessionsRoot: join(home, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    expect(daemon.config.policyMode).toBe("standard");
    expect(daemon.policyModeSource).toBe("override");
  });

  test("operator-visible consequence: trusted allows non-critical shell command and prompts on critical command", () => {
    const ompHome = tempDir("omp-scratch-");
    const ompAgentDir = join(ompHome, "agent");
    mkdirSync(ompAgentDir, { recursive: true });
    writeFileSync(join(ompAgentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");

    const home = tempDir("ompd-scratch-");
    writeFileSync(join(home, "config.json"), JSON.stringify({ port: 7777 }));

    process.env.PI_CODING_AGENT_DIR = ompAgentDir;

    const fake = createFakeHost();
    const daemon = new Ompd({
      mcpAuthVault: "file",
      home,
      sessionsRoot: join(home, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    expect(daemon.config.policyMode).toBe("trusted");

    const actor = { deviceId: "operator", scopes: [SCOPE_PROMPT, SCOPE_APPROVE] };

    // In trusted mode: ordinary non-critical command returns allow
    const nonCritical = daemon.policy.evaluate({
      agent: testAgent,
      tool: "bash",
      input: { command: "git status" },
      actor,
    });
    expect(nonCritical.action).toBe("allow");

    // In trusted mode: critical command still returns prompt
    const critical = daemon.policy.evaluate({
      agent: testAgent,
      tool: "bash",
      input: { command: "rm -rf /" },
      actor,
    });
    expect(critical.action).toBe("prompt");

    // In standard mode: ordinary non-critical command returns prompt
    const standardHome = tempDir("ompd-standard-");
    writeFileSync(join(standardHome, "config.json"), JSON.stringify({ port: 7777, policyMode: "standard" }));
    const standardDaemon = new Ompd({
      mcpAuthVault: "file",
      home: standardHome,
      sessionsRoot: join(standardHome, "sessions"),
      spawnHost: fake.factory,
      voice: false,
    });

    const standardNonCritical = standardDaemon.policy.evaluate({
      agent: testAgent,
      tool: "bash",
      input: { command: "git status" },
      actor,
    });
    expect(standardNonCritical.action).toBe("prompt");
  });
});
