import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent } from "@ompd/core";
import type { CliContext } from "../src/client.ts";
import { run } from "../src/main.ts";

const scratch: string[] = [];

interface Harness {
  ctx: CliContext;
  home: string;
  calls: Array<{ url: string; method: string; body: unknown; authorization: string | null }>;
  stdout: () => string;
  stderr: () => string;
  stdoutLines: () => string[];
  stderrLines: () => string[];
}

interface HarnessOptions {
  routes?: Record<string, { status?: number; body: unknown }>;
  token?: string | null;
  env?: Record<string, string | undefined>;
}

function harness(opts: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "ompd-orch-cli-"));
  scratch.push(home);
  if (opts.token !== null) writeFileSync(join(home, "token"), `${opts.token ?? "tok_local"}\n`);

  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = [];
  const routes: Record<string, { status?: number; body: unknown }> = { ...opts.routes };

  const ctx: CliContext = {
    out: line => out.push(line),
    err: line => err.push(line),
    env: { OMPD_URL: "http://127.0.0.1:19999", HOME: home, ...opts.env },
    cwd: home,
    home,
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname + new URL(url).search;
      const headers = new Headers(init?.headers);
      calls.push({
        url: path,
        method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        authorization: headers.get("authorization"),
      });

      const route = routes[`${method} ${path}`] ?? routes[path];
      if (route === undefined) {
        return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      }
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };

  return {
    ctx,
    home,
    calls,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    stdoutLines: () => [...out],
    stderrLines: () => [...err],
  };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fakeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt_8da4625aa24a4101",
    name: "e2e-orchestrator",
    state: "idle",
    acpSessionId: "01a09435-6bdc-7000-849c-ed0f3f378174",
    cwd: "/tmp/work",
    host: { kind: "local", id: "73885", spec: { kind: "local" } },
    createdAt: "2026-09-11T00:00:00.000Z",
    lastActiveAt: "2026-09-11T00:00:00.000Z",
    labels: { role: "orchestrator" },
    ...overrides,
  };
}

