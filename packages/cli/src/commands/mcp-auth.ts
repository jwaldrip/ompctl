/**
 * The operator's view of brokered MCP grants.
 *
 * Everything here reads or drives the daemon over the same HTTP surface a
 * paired phone uses. No command in this file touches a refresh token, a client
 * secret, or an access token, and none of them can: the daemon has no route
 * that returns one. What an operator gets is a state per grant and, when the
 * state needs a person, the exact line that fixes it.
 */

import type { McpAuthState, McpAuthStatus, McpAuthSummary } from "@ompd/core";
import type { Command } from "../args.ts";
import { api, type CliContext } from "../client.ts";
import { age, table } from "../format.ts";

interface LoginBegun {
  flowId: string;
  authorizationUrl: string;
}

interface LoginProgress {
  state: "pending" | "complete" | "failed";
  grantId?: string;
  serverName?: string;
  detail?: string;
}

interface RefreshResult {
  outcome: "ok" | "definitive" | "transient";
  state: McpAuthState;
  detail?: string;
}

interface ImportResult {
  refused?: "broker_running";
  dryRun: boolean;
  imported: Array<{ grantId: string; serverName: string; resourceUrl: string; recoveredTokenUrl: boolean }>;
  skipped: Array<{ resourceUrl: string; reason: string }>;
}

interface ApplyResult {
  applied: Array<{ serverName: string; brokerName: string; url: string }>;
  disabled: string[];
  skipped: Array<{ serverName: string; state: McpAuthState; detail: string }>;
}

interface UnapplyResult {
  removed: string[];
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * One line per state, in the operator's language rather than the protocol's.
 *
 * `no_refresh_grant` gets the longest explanation because it is the only state
 * no amount of daemon effort can improve, and the temptation when reading a red
 * row is to retry it forever.
 */
function remedy(grant: McpAuthSummary): string {
  switch (grant.state) {
    case "healthy":
      return "";
    case "refreshing":
      return "exchange in flight";
    case "degraded":
      return `retrying${grant.nextAttemptAt === undefined ? "" : ` at ${grant.nextAttemptAt}`}`;
    case "reauth_required":
      return "run `ompd mcp-auth login` with this row's RESOURCE URL";
    case "no_refresh_grant":
      return "provider issues no refresh token; nothing can renew this unattended";
  }
}

export async function mcpAuthStatusCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "mcp-auth"; action: "status" }>,
): Promise<number> {
  const status = await api<McpAuthStatus>(ctx, "/v1/mcp-auth");
  if (cmd.json) {
    ctx.out(JSON.stringify(status, null, 2));
    return 0;
  }

  ctx.out(`broker    ${status.endpoint ?? "not listening"}`);
  ctx.out(`at rest   ${status.vault}`);
  if (status.grants.length === 0) {
    ctx.out("");
    ctx.out("No grants. `ompd mcp-auth import` copies the ones OMP already holds,");
    ctx.out("or `ompd mcp-auth login <mcp-url>` authorizes a new one.");
    return 0;
  }

  ctx.out("");
  for (const line of table(
    ["ID", "SERVER", "STATE", "WIRED", "REFRESHED", "EXPIRES", "NOTE"],
    status.grants.map(grant => [
      grant.id,
      grant.serverName,
      grant.state,
      grant.wired ? "yes" : "no",
      age(grant.lastRefreshAt),
      grant.accessExpiresAt ?? "-",
      remedy(grant) || (grant.detail ?? ""),
    ]),
  )) {
    ctx.out(line);
  }
  return 0;
}

/**
 * Begin an authorization and wait for the person to finish it in a browser.
 *
 * The callback listener belongs to the daemon, not to this process: the daemon
 * is what has to hold the resulting refresh token, and a CLI that received the
 * code itself would have to hand a credential across a process boundary to give
 * it away. So this command prints a URL and polls.
 */
