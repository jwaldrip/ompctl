/**
 * The loopback broker's HTTP boundary, against a real upstream.
 *
 * Every upstream here is an actual `Bun.serve` reached over actual HTTP, not a
 * mocked `fetch`. That is deliberate and it is most of the value: the things
 * that break a proxy are HTTP semantics -- when response headers flush, whether
 * a body streams or buffers, whether an abort reaches the far end, whether a
 * replayed POST still has its body -- and a stubbed `fetch` answers all four by
 * assumption. Only the broker and the grant store are stubs, because their
 * behaviour is another slice's contract and is not what is under test here.
 *
 * Time is injected, not slept through: the one test whose subject is a deadline
 * drives `Clock.now` by hand. The only real timer in this file is a watchdog
 * that never fires on a passing run.
 *
 * One cross-cutting rule is enforced in `afterEach` rather than in a single
 * test: no access token any stub broker minted may appear in a log line the
 * proxy emitted or in a body a caller actually read. It is asserted against the
 * collected bytes, never against a redaction helper's opinion of itself.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { McpAuthState } from "@ompd/core";
import { MCP_AUTH_HEADER, type McpAuthProxy, startMcpAuthProxy } from "../src/mcpauth/proxy.ts";
import type { AccessTokenResult, Clock, GrantRecord, GrantStore, McpAuthBroker } from "../src/mcpauth/types.ts";

/** Stands in for the contents of `~/.ompd/mcp-auth.token`. The proxy only ever sees the digest. */
const LOOPBACK_TOKEN = "ompd-loopback-token-2f9c41";
const TOKEN_HASH = createHash("sha256").update(LOOPBACK_TOKEN).digest("hex");

const running: Array<{ stop(): void }> = [];
/** Every access token any stub broker handed out in the current test. */
const minted = new Set<string>();
/** Every line the proxy asked to have logged. */
const logs: string[] = [];
/** Every byte a caller actually read off the wire. */
const wire: string[] = [];

afterEach(() => {
  const emitted = [...logs, ...wire].join("\n");
  const secrets = [...minted];
  // Torn down before the assertion, so a leak fails the test it happened in
  // without also leaving a server bound behind it.
  for (const item of running.splice(0)) item.stop();
  logs.length = 0;
  wire.length = 0;
  minted.clear();
  for (const secret of secrets) expect(emitted).not.toContain(secret);
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SeenRequest {
  method: string;
  path: string;
  /** Lowercased by `Headers`, which is what makes an absence assertion meaningful. */
  headers: Record<string, string>;
  body: string;
}

interface Upstream {
  url: string;
  seen: SeenRequest[];
  stop(): void;
}

/** A real MCP-shaped server. The handler sees the live `Request` (for `signal`) and the record already taken from it. */
function upstream(handler: (req: Request, seen: SeenRequest) => Response | Promise<Response>): Upstream {
  const seen: SeenRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: async req => {
      const record: SeenRequest = {
        method: req.method,
        path: new URL(req.url).pathname,
        headers: Object.fromEntries(req.headers),
        body: req.method === "POST" ? await req.text() : "",
      };
      seen.push(record);
      return handler(req, record);
    },
  });
  const it: Upstream = { url: `http://127.0.0.1:${server.port}/mcp`, seen, stop: () => server.stop(true) };
  running.push(it);
  return it;
}

interface StubBroker extends McpAuthBroker {
  /** Grant ids `invalidate` was called with, in order. */
  invalidated: string[];
  /** Access tokens actually handed out, in order. Empty proves the screen ran upstream of the broker. */
  handed: string[];
}

/** Hands out `results` in order, repeating the last one once exhausted. */
function stubBroker(results: readonly AccessTokenResult[]): StubBroker {
  const invalidated: string[] = [];
  const handed: string[] = [];
  let next = 0;
  for (const result of results) if (result.ok) minted.add(result.accessToken);
  return {
    invalidated,
    handed,
    accessTokenFor: async () => {
      const result = results[Math.min(next++, results.length - 1)]!;
      if (result.ok) handed.push(result.accessToken);
      return result;
    },
    invalidate: id => {
      invalidated.push(id);
    },
    refreshNow: async () => ({ kind: "transient", reason: "the proxy never calls this" }),
    summaries: () => [],
    start: () => {},
    stop: () => {},
  };
}

