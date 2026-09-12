/**
 * The session MCP surface, driven through a real client.
 *
 * Everything here goes over an in-memory transport into a real `McpServer`,
 * asserting that session management tools are registered, validate against
 * schemas, enforce scopes, and handle daemon responses faithfully.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Agent, SessionTranscriptResponse } from "@ompd/core";
import { z } from "zod";
import type { CliContext } from "../src/client.ts";
import { registerSessionTools, SESSION_TOOL_NAMES } from "../src/mcp/session-tools.ts";

const BASE_URL = "http://127.0.0.1:19999";

const EXPECTED_SESSION_TOOLS = [
  "ompctl_sessions_list",
  "ompctl_session_create",
  "ompctl_session_prompt",
  "ompctl_session_read",
  "ompctl_session_stop",
] as const;

const RESULT_SHAPE = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const scratch: string[] = [];

interface Route {
  status?: number;
  body: unknown;
}

interface Call {
  path: string;
  method: string;
  body: string | null;
}

interface HarnessOptions {
  routes?: Record<string, Route>;
  token?: string | null;
  offline?: boolean;
  env?: Record<string, string | undefined>;
}

interface ToolCall {
  raw: unknown;
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}

interface Harness {
  client: Client;
  calls: Call[];
  call: (name: string, args: Record<string, unknown>) => Promise<ToolCall>;
  close: () => Promise<void>;
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "ompd-session-mcp-"));
  scratch.push(home);
  if (opts.token !== null) writeFileSync(join(home, "token"), `${opts.token ?? "tok_local"}\n`);

  const printed: string[] = [];
  const calls: Call[] = [];
  const routes: Record<string, Route> = { ...opts.routes };

  const ctx: CliContext = {
    out: line => printed.push(line),
    err: line => printed.push(line),
    env: { OMPD_URL: BASE_URL, HOME: home, ...opts.env },
    cwd: home,
    home,
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const target = new URL(url);
      calls.push({
        path: target.pathname + target.search,
        method,
        body: init?.body === undefined ? null : String(init.body),
      });
      if (opts.offline === true) throw new Error("connect ECONNREFUSED 127.0.0.1:19999");

      const route = routes[`${method} ${target.pathname + target.search}`] ?? routes[`${method} ${target.pathname}`];
      if (route === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };

  const server = new McpServer({ name: "ompctl", version: "0.1.0" });
  registerSessionTools(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-session-tools-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools();

  return {
    client,
    calls,
    call: async (name, args) => {
      const raw = await client.callTool({ name, arguments: args });
      const parsed = RESULT_SHAPE.parse(raw);
      return {
        raw,
        text: parsed.content
          .filter(block => block.type === "text")
          .map(block => block.text ?? "")
          .join("\n"),
        structured: parsed.structuredContent ?? {},
        isError: parsed.isError === true,
      };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const AGENT_A: Agent = {
  id: "agt_0000000000000001",
  name: "Worker A",
  state: "idle",
  cwd: "/workspace/proj-a",
  acpSessionId: "sess_0000000000000001",
  host: { kind: "local", id: "lcl_1", spec: { kind: "local" } },
  createdAt: "2026-09-01T00:00:00.000Z",
  lastActiveAt: "2026-09-01T01:00:00.000Z",
  labels: {},
};

const AGENT_B: Agent = {
  id: "agt_0000000000000002",
  name: "Worker B",
  state: "busy",
  cwd: "/workspace/proj-b",
  acpSessionId: "sess_0000000000000002",
  host: { kind: "local", id: "lcl_2", spec: { kind: "local" } },
  createdAt: "2026-09-01T00:00:00.000Z",
  lastActiveAt: "2026-09-01T02:00:00.000Z",
  labels: {},
};

describe("the session tool surface", () => {
  test("advertises exactly the five expected session tools with honest annotations", async () => {
    const h = await harness();
    const list = await h.client.listTools();
    const names = list.tools.map(t => t.name).sort();
    expect(names).toEqual([...EXPECTED_SESSION_TOOLS].sort());
    expect([...SESSION_TOOL_NAMES]).toEqual([...EXPECTED_SESSION_TOOLS]);

    const listTool = list.tools.find(t => t.name === "ompctl_sessions_list");
    expect(listTool?.annotations?.readOnlyHint).toBe(true);
    expect(listTool?.annotations?.idempotentHint).toBe(true);
    expect(listTool?.annotations?.destructiveHint).toBe(false);

    const createTool = list.tools.find(t => t.name === "ompctl_session_create");
    expect(createTool?.annotations?.readOnlyHint).toBe(false);
    expect(createTool?.annotations?.idempotentHint).toBe(false);
    expect(createTool?.annotations?.destructiveHint).toBe(false);

    const promptTool = list.tools.find(t => t.name === "ompctl_session_prompt");
    expect(promptTool?.annotations?.readOnlyHint).toBe(false);
    expect(promptTool?.annotations?.idempotentHint).toBe(false);
    expect(promptTool?.annotations?.destructiveHint).toBe(false);

    const readTool = list.tools.find(t => t.name === "ompctl_session_read");
    expect(readTool?.annotations?.readOnlyHint).toBe(true);
    expect(readTool?.annotations?.idempotentHint).toBe(true);
    expect(readTool?.annotations?.destructiveHint).toBe(false);

    const stopTool = list.tools.find(t => t.name === "ompctl_session_stop");
    expect(stopTool?.annotations?.readOnlyHint).toBe(false);
    expect(stopTool?.annotations?.idempotentHint).toBe(false);
    expect(stopTool?.annotations?.destructiveHint).toBe(true);
    await h.close();
  });
});

describe("ompctl_sessions_list", () => {
  test("lists agents in the fleet and supports filtering by cwd and state", async () => {
    const h = await harness({
      routes: {
        "GET /v1/agents": { body: { agents: [AGENT_A, AGENT_B] } },
      },
    });

    const unfiltered = await h.call("ompctl_sessions_list", {});
    expect(unfiltered.isError).toBe(false);
    expect(unfiltered.structured.count).toBe(2);
    expect(unfiltered.text).toContain("agt_0000000000000001");
    expect(unfiltered.text).toContain("agt_0000000000000002");

    const filteredByCwd = await h.call("ompctl_sessions_list", { cwd: "/workspace/proj-a" });
    expect(filteredByCwd.structured.count).toBe(1);
    expect(filteredByCwd.text).toContain("agt_0000000000000001");
    expect(filteredByCwd.text).not.toContain("agt_0000000000000002");

    const filteredByState = await h.call("ompctl_sessions_list", { state: "busy" });
    expect(filteredByState.structured.count).toBe(1);
    expect(filteredByState.text).toContain("agt_0000000000000002");
    expect(filteredByState.text).not.toContain("agt_0000000000000001");

    await h.close();
  });
});

describe("ompctl_session_create", () => {
  test("creates an agent session and returns the daemon's own verdict", async () => {
    const h = await harness({
      routes: {
        "POST /v1/agents": {
          status: 201,
          body: {
            agent: {
              id: "agt_created12345678",
              name: "new-session",
              state: "idle",
              cwd: "/workspace/new",
              acpSessionId: "sess_created12345678",
              host: { kind: "local", id: "lcl_1" },
              createdAt: "2026-09-11T00:00:00.000Z",
              lastActiveAt: "2026-09-11T00:00:00.000Z",
              labels: {},
            },
          },
        },
      },
    });

    const result = await h.call("ompctl_session_create", {
      cwd: "/workspace/new",
      name: "new-session",
    });

    expect(result.isError).toBe(false);
    expect(result.structured.agentId).toBe("agt_created12345678");
    expect(result.structured.sessionId).toBe("sess_created12345678");
    expect(result.structured.name).toBe("new-session");
    expect(result.structured.cwd).toBe("/workspace/new");
    expect(result.text).toContain("agt_created12345678");
    expect(result.text).toContain("sess_created12345678");

    await h.close();
  });

  test("returns daemon refusal rather than an optimistic echo of the request", async () => {
    const h = await harness({
      routes: {
        "POST /v1/agents": {
          status: 400,
          body: { error: "invalid_cwd", reason: "directory /forbidden does not exist" },
        },
      },
    });

    const result = await h.call("ompctl_session_create", {
      cwd: "/forbidden",
      name: "should-fail",
    });

    // Proves the failure is reported as an error with daemon's verdict, not an optimistic success shape
    expect(result.isError).toBe(true);
    expect(result.structured.agentId).toBeUndefined();
    expect(result.text).toContain("directory /forbidden does not exist");

    await h.close();
  });
});

describe("ompctl_session_prompt", () => {
  test("sends a prompt, waits for turn to settle, and returns assistant reply", async () => {
    const transcriptResponse: SessionTranscriptResponse = {
      sessionId: "sess_0000000000000001",
      entries: [
        { role: "user", text: "hello from orchestrator", at: "2026-09-11T00:00:00.000Z" },
        { role: "assistant", text: "I have finished the assigned task.", at: "2026-09-11T00:00:01.000Z" },
      ],
      messages: [],
      truncated: false,
      nextCursor: null,
    };

    const h = await harness({
      routes: {
        "POST /v1/agents/agt_0000000000000001/prompt": {
          status: 200,
          body: { agentId: "agt_0000000000000001", stopReason: "end_turn" },
        },
        "GET /v1/sessions/agt_0000000000000001/transcript?limit=10": {
          status: 200,
          body: transcriptResponse,
        },
      },
    });

    const result = await h.call("ompctl_session_prompt", {
      agentId: "agt_0000000000000001",
      prompt: "hello from orchestrator",
    });

    expect(result.isError).toBe(false);
    expect(result.structured.agentId).toBe("agt_0000000000000001");
    expect(result.structured.stopReason).toBe("end_turn");
    expect(result.structured.reply).toBe("I have finished the assigned task.");
    expect(result.text).toContain("end_turn");
    expect(result.text).toContain("I have finished the assigned task.");

    await h.close();
  });

  test("refuses prompt addressed to the caller agent when detectable in env to prevent loops", async () => {
    const h = await harness({
      env: { OMP_AGENT_ID: "agt_orchestrator" },
      routes: {
        "POST /v1/agents/agt_orchestrator/prompt": {
          status: 200,
          body: { agentId: "agt_orchestrator", stopReason: "end_turn" },
        },
      },
    });

    const result = await h.call("ompctl_session_prompt", {
      agentId: "agt_orchestrator",
      prompt: "run something",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("calling orchestrator is running as this agent");
    expect(h.calls.filter(c => c.method === "POST")).toHaveLength(0);

    await h.close();
  });
});

describe("ompctl_session_read", () => {
  test("reads transcript and formats turns", async () => {
    const transcriptResponse: SessionTranscriptResponse = {
      sessionId: "sess_0000000000000001",
      entries: [
        { role: "user", text: "step 1", at: "2026-09-11T00:00:00.000Z" },
        { role: "assistant", text: "done step 1", at: "2026-09-11T00:00:01.000Z" },
      ],
      messages: [],
      truncated: false,
      nextCursor: 1234,
    };

    const h = await harness({
      routes: {
        "GET /v1/sessions/sess_0000000000000001/transcript": {
          status: 200,
          body: transcriptResponse,
        },
      },
    });

    const result = await h.call("ompctl_session_read", {
      sessionId: "sess_0000000000000001",
    });

    expect(result.isError).toBe(false);
    expect(result.structured.sessionId).toBe("sess_0000000000000001");
    expect(result.structured.nextCursor).toBe(1234);
    expect(result.text).toContain("step 1");
    expect(result.text).toContain("done step 1");

    await h.close();
  });
});

describe("ompctl_session_stop", () => {
  test("stops an agent and reports confirmation", async () => {
    const h = await harness({
      routes: {
        "DELETE /v1/agents/agt_0000000000000001": {
          status: 200,
          body: { ok: true },
        },
      },
    });

    const result = await h.call("ompctl_session_stop", {
      agentId: "agt_0000000000000001",
    });

    expect(result.isError).toBe(false);
    expect(result.structured.agentId).toBe("agt_0000000000000001");
    expect(result.structured.stopped).toBe(true);
    expect(result.text).toContain("stopped agent agt_0000000000000001");

    await h.close();
  });
});
