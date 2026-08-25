/**
 * The routine MCP surface, driven through a real client.
 *
 * Everything here goes over an in-memory transport into a real `McpServer`, so
 * the assertions are about the registry the SDK actually advertises and the
 * results it actually validates, not about a literal list kept beside it. That
 * matters most for the tool set: a tool registered here reaches every OMP
 * session that has ompctl configured, and that is a decision someone should
 * have to make on purpose, so the name list is asserted exactly and an eighth
 * tool fails this file.
 *
 * Four properties get the most attention.
 *
 * An update must send only the fields the caller supplied. Absent means
 * unchanged and present means replace, so a handler that filled in defaults
 * would silently overwrite fields nobody mentioned, and `labels: {}` would
 * become indistinguishable from not mentioning labels at all. Asserted on the
 * captured request body, because that is the only place the distinction is
 * real.
 *
 * A read must never carry a webhook credential reference. A tool result is
 * text a model reads and may repeat, so the canary here is asserted absent
 * from the whole serialized result rather than from the one field it was
 * expected in.
 *
 * Offline, rejected, and unauthorized must be three visibly different
 * outcomes. They need three different actions from whoever reads them, and one
 * shared message sends two of the three the wrong way.
 *
 * A schema refusal must cost nothing. An invalid draft has to fail before the
 * request, which is asserted by the fetch double recording no calls at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Routine, Run } from "@ompd/core";
import { z } from "zod";
import type { CliContext } from "../src/client.ts";
import { ROUTINE_TOOL_NAMES as PUBLISHED_TOOL_NAMES } from "../src/mcp/server.ts";
import { ROUTINE_TOOL_NAMES, registerRoutineTools } from "../src/mcp/tools.ts";

const BASE_URL = "http://127.0.0.1:19999";

/** The seven tools, spelled out. A change here is a change to the surface. */
const EXPECTED_TOOLS = [
  "ompctl_routines_list",
  "ompctl_routine_get",
  "ompctl_routine_create",
  "ompctl_routine_update",
  "ompctl_routine_delete",
  "ompctl_routine_run",
  "ompctl_routine_rotate_webhook_secret",
];

/**
 * What a tool result must look like on the wire.
 *
 * Parsed rather than cast: the SDK's `callTool` return type still admits the
 * superseded `toolResult` shape, and a schema is how an assertion about
 * external data stays an assertion. It also means every call below has proved
 * it returned a well-formed result before anything else is checked.
 */
const RESULT_SHAPE = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

const CRON_ROUTINE: Routine = {
  id: "rtn_cron",
  name: "Nightly sweep",
  enabled: true,
  trigger: { kind: "cron", expression: "0 2 * * *", timezone: "America/Denver" },
  actions: [
    {
      id: "act_1",
      name: "sweep",
      prompt: "Delete merged branches.",
      cwd: "/tmp/repo",
      host: { kind: "local" },
      timeoutSeconds: 900,
      labels: { area: "maintenance" },
    },
  ],
  singleton: true,
  labels: { owner: "jason" },
  createdAt: "2026-08-01T00:00:00.000Z",
};

/**
 * A webhook routine whose credential reference is a canary. Nothing a tool
 * returns may contain this string.
 */
const WEBHOOK_ROUTINE: Routine = {
  id: "rtn_hook",
  name: "Deploy hook",
  enabled: false,
  trigger: { kind: "webhook", secretRef: "whsec_canary" },
  actions: [
    { id: "act_2", name: "deploy", prompt: "Ship it.", cwd: "/tmp/deploy", host: { kind: "local" }, labels: {} },
  ],
  singleton: false,
  labels: {},
  createdAt: "2026-08-02T00:00:00.000Z",
};

const A_RUN: Run = {
  id: "run_1",
  routineId: "rtn_cron",
  state: "failed",
  startedAt: "2026-08-03T02:00:00.000Z",
  finishedAt: "2026-08-03T02:04:00.000Z",
  actions: [
    {
      actionId: "act_1",
      actionName: "sweep",
      index: 0,
      state: "failed",
      agentId: "agt_9",
      startedAt: "2026-08-03T02:00:00.000Z",
      finishedAt: "2026-08-03T02:04:00.000Z",
      error: "git push was rejected",
    },
  ],
};

