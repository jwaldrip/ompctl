/**
 * The only code in this daemon that talks to a token endpoint.
 *
 * Two jobs, and the second one is the one that earns the file. The first is
 * plumbing: form-encode a grant, post it, parse the response. The second is
 * classification -- deciding whether a failure means "this grant is gone, fetch
 * a human" or "try again shortly" -- and that decision is deliberately
 * asymmetric. Wrongly keeping a dead grant costs a retry against a provider
 * that already said no. Wrongly discarding a live one costs a person a browser
 * trip, and it happens at whatever hour the network hiccupped. So only the
 * codes RFC 6749 section 5.2 defines as terminal, on a 4xx, are terminal here.
 * A 5xx, an unparseable body, an unrecognised code, a socket error and an abort
 * are all transient.
 *
 * The other thing this file owns is not saying too much. Token endpoints echo:
 * the row that motivated this subsystem recorded `invalid_grant: Refresh token
 * reuse detected; session revoked`, and a provider one field away from that will
 * quote the token it refused. Error text from here becomes a log line, a stored
 * `detail`, and a field on a wire response, so everything we sent is scrubbed
 * out of everything we say, at the one place that knows both.
 */

import {
  type AuthorizationServerMetadata,
  type ClientAuthMethod,
  DEFINITIVE_OAUTH_ERRORS,
  type MintedAccessToken,
  type RefreshOutcome,
  type RefreshRequest,
  type TokenEndpointClient,
  TokenEndpointError,
  type TokenResponse,
} from "./types.ts";

export type { ClientAuthMethod } from "./types.ts";

/**
 * A token whose lifetime the provider did not state expires in five minutes as
 * far as this daemon is concerned.
 *
 * RFC 6749 section 5.1 makes `expires_in` optional and recommends the client
 * assume nothing. Assuming a long life would mean serving a dead token to an
 * MCP session and reading the 401 as the provider's fault; assuming a short one
 * costs an extra refresh. Five minutes is short enough to be safe and long
 * enough that a burst of requests shares one token.
 */
export const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 300;

/** Longest error detail kept. A log line that is a paragraph is a log line nobody reads. */
const MAX_ERROR_DETAIL = 200;

/**
 * Shortest secret worth scrubbing.
 *
 * A three-character "secret" would turn every message into redaction confetti
 * by matching ordinary words. Nothing a real authorization server issues is
 * anywhere near this short.
 */
const MIN_SCRUBBABLE_SECRET = 8;

/**
 * Validate a method recorded for a pre-registered client.
 *
 * Discovery advertises what an authorization server accepts, not the method an
 * existing client was registered with. A fresh DCR flow chooses and records its
 * own method in `registerClient`; this helper refuses when an existing client
 * would require an inference.
 */
export function pickClientAuthMethod(
  metadata: Pick<AuthorizationServerMetadata, "token_endpoint_auth_methods_supported">,
  hasSecret: boolean,
): ClientAuthMethod {
  const methods = metadata.token_endpoint_auth_methods_supported ?? [];
  if (!hasSecret) {
    if (methods.includes("none")) return "none";
    throw new Error(
      "the OAuth client has no secret and the authorization server does not advertise public client authentication",
    );
  }
  const confidential = methods.filter(
    (method): method is "client_secret_basic" | "client_secret_post" =>
      method === "client_secret_basic" || method === "client_secret_post",
  );
  const method = confidential[0];
  if (confidential.length === 1 && method !== undefined) return method;
  throw new Error(
    "the OAuth client authentication method is ambiguous or unsupported; use the method recorded at registration",
  );
}

/**
 * Remove anything we sent from anything we are about to say.
 *
 * Exported because it is a guarantee, not a detail: every caller that turns a
 * provider's words into a message a human or a log will see runs them through
 * here first, and a test asserts on the bytes rather than on this function's
 * own output.
 */
export function scrubSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < MIN_SCRUBBABLE_SECRET) continue;
    out = out.replaceAll(secret, "[redacted]");
    // A provider echoing a form value may echo it still encoded.
    out = out.replaceAll(encodeURIComponent(secret), "[redacted]");
  }
  return out.length > MAX_ERROR_DETAIL ? `${out.slice(0, MAX_ERROR_DETAIL)}…` : out;
}

/** Turn a successful token response into the outcome the broker records. */
export function toRefreshOutcome(response: TokenResponse, now: number): RefreshOutcome {
  const stated = response.expires_in ?? 0;
  const lifetime = Number.isFinite(stated) && stated > 0 ? stated : DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  const token: MintedAccessToken = {
    accessToken: response.access_token,
    tokenType: response.token_type ?? "Bearer",
    expiresAt: now + lifetime * 1000,
    scope: response.scope,
  };
  // `rotated` stays undefined when the response carried no successor. RFC 6749
  // section 6: the presented refresh token remains valid unless a new one is
  // issued, so the store must be told "nothing changed" rather than handed an
  // empty string, which would blank a working credential.
  return { kind: "ok", token, rotated: response.refresh_token };
}

/** The real thing. Every test in this subsystem replaces it with a `TokenEndpointClient` of its own. */
export class HttpTokenEndpointClient implements TokenEndpointClient {
  readonly #fetch: typeof fetch;

