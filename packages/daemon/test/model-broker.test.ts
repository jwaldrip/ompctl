/**
 * The model broker is the only thing between a container agent and the provider
 * credential this host holds, so these tests are written from the guest's side
 * of the wire: a real socket, a real listener, and a fake auth-gateway standing
 * in for the loopback omp children.
 *
 * Four properties carry most of the weight, and each one is a door that closes
 * quietly when it breaks.
 *
 * The allowlist is an allowlist. Two exact strings, POST only. A prefix test, a
 * passthrough, or a trailing slash slipping through would expose whatever
 * omp's gateway grows next, including `GET /v1/models`, which enumerates every
 * provider this host holds a credential for. So the refusals are asserted as
 * hard 404s rather than as "not a 200".
 *
 * A malformed peer range must throw at mint time, not degrade into a skip. The
 * skip is reachable only from an explicit `null`, because `null` is a decision
 * somebody spelled out and a range that does not parse is an accident. The test
 * for that is the one place here where a passing assertion and an open door are
 * one edit apart, so it asserts the thrown message names the null escape hatch
 * rather than merely that something threw.
 *
 * Nothing this broker logs may contain a credential or a byte of a body. That
 * is asserted globally rather than per refusal: every path is exercised and
 * then every captured line is searched for every minted token, the upstream
 * bearer, and a canary planted in a request body. A new refusal that quotes the
 * wrong thing fails here without anyone remembering to add a case.
 *
 * The refusal drain is pinned over a raw TCP connection rather than through
 * `fetch`, and that is not ceremony. Measured on Bun 1.3.14, a handler that
 * answers a request whose body it never consumed desyncs the keep-alive
 * connection and hangs the NEXT request on it. `fetch` decides on its own
 * whether to reuse a connection, so a `fetch`-based test would pass whether or
 * not the drain is there. The raw client below sends both requests down one
 * socket it owns, so removing `await drainBody(req)` from `#deny` fails this
 * file as a timeout instead of passing it by luck.
 *
 * Nothing here sleeps on a duration hoping something happened. Every wait is on
 * a real signal -- a gate the fake gateway opens when a request reaches it, a
 * chunk arriving on a stream -- with a deadline attached so a regression fails
 * with the name of what never came rather than hanging the suite.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { ModelBroker, type ModelGrant, type ModelGrantLimits } from "../src/model-broker/broker.ts";

/** The one model every grant here allowlists, unless a test says otherwise. */
const MODEL = "claude-broker-test-model";

/** What the fake auth-gateway expects to be presented, and what no log may name. */
const UPSTREAM_BEARER = "upstream-bearer-value";

/**
 * Deadline for a signal that is already on its way. It never elapses on a
 * passing run and adds nothing to one; it exists so a missing chunk, response,
 * or connection fails with the name of what was expected.
 */
const DEADLINE_MS = 10_000;

const DEFAULT_LIMITS: ModelGrantLimits = { maxRequests: 16, maxTokens: 100_000, maxConcurrent: 4 };

const DEFAULT_TTL_MS = 600_000;

/** Retries kept short: loopback either binds now or the port is genuinely taken. */
const LISTEN = { attempts: 4, delayMs: 25 } as const;

/**
 * Comfortably past a single TCP segment and past any plausible socket buffer,
 * so the refusal is answered while bytes are still arriving. That is the shape
 * that desyncs the connection when the body is not drained.
 */
const LARGE_BODY_BYTES = 4 * 1024 * 1024;

/** `MAX_REQUEST_BODY_BYTES` in the broker, which is not exported, plus a nudge. */
const OVER_CAP_BODY_BYTES = 32 * 1024 * 1024 + 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open: () => void = () => {};
  const promise = new Promise<void>(resolve => {
    open = () => {
      resolve();
    };
  });
  return { promise, open };
}

async function withDeadline<T>(work: Promise<T>, label: string, ms = DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The message a synchronous throw carried, or "" when it did not throw. */
function thrownMessage(work: () => unknown): string {
  try {
    work();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "";
}

/**
 * Distinct ports nothing is listening on.
 *
 * Every probe is opened before any is closed, so the kernel is holding all of
 * them at once and cannot hand the same one out twice. A single probe reused in
 * a loop would.
 */
async function freePorts(count: number): Promise<number[]> {
  const probes: Server<never>[] = [];
  for (let i = 0; i < count; i += 1) {
    probes.push(Bun.serve<never, {}>({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) }));
  }
  const ports = probes.map(probe => probe.port);
  await Promise.all(probes.map(probe => probe.stop(true)));
  return ports;
}

async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  if (port === undefined) throw new Error("could not reserve a port");
  return port;
}

