/**
 * Routines: what is scheduled, and running one now.
 *
 * `run` is a manual fire, not a reschedule. The routine's own timer is
 * untouched, which is what makes it safe to use for a smoke test of something
 * that normally runs nightly.
 */

import {
  type ActionRun,
  ROUTINE_DELETE_REFUSAL_REASONS,
  type Routine,
  type RoutineDeleteResult,
  type Run,
  type TriggerSpec,
} from "@ompd/core";
import { type Command, UsageError } from "../args.ts";
import { ApiError, api, type CliContext } from "../client.ts";
import { age, duration, table } from "../format.ts";

interface RoutinesResponse {
  routines?: Routine[];
}

interface RoutineDetailResponse {
  routine?: Routine;
  runs?: Run[];
}

interface RunResponse {
  run?: Run;
}

interface WebhookSecretResponse {
  secret?: unknown;
}

export interface RunsArgs {
  targetId?: string;
  limit?: number;
  detail: boolean;
}

function describeTrigger(trigger: TriggerSpec): string {
  switch (trigger.kind) {
    case "cron":
      return `cron ${trigger.expression}${trigger.timezone === undefined ? "" : ` ${trigger.timezone}`}`;
    case "interval":
      return `every ${trigger.seconds}s`;
    case "webhook":
      return "webhook";
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

export function isInterruptedRun(run: Run): boolean {
  if (run.error?.includes("daemon shut down")) return true;
  return run.actions.some(action => action.error?.includes("daemon shut down"));
}

export function formatRunState(run: Run): string {
  if (isInterruptedRun(run)) return "interrupted";
  return run.state;
}

export function formatActionState(action: ActionRun): string {
  if (action.error?.includes("daemon shut down")) return "interrupted";
  return action.state;
}

function formatDuration(run: Run): string {
  if (run.finishedAt !== undefined && run.startedAt !== undefined) {
    const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    if (!Number.isNaN(ms) && ms >= 0) return duration(ms);
  }
  if (run.state === "running") return "running";
  return "-";
}

function formatActionDuration(action: ActionRun): string {
  if (action.finishedAt !== undefined && action.startedAt !== undefined) {
    const ms = Date.parse(action.finishedAt) - Date.parse(action.startedAt);
    if (!Number.isNaN(ms) && ms >= 0) return duration(ms);
  }
  if (action.state === "running") return "running";
  return "-";
}

function summarizeActions(actions: ActionRun[]): string {
  if (actions.length === 0) return "-";
  const counts: Record<string, number> = {};
  for (const action of actions) {
    const state = formatActionState(action);
    counts[state] = (counts[state] ?? 0) + 1;
  }
  const parts: string[] = [];
  const order = ["failed", "interrupted", "refused", "timed_out", "skipped", "running", "succeeded", "queued"];
  for (const state of order) {
    const count = counts[state];
    if (count !== undefined && count > 0) {
      parts.push(`${count} ${state}`);
    }
  }
  return parts.join(", ");
}

export function parseRunsArgs(argv: string[]): RunsArgs {
  const positionals: string[] = [];
  let limit: number | undefined;
  let detail = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;
    if (token === "--") {
      throw new UsageError("`--` on its own is not a flag");
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    if (body === "detail") {
      detail = true;
      continue;
    }
    if (body === "limit") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError("--limit needs a value");
      }
      const parsed = Number.parseInt(next, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new UsageError(`--limit must be positive, got ${next}`);
      }
      limit = parsed;
      i += 1;
      continue;
    }
    if (body.startsWith("limit=")) {
      const raw = body.slice("limit=".length);
      const parsed = Number.parseInt(raw, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        throw new UsageError(`--limit must be positive, got ${raw}`);
      }
      limit = parsed;
      continue;
    }
    throw new UsageError(`unknown flag --${body}`);
  }

  if (detail && positionals[0] === undefined) {
    throw new UsageError("--detail requires a run id");
  }

  if (positionals.length > 1) {
    throw new UsageError("runs takes at most 1 argument");
  }

  return { targetId: positionals[0], limit, detail };
}

function printRunDetail(ctx: CliContext, run: Run, routine?: Routine): number {
  ctx.out(`${run.id}  ${formatRunState(run)}`);
  if (routine !== undefined) {
    ctx.out(`  routine   ${routine.name} (${routine.id})`);
  }
  ctx.out(`  started   ${run.startedAt} (${age(run.startedAt)})`);
  const runDuration = formatDuration(run);
  ctx.out(`  finished  ${run.finishedAt ? `${run.finishedAt} (${runDuration})` : runDuration}`);
  if (run.error !== undefined) {
    ctx.out(`  error     ${run.error}`);
  }
  for (const action of run.actions) {
    ctx.out(`  ${String(action.index + 1)}. ${action.actionName}  ${formatActionState(action)}`);
    ctx.out(`     started   ${action.startedAt} (${age(action.startedAt)})`);
    const actionDuration = formatActionDuration(action);
    ctx.out(`     finished  ${actionDuration === "-" ? "-" : `${action.finishedAt ?? "-"} (${actionDuration})`}`);
    if (action.sessionId !== undefined) {
      ctx.out(`     session   ${action.sessionId}`);
    }
    if (action.agentId !== undefined) {
      ctx.out(`     agent     ${action.agentId}`);
    }
    if (action.summary !== undefined) {
      ctx.out(`     summary   ${action.summary}`);
    }
    if (action.error !== undefined) {
      ctx.out(`     error     ${action.error}`);
    }
    if (action.refusal !== undefined) {
      ctx.out(`     refused   ${action.refusal.code}: ${action.refusal.reason}`);
    }
  }

  return run.state === "failed" || run.state === "timed_out" || isInterruptedRun(run) ? 1 : 0;
}

