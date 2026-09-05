/**
 * Helpers for the web portal build (https://app.ompctl.ai and daemon-served origins).
 *
 * Handles deep-link query and fragment parsing, address-bar token scrubbing,
 * and direct-socket default targeting when the app is served directly by an ompd daemon.
 */

import { DEFAULT_HUB_HOST, parsePairTarget } from "@ompd/core/pairing";
import type { Connection } from "./connection.ts";
import { parsePairDeepLink } from "./deeplink.ts";

/**
 * Returns the WebSocket direct socket URL corresponding to an HTTP or HTTPS origin.
 * Example: "http://127.0.0.1:7777" -> "ws://127.0.0.1:7777/v1/socket".
 */
export function directSocketUrlForOrigin(origin: string): string {
  const parsed = new URL(origin);
  const scheme = parsed.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${parsed.host}/v1/socket`;
}

/**
 * Validates the daemon health payload shape:
 * - ok must be true
 * - homeId must be a string
 * - version must be a string
 * - service must NOT be present (the web deploy server emits service: "ompctl-web")
 */
export function isDaemonHealthPayload(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.ok !== true) return false;
  if ("service" in obj) return false;
  if (typeof obj.homeId !== "string" || typeof obj.version !== "string") return false;
  return true;
}

/**
 * Checks whether an origin is an authentic ompd daemon serving web assets.
 * Rejects "app.ompctl.ai" immediately so the hosted portal never treats itself
 * as a local daemon. Queries GET /v1/health expecting the daemon signature.
 */
export async function isDaemonOrigin(origin: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  try {
    const url = new URL(origin);
    if (url.hostname === "app.ompctl.ai") return false;
    const res = await fetchFn(new URL("/v1/health", origin).toString());
    if (!res.ok) return false;
    const data: unknown = await res.json();
    return isDaemonHealthPayload(data);
  } catch {
    return false;
  }
}

/**
 * Determines the default pair target input string for an origin.
 * When served by a daemon, defaults to direct transport to origin's /v1/socket.
 * Otherwise defaults to the hosted hub host.
 */
export function defaultPairTargetForOrigin(origin: string, isDaemon: boolean): string {
  if (isDaemon) {
    return directSocketUrlForOrigin(origin);
  }
  return DEFAULT_HUB_HOST;
}

/**
 * Strips sensitive query parameters and hash fragments from the browser location
 * bar using history.replaceState so tokens do not sit in the address bar or referrers.
 */
export function stripQueryFromHistory(): void {
  if (typeof window !== "undefined" && typeof window.history?.replaceState === "function") {
    window.history.replaceState(null, "", window.location.pathname);
  }
}

/**
 * Pure function: URL in, Connection out.
 *
 * (b) Recognises pairing links from "ompd invite":
 *   https://app.ompctl.ai/pair?hub=<host>&scopes=<scopes>#token=<credential>
 * as well as the legacy query token form:
 *   https://app.ompctl.ai/pair?token=<credential>&hub=<host>&scopes=<scopes>
 *
 * Parses the credential, extracts hubUrl/daemonId/token/scopes, and returns
 * a Connection object while stripping query and fragment from history.
 *
 * Direct connections:
 * A direct connection is ONLY minted when opts.isDaemon is explicitly true.
 * Arbitrary non-app origins with a token query or fragment are rejected without
 * prior proof that the origin is a verified ompd daemon.
 */
export function connectionFromPairUrl(
  rawUrl: string,
  opts: { isDaemon?: boolean } = {},
): Connection | null {
  const hubLink = parsePairDeepLink(rawUrl);
  if (hubLink !== null) {
    stripQueryFromHistory();
    return {
      transport: "hub",
      hubUrl: hubLink.hubUrl,
      daemonId: hubLink.daemonId,
      token: hubLink.token,
      scopes: hubLink.scopes,
    };
  }

  // Direct connection from URL query/fragment is allowed ONLY when the origin
  // was verified as a real daemon via isDaemonOrigin.
  if (opts.isDaemon !== true) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    const hashParams = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const token = hashParams.get("token")?.trim() ?? parsed.searchParams.get("token")?.trim();
    if (token && token.length > 0 && parsed.hostname !== "app.ompctl.ai") {
      const scopes = (hashParams.get("scopes") ?? parsed.searchParams.get("scopes") ?? "")
        .split(",")
        .map(scope => scope.trim())
        .filter(scope => scope.length > 0);
      stripQueryFromHistory();
      return {
        transport: "direct",
        url: directSocketUrlForOrigin(parsed.origin),
        token,
        scopes,
      };
    }
  } catch {
    // Malformed URL
  }

  return null;
}

/**
 * Pure function: constructs a direct connection from a target address and operator token.
 * Reuses the existing parsePairTarget parser.
 */
export function connectionFromDirectInput(targetInput: string, token: string): Connection | null {
  const target = parsePairTarget(targetInput);
  if (target === null || target.transport !== "direct") return null;
  const trimmedToken = token.trim();
  if (trimmedToken.length === 0) return null;
  return {
    transport: "direct",
    url: target.url,
    token: trimmedToken,
    scopes: [],
  };
}