const scratch: string[] = [];

interface Route {
  status?: number;
  body: unknown;
}

interface Call {
  path: string;
  method: string;
  /** The raw serialized body, because the omitted-vs-clear proof is textual. */
  body: string | null;
}

interface HarnessOptions {
  /** `"<METHOD> <path>"` to canned response. Anything unlisted 404s. */
  routes?: Record<string, Route>;
  /** Null writes no token file, which is the first-run state. */
  token?: string | null;
  /** Makes every request throw, the way a refused connection does. */
  offline?: boolean;
}

interface ToolCall {
  /** Everything the client received, for asserting over the whole payload. */
  raw: unknown;
  /** Every text block, joined, so a message can be asserted whole. */
  text: string;
  structured: Record<string, unknown>;
  isError: boolean;
}

interface Harness {
  client: Client;
  calls: Call[];
  /** Calls a tool and proves the result is well formed before returning it. */
  call: (name: string, args: Record<string, unknown>) => Promise<ToolCall>;
  close: () => Promise<void>;
}

async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const home = mkdtempSync(join(tmpdir(), "ompd-mcp-"));
  scratch.push(home);
  if (opts.token !== null) writeFileSync(join(home, "token"), `${opts.token ?? "tok_local"}\n`);

  const printed: string[] = [];
  const calls: Call[] = [];
  const routes: Record<string, Route> = { ...opts.routes };

  const ctx: CliContext = {
    // Anything a tool printed would corrupt the JSON-RPC framing in the real
    // server, so the double records both writers and asserts nothing about
    // them: what matters is that the tools return results, not that they print.
    out: line => printed.push(line),
    err: line => printed.push(line),
    env: { OMPD_URL: BASE_URL, HOME: home },
    cwd: home,
    home,
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const target = new URL(url);
      calls.push({
        path: target.pathname + target.search,
        method,
        body: init?.body === undefined ? null : String(init.body),
      });
      if (opts.offline === true) throw new Error("connect ECONNREFUSED 127.0.0.1:19999");

      const route = routes[`${method} ${target.pathname + target.search}`] ?? routes[`${method} ${target.pathname}`];
      if (route === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      return new Response(JSON.stringify(route.body), {
        status: route.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    },
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  };

  const server = new McpServer({ name: "ompctl", version: "0.1.0" });
  registerRoutineTools(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-tools-test", version: "0.1.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  // Listing caches the output-schema validators, so every call below is checked
  // against the schema its tool advertises. A structuredContent that drifts
  // from its own outputSchema fails here rather than in a real client.
  await client.listTools();

  return {
    client,
    calls,
    call: async (name, args) => {
      const raw = await client.callTool({ name, arguments: args });
      const parsed = RESULT_SHAPE.parse(raw);
      return {
        raw,
        text: parsed.content
          .filter(block => block.type === "text")
          .map(block => block.text ?? "")
          .join("\n"),
        structured: parsed.structuredContent ?? {},
        isError: parsed.isError === true,
      };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the tool surface", () => {
  test("registers exactly the seven published routine tools, in order", async () => {
    const h = await harness();
    const listed = await h.client.listTools();
    const names = listed.tools.map(tool => tool.name);

    expect(Array.from<string>(ROUTINE_TOOL_NAMES)).toEqual(EXPECTED_TOOLS);
    // The name the rest of the CLI imports is the same list, so what the
    // installer advertises and what the server registers cannot diverge.
    expect(Array.from<string>(PUBLISHED_TOOL_NAMES)).toEqual(EXPECTED_TOOLS);
    // Set equality against the live registry: an eighth tool reaching every
    // OMP session fails here, whatever order it was registered in.
    expect(names.slice().sort()).toEqual(EXPECTED_TOOLS.slice().sort());
    expect(names).toEqual(EXPECTED_TOOLS);
    await h.close();
  });

  test("every tool is fully described: title, description, both schemas, all four annotations", async () => {
    const h = await harness();
    const listed = await h.client.listTools();
    expect(listed.tools).toHaveLength(EXPECTED_TOOLS.length);

    for (const tool of listed.tools) {
      expect(tool.title, `${tool.name} title`).toBeTruthy();
      expect((tool.description ?? "").length, `${tool.name} description`).toBeGreaterThan(40);
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
      // Explicitly set, not merely absent. A missing hint leaves a client
      // guessing whether a tool writes, and every one of these has an answer.
      expect(tool.annotations?.readOnlyHint, `${tool.name} readOnlyHint`).toBeTypeOf("boolean");
      expect(tool.annotations?.destructiveHint, `${tool.name} destructiveHint`).toBeTypeOf("boolean");
      expect(tool.annotations?.idempotentHint, `${tool.name} idempotentHint`).toBeTypeOf("boolean");
      expect(tool.annotations?.openWorldHint, `${tool.name} openWorldHint`).toBeTypeOf("boolean");
    }
    await h.close();
  });

  test("the full annotation matrix is pinned for every registered tool", async () => {
    const h = await harness();
    const listed = await h.client.listTools();

    // Keyed by name and checked against the live registry rather than walked in
    // registration order, so a renamed or added tool fails here instead of
    // shifting into a neighbour's row and passing.
    const expected: Record<string, Record<string, boolean | undefined>> = {
      ompctl_routines_list: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ompctl_routine_get: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      ompctl_routine_create: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      // An action sent without an id gets a fresh one on every write, so a
      // repeated patch does not leave the same routine behind.
      ompctl_routine_update: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      ompctl_routine_delete: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      // Firing a routine starts arbitrary prompts on this machine, so nothing
      // here can bound what they touch.
      ompctl_routine_run: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      ompctl_routine_rotate_webhook_secret: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    };

    // Both directions: the registry holds exactly these names, and each one's
    // four hints are exactly what this table says.
    expect(listed.tools.map(tool => tool.name).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, want] of Object.entries(expected)) {
      const tool = listed.tools.find(candidate => candidate.name === name);
      const hints: Record<string, boolean | undefined> = {
        readOnlyHint: tool?.annotations?.readOnlyHint,
        destructiveHint: tool?.annotations?.destructiveHint,
        idempotentHint: tool?.annotations?.idempotentHint,
        openWorldHint: tool?.annotations?.openWorldHint,
      };
      expect(hints, `${name} annotations`).toEqual(want);
    }
    await h.close();
  });
});

describe("reading routines", () => {
  test("lists what the daemon holds and filters in this process, not on the wire", async () => {
    const h = await harness({
      routes: { "GET /v1/routines": { body: { routines: [CRON_ROUTINE, WEBHOOK_ROUTINE] } } },
    });

    const all = await h.call("ompctl_routines_list", {});
    expect(all.structured).toMatchObject({ count: 2 });

    const filtered = await h.call("ompctl_routines_list", {
      enabled: true,
      triggerKind: "cron",
      nameContains: "NIGHTLY",
    });
    expect(filtered.structured).toMatchObject({ count: 1 });
    expect(filtered.text).toContain("rtn_cron");

    // The daemon has no filter parameters on this route, so both calls are the
    // same bare GET. If that ever stops being true, the filtering comment in
    // the tool is wrong and this fails.
    expect(h.calls.map(call => `${call.method} ${call.path}`)).toEqual(["GET /v1/routines", "GET /v1/routines"]);
    await h.close();
  });

  test("a listed webhook routine never carries its credential reference", async () => {
    const h = await harness({ routes: { "GET /v1/routines": { body: { routines: [WEBHOOK_ROUTINE] } } } });

    const result = await h.call("ompctl_routines_list", {});
    expect(JSON.stringify(result.raw)).not.toContain("whsec_canary");
    // Dropped, not merely renamed: the caller still learns a secret exists.
    expect(result.structured).toMatchObject({
      routines: [{ trigger: { kind: "webhook", hasWebhookSecretRef: true } }],
    });
    await h.close();
  });

  test("an inspected routine returns its actions and runs, and no credential reference", async () => {
    const h = await harness({
      routes: {
        "GET /v1/routines/rtn_hook?runLimit=10": { body: { routine: WEBHOOK_ROUTINE, runs: [A_RUN] } },
      },
    });

    const result = await h.call("ompctl_routine_get", { routineId: "rtn_hook" });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.raw)).not.toContain("whsec_canary");
    expect(result.structured).toMatchObject({
      routine: { id: "rtn_hook", trigger: { kind: "webhook", hasWebhookSecretRef: true }, actions: [{ id: "act_2" }] },
      runs: [{ id: "run_1", state: "failed", actions: [{ state: "failed", error: "git push was rejected" }] }],
    });
    // The default run limit is the tool's, not left for the daemon to pick.
    expect(h.calls[0]?.path).toBe("/v1/routines/rtn_hook?runLimit=10");
    await h.close();
  });
});