// ---------------------------------------------------------------------------
// A raw HTTP/1.1 client, so "the same connection" is a fact and not a hope
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

interface RawConnection {
  send(payload: string | Uint8Array): void;
  /** The next complete response on this connection, or a named timeout. */
  next(label: string, ms?: number): Promise<RawResponse>;
  close(): void;
}

interface ParsedResponse {
  response: RawResponse;
  consumed: number;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function indexOfSequence(haystack: Uint8Array, needle: number[], from: number): number {
  const last = haystack.byteLength - needle.length;
  for (let at = from; at <= last; at += 1) {
    let hit = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (haystack[at + i] !== needle[i]) {
        hit = false;
        break;
      }
    }
    if (hit) return at;
  }
  return -1;
}

const CRLF = [0x0d, 0x0a];
const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a];

/**
 * One response off the front of `buf`, or null while it is still arriving.
 *
 * Handles exactly the two framings Bun emits: `content-length` for the fixed
 * bodies every refusal produces, and `chunked` for the streamed forward of a
 * gateway reply. Trailers are not parsed because Bun sends none, and a test
 * harness that pretended otherwise would be untested code guarding a boundary
 * nothing crosses.
 */
function parseResponse(buf: Uint8Array): ParsedResponse | null {
  const headEnd = indexOfSequence(buf, CRLF_CRLF, 0);
  if (headEnd < 0) return null;
  const lines = decoder.decode(buf.subarray(0, headEnd)).split("\r\n");
  const status = Number((lines[0] ?? "").split(" ")[1] ?? "0");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const bodyStart = headEnd + CRLF_CRLF.length;

  const declared = headers.get("content-length");
  if (declared !== undefined) {
    const length = Number(declared);
    if (buf.byteLength < bodyStart + length) return null;
    const body = decoder.decode(buf.subarray(bodyStart, bodyStart + length));
    return { response: { status, headers, body }, consumed: bodyStart + length };
  }

  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    let cursor = bodyStart;
    let body = new Uint8Array(0);
    for (;;) {
      const eol = indexOfSequence(buf, CRLF, cursor);
      if (eol < 0) return null;
      const size = Number.parseInt(decoder.decode(buf.subarray(cursor, eol)).split(";")[0] ?? "", 16);
      if (!Number.isFinite(size)) return null;
      const dataStart = eol + CRLF.length;
      if (size === 0) {
        const end = dataStart + CRLF.length;
        if (buf.byteLength < end) return null;
        return { response: { status, headers, body: decoder.decode(body) }, consumed: end };
      }
      const dataEnd = dataStart + size;
      if (buf.byteLength < dataEnd + CRLF.length) return null;
      body = concat(body, buf.subarray(dataStart, dataEnd));
      cursor = dataEnd + CRLF.length;
    }
  }

  return { response: { status, headers, body: "" }, consumed: bodyStart };
}

async function rawConnect(host: string, port: number): Promise<RawConnection> {
  let inbox = new Uint8Array(0);
  let waiting: (() => void) | null = null;
  let failure: Error | null = null;
  const outbox: Uint8Array[] = [];

  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_socket, data) {
        // Copied: Bun may reuse the backing buffer for the next read.
        inbox = concat(inbox, new Uint8Array(data));
        waiting?.();
      },
      drain(open) {
        pump(open);
      },
      error(_socket, err) {
        failure = err instanceof Error ? err : new Error(String(err));
        waiting?.();
      },
      close() {
        failure ??= new Error("the peer closed the connection before a complete response arrived");
        waiting?.();
      },
    },
  });

  /**
   * Write what fits. A partial write means the kernel buffer is full, so the
   * remainder waits for `drain` rather than spinning; a 33 MiB body over
   * loopback hits that on every run.
   */
  function pump(open: { write(data: Uint8Array): number }): void {
    while (outbox.length > 0) {
      const head = outbox[0];
      if (head === undefined) break;
      const wrote = open.write(head);
      if (wrote >= head.byteLength) {
        outbox.shift();
        continue;
      }
      outbox[0] = head.subarray(wrote);
      return;
    }
  }

  return {
    send(payload) {
      outbox.push(typeof payload === "string" ? encoder.encode(payload) : payload);
      pump(socket);
    },
    next(label, ms = DEADLINE_MS) {
      return new Promise<RawResponse>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = () => {
          waiting = null;
          if (timer !== undefined) clearTimeout(timer);
        };
        const attempt = () => {
          if (failure !== null) {
            const err = failure;
            settle();
            reject(err);
            return;
          }
          const parsed = parseResponse(inbox);
          if (parsed === null) return;
          inbox = inbox.slice(parsed.consumed);
          settle();
          resolve(parsed.response);
        };
        timer = setTimeout(() => {
          settle();
          reject(new Error(`timed out after ${ms}ms waiting for ${label}`));
        }, ms);
        waiting = attempt;
        attempt();
      });
    },
    close() {
      socket.end();
    },
  };
}