function granted(accessToken: string): AccessTokenResult {
  return { ok: true, accessToken, tokenType: "Bearer" };
}

/**
 * `mcpauth_` + the first 16 hex of sha256(`resourceUrl\naccount`).
 *
 * Reproduced here rather than imported because it is a cross-slice contract:
 * the store, the config bridge and this endpoint all derive it independently,
 * and a test that borrowed one of their implementations would not notice the
 * three disagreeing.
 */
function grantIdFor(resourceUrl: string, account?: string): string {
  const digest = createHash("sha256")
    .update(`${resourceUrl}\n${account ?? ""}`)
    .digest("hex");
  return `mcpauth_${digest.slice(0, 16)}`;
}

function grant(resourceUrl: string, serverName = "notes"): GrantRecord {
  const at = "2026-08-25T00:00:00.000Z";
  return {
    id: grantIdFor(resourceUrl),
    serverName,
    resourceUrl,
    issuer: "https://auth.example.test",
    tokenUrl: "https://auth.example.test/token",
    clientId: "client-abc",
    scopes: "mcp:read mcp:write",
    state: "healthy",
    supportsRefresh: true,
    failures: 0,
    createdAt: at,
    updatedAt: at,
  };
}

function stubStore(...grants: GrantRecord[]): Pick<GrantStore, "get"> {
  const byId = new Map(grants.map(record => [record.id, record]));
  return { get: id => byId.get(id) };
}

function proxy(opts: {
  broker: McpAuthBroker;
  grants: Pick<GrantStore, "get">;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}): McpAuthProxy {
  const started = startMcpAuthProxy({
    broker: opts.broker,
    grants: opts.grants,
    tokenHash: TOKEN_HASH,
    clock: opts.clock,
    fetchImpl: opts.fetchImpl,
    onLog: line => logs.push(line),
  });
  running.push({ stop: () => started.close() });
  return started;
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { [MCP_AUTH_HEADER]: LOOPBACK_TOKEN, "content-type": "application/json", ...extra };
}

function post(url: string, frame: unknown, headers: Record<string, string> = auth()): Promise<Response> {
  return fetch(url, { method: "POST", headers, body: JSON.stringify(frame) });
}

