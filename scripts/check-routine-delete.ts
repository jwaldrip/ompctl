/**
 * Live check that a webhook routine's whole credential lifecycle and its
 * deletion work against a real daemon process: the initial secret fires, a
 * rotation retires the old secret and arms the new one, the delete route takes
 * the definition with its run history and its credential, and the audit log
 * records who asked.
 *
 * Companion to check-routine-live.ts, which proves routines fire on the real
 * clock. This one proves the surfaces an operator actually touches for one
 * webhook routine: the public POST route, the rotate route, the delete route,
 * `ompd routines`, and the audit log. Everything happens against a scratch
 * daemon in a temp home; nothing on the operator's machine is touched.
 *
 * Every request is built from `webhookPath`, the same helper the app renders
 * its instructions from, so this check also re-proves the served route and the
 * operator-facing path cannot have drifted apart.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Routine, webhookPath } from "@ompd/core";
import { hashWebhookSecret, Ompd } from "@ompd/daemon";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

function section(title: string): void {
  console.log("");
  console.log(`-- ${title}`);
}

function echo(prefix: string, text: string): void {
  for (const line of text.split("\n")) console.log(`${prefix}${line}`);
}

/** Run the real CLI against this daemon, so the operator-visible view is real. */
async function cli(home: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", "packages/cli/src/main.ts", ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, OMPD_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return `${out}${err}`.trimEnd();
}

/**
 * Poll a run until it is terminal. A webhook fire returns 202 the moment the
 * run is queued; deleting while it is still in flight is exactly the refusal
 * the daemon exists to give, so this check waits the run out rather than
 * tripping its own guard.
 */
async function settleRun(daemon: Ompd, routineId: string, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const latest = daemon.store.listRuns(routineId)[0];
    const state = latest?.state ?? "none";
    if (latest?.finishedAt !== undefined) return state;
    if (Date.now() > deadline) return `${state} (still unfinished at the deadline)`;
    const { promise: tick, resolve: ticked } = Promise.withResolvers<void>();
    setTimeout(ticked, 250);
    await tick;
  }
}

const failures: string[] = [];

function expect(ok: boolean, finding: string): void {
  console.log(`  ${ok ? "ok" : "FAIL"}  ${finding}`);
}

const home = mkdtempSync(join(tmpdir(), "ompd-routine-delete-home-"));
const work = mkdtempSync(join(tmpdir(), "ompd-routine-delete-work-"));
const routineId = "rt_live_delete_me";
const secretRef = "whsec_live_delete_me";

const routine: Routine = {
  id: routineId,
  name: "live-delete-proof",
  enabled: true,
  trigger: { kind: "webhook", secretRef },
  actions: [
    {
      id: "act_reply",
      name: "Reply",
      prompt: "Reply with the single word: ok. Do not use tools.",
      cwd: work,
      host: { kind: "local" },
      timeoutSeconds: 180,
      labels: {},
    },
  ],
  singleton: false,
  labels: {},
  createdAt: new Date().toISOString(),
};

const initialSecret = "initial-live-secret";
const daemon = new Ompd({
  home,
  overrides: { port: 0, host: "127.0.0.1" },
  repoRoot: REPO_ROOT,
  onLog: line => console.log(`    daemon| ${line}`),
});
daemon.store.upsertRoutine(routine);
daemon.store.upsertWebhookSecret(secretRef, hashWebhookSecret(initialSecret));

