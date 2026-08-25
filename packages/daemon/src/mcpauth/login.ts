/**
 * The one time a person is in the loop.
 *
 * OAuth 2.1 authorization code with PKCE, a loopback redirect, and dynamic
 * client registration when the operator has no client id -- which is the normal
 * case, because every authorization server behind the grants that motivated
 * this subsystem publishes a registration endpoint.
 *
 * Two decisions here decide whether the daemon can do its job at all:
 *
 * `offline_access` is requested whenever the server advertises it. A provider
 * that supports the refresh grant but was never asked for offline access issues
 * no refresh token, and the operator then gets a `no_refresh_grant` that is our
 * fault and looks like theirs. Asking costs nothing where it is not needed.
 *
 * `supportsRefresh` on the resulting grant is the conjunction of "the server
 * advertises the refresh grant" and "it actually issued a refresh token". The
 * second half is the honest one: `no_refresh_grant` is defined as either
 * condition failing, and a grant recorded as refreshable on the strength of
 * metadata alone would sit at `healthy` until its access token died.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { discoverAuth, registerClient } from "./discovery.ts";
import { exchangeAuthorizationCode, toRefreshOutcome } from "./token-endpoint.ts";
import type { ClientAuthMethod, Clock, DiscoveredAuth, GrantInput, MintedAccessToken } from "./types.ts";

/** The redirect host. Loopback only: a redirect any other machine can reach is an authorization anyone can steal. */
const LOOPBACK = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** RFC 6749 has no timeout. A listener with no deadline is a listener nobody closes. */
const DEFAULT_LOGIN_TIMEOUT_MS = 300_000;
/** The scope that makes a refresh token appear. Named by OpenID Connect, honoured by most OAuth servers. */
const OFFLINE_ACCESS = "offline_access";

export interface BeginLoginOptions {
  /** The MCP endpoint being authorized. Also half the grant id. */
  resourceUrl: string;
  /** The name this server is mounted under in MCP config, used for the registered client name. */
  serverName: string;
  /** The provider's own label for the identity, when the operator knows it. The other half of the grant id. */
  account?: string;
  /** Fixed loopback port, for the servers that only accept a pre-registered redirect. Default: OS-assigned. */
  redirectPort?: number;
  /** Skip dynamic client registration and use this client instead. */
  clientId?: string;
  clientSecret?: string;
  /** Required when reusing a pre-registered client: discovery cannot prove its registration method. */
  clientAuthMethod?: ClientAuthMethod;
  /** What to call the dynamically registered client. Defaults to the server name. */
  clientName?: string;
  /** Scopes to request on top of `offline_access`. Space separated. */
  scope?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Clock seam for the first in-memory access token's expiry. */
  clock?: Clock;
  /** Discovery already done by the caller, to avoid probing twice. */
  discovered?: DiscoveredAuth;
}

/**
 * The durable grant and its first, memory-only bearer.
 *
 * The grant persists only renewable material. The access token is deliberately
 * kept beside the result until the subsystem hands it to the in-memory broker,
 * which lets a provider that issued no refresh token work until this bearer
 * expires without putting it in SQLite.
 */
export interface CompletedLogin extends GrantInput {
  initialAccessToken: MintedAccessToken;
}

export interface PendingLogin {
  /** Where to send the person. Nothing happens until this is opened. */
  authorizationUrl: string;
  /** The loopback redirect this login is listening on. */
  redirectUri: string;
  /** What was actually asked for, so a caller can report it rather than guess. */
  requestedScope?: string;
  /** Resolves once the code has been exchanged. Rejects on refusal, mismatch, or timeout. */
  completed: Promise<CompletedLogin>;
  /** Abandon the login and close the listener. */
  cancel(reason?: string): void;
}

