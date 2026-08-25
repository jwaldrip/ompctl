/**
 * The loopback endpoint an OMP session actually connects to.
 *
 * One route shape, `/mcp/<grantId>`, and the upstream URL comes only from the
 * grant row that id names. There is deliberately no route that takes a
 * destination from the caller: something that attaches a live OAuth bearer
 * token to whichever URL it is handed is a credential-forwarding service, not
 * a broker, and that difference is the entire security argument for the daemon
 * holding these tokens instead of the sessions.
 *
 * What one request looks like:
 *
 *   omp session ──▶ /mcp/<grantId>              X-Ompd-Mcp-Auth: <loopback token>
 *                     │  authenticate the caller, screen the JSON-RPC method
 *                     ▼
 *                   broker.accessTokenFor(grantId)
 *                     │
 *                     ▼
 *                   grant.resourceUrl            Authorization: Bearer <access>
 *
 * The two credentials never meet. The caller's `X-Ompd-Mcp-Auth` is not
 * forwarded upstream, and the caller never sees the bearer token in a response
 * body, a header, or a log line. That asymmetry is what makes the loopback
 * token safe to keep in a file that MCP config points at by *command* rather
 * than by value.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import {
  type AccessTokenResult,
  type Clock,
  type GrantRecord,
  type GrantStore,
  type McpAuthBroker,
  systemClock,
} from "./types.ts";

/**
 * Why a header, when `browser/mcp-server.ts` puts its token in the path.
 *
 * This URL is written into `~/.omp/agent/mcp.json`, and a config file must
 * never carry a credential. OMP's own `!command` header indirection means it
 * does not have to: the file holds
 * `"X-Ompd-Mcp-Auth": "!/bin/cat ~/.ompd/mcp-auth.token"`, the token stays in a
 * `0600` file, and a config committed to a repository by accident carries
 * nothing. The WebView server can afford a token in its path because that URL
 * is handed over ACP in memory and never written down.
 *
 * Exported so the code that writes that config entry names the same header this
 * code reads, rather than a string that happens to agree with it today.
 */
export const MCP_AUTH_HEADER = "X-Ompd-Mcp-Auth";

/**
 * The JSON-RPC methods a session may send through the broker.
 *
 * An allowlist, because the two failure directions do not cost the same. A
 * method missing from this list costs one legible `-32601` and a one-line
 * change here. A method that should not have been forwarded costs a request
 * made to a third party under the operator's own OAuth grant, with the
 * operator's own token on it, and there is no undo for that.
 *
 * Everything the MCP spec has a client send is here. Anything else is refused
 * before a token is minted -- including something that merely reads like a
 * member of the family, `tools/callSecret`, which is why membership is exact
 * and not a prefix.
 *
 * `notifications/*` is the one prefix, because notification types are the part
 * of the protocol that grows (`notifications/initialized`,
 * `notifications/cancelled`, `notifications/progress`, ...) and each is a
 * fire-and-forget message on a channel the caller already holds.
 */
const ALLOWED_METHODS: Record<string, true> = {
  initialize: true,
  ping: true,
  "completion/complete": true,
  "logging/setLevel": true,
  "tools/list": true,
  "tools/call": true,
  "resources/list": true,
  "resources/templates/list": true,
  "resources/read": true,
  "resources/subscribe": true,
  "resources/unsubscribe": true,
  "prompts/list": true,
  "prompts/get": true,
  "roots/list": true,
};

const NOTIFICATION_PREFIX = "notifications/";

/**
 * A path segment is an identifier and nothing else.
 *
 * The store is the authority on which grants exist -- this pattern is not a
 * second, drifting copy of the id scheme. What it does buy is that no request
 * reaching the grant lookup can carry a `..`, a second path segment, or
 * anything else that would make "the upstream comes only from the grant row"
 * less than literally true.
 */
const ROUTE = /^\/mcp\/([A-Za-z0-9_-]{1,64})$/;

/**
 * Forwarded upstream, by name.
 *
 * An allowlist rather than a denylist of hop-by-hop fields, so RFC 9110's
 * `Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`,
 * `Proxy-Authenticate` and `Proxy-Authorization` are excluded by construction
 * rather than by a list somebody has to keep in sync with the spec. The
 * caller's own `Authorization` and `X-Ompd-Mcp-Auth` are excluded the same way,
 * as is a cookie, a bearer token for something else, or any header a future
 * client invents.
 *
 * `Last-Event-ID` is here because it is how a reconnecting Streamable HTTP
 * client asks to resume a stream rather than replay it, and dropping it turns
 * every reconnect into a silent gap.
 */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
] as const;

