/**
 * Prove the routines MCP server end to end, over raw stdio, against a real
 * daemon.
 *
 * A client reporting "connected" proves a process started and answered
 * `initialize`. It proves nothing about permissions, nothing about whether a
 * write lands, and nothing about whether the tool a model sees is the tool the
 * registry meant to expose. So this drives the JSON-RPC framing directly:
 * `initialize`, `tools/list`, then a create/read/update/run/rotate/delete round
 * trip whose every assertion is on observable daemon state rather than on a
 * call having returned.
 *
 * Three properties are load bearing:
 *
 * - **The canary, not the id.** A create that returns an id proves the call was
 *   accepted, never that the content was stored. Every routine this writes
 *   carries a unique marker string, and the read back asserts the marker
 *   arrived intact through the schema, the wire, and SQLite.
 * - **Cleanup sweeps by marker.** A failed earlier run leaves orphans, so the
 *   teardown deletes every routine whose name carries the marker prefix, not
 *   only the ids this run happens to be holding.
 * - **Failure modes are separate assertions.** Offline, bad token, and a
 *   refused schema are three different operator problems, and a server that
 *   collapsed them into one message would be useless at exactly the moment
 *   somebody needed it. Each is provoked and checked on its own.
 *
 * The artifact under test is named rather than guessed: the compiled binary is
 * the default and the source entry is an explicit opt-in. A check that
 * substituted the source entry whenever the binary was absent could not see the
 * one regression it exists to catch, a dependency `bun build --compile` leaves
 * out of the bundle, and its output did not say which artifact it had driven.
 *
 * The daemon runs on a scratch OMPD_HOME with its own store and its own
 * operator token, so nothing here can touch the real one.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const fromSource = process.argv.includes("--from-source");
const PORT = 47991;

/** Distinguishes this run's artifacts from an earlier run's orphans. */
const MARKER_PREFIX = "mcp-roundtrip-canary";
const marker = `${MARKER_PREFIX}-${crypto.randomUUID().slice(0, 8)}`;

const COMPILED = join(repo, "dist", "ompd");
const SOURCE_ENTRY = join(repo, "packages", "cli", "src", "main.ts");

/** Printed twice on a source-entry run, because scrollback loses a single line. */
const SOURCE_ONLY = "!! SOURCE ENTRY ONLY: the compiled binary was NOT exercised (--from-source).";

/**
 * Resolve the artifact under test, refusing rather than substituting.
 *
 * The compiled binary is the only artifact that can fail the way this check
 * exists to catch, so an absent `dist/ompd` is an operator error with a known
 * remedy, not a reason to quietly prove something else.
 */
function artifact(): { argv: string[]; label: string; path: string; compiled: boolean } {
  if (fromSource) return { argv: ["bun", SOURCE_ENTRY], label: "source entry", path: SOURCE_ENTRY, compiled: false };
  if (!existsSync(COMPILED)) {
    console.error(
      `No compiled binary at ${COMPILED}.\n\n` +
        "Build it first:\n\n  bun run build:cli\n\n" +
        "The source entry is deliberately not a fallback. This check exists to drive\n" +
        "the compiled artifact's MCP surface, which is the only place a dependency\n" +
        "`bun build --compile` fails to bundle can show up, and the source entry\n" +
        "cannot prove that. Pass --from-source for a fast local loop, and read the\n" +
        "result as proving nothing about the binary.",
    );
    process.exit(2);
  }
  return { argv: [COMPILED], label: "compiled binary", path: COMPILED, compiled: true };
}

