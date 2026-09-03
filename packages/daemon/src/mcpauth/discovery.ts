/**
 * Where a token comes from, established before anything is stored.
 *
 * The nine unrefreshable rows this subsystem exists to fix were unrefreshable
 * for one reason: nobody wrote down the token endpoint. OMP's refresh predicate
 * is `Boolean(current.refresh && material?.tokenUrl)`, and a plugin-provided
 * server definition carries no `auth` block for `material` to fall back to, so
 * those grants were dead the moment they were saved. Discovery runs once, at
 * authorization time, and its whole output is persisted as columns -- issuer,
 * token endpoint, registration endpoint -- so a refresh a month from now needs
 * nothing but the row.
 *
 * Two RFCs and one de-facto shape, in that order: RFC 9728 asks the resource
 * server which authorization server protects it, RFC 8414 asks that server
 * where its endpoints are, and OpenID Connect Discovery covers the providers
 * that only ever published the OIDC document.
 */

import type {
  AuthorizationServerMetadata,
  ClientAuthMethod,
  DiscoveredAuth,
  ProtectedResourceMetadata,
} from "./types.ts";

/** RFC 9728 section 3: the path a resource server publishes its own metadata under. */
const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";
/** RFC 8414 section 3. */
const AS_WELL_KNOWN = "/.well-known/oauth-authorization-server";
/** OpenID Connect Discovery 1.0 section 4. */
const OPENID_WELL_KNOWN = "/.well-known/openid-configuration";

/** What dynamic client registration hands back. The secret, when there is one, belongs in the vault. */
export interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  clientAuthMethod: ClientAuthMethod;
}

/**
 * The RFC 9728 documents to try, most specific first.
 *
 * A server at `https://host/mcp` may publish under
 * `/.well-known/oauth-protected-resource/mcp` (one document per protected
 * resource) or at the root (one document for the host). Both are deployed in
 * the wild, so both are probed, and the specific one wins because a host
 * serving several MCP endpoints can only distinguish them that way.
 */