/**
 * Returned to the caller, by name.
 *
 * `Mcp-Session-Id` is the one that matters: the upstream mints it on
 * `initialize` and every later request has to carry it back, so a proxy that
 * swallows it turns a stateful server into one that appears to forget its own
 * session. `WWW-Authenticate` is here so a 401 the broker could not fix still
 * reaches the caller as an authentication challenge instead of a bare status.
 */
const RETURNED_RESPONSE_HEADERS = ["content-type", "mcp-session-id", "www-authenticate"] as const;

/** Literal loopback addresses. Not `localhost`, which is whatever `/etc/hosts` says it is. */
const LOOPBACK_HOSTS: Record<string, true> = { "127.0.0.1": true, "::1": true };

/**
 * How long a grant that just refused a freshly minted token is left alone.
 *
 * The per-request bound stops one request making three upstream calls. It does
 * not stop the loop, because the loop is not inside one request: a revoked
 * grant makes every request a session sends cost an `invalidate`, a re-mint and
 * a second upstream call, and sessions retry. So a grant whose *replayed*
 * attempt was also refused stops being re-minted for a while, and its single
 * attempt is passed through unchanged. Short enough that somebody who has just
 * re-authorized is not left staring at a stale refusal, long enough that a dead
 * grant costs one request's worth of provider load rather than two.
 */
const RETRY_COOLDOWN_MS = 30_000;

/** A log is not a spool: a caller can otherwise name a method of any length and write it into the daemon's log. */
const METHOD_LOG_LIMIT = 64;

/**
 * JSON-RPC reserves -32000..-32099 for implementation-defined server errors.
 * This proxy defines exactly one, and lets the HTTP status carry the class:
 * 401 unauthorized, 404 unknown grant, 405 wrong method, 502 upstream
 * unreachable, 503 the grant needs a person.
 */
const CODE_BROKER = -32001;

interface JsonRpcFrame {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
}

type JsonRpcId = string | number | null;

export interface McpAuthProxyOptions {
  broker: McpAuthBroker;
  /** Read-only by construction: this surface resolves grants, it never writes one. */
  grants: Pick<GrantStore, "get">;
  /** Defaults to 0 so tests never collide on a port. The daemon passes its configured, stable one. */
  port?: number;
  /** Defaults to `127.0.0.1`. A non-loopback value is refused rather than bound. */
  host?: string;
  /** sha256 hex of the contents of `~/.ompd/mcp-auth.token`. The token itself never reaches this process. */
  tokenHash: string;
  clock?: Clock;
  onLog?: (line: string) => void;
  /** The seam the daemon leaves alone and a test can wrap. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface McpAuthProxy {
  readonly port: number;
  /** The URL an MCP config entry points at for `grantId`. Stable across restarts, because the id is derived. */
  urlFor(grantId: string): string;
  close(): void;
}

function rpc(id: JsonRpcId, code: number, message: string, status: number): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}