export async function runsCommand(ctx: CliContext, argv: string[]): Promise<number> {
  const args = parseRunsArgs(argv);

  if (args.detail && args.targetId !== undefined) {
    const routinesResp = await api<RoutinesResponse>(ctx, "/v1/routines");
    const routines = routinesResp.routines ?? [];
    let foundRun: Run | undefined;
    let foundRoutine: Routine | undefined;

    await Promise.all(
      routines.map(async r => {
        try {
          const resp = await api<RoutineDetailResponse>(ctx, `/v1/routines/${encodeURIComponent(r.id)}?runLimit=50`);
          const match = resp.runs?.find(candidate => candidate.id === args.targetId);
          if (match !== undefined) {
            foundRun = match;
            foundRoutine = r;
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) return;
          throw err;
        }
      }),
    );

    if (foundRun === undefined) {
      ctx.err(`no run found for ${args.targetId}`);
      return 1;
    }
    return printRunDetail(ctx, foundRun, foundRoutine);
  }

  if (args.targetId !== undefined) {
    if (args.targetId.startsWith("run_")) {
      const routinesResp = await api<RoutinesResponse>(ctx, "/v1/routines");
      const routines = routinesResp.routines ?? [];
      let foundRun: Run | undefined;
      let foundRoutine: Routine | undefined;

      await Promise.all(
        routines.map(async r => {
          try {
            const resp = await api<RoutineDetailResponse>(ctx, `/v1/routines/${encodeURIComponent(r.id)}?runLimit=50`);
            const match = resp.runs?.find(candidate => candidate.id === args.targetId);
            if (match !== undefined) {
              foundRun = match;
              foundRoutine = r;
            }
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) return;
            throw err;
          }
        }),
      );

      if (foundRun === undefined) {
        ctx.err(`no run found for ${args.targetId}`);
        return 1;
      }
      return printRunDetail(ctx, foundRun, foundRoutine);
    }

    try {
      const resp = await api<RoutineDetailResponse>(
        ctx,
        `/v1/routines/${encodeURIComponent(args.targetId)}?runLimit=${args.limit ?? 50}`,
      );
      if (resp.routine !== undefined) {
        const runs = resp.runs ?? [];
        if (runs.length === 0) {
          ctx.out("no runs");
          return 0;
        }
        const rows = runs.map(run => [
          run.id,
          resp.routine?.name ?? args.targetId ?? "",
          formatRunState(run),
          summarizeActions(run.actions),
          age(run.startedAt),
          formatDuration(run),
        ]);
        for (const line of table(["RUN ID", "ROUTINE", "STATE", "ACTIONS", "WHEN", "DURATION"], rows)) {
          ctx.out(line);
        }
        return 0;
      }
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        throw err;
      }
    }

    const routinesResp = await api<RoutinesResponse>(ctx, "/v1/routines");
    const routines = routinesResp.routines ?? [];
    let foundRun: Run | undefined;
    let foundRoutine: Routine | undefined;

    await Promise.all(
      routines.map(async r => {
        try {
          const resp = await api<RoutineDetailResponse>(ctx, `/v1/routines/${encodeURIComponent(r.id)}?runLimit=50`);
          const match = resp.runs?.find(candidate => candidate.id === args.targetId);
          if (match !== undefined) {
            foundRun = match;
            foundRoutine = r;
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) return;
          throw err;
        }
      }),
    );

    if (foundRun !== undefined) {
      return printRunDetail(ctx, foundRun, foundRoutine);
    }

    ctx.err(`no routine or run found for ${args.targetId}`);
    return 1;
  }

  const routinesResp = await api<RoutinesResponse>(ctx, "/v1/routines");
  const routines = routinesResp.routines ?? [];
  if (routines.length === 0) {
    ctx.out("no routines");
    return 0;
  }

  const runLimit = args.limit ?? 50;
  const routineResults = await Promise.all(
    routines.map(async r => {
      try {
        const resp = await api<RoutineDetailResponse>(
          ctx,
          `/v1/routines/${encodeURIComponent(r.id)}?runLimit=${runLimit}`,
        );
        return { routine: r, runs: resp.runs ?? [] };
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return { routine: r, runs: [] };
        }
        throw err;
      }
    }),
  );

  interface EnrichedRun {
    run: Run;
    routine: Routine;
  }
  const allRuns: EnrichedRun[] = [];
  for (const { routine, runs } of routineResults) {
    for (const run of runs) {
      allRuns.push({ run, routine });
    }
  }

  if (allRuns.length === 0) {
    ctx.out("no runs");
    return 0;
  }

  allRuns.sort((a, b) => {
    const timeDiff = Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt);
    if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff;
    return b.run.id.localeCompare(a.run.id);
  });

  const runsToDisplay = allRuns.slice(0, runLimit);
  const rows = runsToDisplay.map(({ run, routine }) => [
    run.id,
    routine.name,
    formatRunState(run),
    summarizeActions(run.actions),
    age(run.startedAt),
    formatDuration(run),
  ]);
  for (const line of table(["RUN ID", "ROUTINE", "STATE", "ACTIONS", "WHEN", "DURATION"], rows)) {
    ctx.out(line);
  }
  return 0;
}
