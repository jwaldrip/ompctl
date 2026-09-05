/**
 * Live smoke test against a real `omp acp` child process.
 *
 * The scripted-peer tests in `permission-path.test.ts` prove ompd's logic. This
 * proves the assumption underneath all of it: that OMP genuinely speaks the wire
 * protocol, creates sessions via ACP `session/new`, loads dormant sessions via
 * `session/load`, and enforces the approval gate.
 *
 * Gated on `which omp` succeeding so the token-free lifecycle and ACP handshake
 * tests run locally whenever omp is installed (e.g. omp 18.1.11). Tests that spend
 * real model tokens remain gated behind OMPD_LIVE=1.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Actor, SCOPE_APPROVE, SCOPE_MANAGE, SCOPE_PROMPT, SCOPE_READ, Store } from "@ompd/core";
import { type PendingApproval, Supervisor } from "../src/supervisor.ts";

const hasOmp = Bun.which("omp") !== null;
const describeOmp = hasOmp ? describe : describe.skip;
const testPrompt = hasOmp && process.env.OMPD_LIVE === "1" ? test : test.skip;

describeOmp("live omp acp", () => {
  const workdir = mkdtempSync(join(tmpdir(), "ompd-live-"));
  const store = new Store(join(workdir, "ompd.db"));
  let approvals: Array<Omit<PendingApproval, "resolve">> = [];
  const sup = new Supervisor({
    store,
    approvalTimeoutMs: 10_000,
    events: { onApprovalNeeded: p => approvals.push(p) },
  });

  store.addDevice({
    id: "operator",
    name: "operator",
    publicKey: "pk",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
    createdAt: new Date().toISOString(),
  });
  const operator: Actor = {
    deviceId: "operator",
    scopes: [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE],
  };

  afterAll(async () => {
    await sup.shutdown();
    store.close();
    rmSync(workdir, { recursive: true, force: true });
  });

  test("ACP handshake and session/new against real omp process without spending tokens", async () => {
    const agent = await sup.createAgent({ name: "live-handshake", cwd: workdir }, operator);
    expect(agent.id).toBeDefined();
    expect(agent.state).toBe("idle");
    expect(agent.acpSessionId).toBeDefined();
    expect(typeof agent.acpSessionId).toBe("string");
    expect(agent.acpSessionId!.length).toBeGreaterThan(0);

    // Clean stop
    await sup.stopAgent(agent.id, operator);
    expect(store.getAgent(agent.id)?.state).toBe("stopped");
  }, 30_000);

  test("ACP session/load resumes a dormant session against real omp process", async () => {
    // 1. Create a session with real omp
    const initial = await sup.createAgent({ name: "live-to-resume", cwd: workdir }, operator);
    const sessionId = initial.acpSessionId!;
    expect(sessionId).toBeDefined();

    // 2. Stop agent so the session becomes dormant on disk
    await sup.stopAgent(initial.id, operator);
    expect(store.getAgent(initial.id)?.state).toBe("stopped");

    // 3. Resume session via ACP session/load
    const resumed = await sup.resumeAgent({ name: "live-resumed", cwd: workdir, sessionId }, operator);
    expect(resumed.id).toBeDefined();
    expect(resumed.acpSessionId).toBe(sessionId);
    expect(resumed.state).toBe("idle");

    await sup.stopAgent(resumed.id, operator);
  }, 30_000);

  testPrompt(
    "cancelling an in-flight prompt on real omp settles the turn promptly",
    async () => {
      const agent = await sup.createAgent({ name: "live-cancel", cwd: workdir }, operator);
      const turn = sup.prompt(
        agent.id,
        "Write an exhaustive 5000-word essay about the history of computing.",
        operator,
      );
      await Bun.sleep(100);
      await sup.cancel(agent.id, operator);
      const result = await turn;
      expect(result.stopReason).toBeDefined();
      await sup.stopAgent(agent.id, operator);
    },
    60_000,
  );

  testPrompt(
    "a real agent cannot touch the filesystem when the gate is not answered",
    async () => {
      approvals = [];
      const marker = join(workdir, "denied.txt");
      const agent = await sup.createAgent({ name: "live-deny", cwd: workdir }, operator);

      await sup.prompt(
        agent.id,
        `Use your bash tool to run exactly: touch ${marker}\nThat is the entire task.`,
        operator,
      );

      expect(approvals.length).toBeGreaterThan(0);
      expect(existsSync(marker)).toBe(false);
    },
    180_000,
  );

  testPrompt(
    "the same agent does touch the filesystem once an operator approves",
    async () => {
      approvals = [];
      const marker = join(workdir, "allowed.txt");
      const agent = await sup.createAgent({ name: "live-allow", cwd: workdir }, operator);

      const turn = sup.prompt(
        agent.id,
        `Use your bash tool to run exactly: touch ${marker}\nThat is the entire task.`,
        operator,
      );

      const deadline = Date.now() + 60_000;
      let approved = false;
      while (Date.now() < deadline && !approved) {
        const p = approvals[0];
        if (p) approved = sup.decide(p.requestId, "allow", "once", operator);
        if (!approved) await Bun.sleep(150);
      }

      expect(approved).toBe(true);
      await turn;
      expect(existsSync(marker)).toBe(true);
    },
    180_000,
  );
});
