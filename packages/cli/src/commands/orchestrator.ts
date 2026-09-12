/**
 * Orchestrator session creation and prompting.
 *
 * An orchestrator is an agent whose role label is "orchestrator", granting it
 * access to the ompctl MCP server for session control tools.
 */

import { basename, resolve } from "node:path";
import type { Agent } from "@ompd/core";
import { UsageError } from "../args.ts";
import { api, type CliContext } from "../client.ts";

interface CreateAgentResponse {
  agent?: Agent;
}

interface PromptResponse {
  stopReason?: string;
}

export interface OrchestratorCommandArgs {
  cwd: string;
  name?: string;
  prompt?: string;
}

export function parseOrchestratorArgs(argv: string[]): OrchestratorCommandArgs {
  let cwd: string | undefined;
  let name: string | undefined;
  let prompt: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--name" || arg === "-n") {
      name = argv[++i];
      if (name === undefined) throw new UsageError("--name requires a value");
    } else if (arg.startsWith("--name=")) {
      name = arg.slice(7);
    } else if (arg === "--prompt" || arg === "-p") {
      prompt = argv[++i];
      if (prompt === undefined) throw new UsageError("--prompt requires a value");
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice(9);
    } else if (arg.startsWith("-")) {
      throw new UsageError(`unknown flag ${arg}`);
    } else if (cwd === undefined) {
      cwd = arg;
    } else {
      throw new UsageError(`unexpected argument: ${arg}`);
    }
  }

  return { cwd: cwd ?? ".", name, prompt };
}

export async function orchestratorCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseOrchestratorArgs(argv);
  const cwd = resolve(ctx.cwd, args.cwd);
  const name = args.name ?? basename(cwd);

  const response = await api<CreateAgentResponse>(ctx, "/v1/agents", {
    method: "POST",
    body: {
      name,
      cwd,
      labels: { role: "orchestrator" },
    },
  });

  const agent = response.agent;
  if (agent === undefined) {
    ctx.err("the daemon created no agent");
    return 1;
  }

  ctx.out(`${agent.id}  ${agent.state}  ${agent.name}`);
  if (agent.acpSessionId) {
    ctx.out(`  session ${agent.acpSessionId}`);
  }
  ctx.out(`  cwd     ${agent.cwd}`);
  ctx.out(`  host    ${agent.host.kind} ${agent.host.id}`);

  const mounts = agent.host.spec?.mounts ?? [];
  if (mounts.length > 0) {
    ctx.out("  mounts:");
    for (const mount of mounts) ctx.out(`    ${mount.hostPath} (${mount.mode ?? "ro"})`);
  }

  if (args.prompt !== undefined && args.prompt.length > 0) {
    const promptResponse = await api<PromptResponse>(ctx, `/v1/agents/${encodeURIComponent(agent.id)}/prompt`, {
      method: "POST",
      body: { text: args.prompt },
    });
    ctx.out(promptResponse.stopReason ?? "unknown");
  }

  return 0;
}