function requestHead(input: {
  method?: string;
  path: string;
  host: string;
  contentLength: number;
  token?: string;
}): string {
  const lines = [
    `${input.method ?? "POST"} ${input.path} HTTP/1.1`,
    `Host: ${input.host}`,
    "Content-Type: application/json",
    `Content-Length: ${input.contentLength}`,
  ];
  if (input.token !== undefined) lines.push(`Authorization: Bearer ${input.token}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

// ---------------------------------------------------------------------------
// Per-test state
// ---------------------------------------------------------------------------

let logs: string[];
let nowMs: number;
let upstream: Server<never>;
let upstreamBase: string;
let liveUpstreamBase: string;
let upstreamSeen: UpstreamCall[];
let upstreamReply: (req: Request, body: string) => Response | Promise<Response>;
let broker: ModelBroker;
let brokerHost: string;
let brokerBase: string;
let minted: string[];

const brokers: ModelBroker[] = [];
const servers: Server<never>[] = [];
const connections: RawConnection[] = [];

/** A broker wired to the fake gateway, registered for teardown, not yet listening. */
function makeBroker(sink: string[] = logs): ModelBroker {
  const made = new ModelBroker({
    upstreamUrl: () => upstreamBase,
    upstreamBearer: async () => UPSTREAM_BEARER,
    onLog: line => {
      sink.push(line);
    },
    now: () => nowMs,
  });
  brokers.push(made);
  return made;
}

function issueGrant(
  over: Partial<{ model: string; peerCidr: string | null; limits: ModelGrantLimits; ttlMs: number }> = {},
): ModelGrant {
  const granted = broker.issue({
    model: MODEL,
    peerCidr: "127.0.0.0/8",
    limits: DEFAULT_LIMITS,
    ttlMs: DEFAULT_TTL_MS,
    ...over,
  });
  minted.push(granted.token);
  return granted;
}

interface CallOptions {
  method?: string;
  token?: string;
  /** A string is sent verbatim; anything else is JSON-encoded. */
  body?: unknown;
}

function request(path: string, opts: CallOptions = {}): Promise<Response> {
  const method = opts.method ?? "POST";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  const raw = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? { model: MODEL });
  return fetch(`${brokerBase}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : raw,
    signal: AbortSignal.timeout(DEADLINE_MS),
  });
}

interface Answer {
  status: number;
  text: string;
}

/** A call whose body is read to completion, which is what drives the meter's flush. */
async function post(path: string, opts: CallOptions = {}): Promise<Answer> {
  const res = await request(path, opts);
  return { status: res.status, text: await res.text() };
}

function refusals(): string[] {
  return logs.filter(line => line.includes("refused:"));
}

beforeEach(async () => {
  logs = [];
  minted = [];
  upstreamSeen = [];
  nowMs = Date.UTC(2026, 7, 25, 12, 0, 0);
  upstreamReply = () => Response.json({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } });

  upstream = Bun.serve<never, {}>({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const body = await req.text();
      upstreamSeen.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("authorization"),
        body,
      });
      return await upstreamReply(req, body);
    },
  });
  servers.push(upstream);
  liveUpstreamBase = `http://127.0.0.1:${upstream.port}`;
  upstreamBase = liveUpstreamBase;

  brokerHost = "127.0.0.1";
  broker = makeBroker();
  const port = await freePort();
  await broker.listen({ host: brokerHost, port, ...LISTEN });
  brokerBase = `http://${brokerHost}:${port}`;
});

afterEach(async () => {
  for (const connection of connections) connection.close();
  connections.length = 0;
  await Promise.all(brokers.map(each => each.close()));
  brokers.length = 0;
  await Promise.all(servers.map(each => each.stop(true)));
  servers.length = 0;
});

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

