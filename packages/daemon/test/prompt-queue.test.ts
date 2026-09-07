import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, PROMPT_QUEUE_MAX, Store } from "@ompd/core";
import { AgentBusyError, PromptQueueFullError, Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  for (const sup of sups.splice(0)) await sup.shutdown();
  for (const store of stores.splice(0)) store.close();
  for (const p of paths.splice(0)) rmSync(p, { force: true });
});

describe("prompt queue while a turn is in flight", () => {
  test("a followUp during a turn is queued and dispatched after turn end, and ninth is refused", async () => {
    const path = `/tmp/ompd-prompt-queue-${crypto.randomUUID()}.db`;
    paths.push(path);
    const store = new Store(path);
    stores.push(store);
    const host = createFakeHost();

    const queuedEvents: Array<{ agentId: string; queued: number }> = [];
    const sup = new Supervisor({
      store,
      policy: new DefaultPolicy({ mode: "standard" }),
      spawnHost: host.factory,
      events: {
        onPromptQueued: (agentId, queued) => {
          queuedEvents.push({ agentId, queued });
        },
      },
    });
    sups.push(sup);

    store.addDevice({
      id: "operator",
      name: "operator",
      publicKey: "pk_operator",
      scopes: ["read", "prompt", "manage"],
      createdAt: new Date().toISOString(),
    });
    const actor = { deviceId: "operator", scopes: ["read", "prompt", "manage"] };
    const agent = await sup.createAgent({ name: "worker", cwd: "/tmp" }, actor);

    const turn1 = Promise.withResolvers<{ stopReason: string }>();
    const turn2 = Promise.withResolvers<{ stopReason: string }>();
    const turn2Dispatched = Promise.withResolvers<void>();

    host.onPrompt((_sessionId, text) => {
      if (text === "turn 1") return turn1.promise;
      if (text === "turn 2") {
        turn2Dispatched.resolve();
        return turn2.promise;
      }
      return { stopReason: "end_turn" };
    });

    // Start turn 1
    const p1 = sup.prompt(agent.id, "turn 1", actor);

    // Follow-up prompt while busy should be queued
    const q1 = await sup.prompt(agent.id, "turn 2", actor, undefined, { deliverAs: "followUp" });
    expect(q1).toEqual({ queued: 1 });
    expect(queuedEvents).toEqual([{ agentId: agent.id, queued: 1 }]);

    // A plain prompt while busy still answers agent_busy
    await expect(sup.prompt(agent.id, "plain prompt", actor)).rejects.toThrow(AgentBusyError);

    // Queue 7 more follow-up prompts to reach PROMPT_QUEUE_MAX (8)
    for (let i = 2; i <= PROMPT_QUEUE_MAX; i++) {
      const q = await sup.prompt(agent.id, `queued ${i}`, actor, undefined, { deliverAs: "followUp" });
      expect(q).toEqual({ queued: i });
    }

    // The ninth followUp is refused with PromptQueueFullError
    await expect(sup.prompt(agent.id, "ninth", actor, undefined, { deliverAs: "followUp" })).rejects.toThrow(
      PromptQueueFullError,
    );

    // Turn 1 ends: turn 2 should be dispatched FIFO
    turn1.resolve({ stopReason: "end_turn" });
    await p1;

    // Await deterministic turn 2 dispatch without timers
    await turn2Dispatched.promise;
    expect(host.prompts).toHaveLength(2);
    expect(host.prompts[1]?.text).toBe("turn 2");

    // Stopping the agent drops the remaining queue
    expect(sup.getPromptQueue(agent.id).length).toBeGreaterThan(0);
    await sup.stopAgent(agent.id, actor);
    expect(sup.getPromptQueue(agent.id)).toHaveLength(0);

    turn2.resolve({ stopReason: "end_turn" });
  });
});
