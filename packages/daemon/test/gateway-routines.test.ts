/**
 * The routine write surface, over real HTTP against a real daemon.
 *
 * Three properties here are invisible in normal use and each fails silently.
 *
 * **Presence, not value.** A patch says "absent means unchanged, present means
 * replace". `labels: {}` clears every label; no `labels` key at all keeps the
 * ones already there. Collapse those two and clearing anything becomes
 * impossible, and nothing about the response says so.
 *
 * **The webhook credential follows the capability.** Moving a trigger off
 * `webhook` withdraws the endpoint, so the credential row has to go with it. A
 * surviving hash is a live secret nothing in the catalogue names any more.
 * Moving a trigger onto `webhook` mints a fresh ref rather than reusing one,
 * and an edit that leaves a webhook alone must not re-mint, because that
 * silently breaks a URL already handed out.
 *
 * **The audit row is safe to read.** `detail` is the one free-form field on an
 * audit row. A `secretRef` reaching it would put a credential reference in a
 * log meant to be printable, so the trigger is recorded by kind alone.
 *
 * Nothing here spawns `omp`: the supervisor's host seam is a scripted peer and
 * voice is off. Every trigger used is cron-at-3am, manual, or webhook, and the
 * one `/run` probe names a disabled routine, so the scheduler never has an
 * action to execute while a test is running.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEntry, Routine, Run } from "@ompd/core";
import { Ompd } from "../src/daemon.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const running: Ompd[] = [];

interface Harness {
  daemon: Ompd;
  url: string;
  /** The bootstrap operator credential: holds every scope, so it can mint lesser ones. */
  operator: string;
}

async function harness(): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "ompd-routines-"));
  scratch.push(home);
  const daemon = new Ompd({
    home,
    // Port 0 asks the OS for a free one, so tests never collide with each other
    // or with a daemon the developer left running.
    overrides: { port: 0 },
    spawnHost: createFakeHost().factory,
    voice: false,
  });
  running.push(daemon);
  const info = await daemon.start();
  return { daemon, url: info.url, operator: (await Bun.file(join(home, "token")).text()).trim() };
}

