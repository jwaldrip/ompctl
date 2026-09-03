/**
 * The seven routine tools an OMP session gets, and nothing else.
 *
 * Everything here goes through `api`, the same HTTP client the CLI commands
 * use. That is the whole design: the MCP path resolves the daemon's address
 * the same way, reads the same 0600 token at the point of use, hits the same
 * scope checks, and reports the same failures. A second client here would be a
 * second auth story to keep true, and the one that drifted would be the one an
 * agent was holding.
 *
 * Two disciplines this module keeps that are easy to lose:
 *
 * A tool result is model-visible text. So a webhook `secretRef` is stripped on
 * the way out of every read, and the one tool that returns an actual secret
 * says so in its own text. Nothing here logs a response body, anywhere: a log
 * line is how the rotate response ends up somewhere nobody meant to keep it.
 *
 * A session id is not in that category and is returned as it stands. It names
 * a session and grants nothing: opening one still goes through the daemon's
 * own auth, so withholding the id would cost a caller the ability to look at
 * what a run did while protecting nothing.
 *
 * The schema descriptions are the only specification a model ever reads. There
 * is no man page and no README in that loop, so a field whose description says
 * nothing is a field that gets guessed at.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type ActionRun,
  type ActionRunState,
  ROUTINE_DELETE_REFUSAL_REASONS,
  type Routine,
  type RoutineAction,
  type RoutineDeleteResult,
  type RoutineDraft,
  type RoutinePatch,
  type Run,
  type RunState,
  type TriggerSpec,
} from "@ompd/core";
import { z } from "zod";
import { api, type CliContext } from "../client.ts";
import { type ToolErrorResult, toolError } from "./errors.ts";

/**
 * Every tool this module registers, in registration order.
 *
 * Exported so the thing that advertises the surface and the thing that builds
 * it cannot disagree, and so a test can fail when a tool is added: a new tool
 * reaching every OMP session is a decision, not an implementation detail.
 */
export const ROUTINE_TOOL_NAMES = [
  "ompctl_routines_list",
  "ompctl_routine_get",
  "ompctl_routine_create",
  "ompctl_routine_update",
  "ompctl_routine_delete",
  "ompctl_routine_run",
  "ompctl_routine_rotate_webhook_secret",
] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// What the daemon answers with
// ---------------------------------------------------------------------------

interface RoutinesResponse {
  routines?: Routine[];
}

interface RoutineResponse {
  routine?: Routine;
}

interface RoutineDetailResponse {
  routine?: Routine;
  runs?: Run[];
}

interface RunResponse {
  run?: Run;
}

interface DeleteResponse {
  results?: RoutineDeleteResult[];
}

interface WebhookSecretResponse {
  secret?: unknown;
}

// ---------------------------------------------------------------------------
// Enumerations, exhaustive by construction
// ---------------------------------------------------------------------------

/**
 * The state tables, keyed by the contract's own unions so a state added or
 * removed in `@ompd/core` fails to compile here rather than failing output
 * validation at the client, which is a runtime error in someone else's
 * process.
 */
const TRIGGER_KINDS: Record<TriggerSpec["kind"], TriggerSpec["kind"]> = {
  cron: "cron",
  interval: "interval",
  manual: "manual",
  webhook: "webhook",
};

const RUN_STATES: Record<RunState, RunState> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  skipped: "skipped",
  timed_out: "timed_out",
};

const ACTION_RUN_STATES: Record<ActionRunState, ActionRunState> = {
  queued: "queued",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  refused: "refused",
  timed_out: "timed_out",
  skipped: "skipped",
};

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const labelsSchema = z
  .record(z.string(), z.string())
  .describe('Free-form tags, for example {"owner":"jason","area":"maintenance"}.');

/**
 * A string with something in it, which `z.string().min(1)` does not mean.
 *
 * `min(1)` accepts `"   "`, and the daemon trims a name before storing it and
 * then refuses the empty result. That divergence is the whole failure mode this
 * pair of surfaces exists to avoid: a model sends a name of spaces, this schema
 * says yes, and the refusal arrives from the daemon naming a field the caller
 * believes it filled in. Refusing here says so at the layer that knows the
 * caller.
 */
const filledSchema = z.string().refine(value => value.trim().length > 0, "must not be blank");