const under = artifact();
console.log(`artifact under test: ${under.label} at ${under.path}`);
if (!under.compiled) console.log(SOURCE_ONLY);

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------------------
// A minimal raw-stdio MCP client
// ---------------------------------------------------------------------------

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface Waiter {
  resolve: (r: Rpc) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ToolOutcome {
  text: string;
  structured: unknown;
  isError: boolean;
}

/**
 * 120s because a first call can block on a cold compile of the source entry,
 * and a timeout that fired before the server had answered anything would
 * report a hang the server never had.
 */
const CALL_TIMEOUT_MS = 120_000;

class StdioMcp {
  #proc: ChildProcessWithoutNullStreams;
  #pending = new Map<number, Waiter>();
  #nextId = 1;
  #stderr = "";
  #buf = "";
  /**
   * Every stdout line that was not JSON-RPC. Kept rather than merely logged,
   * because tolerating them here is what would let this whole check pass over
   * the one defect it exists to catch: a real client reads this stream as
   * framed JSON, and a single human-readable line desynchronises it for good.
   */
  #junk: string[] = [];
  #dead = false;

  /**
   * `cwd` is a parameter and not left to inherit, because omp spawns a stdio
   * server from wherever it happens to be. A server that resolved anything
   * against `process.cwd()` would pass every check run from this repository and
   * fail in every real session, so at least one client here starts from `/`.
   */
  constructor(env: Record<string, string>, cwd: string = repo) {
    const [cmd, ...pre] = under.argv;
    this.#proc = spawn(cmd as string, [...pre, "mcp"], {
      env: { ...process.env, ...env },
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#proc.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    // Captured separately and quoted in every timeout: an MCP server reports a
    // fatal setup problem here and says nothing at all on stdout.
    this.#proc.stderr.on("data", (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    this.#proc.on("exit", code => {
      this.#dead = true;
      for (const [, waiter] of this.#pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`server exited (${code}); stderr:\n${this.stderrTail}`));
      }
      this.#pending.clear();
    });
  }

  get stderrTail(): string {
    return this.#stderr.slice(-3000);
  }

  /** Non-JSON-RPC stdout lines seen so far. Must always be empty. */
  get junkLines(): readonly string[] {
    return this.#junk;
  }

  #onStdout(chunk: Buffer): void {
    this.#buf += chunk.toString();
    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl < 0) break;
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line.length === 0) continue;
      let msg: Rpc;
      try {
        msg = JSON.parse(line) as Rpc;
      } catch {
        // Anything unparsable on stdout is the defect this check exists to
        // catch: one stray human-readable line corrupts the framing for good.
        this.#junk.push(line);
        continue;
      }
      // Parsing is not enough, and assuming it was is how this check nearly
      // shipped blind a second time. A structured logger writing one JSON object
      // to stdout produces a line that parses perfectly and is not a JSON-RPC
      // message, and a conforming client rejects the stream over it just the
      // same. So the shape is asserted, not the syntax: `jsonrpc: "2.0"` plus
      // either an id (a response) or a method (a notification or request).
      const framed =
        msg.jsonrpc === "2.0" &&
        (typeof msg.id === "number" || typeof msg.id === "string" || typeof msg.method === "string");
      if (!framed) {
        this.#junk.push(line);
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const waiter = this.#pending.get(msg.id);
      if (!waiter) continue;
      this.#pending.delete(msg.id);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.#dead) throw new Error(`server already exited; stderr:\n${this.stderrTail}`);
    const id = this.#nextId++;
    const response = await new Promise<Rpc>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`timeout on ${method}; stderr:\n${this.stderrTail}`));
      }, CALL_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
    if (response.error) throw new Error(`${method}: rpc error ${response.error.code} ${response.error.message}`);
    return response.result;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "check-mcp-roundtrip", version: "1" },
    });
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  }

  /** A tool-level refusal is a success-shaped result with `isError`, never a JSON-RPC error. */
  async call(name: string, args: unknown): Promise<ToolOutcome> {
    const raw = await this.request("tools/call", { name, arguments: args });
    let text = "";
    let structured: unknown;
    let isError = false;
    if (raw !== null && typeof raw === "object") {
      if ("isError" in raw) isError = raw.isError === true;
      if ("structuredContent" in raw) structured = raw.structuredContent;
      if ("content" in raw && Array.isArray(raw.content)) {
        const parts: string[] = [];
        for (const part of raw.content) {
          if (part !== null && typeof part === "object" && "text" in part && typeof part.text === "string") {
            parts.push(part.text);
          }
        }
        text = parts.join("\n");
      }
    }
    return { text, structured, isError };
  }

  close(): void {
    this.#proc.stdin.end();
    this.#proc.kill();
  }
}