interface RpcBody {
  jsonrpc?: string;
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Reads the body AND records it, so the leak gate in `afterEach` sees every byte a caller saw. */
async function readJson(res: Response): Promise<RpcBody> {
  const text = await res.text();
  wire.push(text);
  return text === "" ? {} : (JSON.parse(text) as RpcBody);
}

/** Reads and records a body nothing asserts on, so it still reaches the leak gate. */
async function drain(res: Response): Promise<Response> {
  wire.push(await res.text());
  return res;
}

/**
 * A watchdog, not a wait.
 *
 * Nothing here sleeps for a duration: `work` is the real signal (a response, a
 * stream chunk, an abort event) and the timer exists only so a proxy that
 * buffered a body reports the specific thing that hung instead of a suite-level
 * timeout. Fake timers are not an option in this file at all -- `fetch` and
 * `Bun.serve` are the subjects, and both stop working when the platform clock
 * is replaced. On a passing run this timer is cleared without firing and costs
 * nothing.
 */
async function within<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  const bail = Promise.withResolvers<never>();
  const timer = setTimeout(() => bail.reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
  try {
    return await Promise.race([work, bail.promise]);
  } finally {
    clearTimeout(timer);
  }
}

function sse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

// ---------------------------------------------------------------------------

describe("MCP auth proxy: the brokered round trip", () => {
  test("a tools/call reaches the upstream under the broker's bearer token, and the upstream's result reaches the caller", async () => {
    const up = upstream(() =>
      Response.json({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "three results" }] } }),
    );
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-round-trip")]), grants: stubStore(g) });

    const res = await post(p.urlFor(g.id), {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search", arguments: { q: "kanban" } },
    });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.result).toEqual({ content: [{ type: "text", text: "three results" }] });
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.headers.authorization).toBe("Bearer access-round-trip");
    expect(up.seen[0]!.path).toBe("/mcp");
    // The frame arrived intact, params and all: reading the body so a replay can
    // resend it must not consume it out from under the request actually made.
    expect(JSON.parse(up.seen[0]!.body)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "search", arguments: { q: "kanban" } },
    });
  });

  test("notifications/* is forwarded, because notification types are the part of the protocol that grows", async () => {
    const up = upstream(() => new Response(null, { status: 202 }));
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-notify")]), grants: stubStore(g) });

    const res = await drain(
      await post(p.urlFor(g.id), { jsonrpc: "2.0", method: "notifications/progress", params: { p: 1 } }),
    );

    expect(res.status).toBe(202);
    expect(up.seen).toHaveLength(1);
  });

  test("DELETE is forwarded, since that is how a Streamable HTTP client terminates its session", async () => {
    const up = upstream(() => new Response(null, { status: 204 }));
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-delete")]), grants: stubStore(g) });

    const res = await fetch(p.urlFor(g.id), {
      method: "DELETE",
      headers: auth({ "mcp-session-id": "sess-teardown" }),
    });

    expect(res.status).toBe(204);
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]!.method).toBe("DELETE");
    expect(up.seen[0]!.headers["mcp-session-id"]).toBe("sess-teardown");
  });

  test("the injected fetch seam is what performs the upstream call", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const through: string[] = [];
    // `typeof fetch` carries `preconnect` under Bun, so a stand-in for the seam
    // has to carry the whole surface rather than just the callable half.
    const counted: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        through.push(String(input));
        return fetch(input, init);
      },
      { preconnect: fetch.preconnect },
    );
    const p = proxy({ broker: stubBroker([granted("access-seam")]), grants: stubStore(g), fetchImpl: counted });

    await readJson(await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(through).toEqual([up.url]);
    expect(up.seen).toHaveLength(1);
  });
});

