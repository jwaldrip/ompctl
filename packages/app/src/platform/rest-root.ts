/**
 * The HTTP root a socket url implies, for the surfaces that still need one.
 *
 * Cowork, Agent Config, and Stats are not among them: their surfaces ride the
 * socket now, and the `transport === "direct"` gates that once failed their
 * fetches closed are gone with the fetches. What remains here is the routines
 * webhook display that shows an outside caller where to POST. A hub pairing
 * holds a relay address rather than the daemon's own, and the hub tunnels that
 * specific webhook route down to the daemon.
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