/** The id a response must echo, or `null` when the frame carried none a client could correlate. */
function frameId(raw: unknown): JsonRpcId {
  if (raw === null || typeof raw !== "object") return null;
  const id = (raw as JsonRpcFrame).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/**
 * `null` when every frame in the body is one this proxy is willing to forward.
 *
 * A batch is all-or-nothing. Forwarding the acceptable members and synthesising
 * errors for the rest would mean this code splitting and reassembling somebody
 * else's JSON-RPC correlation, and a batch containing one refused method is not
 * a batch a well-behaved client sent.
 */
function screen(parsed: unknown): { id: JsonRpcId; code: number; message: string } | null {
  const frames = Array.isArray(parsed) ? parsed : [parsed];
  // JSON-RPC 2.0 section 6: an empty batch is itself an invalid request.
  if (frames.length === 0) return { id: null, code: -32600, message: "invalid request: empty batch" };
  for (const raw of frames) {
    const frame = raw !== null && typeof raw === "object" ? (raw as JsonRpcFrame) : null;
    if (frame === null || frame.jsonrpc !== "2.0" || typeof frame.method !== "string") {
      return { id: frameId(raw), code: -32600, message: "invalid request" };
    }
    const method = frame.method;
    const permitted =
      ALLOWED_METHODS[method] === true ||
      (method.startsWith(NOTIFICATION_PREFIX) && method.length > NOTIFICATION_PREFIX.length);
    if (!permitted) {
      const shown = method.length <= METHOD_LOG_LIMIT ? method : `${method.slice(0, METHOD_LOG_LIMIT)}...`;
      return {
        id: frameId(raw),
        code: -32601,
        message: `method not permitted by the ompd MCP auth broker: ${shown}`,
      };
    }
  }
  return null;
}

/**
 * RFC 7235 auth schemes are case-insensitive, but resource servers that only
 * accept the canonical spelling exist. `bearer` is normalised; anything else is
 * passed through verbatim, because this code is in no position to translate a
 * token type it does not understand.
 */
function authorizationHeader(token: { accessToken: string; tokenType: string }): string {
  const type = token.tokenType.trim();
  const scheme = type === "" || type.toLowerCase() === "bearer" ? "Bearer" : type;
  return `${scheme} ${token.accessToken}`;
}

/** Render one untrusted string as exactly one POSIX shell argument for copy-paste guidance. */
function shellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function startMcpAuthProxy(opts: McpAuthProxyOptions): McpAuthProxy {
  const host = opts.host ?? "127.0.0.1";
  if (LOOPBACK_HOSTS[host] !== true) {
    throw new Error(
      `mcp auth proxy refuses to bind ${host}: this surface mints live OAuth tokens and is loopback only`,
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(opts.tokenHash)) {
    // A malformed hash would authenticate nobody, and would do it as a 401 on
    // every request -- indistinguishable from a wrong token in the file. Fail
    // where the mistake was made instead.
    throw new Error("mcp auth proxy tokenHash must be a sha256 hex digest of the loopback token");
  }
  const expectedToken = Buffer.from(opts.tokenHash.toLowerCase(), "hex");
  const clock = opts.clock ?? systemClock;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.onLog;
  const headerLower = MCP_AUTH_HEADER.toLowerCase();

  /** Grants whose replayed attempt was also refused, and when they may be re-minted again. */
  const coolingUntil = new Map<string, number>();

  function authenticate(req: Request): boolean {
    const presented = req.headers.get(headerLower);
    if (presented === null || presented.length === 0) return false;
    // Both sides are a 32-byte digest, so the lengths always match and
    // `timingSafeEqual` cannot throw. Hashing first is also what keeps the
    // comparison length-independent: a token's own length is not disclosed.
    return timingSafeEqual(createHash("sha256").update(presented).digest(), expectedToken);
  }

  /**
   * The one place a human learns that a grant needs them.
   *
   * `detail` is the broker's own one-line reason, which `McpAuthSummary`
   * defines as wire-safe and already redacted; without it this names a state
   * but not a cause, and "degraded" on its own has never helped anybody. No
   * token, no refresh material and no upstream error body reaches here.
   */
  function needsAPerson(
    grant: GrantRecord,
    result: Extract<AccessTokenResult, { ok: false }>,
    id: JsonRpcId,
  ): Response {
    const because = result.detail.trim() === "" ? "" : `: ${result.detail}`;
    log?.(`mcp-auth: ${grant.serverName} needs a person: ${result.state}`);
    return rpc(
      id,
      CODE_BROKER,
      `MCP auth for "${grant.serverName}" is ${result.state}${because}. ` +
        `Run \`ompd mcp-auth login ${shellArgument(grant.resourceUrl)}\` to re-authorize it.`,
      503,
    );
  }

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    // An MCP notification channel can legitimately sit silent for minutes, and
    // Bun's default would close it as idle. This surface exists to hold
    // long-lived sessions open, so it holds them open.
    idleTimeout: 0,
    fetch: async req => {
      const match = ROUTE.exec(new URL(req.url).pathname);
      if (match === null) return rpc(null, CODE_BROKER, "not found", 404);
      // Authenticated before the grant lookup, so an unauthenticated caller
      // cannot enumerate which grants exist by reading 404 against 200. The
      // refusal says nothing about which half was wrong: a 401 that
      // distinguishes "you sent nothing" from "you sent the wrong thing" is a
      // free oracle, and a legitimate caller learns nothing from it either.
      if (!authenticate(req)) {
        log?.(`mcp-auth: rejected a request with a missing or wrong ${MCP_AUTH_HEADER} header`);
        return rpc(null, CODE_BROKER, "unauthorized", 401);
      }
      const method = req.method;
      if (method !== "POST" && method !== "GET" && method !== "DELETE") {
        return rpc(null, CODE_BROKER, "method not allowed", 405);
      }
      const grantId = match[1]!;
      const grant = opts.grants.get(grantId);
      if (grant === undefined) return rpc(null, CODE_BROKER, "not found", 404);

      // Read once, reuse for the replay. A JSON-RPC frame is small; the
      // alternative is a retry that cannot resend what it already consumed.
      let body: string | undefined;
      let callerId: JsonRpcId = null;
      if (method === "POST") {
        body = await req.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return rpc(null, -32700, "parse error", 400);
        }
        callerId = frameId(Array.isArray(parsed) ? parsed[0] : parsed);
        const refused = screen(parsed);
        if (refused !== null) {
          log?.(`mcp-auth: refused a ${grant.serverName} request: ${refused.message}`);
          // HTTP 200 with a JSON-RPC error, which is how a JSON-RPC client is
          // meant to receive one: as a refusal of the call, not as a transport
          // failure it should reconnect over.
          return rpc(refused.id, refused.code, refused.message, 200);
        }
      }

      const upstreamHeaders = new Headers();
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers.get(name);
        if (value !== null) upstreamHeaders.set(name, value);
      }

      let minted = await opts.broker.accessTokenFor(grantId);
      if (!minted.ok) return needsAPerson(grant, minted, callerId);

      // A grant still inside its cooldown gets one attempt and no re-mint.
      let mayRetry = (coolingUntil.get(grantId) ?? 0) <= clock.now();
      for (;;) {
        upstreamHeaders.set("authorization", authorizationHeader(minted));
        let upstream: Response;
        try {
          upstream = await doFetch(grant.resourceUrl, {
            method,
            headers: upstreamHeaders,
            body,
            signal: req.signal,
            // Not followed. Following one means deciding whether to re-send an
            // injected bearer token to a host this grant was never bound to,
            // and the answer to that is no, so the 3xx goes back to the caller
            // as the visible dead end it is.
            redirect: "manual",
          });
        } catch (err) {
          // The caller is already gone; nothing reads this.
          if (req.signal.aborted) return new Response(null, { status: 499 });
          const reason = err instanceof Error ? err.message : String(err);
          log?.(`mcp-auth: upstream request for ${grant.serverName} failed: ${reason}`);
          return rpc(callerId, CODE_BROKER, `upstream request to ${grant.serverName} failed`, 502);
        }

        // The retry decision is made from the status line, before one body byte
        // has been handed to the caller, which is what makes "never replay a
        // stream that already delivered bytes" true by construction rather than
        // by a flag somebody has to remember to check.
        const refusedUpstream = upstream.status === 401 || upstream.status === 403;
        if (refusedUpstream && mayRetry) {
          mayRetry = false;
          // An undrained refusal body holds a connection open for nothing.
          await upstream.body?.cancel().catch(() => {});
          opts.broker.invalidate(grantId);
          const fresh = await opts.broker.accessTokenFor(grantId);
          if (!fresh.ok) return needsAPerson(grant, fresh, callerId);
          minted = fresh;
          log?.(`mcp-auth: ${grant.serverName} refused a brokered request with ${upstream.status}; replaying once`);
          continue;
        }

        if (refusedUpstream) {
          coolingUntil.set(grantId, clock.now() + RETRY_COOLDOWN_MS);
          log?.(
            `mcp-auth: ${grant.serverName} refused with ${upstream.status} after a re-mint; ` +
              `not re-minting for ${Math.round(RETRY_COOLDOWN_MS / 1000)}s`,
          );
        } else {
          coolingUntil.delete(grantId);
        }

        const headers = new Headers();
        for (const name of RETURNED_RESPONSE_HEADERS) {
          const value = upstream.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        // Passed through, never buffered. A stream read to completion before
        // answering is not a stream, and every incremental notification on it
        // would arrive at once, at the end. RFC 9110's bodiless statuses are
        // the one exception: handing `new Response` a body with one throws.
        const bodiless = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
        return new Response(bodiless ? null : upstream.body, { status: upstream.status, headers });
      }
    },
  });

  const port = server.port;
  if (port === undefined) throw new Error("mcp auth proxy bound no port");
  const authority = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;

  return {
    port,
    urlFor(grantId) {
      return `http://${authority}/mcp/${grantId}`;
    },
    close() {
      server.stop(true);
    },
  };
}
