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
 * passthrough, or a trailing slash slipping through would expose whatever omp's
 * gateway grows next, including `GET /v1/models`, which enumerates every
 * provider this host holds a credential for. So the refusals are asserted as
 * hard 404s rather than as "not a 200".
 *
 * A malformed peer range must throw at mint time, not degrade into a skip. The
 * skip is reachable only from an explicit `null`, because `null` is a decision
 * somebody spelled out and a range that does not parse is an accident. That is
 * the one place here where a passing assertion and an open door are a single
 * edit apart, so the test asserts the thrown message names the null escape
 * hatch rather than merely that something threw.
 *
 * Nothing this broker logs may contain a credential or a byte of a body. That
 * is asserted globally rather than per refusal: every path is exercised and
 * then every captured line is searched for every minted token, the upstream
 * bearer, and a canary planted in a request body. A refusal added later that
 * quotes the wrong thing fails here without anyone remembering to add a case.
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
 * chunk arriving on a stream -- and the only `setTimeout` in the file is the
 * watchdog attached to those waits, which never fires on a passing run and
 * exists so a regression fails with the name of what never came.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { ModelBroker, type ModelGrant, type ModelGrantLimits } from "../src/model-broker/broker.ts";

/** The one model every grant here allowlists, unless a test says otherwise. */
const MODEL = "claude-broker-test-model";

/** What the fake auth-gateway is presented with, and what no log line may name. */
const UPSTREAM_BEARER = "upstream-bearer-value";

/**
 * Watchdog budget for a signal that is already on its way. Under bun:test's own
 * 5s per-test timeout on purpose, so a stalled wait fails naming what it was
 * waiting for rather than as an anonymous test timeout.
 */
const DEADLINE_MS = 3_000;

const DEFAULT_LIMITS: ModelGrantLimits = { maxRequests: 16, maxTokens: 100_000, maxConcurrent: 4 };

const DEFAULT_TTL_MS = 600_000;

/** Bind retries kept short: loopback either binds now or the port is genuinely taken. */
const LISTEN = { attempts: 4, delayMs: 25 } as const;

/**
 * 33 MiB, which is the size the desync was originally measured at and not a
 * round number picked for comfort. Deleting `await drainBody(req)` from `#deny`
 * and re-running this file was measured on Bun 1.3.14 to still pass at 4 MiB
 * and to hang at 33 MiB: below some threshold the server absorbs the whole body
 * before the handler answers, and the connection stays in sync whether or not
 * anything drained it. A drain test written at 4 MiB is a drain test that
 * cannot fail, so the size is part of the assertion.
 */
const LARGE_BODY_BYTES = 33 * 1024 * 1024;

/** The broker's `MAX_REQUEST_BODY_BYTES`, which it does not export. */
const REQUEST_BODY_CAP = 32 * 1024 * 1024;

/**
 * Double the cap, not a byte over it, and the difference decides whether the
 * 413 test can fail. `readBounded` crosses the cap after 32 MiB and its job is
 * to keep reading anyway; a `cap + 1024` body leaves a kilobyte of remainder,
 * which the kernel has long since accepted, so the test reads zero bytes
 * outstanding whether or not anything read past the cap. Measured on Bun
 * 1.3.14: at `cap + 1024` a broker that bails at the cap AND skips the `#deny`
 * drain still passes; at `2 * cap` it leaves roughly 32 MiB outstanding and is
 * caught.
 */
const OVER_CAP_BODY_BYTES = 2 * REQUEST_BODY_CAP;

/** Room for tens of megabytes across loopback, which bun:test's 5s default does not leave. */
const LARGE_BODY_TEST_TIMEOUT_MS = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface UpstreamCall {
  url: string;
  method: string;
  authorization: string | null;
  /**
   * Every header the fake gateway was presented with, lowercased by `Headers`
   * iteration. Kept whole rather than as a handful of named fields, because the
   * property under test is which headers a guest can get through here at all,
   * and a fixed field list can only ever check the ones somebody thought of.
   */
  headers: Record<string, string>;
  body: string;
}

/** A one-shot signal, so a test can hold the fake gateway open and let it go. */
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
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
    probes.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) }));
  }
  const ports = probes.map(probe => probe.port);
  // Stopped before anything can throw, so a probe never outlives this call.
  await Promise.all(probes.map(probe => probe.stop(true)));
  const reserved: number[] = [];
  for (const port of ports) {
    if (port === undefined) throw new Error("Bun.serve reported no port for a free-port probe");
    reserved.push(port);
  }
  return reserved;
}