describe("MCP auth proxy: what never reaches the upstream", () => {
  test("a missing, empty or wrong X-Ompd-Mcp-Auth is 401, identically, and the upstream is never contacted", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const broker = stubBroker([granted("access-never-minted")]);
    const p = proxy({ broker, grants: stubStore(g) });
    const frame = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    const absent = await post(p.urlFor(g.id), frame, { "content-type": "application/json" });
    const wrong = await post(p.urlFor(g.id), frame, auth({ [MCP_AUTH_HEADER]: `${LOOPBACK_TOKEN}x` }));
    const blank = await post(p.urlFor(g.id), frame, auth({ [MCP_AUTH_HEADER]: "" }));
    const prefix = await post(p.urlFor(g.id), frame, auth({ [MCP_AUTH_HEADER]: LOOPBACK_TOKEN.slice(0, -1) }));

    expect([absent.status, wrong.status, blank.status, prefix.status]).toEqual([401, 401, 401, 401]);
    const bodies = [await readJson(absent), await readJson(wrong), await readJson(blank), await readJson(prefix)];
    // Identical refusals: which half was wrong is not information this endpoint
    // gives away.
    expect(bodies[1]).toEqual(bodies[0]!);
    expect(bodies[2]).toEqual(bodies[0]!);
    expect(bodies[3]).toEqual(bodies[0]!);
    expect(bodies[0]!.error).toEqual({ code: -32001, message: "unauthorized" });
    expect(up.seen).toHaveLength(0);
    expect(broker.handed).toEqual([]);
  });

  test("an unknown grant id is 404 and contacts nothing", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const broker = stubBroker([granted("access-unknown-grant")]);
    const p = proxy({ broker, grants: stubStore(g) });

    const res = await post(p.urlFor(grantIdFor("https://not-registered.example.test/mcp")), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const body = await readJson(res);

    expect(res.status).toBe(404);
    expect(body.error?.message).toBe("not found");
    expect(up.seen).toHaveLength(0);
    expect(broker.handed).toEqual([]);
  });

  test("a method outside the allowlist is refused with -32601 before a token is minted", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const broker = stubBroker([granted("access-refused-method")]);
    const p = proxy({ broker, grants: stubStore(g) });

    // The obvious one, and the one that is dangerous precisely because it reads
    // like a member of the family.
    for (const method of ["evil/exfiltrate", "tools/callSecret", "resources/readAll", "notifications/"]) {
      const body = await readJson(await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 4, method }));
      expect(body.error?.code).toBe(-32601);
      expect(body.error?.message).toContain(method);
      // Echoed, so the client can correlate the refusal instead of timing out.
      expect(body.id).toBe(4);
    }

    expect(up.seen).toHaveLength(0);
    // Nothing was minted either: the screen sits upstream of the broker, so a
    // refused method does not even cost a token exchange.
    expect(broker.handed).toEqual([]);
  });

  test("a batch is all-or-nothing: one refused member refuses the batch and forwards none of it", async () => {
    const up = upstream(() => Response.json([{ jsonrpc: "2.0", id: 1, result: {} }]));
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-batch")]), grants: stubStore(g) });

    await readJson(
      await post(p.urlFor(g.id), [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "prompts/list" },
      ]),
    );
    expect(up.seen).toHaveLength(1);

    const body = await readJson(
      await post(p.urlFor(g.id), [
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        { jsonrpc: "2.0", id: 4, method: "evil/exfiltrate" },
      ]),
    );

    expect(body.error?.code).toBe(-32601);
    expect(body.id).toBe(4);
    expect(up.seen).toHaveLength(1);
  });

  test("a body that is not JSON is 400, and a frame that is not JSON-RPC 2.0 is -32600", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-malformed")]), grants: stubStore(g) });

    const malformed = await fetch(p.urlFor(g.id), { method: "POST", headers: auth(), body: "{not json" });
    const malformedBody = await readJson(malformed);
    expect(malformed.status).toBe(400);
    expect(malformedBody.error?.code).toBe(-32700);

    const wrongVersion = await readJson(await post(p.urlFor(g.id), { jsonrpc: "1.0", id: 2, method: "tools/list" }));
    expect(wrongVersion.error?.code).toBe(-32600);

    const emptyBatch = await readJson(await post(p.urlFor(g.id), []));
    expect(emptyBatch.error?.code).toBe(-32600);

    expect(up.seen).toHaveLength(0);
  });

  test("only POST, GET and DELETE exist, and only /mcp/<id> is a route at all", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-routes")]), grants: stubStore(g) });

    const put = await drain(await fetch(p.urlFor(g.id), { method: "PUT", headers: auth(), body: "{}" }));
    const patch = await drain(await fetch(p.urlFor(g.id), { method: "PATCH", headers: auth(), body: "{}" }));
    expect([put.status, patch.status]).toEqual([405, 405]);

    for (const path of ["/", "/health", `/mcp/${g.id}/extra`, "/mcp/", "/mcp/../mcp"]) {
      const res = await drain(
        await fetch(`http://127.0.0.1:${p.port}${path}`, { method: "POST", headers: auth(), body: "{}" }),
      );
      expect(res.status).toBe(404);
    }

    // A query string is not a second way to name a destination: same route, and
    // the upstream still comes only from the grant row -- so this is refused for
    // its body, not answered by whatever `to` names.
    const smuggled = await readJson(
      await fetch(`${p.urlFor(g.id)}?to=https%3A%2F%2Fevil.test`, { method: "POST", headers: auth(), body: "{}" }),
    );
    expect(smuggled.error?.code).toBe(-32600);
    expect(up.seen).toHaveLength(0);
  });

  test("the caller's own Authorization, cookie and stray headers do not reach the upstream", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-brokered-only")]), grants: stubStore(g) });

    await readJson(
      await post(
        p.urlFor(g.id),
        { jsonrpc: "2.0", id: 1, method: "ping" },
        auth({
          authorization: "Bearer caller-supplied-secret",
          cookie: "session=caller-cookie",
          "x-tenant-override": "someone-elses-tenant",
        }),
      ),
    );

    const seen = up.seen[0]!;
    expect(seen.headers.authorization).toBe("Bearer access-brokered-only");
    expect(Object.keys(seen.headers)).not.toContain(MCP_AUTH_HEADER.toLowerCase());
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["x-tenant-override"]).toBeUndefined();
    const forwarded = JSON.stringify(seen.headers);
    expect(forwarded).not.toContain("caller-supplied-secret");
    expect(forwarded).not.toContain("caller-cookie");
    expect(forwarded).not.toContain(LOOPBACK_TOKEN);
  });
});

