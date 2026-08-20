import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import { type Actor, type Routine, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store } from "@ompd/core";
import { Scheduler } from "../src/routines/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const supervisors: Supervisor[] = [];

afterEach(async () => {
  while (supervisors.length > 0) await supervisors.pop()?.shutdown();
  while (stores.length > 0) stores.pop()?.close();
  while (paths.length > 0) {
    const path = paths.pop() ?? "";
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});

function harness(rejectCwd?: string): {
  store: Store;
  scheduler: Scheduler;
  actor: Actor;
  fake: FakeHostController;
} {
  const path = `/tmp/ompd-routine-actions-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const spawnHost = (options: SpawnLocalHostOptions): LocalHost => {
    if (options.cwd === rejectCwd) throw new Error("connector failed");
    return fake.factory(options);
  };
  const supervisor = new Supervisor({ store, spawnHost });
  supervisors.push(supervisor);
  const actor: Actor = { deviceId: "daemon", scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE] };
  return {
    store,
    scheduler: new Scheduler({ store, supervisor, actor }),
    actor,
    fake,
  };
}

function routine(actions: Routine["actions"]): Routine {
  return {
    id: "rtn_fanout",
    name: "Fan out",
    enabled: true,
    trigger: { kind: "webhook", secretRef: "whsec_fanout" },
    actions,
    singleton: false,
    labels: {},
    createdAt: "2026-08-19T00:00:00.000Z",
  };
}

const action = (id: string, prompt: string, cwd = "/work"): Routine["actions"][number] => ({
  id,
  name: id,
  prompt,
  cwd,
  host: { kind: "local" },
  labels: {},
});

describe("routine action fan-out", () => {
  test("one event runs every action in order and records each outcome", async () => {
    const h = harness();
    h.store.upsertRoutine(routine([action("text-back", "send the text"), action("webhook", "call the webhook")]));

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    expect(run.actions.map(outcome => [outcome.actionId, outcome.state])).toEqual([
      ["text-back", "succeeded"],
      ["webhook", "succeeded"],
    ]);
    expect(h.fake.prompts.map(prompt => prompt.text)).toEqual(["send the text", "call the webhook"]);
    expect(h.store.listRuns("rtn_fanout")[0]?.actions).toEqual(run.actions);
  });

  test("an execution failure is recorded without consuming the next action", async () => {
    const h = harness("/broken");
    h.store.upsertRoutine(
      routine([action("broken", "explode", "/broken"), action("webhook", "call the webhook after the failure")]),
    );

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    expect(run.actions[0]).toMatchObject({
      actionId: "broken",
      state: "failed",
      error: "connector failed",
    });
    expect(run.actions[1]).toMatchObject({ actionId: "webhook", state: "succeeded" });
    expect(h.fake.prompts.map(prompt => prompt.text)).toEqual(["call the webhook after the failure"]);
    expect(h.store.listRuns("rtn_fanout")[0]?.actions[0]?.error).toBe("connector failed");
  });

  test("an invalid action records a named refusal without consuming the next action", async () => {
    const h = harness();
    h.store.upsertRoutine(
      routine([action("broken", ""), action("webhook", "call the webhook even after the refusal")]),
    );

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    expect(run.actions[0]).toMatchObject({
      actionId: "broken",
      state: "refused",
      refusal: { code: "invalid_action", reason: "prompt is empty" },
    });
    expect(run.actions[1]).toMatchObject({ actionId: "webhook", state: "succeeded" });
    expect(h.store.listRuns("rtn_fanout")[0]?.actions[0]?.refusal?.code).toBe("invalid_action");
  });
});