/** A token for a device holding exactly `scopes`, minted by the operator. */
async function tokenWith(h: Harness, name: string, scopes: string[]): Promise<string> {
  const pairing = await fetch(`${h.url}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, publicKey: `pk_${name}` }),
  });
  const paired = (await pairing.json()) as { code: string };
  const granted = await fetch(`${h.url}/v1/pairings/approve`, {
    method: "POST",
    headers: { authorization: `Bearer ${h.operator}`, "content-type": "application/json" },
    body: JSON.stringify({ code: paired.code, scopes }),
  });
  const approved = (await granted.json()) as { token: string };
  return approved.token;
}

function post(h: Harness, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token ?? h.operator}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(h: Harness, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${h.url}${path}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token ?? h.operator}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(h: Harness, path: string, token?: string): Promise<Response> {
  return fetch(`${h.url}${path}`, { headers: { authorization: `Bearer ${token ?? h.operator}` } });
}

const ACTION = { name: "Summarise", prompt: "summarise the day", cwd: "/tmp" };

/** Create a routine, asserting the 201 so a later expectation reads a real routine. */
async function create(h: Harness, draft: unknown): Promise<Routine> {
  const response = await post(h, "/v1/routines", draft);
  expect(response.status).toBe(201);
  const body = (await response.json()) as { routine: Routine };
  return body.routine;
}

/** The routine a patch answered with, asserting the 200 for the same reason. */
async function patched(h: Harness, id: string, body: unknown): Promise<Routine> {
  const response = await patch(h, `/v1/routines/${id}`, body);
  expect(response.status).toBe(200);
  const answered = (await response.json()) as { routine: Routine };
  return answered.routine;
}

/** The `secretRef` a webhook trigger names, or "" so a failure reads as a mismatch. */
function refOf(routine: Routine): string {
  return routine.trigger.kind === "webhook" ? routine.trigger.secretRef : "";
}

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("POST /v1/routines", () => {
  test("mints an id and a createdAt, defaults enabled and singleton, and forces the host local", async () => {
    const h = await harness();

    const routine = await create(h, {
      name: "nightly",
      trigger: { kind: "cron", expression: "0 3 * * *" },
      actions: [ACTION],
    });

    expect(routine.id).toMatch(/^rtn_[0-9a-f]{16}$/);
    expect(routine.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(routine.enabled).toBe(true);
    expect(routine.singleton).toBe(true);
    expect(routine.labels).toEqual({});
    expect(routine.trigger).toEqual({ kind: "cron", expression: "0 3 * * *" });
    // The host is the daemon's to decide, so an action gets a local one and an
    // id whether or not the draft named either.
    expect(routine.actions).toEqual([
      { id: expect.stringMatching(/^act_[0-9a-f]{16}$/), ...ACTION, host: { kind: "local" }, labels: {} },
    ]);

    // Written, not merely answered: the list route is a separate read path.
    const listed = (await (await get(h, "/v1/routines")).json()) as { routines: Routine[] };
    expect(listed.routines.map(r => r.id)).toEqual([routine.id]);
  });

  test("a webhook trigger gets a minted secretRef, and no secret value until one is asked for", async () => {
    const h = await harness();

    const response = await post(h, "/v1/routines", {
      name: "inbound",
      trigger: { kind: "webhook" },
      actions: [ACTION],
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { routine: Routine };

    // Exactly one key: a create that also handed back a credential would put
    // one in a response nobody asked for it in, and from there into whatever
    // record the caller keeps of its own requests.
    expect(Object.keys(body)).toEqual(["routine"]);
    const secretRef = refOf(body.routine);
    expect(secretRef).toMatch(/^whsec_[0-9a-f]{16}$/);
    expect(h.daemon.store.getWebhookSecret(secretRef)).toBeNull();

    const minted = await post(h, `/v1/routines/${body.routine.id}/webhook-secret`, {});
    expect(minted.status).toBe(201);
    const issued = (await minted.json()) as { secret: string };
    expect(issued.secret.length).toBeGreaterThan(20);

    // Returned exactly once: the store holds the digest, so nothing can reveal
    // this value again -- not this route, not a restart, not the audit log.
    const stored = h.daemon.store.getWebhookSecret(secretRef);
    expect(stored?.secretHash).toBe(new Bun.CryptoHasher("sha256").update(issued.secret).digest("hex"));
    expect(stored?.secretHash).not.toBe(issued.secret);
  });

  test("every refusal names the field that has to change", async () => {
    const h = await harness();
    const cron = { kind: "cron", expression: "0 3 * * *" };

    const refusals: Array<{ body: unknown; matches: RegExp }> = [
      { body: { name: "   ", trigger: cron, actions: [ACTION] }, matches: /name must be a non-empty string/ },
      { body: { name: "n", trigger: cron, actions: [] }, matches: /at least one action/ },
      {
        body: { name: "n", trigger: cron, actions: [{ ...ACTION, cwd: "relative/path" }] },
        matches: /actions\[0\]\.cwd must be an absolute path/,
      },
      {
        body: { name: "n", trigger: { kind: "interval", seconds: 0 }, actions: [ACTION] },
        matches: /trigger\.seconds must be a finite number greater than 0/,
      },
      {
        body: { name: "n", trigger: cron, actions: [ACTION], schedule: "daily" },
        matches: /unknown key "schedule"/,
      },
      {
        body: { name: "n", trigger: { kind: "webhook", secretRef: "whsec_mine" }, actions: [ACTION] },
        matches: /must not carry secretRef/,
      },
      // Accepted here and unrunnable on the first tick is the shape this
      // validation exists to prevent: `formatterFor` throws on an empty or
      // unknown zone the moment the scheduler arms the routine, and nothing
      // would be listening by then.
      {
        body: { name: "n", trigger: { kind: "cron", expression: "0 3 * * *", timezone: "" }, actions: [ACTION] },
        matches: /trigger\.timezone/,
      },
      {
        body: {
          name: "n",
          trigger: { kind: "cron", expression: "0 3 * * *", timezone: "Mars/Olympus_Mons" },
          actions: [ACTION],
        },
        matches: /unknown timezone/,
      },
      // A fraction of a second is a schedule the MCP surface cannot express and
      // the store has no column semantics for. Two write doors disagreeing
      // about what is legal is a shared contract in name only.
      {
        body: { name: "n", trigger: { kind: "interval", seconds: 1.5 }, actions: [ACTION] },
        matches: /trigger\.seconds must be a whole number/,
      },
      {
        body: { name: "n", trigger: cron, actions: [{ ...ACTION, timeoutSeconds: 0.5 }] },
        matches: /actions\[0\]\.timeoutSeconds must be a whole number/,
      },
    ];

    for (const { body, matches } of refusals) {
      const response = await post(h, "/v1/routines", body);
      expect(response.status).toBe(400);
      const refused = (await response.json()) as { error: string; reason: string };
      expect(refused.error).toBe("invalid_routine");
      // The reason is the only thing a caller has to fix its input from, so it
      // has to name the field rather than say "invalid".
      expect(refused.reason).toMatch(matches);
    }

    // Nothing half-written: a refused draft leaves the catalogue as it was.
    expect(h.daemon.store.listRoutines()).toEqual([]);
  });

  test("a body that is not JSON is refused as such rather than as an invalid routine", async () => {
    const h = await harness();

    const response = await fetch(`${h.url}/v1/routines`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.operator}`, "content-type": "application/json" },
      body: "{ not json",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_json" });
  });
});