describe("orchestrator command", () => {
  test("creates an orchestrator session with role: 'orchestrator' and prints identifiers", async () => {
    const agent = fakeAgent();
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: { agent },
        },
      },
    });

    const code = await run(["orchestrator", "/tmp/work", "--name", "e2e-orchestrator"], h.ctx);
    expect(code).toBe(0);

    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.method).toBe("POST");
    expect(h.calls[0]?.url).toBe("/v1/agents");
    expect(h.calls[0]?.body).toEqual({
      name: "e2e-orchestrator",
      cwd: "/tmp/work",
      labels: { role: "orchestrator" },
    });

    const lines = h.stdoutLines();
    expect(lines[0]).toBe("agt_8da4625aa24a4101  idle  e2e-orchestrator");
    expect(lines[1]).toBe("  session 01a09435-6bdc-7000-849c-ed0f3f378174");
    expect(lines[2]).toBe("  cwd     /tmp/work");
    expect(lines[3]).toBe("  host    local 73885");
  });

  test("defaults cwd to ctx.cwd and name to basename of cwd", async () => {
    const h = harness();
    const expectedName = basename(h.home);
    const agent = fakeAgent({ name: expectedName, cwd: h.home });

    const hWithRoutes = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: { agent },
        },
      },
    });

    const code = await run(["orchestrator"], hWithRoutes.ctx);
    expect(code).toBe(0);

    expect(hWithRoutes.calls).toHaveLength(1);
    expect(hWithRoutes.calls[0]?.body).toEqual({
      name: basename(hWithRoutes.ctx.cwd),
      cwd: hWithRoutes.ctx.cwd,
      labels: { role: "orchestrator" },
    });
  });

  test("supports --prompt flag by sending separate prompt after creation", async () => {
    const agent = fakeAgent();
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: { agent },
        },
        "POST /v1/agents/agt_8da4625aa24a4101/prompt": {
          status: 200,
          body: { stopReason: "end_turn" },
        },
      },
    });

    const code = await run(
      ["orchestrator", "/tmp/work", "--name", "e2e-orchestrator", "--prompt", "coordinate tasks"],
      h.ctx,
    );
    expect(code).toBe(0);

    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]?.url).toBe("/v1/agents");
    expect(h.calls[1]?.url).toBe("/v1/agents/agt_8da4625aa24a4101/prompt");
    expect(h.calls[1]?.body).toEqual({ text: "coordinate tasks" });

    const lines = h.stdoutLines();
    expect(lines).toContain("agt_8da4625aa24a4101  idle  e2e-orchestrator");
    expect(lines).toContain("  session 01a09435-6bdc-7000-849c-ed0f3f378174");
    expect(lines).toContain("end_turn");
  });

  test("supports equals syntax for --name= and --prompt=", async () => {
    const agent = fakeAgent({ name: "eq-orch" });
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: { agent },
        },
        "POST /v1/agents/agt_8da4625aa24a4101/prompt": {
          status: 200,
          body: { stopReason: "end_turn" },
        },
      },
    });

    const code = await run(["orchestrator", "/tmp/work", "--name=eq-orch", "--prompt=test-eq"], h.ctx);
    expect(code).toBe(0);
    expect(h.calls[0]?.body).toEqual({
      name: "eq-orch",
      cwd: "/tmp/work",
      labels: { role: "orchestrator" },
    });
    expect(h.calls[1]?.body).toEqual({ text: "test-eq" });
  });

  test("supports short flags -n and -p", async () => {
    const agent = fakeAgent({ name: "short-orch" });
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: { agent },
        },
        "POST /v1/agents/agt_8da4625aa24a4101/prompt": {
          status: 200,
          body: { stopReason: "end_turn" },
        },
      },
    });

    const code = await run(["orchestrator", "/tmp/work", "-n", "short-orch", "-p", "short-prompt"], h.ctx);
    expect(code).toBe(0);
    expect(h.calls[0]?.body).toEqual({
      name: "short-orch",
      cwd: "/tmp/work",
      labels: { role: "orchestrator" },
    });
    expect(h.calls[1]?.body).toEqual({ text: "short-prompt" });
  });

  test("orchestrator --help prints CLI usage including orchestrator entry", async () => {
    const h = harness();
    const code = await run(["orchestrator", "--help"], h.ctx);
    expect(code).toBe(0);
    const stdout = h.stdout();
    expect(stdout).toContain("orchestrator [<cwd>] [--name N] [--prompt P]");
    expect(stdout).toContain("create an orchestrator session with session-control tools");
  });

  test("handles daemon failure when creating agent", async () => {
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 500,
          body: { error: "agent_creation_failed" },
        },
      },
    });

    const code = await run(["orchestrator", "/tmp/work"], h.ctx);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("ompd: agent_creation_failed");
  });

  test("handles daemon returning empty agent in response body", async () => {
    const h = harness({
      routes: {
        "POST /v1/agents": {
          status: 200,
          body: {},
        },
      },
    });

    const code = await run(["orchestrator", "/tmp/work"], h.ctx);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("the daemon created no agent");
  });

  test("rejects unknown flags", async () => {
    const h = harness();
    const code = await run(["orchestrator", "--unrecognized-flag"], h.ctx);
    expect(code).toBe(2);
    expect(h.stderr()).toContain("unknown flag --unrecognized-flag");
  });

  test("rejects missing values for --name and --prompt", async () => {
    const h1 = harness();
    const code1 = await run(["orchestrator", "--name"], h1.ctx);
    expect(code1).toBe(2);
    expect(h1.stderr()).toContain("--name requires a value");

    const h2 = harness();
    const code2 = await run(["orchestrator", "--prompt"], h2.ctx);
    expect(code2).toBe(2);
    expect(h2.stderr()).toContain("--prompt requires a value");
  });
});
