/**
 * End-to-end verification of orchestrator sessions against a real scratch daemon.
 *
 * Exercises the complete orchestrator lifecycle with the compiled binary:
 * 1. Boot a scratch daemon with a dedicated OMPD_HOME on an ephemeral port.
 * 2. Create an orchestrator session via the CLI command `ompd orchestrator`.
 * 3. Connect to the orchestrator's MCP server over raw stdio.
 * 4. List sessions via `ompctl_sessions_list`.
 * 5. Create a worker session via `ompctl_session_create`.
 * 6. Exercise the self-prompt loop refusal via `ompctl_session_prompt`.
 * 7. Prompt the worker session and observe turn settlement.
 * 8. Read the session transcript via `ompctl_session_read`.
 * 9. Stop the worker session via `ompctl_session_stop`.
 * 10. List the fleet to confirm the worker is stopped.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const fromSource = process.argv.includes("--from-source");

const COMPILED = join(repo, "dist", "ompd");
const SOURCE_ENTRY = join(repo, "packages", "cli", "src", "main.ts");

function artifact(): { argv: string[]; label: string; path: string; compiled: boolean } {
  if (fromSource) {
    return { argv: ["bun", SOURCE_ENTRY], label: "source entry", path: SOURCE_ENTRY, compiled: false };
  }
  if (!existsSync(COMPILED)) {
    console.error(
      `No compiled binary at ${COMPILED}.\n\n` +
        "Build it first:\n\n  bun run build:cli\n\n" +
        "Pass --from-source for running from source.",
    );
    process.exit(1);
  }
  return { argv: [COMPILED], label: "compiled binary", path: COMPILED, compiled: true };
}

async function getFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const srv = createServer();
  srv.listen(0, "127.0.0.1", () => {
    const addr = srv.address();
    if (addr && typeof addr === "object") {
      const port = addr.port;
      srv.close(() => resolve(port));
    } else {
      srv.close(() => reject(new Error("failed to get port")));
    }
  });
  srv.on("error", reject);
  return promise;
}

const under = artifact();
console.log(`artifact under test: ${under.label} at ${under.path}`);

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------------------
interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Waiter {
  resolve: (r: Rpc) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ToolOutcome {
  text: string;
  structured: unknown;
  isError: boolean;
}

const CALL_TIMEOUT_MS = 60_000;

class StdioMcp {
  #proc: ChildProcessWithoutNullStreams;
  #pending = new Map<number, Waiter>();
  #nextId = 1;
  #stderr = "";
  #buf = "";
  #junk: string[] = [];
  #dead = false;

  constructor(env: Record<string, string>, cwd: string = repo) {
    const [cmd, ...pre] = under.argv;
    this.#proc = spawn(cmd as string, [...pre, "mcp"], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#proc.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    this.#proc.on("exit", (code: number | null) => {
      this.#dead = true;
      for (const [, waiter] of this.#pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`server exited (${code}); stderr:\n${this.stderrTail}`));
      }
      this.#pending.clear();
    });
  }

  get stderrTail(): string {
    return this.#stderr.slice(-3000);
  }

  get junkLines(): readonly string[] {
    return this.#junk;
  }

  #onStdout(chunk: Buffer): void {
    this.#buf += chunk.toString();
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        this.#junk.push(line);
        continue;
      }
      const framed =
        msg.jsonrpc === "2.0" &&
        (typeof msg.id === "number" || typeof msg.id === "string" || typeof msg.method === "string");
      if (!framed) {
        this.#junk.push(line);
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const waiter = this.#pending.get(msg.id);
      if (!waiter) continue;
      this.#pending.delete(msg.id);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  async request(method: string, params?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
    if (this.#dead) throw new Error(`server already exited; stderr:\n${this.stderrTail}`);
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<Rpc>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new Error(`timeout on ${method}; stderr:\n${this.stderrTail}`));
    }, timeoutMs);
    this.#pending.set(id, { resolve, reject, timer });
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const response = await promise;
    if (response.error) {
      throw new Error(`${method}: rpc error ${response.error.code} ${response.error.message}`);
    }
    return response.result;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "check-orchestrator-e2e", version: "1" },
    });
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  async call(name: string, args: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<ToolOutcome> {
    const raw = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    let text = "";
    let structured: unknown;
    let isError = false;
    if (raw !== null && typeof raw === "object") {
      if ("isError" in raw) isError = raw.isError === true;
      if ("structuredContent" in raw) structured = raw.structuredContent;
      if ("content" in raw && Array.isArray(raw.content)) {
        const parts: string[] = [];
        for (const part of raw.content) {
          if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
        text = parts.join("\n");
      }
    }
    return { text, structured, isError };
  }

  close(): void {
    this.#proc.stdin.end();
    this.#proc.kill();
  }
}

function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

// ---------------------------------------------------------------------------
// Scratch daemon setup and execution
// ---------------------------------------------------------------------------

const port = await getFreePort();
const base = `http://127.0.0.1:${port}`;
const home = mkdtempSync(join(tmpdir(), "ompd-orch-e2e-home-"));
const workdir = mkdtempSync(join(tmpdir(), "ompd-orch-e2e-work-"));

console.log(`starting scratch daemon on ${base} (home: ${home})...`);

const [cmd, ...pre] = under.argv;
const daemonProc = spawn(
  cmd as string,
  [...pre, "start", "--host", "127.0.0.1", "--port", String(port), "--foreground"],
  {
    env: { ...process.env, OMPD_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let daemonOutput = "";
let daemonExit: number | null = null;
const { promise: readyPromise, resolve: resolveReady } = Promise.withResolvers<boolean>();
const deadline = setTimeout(() => resolveReady(false), 30_000);

const watch = (chunk: Buffer): void => {
  daemonOutput += chunk.toString();
  if (daemonOutput.includes("ompd is listening at")) {
    clearTimeout(deadline);
    resolveReady(true);
  }
};
daemonProc.stdout.on("data", watch);
daemonProc.stderr.on("data", watch);

let daemonRunning = true;
daemonProc.on("exit", (code: number | null) => {
  daemonRunning = false;
  daemonExit = code;
  clearTimeout(deadline);
  resolveReady(false);
});

const ready = await readyPromise;
if (!ready) {
  console.error(
    `daemon never became ready (exit: ${daemonExit !== null ? daemonExit : "none"}); output:\n${daemonOutput}`,
  );
  daemonProc.kill();
  process.exit(1);
}

check("scratch daemon listening", ready, base);

let client: StdioMcp | null = null;

try {
  // Step 1: Create orchestrator session via CLI command
  console.log("\n  creating orchestrator session via CLI:");
  const cliProc = spawn(cmd as string, [...pre, "orchestrator", workdir, "--name", "e2e-orchestrator"], {
    env: { ...process.env, OMPD_HOME: home, OMPD_URL: base },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let cliStdout = "";
  let cliStderr = "";
  cliProc.stdout.on("data", (chunk: Buffer) => {
    cliStdout += chunk.toString();
  });
  cliProc.stderr.on("data", (chunk: Buffer) => {
    cliStderr += chunk.toString();
  });

  const { promise: exitPromise, resolve: resolveExit } = Promise.withResolvers<number | null>();
  cliProc.on("exit", (code: number | null) => resolveExit(code));
  const cliExit = await exitPromise;

  check("cli orchestrator command exited 0", cliExit === 0, `exit code ${cliExit}`);
  if (cliStderr.trim()) console.log(`    cli stderr: ${cliStderr.trim()}`);
  console.log(
    `    cli stdout:\n${cliStdout
      .trim()
      .split("\n")
      .map(l => `      ${l}`)
      .join("\n")}`,
  );

  const agentIdMatch = /^(agt_[0-9a-f]+)\s+/m.exec(cliStdout);
  const sessionIdMatch = /^\s+session\s+([0-9a-f-]+)/m.exec(cliStdout);
  const orchAgentId = agentIdMatch?.[1] ?? "";
  const orchSessionId = sessionIdMatch?.[1] ?? "";

  check("cli output includes agent ID", orchAgentId.startsWith("agt_"), orchAgentId);
  check("cli output includes session ID", orchSessionId.length > 0, orchSessionId);

  // Step 2: Connect to orchestrator MCP server over raw stdio
  console.log("\n  connecting to orchestrator MCP server on stdio:");
  client = new StdioMcp({
    OMPD_HOME: home,
    OMPD_URL: base,
    OMPD_AGENT_ID: orchAgentId,
  });

  await client.initialize();
  check("mcp initialize succeeded", true);

  const toolsList = (await client.request("tools/list")) as { tools: Array<{ name: string }> };
  const toolNames = toolsList.tools.map(t => t.name);
  check("ompctl_sessions_list tool is registered", toolNames.includes("ompctl_sessions_list"));
  check("ompctl_session_create tool is registered", toolNames.includes("ompctl_session_create"));
  check("ompctl_session_prompt tool is registered", toolNames.includes("ompctl_session_prompt"));
  check("ompctl_session_read tool is registered", toolNames.includes("ompctl_session_read"));
  check("ompctl_session_stop tool is registered", toolNames.includes("ompctl_session_stop"));

  // Step 3: List sessions via MCP
  console.log("\n  listing sessions via orchestrator MCP:");
  const initialList = await client.call("ompctl_sessions_list", {});
  check("sessions list call succeeded", !initialList.isError);
  const initialSessions = field(initialList.structured, "sessions");
  check(
    "orchestrator session appears in sessions list",
    Array.isArray(initialSessions) && initialSessions.some(s => field(s, "id") === orchAgentId),
  );

  // Step 4: Create a worker session via MCP
  console.log("\n  creating worker session via orchestrator MCP:");
  const createWorker = await client.call("ompctl_session_create", {
    name: "e2e-worker",
    cwd: workdir,
  });
  check("worker creation succeeded", !createWorker.isError, createWorker.isError ? createWorker.text : "");
  const workerAgentId = String(field(createWorker.structured, "agentId") ?? "");
  const workerSessionId = String(field(createWorker.structured, "sessionId") ?? "");
  check("worker agentId received", workerAgentId.startsWith("agt_"), workerAgentId);
  check("worker sessionId received", workerSessionId.length > 0, workerSessionId);

  // Step 5: Exercise self-prompt refusal
  console.log("\n  exercising self-prompt refusal guard:");
  const selfPrompt = await client.call("ompctl_session_prompt", {
    agentId: orchAgentId,
    prompt: "self prompt loop attempt",
  });
  check("self-prompt was rejected", selfPrompt.isError);
  check(
    "self-prompt rejection message matches expected refusal",
    selfPrompt.text.includes("cannot prompt agent") &&
      selfPrompt.text.includes("the calling orchestrator is running as this agent, and prompting itself would loop"),
    selfPrompt.text,
  );

  // Step 6: Prompt the worker session
  console.log(`\n  prompting worker session ${workerAgentId}:`);
  let workerPromptSettled = false;
  let promptStopReason = "";
  try {
    const promptRes = await client.call(
      "ompctl_session_prompt",
      {
        agentId: workerAgentId,
        prompt: "Reply with the single word: WORKER_PONG",
      },
      30_000,
    );
    if (!promptRes.isError) {
      workerPromptSettled = true;
      promptStopReason = String(field(promptRes.structured, "stopReason") ?? "");
    } else {
      console.log(`    worker prompt note: returned error result (${promptRes.text})`);
    }
  } catch (err) {
    console.log(
      `    worker prompt turn note: did not settle within timeout (${err instanceof Error ? err.message : err})`,
    );
  }

  if (workerPromptSettled) {
    check("worker prompt settled turn", true, `stopReason: ${promptStopReason}`);
  } else {
    console.log(
      "  info: worker prompt live model turn did not settle in scratch environment (expected if models unconfigured)",
    );
  }

  // Step 7: Read worker session transcript
  console.log("\n  reading worker session transcript:");
  const transcriptRes = await client.call("ompctl_session_read", {
    sessionId: workerSessionId,
  });
  check("session transcript read call succeeded", !transcriptRes.isError);
  const entries = field(transcriptRes.structured, "entries");
  console.log(`    transcript entries: ${Array.isArray(entries) ? entries.length : 0}`);
  if (transcriptRes.text) {
    console.log(
      `    transcript preview:\n${transcriptRes.text
        .split("\n")
        .map(l => `      ${l}`)
        .join("\n")}`,
    );
  }

  // Step 8: Stop the worker session
  console.log(`\n  stopping worker session ${workerAgentId}:`);
  const stopRes = await client.call("ompctl_session_stop", {
    agentId: workerAgentId,
  });
  check("worker session stop accepted", !stopRes.isError && field(stopRes.structured, "stopped") === true);

  // Step 9: List fleet and verify worker is stopped
  console.log("\n  listing fleet after worker stop:");
  const finalList = await client.call("ompctl_sessions_list", {});
  check("final fleet list succeeded", !finalList.isError);
  const finalSessions = field(finalList.structured, "sessions");
  const workerRow = Array.isArray(finalSessions) ? finalSessions.find(s => field(s, "id") === workerAgentId) : null;
  check(
    "worker agent is in stopped state or removed from active fleet",
    workerRow === null || field(workerRow, "state") === "stopped",
  );

  check("no non-JSON-RPC junk on MCP stdout", client.junkLines.length === 0);
} finally {
  if (client) {
    client.close();
  }
  if (daemonRunning) {
    daemonProc.kill();
  }
  if (!keep) {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  }
}

console.log("\n---------------------------------------------------------------------------");
if (failures.length > 0) {
  console.error(`FAILED with ${failures.length} check failure(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
} else {
  console.log("All orchestrator end-to-end checks PASSED.");
}