describe("MCP auth proxy: streaming and cancellation", () => {
  test("an SSE response passes through unbuffered: an event reaches the caller before the upstream stops writing", async () => {
    let push: (chunk: string) => void = () => {};
    let finish: () => void = () => {};
    let finished = false;
    const encoder = new TextEncoder();
    const up = upstream(() =>
      sse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // Enqueued synchronously so the response has a first byte to flush
            // its headers with; the rest of the stream is driven by the test.
            controller.enqueue(encoder.encode("event: message\ndata: one\n\n"));
            push = chunk => controller.enqueue(encoder.encode(chunk));
            finish = () => {
              finished = true;
              controller.close();
            };
          },
        }),
      ),
    );
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-sse")]), grants: stubStore(g) });

    const res = await within(
      "the SSE response headers",
      2000,
      fetch(p.urlFor(g.id), {
        method: "GET",
        headers: { [MCP_AUTH_HEADER]: LOOPBACK_TOKEN, accept: "text/event-stream" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await within("the first SSE event", 2000, reader.read());
    const firstText = decoder.decode(first.value);
    wire.push(firstText);
    expect(firstText).toContain("data: one");
    // The upstream has not finished writing. Had the body been read to
    // completion before answering, neither the fetch above nor this read could
    // have resolved yet.
    expect(finished).toBe(false);
    expect(up.seen[0]!.headers.accept).toBe("text/event-stream");

    push("event: message\ndata: two\n\n");
    const second = await within("the second SSE event", 2000, reader.read());
    const secondText = decoder.decode(second.value);
    wire.push(secondText);
    expect(secondText).toContain("data: two");

    finish();
    const end = await within("the stream ending", 2000, reader.read());
    expect(end.done).toBe(true);
  });

  test("a caller abort cancels the upstream request rather than orphaning it", async () => {
    const aborted = Promise.withResolvers<void>();
    let sawAbort = false;
    const up = upstream(req => {
      req.signal.addEventListener("abort", () => {
        sawAbort = true;
        aborted.resolve();
      });
      return sse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": open\n\n"));
          },
        }),
      );
    });
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-cancel")]), grants: stubStore(g) });

    const aborter = new AbortController();
    const res = await within(
      "the SSE response headers",
      2000,
      fetch(p.urlFor(g.id), {
        method: "GET",
        headers: { [MCP_AUTH_HEADER]: LOOPBACK_TOKEN, accept: "text/event-stream" },
        signal: aborter.signal,
      }),
    );
    const reader = res.body!.getReader();
    const opened = await within("the stream opening", 2000, reader.read());
    wire.push(new TextDecoder().decode(opened.value));
    expect(sawAbort).toBe(false);

    aborter.abort();
    // The real event, not a poll: the upstream's own request signal.
    await within("the upstream's request signal firing", 2000, aborted.promise);
    expect(sawAbort).toBe(true);
  });
});