export async function mcpAuthLoginCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "mcp-auth"; action: "login" }>,
): Promise<number> {
  const begun = await api<LoginBegun>(ctx, "/v1/mcp-auth/login", {
    method: "POST",
    body: { resourceUrl: cmd.resourceUrl, name: cmd.name },
  });

  ctx.out("Open this to authorize:");
  ctx.out("");
  ctx.out(`  ${begun.authorizationUrl}`);
  ctx.out("");
  ctx.out("Waiting for the callback. Ctrl-C stops waiting; the daemon keeps the flow open.");

  const deadline = Date.now() + 300_000;
  for (;;) {
    await sleep(1000);
    const progress = await api<LoginProgress>(ctx, `/v1/mcp-auth/login/${begun.flowId}`);
    if (progress.state === "complete") {
      ctx.out(`Authorized ${progress.serverName ?? cmd.resourceUrl} as ${progress.grantId}.`);
      ctx.out("Run `ompd mcp-auth apply` to point OMP's MCP config at the broker.");
      return 0;
    }
    if (progress.state === "failed") {
      ctx.err(`Authorization failed: ${progress.detail ?? "no detail"}`);
      return 1;
    }
    if (Date.now() > deadline) {
      ctx.err("Timed out waiting for the callback.");
      return 1;
    }
  }
}

export async function mcpAuthImportCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "mcp-auth"; action: "import" }>,
): Promise<number> {
  const result = await api<ImportResult>(ctx, "/v1/mcp-auth/import", {
    method: "POST",
    body: { dryRun: cmd.dryRun, force: cmd.force },
  });

  if (result.refused === "broker_running") {
    ctx.err("An omp auth-broker is listening on 127.0.0.1:8765.");
    ctx.err("Its background refresher would redeem the same rotating refresh tokens this");
    ctx.err("daemon is about to hold, and one of the two would get the family revoked.");
    ctx.err("Stop it, or pass --force if you know it will not touch these grants.");
    return 1;
  }

  ctx.out(result.dryRun ? "Would import:" : "Imported:");
  if (result.imported.length === 0) {
    ctx.out("  nothing");
  }
  for (const row of result.imported) {
    const note = row.recoveredTokenUrl ? "  (token endpoint recovered by discovery)" : "";
    ctx.out(`  ${row.grantId}  ${row.serverName}  ${row.resourceUrl}${note}`);
  }

  if (result.skipped.length > 0) {
    ctx.out("");
    ctx.out("Skipped:");
    for (const row of result.skipped) ctx.out(`  ${row.resourceUrl}  ${row.reason}`);
  }
  return 0;
}

export async function mcpAuthApplyCommand(ctx: CliContext): Promise<number> {
  const result = await api<ApplyResult>(ctx, "/v1/mcp-auth/apply", { method: "POST" });
  const reportSkipped = (): void => {
    if (result.skipped.length === 0) return;
    ctx.out("");
    ctx.out("Left alone, because wiring one of these would disable a definition that works today:");
    for (const row of result.skipped) ctx.out(`  ${row.serverName}  ${row.state}  ${row.detail}`);
  };
  if (result.applied.length === 0) {
    ctx.out("Nothing to apply.");
    reportSkipped();
    return 0;
  }
  ctx.out("OMP's MCP config now points at the broker for:");
  for (const row of result.applied) ctx.out(`  ${row.brokerName}  ${row.url}`);
  if (result.disabled.length > 0) {
    ctx.out("");
    ctx.out(`Shadowed the unbrokered definitions: ${result.disabled.join(", ")}`);
  }
  reportSkipped();
  ctx.out("");
  ctx.out("Existing sessions keep their old connections; `/mcp reload` picks this up.");
  return 0;
}

export async function mcpAuthUnapplyCommand(ctx: CliContext): Promise<number> {
  const result = await api<UnapplyResult>(ctx, "/v1/mcp-auth/unapply", { method: "POST" });
  ctx.out(result.removed.length === 0 ? "Nothing was applied." : `Restored: ${result.removed.join(", ")}`);
  return 0;
}

export async function mcpAuthRefreshCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "mcp-auth"; action: "refresh" }>,
): Promise<number> {
  const result = await api<RefreshResult>(ctx, `/v1/mcp-auth/${cmd.grantId}/refresh`, { method: "POST" });
  if (result.outcome === "ok") {
    ctx.out(`Refreshed. ${cmd.grantId} is ${result.state}.`);
    return 0;
  }
  ctx.err(`${result.outcome === "definitive" ? "Refused" : "Failed"}: ${result.detail ?? "no detail"}`);
  ctx.err(`${cmd.grantId} is ${result.state}.`);
  return 1;
}

export async function mcpAuthLogoutCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "mcp-auth"; action: "logout" }>,
): Promise<number> {
  await api<{ removed: boolean }>(ctx, `/v1/mcp-auth/${cmd.grantId}`, { method: "DELETE" });
  ctx.out(`Forgot ${cmd.grantId}. Its refresh token is gone from this machine.`);
  ctx.out("The provider still has the grant; revoke it there if that is what you meant.");
  return 0;
}