describe("GET /v1/routines/:id", () => {
  test("answers the routine with its newest runs, clamped, and 404 for an id nothing holds", async () => {
    const h = await harness();
    const routine = await create(h, { name: "nightly", trigger: { kind: "manual" }, actions: [ACTION] });

    const run = (id: string, startedAt: string): Run => ({
      id,
      routineId: routine.id,
      state: "succeeded",
      startedAt,
      finishedAt: startedAt,
      actions: [],
    });
    h.daemon.store.upsertRun(run("run_older", "2026-08-01T00:00:00.000Z"));
    h.daemon.store.upsertRun(run("run_newer", "2026-08-02T00:00:00.000Z"));

    const body = (await (await get(h, `/v1/routines/${routine.id}`)).json()) as { routine: Routine; runs: Run[] };
    expect(body.routine.id).toBe(routine.id);
    expect(body.runs.map(r => r.id)).toEqual(["run_newer", "run_older"]);

    // Clamped at both ends rather than refused: a caller naming a ceiling it
    // cannot see has guessed, not erred.
    const one = (await (await get(h, `/v1/routines/${routine.id}?runLimit=1`)).json()) as { runs: Run[] };
    expect(one.runs.map(r => r.id)).toEqual(["run_newer"]);
    const zero = (await (await get(h, `/v1/routines/${routine.id}?runLimit=0`)).json()) as { runs: Run[] };
    expect(zero.runs.map(r => r.id)).toEqual(["run_newer"]);
    const huge = (await (await get(h, `/v1/routines/${routine.id}?runLimit=9999`)).json()) as { runs: Run[] };
    expect(huge.runs).toHaveLength(2);

    const missing = await get(h, "/v1/routines/rtn_never_was");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
  });

  test("the single-segment matcher does not shadow the sibling routine routes", async () => {
    const h = await harness();
    // Disabled, so the `/run` probe below proves which route answered without
    // any action actually executing.
    const routine = await create(h, {
      name: "inbound",
      enabled: false,
      trigger: { kind: "webhook" },
      actions: [ACTION],
    });

    // Two-segment paths cannot reach the `:id` matcher at all, so each must
    // still be answered by its own route. `webhook-secret` proves it by
    // succeeding; `/run` proves it by refusing in its own words rather than
    // with the `not_found` a shadowing read would have produced.
    expect((await post(h, `/v1/routines/${routine.id}/webhook-secret`, {})).status).toBe(201);
    const ran = await post(h, `/v1/routines/${routine.id}/run`, {});
    expect(ran.status).toBe(404);
    expect(await ran.json()).toEqual({ error: `routine ${routine.id} is disabled` });

    // The anchor itself, which route order alone does not defend: an
    // unanchored matcher would read `/<id>/anything` as this routine and
    // answer 200, turning a client's typo into a silent success.
    const typo = await get(h, `/v1/routines/${routine.id}/summary`);
    expect(typo.status).not.toBe(200);
    expect(await typo.text()).not.toContain(routine.id);

    // `/v1/routines/delete` is a literal path tried first, so a POST to it is
    // still a delete and not an edit of a routine named "delete".
    const deleted = await post(h, "/v1/routines/delete", { routineIds: [routine.id] });
    expect(deleted.status).toBe(200);
    expect(h.daemon.store.listRoutines()).toEqual([]);
  });
});