const cwdSchema = z
  .string()
  .regex(/^\//, "cwd must be an absolute path")
  .describe("Absolute working directory the agent starts in, for example /Users/you/dev/src/github.com/you/repo.");

/**
 * Strict, and that is load-bearing rather than fussy. Zod strips an unknown
 * key by default, so a caller that sent `host: {kind:"container"}` here would
 * be told its action was created and get a local one: it asked for something,
 * was answered yes, and got something else. Refusing says which field the
 * daemon does not accept.
 */
const actionDraftSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Existing action id. Omit when adding an action: the daemon mints one. Supply it on an update to keep " +
        "past run outcomes attached to this action across a rename.",
    ),
  name: filledSchema.describe('Short label for this step, for example "sweep stale branches".'),
  prompt: filledSchema.describe(
    "The prompt a fresh agent receives when this action runs. It gets no other context, so state the task in full.",
  ),
  cwd: cwdSchema,
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Kill this action after this many seconds. Omit to let it run to completion."),
  labels: labelsSchema.optional(),
});

/**
 * The four triggers, as a discriminated union so a model cannot send a cron
 * expression on an interval trigger and have it silently ignored.
 *
 * A webhook trigger names no secret. The daemon mints one credential per
 * routine, which is what stops two routines sharing a secret where rotating
 * either would silently break the other.
 */
const triggerDraftSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("cron"),
      expression: filledSchema.describe('Five-field cron expression, for example "0 2 * * *" for 02:00 daily.'),
      timezone: filledSchema
        .optional()
        .describe('IANA timezone the expression is read in, for example "America/Denver". Omit for the daemon\'s own.'),
    }),
    z.strictObject({
      kind: z.literal("interval"),
      seconds: z.number().int().positive().describe("Seconds between runs, for example 3600 for hourly."),
    }),
    z.strictObject({ kind: z.literal("manual") }),
    // Strict for the same reason, and it matters most here: a caller sending
    // its own `secretRef` would have it stripped, then sign its calls with a
    // secret the daemon never stored, and the endpoint would refuse every one
    // of them with nothing pointing at why.
    z.strictObject({ kind: z.literal("webhook") }),
  ])
  .describe(
    "When this routine fires. `manual` never fires on its own and is the right choice for something you will " +
      "start by hand. `webhook` fires on an authenticated POST; the daemon mints the secret, so do not send one.",
  );

const listShape = {
  enabled: z.boolean().optional().describe("Keep only enabled routines, or only disabled ones. Omit for both."),
  triggerKind: z.enum(TRIGGER_KINDS).optional().describe("Keep only routines with this trigger kind."),
  nameContains: z
    .string()
    .min(1)
    .optional()
    .describe("Keep only routines whose name contains this text, matched without regard to case."),
};

const getShape = {
  routineId: z.string().min(1).describe("The routine's id, as `ompctl_routines_list` reports it."),
  runLimit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("How many of the most recent runs to include, newest first."),
};

const createShape = {
  name: filledSchema.describe('What this routine is called, for example "nightly dependency sweep".'),
  enabled: z
    .boolean()
    .optional()
    .describe("Whether it fires on its trigger. Defaults to true; pass false to define it switched off."),
  trigger: triggerDraftSchema,
  actions: z
    .array(actionDraftSchema)
    .min(1)
    .describe("The steps, run in this order. Each one records its own outcome. At least one is required."),
  singleton: z
    .boolean()
    .optional()
    .describe("Skip a firing while a previous run of this routine is still going. Defaults to true."),
  labels: labelsSchema.optional(),
};

const updateShape = {
  routineId: z.string().min(1).describe("The routine to edit."),
  name: filledSchema.optional().describe("Replaces the name."),
  enabled: z.boolean().optional().describe("Turns the routine on or off without touching anything else."),
  trigger: triggerDraftSchema.optional().describe("Replaces the trigger entirely, including its kind."),
  actions: z
    .array(actionDraftSchema)
    .min(1)
    .optional()
    .describe(
      "Replaces the whole action list, in this order. There is no per-action patch: an insert would retarget " +
        "every later action. Send the full list, carrying each action's existing `id` where you mean the same " +
        "step. An action sent without an id is a new action: the daemon mints one on every write, so a patch " +
        "that omits ids cannot be retried without replacing the ids that past run outcomes name.",
    ),
  singleton: z.boolean().optional().describe("Replaces the singleton setting."),
  labels: labelsSchema
    .optional()
    .describe("Replaces every label. An empty object clears them all; omitting the field leaves them alone."),
};