describe("route allowlist", () => {
  test("forwards the two allowlisted POST routes and 404s everything else", async () => {
    const granted = issueGrant();
    expect(granted.endpoint).toBe(brokerBase);

    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
    expect((await post("/v1/messages/count_tokens", { token: granted.token })).status).toBe(200);
    expect(upstreamSeen.map(call => new URL(call.url).pathname)).toEqual([
      "/v1/messages",
      "/v1/messages/count_tokens",
    ]);
    // The guest's bearer stops at the broker. What reaches the gateway is the
    // gateway's own, which the guest has never held.
    expect(upstreamSeen.every(call => call.authorization === `Bearer ${UPSTREAM_BEARER}`)).toBe(true);

    const refused: [string, CallOptions][] = [
      ["/v1/messages", { token: granted.token, method: "GET" }],
      ["/v1/models", { token: granted.token }],
      ["/", { token: granted.token }],
      ["/v1/messages/", { token: granted.token }],
    ];
    for (const [path, opts] of refused) {
      const answer = await post(path, opts);
      expect({ path, status: answer.status }).toEqual({ path, status: 404 });
      expect(JSON.parse(answer.text)).toEqual({ error: "not_found" });
    }

    // Only two calls ever reached the gateway: a refusal is not a forward.
    expect(upstreamSeen).toHaveLength(2);

    for (const named of [
      "GET /v1/messages is not an allowlisted route",
      "POST /v1/models is not an allowlisted route",
      "POST / is not an allowlisted route",
      "POST /v1/messages/ is not an allowlisted route",
    ]) {
      expect(logs.some(line => line.includes(named))).toBe(true);
    }
  });

  test("discards a query string rather than forwarding it to the gateway", async () => {
    const granted = issueGrant();

    const answer = await post("/v1/messages?x=1&beta=true", { token: granted.token });
    expect(answer.status).toBe(200);

    const seen = upstreamSeen.at(-1);
    expect(seen).toBeDefined();
    const forwarded = new URL(seen?.url ?? "");
    expect(forwarded.pathname).toBe("/v1/messages");
    expect(forwarded.search).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Who may present a grant
// ---------------------------------------------------------------------------

describe("bearer authentication", () => {
  test("refuses a request carrying no bearer", async () => {
    issueGrant();
    const answer = await post("/v1/messages");
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.text)).toEqual({ error: "unauthorized" });
    expect(logs.some(line => line.includes("carried no bearer credential"))).toBe(true);
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a bearer no live grant matches", async () => {
    issueGrant();
    const answer = await post("/v1/messages", { token: "not-a-token-anyone-minted" });
    expect(answer.status).toBe(401);
    expect(logs.some(line => line.includes("presented a credential no live grant matches"))).toBe(true);
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a revoked token", async () => {
    const granted = issueGrant();
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);

    broker.revoke(granted.token);
    expect(broker.liveGrants()).toBe(0);

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(401);
    expect(logs.some(line => line.includes("presented a credential no live grant matches"))).toBe(true);
    expect(upstreamSeen).toHaveLength(1);
  });

  test("refuses an expired grant and drops it", async () => {
    const enduring = issueGrant({ ttlMs: 600_000 });
    const doomed = issueGrant({ ttlMs: 1_000 });
    expect(broker.liveGrants()).toBe(2);

    nowMs += 5_000;

    const answer = await post("/v1/messages", { token: doomed.token });
    expect(answer.status).toBe(401);
    expect(logs.some(line => line.includes(`presented an expired grant for ${MODEL}`))).toBe(true);
    // Dropped, not merely refused: the walk every request pays for is shorter.
    expect(broker.liveGrants()).toBe(1);

    expect((await post("/v1/messages", { token: enduring.token })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Which peer may present it
// ---------------------------------------------------------------------------

describe("peer range", () => {
  test("admits a peer inside the granted range", async () => {
    const granted = issueGrant({ peerCidr: "127.0.0.0/8" });
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
  });

  test("refuses a peer outside the granted range", async () => {
    const granted = issueGrant({ peerCidr: "10.0.0.0/8" });

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.text)).toEqual({ error: "forbidden" });
    expect(logs.some(line => line.includes("arrived from 127.0.0.1, outside the granted range 10.0.0.0/8"))).toBe(true);
    expect(upstreamSeen).toHaveLength(0);
  });

  test("skips the check only for a grant minted with an explicit null range", async () => {
    const granted = issueGrant({ peerCidr: null });
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
    // Turning the check off is a real widening, so it is named in the audit
    // rather than left to be inferred from an absent range.
    expect(logs.some(line => line.includes("any peer, peer check off for this grant"))).toBe(true);
  });

  test("refuses to mint a grant whose range does not parse, rather than skipping the check", async () => {
    for (const malformed of ["not-a-cidr", "192.168.1.0/33", "192.168.1.0", ""]) {
      const message = thrownMessage(() =>
        broker.issue({ model: MODEL, peerCidr: malformed, limits: DEFAULT_LIMITS, ttlMs: DEFAULT_TTL_MS }),
      );
      expect({ malformed, threw: message !== "" }).toEqual({ malformed, threw: true });
      expect(message).toContain(JSON.stringify(malformed));
      expect(message).toContain("it is not an IPv4 CIDR");
      // The security property in one sentence: the skip has exactly one door,
      // and a range that failed to parse is not it.
      expect(message).toContain("Pass null if the peer check is meant to be off");
      expect(message).toContain("a range that does not parse is never read as a skip");
    }
    // Nothing was minted along the way, so no half-checked grant is presentable.
    expect(broker.liveGrants()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Which model it may ask for
// ---------------------------------------------------------------------------

describe("model allowlist", () => {
  test("refuses another model without naming it in the log", async () => {
    const granted = issueGrant();
    const shadow = "shadow-model-4f21a9";

    const answer = await post("/v1/messages", { token: granted.token, body: { model: shadow } });
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.text)).toEqual({ error: "forbidden" });
    expect(logs.some(line => line.includes(`asked for a model other than the granted ${MODEL}`))).toBe(true);
    // The requested model is body content, and body content does not reach a log.
    expect(logs.some(line => line.includes(shadow))).toBe(false);
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a body that is not JSON", async () => {
    const granted = issueGrant();
    const answer = await post("/v1/messages", { token: granted.token, body: "{not json at all" });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text)).toEqual({ error: "bad_request" });
    expect(logs.some(line => line.includes("body is not JSON"))).toBe(true);
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a body that names no model", async () => {
    const granted = issueGrant();
    for (const body of ['{"messages":[]}', '{"model":42}', "[]", '"a string"']) {
      const answer = await post("/v1/messages", { token: granted.token, body });
      expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    }
    expect(logs.some(line => line.includes("body names no model"))).toBe(true);
    expect(upstreamSeen).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The ceilings
// ---------------------------------------------------------------------------

describe("ceilings", () => {
  test("refuses past the request ceiling", async () => {
    const granted = issueGrant({ limits: { maxRequests: 2, maxTokens: 100_000, maxConcurrent: 2 } });

    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(402);
    expect(JSON.parse(answer.text)).toEqual({ error: "quota_exhausted" });
    expect(logs.some(line => line.includes("exhausted the 2-request ceiling"))).toBe(true);
    expect(upstreamSeen).toHaveLength(2);
  });

  test("refuses past the token ceiling, counting a non-streaming usage block", async () => {
    upstreamReply = () => Response.json({ content: [], usage: { input_tokens: 7, output_tokens: 5 } });
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 10, maxConcurrent: 2 } });

    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(402);
    // The counted figure is in the refusal, which is the only place this
    // accounting is observable, so it pins the arithmetic and not just the door.
    expect(logs.some(line => line.includes("exhausted the 10-token ceiling (12 counted)"))).toBe(true);
  });

  test("refuses past the concurrency ceiling and hands the slot back afterwards", async () => {
    const reached = gate();
    const release = gate();
    upstreamReply = async () => {
      reached.open();
      await release.promise;
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 100_000, maxConcurrent: 1 } });

    const held = request("/v1/messages", { token: granted.token });
    await withDeadline(reached.promise, "the first request to reach the fake gateway");

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(429);
    expect(JSON.parse(answer.text)).toEqual({ error: "too_many_requests" });
    expect(logs.some(line => line.includes("exceeds the 1-request concurrency ceiling"))).toBe(true);

    release.open();
    const first = await withDeadline(held, "the held request to complete");
    expect(first.status).toBe(200);
    await first.text();

    // A refusal at the concurrency door spends no request slot, so this is the
    // second forward and not the third.
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
    expect(upstreamSeen).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Metering, and the stream it must not hold up
// ---------------------------------------------------------------------------

const SSE_HEAD =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n';
const SSE_TAIL = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\ndata: [DONE]\n\n';

describe("usage metering", () => {
  test("counts message_start and message_delta off an SSE body", async () => {
    upstreamReply = () =>
      new Response(SSE_HEAD + SSE_TAIL, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 10, maxConcurrent: 2 } });

    const streamed = await post("/v1/messages", { token: granted.token });
    expect(streamed.status).toBe(200);
    expect(streamed.text).toBe(SSE_HEAD + SSE_TAIL);

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(402);
    expect(logs.some(line => line.includes("exhausted the 10-token ceiling (13 counted)"))).toBe(true);
  });

  test("streams SSE through unchanged and incrementally, not buffered to the end", async () => {
    const release = gate();
    upstreamReply = () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(SSE_HEAD));
          void release.promise.then(() => {
            controller.enqueue(encoder.encode(SSE_TAIL));
            controller.close();
          });
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    };
    const granted = issueGrant();

    const res = await request("/v1/messages", { token: granted.token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const body = res.body;
    expect(body).not.toBeNull();
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const received: Uint8Array[] = [];
    let seen = 0;

    // The tail does not exist yet and cannot until this test releases it, so a
    // broker that buffered the response to the end would deadlock here and fail
    // as a named timeout rather than as a wrong assertion.
    while (seen < SSE_HEAD.length) {
      const step = await withDeadline(reader.read(), "the first SSE chunk to arrive before the stream ended");
      if (step.done) break;
      if (step.value === undefined) continue;
      received.push(step.value);
      seen += step.value.byteLength;
    }
    expect(decoder.decode(concat(new Uint8Array(0), joinAll(received)))).toBe(SSE_HEAD);

    release.open();
    for (;;) {
      const step = await withDeadline(reader.read(), "the rest of the SSE stream");
      if (step.done) break;
      if (step.value !== undefined) received.push(step.value);
    }

    // Byte for byte: the meter reads the bytes on their way past and rewrites
    // none of them.
    expect(joinAll(received)).toEqual(encoder.encode(SSE_HEAD + SSE_TAIL));
  });
});

function joinAll(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The slot comes back on every exit
// ---------------------------------------------------------------------------

describe("concurrency slot", () => {
  test("hands the slot back when the forward to the gateway fails", async () => {
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 100_000, maxConcurrent: 1 } });
    const dead = await freePort();

    upstreamBase = `http://127.0.0.1:${dead}`;
    const failed = await post("/v1/messages", { token: granted.token });
    expect(failed.status).toBe(502);
    expect(JSON.parse(failed.text)).toEqual({ error: "bad_gateway" });
    expect(logs.some(line => line.includes("forwarding /v1/messages to the auth gateway failed"))).toBe(true);

    upstreamBase = liveUpstreamBase;
    // 429 here would mean the failed forward kept its slot for the life of the
    // container, which is the wedge the handler's `finally` exists to prevent.
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
  });

  test("hands the slot back for a gateway reply that carries no body of its own", async () => {
    // 204 rather than a literal null body: measured on Bun 1.3.14, `fetch`
    // never yields `response.body === null` for any status, including the
    // null-body statuses the Fetch standard names, so the handler's explicit
    // null-body branch is unreachable from a real upstream on this runtime. The
    // observable it protects is reachable, and this is it.
    upstreamReply = () => new Response(null, { status: 204 });
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 100_000, maxConcurrent: 1 } });

    const empty = await post("/v1/messages", { token: granted.token });
    expect(empty.status).toBe(204);
    expect(empty.text).toBe("");

    upstreamReply = () => Response.json({ ok: true });
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Binding, and the window `issue` has to survive
// ---------------------------------------------------------------------------

describe("listen and issue ordering", () => {
  test("refuses to issue before there is an address to name", () => {
    const unbound = makeBroker();
    const message = thrownMessage(() =>
      unbound.issue({ model: MODEL, peerCidr: null, limits: DEFAULT_LIMITS, ttlMs: DEFAULT_TTL_MS }),
    );
    expect(message).toContain("model broker has no address");
    expect(message).toContain("call `listen` before `issue`");
  });

  test("refuses every spelling of a wildcard host", async () => {
    const refuser = makeBroker();
    const port = await freePort();
    for (const host of ["0.0.0.0", "::", "*", "", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"]) {
      await expect(refuser.listen({ host, port, ...LISTEN })).rejects.toThrow(
        `model broker refuses to bind the wildcard host ${JSON.stringify(host)}`,
      );
    }
    // Refused before anything was recorded, so the broker never became bindable
    // by a wildcard it already accepted.
    expect(
      thrownMessage(() => refuser.issue({ model: MODEL, peerCidr: null, limits: DEFAULT_LIMITS, ttlMs: 1_000 })),
    ).toContain("model broker has no address");
  });

  test("refuses a second address once it is committed to one", async () => {
    const committed = makeBroker();
    const [first, second] = await freePorts(2);
    if (first === undefined || second === undefined) throw new Error("could not reserve two ports");

    await committed.listen({ host: "127.0.0.1", port: first, ...LISTEN });
    await expect(committed.listen({ host: "127.0.0.1", port: second, ...LISTEN })).rejects.toThrow(
      `model broker is already committed to 127.0.0.1:${first} and cannot also serve 127.0.0.1:${second}`,
    );
    await expect(committed.listen({ host: "127.0.0.2", port: first, ...LISTEN })).rejects.toThrow(
      "already committed",
    );
  });

  test("joins an in-flight bind for the same address instead of starting a second one", async () => {
    const sink: string[] = [];
    const joiner = makeBroker(sink);
    const port = await freePort();

    const first = joiner.listen({ host: "127.0.0.1", port, ...LISTEN });
    const second = joiner.listen({ host: "127.0.0.1", port, ...LISTEN });
    // The same promise, which is the mechanism: the provisioner's later await
    // is the first bind, not a race against it.
    expect(second).toBe(first);

    await first;
    await second;
    await joiner.listen({ host: "127.0.0.1", port, ...LISTEN });

    expect(sink.filter(line => line.includes("listening on"))).toEqual([`model broker: listening on 127.0.0.1:${port}`]);
  });

  test("refuses to grant an endpoint on an ephemeral port the bind has not resolved", async () => {
    const ephemeral = makeBroker();
    const pending = ephemeral.listen({ host: "127.0.0.1", port: 0, ...LISTEN });

    const message = thrownMessage(() =>
      ephemeral.issue({ model: MODEL, peerCidr: null, limits: DEFAULT_LIMITS, ttlMs: DEFAULT_TTL_MS }),
    );
    expect(message).toContain("cannot grant an endpoint on 127.0.0.1:0");
    expect(message).toContain("await `listen` before issuing");

    await pending;
    const granted = ephemeral.issue({
      model: MODEL,
      peerCidr: null,
      limits: DEFAULT_LIMITS,
      ttlMs: DEFAULT_TTL_MS,
    });
    expect(new URL(granted.endpoint).port).not.toBe("0");
    expect(Number(new URL(granted.endpoint).port)).toBeGreaterThan(0);
  });

  test("names the attempts and the elapsed budget when the address never binds", async () => {
    const occupied = Bun.serve<never, {}>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 404 }),
    });
    servers.push(occupied);
    const blocked = makeBroker();

    await expect(blocked.listen({ host: "127.0.0.1", port: occupied.port, attempts: 2, delayMs: 10 })).rejects.toThrow(
      `model broker could not bind 127.0.0.1:${occupied.port} after 2 attempts over 20ms`,
    );

    // A failed bind must not poison the broker: the next container provisions
    // onto a different network and therefore a different address.
    const usable = await freePort();
    await blocked.listen({ host: "127.0.0.1", port: usable, ...LISTEN });
    expect(
      blocked.issue({ model: MODEL, peerCidr: null, limits: DEFAULT_LIMITS, ttlMs: DEFAULT_TTL_MS }).endpoint,
    ).toBe(`http://127.0.0.1:${usable}`);
  });
});

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

describe("refusal body drain", () => {
  test("leaves the connection usable after refusing a request whose body it never wanted", async () => {
    const granted = issueGrant();
    const host = `127.0.0.1:${new URL(brokerBase).port}`;
    const connection = await rawConnect("127.0.0.1", Number(new URL(brokerBase).port));
    connections.push(connection);

    const large = new Uint8Array(LARGE_BODY_BYTES).fill(0x61);

    // Refused at the route, before the handler has any reason to read a body.
    connection.send(
      requestHead({ path: "/v1/models", host, contentLength: large.byteLength, token: granted.token }),
    );
    connection.send(large);
    const notFound = await connection.next("the 404 refusal of an oversized POST /v1/models");
    expect(notFound.status).toBe(404);
    expect(JSON.parse(notFound.body)).toEqual({ error: "not_found" });

    // Refused at the credential, on the same connection, same shape.
    connection.send(requestHead({ path: "/v1/messages", host, contentLength: large.byteLength }));
    connection.send(large);
    const unauthorized = await connection.next("the 401 refusal of an oversized unauthenticated POST");
    expect(unauthorized.status).toBe(401);
    expect(JSON.parse(unauthorized.body)).toEqual({ error: "unauthorized" });

    // The whole point. Without the drain in `#deny` this request never
    // completes and this file fails as the named timeout above rather than as a
    // wrong status.
    const valid = encoder.encode(JSON.stringify({ model: MODEL }));
    connection.send(
      requestHead({ path: "/v1/messages", host, contentLength: valid.byteLength, token: granted.token }),
    );
    connection.send(valid);
    const ok = await connection.next("a valid request on the connection two refusals were answered on");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } });
  });

  test("leaves the connection usable after refusing a body over the cap", async () => {
    const granted = issueGrant();
    const host = `127.0.0.1:${new URL(brokerBase).port}`;
    const connection = await rawConnect("127.0.0.1", Number(new URL(brokerBase).port));
    connections.push(connection);

    const overCap = new Uint8Array(OVER_CAP_BODY_BYTES).fill(0x61);
    connection.send(
      requestHead({ path: "/v1/messages", host, contentLength: overCap.byteLength, token: granted.token }),
    );
    connection.send(overCap);
    const tooLarge = await connection.next("the 413 refusal of an over-cap body");
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body)).toEqual({ error: "payload_too_large" });
    expect(logs.some(line => line.includes(`body exceeds the ${32 * 1024 * 1024}-byte ceiling`))).toBe(true);

    const valid = encoder.encode(JSON.stringify({ model: MODEL }));
    connection.send(
      requestHead({ path: "/v1/messages", host, contentLength: valid.byteLength, token: granted.token }),
    );
    connection.send(valid);
    const ok = await connection.next("a valid request on the connection an over-cap body was refused on");
    expect(ok.status).toBe(200);

    // The over-cap body was read and dropped, never forwarded.
    expect(upstreamSeen).toHaveLength(1);
    expect(JSON.parse(upstreamSeen[0]?.body ?? "null")).toEqual({ model: MODEL });
  });
});