describe("MCP auth proxy: session continuity", () => {
  test("Mcp-Session-Id comes back from initialize and goes back up next request, as do the protocol version and Last-Event-ID", async () => {
    const up = upstream(() =>
      Response.json(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-4f2a" } },
      ),
    );
    const g = grant(up.url);
    const p = proxy({ broker: stubBroker([granted("access-session")]), grants: stubStore(g) });

    const initialize = await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 1, method: "initialize" });
    await readJson(initialize);
    expect(initialize.headers.get("mcp-session-id")).toBe("sess-4f2a");

    await readJson(
      await post(
        p.urlFor(g.id),
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
        auth({
          "mcp-session-id": "sess-4f2a",
          "mcp-protocol-version": "2025-06-18",
          "last-event-id": "42",
        }),
      ),
    );

    const seen = up.seen[1]!;
    expect(seen.headers["mcp-session-id"]).toBe("sess-4f2a");
    expect(seen.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(seen.headers["last-event-id"]).toBe("42");
  });
});

describe("MCP auth proxy: a 401 from the far end", () => {
  test("an upstream 401 costs exactly one invalidate and one replay, and the replay's result is what the caller gets", async () => {
    const up = upstream((_req, seen) =>
      seen.headers.authorization === "Bearer stale-access"
        ? new Response("token expired", { status: 401 })
        : Response.json({ jsonrpc: "2.0", id: 9, result: { tools: [] } }),
    );
    const g = grant(up.url);
    const broker = stubBroker([granted("stale-access"), granted("fresh-access")]);
    const p = proxy({ broker, grants: stubStore(g) });

    const res = await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 9, method: "tools/list" });
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.result).toEqual({ tools: [] });
    expect(broker.invalidated).toEqual([g.id]);
    expect(up.seen.map(s => s.headers.authorization)).toEqual(["Bearer stale-access", "Bearer fresh-access"]);
    // The buffered frame was resent, not lost.
    expect(up.seen.map(s => JSON.parse(s.body).method)).toEqual(["tools/list", "tools/list"]);
  });

  test("a second consecutive 401 is surfaced to the caller, with its challenge, and there is no third attempt", async () => {
    const challenge = 'Bearer resource_metadata="https://auth.example.test/.well-known/oauth-protected-resource"';
    const up = upstream(() => new Response("still no", { status: 401, headers: { "www-authenticate": challenge } }));
    const g = grant(up.url);
    const broker = stubBroker([granted("first-access"), granted("second-access"), granted("third-access")]);
    const p = proxy({ broker, grants: stubStore(g) });

    const res = await drain(await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 9, method: "tools/list" }));

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(challenge);
    expect(up.seen).toHaveLength(2);
    expect(broker.invalidated).toEqual([g.id]);
    expect(broker.handed).toEqual(["first-access", "second-access"]);
  });

  test("an upstream 403 is treated the same way, since a stale token is refused as either", async () => {
    const up = upstream((_req, seen) =>
      seen.headers.authorization === "Bearer stale-403"
        ? new Response("forbidden", { status: 403 })
        : Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    const g = grant(up.url);
    const broker = stubBroker([granted("stale-403"), granted("fresh-403")]);
    const p = proxy({ broker, grants: stubStore(g) });

    const body = await readJson(await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(body.result).toEqual({ ok: true });
    expect(broker.invalidated).toEqual([g.id]);
    expect(up.seen).toHaveLength(2);
  });

  test("a grant that refused a re-minted token is left alone until the cooldown passes", async () => {
    const up = upstream(() => new Response("no", { status: 401 }));
    const g = grant(up.url);
    const broker = stubBroker([granted("cool-1"), granted("cool-2"), granted("cool-3"), granted("cool-4")]);
    let now = 1_700_000_000_000;
    const p = proxy({ broker, grants: stubStore(g), clock: { now: () => now } });
    const frame = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    // One attempt, one re-mint, one replay. The replay was refused too, so the
    // grant is now cooling.
    await drain(await post(p.urlFor(g.id), frame));
    expect(up.seen).toHaveLength(2);
    expect(broker.invalidated).toHaveLength(1);

    // Inside the window a revoked grant costs one upstream call, not two. This
    // is the bound a per-request one cannot provide, because the loop it stops
    // lives across requests.
    await drain(await post(p.urlFor(g.id), frame));
    expect(up.seen).toHaveLength(3);
    expect(broker.invalidated).toHaveLength(1);

    now += 30_001;
    await drain(await post(p.urlFor(g.id), frame));
    expect(up.seen).toHaveLength(5);
    expect(broker.invalidated).toHaveLength(2);
  });

  test("a grant that starts working again stops cooling, on a clock that never moved", async () => {
    let refuse = true;
    const up = upstream(() =>
      refuse ? new Response("no", { status: 401 }) : Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    const g = grant(up.url);
    const broker = stubBroker([granted("warm-1"), granted("warm-2"), granted("warm-3"), granted("warm-4")]);
    const now = 1_700_000_000_000;
    const p = proxy({ broker, grants: stubStore(g), clock: { now: () => now } });
    const frame = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    await drain(await post(p.urlFor(g.id), frame));
    expect(up.seen).toHaveLength(2);

    refuse = false;
    await readJson(await post(p.urlFor(g.id), frame));
    expect(up.seen).toHaveLength(3);

    // Cleared by the success rather than by time passing: recovery is the
    // observation, not the clock.
    refuse = true;
    await drain(await post(p.urlFor(g.id), frame));
    expect(up.seen).toHaveLength(5);
  });
});

describe("MCP auth proxy: when the broker cannot mint", () => {
  test("each unservable state becomes a 503 naming that state, the reason and the remedy, and contacts nothing", async () => {
    const up = upstream(() => Response.json({ jsonrpc: "2.0", id: 1, result: {} }));
    const g = grant(up.url, "notes");
    const states: McpAuthState[] = ["reauth_required", "no_refresh_grant", "degraded"];

    for (const state of states) {
      const broker = stubBroker([{ ok: false, state, detail: "invalid_grant: session revoked" }]);
      const p = proxy({ broker, grants: stubStore(g) });
      const res = await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 5, method: "tools/list" });
      const body = await readJson(res);

      expect(res.status).toBe(503);
      expect(body.id).toBe(5);
      expect(body.error?.message).toContain(state);
      expect(body.error?.message).toContain("invalid_grant: session revoked");
      expect(body.error?.message).toContain(`ompd mcp-auth login '${g.resourceUrl}'`);
    }

    expect(up.seen).toHaveLength(0);
  });

  test("the copy-paste reauth command keeps hostile resource text inside one POSIX argument", async () => {
    const up = upstream(() => Response.json({}));
    const g = grant(`${up.url}?query=$(id)'`, "hostile");
    const p = proxy({
      broker: stubBroker([{ ok: false, state: "reauth_required", detail: "authorization expired" }]),
      grants: stubStore(g),
    });

    const body = await readJson(await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 9, method: "tools/list" }));
    expect(body.error?.message).toContain(`ompd mcp-auth login '${up.url}?query=$(id)'"'"''`);
  });

  test("a broker that cannot re-mint after a 401 answers 503 rather than replaying the token that just failed", async () => {
    const up = upstream(() => new Response("no", { status: 401 }));
    const g = grant(up.url, "tickets");
    const broker = stubBroker([
      granted("about-to-be-revoked"),
      { ok: false, state: "reauth_required", detail: "invalid_grant: refresh token reuse detected" },
    ]);
    const p = proxy({ broker, grants: stubStore(g) });

    const res = await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 6, method: "tools/list" });
    const body = await readJson(res);

    expect(res.status).toBe(503);
    expect(body.error?.message).toContain("reauth_required");
    expect(body.error?.message).toContain(`ompd mcp-auth login '${g.resourceUrl}'`);
    expect(up.seen).toHaveLength(1);
  });

  test("an unreachable upstream is a 502 that names the server and carries nothing from it", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const deadUrl = `http://127.0.0.1:${closed.port}/mcp`;
    closed.stop(true);

    const g = grant(deadUrl, "routers");
    const p = proxy({ broker: stubBroker([granted("access-unreachable")]), grants: stubStore(g) });

    const res = await post(p.urlFor(g.id), { jsonrpc: "2.0", id: 8, method: "tools/list" });
    const body = await readJson(res);

    expect(res.status).toBe(502);
    expect(body.id).toBe(8);
    expect(body.error?.message).toBe("upstream request to routers failed");
  });
});

