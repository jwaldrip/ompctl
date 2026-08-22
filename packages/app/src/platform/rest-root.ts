/**
 * The HTTP root a socket url implies, for the surfaces that still need one.
 *
 * Cowork is not one of them: its whole surface rides the socket now, and the
 * `transport === "direct"` gate that once failed its fetches closed is gone
 * with the fetches. What remains here are the consumers of routes that are
 * still HTTP-only on the daemon -- the routines webhook display that shows an
 * outside caller where to POST, and the agent-config screen that has not yet
 * migrated onto the `agent_config_read`/`agent_config_write` frames. A hub
 * pairing holds a relay address rather than the daemon's own, so there is no
 * root to derive from it, which those surfaces name themselves.
 */

/** `ws://host/v1/socket?x=1#y` becomes `http://host`. Mirrors `client.ts`'s `agentsEndpoint`. */
export function restRoot(socketUrl: string): string | null {
  const match = /^(wss?|https?):\/\/([^/?#]+)/.exec(socketUrl);
  if (match === null) return null;
  const [, scheme, authority] = match;
  if (scheme === undefined || authority === undefined || authority.length === 0) return null;
  const secure = scheme === "wss" || scheme === "https";
  return `${secure ? "https" : "http"}://${authority}`;
}