const deleteShape = {
  routineIds: z
    .array(z.string().min(1))
    .min(1)
    .describe("The routines to delete. Each id is answered separately, so one refusal does not hide the rest."),
};

const routineIdShape = {
  routineId: z.string().min(1).describe("The routine's id, as `ompctl_routines_list` reports it."),
};

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const triggerViewSchema = z.object({
  kind: z.enum(TRIGGER_KINDS),
  expression: z.string().optional().describe("Cron triggers only."),
  timezone: z.string().optional().describe("Cron triggers only, when one was set."),
  seconds: z.number().optional().describe("Interval triggers only."),
  hasWebhookSecretRef: z
    .boolean()
    .describe("Whether a webhook credential exists. The reference itself is never returned."),
});

const actionViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  cwd: z.string(),
  timeoutSeconds: z.number().optional(),
  labels: z.record(z.string(), z.string()),
});

const routineSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: triggerViewSchema,
  actionCount: z.number().int(),
  singleton: z.boolean(),
  labels: z.record(z.string(), z.string()),
  createdAt: z.string(),
});

const routineViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  trigger: triggerViewSchema,
  actions: z.array(actionViewSchema),
  singleton: z.boolean(),
  labels: z.record(z.string(), z.string()),
  createdAt: z.string(),
});

const runViewSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  state: z.enum(RUN_STATES),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
  error: z.string().optional().describe("Event-level cause, used for singleton skips and daemon interruption."),
  linkedSessionCount: z
    .number()
    .int()
    .describe(
      "How many distinct sessions this run created, counted over the `sessionId`s below. Zero means none of " +
        "these actions recorded one, which is what every run predating session links looks like.",
    ),
  actions: z.array(
    z.object({
      actionId: z.string(),
      actionName: z.string(),
      index: z.number().int(),
      state: z.enum(ACTION_RUN_STATES),
      agentId: z.string().optional(),
      sessionId: z
        .string()
        .optional()
        .describe(
          "The session this action's agent ran in, as an ordinary session open takes it. A handle, not a " +
            "secret: it names a session and grants nothing. Absent on a run recorded before the daemon " +
            "linked sessions, and on an action that never reached an agent.",
        ),
      summary: z.string().optional(),
      error: z.string().optional(),
      refusal: z.object({ code: z.string(), reason: z.string() }).optional(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * `type` and not `interface` throughout: the SDK's tool result carries an
 * index signature, and only an anonymous object type gets the implicit index
 * signature that makes it assignable to one.
 *
 * Optional fields are assigned straight from the source even when undefined.
 * JSON drops an undefined value on the way out, and the validator on both
 * ends treats a key holding undefined as absent, so there is no difference to
 * a client between that and building the object conditionally.
 */
type TriggerView = z.infer<typeof triggerViewSchema>;
type ActionView = z.infer<typeof actionViewSchema>;
type RoutineSummary = z.infer<typeof routineSummarySchema>;
type RoutineView = z.infer<typeof routineViewSchema>;
type RunView = z.infer<typeof runViewSchema>;

type ToolSuccess = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

/**
 * The trigger, with the webhook credential reference removed.
 *
 * This is the one projection that matters for disclosure. A tool result is
 * text a model reads, quotes, and may carry into a summary, and a credential
 * reference has no business in that stream. The boolean is what a caller
 * actually needs: whether there is a secret to rotate.
 */
function triggerView(trigger: TriggerSpec): TriggerView {
  switch (trigger.kind) {
    case "cron":
      return {
        kind: "cron",
        expression: trigger.expression,
        timezone: trigger.timezone,
        hasWebhookSecretRef: false,
      };
    case "interval":
      return { kind: "interval", seconds: trigger.seconds, hasWebhookSecretRef: false };
    case "webhook":
      return { kind: "webhook", hasWebhookSecretRef: trigger.secretRef.length > 0 };
    default:
      return { kind: "manual", hasWebhookSecretRef: false };
  }
}

/** The action, without its execution host: that is the daemon's, forced local. */
function actionView(action: RoutineAction): ActionView {
  return {
    id: action.id,
    name: action.name,
    prompt: action.prompt,
    cwd: action.cwd,
    timeoutSeconds: action.timeoutSeconds,
    labels: action.labels,
  };
}

function routineSummary(routine: Routine): RoutineSummary {
  return {
    id: routine.id,
    name: routine.name,
    enabled: routine.enabled,
    trigger: triggerView(routine.trigger),
    // A routine is a fan-out, so there is no single cwd to list. What a list
    // needs is how many outcomes one firing produces.
    actionCount: routine.actions.length,
    singleton: routine.singleton,
    labels: routine.labels,
    createdAt: routine.createdAt,
  };
}

function routineView(routine: Routine): RoutineView {
  return {
    id: routine.id,
    name: routine.name,
    enabled: routine.enabled,
    trigger: triggerView(routine.trigger),
    actions: routine.actions.map(actionView),
    singleton: routine.singleton,
    labels: routine.labels,
    createdAt: routine.createdAt,
  };
}

function actionRunView(run: ActionRun): RunView["actions"][number] {
  return {
    actionId: run.actionId,
    actionName: run.actionName,
    index: run.index,
    state: run.state,
    agentId: run.agentId,
    sessionId: run.sessionId,
    summary: run.summary,
    error: run.error,
    refusal: run.refusal === undefined ? undefined : { code: run.refusal.code, reason: run.refusal.reason },
  };
}

/**
 * How many sessions one run created.
 *
 * Distinct and non-blank, not `actions.length`: a run whose actions never
 * reached an agent has no session to open, and counting the actions instead
 * would tell a model there is something to look at when there is not. Blank is
 * treated as absent for the same reason a missing key is, because an empty
 * string is a value no session open can take.
 */
function linkedSessionCount(run: Run): number {
  const linked = new Set<string>();
  for (const action of run.actions) {
    if (action.sessionId !== undefined && action.sessionId.length > 0) linked.add(action.sessionId);
  }
  return linked.size;
}

function runView(run: Run): RunView {
  return {
    id: run.id,
    routineId: run.routineId,
    state: run.state,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    linkedSessionCount: linkedSessionCount(run),
    actions: run.actions.map(actionRunView),
  };
}

// ---------------------------------------------------------------------------
// Human-readable summaries
// ---------------------------------------------------------------------------

function triggerLabel(trigger: TriggerView): string {
  switch (trigger.kind) {
    case "cron":
      return `cron ${trigger.expression ?? "?"}${trigger.timezone === undefined ? "" : ` ${trigger.timezone}`}`;
    case "interval":
      return `every ${String(trigger.seconds ?? 0)}s`;
    case "webhook":
      return "webhook";
    default:
      return "manual";
  }
}

function routineLine(routine: RoutineSummary): string {
  const actions = routine.actionCount === 1 ? "1 action" : `${String(routine.actionCount)} actions`;
  return `  ${routine.id}  ${routine.enabled ? "enabled " : "disabled"}  ${routine.name}  ${triggerLabel(routine.trigger)}  ${actions}`;
}

/**
 * One run, as a line.
 *
 * The session count is here and not only in the structured output because the
 * text is what a model reads. A count that appeared solely in
 * `structuredContent` would be a field a caller has to already know to look
 * for, and the whole point of reporting it is that someone asking "why did
 * last night's routine fail" learns there is a session to open.
 */
function runLine(run: RunView): string {
  const failed = run.actions.filter(action => action.state === "failed" || action.state === "timed_out").length;
  const detail = failed === 0 ? "" : `  ${String(failed)} failed`;
  const sessions = run.linkedSessionCount === 1 ? "  1 session" : `  ${String(run.linkedSessionCount)} sessions`;
  return `  ${run.id}  ${run.state}  started ${run.startedAt}${detail}${sessions}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Run a handler with its failures already mapped.
 *
 * Every handler is wrapped, because an exception escaping into the transport
 * is not an error a client can read: it becomes a protocol-level failure with
 * the cause flattened out of it. `action` is the imperative of what was being
 * attempted, so the message names its own subject.
 */
async function guard(action: string, run: () => Promise<ToolSuccess>): Promise<ToolSuccess | ToolErrorResult> {
  try {
    return await run();
  } catch (err) {
    return toolError(action, err);
  }
}

export function registerRoutineTools(server: McpServer, ctx: CliContext): void {
  server.registerTool(
    "ompctl_routines_list",
    {
      title: "List routines",
      description:
        "Every routine this daemon holds, with its trigger, whether it is on, and how many actions it runs. " +
        "Start here: the ids the other routine tools take come from this list. Filters are applied here, not " +
        "by the daemon, so a filtered call costs the same as an unfiltered one.",
      inputSchema: listShape,
      outputSchema: { count: z.number().int(), routines: z.array(routineSummarySchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    args =>
      guard("list routines", async () => {
        const response = await api<RoutinesResponse>(ctx, "/v1/routines");
        // The daemon has no filter parameters on this route. These predicates
        // run in this process, over the full list it just returned: nothing
        // here is enforced by the daemon, and nothing here hides a routine
        // from anyone who calls the route directly.
        const needle = args.nameContains?.toLowerCase();
        const routines = (response.routines ?? [])
          .filter(routine => args.enabled === undefined || routine.enabled === args.enabled)
          .filter(routine => args.triggerKind === undefined || routine.trigger.kind === args.triggerKind)
          .filter(routine => needle === undefined || routine.name.toLowerCase().includes(needle))
          .map(routineSummary);

        const heading =
          routines.length === 0
            ? "no routines matched"
            : `${String(routines.length)} routine${routines.length === 1 ? "" : "s"}`;
        return {
          content: [{ type: "text", text: [heading, ...routines.map(routineLine)].join("\n") }],
          structuredContent: { count: routines.length, routines },
        };
      }),
  );

  server.registerTool(
    "ompctl_routine_get",
    {
      title: "Inspect a routine",
      description:
        "One routine in full, with every action's prompt and working directory, plus its most recent runs and " +
        "how each action inside them ended. This is what to read before editing a routine or when asked why a " +
        "run did not do what someone expected. Each run reports how many sessions it created, and each action " +
        "inside it reports the `sessionId` of the one it ran in, which opens like any other session. A webhook " +
        "routine's credential reference is never included.",
      inputSchema: getShape,
      outputSchema: { routine: routineViewSchema, runs: z.array(runViewSchema) },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    args =>
      guard("inspect a routine", async () => {
        const path = `/v1/routines/${encodeURIComponent(args.routineId)}?runLimit=${String(args.runLimit)}`;
        const response = await api<RoutineDetailResponse>(ctx, path);
        if (response.routine === undefined) throw new Error("the daemon answered with no routine");

        const routine = routineView(response.routine);
        const runs = (response.runs ?? []).map(runView);
        const lines = [
          `${routine.name}  ${routine.id}`,
          `  ${routine.enabled ? "enabled" : "disabled"}, ${triggerLabel(routine.trigger)}, ${
            routine.singleton ? "singleton" : "concurrent"
          }, created ${routine.createdAt}`,
          "actions:",
          ...routine.actions.map(
            (action, index) =>
              `  ${String(index + 1)}. ${action.name}  ${action.cwd}${
                action.timeoutSeconds === undefined ? "" : `  timeout ${String(action.timeoutSeconds)}s`
              }`,
          ),
          runs.length === 0 ? "no runs recorded" : "runs, newest first:",
          ...runs.map(runLine),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { routine, runs },
        };
      }),
  );

  server.registerTool(
    "ompctl_routine_create",
    {
      title: "Define a routine",
      description:
        "Define a new scheduled routine: a trigger, and the ordered prompts it runs. Each action starts a fresh " +
        "agent that sees only its own prompt and working directory. The daemon mints the routine's id, each " +
        "action's id, and a webhook secret if the trigger needs one, so none of those are yours to send. " +
        "Actions always run on this machine.",
      inputSchema: createShape,
      outputSchema: { routine: routineViewSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    args =>
      guard("create a routine", async () => {
        // Typed as the shared contract rather than passed straight through, so
        // a schema that drifts from `RoutineDraft` stops compiling instead of
        // sending a body the daemon will reject at runtime.
        const draft: RoutineDraft = args;
        const response = await api<RoutineResponse>(ctx, "/v1/routines", { method: "POST", body: draft });
        if (response.routine === undefined) throw new Error("the daemon created no routine");

        const routine = routineView(response.routine);
        const text = [
          `created ${routine.name}  ${routine.id}`,
          `  ${routine.enabled ? "enabled" : "disabled"}, ${triggerLabel(routine.trigger)}, ${String(
            routine.actions.length,
          )} action${routine.actions.length === 1 ? "" : "s"}`,
          routine.trigger.kind === "webhook"
            ? "  a webhook secret was minted; read it once with ompctl_routine_rotate_webhook_secret"
            : "",
        ]
          .filter(line => line.length > 0)
          .join("\n");
        return { content: [{ type: "text", text }], structuredContent: { routine } };
      }),
  );

  server.registerTool(
    "ompctl_routine_update",
    {
      title: "Edit a routine",
      description:
        "Change parts of an existing routine. Only the fields you send are touched: leave a field out and it " +
        "keeps its current value, which is how you flip `enabled` without restating the actions. `actions` and " +
        "`labels` replace what is there rather than merging, so send the whole list; an empty `labels` object " +
        "clears every label. Repeating this call is only safe when every action carries its existing `id`: " +
        "without one the daemon mints a fresh action id on each write, so read the routine first if you have " +
        "to retry.",
      inputSchema: updateShape,
      outputSchema: { routine: routineViewSchema },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // A patch whose actions omit ids is not repeatable. The daemon mints a
        // fresh action id on every write, so the second identical call leaves a
        // routine equal field by field but not the same routine, and past run
        // outcomes stop naming the action that produced them. A caller that
        // carries each action's existing `id`, which `ompctl_routine_get`
        // reports, gets a write it can repeat.
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    args =>
      guard("update a routine", async () => {
        // Built key by key, from only what the caller sent. Absent has to stay
        // absent on the wire: the daemon reads a present key as "replace this"
        // and an absent one as "leave it alone", so spreading defaults in here
        // would quietly overwrite fields nobody mentioned, and would make
        // `labels: {}` indistinguishable from not passing labels at all.
        const patch: RoutinePatch = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.enabled !== undefined) patch.enabled = args.enabled;
        if (args.trigger !== undefined) patch.trigger = args.trigger;
        if (args.actions !== undefined) patch.actions = args.actions;
        if (args.singleton !== undefined) patch.singleton = args.singleton;
        if (args.labels !== undefined) patch.labels = args.labels;

        const changed = Object.keys(patch);
        if (changed.length === 0) throw new Error("no fields were supplied, so there is nothing to change");

        const response = await api<RoutineResponse>(ctx, `/v1/routines/${encodeURIComponent(args.routineId)}`, {
          method: "PATCH",
          body: patch,
        });
        if (response.routine === undefined) throw new Error("the daemon returned no routine");

        const routine = routineView(response.routine);
        const text = [
          `updated ${routine.name}  ${routine.id}`,
          `  replaced ${changed.join(", ")}`,
          `  now ${routine.enabled ? "enabled" : "disabled"}, ${triggerLabel(routine.trigger)}, ${String(
            routine.actions.length,
          )} action${routine.actions.length === 1 ? "" : "s"}`,
        ].join("\n");
        return { content: [{ type: "text", text }], structuredContent: { routine } };
      }),
  );

  server.registerTool(
    "ompctl_routine_delete",
    {
      title: "Delete routines",
      description:
        "Delete routines for good. This also destroys their run history and, for a webhook routine, the " +
        "credential its callers hold: anything posting to that endpoint stops working and the secret cannot be " +
        "recovered. A routine with a run in flight is refused rather than interrupted. Each id is answered " +
        "separately, so read every result.",
      inputSchema: deleteShape,
      outputSchema: {
        results: z.array(
          z.object({
            routineId: z.string(),
            deleted: z.boolean(),
            refusal: z.string().optional().describe("Why this id was refused, when it was."),
          }),
        ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    args =>
      guard("delete routines", async () => {
        const response = await api<DeleteResponse>(ctx, "/v1/routines/delete", {
          method: "POST",
          body: { routineIds: args.routineIds },
        });
        const outcomes = response.results ?? [];
        if (outcomes.length === 0) throw new Error("the daemon answered a delete with no results");

        const results = outcomes.map(result =>
          result.deleted
            ? { routineId: result.routineId, deleted: true }
            : { routineId: result.routineId, deleted: false, refusal: result.refusal },
        );
        // The daemon's own wording for a refusal, because it is the copy every
        // other surface shows for the same cause.
        const lines = outcomes.map(result =>
          result.deleted
            ? `  ${result.routineId} deleted, with its runs and its webhook secret`
            : `  ${result.routineId} refused (${result.refusal}): ${ROUTINE_DELETE_REFUSAL_REASONS[result.refusal]}`,
        );
        const gone = outcomes.filter(result => result.deleted).length;
        const heading = `${String(gone)} deleted, ${String(outcomes.length - gone)} refused`;
        return {
          content: [{ type: "text", text: [heading, ...lines].join("\n") }],
          structuredContent: { results },
        };
      }),
  );

  server.registerTool(
    "ompctl_routine_run",
    {
      title: "Run a routine now",
      description:
        "Fire a routine immediately, whatever its trigger says. Its own schedule is untouched: a nightly " +
        "routine started this way still runs tonight. Each action starts a fresh agent with the routine's own " +
        "prompt and working directory, so this does whatever those prompts do on this machine: read the " +
        "routine with `ompctl_routine_get` before firing one you did not write. The reply carries each " +
        "action's outcome, so a run where one action failed and the rest succeeded reads as exactly that.",
      inputSchema: routineIdShape,
      outputSchema: { run: runViewSchema },
      annotations: {
        readOnlyHint: false,
        // This starts arbitrary prompts on this machine, so what it may destroy
        // is whatever those prompts reach: files, branches, external services.
        // An annotation that cannot bound the effect must not claim the effect
        // is additive, so the honest value is the one that makes a client ask.
        destructiveHint: true,
        idempotentHint: false,
        // False despite that: the tool itself talks to one known local daemon.
        // What the prompts inside the run reach is not this tool's world.
        openWorldHint: false,
      },
    },
    args =>
      guard("run a routine", async () => {
        const path = `/v1/routines/${encodeURIComponent(args.routineId)}/run`;
        const response = await api<RunResponse>(ctx, path, { method: "POST" });
        if (response.run === undefined) throw new Error("the daemon started no run");

        const run = runView(response.run);
        const lines = [
          `run ${run.id}  ${run.state}`,
          ...run.actions.map(
            action =>
              `  ${String(action.index + 1)}. ${action.actionName}  ${action.state}${
                action.error === undefined ? "" : `  ${action.error}`
              }${action.refusal === undefined ? "" : `  refused ${action.refusal.code}: ${action.refusal.reason}`}`,
          ),
          run.error === undefined ? "" : `  ${run.error}`,
        ].filter(line => line.length > 0);
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { run } };
      }),
  );

  server.registerTool(
    "ompctl_routine_rotate_webhook_secret",
    {
      title: "Rotate a webhook secret",
      description:
        "Mint a fresh secret for a webhook routine and return it once. The daemon keeps only a hash, so this " +
        "reply is the only copy that will ever exist. Rotating breaks every caller still holding the previous " +
        "secret, and the previous one cannot be restored, so do this when a secret has leaked or when a caller " +
        "is being replaced. Only webhook routines have one.",
      inputSchema: routineIdShape,
      outputSchema: {
        routineId: z.string(),
        secret: z.string().describe("The new secret, shown here and nowhere else, ever."),
        sensitive: z.literal(true).describe("Do not repeat this value into a log, a file, or a summary."),
      },
      annotations: {
        readOnlyHint: false,
        // The previous credential stops working the moment this returns and
        // cannot be recovered. That is destruction, whatever it mints.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    args =>
      guard("rotate a webhook secret", async () => {
        const path = `/v1/routines/${encodeURIComponent(args.routineId)}/webhook-secret`;
        const response = await api<WebhookSecretResponse>(ctx, path, { method: "POST" });
        if (typeof response.secret !== "string" || response.secret.length === 0) {
          throw new Error("the daemon minted no webhook secret");
        }

        const text = [
          `new webhook secret for ${args.routineId}:`,
          "",
          `  ${response.secret}`,
          "",
          "This is the only time this value is shown: the daemon keeps only its hash and cannot show it again.",
          "The previous secret stopped working just now, so every caller posting to this routine needs this one.",
        ].join("\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { routineId: args.routineId, secret: response.secret, sensitive: true },
        };
      }),
  );
}