describe("writing routines", () => {
  test("an update sends only the fields the caller supplied", async () => {
    const h = await harness({ routes: { "PATCH /v1/routines/rtn_cron": { body: { routine: CRON_ROUTINE } } } });

    await h.call("ompctl_routine_update", { routineId: "rtn_cron", name: "Nightly sweep" });
    expect(h.calls[0]?.method).toBe("PATCH");
    expect(h.calls[0]?.body).toBe('{"name":"Nightly sweep"}');

    // The clearing case, which is the one a spread of defaults destroys: an
    // empty object has to reach the daemon as an empty object.
    await h.call("ompctl_routine_update", { routineId: "rtn_cron", labels: {} });
    expect(h.calls[1]?.body).toBe('{"labels":{}}');
    await h.close();
  });

  test("a repeated update whose action omits an id sends no id either time, so the daemon mints a new one", async () => {
    const h = await harness({ routes: { "PATCH /v1/routines/rtn_cron": { body: { routine: CRON_ROUTINE } } } });

    const patch = {
      routineId: "rtn_cron",
      actions: [{ name: "sweep", prompt: "Delete merged branches.", cwd: "/tmp/repo" }],
    };
    await h.call("ompctl_routine_update", patch);
    await h.call("ompctl_routine_update", patch);

    // This is why `idempotentHint` is false on update. The tool forwards the
    // action exactly as the caller wrote it, so both identical calls arrive
    // carrying no action id, and the gateway mints a fresh one each time:
    // packages/daemon/test/gateway-routines.test.ts proves the minting itself.
    // The second call therefore leaves a routine equal field by field but with
    // an action id that no earlier run outcome names.
    const sent = h.calls.map(call => JSON.parse(call.body ?? "null") as { actions?: Array<{ id?: string }> });
    expect(sent).toHaveLength(2);
    for (const body of sent) {
      expect(body.actions).toHaveLength(1);
      expect(body.actions?.[0]).not.toHaveProperty("id");
    }

    // Carrying the id back is what makes the write repeatable, and the tool
    // has to pass it through for that advice to be worth anything.
    await h.call("ompctl_routine_update", {
      routineId: "rtn_cron",
      actions: [{ id: "act_1", name: "sweep", prompt: "Delete merged branches.", cwd: "/tmp/repo" }],
    });
    expect(h.calls[2]?.body).toContain('"id":"act_1"');
    await h.close();
  });

  test("a create posts the draft and reports what came back", async () => {
    const h = await harness({ routes: { "POST /v1/routines": { status: 201, body: { routine: CRON_ROUTINE } } } });

    const result = await h.call("ompctl_routine_create", {
      name: "Nightly sweep",
      trigger: { kind: "cron", expression: "0 2 * * *", timezone: "America/Denver" },
      actions: [{ name: "sweep", prompt: "Delete merged branches.", cwd: "/tmp/repo", timeoutSeconds: 900 }],
    });

    expect(result.isError).toBe(false);
    expect(h.calls[0]?.body).toBe(
      '{"name":"Nightly sweep","trigger":{"kind":"cron","expression":"0 2 * * *","timezone":"America/Denver"},' +
        '"actions":[{"name":"sweep","prompt":"Delete merged branches.","cwd":"/tmp/repo","timeoutSeconds":900}]}',
    );
    expect(result.structured).toMatchObject({ routine: { id: "rtn_cron" } });
    await h.close();
  });

  test("a delete answers every id, so a partial refusal is legible", async () => {
    const h = await harness({
      routes: {
        "POST /v1/routines/delete": {
          body: {
            results: [
              { routineId: "rtn_cron", deleted: true },
              { routineId: "rtn_hook", deleted: false, refusal: "running" },
            ],
          },
        },
      },
    });

    const result = await h.call("ompctl_routine_delete", { routineIds: ["rtn_cron", "rtn_hook"] });

    expect(result.structured).toMatchObject({
      results: [
        { routineId: "rtn_cron", deleted: true },
        { routineId: "rtn_hook", deleted: false, refusal: "running" },
      ],
    });
    expect(result.text).toContain("rtn_cron deleted");
    expect(result.text).toContain("rtn_hook refused (running)");
    // The daemon's own wording for the cause, not a paraphrase of it.
    expect(result.text).toContain("let it finish or stop it first");
    await h.close();
  });

  test("a manual run reports each action's outcome, not just the run's", async () => {
    const h = await harness({ routes: { "POST /v1/routines/rtn_cron/run": { body: { run: A_RUN } } } });

    const result = await h.call("ompctl_routine_run", { routineId: "rtn_cron" });
    expect(result.structured).toMatchObject({ run: { id: "run_1", state: "failed" } });
    expect(result.text).toContain("1. sweep  failed  git push was rejected");
    await h.close();
  });

  test("a rotated webhook secret is returned once, and says so", async () => {
    const h = await harness({
      routes: { "POST /v1/routines/rtn_hook/webhook-secret": { status: 201, body: { secret: "whsec_fresh" } } },
    });

    const result = await h.call("ompctl_routine_rotate_webhook_secret", { routineId: "rtn_hook" });

    expect(result.structured).toEqual({ routineId: "rtn_hook", secret: "whsec_fresh", sensitive: true });
    expect(result.text).toContain("whsec_fresh");
    expect(result.text).toContain("only time this value is shown");
    expect(result.text).toContain("previous secret stopped working");
    await h.close();
  });
});