/** Reads one field off a structured result without asserting a shape onto it. */
function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || !(key in value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ---------------------------------------------------------------------------
// A scratch daemon of its own
// ---------------------------------------------------------------------------

const base = `http://127.0.0.1:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "ompd-mcp-rt-"));
const workdir = mkdtempSync(join(tmpdir(), "ompd-mcp-cwd-"));

const [cmd, ...pre] = under.argv;
const daemon = spawn(cmd as string, [...pre, "start", "--host", "127.0.0.1", "--port", String(PORT), "--foreground"], {
  env: { ...process.env, OMPD_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});

/** Readiness is the daemon saying it listens, not the process existing. */
const ready = await new Promise<boolean>(resolve => {
  const deadline = setTimeout(() => resolve(false), 120_000);
  const watch = (chunk: Buffer): void => {
    if (chunk.toString().includes("ompd is listening at")) {
      clearTimeout(deadline);
      resolve(true);
    }
  };
  daemon.stdout.on("data", watch);
  daemon.stderr.on("data", watch);
  daemon.on("exit", () => {
    clearTimeout(deadline);
    resolve(false);
  });
});

let client: StdioMcp | null = null;

try {
  console.log(`\nscratch daemon at ${base}, home ${home}`);
  check("daemon reached readiness", ready);
  if (!ready) throw new Error("daemon never listened");

  const token = readFileSync(join(home, "token"), "utf8").trim();
  const env = { OMPD_HOME: home, OMPD_URL: base, OMPD_TOKEN: token };

  // --- the server answers at all ------------------------------------------
  client = new StdioMcp(env);
  await client.initialize();
  check("initialize answered over raw stdio", true);

  const listed = await client.request("tools/list");
  const tools = field(listed, "tools");
  const names: string[] = [];
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const name = field(tool, "name");
      if (typeof name === "string") names.push(name);
    }
  }
  console.log(`  tools: ${names.join(", ")}`);

  const expected = [
    "ompctl_routines_list",
    "ompctl_routine_get",
    "ompctl_routine_create",
    "ompctl_routine_update",
    "ompctl_routine_delete",
    "ompctl_routine_run",
    "ompctl_routine_rotate_webhook_secret",
  ];
  check(
    "tools/list is exactly the seven routine tools",
    names.length === expected.length && expected.every(n => names.includes(n)),
    `${names.length} tools`,
  );

  // Every tool must declare its schemas and all four annotations. A tool that
  // reached a model without them is a tool the model has to guess at.
  let fullyDescribed = true;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const ann = asRecord(field(tool, "annotations"));
      const described =
        typeof field(tool, "description") === "string" &&
        asRecord(field(tool, "inputSchema")) !== null &&
        asRecord(field(tool, "outputSchema")) !== null &&
        ann !== null &&
        typeof ann.readOnlyHint === "boolean" &&
        typeof ann.destructiveHint === "boolean" &&
        typeof ann.idempotentHint === "boolean" &&
        typeof ann.openWorldHint === "boolean";
      if (!described) {
        fullyDescribed = false;
        console.log(`       incomplete: ${String(field(tool, "name"))}`);
      }
    }
  }
  check("every tool declares input, output and all four annotations", fullyDescribed);

  // --- create, with a canary ----------------------------------------------
  const created = await client.call("ompctl_routine_create", {
    name: `${marker} nightly`,
    trigger: { kind: "cron", expression: "0 3 * * *", timezone: "America/Denver" },
    actions: [{ name: "sweep", prompt: `say ${marker}`, cwd: workdir, labels: { origin: marker } }],
    labels: { suite: marker },
  });
  check("create accepted", !created.isError, created.isError ? created.text : "");
  const routine = asRecord(field(created.structured, "routine"));
  const routineId = typeof routine?.id === "string" ? routine.id : "";
  check("create minted an rtn_ id", routineId.startsWith("rtn_"), routineId);

  // --- read it back, and assert the canary survived the round trip --------
  const got = await client.call("ompctl_routine_get", { routineId });
  const gotRoutine = asRecord(field(got.structured, "routine"));
  const gotJson = JSON.stringify(got.structured);
  check("get returns the routine", gotRoutine?.id === routineId);
  check("the canary survived create and read back", gotJson.includes(marker));
  const gotTrigger = asRecord(gotRoutine?.trigger);
  check(
    "the cron expression and timezone round tripped",
    gotTrigger?.expression === "0 3 * * *" && gotTrigger?.timezone === "America/Denver",
    JSON.stringify(gotTrigger),
  );
  const gotActions = gotRoutine?.actions;
  check(
    "the action's prompt, cwd and labels round tripped",
    Array.isArray(gotActions) &&
      gotActions.length === 1 &&
      field(gotActions[0], "cwd") === workdir &&
      String(field(gotActions[0], "prompt")).includes(marker),
  );

  const inList = await client.call("ompctl_routines_list", { nameContains: marker });
  check("list finds it by name filter", JSON.stringify(inList.structured).includes(routineId));

  // --- update: omitted stays, present replaces ----------------------------
  const renamed = await client.call("ompctl_routine_update", { routineId, name: `${marker} renamed` });
  check("update accepted", !renamed.isError, renamed.isError ? renamed.text : "");
  const afterRename = asRecord(field(renamed.structured, "routine"));
  const keptActions = afterRename?.actions;
  check(
    "renaming left the actions and trigger untouched",
    afterRename?.name === `${marker} renamed` &&
      Array.isArray(keptActions) &&
      keptActions.length === 1 &&
      asRecord(afterRename?.trigger)?.kind === "cron",
  );
  check(
    "renaming left the labels untouched",
    JSON.stringify(afterRename?.labels).includes(marker),
    JSON.stringify(afterRename?.labels),
  );

  const cleared = await client.call("ompctl_routine_update", { routineId, labels: {} });
  const afterClear = asRecord(field(cleared.structured, "routine"));
  check(
    "an explicit empty labels object clears them",
    JSON.stringify(afterClear?.labels) === "{}",
    JSON.stringify(afterClear?.labels),
  );

  // --- run: assert the record, not the exit code --------------------------
  // Whether the spawned agent succeeds depends on model access this check has
  // no business requiring. What must be true is that a run record landed,
  // named this routine, and is readable back through the get tool.
  const ran = await client.call("ompctl_routine_run", { routineId });
  const run = asRecord(field(ran.structured, "run"));
  const runId = typeof run?.id === "string" ? run.id : "";
  check(
    "run returned a run record naming this routine",
    runId.startsWith("run_") && run?.routineId === routineId,
    runId,
  );
  const afterRun = await client.call("ompctl_routine_get", { routineId });
  check("the run is readable back in the routine's history", JSON.stringify(afterRun.structured).includes(runId));

  // --- rotate: a webhook routine, and the secret exactly once -------------
  const hooked = await client.call("ompctl_routine_create", {
    name: `${marker} hook`,
    trigger: { kind: "webhook" },
    actions: [{ name: "fire", prompt: `hook ${marker}`, cwd: workdir }],
  });
  const hookId = String(field(asRecord(field(hooked.structured, "routine")), "id") ?? "");
  check("a webhook routine was created", hookId.startsWith("rtn_"), hookId);

  // No routine read may ever carry the reference that names a credential.
  const hookRead = await client.call("ompctl_routine_get", { routineId: hookId });
  check("a routine read never exposes a secretRef", !JSON.stringify(hookRead.structured).includes("whsec_"));

  const rotated = await client.call("ompctl_routine_rotate_webhook_secret", { routineId: hookId });
  const secret = field(rotated.structured, "secret");
  check("rotate returned a secret", typeof secret === "string" && String(secret).length > 20);
  const again = await client.call("ompctl_routine_rotate_webhook_secret", { routineId: hookId });
  const replacement = field(again.structured, "secret");
  check("rotating again returns a different secret", typeof replacement === "string" && replacement !== secret);

  // Two different strings is not the claim the tool makes. It says the previous
  // secret "stopped working just now", and the only way to observe that is to
  // present it. A refused fire executes nothing, so this is safe to send; the
  // replacement deliberately is not sent, because a webhook that authenticated
  // would start the routine's prompts.
  const staleFire = await fetch(`${base}/v1/webhooks/${hookId}`, {
    method: "POST",
    headers: { "x-webhook-secret": String(secret) },
  });
  check(
    "the secret from before the rotation is refused, not merely replaced",
    staleFire.status === 403,
    `HTTP ${String(staleFire.status)}`,
  );
  // The discriminator, without which the 403 above proves nothing: a 403 has to
  // mean "this credential is wrong" rather than "this endpoint refuses
  // everything". An id nothing holds answers differently.
  const unknownFire = await fetch(`${base}/v1/webhooks/rtn_does_not_exist`, {
    method: "POST",
    headers: { "x-webhook-secret": String(secret) },
  });
  check(
    "an unknown routine answers 404 rather than the same 403",
    unknownFire.status === 404,
    `HTTP ${String(unknownFire.status)}`,
  );

  // The daemon keeps a hash. If the value were recoverable by reading, the
  // "shown once" claim the tool makes would be false. Every read tool, not one:
  // asserting against `ompctl_routine_get` alone left the list tool outside a
  // claim written as "any read tool".
  const hookAfter = await client.call("ompctl_routine_get", { routineId: hookId });
  const listedAfter = await client.call("ompctl_routines_list", { nameContains: marker });
  const readSurfaces = [
    JSON.stringify(hookAfter.structured),
    hookAfter.text,
    JSON.stringify(listedAfter.structured),
    listedAfter.text,
  ];
  check(
    "neither read tool returns either secret, in structured output or in text",
    readSurfaces.every(surface => !surface.includes(String(secret)) && !surface.includes(String(replacement))),
  );

  // --- negatives ----------------------------------------------------------
  const badSchedule = await client.call("ompctl_routine_create", {
    name: `${marker} bad`,
    trigger: { kind: "interval", seconds: 0 },
    actions: [{ name: "x", prompt: "x", cwd: workdir }],
  });
  check("an interval of zero seconds is refused", badSchedule.isError);

  const relativeCwd = await client.call("ompctl_routine_create", {
    name: `${marker} bad cwd`,
    trigger: { kind: "manual" },
    actions: [{ name: "x", prompt: "x", cwd: "relative/path" }],
  });
  check("a relative cwd is refused", relativeCwd.isError);

  const unknownDelete = await client.call("ompctl_routine_delete", { routineIds: ["rtn_does_not_exist"] });
  const results = field(unknownDelete.structured, "results");
  check(
    "deleting an unknown id refuses that id rather than claiming a deletion",
    Array.isArray(results) && results.length === 1 && field(results[0], "deleted") === false,
    JSON.stringify(results),
  );

  const unknownGet = await client.call("ompctl_routine_get", { routineId: "rtn_does_not_exist" });
  check("getting an unknown id is an error result", unknownGet.isError);

  // --- delete, and prove it is gone ---------------------------------------
  const deleted = await client.call("ompctl_routine_delete", { routineIds: [routineId, hookId] });
  const delResults = field(deleted.structured, "results");
  check(
    "delete reports both ids gone",
    Array.isArray(delResults) && delResults.length === 2 && delResults.every(r => field(r, "deleted") === true),
    JSON.stringify(delResults),
  );

  const afterDelete = await client.call("ompctl_routines_list", { nameContains: marker });
  check("neither routine survives the delete", field(afterDelete.structured, "count") === 0);

  const getGone = await client.call("ompctl_routine_get", { routineId });
  check("get on the deleted routine is an error result", getGone.isError);

  // The framing assertion, and the reason this check drives raw stdio rather
  // than trusting a client: everything above could pass while the server also
  // printed a banner, a warning, or a stray log line onto the same stream. A
  // tolerant reader (like the one in this file) recovers from that; a real MCP
  // client does not. So the stream itself is an assertion, not just a
  // transport.
  check(
    "the server never wrote a non-JSON-RPC line to stdout",
    client.junkLines.length === 0,
    client.junkLines.slice(0, 3).join(" | "),
  );

  client.close();
  client = null;

  // --- offline, auth and scope are three different answers ----------------
  const offline = new StdioMcp({ OMPD_HOME: home, OMPD_URL: "http://127.0.0.1:1", OMPD_TOKEN: token });
  await offline.initialize();
  const offlineOut = await offline.call("ompctl_routines_list", {});
  offline.close();
  check(
    "an unreachable daemon is an error naming the address",
    offlineOut.isError && offlineOut.text.includes("127.0.0.1:1"),
    offlineOut.text.slice(0, 120),
  );

  const badToken = new StdioMcp({ OMPD_HOME: home, OMPD_URL: base, OMPD_TOKEN: "not-a-real-token" });
  await badToken.initialize();
  const badTokenOut = await badToken.call("ompctl_routines_list", {});
  badToken.close();
  check(
    "a rejected token is an error that does not claim the token is missing",
    badTokenOut.isError && !/no .*token found/i.test(badTokenOut.text),
    badTokenOut.text.slice(0, 120),
  );
  check("offline and rejected-token report differently", offlineOut.text !== badTokenOut.text);

  // --- the shape omp actually spawns --------------------------------------
  //
  // Everything above passed `OMPD_URL` and `OMPD_TOKEN`, which is the one shape
  // the installed server never runs in. `ompd mcp install` writes a command and
  // no environment at all, so a real session resolves the address from
  // `<home>/endpoint` and reads the 0600 `<home>/token` at the point of use. A
  // check that supplies both by environment proves the HTTP client and says
  // nothing about the credential path.
  //
  // cwd is `/`, for the same reason: omp spawns a stdio server from wherever it
  // happens to be, so anything resolved against `process.cwd()` would pass in
  // this repository and fail in every real session.
  check("the daemon published its endpoint for a server with no OMPD_URL", existsSync(join(home, "endpoint")));

  const installed = new StdioMcp({ OMPD_HOME: home }, "/");
  await installed.initialize();
  const installedList = await installed.call("ompctl_routines_list", {});
  check(
    "a server given only OMPD_HOME, from cwd=/, reaches the daemon",
    !installedList.isError,
    installedList.text.slice(0, 120),
  );

  // --- two clients at once -------------------------------------------------
  //
  // Every OMP session spawns its own server process, so concurrent writers are
  // the ordinary case rather than an edge one. They share one SQLite file
  // through the daemon, which is the part that would fail.
  const a = new StdioMcp({ OMPD_HOME: home }, "/");
  const b = new StdioMcp({ OMPD_HOME: home }, workdir);
  await Promise.all([a.initialize(), b.initialize()]);

  const [madeA, madeB] = await Promise.all([
    a.call("ompctl_routine_create", {
      name: `${marker} concurrent a`,
      trigger: { kind: "manual" },
      actions: [{ name: "a", prompt: "a", cwd: workdir }],
    }),
    b.call("ompctl_routine_create", {
      name: `${marker} concurrent b`,
      trigger: { kind: "webhook" },
      actions: [{ name: "b", prompt: "b", cwd: workdir }],
    }),
  ]);
  const idA = String(field(field(madeA.structured, "routine"), "id") ?? "");
  const idB = String(field(field(madeB.structured, "routine"), "id") ?? "");
  check("two clients created two routines at once", !madeA.isError && !madeB.isError, `${idA} ${idB}`);
  check("the two creates got distinct ids", idA.length > 0 && idB.length > 0 && idA !== idB);

  const [updatedA, rotatedB] = await Promise.all([
    a.call("ompctl_routine_update", { routineId: idA, enabled: false }),
    b.call("ompctl_routine_rotate_webhook_secret", { routineId: idB }),
  ]);
  check("a concurrent update and a concurrent rotate both landed", !updatedA.isError && !rotatedB.isError);

  const seen = await installed.call("ompctl_routines_list", { nameContains: marker });
  const seenRoutines = field(seen.structured, "routines");
  check(
    "a third client sees both routines the other two wrote",
    Array.isArray(seenRoutines) && seenRoutines.length === 2,
    Array.isArray(seenRoutines) ? String(seenRoutines.length) : "not an array",
  );

  const [goneA, goneB] = await Promise.all([
    a.call("ompctl_routine_delete", { routineIds: [idA] }),
    b.call("ompctl_routine_delete", { routineIds: [idB] }),
  ]);
  check("two clients deleted their own routine at once", !goneA.isError && !goneB.isError);

  const swept = await installed.call("ompctl_routines_list", { nameContains: marker });
  const sweptRoutines = field(swept.structured, "routines");
  check(
    "nothing the concurrent pair created survives",
    Array.isArray(sweptRoutines) && sweptRoutines.length === 0,
    Array.isArray(sweptRoutines) ? String(sweptRoutines.length) : "not an array",
  );

  // Three more streams that a stray write would corrupt, asserted for the
  // reason the first one is.
  for (const [label, peer] of [
    ["the installed-shape server", installed],
    ["concurrent client a", a],
    ["concurrent client b", b],
  ] as const) {
    check(
      `${label} wrote no non-JSON-RPC line to stdout`,
      peer.junkLines.length === 0,
      peer.junkLines.slice(0, 2).join(" | "),
    );
  }

  installed.close();
  a.close();
  b.close();
} finally {
  // Sweep by marker prefix, not by the ids this run is holding: an earlier
  // failed run leaves orphans and they are indistinguishable from live ones to
  // anyone reading the catalogue later.
  try {
    const token = readFileSync(join(home, "token"), "utf8").trim();
    const res = await fetch(`${base}/v1/routines`, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) {
      const body: unknown = await res.json();
      const all = field(body, "routines");
      const orphans: string[] = [];
      if (Array.isArray(all)) {
        for (const r of all) {
          const name = field(r, "name");
          const id = field(r, "id");
          if (typeof name === "string" && name.includes(MARKER_PREFIX) && typeof id === "string") orphans.push(id);
        }
      }
      if (orphans.length > 0) {
        const cleanup = await fetch(`${base}/v1/routines/delete`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ routineIds: orphans }),
        });
        console.log(`\nswept ${orphans.length} marked routine(s): HTTP ${cleanup.status}`);
      } else {
        console.log("\nno marked routines left to sweep");
      }
    }
  } catch (err) {
    console.log(`\ncleanup could not reach the daemon: ${err instanceof Error ? err.message : String(err)}`);
  }

  client?.close();
  daemon.kill();
  if (!keep) {
    rmSync(home, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
  } else {
    console.log(`kept ${home} and ${workdir}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `\nMCP round trip proven over raw stdio against the ${under.label} (${under.path}):` +
    " tools/list -> create -> read -> update -> run -> rotate -> delete -> gone.",
);
if (!under.compiled) console.log(SOURCE_ONLY);
