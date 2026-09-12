import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, type PromptResult } from "@ompd/acp";
import { attachOperatorMcpServers } from "../src/mcp-forwarding.ts";
import { resolveOmp } from "../src/omp-resolver.ts";

const scratchDirs: string[] = [];
const cleanupFns: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanupFns.splice(0)) await fn();
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("post-attach strategy: live ACP session resilience and tool visibility", () => {
  test("create-time forwarding fails on 401 server, whereas post-attach isolates failure and attaches healthy tools", async () => {
    // 1. Mock server that returns HTTP 401 Unauthorized at MCP connect time
    const sBad = Bun.serve({
      port: 0,
      fetch: () => new Response("{}", { status: 401, headers: { "content-type": "application/json" } }),
    });
    cleanupFns.push(() => {
      sBad.stop(true);
    });

    // 2. Healthy mock MCP server that implements initialize and tools/list
    const { promise: toolListPromise, resolve: resolveToolList } = Promise.withResolvers<void>();
    const sGood = Bun.serve({
      port: 0,
      fetch: async req => {
        if (req.method === "POST") {
          const body = (await req.json()) as { method?: string; id?: unknown };
          if (body.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "good-server", version: "1.0.0" },
              },
            });
          }
          if (body.method === "tools/list") {
            resolveToolList();
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [
                  {
                    name: "custom_operator_tool",
                    description: "a custom operator tool",
                    inputSchema: { type: "object", properties: { query: { type: "string" } } },
                  },
                ],
              },
            });
          }
        }
        return Response.json({ jsonrpc: "2.0", error: { code: -32601, message: "not found" } });
      },
    });
    cleanupFns.push(() => {
      sGood.stop(true);
    });

    const ompPath = resolveOmp().path;
    const cwd = mkdtempSync(join(tmpdir(), "post-attach-test-"));
    scratchDirs.push(cwd);

    const proc = spawn(ompPath, ["acp"], { stdio: ["pipe", "pipe", "pipe"], cwd });
    cleanupFns.push(() => {
      proc.kill("SIGKILL");
    });
    const client = new AcpClient(
      line => {
        proc.stdin.write(line);
      },
      {
        onPermission: async () => "allow_once",
        onElicitation: async () => ({ action: "accept", value: "" }),
      },
    );
    proc.stdout.on("data", (chunk: Buffer) => client.ingest(chunk.toString()));

    await client.initialize();

    const badServerDesc = {
      type: "http" as const,
      name: "failingServer",
      url: `http://127.0.0.1:${sBad.port}/mcp`,
      headers: [],
    };
    const goodServerDesc = {
      type: "http" as const,
      name: "healthyServer",
      url: `http://127.0.0.1:${sGood.port}/mcp`,
      headers: [],
    };

    // PROOF PART 1: The old strategy (create-time forwarding) fails session creation
    // when any operator server answers 401 at connect time.
    let createTimeFailed = false;
    try {
      await client.newSession(cwd, [goodServerDesc, badServerDesc]);
    } catch (err) {
      createTimeFailed = true;
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("Internal error");
    }
    expect(createTimeFailed).toBe(true);

    // PROOF PART 2: The new strategy (clean create, post-attach) succeeds:
    // Session is created cleanly with no operator servers.
    const cleanSession = await client.newSession(cwd, []);
    expect(cleanSession.sessionId).toBeDefined();
    const sessionId = cleanSession.sessionId;

    // Attach operator servers: isolates failingServer and attaches healthyServer.
    const attachResult = await attachOperatorMcpServers({
      client,
      sessionId,
      cwd,
      daemonServers: [],
      candidateServers: [goodServerDesc, badServerDesc],
    });

    expect(attachResult.attached.map(s => s.name)).toEqual(["healthyServer"]);
    expect(attachResult.failed.map(f => f.name)).toEqual(["failingServer"]);
    expect(attachResult.failed[0]?.reason).toContain("HTTP 401");

    // PROOF PART 3: The healthy operator server received tools/list and tools are active.
    await toolListPromise;

    // PROOF PART 4: The session is alive, usable, and handles prompts cleanly.
    //
    // Same discipline as scripts/check-mcp-roundtrip.ts: whether a spawned agent
    // can settle a turn depends on model access, and CI has none. The tool call
    // and session liveness are always asserted, while the settled turn is asserted
    // only where a model can actually produce one. The absence is printed rather
    // than passed over: a check that quietly drops its strongest assertion is how
    // a surface stops being covered without anyone noticing.
    let promptRes: PromptResult | undefined;
    let noModel = false;
    let refusalMessage = "";
    try {
      promptRes = await client.prompt(sessionId, "Respond with PONG");
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/no model selected/i.test(text)) {
        noModel = true;
        refusalMessage = text.split("\n")[0] ?? "";
      } else {
        throw err;
      }
    }

    if (noModel) {
      console.log(
        "  note  no model is configured in this environment, so the settled turn was not exercised.\n" +
          `        ACP refusal: ${refusalMessage}`,
      );
      expect(promptRes).toBeUndefined();
    } else {
      expect(promptRes).toBeDefined();
      expect(promptRes!.stopReason).toBe("end_turn");
    }
  }, 30_000);
});