function protectedResourceCandidates(resourceUrl: string): string[] {
  const url = new URL(resourceUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const candidates = path === "" ? [] : [`${url.origin}${PROTECTED_RESOURCE_WELL_KNOWN}${path}`];
  candidates.push(`${url.origin}${PROTECTED_RESOURCE_WELL_KNOWN}`);
  return candidates;
}

/**
 * The authorization server metadata documents to try, in the order the specs
 * put them.
 *
 * RFC 8414 inserts the well-known segment between the host and the issuer's
 * path; OpenID Connect appends it. An issuer with no path makes those two the
 * same URL, so the insert form is emitted once and the append form is skipped
 * rather than probed twice.
 */
function authorizationServerCandidates(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  const candidates = [`${url.origin}${AS_WELL_KNOWN}${path}`];
  if (path !== "") candidates.push(`${url.origin}${path}${AS_WELL_KNOWN}`);
  candidates.push(`${url.origin}${path}${OPENID_WELL_KNOWN}`);
  return candidates;
}

/**
 * Probe an MCP endpoint and return everything needed to authorize against it
 * and, later, to renew without asking anything again.
 *
 * Every probe is a best-effort GET: a 404, a redirect to a login page, a
 * non-JSON body and a connection reset all mean "not here, try the next one".
 * Only exhausting the list is an error, and that error names what was probed,
 * because the alternative is an operator staring at "discovery failed".
 */
export async function discoverAuth(resourceUrl: string, fetchImpl: typeof fetch = fetch): Promise<DiscoveredAuth> {
  let protectedResource: ProtectedResourceMetadata | undefined;
  for (const candidate of protectedResourceCandidates(resourceUrl)) {
    protectedResource = await fetchJson<ProtectedResourceMetadata>(candidate, fetchImpl);
    if (protectedResource !== undefined) break;
  }

  const declared = protectedResource?.authorization_servers?.find(isNonEmptyString);
  // No protected-resource document, or one that names no authorization server:
  // fall back to the MCP endpoint's own origin. This is not a courtesy. Several
  // servers in the set that motivated this subsystem publish no RFC 9728
  // document at all and serve RFC 8414 metadata from the origin they answer
  // requests on, so refusing here would refuse servers that demonstrably work.
  const issuer = declared ?? new URL(resourceUrl).origin;

  const probed: string[] = [];
  let metadata: AuthorizationServerMetadata | undefined;
  for (const candidate of authorizationServerCandidates(issuer)) {
    probed.push(candidate);
    const document = await fetchJson<AuthorizationServerMetadata>(candidate, fetchImpl);
    // "First document carrying a token endpoint wins", not "first 200 wins". A
    // 200 without a `token_endpoint` is not metadata this daemon can renew
    // against, and stopping on it would hide a usable document one candidate
    // further down the list.
    if (document !== undefined && isNonEmptyString(document.token_endpoint)) {
      metadata = { ...document, issuer: isNonEmptyString(document.issuer) ? document.issuer : issuer };
      break;
    }
  }

  if (metadata === undefined) {
    throw new Error(
      `no authorization server metadata with a token endpoint for ${issuer} (probed ${probed.join(", ")})`,
    );
  }

  // RFC 8414 section 3.3 requires the document's `issuer` to match the one that
  // led us to it, and the mismatch it guards against is a real attack: a
  // resource server that names an issuer it does not control could otherwise
  // point a client's tokens anywhere. The check applies only when the issuer
  // was *declared* by a protected-resource document. When we guessed the origin
  // ourselves there was no claim to verify, and enforcing a match against our
  // own guess would reject correctly configured servers whose endpoints live
  // under a path.
  if (declared !== undefined && metadata.issuer.replace(/\/+$/, "") !== declared.replace(/\/+$/, "")) {
    throw new Error(`${declared} names a different issuer (${metadata.issuer}) in its metadata; refusing it`);
  }

  return {
    resource: isNonEmptyString(protectedResource?.resource) ? protectedResource.resource : resourceUrl,
    issuer: metadata.issuer,
    metadata,
    // Absent metadata is not a yes. RFC 8414 says an omitted
    // `grant_types_supported` defaults to `["authorization_code", "implicit"]`,
    // which does not include the refresh grant, and the cost of guessing
    // optimistically here is a broker reporting `healthy` for a grant it can
    // never renew -- exactly the lie the `no_refresh_grant` state exists to
    // avoid telling.
    supportsRefresh: metadata.grant_types_supported?.includes("refresh_token") === true,
  };
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Every authorization server behind the grants that motivated this work exposes
 * a registration endpoint, which is what makes a daemon-owned broker possible
 * at all: there is no operator-visible step where someone pastes a client id.
 *
 * `grant_types` names `refresh_token` explicitly. A server that registers a
 * client without it will refuse the refresh grant later with
 * `unauthorized_client`, and that failure arrives an hour after the browser is
 * closed, at which point nothing connects it back to this request.
 */
export async function registerClient(
  metadata: AuthorizationServerMetadata,
  redirectUri: string,
  clientName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredClient> {
  const endpoint = metadata.registration_endpoint;
  if (!isNonEmptyString(endpoint)) {
    throw new Error(
      `${metadata.issuer} publishes no registration_endpoint; a client id must be supplied for this server`,
    );
  }
  const advertised = metadata.token_endpoint_auth_methods_supported ?? [];
  const requestedMethod: ClientAuthMethod = advertised.includes("none")
    ? "none"
    : advertised.includes("client_secret_basic") || advertised.length === 0
      ? "client_secret_basic"
      : advertised.includes("client_secret_post")
        ? "client_secret_post"
        : (() => {
            throw new Error(`${metadata.issuer} advertises no supported token endpoint client authentication method`);
          })();
  const body: Record<string, unknown> = {
    client_name: clientName,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    application_type: "native",
    token_endpoint_auth_method: requestedMethod,
  };

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    // The failure body is quoted because it is the only thing that explains a
    // rejected registration, and it cannot contain a secret: this request is
    // the one that asks for one.
    const detail = (await response.text().catch(() => "")).slice(0, 200);
    throw new Error(`dynamic client registration at ${endpoint} failed with ${response.status}: ${detail}`);
  }

  const registered = (await response.json()) as {
    client_id?: unknown;
    client_secret?: unknown;
    token_endpoint_auth_method?: unknown;
  };
  if (!isNonEmptyString(registered.client_id)) {
    throw new Error(`dynamic client registration at ${endpoint} returned no client_id`);
  }
  const returnedMethod = registered.token_endpoint_auth_method;
  const clientAuthMethod =
    returnedMethod === undefined
      ? requestedMethod
      : returnedMethod === "client_secret_basic" || returnedMethod === "client_secret_post" || returnedMethod === "none"
        ? returnedMethod
        : (() => {
            throw new Error(
              `dynamic client registration at ${endpoint} returned an unsupported token authentication method`,
            );
          })();
  const clientSecret = isNonEmptyString(registered.client_secret) ? registered.client_secret : undefined;
  if (clientAuthMethod !== "none" && clientSecret === undefined) {
    throw new Error(
      `dynamic client registration at ${endpoint} chose ${clientAuthMethod} but returned no client_secret`,
    );
  }
  return {
    clientId: registered.client_id,
    clientSecret,
    clientAuthMethod,
  };
}

/** A GET that treats every failure -- transport, status, body -- as "not this URL". */
async function fetchJson<T>(url: string, fetchImpl: typeof fetch): Promise<T | undefined> {
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

/** A type guard, so `metadata.issuer` and friends narrow rather than needing a cast at every use. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