describe("PATCH /v1/routines/:id", () => {
  test("a key the caller omitted is not touched, and labels:{} clears while an absent labels preserves", async () => {
    const h = await harness();
    const created = await create(h, {
      name: "nightly",
      trigger: { kind: "cron", expression: "0 3 * * *" },
      actions: [ACTION],
      labels: { team: "ops" },
      singleton: false,
      enabled: false,
    });

    // Only `name` sent: everything else has to come back exactly as it was.
    const renamed = await patched(h, created.id, { name: "renamed" });
    expect(renamed.name).toBe("renamed");
    expect(renamed.trigger).toEqual(created.trigger);
    expect(renamed.actions).toEqual(created.actions);
    expect(renamed.labels).toEqual({ team: "ops" });
    expect(renamed.singleton).toBe(false);
    expect(renamed.enabled).toBe(false);
    expect(renamed.id).toBe(created.id);
    expect(renamed.createdAt).toBe(created.createdAt);

    // The assertion the whole patch contract rests on: an empty object is a
    // real instruction to clear, not an absent field.
    const cleared = await patched(h, created.id, { labels: {} });
    expect(cleared.labels).toEqual({});
    expect(cleared.name).toBe("renamed");

    // And its mirror image, which is what tells the contract from a route that
    // simply drops the field: labels set again, then a patch that never
    // mentions them leaves them alone.
    await patched(h, created.id, { labels: { team: "ops" } });
    const untouched = await patched(h, created.id, { enabled: true });
    expect(untouched.labels).toEqual({ team: "ops" });
    expect(untouched.enabled).toBe(true);
  });

  test("the webhook credential follows the capability across every trigger move", async () => {
    const h = await harness();
    const created = await create(h, { name: "inbound", trigger: { kind: "webhook" }, actions: [ACTION] });
    const firstRef = refOf(created);
    await post(h, `/v1/routines/${created.id}/webhook-secret`, {});
    expect(h.daemon.store.getWebhookSecret(firstRef)).not.toBeNull();

    // An edit that never mentions the trigger keeps the ref verbatim: it is the
    // public half of a URL already handed out.
    expect((await patched(h, created.id, { name: "inbound v2" })).trigger).toEqual({
      kind: "webhook",
      secretRef: firstRef,
    });

    // So does an edit that restates the same kind, and the credential survives
    // both.
    expect((await patched(h, created.id, { trigger: { kind: "webhook" } })).trigger).toEqual({
      kind: "webhook",
      secretRef: firstRef,
    });
    expect(h.daemon.store.getWebhookSecret(firstRef)).not.toBeNull();

    // webhook -> manual withdraws the capability, so the credential goes with
    // it. A surviving hash would be a live secret nothing names any more.
    const manual = await patched(h, created.id, { trigger: { kind: "manual" } });
    expect(manual.trigger).toEqual({ kind: "manual" });
    expect(h.daemon.store.getWebhookSecret(firstRef)).toBeNull();

    // manual -> webhook mints a fresh ref rather than reviving the old one, so
    // no two routines can be made to share one credential row.
    const rearmed = await patched(h, created.id, { trigger: { kind: "webhook" } });
    const secondRef = refOf(rearmed);
    expect(secondRef).toMatch(/^whsec_[0-9a-f]{16}$/);
    expect(secondRef).not.toBe(firstRef);
    // Minted as a name only: a value still has to be asked for.
    expect(h.daemon.store.getWebhookSecret(secondRef)).toBeNull();
  });

  test("replaces the whole actions array, keeping ids the draft named and minting the rest", async () => {
    const h = await harness();
    const created = await create(h, {
      name: "nightly",
      trigger: { kind: "manual" },
      actions: [ACTION, { ...ACTION, name: "Second" }],
    });
    const keptId = created.actions[0]?.id ?? "";

    const replaced = await patched(h, created.id, {
      actions: [{ id: keptId, name: "Summarise", prompt: "summarise the week", cwd: "/tmp" }],
    });

    // One action, not three: `actions` replaces rather than merges, and the id
    // the caller named is kept so recorded runs still point at something.
    expect(replaced.actions).toEqual([
      { id: keptId, name: "Summarise", prompt: "summarise the week", cwd: "/tmp", host: { kind: "local" }, labels: {} },
    ]);
  });

  test("refuses an unknown id, a non-JSON body, and an actions array with nothing in it", async () => {
    const h = await harness();
    const created = await create(h, { name: "nightly", trigger: { kind: "manual" }, actions: [ACTION] });

    const missing = await patch(h, "/v1/routines/rtn_never_was", { name: "x" });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });

    const malformed = await fetch(`${h.url}/v1/routines/${created.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${h.operator}`, "content-type": "application/json" },
      body: "{ not json",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "bad_json" });

    const empty = await patch(h, `/v1/routines/${created.id}`, { actions: [] });
    expect(empty.status).toBe(400);
    const refused = (await empty.json()) as { error: string; reason: string };
    expect(refused.error).toBe("invalid_patch");
    expect(refused.reason).toMatch(/at least one action/);
  });
});

