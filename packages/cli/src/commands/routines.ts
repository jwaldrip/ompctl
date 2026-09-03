/**
 * Routines: what is scheduled, and running one now.
 *
 * `run` is a manual fire, not a reschedule. The routine's own timer is
 * untouched, which is what makes it safe to use for a smoke test of something
 * that normally runs nightly.
 */

import {
  ROUTINE_DELETE_REFUSAL_REASONS,
  type Routine,
  type RoutineDeleteResult,
  type Run,
  type TriggerSpec,
} from "@ompd/core";
import type { Command } from "../args.ts";
import { api, type CliContext } from "../client.ts";
import { table } from "../format.ts";

interface RoutinesResponse {
  routines?: Routine[];
}

interface RunResponse {
  run?: Run;
}

interface WebhookSecretResponse {
  secret?: unknown;
}

function describeTrigger(trigger: TriggerSpec): string {
  switch (trigger.kind) {
    case "cron":
      return `cron ${trigger.expression}${trigger.timezone === undefined ? "" : ` ${trigger.timezone}`}`;
    case "interval":
      return `every ${trigger.seconds}s`;
    case "webhook":
      return `webhook ${trigger.secretRef}`;
    default:
      return "manual";
  }
}

export async function routinesCommand(ctx: CliContext): Promise<number> {
  const response = await api<RoutinesResponse>(ctx, "/v1/routines");
  const routines = response.routines ?? [];
  if (routines.length === 0) {
    ctx.out("no routines");
    return 0;
  }

  const rows = routines.map(routine => [
    routine.id,
    routine.enabled ? "enabled" : "disabled",
    routine.name,
    describeTrigger(routine.trigger),
    // A routine is a fan-out now, so there is no single cwd to print. The
    // count is what an operator needs from a list: how many outcomes one
    // event produces. `ompd run` prints each action's own result.
    String(routine.actions.length),
  ]);
  for (const line of table(["ID", "STATE", "NAME", "TRIGGER", "ACTIONS"], rows)) ctx.out(line);
  return 0;
}

export async function runCommand(ctx: CliContext, cmd: Extract<Command, { kind: "run" }>): Promise<number> {
  const response = await api<RunResponse>(ctx, `/v1/routines/${encodeURIComponent(cmd.routineId)}/run`, {
    method: "POST",
  });

  const run = response.run;
  if (run === undefined) {
    ctx.err("the daemon started no run");
    return 1;
  }

  ctx.out(`${run.id}  ${run.state}`);
  // Every action's outcome, in configured order. Printing only the event's
  // own state would hide the case this command exists for: one action failed
  // and the rest still ran.
  for (const action of run.actions) {
    ctx.out(`  ${String(action.index + 1)}. ${action.actionName}  ${action.state}`);
    if (action.agentId !== undefined) ctx.out(`     agent   ${action.agentId}`);
    if (action.summary !== undefined) ctx.out(`     summary ${action.summary}`);
    if (action.error !== undefined) ctx.out(`     error   ${action.error}`);
    if (action.refusal !== undefined) ctx.out(`     refused ${action.refusal.code}: ${action.refusal.reason}`);
  }
  if (run.error !== undefined) ctx.out(`  error   ${run.error}`);
  // A failed run is a failed command. Exiting 0 here would make this useless
  // in anything that checks a status code.
  return run.state === "failed" || run.state === "timed_out" ? 1 : 0;
}

/**
 * Rotate the per-routine credential and print the replacement exactly once.
 * The daemon retains only a hash, so this is the sole chance to copy it.
 */
export async function webhookSecretCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "webhook-secret" }>,
): Promise<number> {
  const response = await api<WebhookSecretResponse>(
    ctx,
    `/v1/routines/${encodeURIComponent(cmd.routineId)}/webhook-secret`,
    { method: "POST" },
  );
  if (typeof response.secret !== "string") {
    ctx.err("the daemon minted no webhook secret");
    return 1;
  }

  ctx.out(`webhook secret for ${cmd.routineId}`);
  ctx.out("");
  ctx.out(`  ${response.secret}`);
  ctx.out("");
  ctx.out("  This secret is shown once and is not recoverable. The daemon keeps only its");
  ctx.out("  hash. Copy it now; mint another one if you lose it.");
  return 0;
}

/**
 * Delete one routine for good, reporting the named refusal rather than a
 * bare failure. The daemon's wording is used verbatim because it is the one
 * copy the operator's other surfaces also show.
 */
export async function routineDeleteCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "routine-delete" }>,
): Promise<number> {
  const response = await api<{ results?: RoutineDeleteResult[] }>(ctx, "/v1/routines/delete", {
    method: "POST",
    body: { routineIds: [cmd.routineId] },
  });
  const result = response.results?.[0];
  if (result === undefined) {
    ctx.err("the daemon answered a delete with no result");
    return 1;
  }
  if (!result.deleted) {
    ctx.err(`${cmd.routineId} was not deleted: ${ROUTINE_DELETE_REFUSAL_REASONS[result.refusal]}`);
    return 1;
  }
  ctx.out(`${cmd.routineId} deleted, with its runs and its webhook secret`);
  return 0;
}