  constructor(opts: { fetchImpl?: typeof fetch } = {}) {
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async refresh(input: RefreshRequest): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
    });
    // RFC 8707. The resource server told us which indicator its tokens are
    // bound to; a renewal that omits it gets a token for a different audience,
    // which the upstream then rejects with a 401 that looks like expiry.
    if (input.resource !== undefined && input.resource !== "") form.set("resource", input.resource);
    if (input.scope !== undefined && input.scope !== "") form.set("scope", input.scope);

    return await postForm({
      url: input.tokenUrl,
      form,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      authMethod: input.clientAuthMethod,
      fetchImpl: this.#fetch,
      signal: input.signal,
      secrets: [input.refreshToken, input.clientSecret],
    });
  }
}

/** The authorization code half of the flow. Runs once, from `login.ts`, and never again for that grant. */
export async function exchangeAuthorizationCode(input: {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  resource?: string;
  clientAuthMethod: ClientAuthMethod;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
    client_id: input.clientId,
  });
  if (input.resource !== undefined && input.resource !== "") form.set("resource", input.resource);

  return await postForm({
    url: input.tokenUrl,
    form,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    authMethod: input.clientAuthMethod,
    fetchImpl: input.fetchImpl ?? fetch,
    signal: input.signal,
    secrets: [input.code, input.codeVerifier, input.clientSecret],
  });
}

/** RFC 6749 requires form-component encoding inside HTTP Basic credentials, not URI-component encoding. */
function formComponent(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

async function postForm(args: {
  url: string;
  form: URLSearchParams;
  clientId: string;
  clientSecret?: string;
  authMethod: ClientAuthMethod;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  /** Everything in this request that must never appear in an error. */
  secrets: readonly (string | undefined)[];
}): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };

  if (args.authMethod !== "none" && args.clientSecret !== undefined && args.clientSecret !== "") {
    if (args.authMethod === "client_secret_basic") {
      // RFC 6749 section 2.3.1: both halves are form-urlencoded before base64,
      // which matters for the generated secrets that contain `+` or `/`.
      const credentials = `${formComponent(args.clientId)}:${formComponent(args.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
    } else {
      args.form.set("client_secret", args.clientSecret);
    }
  }

  if (args.authMethod === "client_secret_basic") args.form.delete("client_id");

  let response: Response;
  try {
    response = await args.fetchImpl(args.url, {
      method: "POST",
      headers,
      body: args.form.toString(),
      signal: args.signal,
    });
  } catch (err) {
    // Nothing about a socket error or an abort says the grant is gone. Status 0
    // marks "we never got an answer", which is what makes this transient.
    const reason = scrubSecrets(err instanceof Error ? err.message : String(err), args.secrets);
    throw new TokenEndpointError(`token endpoint ${args.url} unreachable: ${reason}`, {
      status: 0,
      definitive: false,
    });
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) throw classifyFailure(response.status, body, args.secrets);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new TokenEndpointError(`token endpoint returned a non-JSON body (status ${response.status})`, {
      status: response.status,
      definitive: false,
    });
  }

  const fields = parsed as Partial<TokenResponse>;
  if (typeof fields.access_token !== "string" || fields.access_token === "") {
    throw new TokenEndpointError(`token endpoint returned no access token (status ${response.status})`, {
      status: response.status,
      definitive: false,
    });
  }

  // Rebuilt field by field rather than passed through. A provider is free to
  // return anything alongside these, and the rest of this subsystem holds
  // whatever comes out of here in memory and in logs.
  return {
    access_token: fields.access_token,
    token_type: typeof fields.token_type === "string" ? fields.token_type : undefined,
    expires_in: typeof fields.expires_in === "number" ? fields.expires_in : undefined,
    refresh_token:
      typeof fields.refresh_token === "string" && fields.refresh_token !== "" ? fields.refresh_token : undefined,
    scope: typeof fields.scope === "string" ? fields.scope : undefined,
  };
}

/**
 * The verdict, from the status and the body and nothing else.
 *
 * `definitive` requires all three of: a 4xx, a parseable body, and a code RFC
 * 6749 lists as terminal. Anything less specific keeps the grant.
 */
function classifyFailure(status: number, body: string, secrets: readonly (string | undefined)[]): TokenEndpointError {
  let code: string | undefined;
  let description: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; error_description?: unknown };
    if (typeof parsed.error === "string" && parsed.error !== "") code = parsed.error;
    if (typeof parsed.error_description === "string" && parsed.error_description !== "") {
      description = parsed.error_description;
    }
  } catch {
    // An unparseable body is not a verdict. It is a proxy page, an HTML error,
    // or a truncated response, and none of those mean the grant is gone.
  }

  const definitive = status >= 400 && status < 500 && code !== undefined && DEFINITIVE_OAUTH_ERRORS.includes(code);
  const detail = scrubSecrets([code ?? `http_${status}`, description].filter(Boolean).join(": "), secrets);
  return new TokenEndpointError(`token endpoint refused the exchange (${detail})`, { status, error: code, definitive });
}