describe("routine write auditing", () => {
  test("one row per write, the right action, and no credential anywhere in it", async () => {
    const h = await harness();

    const created = await create(h, { name: "inbound", trigger: { kind: "webhook" }, actions: [ACTION] });
    const secretRef = refOf(created);
    await post(h, `/v1/routines/${created.id}/webhook-secret`, {});
    await patched(h, created.id, { name: "inbound v2" });
    // Refused, so it must leave no trace: a draft nothing accepted is not a
    // write, and a row saying otherwise would make the log unreadable.
    await post(h, "/v1/routines", { name: "", trigger: { kind: "manual" }, actions: [ACTION] });

    const writes: AuditEntry[] = h.daemon.store.listAudit().filter(row => row.action.startsWith("routine."));
    // Exactly two, newest first: one create, one update.
    expect(writes.map(row => row.action)).toEqual(["routine.update", "routine.create"]);

    for (const row of writes) {
      expect(row.outcome).toBe("ok");
      expect(row.actorDeviceId).not.toBeNull();
      expect(row.detail).toMatchObject({ routineId: created.id, trigger: "webhook", actions: 1 });
      // The structural assertion, and the load-bearing one: `detail.trigger` is
      // a kind string rather than the trigger object that carries the
      // credential reference. The store's own redaction already blanks a field
      // literally named `secretRef`, so a whole-row scan alone could pass over
      // a leak that arrived under any other name; this catches the leak itself.
      expect(typeof row.detail.trigger).toBe("string");
      expect(JSON.stringify(row)).not.toContain(secretRef);
    }
    expect(writes[0]?.detail.name).toBe("inbound v2");
    expect(writes[1]?.detail.name).toBe("inbound");
  });
});

describe("routine write scopes", () => {
  test("manage gates both writes while read alone still reads one routine", async () => {
    const h = await harness();
    const created = await create(h, { name: "nightly", trigger: { kind: "manual" }, actions: [ACTION] });
    const watcher = await tokenWith(h, "watcher", ["read"]);

    const draft = { name: "x", trigger: { kind: "manual" }, actions: [ACTION] };
    const refusedCreate = await post(h, "/v1/routines", draft, watcher);
    expect(refusedCreate.status).toBe(403);
    expect(await refusedCreate.json()).toEqual({ error: "forbidden" });

    const refusedPatch = await patch(h, `/v1/routines/${created.id}`, { name: "x" }, watcher);
    expect(refusedPatch.status).toBe(403);
    expect(await refusedPatch.json()).toEqual({ error: "forbidden" });

    // The mirror image, which is what distinguishes a gate from a route that
    // simply fails: watching is still allowed, and nothing was written.
    const read = await get(h, `/v1/routines/${created.id}`, watcher);
    expect(read.status).toBe(200);
    const body = (await read.json()) as { routine: Routine };
    expect(body.routine.name).toBe("nightly");
    expect(h.daemon.store.listRoutines().map(r => r.name)).toEqual(["nightly"]);
  });
});