// ---------------------------------------------------------------------------
// What may never reach a log line
// ---------------------------------------------------------------------------

describe("logging", () => {
  test("never writes a token, the upstream bearer, or body content to a log line", async () => {
    const canary = "canary-body-8f2b1c";
    const stranger = "stranger-token-6d0e4a";
    const shadow = "shadow-model-1b7c93";

    const spent = issueGrant({ limits: { maxRequests: 1, maxTokens: 100_000, maxConcurrent: 1 } });
    const narrow = issueGrant({ peerCidr: "10.0.0.0/8" });
    const doomed = issueGrant({ ttlMs: 1_000 });
    const working = issueGrant();
    expect(minted).toHaveLength(4);

    const canaryBody = JSON.stringify({ model: MODEL, messages: [{ role: "user", content: canary }] });
    const shadowBody = JSON.stringify({ model: shadow, messages: [{ role: "user", content: canary }] });

    // A success, then every refusal this handler can produce short of the ones
    // that need a wedged upstream.
    expect((await post("/v1/messages", { token: working.token, body: canaryBody })).status).toBe(200);
    expect((await post("/v1/models", { token: working.token, body: canaryBody })).status).toBe(404);
    expect((await post("/v1/messages", { body: canaryBody })).status).toBe(401);
    expect((await post("/v1/messages", { token: stranger, body: canaryBody })).status).toBe(401);
    expect((await post("/v1/messages", { token: narrow.token, body: canaryBody })).status).toBe(403);
    expect((await post("/v1/messages", { token: working.token, body: shadowBody })).status).toBe(403);
    expect((await post("/v1/messages", { token: working.token, body: `${canaryBody}<<<not json` })).status).toBe(400);
    expect((await post("/v1/messages", { token: working.token, body: '{"messages":[]}' })).status).toBe(400);
    expect((await post("/v1/messages", { token: spent.token, body: canaryBody })).status).toBe(200);
    expect((await post("/v1/messages", { token: spent.token, body: canaryBody })).status).toBe(402);
    nowMs += 5_000;
    expect((await post("/v1/messages", { token: doomed.token, body: canaryBody })).status).toBe(401);
    broker.revoke(working.token);
    broker.revokeAll();

    // Every path above produced a line, so this is a search over the real
    // surface and not over an empty array.
    expect(refusals().length).toBeGreaterThanOrEqual(8);
    expect(logs.length).toBeGreaterThanOrEqual(12);

    const forbidden = [...minted, stranger, UPSTREAM_BEARER, canary, shadow];
    for (const secret of forbidden) {
      const leaked = logs.filter(line => line.includes(secret));
      expect({ secret, leaked }).toEqual({ secret, leaked: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("lifecycle", () => {
  test("revokeAll drops every grant", async () => {
    const first = issueGrant();
    const second = issueGrant();
    expect(broker.liveGrants()).toBe(2);

    broker.revokeAll();

    expect(broker.liveGrants()).toBe(0);
    expect(logs.some(line => line.includes("revoked 2 grants"))).toBe(true);
    expect((await post("/v1/messages", { token: first.token })).status).toBe(401);
    expect((await post("/v1/messages", { token: second.token })).status).toBe(401);

    // Idempotent, and silent when there is nothing to say.
    const before = logs.length;
    broker.revokeAll();
    expect(logs.length).toBe(before);
  });

  test("close stops the listener, leaves grants alone, and is safe to call twice", async () => {
    const granted = issueGrant();
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
    expect(broker.liveGrants()).toBe(1);

    await broker.close();

    // Deliberately unchanged: `revokeAll` is the audited lifecycle event that
    // ends a grant, so whether the audit records a revocation must not depend
    // on shutdown ordering.
    expect(broker.liveGrants()).toBe(1);
    await expect(request("/v1/messages", { token: granted.token })).rejects.toThrow();

    await broker.close();
    expect(broker.liveGrants()).toBe(1);
  });
});
