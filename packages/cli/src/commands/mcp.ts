/**
 * `ompd mcp` and `ompd mcp install`: routines, as tools an OMP session can
 * call.
 *
 * The serve verb is not for a human. omp spawns it, speaks JSON-RPC over the
 * child's stdio, and reads every byte on stdout as protocol framing, so this
 * command's only job on the way in is to load the server and stay off stdout.
 * `main.ts` hands it a context whose `out` already points at stderr for
 * exactly that reason.
 *
 * The install verb is the half that has to be careful. It writes an absolute
 * path into a file omp owns, and both of those words are load-bearing. omp
 * spawns stdio servers without an interactive shell, so a bare `ompd` resolves
 * to nothing under launchd and the operator gets a server that is registered
 * and permanently dead; and the file it writes into holds other people's
 * servers, so omp-config.ts refuses anything it cannot read rather than
 * starting fresh.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { CliContext } from "../client.ts";
import { defaultPrefix, type ProgramResolution, resolveProgram } from "../install.ts";
import { applyOmpMcpInstall, OMP_MCP_SERVER_NAME, ompMcpConfigPath, planOmpMcpInstall } from "../mcp/omp-config.ts";
import { serveRoutinesMcp } from "../mcp/server.ts";

/** Serve routines on stdio until omp closes the transport. */
export async function mcpCommand(ctx: CliContext): Promise<number> {
  await serveRoutinesMcp(ctx);
  return 0;
}

/**
 * Register this binary with omp, once, everywhere omp will look.
 *
 * Nothing here is conditional on the daemon running: this writes a spawn
 * recipe, and the server it registers reaches the daemon over HTTP when a tool
 * is actually called. Installing before the daemon has ever started is the
 * normal case, not an error.
 */
export async function mcpInstallCommand(ctx: CliContext): Promise<number> {
  const program = resolveProgram(defaultPrefix(ctx.env));
  if (program.origin === "source") {
    for (const line of sourceOnlyMessage(program)) ctx.err(line);
    return 1;
  }

  const path = ompMcpConfigPath(ctx.env, ctx.env.HOME ?? homedir());
  // Read here rather than inside the planner, so the planner stays pure and
  // the whole no-clobber decision is assertable without a filesystem.
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const plan = planOmpMcpInstall({ existing, path, command: program.program });
  applyOmpMcpInstall(plan);

  ctx.out(plan.changed ? `wrote ${plan.path}` : `${plan.path} already says this`);
  for (const note of plan.notes) ctx.out(`  ${note}`);
  ctx.out(`  server  ${OMP_MCP_SERVER_NAME}`);
  // The absolute path, printed rather than implied. What omp will exec for the
  // rest of this machine's life should not be something you open a JSON file
  // to discover, and a path inside a checkout is the one case where reading it
  // tells the operator something is about to break.
  ctx.out(`  spawns  ${program.program} mcp`);
  if (program.checkout !== null) {
    ctx.out(`          inside the checkout at ${program.checkout}; it breaks if that is removed`);
  }
  ctx.out("  omp picks this up when it next starts a session");
  return 0;
}

/**
 * The refusal for a checkout with no installed binary.
 *
 * `resolveProgram` answers `bun path/to/main.ts` here, and omp can run neither
 * half of that: it spawns with no shell, so `bun` is not on the path it
 * inherits, and the entry file stops existing the moment the checkout does.
 * Both failures look identical from inside omp, which is a server that never
 * starts and says nothing about why.
 */
function sourceOnlyMessage(program: ProgramResolution): string[] {
  return [
    `refusing to register ${program.program} with omp`,
    "  That is a source entry in a checkout, not an installed binary. omp spawns MCP servers",
    "  with no shell and holds the path indefinitely, so it would need an interpreter it does",
    "  not have, at a path that disappears with the checkout.",
    "",
    "  Install a standalone binary first:",
    "    ompd self-install",
    "    ompd mcp install",
  ];
}