describe("withdrawing a webhook capability", () => {
  test("deleting the routine destroys the credential row, not only the definition", async () => {
    const h = await harness();
    const routine = await create(h, { name: "inbound", trigger: { kind: "webhook" }, actions: [ACTION] });
    const secretRef = refOf(routine);
    await post(h, `/v1/routines/${routine.id}/webhook-secret`, {});
    expect(h.daemon.store.getWebhookSecret(secretRef)).not.toBeNull();

    const response = await post(h, "/v1/routines/delete", { routineIds: [routine.id] });
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: Array<{ deleted: boolean }> };
    expect(results[0]?.deleted).toBe(true);

    // Deleting the routine is the largest withdrawal of the capability there
    // is, so it has to take the credential with it. A surviving hash is a live
    // secret nothing in the catalogue names any more: nothing lists it, nothing
    // can rotate it, and no read anywhere would ever show it again.
    expect(h.daemon.store.getWebhookSecret(secretRef)).toBeNull();
  });

  test("a refusal in the same batch leaves the surviving routine's credential alone", async () => {
    const h = await harness();
    const kept = await create(h, { name: "kept", trigger: { kind: "webhook" }, actions: [ACTION] });
    const keptRef = refOf(kept);
    await post(h, `/v1/routines/${kept.id}/webhook-secret`, {});

    // One id nothing holds, and the live one is not named at all. The mirror
    // image of the test above: a delete sweep must withdraw exactly what it
    // deleted.
    const response = await post(h, "/v1/routines/delete", { routineIds: ["rtn_never_was"] });
    expect(response.status).toBe(200);
    const { results } = (await response.json()) as { results: Array<{ deleted: boolean; refusal?: string }> };
    expect(results[0]).toMatchObject({ deleted: false, refusal: "not_found" });

    expect(h.daemon.store.getWebhookSecret(keptRef)).not.toBeNull();
  });

  test("a write that throws leaves the credential the stored definition still names", async () => {
    const h = await harness();
    const routine = await create(h, { name: "inbound", trigger: { kind: "webhook" }, actions: [ACTION] });
    const secretRef = refOf(routine);
    await post(h, `/v1/routines/${routine.id}/webhook-secret`, {});

    // The ordering, which is invisible until the day the store fails. Withdraw
    // the credential before the definition that no longer names it is on disk
    // and a failed write leaves a routine that still says `webhook`, pointed at
    // a row that is gone: every call to the endpoint is refused, and the secret
    // cannot be recovered or even rotated back into existence by that door.
    const store = h.daemon.store;
    const real = store.upsertRoutine.bind(store);
    let failed = false;
    Object.defineProperty(store, "upsertRoutine", {
      configurable: true,
      value: () => {
        failed = true;
        throw new Error("store went away mid-write");
      },
    });

    const response = await patch(h, `/v1/routines/${routine.id}`, { trigger: { kind: "manual" } });
    expect(failed).toBe(true);
    expect(response.status).toBeGreaterThanOrEqual(500);

    Object.defineProperty(store, "upsertRoutine", { configurable: true, value: real });

    // Still a webhook routine, so its credential must still exist.
    expect(store.listRoutines()[0]?.trigger).toEqual({ kind: "webhook", secretRef });
    expect(store.getWebhookSecret(secretRef)).not.toBeNull();
  });
});