async function freePort(): Promise<number> {
  const [port] = await freePorts(1);
  if (port === undefined) throw new Error("could not reserve a port");
  return port;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

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
// A raw HTTP/1.1 client, so "the same connection" is a fact and not a hope
// ---------------------------------------------------------------------------

interface RawResponse {
  status: number;
  body: string;
}

interface RawConnection {
  send(payload: string | Uint8Array): void;
  /**
   * Bytes queued for this socket that the kernel has not accepted yet.
   *
   * This is the whole drain assertion. A handler that consumed the request
   * body before answering cannot have answered until every byte reached it, so
   * a refusal arriving with anything still queued here is a refusal written
   * over a body that is still in flight, which is the state that desyncs the
   * connection.
   */
  pending(): number;
  /** The next complete response on this connection, or a named timeout. */
  next(label: string, ms?: number): Promise<RawResponse>;
  close(): void;
}

interface ParsedResponse {
  response: RawResponse;
  consumed: number;
}

const CRLF = [0x0d, 0x0a];
const CRLF_CRLF = [0x0d, 0x0a, 0x0d, 0x0a];

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

/**
 * One response off the front of `buf`, or null while it is still arriving.
 *
 * Handles exactly the two framings Bun emits: `content-length` for the fixed
 * bodies every refusal produces, and `chunked` for the streamed forward of a
 * gateway reply. Trailers are not parsed because Bun sends none, and a harness
 * that pretended otherwise would be untested code standing in for the guest.
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
    return { response: { status, body }, consumed: bodyStart + length };
  }

  if ((headers.get("transfer-encoding") ?? "").toLowerCase().includes("chunked")) {
    const pieces: Uint8Array[] = [];
    let cursor = bodyStart;
    for (;;) {
      const eol = indexOfSequence(buf, CRLF, cursor);
      if (eol < 0) return null;
      const size = Number.parseInt(decoder.decode(buf.subarray(cursor, eol)).split(";")[0] ?? "", 16);
      if (!Number.isFinite(size)) return null;
      const dataStart = eol + CRLF.length;
      if (size === 0) {
        const end = dataStart + CRLF.length;
        if (buf.byteLength < end) return null;
        return { response: { status, body: decoder.decode(joinAll(pieces)) }, consumed: end };
      }
      const dataEnd = dataStart + size;
      if (buf.byteLength < dataEnd + CRLF.length) return null;
      pieces.push(buf.slice(dataStart, dataEnd));
      cursor = dataEnd + CRLF.length;
    }
  }

  return { response: { status, body: "" }, consumed: bodyStart };
}

async function rawConnect(host: string, port: number): Promise<RawConnection> {
  // Annotated rather than inferred: `concat` yields the `ArrayBufferLike`
  // spelling and `new Uint8Array(0)` yields the `ArrayBuffer` one, which do not
  // assign in that direction under the generic typed-array lib.
  let inbox: Uint8Array = new Uint8Array(0);
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
      drain() {
        pump();
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
  function pump(): void {
    while (outbox.length > 0) {
      const head = outbox[0];
      if (head === undefined) break;
      const wrote = socket.write(head);
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
      pump();
    },
    pending() {
      let total = 0;
      for (const queued of outbox) total += queued.byteLength;
      return total;
    },
    next(label, ms = DEADLINE_MS) {
      return new Promise<RawResponse>((resolve, reject) => {
        let timer: Timer | undefined;
        const settle = () => {
          waiting = null;
          clearTimeout(timer);
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
  /** Verbatim extra header lines, for shapes `fetch` and `Headers` refuse to send. */
  extra?: string[];
}): string {
  const lines = [
    `${input.method ?? "POST"} ${input.path} HTTP/1.1`,
    `Host: ${input.host}`,
    "Content-Type: application/json",
    `Content-Length: ${input.contentLength}`,
  ];
  if (input.token !== undefined) lines.push(`Authorization: Bearer ${input.token}`);
  for (const line of input.extra ?? []) lines.push(line);
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
let brokerPort: number;
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
  const body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? { model: MODEL });
  return fetch(`${brokerBase}${path}`, { method, headers, body: method === "GET" ? undefined : body });
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