describe("failures an operator has to tell apart", () => {
  test("no token, a rejected token, a missing scope, and no daemon read as four different problems", async () => {
    const missing = await harness({ token: null, routes: { "GET /v1/routines": { body: { routines: [] } } } });
    const rejected = await harness({
      routes: { "GET /v1/routines": { status: 401, body: { error: "unauthorized" } } },
    });
    const unscoped = await harness({
      routes: { "POST /v1/routines/rtn_cron/run": { status: 403, body: { error: "forbidden" } } },
    });
    const offline = await harness({ offline: true });

    const noToken = await missing.call("ompctl_routines_list", {});
    const badToken = await rejected.call("ompctl_routines_list", {});
    const noScope = await unscoped.call("ompctl_routine_run", { routineId: "rtn_cron" });
    const noDaemon = await offline.call("ompctl_routines_list", {});

    // Errors, not exceptions: a thrown handler reaches the client as a
    // protocol failure with the cause flattened out of it.
    for (const result of [noToken, badToken, noScope, noDaemon]) expect(result.isError).toBe(true);

    // Nothing was sent when there was no token to send.
    expect(missing.calls).toHaveLength(0);
    expect(noToken.text).toContain("no operator token was found");

    // A token was found and presented, so this must not send someone looking
    // for a token they are already holding.
    expect(badToken.text).toContain("the daemon rejected this token");
    expect(badToken.text).not.toContain("no operator token was found");
    expect(badToken.text).not.toContain("No device token found");

    // The scope is the actionable part: the token works, and it is not allowed
    // to do this.
    expect(noScope.text).toContain("`manage` scope");
    expect(noScope.text).not.toContain("rejected this token");

    // The address is the actionable part: usually the daemon is running and
    // this shell is pointed somewhere else.
    expect(noDaemon.text).toContain(BASE_URL);
    expect(noDaemon.text).toContain("no daemon is listening");

    // Four causes, four messages.
    expect(new Set([noToken.text, badToken.text, noScope.text, noDaemon.text]).size).toBe(4);

    await Promise.all([missing.close(), rejected.close(), unscoped.close(), offline.close()]);
  });

  test("a refused write carries the daemon's reason, which is the part that says what to fix", async () => {
    const h = await harness({
      routes: {
        "POST /v1/routines": {
          status: 400,
          body: { error: "invalid_routine", reason: "actions must have at least one entry" },
        },
      },
    });

    const result = await h.call("ompctl_routine_create", {
      name: "Nightly sweep",
      trigger: { kind: "manual" },
      actions: [{ name: "sweep", prompt: "Delete merged branches.", cwd: "/tmp/repo" }],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid_routine");
    expect(result.text).toContain("actions must have at least one entry");
    await h.close();
  });

  test("a routine that is not there reports the daemon's own reason", async () => {
    const h = await harness({
      routes: { "GET /v1/routines/rtn_gone?runLimit=10": { status: 404, body: { error: "not_found" } } },
    });

    const result = await h.call("ompctl_routine_get", { routineId: "rtn_gone" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not_found");
    await h.close();
  });

  test("a daemon with no routine runner says the feature is off, not broken", async () => {
    const h = await harness({
      routes: { "POST /v1/routines/rtn_cron/run": { status: 503, body: { error: "routines_unavailable" } } },
    });

    const result = await h.call("ompctl_routine_run", { routineId: "rtn_cron" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no routine runner wired in");
    await h.close();
  });
});

describe("input the schema refuses", () => {
  const draft = {
    name: "Nightly sweep",
    trigger: { kind: "cron", expression: "0 2 * * *" },
    actions: [{ name: "sweep", prompt: "Delete merged branches.", cwd: "/tmp/repo" }],
  };

  const rejected: Record<string, Record<string, unknown>> = {
    "a relative cwd": { ...draft, actions: [{ name: "sweep", prompt: "Do it.", cwd: "relative/path" }] },
    "no actions at all": { ...draft, actions: [] },
    "an interval of zero seconds": { ...draft, trigger: { kind: "interval", seconds: 0 } },
    "a fractional interval": { ...draft, trigger: { kind: "interval", seconds: 1.5 } },
    "an empty name": { ...draft, name: "" },
    // Both of these would be stripped by a non-strict schema, and stripping is
    // worse than refusing: the caller is told yes and gets something else.
    "a secret on a webhook trigger": { ...draft, trigger: { kind: "webhook", secretRef: "whsec_mine" } },
    "an execution host on an action": {
      ...draft,
      actions: [{ name: "sweep", prompt: "Do it.", cwd: "/tmp/repo", host: { kind: "container" } }],
    },
  };

  for (const [what, args] of Object.entries(rejected)) {
    test(`${what} is refused before anything is sent`, async () => {
      const h = await harness({ routes: { "POST /v1/routines": { status: 201, body: { routine: CRON_ROUTINE } } } });

      const result = await h.call("ompctl_routine_create", args);
      expect(result.isError).toBe(true);
      // The point of a schema: a bad draft costs no request, no token read, and
      // nothing half-written on the other end.
      expect(h.calls).toHaveLength(0);
      await h.close();
    });
  }

  test("a run limit outside the daemon's range is refused", async () => {
    const h = await harness();
    const result = await h.call("ompctl_routine_get", { routineId: "rtn_cron", runLimit: 500 });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.close();
  });

  test("an update with nothing to change is refused rather than sent as an empty patch", async () => {
    const h = await harness({ routes: { "PATCH /v1/routines/rtn_cron": { body: { routine: CRON_ROUTINE } } } });
    const result = await h.call("ompctl_routine_update", { routineId: "rtn_cron" });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
    await h.close();
  });
});