describe("MCP auth proxy: construction", () => {
  test("a non-loopback bind is refused rather than bound", () => {
    const g = grant("http://127.0.0.1:1/mcp");
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "localhost"]) {
      expect(() =>
        startMcpAuthProxy({
          broker: stubBroker([granted("access-never-bound")]),
          grants: stubStore(g),
          tokenHash: TOKEN_HASH,
          host,
        }),
      ).toThrow(/loopback only/);
    }
  });

  test("a token hash that is not a sha256 digest fails at construction, not as a 401 on every request", () => {
    const g = grant("http://127.0.0.1:1/mcp");
    for (const bad of ["", LOOPBACK_TOKEN, `${TOKEN_HASH}00`, TOKEN_HASH.slice(0, 63)]) {
      expect(() =>
        startMcpAuthProxy({
          broker: stubBroker([granted("access-never-bound")]),
          grants: stubStore(g),
          tokenHash: bad,
        }),
      ).toThrow(/sha256 hex digest/);
    }
  });

  test("urlFor is the loopback URL an MCP config entry points at", () => {
    const g = grant("http://127.0.0.1:1/mcp");
    const p = proxy({ broker: stubBroker([granted("access-urlfor")]), grants: stubStore(g) });
    expect(p.urlFor(g.id)).toBe(`http://127.0.0.1:${p.port}/mcp/${g.id}`);
    expect(p.port).toBeGreaterThan(0);
  });
});