beforeEach(async () => {
  logs = [];
  minted = [];
  upstreamSeen = [];
  nowMs = Date.UTC(2026, 7, 25, 12, 0, 0);
  upstreamReply = () => Response.json({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } });

  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    async fetch(req) {
      const body = await req.text();
      upstreamSeen.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.get("authorization"),
        headers: Object.fromEntries(req.headers),
        body,
      });
      return await upstreamReply(req, body);
    },
  });
  servers.push(upstream);
  liveUpstreamBase = `http://127.0.0.1:${upstream.port}`;
  upstreamBase = liveUpstreamBase;

  broker = makeBroker();
  brokerPort = await freePort();
  await broker.listen({ host: "127.0.0.1", port: brokerPort, ...LISTEN });
  brokerBase = `http://127.0.0.1:${brokerPort}`;
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
    expect(upstreamSeen.map(call => new URL(call.url).pathname)).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
    // The guest's bearer stops at the broker. What reaches the gateway is the
    // gateway's own, which the guest has never held.
    expect(upstreamSeen.map(call => call.authorization)).toEqual([
      `Bearer ${UPSTREAM_BEARER}`,
      `Bearer ${UPSTREAM_BEARER}`,
    ]);

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

    // Two forwards, and no more: a refusal is not a forward.
    expect(upstreamSeen).toHaveLength(2);

    const captured = logs.join("\n");
    for (const named of [
      "GET /v1/messages is not an allowlisted route",
      "POST /v1/models is not an allowlisted route",
      "POST / is not an allowlisted route",
      "POST /v1/messages/ is not an allowlisted route",
    ]) {
      expect(captured).toContain(named);
    }
  });

  test("discards a query string rather than forwarding it to the gateway", async () => {
    const granted = issueGrant();

    expect((await post("/v1/messages?x=1&beta=true", { token: granted.token })).status).toBe(200);

    const seen = upstreamSeen.at(-1);
    expect(seen).toBeDefined();
    const forwarded = new URL(seen?.url ?? "http://invalid.invalid");
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
    expect(logs.join("\n")).toContain("carried no bearer credential");
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a bearer no live grant matches", async () => {
    issueGrant();
    const answer = await post("/v1/messages", { token: "not-a-token-anyone-minted" });
    expect(answer.status).toBe(401);
    expect(logs.join("\n")).toContain("presented a credential no live grant matches");
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a revoked token", async () => {
    const granted = issueGrant();
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);

    broker.revoke(granted.token);
    expect(broker.liveGrants()).toBe(0);

    const answer = await post("/v1/messages", { token: granted.token });
    expect(answer.status).toBe(401);
    expect(logs.join("\n")).toContain("presented a credential no live grant matches");
    expect(upstreamSeen).toHaveLength(1);
  });

  test("refuses an expired grant and drops it", async () => {
    const enduring = issueGrant({ ttlMs: 600_000 });
    const doomed = issueGrant({ ttlMs: 1_000 });
    expect(broker.liveGrants()).toBe(2);

    nowMs += 5_000;

    const answer = await post("/v1/messages", { token: doomed.token });
    expect(answer.status).toBe(401);
    expect(logs.join("\n")).toContain(`presented an expired grant for ${MODEL}`);
    // Dropped by the request that presented it, and asserted through `revoke`
    // rather than through `liveGrants`, because `liveGrants` prunes expired
    // grants itself and would report 1 either way. `revoke` logs only when it
    // found something, so silence here is the request having already removed
    // it, and a line here is the delete in the handler having gone missing.
    const beforeRevoke = logs.length;
    broker.revoke(doomed.token);
    expect(logs.slice(beforeRevoke)).toEqual([]);
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
    expect(logs.join("\n")).toContain("arrived from 127.0.0.1, outside the granted range 10.0.0.0/8");
    expect(upstreamSeen).toHaveLength(0);
  });

  test("skips the check only for a grant minted with an explicit null range", async () => {
    const granted = issueGrant({ peerCidr: null });
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
    // Turning the check off is a real widening, so it is named in the audit
    // rather than left to be inferred from an absent range.
    expect(logs.join("\n")).toContain("any peer, peer check off for this grant");
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
    expect(logs.join("\n")).toContain(`asked for a model other than the granted ${MODEL}`);
    // The requested model is body content, and body content does not reach a log.
    expect(logs.join("\n")).not.toContain(shadow);
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a body that is not JSON", async () => {
    const granted = issueGrant();
    const answer = await post("/v1/messages", { token: granted.token, body: "{not json at all" });
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.text)).toEqual({ error: "bad_request" });
    expect(logs.join("\n")).toContain("body is not JSON");
    expect(upstreamSeen).toHaveLength(0);
  });

  test("refuses a body that names no model", async () => {
    const granted = issueGrant();
    for (const body of ['{"messages":[]}', '{"model":42}', "[]", '"a string"']) {
      const answer = await post("/v1/messages", { token: granted.token, body });
      expect({ body, status: answer.status }).toEqual({ body, status: 400 });
    }
    expect(logs.join("\n")).toContain("body names no model");
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
    expect(logs.join("\n")).toContain("exhausted the 2-request ceiling");
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
    expect(logs.join("\n")).toContain("exhausted the 10-token ceiling (12 counted)");
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
    expect(logs.join("\n")).toContain("exceeds the 1-request concurrency ceiling");

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
// Admission is atomic, or the ceilings are decorations
//
// The ceilings used to be checked at the top of the handler and incremented
// after `readBounded` and `#upstreamBearer`, both of which yield. Every
// request in a burst therefore read the same stale zero, every one passed
// admission, and every one forwarded. A sequential test cannot see that: one
// request at a time passes either version. So these fire a burst an order of
// magnitude past the ceiling at a gateway that answers nothing until the test
// lets it, which is the only shape where the race is the difference between
// pass and fail.
// ---------------------------------------------------------------------------

/** Far enough past any ceiling here that one stale read shows up as a pile-up. */
const BURST = 50;

/** Long enough for fifty loopback requests, which bun:test's 5s default is not. */
const BURST_DEADLINE_MS = 15_000;

interface Burst {
  /** Opens as soon as the fake gateway is holding more than the ceiling allows. */
  readonly overshot: Gate;
  /** Opens once the broker has answered every request it refused. */
  readonly refused: Gate;
  /** The most the fake gateway ever held at once. */
  peak(): number;
  /** Lets the held requests complete. */
  finish(): void;
  /** Every response, once the held ones have drained. */
  drain(): Promise<Response[]>;
}

/**
 * `BURST` requests fired without awaiting any of them, at a fake gateway that
 * holds every request it receives.
 *
 * Holding is what makes the count meaningful: nothing the broker admitted can
 * finish and free its slot while the burst is still arriving, so the number the
 * gateway is holding is exactly the number that got through admission.
 */
function burst(input: { token: string; ceiling: number }): Burst {
  const overshot = gate();
  const refused = gate();
  const finish = gate();
  let holding = 0;
  let peak = 0;
  let answered = 0;

  upstreamReply = async () => {
    holding += 1;
    peak = Math.max(peak, holding);
    if (holding > input.ceiling) overshot.open();
    await finish.promise;
    holding -= 1;
    return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
  };

  const flight = Array.from({ length: BURST }, () =>
    request("/v1/messages", { token: input.token }).then(response => {
      // Only refusals can resolve before `finish`, so this counts refusals
      // without having to read a status to know one.
      answered += 1;
      if (answered >= BURST - input.ceiling) refused.open();
      return response;
    }),
  );

  return {
    overshot,
    refused,
    peak: () => peak,
    finish: () => {
      finish.open();
    },
    drain: () => withDeadline(Promise.all(flight), "the burst to drain", BURST_DEADLINE_MS),
  };
}

/** Responses counted by status, so a failure names the shape and not just a number. */
function byStatus(answers: Response[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const answer of answers) {
    const key = String(answer.status);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

describe("atomic admission", () => {
  test("a burst past maxConcurrent never puts more than the ceiling on the wire", async () => {
    const ceiling = 2;
    const granted = issueGrant({ limits: { maxRequests: BURST, maxTokens: 1_000_000, maxConcurrent: ceiling } });
    const fired = burst({ token: granted.token, ceiling });

    // Whichever happens first. A broker with the race loses on `overshot` and
    // loses immediately, with the peak in the failure message, rather than as an
    // anonymous timeout.
    await withDeadline(
      Promise.race([fired.refused.promise, fired.overshot.promise]),
      "the burst to be refused or to overshoot the concurrency ceiling",
      BURST_DEADLINE_MS,
    );
    expect(fired.peak()).toBeLessThanOrEqual(ceiling);

    fired.finish();
    const answers = await fired.drain();
    // Exact, not a bound: the burst is only released after every refusal has
    // been answered, so nothing can arrive late and find a free slot.
    expect(byStatus(answers)).toEqual({ "200": ceiling, "429": BURST - ceiling });
    expect(upstreamSeen).toHaveLength(ceiling);
    await Promise.all(answers.map(answer => answer.text()));
  });

  test("a burst past maxRequests never puts more than the ceiling on the wire", async () => {
    const ceiling = 3;
    // Concurrency deliberately wide open, so the request ceiling is the only
    // thing that can hold this burst back and the assertion is about that
    // counter rather than about the other one.
    const granted = issueGrant({ limits: { maxRequests: ceiling, maxTokens: 1_000_000, maxConcurrent: BURST } });
    const fired = burst({ token: granted.token, ceiling });

    await withDeadline(
      Promise.race([fired.refused.promise, fired.overshot.promise]),
      "the burst to be refused or to overshoot the request ceiling",
      BURST_DEADLINE_MS,
    );
    expect(fired.peak()).toBeLessThanOrEqual(ceiling);

    fired.finish();
    const answers = await fired.drain();
    expect(byStatus(answers)).toEqual({ "200": ceiling, "402": BURST - ceiling });
    expect(upstreamSeen).toHaveLength(ceiling);
    await Promise.all(answers.map(answer => answer.text()));
  });

  test(
    "a refusal after admission gives back both the slot and the request",
    async () => {
      const ceiling = 3;
      const granted = issueGrant({ limits: { maxRequests: ceiling, maxTokens: 100_000, maxConcurrent: 1 } });

      // Every refusal that lands after the reservation is taken: a body naming
      // another model, a body that is not JSON, a body naming no model, and a
      // body over the cap. None of them reached the gateway.
      //
      // With `maxConcurrent: 1`, a leaked slot fails this on the second line
      // with a 429, and a request charged for a refusal fails it below on the
      // count. Both counters are covered.
      const other = { model: "a-model-this-grant-does-not-allow" };
      expect((await post("/v1/messages", { token: granted.token, body: other })).status).toBe(403);
      expect((await post("/v1/messages", { token: granted.token, body: "{not json" })).status).toBe(400);
      expect((await post("/v1/messages", { token: granted.token, body: '{"messages":[]}' })).status).toBe(400);
      // A kilobyte over the cap, not the doubled body the drain tests use: the
      // doubling there exists to leave bytes outstanding for a `pending()`
      // assertion, and this test only needs the refusal itself.
      const overCap = "a".repeat(REQUEST_BODY_CAP + 1024);
      expect((await post("/v1/messages", { token: granted.token, body: overCap })).status).toBe(413);

      // Four requests against a budget of three. If any refusal above had kept
      // its reservation, one of the first three is a 402 instead.
      expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
      expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
      expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
      const spent = await post("/v1/messages", { token: granted.token });
      expect(spent.status).toBe(402);
      expect(JSON.parse(spent.text)).toEqual({ error: "quota_exhausted" });
      expect(upstreamSeen).toHaveLength(ceiling);
    },
    LARGE_BODY_TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// What the guest can put in front of the gateway
//
// The gateway is an external `omp` child holding a real provider credential,
// and this repo pins neither its version nor its inbound-header handling. So
// the assertion is not "the headers we thought of are stripped", it is "only
// the four on the allowlist arrive". A denylist passes the first and fails the
// second.
// ---------------------------------------------------------------------------

describe("forwarded request headers", () => {
  test("forwards only the allowlisted headers, with the gateway's own bearer", async () => {
    const granted = issueGrant();
    // Each of these means something to some provider or proxy, and the guest
    // chose every byte of every one of them.
    const planted: Record<string, string> = {
      "x-api-key": "guest-planted-provider-key",
      "x-forwarded-for": "10.9.9.9",
      "x-forwarded-host": "gateway.guest.example",
      "openai-organization": "org-the-guest-picked",
      "openai-project": "proj-the-guest-picked",
      "x-goog-user-project": "billing-project-the-guest-picked",
    };

    const res = await fetch(`${brokerBase}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${granted.token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
        ...planted,
      },
      body: JSON.stringify({ model: MODEL }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const call = upstreamSeen[0];
    if (call === undefined) throw new Error("the fake gateway saw no call to check headers on");

    for (const name of Object.keys(planted)) {
      expect({ name, forwarded: call.headers[name] }).toEqual({ name, forwarded: undefined });
    }

    // And the four a turn genuinely needs arrive verbatim, values included:
    // dropping these would break streaming and protocol version selection.
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.accept).toBe("text/event-stream");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(call.headers.authorization).toBe(`Bearer ${UPSTREAM_BEARER}`);

    // Nowhere in the forwarded request, under any header name.
    expect(JSON.stringify(call.headers)).not.toContain(granted.token);
  });

  test("a smuggled second authorization header authenticates as nothing", async () => {
    const granted = issueGrant();
    const smuggled = "smuggled-second-credential";
    const host = `127.0.0.1:${brokerPort}`;
    const connection = await rawConnect("127.0.0.1", brokerPort);
    connections.push(connection);

    const body = encoder.encode(JSON.stringify({ model: MODEL }));
    connection.send(
      requestHead({
        path: "/v1/messages",
        host,
        contentLength: body.byteLength,
        token: granted.token,
        extra: [`Authorization: Bearer ${smuggled}`],
      }),
    );
    connection.send(body);

    // Over a raw socket because `Headers` will not let `fetch` send a duplicate
    // at all. Measured on Bun 1.3.14: the server folds the two into one
    // comma-joined value, so the smuggled credential does not select anything,
    // it corrupts the real one, and the request dies at authentication before
    // any forwarding decision is reached.
    const answer = await connection.next("the refusal of a request carrying two authorization headers");
    expect(answer.status).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({ error: "unauthorized" });
    expect(upstreamSeen).toHaveLength(0);
    expect(logs.join("\n")).not.toContain(smuggled);
  });
});

// ---------------------------------------------------------------------------
// Metering, and the stream it must not hold up
// ---------------------------------------------------------------------------

const SSE_HEAD = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n';
const SSE_TAIL =
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n' + "data: [DONE]\n\n";

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
    expect(logs.join("\n")).toContain("exhausted the 10-token ceiling (13 counted)");
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
    if (body === null) throw new Error("the broker answered an SSE forward with no body");
    const reader = body.getReader();
    const received: Uint8Array[] = [];
    let seen = 0;

    // The tail does not exist yet and cannot until this test releases it, so a
    // broker that buffered the response to the end deadlocks here and fails as
    // the named timeout rather than as a wrong assertion.
    while (seen < SSE_HEAD.length) {
      const step = await withDeadline(reader.read(), "the first SSE chunk to arrive before the stream ended");
      if (step.done) break;
      if (step.value === undefined) continue;
      received.push(step.value);
      seen += step.value.byteLength;
    }
    expect(decoder.decode(joinAll(received))).toBe(SSE_HEAD);

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
    expect(logs.join("\n")).toContain("forwarding /v1/messages to the auth gateway failed");

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
    // observable that branch protects is reachable, and this is it.
    upstreamReply = () => new Response(null, { status: 204 });
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 100_000, maxConcurrent: 1 } });

    const empty = await post("/v1/messages", { token: granted.token });
    expect(empty.status).toBe(204);
    expect(empty.text).toBe("");

    upstreamReply = () => Response.json({ ok: true });
    expect((await post("/v1/messages", { token: granted.token })).status).toBe(200);
  });

  test("hands the slot back when the gateway's stream dies mid-body", async () => {
    const die = gate();
    upstreamReply = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(SSE_HEAD));
            void die.promise.then(() => {
              controller.error(new Error("the gateway's stream died mid-turn"));
            });
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 100_000, maxConcurrent: 1 } });

    const res = await request("/v1/messages", { token: granted.token });
    expect(res.status).toBe(200);
    const body = res.body;
    if (body === null) throw new Error("the broker answered an SSE forward with no body");
    const reader = body.getReader();
    const first = await withDeadline(reader.read(), "the first SSE chunk before the gateway kills the stream");
    expect(decoder.decode(first.value)).toBe(SSE_HEAD);

    // The exit the meter's `cancel` hook exists for, and the only one that
    // never reaches `flush`: the response has already been handed to the
    // stream, so the handler's `finally` has run and released nothing.
    die.open();
    try {
      for (;;) {
        const step = await withDeadline(reader.read(), "the guest's stream to end after the gateway killed it");
        if (step.done) break;
      }
    } catch {
      // Expected: a body that stops mid-stream is what a dead gateway looks
      // like from the guest's side.
    }

    upstreamReply = () => Response.json({ ok: true });
    // 429 here is a slot leaked for the life of the container by one failed
    // stream, which is the whole reason the ceiling has to be released from
    // both stream terminations and not just the tidy one.
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
    // Refused before anything was recorded, so a wildcard cannot leave the
    // broker committed to an address it never opened.
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
    await expect(committed.listen({ host: "127.0.0.2", port: first, ...LISTEN })).rejects.toThrow("already committed");
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

    expect(sink.filter(line => line.includes("listening on"))).toEqual([
      `model broker: listening on 127.0.0.1:${port}`,
    ]);
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
    expect(Number(new URL(granted.endpoint).port)).toBeGreaterThan(0);
  });

  test("names the attempts and the elapsed budget when the address never binds", async () => {
    const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
    servers.push(occupied);
    const taken = occupied.port;
    if (taken === undefined) throw new Error("Bun.serve reported no port for the occupied-port probe");
    const blocked = makeBroker();

    await expect(blocked.listen({ host: "127.0.0.1", port: taken, attempts: 2, delayMs: 10 })).rejects.toThrow(
      `model broker could not bind 127.0.0.1:${taken} after 2 attempts over 20ms`,
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
//
// What actually desyncs a connection, measured on Bun 1.3.14 by deleting
// `await drainBody(req)` from `#deny` and re-running this file:
//
//   A client that writes its whole declared body always resynchronises,
//   whatever the size and whatever the handler did. 4 MiB, 33 MiB and 128 MiB
//   all recover. So "send a huge body, then send another request" is a test
//   that cannot fail, and an earlier draft of this file was exactly that.
//
//   The connection breaks when the refusal is written while body bytes are
//   still in flight. A real client that already holds a final response stops
//   sending the rest, and the server is then parked mid-body: it reads the next
//   request's head as body continuation and either answers nothing at all or
//   answers `400 Bad Request` with `Connection: close`. Both were reproduced.
//
// So the assertion is not "the next request works" -- that is the symptom, and
// it needs a client that misbehaves in exactly the right way to show up. The
// assertion is that NOTHING IS STILL QUEUED when the refusal lands, which is
// only true of a handler that consumed the body before answering, and which
// fails immediately and legibly rather than as a timeout. The follow-up
// request is asserted too, because the property the drain exists for is that
// the connection survives.
// ---------------------------------------------------------------------------

describe("refusal body drain", () => {
  test(
    "reads a refused request's body before answering, and leaves the connection usable",
    async () => {
      const granted = issueGrant();
      const host = `127.0.0.1:${brokerPort}`;
      const connection = await rawConnect("127.0.0.1", brokerPort);
      connections.push(connection);

      const large = new Uint8Array(LARGE_BODY_BYTES).fill(0x61);

      // Refused at the route, before the handler has any reason to read a body.
      connection.send(requestHead({ path: "/v1/models", host, contentLength: large.byteLength, token: granted.token }));
      connection.send(large);
      const notFound = await connection.next("the 404 refusal of an oversized POST /v1/models");
      expect(notFound.status).toBe(404);
      expect(JSON.parse(notFound.body)).toEqual({ error: "not_found" });
      expect({ refusal: 404, stillQueued: connection.pending() }).toEqual({ refusal: 404, stillQueued: 0 });

      // Refused at the credential, on the same connection, same shape.
      connection.send(requestHead({ path: "/v1/messages", host, contentLength: large.byteLength }));
      connection.send(large);
      const unauthorized = await connection.next("the 401 refusal of an oversized unauthenticated POST");
      expect(unauthorized.status).toBe(401);
      expect(JSON.parse(unauthorized.body)).toEqual({ error: "unauthorized" });
      expect({ refusal: 401, stillQueued: connection.pending() }).toEqual({ refusal: 401, stillQueued: 0 });

      const valid = encoder.encode(JSON.stringify({ model: MODEL }));
      connection.send(
        requestHead({ path: "/v1/messages", host, contentLength: valid.byteLength, token: granted.token }),
      );
      connection.send(valid);
      const ok = await connection.next("a valid request on the connection two refusals were answered on");
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.body)).toEqual({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } });
      expect(upstreamSeen).toHaveLength(1);
    },
    LARGE_BODY_TEST_TIMEOUT_MS,
  );

  test(
    "reads an over-cap body to the end before refusing it, and leaves the connection usable",
    async () => {
      const granted = issueGrant();
      const host = `127.0.0.1:${brokerPort}`;
      const connection = await rawConnect("127.0.0.1", brokerPort);
      connections.push(connection);

      const overCap = new Uint8Array(OVER_CAP_BODY_BYTES).fill(0x61);
      connection.send(
        requestHead({ path: "/v1/messages", host, contentLength: overCap.byteLength, token: granted.token }),
      );
      connection.send(overCap);
      const tooLarge = await connection.next("the 413 refusal of an over-cap body", 15_000);
      expect(tooLarge.status).toBe(413);
      expect(JSON.parse(tooLarge.body)).toEqual({ error: "payload_too_large" });
      expect(logs.join("\n")).toContain(`body exceeds the ${REQUEST_BODY_CAP}-byte ceiling`);
      // Two things hold this zero and either one alone is enough: `readBounded`
      // keeps reading past the cap and stops retaining, and `#deny` drains
      // whatever is left. Measured on Bun 1.3.14, breaking one still passes and
      // breaking both leaves half this body outstanding, so this pins the
      // property the connection depends on rather than one mechanism's shape.
      expect({ refusal: 413, stillQueued: connection.pending() }).toEqual({ refusal: 413, stillQueued: 0 });

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
    },
    LARGE_BODY_TEST_TIMEOUT_MS,
  );
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

    // A success, then every refusal this handler produces short of the ones
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
    expect(logs.filter(line => line.includes("refused:")).length).toBeGreaterThanOrEqual(9);
    expect(logs.length).toBeGreaterThanOrEqual(15);

    for (const secret of [...minted, stranger, UPSTREAM_BEARER, canary, shadow]) {
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
    expect(logs.join("\n")).toContain("revoked 2 grants");
    expect((await post("/v1/messages", { token: first.token })).status).toBe(401);
    expect((await post("/v1/messages", { token: second.token })).status).toBe(401);

    // Idempotent, and silent when there is nothing left to say.
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

  test("revoke cancels a turn already dispatched to the gateway", async () => {
    const reached = gate();
    const cancelled = gate();
    upstreamReply = async req => {
      req.signal.addEventListener("abort", () => {
        cancelled.open();
      });
      reached.open();
      // Held until the cancellation arrives, so the only way this test
      // completes is the gateway actually being told to stop.
      await cancelled.promise;
      return Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });
    };
    const granted = issueGrant({ limits: { maxRequests: 5, maxTokens: 100_000, maxConcurrent: 1 } });

    const held = request("/v1/messages", { token: granted.token });
    await withDeadline(reached.promise, "the turn to reach the fake gateway");

    broker.revoke(granted.token);

    // The load-bearing assertion, and it is about the gateway rather than about
    // the guest's answer: until the grant carried an `AbortController`,
    // revocation stopped the next request from authenticating and left this one
    // running, so provider work and operator quota outlived the container that
    // asked for it. The fake gateway's own `req.signal` is the only place that
    // is observable from.
    await withDeadline(cancelled.promise, "the fake gateway to see the turn cancelled");

    const answer = await withDeadline(held, "the cancelled turn to be answered");
    expect(answer.status).toBe(401);
    expect(await answer.json()).toEqual({ error: "unauthorized" });
    expect(logs.join("\n")).toContain("cancelling 1 in flight");
    expect(logs.join("\n")).toContain("cancelled an in-flight /v1/messages");
    // Not a 502: an abort this daemon asked for is not a gateway fault, and
    // reporting it as one sends an operator to read the gateway's logs for a
    // failure that is not there.
    expect(logs.join("\n")).not.toContain("forwarding /v1/messages to the auth gateway failed");
    expect(broker.liveGrants()).toBe(0);
  });

  test("revoke cancels a turn that is already streaming to the guest", async () => {
    const cancelled = gate();
    upstreamReply = req => {
      req.signal.addEventListener("abort", () => {
        cancelled.open();
      });
      // Headers and one event, then nothing, which is what a long turn looks
      // like from here. This is the expensive case: an SSE turn can hold a
      // provider busy for minutes after the container is gone.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(SSE_HEAD));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const granted = issueGrant();

    const res = await request("/v1/messages", { token: granted.token });
    expect(res.status).toBe(200);
    const body = res.body;
    if (body === null) throw new Error("the broker answered an SSE forward with no body");
    const reader = body.getReader();
    const first = await withDeadline(reader.read(), "the first SSE chunk of the turn about to be revoked");
    expect(decoder.decode(first.value)).toBe(SSE_HEAD);

    broker.revoke(granted.token);

    await withDeadline(cancelled.promise, "the fake gateway to see the streaming turn cancelled");
    expect(logs.join("\n")).toContain("cancelling 1 in flight");

    // And the guest's copy ends rather than hanging on a stream nothing will
    // ever write to again.
    try {
      for (;;) {
        const step = await withDeadline(reader.read(), "the guest's stream to end once the turn was revoked");
        if (step.done) break;
      }
    } catch {
      // Expected: the body dies mid-stream when the turn behind it is killed.
    }
  });
});