describe("POST /v1/sync/import", () => {
  test("records the restore, with the actor and the count, and no per-routine arming", async () => {
    const h = await harness();

    const response = await post(h, "/v1/sync/import", {
      policyMode: "standard",
      keepAwake: false,
      skills: [],
      connectors: [],
      routines: [
        {
          id: "rtn_imported",
          name: "imported",
          enabled: true,
          trigger: { kind: "manual" },
          actions: [{ id: "act_imported", ...ACTION, labels: {} }],
          singleton: true,
          labels: {},
          createdAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, routines: 1 });

    // A door that writes routine definitions and records nothing is how
    // `routine.create` came to be a declared action nothing emitted. This one
    // writes a whole catalogue at once, so it is recorded as the one decision
    // that was actually made: a restore, by whom, of how many.
    const rows: AuditEntry[] = h.daemon.store.listAudit().filter(row => row.action === "sync.import");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.actorDeviceId).not.toBeNull();
    expect(rows[0]?.detail).toMatchObject({ routines: 1 });

    // Not fifty arming decisions nobody made: the restore is one row, and the
    // per-routine actions stay out of it.
    expect(h.daemon.store.listAudit().filter(row => row.action.startsWith("routine."))).toEqual([]);
  });

  test("a restore that fails part way through records what actually landed", async () => {
    const h = await harness();
    const store = h.daemon.store;
    const real = store.upsertRoutine.bind(store);

    // Fails on the second routine, so the first is already on disk when the
    // import gives up. This is the case where the log matters most and, before
    // the audit row moved out of the happy path, the one case with nothing in
    // it: a machine holding half of somebody else's catalogue, and a 400 that
    // reads as "nothing changed".
    let writes = 0;
    Object.defineProperty(store, "upsertRoutine", {
      configurable: true,
      value: (routine: Routine) => {
        writes += 1;
        if (writes === 2) throw new Error("store went away mid-restore");
        real(routine);
      },
    });

    const imported = (id: string) => ({
      id,
      name: id,
      enabled: true,
      trigger: { kind: "manual" },
      actions: [{ id: `act_${id}`, ...ACTION, labels: {} }],
      singleton: true,
      labels: {},
      createdAt: "2026-08-19T00:00:00.000Z",
    });

    const response = await post(h, "/v1/sync/import", {
      policyMode: "standard",
      keepAwake: false,
      skills: [],
      connectors: [],
      routines: [imported("rtn_first"), imported("rtn_second"), imported("rtn_third")],
    });
    expect(response.status).toBe(400);

    Object.defineProperty(store, "upsertRoutine", { configurable: true, value: real });

    const rows: AuditEntry[] = store.listAudit().filter(row => row.action === "sync.import");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("error");
    // One landed of three attempted, which is the only number that tells an
    // operator what state the machine is in.
    expect(rows[0]?.detail).toMatchObject({ completed: 1, failedAt: 1, attempted: 3 });
    expect(store.listRoutines().map(routine => routine.id)).toEqual(["rtn_first"]);
  });

  test("a restore that moves a routine off webhook withdraws its credential", async () => {
    const h = await harness();
    const routine = await create(h, { name: "inbound", trigger: { kind: "webhook" }, actions: [ACTION] });
    const secretRef = refOf(routine);
    await post(h, `/v1/routines/${routine.id}/webhook-secret`, {});
    expect(h.daemon.store.getWebhookSecret(secretRef)).not.toBeNull();

    const response = await post(h, "/v1/sync/import", {
      policyMode: "standard",
      keepAwake: false,
      skills: [],
      connectors: [],
      routines: [
        {
          id: routine.id,
          name: "inbound, now by hand",
          enabled: true,
          trigger: { kind: "manual" },
          actions: [{ id: routine.actions[0]?.id ?? "act_x", ...ACTION, labels: {} }],
          singleton: true,
          labels: {},
          createdAt: routine.createdAt,
        },
      ],
    });
    expect(response.status).toBe(200);

    // The credential lifecycle belongs to every door that writes a definition,
    // not only the two that were built for a terminal. A restore is the door
    // most likely to move a trigger off `webhook` without anyone thinking about
    // the secret at all.
    expect(h.daemon.store.listRoutines()[0]?.trigger).toEqual({ kind: "manual" });
    expect(h.daemon.store.getWebhookSecret(secretRef)).toBeNull();
  });

  test("an imported webhook routine gets a locally minted ref, never the document's", async () => {
    const h = await harness();

    const response = await post(h, "/v1/sync/import", {
      policyMode: "standard",
      keepAwake: false,
      skills: [],
      connectors: [],
      routines: [
        {
          id: "rtn_from_elsewhere",
          name: "inbound",
          enabled: true,
          // A ref minted by whichever daemon exported this document. Its hash
          // lives in that daemon's store and nowhere near this one, so honouring
          // it here names a row that does not exist and cannot be made to.
          trigger: { kind: "webhook", secretRef: "whsec_from_elsewhere" },
          actions: [{ id: "act_imported", ...ACTION, labels: {} }],
          singleton: true,
          labels: {},
          createdAt: "2026-08-19T00:00:00.000Z",
        },
      ],
    });
    expect(response.status).toBe(200);

    const imported = h.daemon.store.listRoutines()[0];
    expect(imported?.trigger.kind).toBe("webhook");
    const localRef = imported === undefined ? "" : refOf(imported);
    expect(localRef).toMatch(/^whsec_[0-9a-f]{16}$/);
    expect(localRef).not.toBe("whsec_from_elsewhere");
  });
});
