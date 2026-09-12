/**
 * Routine CLI commands: listing routines, viewing run history, and run details.
 *
 * Every run state that matters to an operator must be distinguishable:
 * success, normal failure, singleton skip, refusal, timeout, and the
 * interruption caused when a daemon shuts down with a run in flight.
 * Webhook secret references must never appear in human-readable output.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Routine, Run } from "@ompd/core";
import { UsageError } from "../src/args.ts";
import type { CliContext } from "../src/client.ts";
import { formatActionState, formatRunState, isInterruptedRun, parseRunsArgs } from "../src/commands/routines.ts";
import { CLI_USAGE, run } from "../src/main.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

interface Harness {
  ctx: CliContext;
  stdout: () => string;
  stderr: () => string;
  calls: Array<{ url: string; method: string }>;
}

interface HarnessOptions {
  routes?: Record<string, { status?: number; body: unknown }>;
  token?: string | null;
  failFetch?: Error;
}

function createHarness(opts: HarnessOptions = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "ompd-routines-test-"));
  scratch.push(home);
  if (opts.token !== null) {
    writeFileSync(join(home, "token"), `${opts.token ?? "tok_test"}\n`);
  }

  const out: string[] = [];
  const err: string[] = [];
  const calls: Harness["calls"] = [];
  const routes = { ...opts.routes };

  const ctx: CliContext = {
    out: line => out.push(line),
    err: line => err.push(line),
    env: { OMPD_URL: "http://127.0.0.1:19999", HOME: home },
    cwd: home,
    home,
    fetch: async (url, init) => {
      if (opts.failFetch !== undefined) {
        throw opts.failFetch;
      }
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname + new URL(url).search;
      calls.push({ url: path, method });

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
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    calls,
  };
}

describe("parseRunsArgs", () => {
  test("accepts empty arguments for default listing", () => {
    expect(parseRunsArgs([])).toEqual({
      targetId: undefined,
      limit: undefined,
      detail: false,
    });
  });

  test("accepts a target routine or run id", () => {
    expect(parseRunsArgs(["rt_123"])).toEqual({
      targetId: "rt_123",
      limit: undefined,
      detail: false,
    });
    expect(parseRunsArgs(["run_456"])).toEqual({
      targetId: "run_456",
      limit: undefined,
      detail: false,
    });
  });

  test("accepts --limit with space or equals", () => {
    expect(parseRunsArgs(["--limit", "10"])).toEqual({
      targetId: undefined,
      limit: 10,
      detail: false,
    });
    expect(parseRunsArgs(["--limit=25"])).toEqual({
      targetId: undefined,
      limit: 25,
      detail: false,
    });
    expect(parseRunsArgs(["rt_123", "--limit", "5"])).toEqual({
      targetId: "rt_123",
      limit: 5,
      detail: false,
    });
  });

  test("accepts --detail with a run id in either position", () => {
    expect(parseRunsArgs(["run_456", "--detail"])).toEqual({
      targetId: "run_456",
      limit: undefined,
      detail: true,
    });
    expect(parseRunsArgs(["--detail", "run_456"])).toEqual({
      targetId: "run_456",
      limit: undefined,
      detail: true,
    });
  });

  test("rejects --detail when no target id is given", () => {
    expect(() => parseRunsArgs(["--detail"])).toThrow(UsageError);
    expect(() => parseRunsArgs(["--detail"])).toThrow(/--detail requires a run id/);
  });

  test("rejects invalid limit values", () => {
    expect(() => parseRunsArgs(["--limit"])).toThrow(/--limit needs a value/);
    expect(() => parseRunsArgs(["--limit", "0"])).toThrow(/--limit must be positive/);
    expect(() => parseRunsArgs(["--limit", "-5"])).toThrow(/--limit must be positive/);
    expect(() => parseRunsArgs(["--limit", "invalid"])).toThrow(/--limit must be positive/);
    expect(() => parseRunsArgs(["--limit=0"])).toThrow(/--limit must be positive/);
  });

  test("rejects extra positionals or unknown flags", () => {
    expect(() => parseRunsArgs(["a", "b"])).toThrow(/runs takes at most 1 argument/);
    expect(() => parseRunsArgs(["--unknown"])).toThrow(/unknown flag --unknown/);
    expect(() => parseRunsArgs(["--"])).toThrow(/`--` on its own is not a flag/);
  });
});

describe("secret protection", () => {
  test("never prints webhook secretRef in routine list or run history", async () => {
    const secretRef = "whsec_supersecrettoken999";
    const routine: Routine = {
      id: "rt_webhook_test",
      name: "Inbound Hook",
      enabled: true,
      singleton: true,
      trigger: { kind: "webhook", secretRef },
      actions: [
        {
          id: "act_1",
          name: "Process Inbound",
          prompt: "echo hook",
          cwd: "/tmp",
          host: { kind: "local" },
          labels: {},
        },
      ],
      labels: {},
      createdAt: new Date().toISOString(),
    };

    const runItem: Run = {
      id: "run_webhook_1",
      routineId: routine.id,
      state: "succeeded",
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      finishedAt: new Date().toISOString(),
      actions: [
        {
          actionId: "act_1",
          actionName: "Process Inbound",
          index: 0,
          state: "succeeded",
          startedAt: new Date(Date.now() - 30_000).toISOString(),
          finishedAt: new Date().toISOString(),
          sessionId: "sess_hook_1",
        },
      ],
    };

    const h = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [runItem] } },
      },
    });

    // 1. routines command
    const routinesExit = await run(["routines"], h.ctx);
    expect(routinesExit).toBe(0);
    const routinesOut = h.stdout();
    expect(routinesOut).toContain("webhook");
    expect(routinesOut).not.toContain(secretRef);
    expect(routinesOut).not.toContain("whsec_");

    // 2. runs command
    const runsExit = await run(["runs"], h.ctx);
    expect(runsExit).toBe(0);
    const runsOut = h.stdout();
    expect(runsOut).not.toContain(secretRef);
    expect(runsOut).not.toContain("whsec_");

    // 3. runs detail command
    const detailExit = await run(["runs", runItem.id, "--detail"], h.ctx);
    expect(detailExit).toBe(0);
    const detailOut = h.stdout();
    expect(detailOut).not.toContain(secretRef);
    expect(detailOut).not.toContain("whsec_");
  });
});

describe("run outcome distinction", () => {
  test("distinguishes succeeded, failed, skipped, refused, timed out, and shutdown runs", async () => {
    const shutdownMessage = "cancelled: the daemon shut down while this run was in flight";

    const routine: Routine = {
      id: "rt_multi",
      name: "Matrix Routine",
      enabled: true,
      singleton: true,
      trigger: { kind: "manual" },
      actions: [
        { id: "act_1", name: "A1", prompt: "p1", cwd: "/tmp", host: { kind: "local" }, labels: {} },
        { id: "act_2", name: "A2", prompt: "p2", cwd: "/tmp", host: { kind: "local" }, labels: {} },
      ],
      labels: {},
      createdAt: new Date().toISOString(),
    };

    const succeededRun: Run = {
      id: "run_succeeded",
      routineId: routine.id,
      state: "succeeded",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      finishedAt: new Date(Date.now() - 50_000).toISOString(),
      actions: [
        {
          actionId: "act_1",
          actionName: "Step Succeeded",
          index: 0,
          state: "succeeded",
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          finishedAt: new Date(Date.now() - 50_000).toISOString(),
          sessionId: "sess_succ_1",
        },
      ],
    };

    const failedRun: Run = {
      id: "run_failed",
      routineId: routine.id,
      state: "failed",
      startedAt: new Date(Date.now() - 50_000).toISOString(),
      finishedAt: new Date(Date.now() - 40_000).toISOString(),
      error: "process exited with code 1",
      actions: [
        {
          actionId: "act_1",
          actionName: "Step Failed",
          index: 0,
          state: "failed",
          startedAt: new Date(Date.now() - 50_000).toISOString(),
          finishedAt: new Date(Date.now() - 40_000).toISOString(),
          error: "process exited with code 1",
          sessionId: "sess_fail_1",
        },
      ],
    };

    const skippedRun: Run = {
      id: "run_skipped",
      routineId: routine.id,
      state: "skipped",
      startedAt: new Date(Date.now() - 40_000).toISOString(),
      finishedAt: new Date(Date.now() - 40_000).toISOString(),
      error: "skipped: previous run still in flight",
      actions: [],
    };

    const timedOutRun: Run = {
      id: "run_timed_out",
      routineId: routine.id,
      state: "timed_out",
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      finishedAt: new Date(Date.now() - 20_000).toISOString(),
      actions: [
        {
          actionId: "act_1",
          actionName: "Step Timed Out",
          index: 0,
          state: "timed_out",
          startedAt: new Date(Date.now() - 30_000).toISOString(),
          finishedAt: new Date(Date.now() - 20_000).toISOString(),
          error: "exceeded timeout of 30s",
          sessionId: "sess_to_1",
        },
      ],
    };

    const refusedRun: Run = {
      id: "run_refused",
      routineId: routine.id,
      state: "failed",
      startedAt: new Date(Date.now() - 20_000).toISOString(),
      finishedAt: new Date(Date.now() - 19_000).toISOString(),
      actions: [
        {
          actionId: "act_1",
          actionName: "Step Refused",
          index: 0,
          state: "refused",
          startedAt: new Date(Date.now() - 20_000).toISOString(),
          finishedAt: new Date(Date.now() - 19_000).toISOString(),
          refusal: { code: "invalid_action", reason: "prompt was empty" },
        },
      ],
    };

    const interruptedRun: Run = {
      id: "run_shutdown",
      routineId: routine.id,
      state: "failed",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      finishedAt: new Date(Date.now() - 5_000).toISOString(),
      error: shutdownMessage,
      actions: [
        {
          actionId: "act_1",
          actionName: "Step Interrupted",
          index: 0,
          state: "failed",
          startedAt: new Date(Date.now() - 10_000).toISOString(),
          finishedAt: new Date(Date.now() - 5_000).toISOString(),
          error: shutdownMessage,
          sessionId: "sess_int_1",
        },
      ],
    };

    // Unit level check on formatting helpers
    expect(formatRunState(succeededRun)).toBe("succeeded");
    expect(formatRunState(failedRun)).toBe("failed");
    expect(formatRunState(skippedRun)).toBe("skipped");
    expect(formatRunState(timedOutRun)).toBe("timed_out");
    expect(formatRunState(interruptedRun)).toBe("interrupted");
    expect(isInterruptedRun(interruptedRun)).toBe(true);
    expect(isInterruptedRun(failedRun)).toBe(false);

    expect(formatActionState(succeededRun.actions[0]!)).toBe("succeeded");
    expect(formatActionState(failedRun.actions[0]!)).toBe("failed");
    expect(formatActionState(timedOutRun.actions[0]!)).toBe("timed_out");
    expect(formatActionState(refusedRun.actions[0]!)).toBe("refused");
    expect(formatActionState(interruptedRun.actions[0]!)).toBe("interrupted");

    const runsList = [interruptedRun, refusedRun, timedOutRun, skippedRun, failedRun, succeededRun];

    const h = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: runsList } },
      },
    });

    const listCode = await run(["runs"], h.ctx);
    expect(listCode).toBe(0);
    const tableOutput = h.stdout();

    // Verify each distinct state appears in the table output
    expect(tableOutput).toContain("interrupted");
    expect(tableOutput).toContain("succeeded");
    expect(tableOutput).toContain("failed");
    expect(tableOutput).toContain("skipped");
    expect(tableOutput).toContain("timed_out");
    expect(tableOutput).toContain("1 refused");

    // Detail check for interrupted shutdown run
    const intHarness = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [interruptedRun] } },
      },
    });
    const intCode = await run(["runs", interruptedRun.id, "--detail"], intHarness.ctx);
    expect(intCode).toBe(1);
    const intOutput = intHarness.stdout();
    expect(intOutput).toContain("interrupted");
    expect(intOutput).toContain(shutdownMessage);
    expect(intOutput).toContain("session   sess_int_1");

    // Detail check for refused run
    const refHarness = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [refusedRun] } },
      },
    });
    const refCode = await run(["runs", refusedRun.id, "--detail"], refHarness.ctx);
    expect(refCode).toBe(1);
    const refOutput = refHarness.stdout();
    expect(refOutput).toContain("refused   invalid_action: prompt was empty");

    // Detail check for timed out run
    const toHarness = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [timedOutRun] } },
      },
    });
    const toCode = await run(["runs", timedOutRun.id, "--detail"], toHarness.ctx);
    expect(toCode).toBe(1);
    const toOutput = toHarness.stdout();
    expect(toOutput).toContain("timed_out");
    expect(toOutput).toContain("exceeded timeout of 30s");
  });
});

describe("runs command execution and output", () => {
  test("reports no routines when store has none", async () => {
    const h = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [] } },
      },
    });
    const code = await run(["runs"], h.ctx);
    expect(code).toBe(0);
    expect(h.stdout()).toBe("no routines");
  });

  test("reports no runs when routines have no runs", async () => {
    const routine: Routine = {
      id: "rt_empty",
      name: "Empty Routine",
      enabled: true,
      singleton: true,
      trigger: { kind: "manual" },
      actions: [],
      labels: {},
      createdAt: new Date().toISOString(),
    };
    const h = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [] } },
      },
    });
    const code = await run(["runs"], h.ctx);
    expect(code).toBe(0);
    expect(h.stdout()).toBe("no runs");
  });

  test("lists runs for a specific routine by routine id", async () => {
    const routine: Routine = {
      id: "rt_target",
      name: "Target Routine",
      enabled: true,
      singleton: true,
      trigger: { kind: "manual" },
      actions: [],
      labels: {},
      createdAt: new Date().toISOString(),
    };
    const runItem: Run = {
      id: "run_target_1",
      routineId: routine.id,
      state: "succeeded",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      finishedAt: new Date().toISOString(),
      actions: [
        {
          actionId: "act_1",
          actionName: "Build",
          index: 0,
          state: "succeeded",
          startedAt: new Date(Date.now() - 10_000).toISOString(),
          finishedAt: new Date().toISOString(),
        },
      ],
    };

    const h = createHarness({
      routes: {
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [runItem] } },
      },
    });

    const code = await run(["runs", routine.id], h.ctx);
    expect(code).toBe(0);
    expect(h.stdout()).toContain(runItem.id);
    expect(h.stdout()).toContain("Target Routine");
    expect(h.stdout()).toContain("succeeded");
  });

  test("orders runs newest first and respects --limit", async () => {
    const routine: Routine = {
      id: "rt_ordered",
      name: "Ordered Routine",
      enabled: true,
      singleton: true,
      trigger: { kind: "manual" },
      actions: [],
      labels: {},
      createdAt: new Date().toISOString(),
    };

    const olderRun: Run = {
      id: "run_older",
      routineId: routine.id,
      state: "succeeded",
      startedAt: new Date(Date.now() - 100_000).toISOString(),
      actions: [],
    };
    const newerRun: Run = {
      id: "run_newer",
      routineId: routine.id,
      state: "succeeded",
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      actions: [],
    };

    const h = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=1`]: { body: { routine, runs: [newerRun, olderRun] } },
      },
    });

    const code = await run(["runs", "--limit", "1"], h.ctx);
    expect(code).toBe(0);
    const lines = h.stdout().split("\n");
    expect(lines.some(l => l.includes("run_newer"))).toBe(true);
    expect(lines.some(l => l.includes("run_older"))).toBe(false);
  });

  test("accepts routines runs prefix as alias", async () => {
    const routine: Routine = {
      id: "rt_alias",
      name: "Alias Routine",
      enabled: true,
      singleton: true,
      trigger: { kind: "manual" },
      actions: [],
      labels: {},
      createdAt: new Date().toISOString(),
    };
    const h = createHarness({
      routes: {
        "GET /v1/routines": { body: { routines: [routine] } },
        [`GET /v1/routines/${routine.id}?runLimit=50`]: { body: { routine, runs: [] } },
      },
    });
    const code = await run(["routines", "runs"], h.ctx);
    expect(code).toBe(0);
    expect(h.stdout()).toBe("no runs");
  });
});

describe("error handling", () => {
  test("reports daemon unreachable in standard CLI voice", async () => {
    const h = createHarness({
      failFetch: new Error("connect ECONNREFUSED 127.0.0.1:19999"),
    });

    const code = await run(["runs"], h.ctx);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("ompd: no daemon is listening at http://127.0.0.1:19999");
    expect(h.stderr()).toContain("start it with `ompd start`, or set OMPD_URL");
  });

  test("reports token rejected in standard CLI voice", async () => {
    const h = createHarness({
      routes: {
        "GET /v1/routines": { status: 401, body: { error: "unauthorized" } },
      },
    });

    const code = await run(["runs"], h.ctx);
    expect(code).toBe(1);
    expect(h.stderr()).toContain("the daemon rejected this token");
    expect(h.stderr()).toContain("Run `ompd start` on this machine");
  });
});

describe("usage text", () => {
  test("includes runs command under routines section", () => {
    expect(CLI_USAGE).toContain("runs [<routineId>] [--limit N]");
    expect(CLI_USAGE).toContain("runs <runId> --detail");
  });
});