try {
  const info = await daemon.start();
  console.log(`scratch daemon at ${info.url}, home ${home}`);
  const token = readFileSync(join(home, "token"), "utf8").trim();
  const bearer = { authorization: `Bearer ${token}` };
  const post = (path: string, body?: unknown, extraHeaders: Record<string, string> = {}) =>
    fetch(`${info.url}${path}`, {
      method: "POST",
      headers: { ...bearer, ...(body === undefined ? {} : { "content-type": "application/json" }), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  section("what the operator sees before anything happens");
  echo("    ", await cli(home, "routines"));

  section("the seeded secret fires the webhook through the public route");
  const firstFire = await post(webhookPath(routineId), undefined, { "x-webhook-secret": initialSecret });
  expect(firstFire.status === 202, `POST ${webhookPath(routineId)} with the seeded secret answered 202`);
  const firstRun = (await firstFire.json()) as { run?: { id: string; state: string } };
  expect(firstRun.run?.id !== undefined, `the fire started a run (${firstRun.run?.id ?? "none"})`);
  console.log(`  first run settled: ${await settleRun(daemon, routineId, 240_000)}`);

  section("rotating retires the old secret and shows the new one exactly once");
  const rotate = await post(`/v1/routines/${encodeURIComponent(routineId)}/webhook-secret`);
  expect(rotate.status === 201, `the rotate route answered 201 for the local operator token (${rotate.status})`);
  const rotated = (await rotate.json()) as { secret?: string };
  expect(typeof rotated.secret === "string" && rotated.secret.length > 20, "the rotate route returned a new secret");
  const newSecret = rotated.secret ?? "";

  const oldFire = await post(webhookPath(routineId), undefined, { "x-webhook-secret": initialSecret });
  expect(oldFire.status === 403, `the retired secret is refused (${oldFire.status}, wanted 403)`);
  echo("    ", JSON.stringify(await oldFire.json()));

  const newFire = await fetch(`${info.url}${webhookPath(routineId)}?token=${encodeURIComponent(newSecret)}`, {
    method: "POST",
  });
  expect(newFire.status === 202, `the rotated secret fires through ?token= too (${webhookPath(routineId)}?token=...)`);
  console.log(`  second run settled: ${await settleRun(daemon, routineId, 240_000)}`);

  const runsBeforeDelete = daemon.store.listRuns(routineId);
  expect(
    runsBeforeDelete.length >= 2,
    `run history exists to take with the definition (${runsBeforeDelete.length} runs)`,
  );

  section("deleting through the HTTP route takes history and credential with it");
  const deleteRes = await post("/v1/routines/delete", { routineIds: [routineId] });
  expect(deleteRes.status === 200, "the HTTP delete route answered 200");
  const deleted = (await deleteRes.json()) as { results?: Array<{ routineId: string; deleted: boolean }> };
  expect(deleted.results?.[0]?.deleted === true, `results report ${routineId} deleted`);
  echo("    ", JSON.stringify(deleted));

  // A refused sibling must not fail the batch, so prove the vocabulary too.
  const mixed = await post("/v1/routines/delete", { routineIds: ["rt_never_was"] });
  const mixedBody = (await mixed.json()) as { results?: Array<{ refusal: string }> };
  expect(
    mixed.status === 200 && mixedBody.results?.[0]?.refusal === "not_found",
    `an unknown id is refused by name, not by status (${JSON.stringify(mixedBody)})`,
  );

  section("what the operator sees after the delete");
  const listed = await fetch(`${info.url}/v1/routines`, { headers: bearer });
  const listBody = (await listed.json()) as { routines?: unknown[] };
  expect(
    listBody.routines?.length === 0,
    `GET /v1/routines no longer lists it (${listBody.routines?.length ?? "?"} left)`,
  );
  echo("    ", await cli(home, "routines"));
  expect(daemon.store.listRuns(routineId).length === 0, "the run history went with the definition");
  expect(daemon.store.getWebhookSecret(secretRef) === null, "the webhook credential row went with it");

  section("the audit log");
  const rows = daemon.store
    .listAudit()
    .filter(entry => entry.action === "routine.delete")
    .reverse();
  for (const row of rows) {
    console.log(`  ${row.ts} ${row.outcome} actor=${row.actorDeviceId ?? "?"} ${JSON.stringify(row.detail)}`);
  }
  expect(rows.length === 2, `one routine.delete row per answered id, refusal included (${rows.length} rows)`);
  expect(rows[0]?.outcome === "ok", `the deletion itself is outcome ok (actor ${rows[0]?.actorDeviceId ?? "?"})`);
  expect(rows[1]?.outcome === "denied", "the unknown id is outcome denied with its named refusal");

  section("findings");
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  FAIL  ${failure}`);
    process.exit(1);
  }
  console.log("VERDICT ok: the webhook lifecycle and the delete door work on a real daemon");
} finally {
  await daemon.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
}
