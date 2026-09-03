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

const action = (id: string, prompt: string, cwd = "/work", timeoutSeconds?: number): Routine["actions"][number] => ({
  id,
  name: id,
  prompt,
  cwd,
  host: { kind: "local" },
  timeoutSeconds,
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

/**
 * Which session each action opened, recorded on the action's own outcome.
 *
 * This is what makes a run's work reachable: the id is the one the session
 * surface is already keyed by, so a client opens it the ordinary way. The
 * pairing is the part worth guarding. One agent per action means one session
 * per action, and a run that recorded only the last one, or the same one
 * twice, would look plausible while sending every reader to one conversation.
 */
describe("routine run session identity", () => {
  test("each action records the session its own agent opened", async () => {
    const h = harness();
    h.store.upsertRoutine(routine([action("text-back", "send the text"), action("webhook", "call the webhook")]));

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    const [first, second] = run.actions;
    expect(first?.sessionId).toBeTruthy();
    expect(second?.sessionId).toBeTruthy();
    // Two agents, two sessions. Equal ids here would mean one conversation
    // wearing both actions' names.
    expect(first?.sessionId).not.toBe(second?.sessionId);

    // Paired against the wire, not merely distinct: the session that was sent
    // this action's prompt is the session recorded on this action's outcome.
    const promptedWith = (text: string): string | undefined =>
      h.fake.prompts.find(prompt => prompt.text === text)?.sessionId;
    expect(first?.sessionId).toBe(promptedWith("send the text"));
    expect(second?.sessionId).toBe(promptedWith("call the webhook"));

    // And against the agent row, which is the identity the session surface
    // resolves transport from.
    expect(first?.sessionId).toBe(h.store.getAgent(first?.agentId ?? "")?.acpSessionId);
    expect(second?.sessionId).toBe(h.store.getAgent(second?.agentId ?? "")?.acpSessionId);
  });

  test("the session id survives the run row's json round trip", async () => {
    const h = harness();
    h.store.upsertRoutine(routine([action("text-back", "send the text"), action("webhook", "call the webhook")]));

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    // The returned object is the scheduler's own; a client only ever sees the
    // row, which carries the actions as serialized json.
    const persisted = h.store.listRuns("rtn_fanout")[0];
    expect(persisted?.actions.map(outcome => outcome.sessionId)).toEqual(run.actions.map(outcome => outcome.sessionId));
    expect(persisted?.actions[0]?.sessionId).toBeTruthy();
    expect(persisted?.actions[1]?.sessionId).toBeTruthy();
  });

  test("a run still in flight already names the session it is working in", async () => {
    const h = harness();
    const gate = Promise.withResolvers<{ stopReason: string }>();
    const arrived = Promise.withResolvers<void>();
    h.fake.onPrompt(() => {
      arrived.resolve();
      return gate.promise;
    });
    h.store.upsertRoutine(routine([action("text-back", "send the text")]));

    const firing = h.scheduler.runNow("rtn_fanout", h.actor);
    await arrived.promise;

    // The row, not the returned promise: this is what a client watching a live
    // run reads. A session captured during teardown would leave this blank for
    // exactly as long as the run is worth opening.
    const running = h.store.listRuns("rtn_fanout")[0];
    expect(running?.state).toBe("running");
    expect(running?.actions[0]?.sessionId).toBe(h.fake.prompts[0]?.sessionId);

    gate.resolve({ stopReason: "end_turn" });
    expect((await firing).state).toBe("succeeded");
  });

  test("an action that timed out still records the session it opened", async () => {
    const h = harness();
    // Never answers, so the action's own deadline is what settles it. A run
    // that only records a session on success is the one that strands the
    // failures, which are exactly the runs an operator opens.
    h.fake.onPrompt(() => Promise.withResolvers<never>().promise);
    h.store.upsertRoutine(routine([action("slow", "think forever", "/work", 0.05)]));

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    expect(run.actions[0]?.state).toBe("timed_out");
    expect(run.actions[0]?.sessionId).toBeTruthy();
    expect(run.actions[0]?.sessionId).toBe(h.fake.prompts[0]?.sessionId);
    expect(h.store.listRuns("rtn_fanout")[0]?.actions[0]?.sessionId).toBe(run.actions[0]?.sessionId);
  });

  test("an action that never opened a session records no session at all", async () => {
    // Two ways to get there: refused before an agent existed, and a host that
    // could not be stood up. Neither has a session, and neither may be given
    // one, because a reader treats any id as openable.
    const h = harness("/broken");
    h.store.upsertRoutine(routine([action("empty", ""), action("hostless", "explode", "/broken")]));

    const run = await h.scheduler.runNow("rtn_fanout", h.actor);

    expect(run.actions.map(outcome => outcome.state)).toEqual(["refused", "failed"]);
    for (const outcome of run.actions) {
      expect(outcome.sessionId).toBeUndefined();
      // Absent, not present-and-empty: an empty string is a link target.
      expect("sessionId" in outcome).toBe(false);
    }
    for (const outcome of h.store.listRuns("rtn_fanout")[0]?.actions ?? []) {
      expect(outcome.sessionId).toBeUndefined();
    }
  });

  test("a run recorded before this field existed reads back with no session", async () => {
    const h = harness();
    h.store.upsertRoutine(routine([action("text-back", "send the text")]));
    // The old shape exactly: no key, because that is what json written before
    // the field looks like. Backfilling one would be inventing it.
    h.store.upsertRun({
      id: "run_legacy",
      routineId: "rtn_fanout",
      state: "succeeded",
      startedAt: "2026-08-19T00:00:00.000Z",
      finishedAt: "2026-08-19T00:00:05.000Z",
      actions: [
        {
          actionId: "text-back",
          actionName: "text-back",
          index: 0,
          agentId: "agt_gone",
          state: "succeeded",
          startedAt: "2026-08-19T00:00:00.000Z",
          finishedAt: "2026-08-19T00:00:05.000Z",
        },
      ],
    });

    const persisted = h.store.listRuns("rtn_fanout").find(row => row.id === "run_legacy");

    expect(persisted?.actions).toHaveLength(1);
    expect(persisted?.actions[0]?.sessionId).toBeUndefined();
    expect("sessionId" in (persisted?.actions[0] ?? {})).toBe(false);
  });
});