/**
 * The grant id, derived rather than random.
 *
 * Two independent parts of this daemon mint these -- the login flow and the
 * config writer -- and they must agree byte for byte, because the id is the
 * last path segment of the loopback URL written into MCP config. Derived from
 * (resource, account) so importing the same grant twice converges instead of
 * forking, and so the URL survives a daemon restart and a re-import.
 */
export function grantIdFor(resourceUrl: string, account?: string): string {
  const digest = createHash("sha256")
    .update(`${resourceUrl}\n${account ?? ""}`)
    .digest("hex");
  return `mcpauth_${digest.slice(0, 16)}`;
}

/**
 * Start an authorization. Returns as soon as there is a URL to open; the grant
 * arrives on `completed`.
 *
 * The listener binds before the client is registered, because the redirect URI
 * is part of the registration and the port is not known until the bind.
 */
export async function beginLogin(opts: BeginLoginOptions): Promise<PendingLogin> {
  const auth = opts.discovered ?? (await discoverAuth(opts.resourceUrl, opts.fetchImpl));
  const clock = opts.clock ?? { now: () => Date.now() };
  const authorizationEndpoint = auth.metadata.authorization_endpoint;
  if (authorizationEndpoint === undefined || authorizationEndpoint === "") {
    throw new Error(`${auth.issuer} publishes no authorization_endpoint; ${opts.serverName} cannot be authorized`);
  }
  const challengeMethods = auth.metadata.code_challenge_methods_supported;
  if (challengeMethods !== undefined && !challengeMethods.includes("S256")) {
    // Refused rather than downgraded to `plain`. A verifier sent in the clear
    // is not PKCE, and an authorization server this far behind is one an
    // operator should hear about rather than silently be given weaker crypto.
    throw new Error(`${auth.issuer} does not support S256 code challenges (offers ${challengeMethods.join(", ")})`);
  }

  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const requested = new Set((opts.scope ?? "").split(/\s+/).filter(scope => scope !== ""));
  if (auth.metadata.scopes_supported?.includes(OFFLINE_ACCESS) === true) requested.add(OFFLINE_ACCESS);
  const requestedScope = requested.size === 0 ? undefined : [...requested].join(" ");

  const settled = Promise.withResolvers<CompletedLogin>();
  if (opts.clientId !== undefined && opts.clientId !== "" && opts.clientAuthMethod === undefined) {
    throw new Error(
      "a pre-registered OAuth client requires its recorded clientAuthMethod; refusing to infer one from metadata",
    );
  }
  let redirectUri = "";
  let clientId = opts.clientId ?? "";
  let clientSecret = opts.clientSecret;
  let clientAuthMethod: ClientAuthMethod = opts.clientAuthMethod ?? "none";
  let answered = false;
  let done = false;

  const server = Bun.serve({
    hostname: LOOPBACK,
    port: opts.redirectPort ?? 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (url.pathname !== CALLBACK_PATH) return page("Not the callback this login is waiting for.", 404);
      // Exactly one answer. A second request on the same URL is a replayed or
      // guessed callback, and the code in the first one has already been spent.
      if (answered) return page("This login has already been answered.", 409);
      answered = true;

      const refusal = url.searchParams.get("error");
      if (refusal !== null) {
        const description = url.searchParams.get("error_description") ?? "";
        const detail = description === "" ? "" : ` (${description})`;
        finish(new Error(`${opts.serverName} authorization was refused: ${refusal}${detail}`));
        return page(`Authorization was refused: ${refusal}.`, 400);
      }

      const presented = url.searchParams.get("state") ?? "";
      const expected = Buffer.from(state, "utf8");
      const actual = Buffer.from(presented, "utf8");
      // Length first: `timingSafeEqual` throws on a mismatch, and a thrown
      // comparison is a comparison that leaks by exception instead of by clock.
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        finish(new Error(`${opts.serverName} callback carried the wrong state; discarding it`));
        return page("This callback did not come from the login that is waiting.", 400);
      }

      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        finish(new Error(`${opts.serverName} callback carried no authorization code`));
        return page("The callback carried no authorization code.", 400);
      }

      try {
        const response = await exchangeAuthorizationCode({
          tokenUrl: auth.metadata.token_endpoint,
          code,
          redirectUri,
          codeVerifier: verifier,
          clientId,
          clientSecret,
          clientAuthMethod,
          resource: auth.resource,
          fetchImpl: opts.fetchImpl,
        });
        const grant: GrantInput = {
          id: grantIdFor(opts.resourceUrl, opts.account),
          serverName: opts.serverName,
          resourceUrl: opts.resourceUrl,
          issuer: auth.issuer,
          tokenUrl: auth.metadata.token_endpoint,
          authorizationUrl: authorizationEndpoint,
          registrationUrl: auth.metadata.registration_endpoint,
          clientId,
          clientAuthMethod,
          // What the provider granted, not what we asked for. The two differ
          // often enough that recording the request would make the status table
          // a record of our intentions rather than of the grant.
          scopes: response.scope ?? requestedScope ?? "",
          account: opts.account,
          supportsRefresh: auth.supportsRefresh && response.refresh_token !== undefined,
          secrets: { refreshToken: response.refresh_token, clientSecret },
        };
        const initial = toRefreshOutcome(response, clock.now());
        if (initial.kind !== "ok") throw new Error("authorization code exchange produced no access token");
        finish({ ...grant, initialAccessToken: initial.token });
        return page("Authorized. You can close this tab.", 200);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
        return page("The token exchange failed. The daemon log has the reason.", 502);
      }
    },
  });

  redirectUri = `http://${LOOPBACK}:${server.port}${CALLBACK_PATH}`;

  /**
   * Settle once and close the listener.
   *
   * `server.stop()` without forcing lets the response this was called from
   * flush; the whole point of answering the browser is that the person sees
   * what happened.
   */
  function finish(outcome: CompletedLogin | Error): void {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    void server.stop();
    if (outcome instanceof Error) settled.reject(outcome);
    else settled.resolve(outcome);
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const deadline = setTimeout(() => {
    finish(new Error(`${opts.serverName} login was not completed within ${Math.round(timeoutMs / 1000)}s`));
  }, timeoutMs);
  // A login nobody finished must not be why the daemon cannot exit.
  deadline.unref();

  if (clientId === "") {
    try {
      const registered = await registerClient(
        auth.metadata,
        redirectUri,
        opts.clientName ?? `ompd (${opts.serverName})`,
        opts.fetchImpl,
      );
      clientId = registered.clientId;
      clientSecret = registered.clientSecret ?? clientSecret;
      clientAuthMethod = registered.clientAuthMethod;
    } catch (err) {
      // The caller learns by throw, and `completed` is left unsettled on
      // purpose: rejecting a promise this function never returned is an
      // unhandled rejection in every caller.
      done = true;
      clearTimeout(deadline);
      void server.stop(true);
      throw err;
    }
  }

  const authorizationUrl = new URL(authorizationEndpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  if (requestedScope !== undefined) authorizationUrl.searchParams.set("scope", requestedScope);
  // RFC 8707. Binding the token to the resource it is for is what stops a token
  // minted for one MCP server being replayed against another behind the same
  // authorization server.
  authorizationUrl.searchParams.set("resource", auth.resource);

  return {
    authorizationUrl: authorizationUrl.toString(),
    redirectUri,
    requestedScope,
    completed: settled.promise,
    cancel: (reason?: string) => {
      finish(new Error(reason ?? `${opts.serverName} login was cancelled`));
    },
  };
}

/** The browser is a person's only view of this flow, so it gets a sentence rather than a status code. */
function page(message: string, status: number): Response {
  const body = `<!doctype html><meta charset="utf-8"><title>ompd</title>
<body style="font:16px system-ui;padding:3rem;max-width:34rem"><p>${message}</p></body>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