describe("MCP auth proxy: the access token stays inside the daemon", () => {
  test("no body a caller read and no line the proxy logged carries the access token, across every path that has one", async () => {
    const secret = "access-token-that-must-not-appear-anywhere";
    const up = upstream((_req, seen) =>
      seen.headers.authorization === `Bearer ${secret}`
        ? new Response("expired", { status: 401 })
        : Response.json({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    );
    const g = grant(up.url, "clerk");
    const broker = stubBroker([granted(secret), granted("second-secret-token"), granted("third-secret-token")]);
    const p = proxy({ broker, grants: stubStore(g) });
    const url = p.urlFor(g.id);

    // Success after a re-mint, a refused method, an unauthorized call, an
    // unknown grant, and a broker that gives up: every path in this file that
    // has ever held a token.
    await readJson(await post(url, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    await readJson(await post(url, { jsonrpc: "2.0", id: 2, method: "evil/exfiltrate" }));
    await readJson(await post(url, { jsonrpc: "2.0", id: 3, method: "ping" }, { "content-type": "application/json" }));
    const absent = grantIdFor("https://absent.example.test/mcp");
    await readJson(await post(p.urlFor(absent), { jsonrpc: "2.0", id: 4, method: "ping" }));

    const givesUp = proxy({
      broker: stubBroker([{ ok: false, state: "degraded", detail: "network unreachable" }]),
      grants: stubStore(g),
    });
    await readJson(await post(givesUp.urlFor(g.id), { jsonrpc: "2.0", id: 5, method: "ping" }));

    // Not vacuous: there is something to search, and a secret to search for.
    expect(logs.length).toBeGreaterThan(0);
    expect(wire.length).toBeGreaterThan(4);
    expect(minted.has(secret)).toBe(true);

    // Bytes, not a redaction helper's own account of itself.
    const emitted = [...logs, ...wire].join("\n");
    for (const value of minted) expect(emitted).not.toContain(value);
    // The loopback credential is not disclosed either, in any direction.
    expect(emitted).not.toContain(LOOPBACK_TOKEN);
    // The upstream did see it, which is what makes the absence above a real
    // absence rather than a token nothing ever held.
    expect(up.seen[0]!.headers.authorization).toBe(`Bearer ${secret}`);
  });
});
