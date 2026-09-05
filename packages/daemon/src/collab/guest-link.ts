/**
 * Collab link parsing for the daemon's guest leg.
 *
 * A port of omp's `parseCollabLink`
 * (`packages/coding-agent/src/collab/protocol.ts`), not an import: the daemon
 * speaks the collab wire protocol but does not link the coding agent, the
 * same reason `packages/collab-web` carries its own copy. The grammar must
 * accept every form the host can print, because the bridge hands links back
 * verbatim and an unparseable one is a join that silently never happened.
 *
 * The link is the credential. The 32-byte room key opens every sealed frame
 * in the room; the 16-byte write token appended in a full link is what the
 * host checks before honouring a write. Neither is logged, audited, or
 * persisted here: parsing keeps them in memory only, and the caller drops
 * its reference when the guest leg closes.
 */

/** AES-256-GCM room key length, from the wire spec. */
export const COLLAB_ROOM_KEY_BYTES = 32;
/** Write-token suffix length that makes a full link, from the wire spec. */
export const COLLAB_WRITE_TOKEN_BYTES = 16;

/** The relay a bare `<roomId>.<key>` link resolves against, per the wire spec. */
const DEFAULT_RELAY_URL = "wss://my.omp.sh";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;
const BARE_LINK_RE = /^([A-Za-z0-9_-]{10,64})[#.]([A-Za-z0-9_-]+)$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
export const LOCAL_HOSTNAMES: Record<string, true> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };

export interface ParsedCollabLink {
  /** ws(s)://host[:port]/r/<roomId>, no query, no fragment. */
  wsUrl: string;
  roomId: string;
  key: Uint8Array;
  /** Write token from a full link; absent for a view-only (view) link. */
  writeToken?: Uint8Array;
}

/** Normalize a relay base URL (ws/wss/http/https) into a ws/wss origin, or an error. */
function normalizeRelayOrigin(relayUrl: string): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return { error: `Invalid relay URL: ${relayUrl}` };
  }
  let scheme: string;
  switch (url.protocol) {
    case "wss:":
    case "https:":
      scheme = "wss:";
      break;
    case "ws:":
    case "http:":
      scheme = "ws:";
      break;
    default:
      return { error: `Unsupported relay URL scheme: ${url.protocol}` };
  }
  // Plain ws carries the sealed frames fine, but a room id in the path is
  // still a capability, so off-machine relays stay encrypted at the
  // transport too. The daemon's own relay is loopback, where ws is the
  // supported shape per the wire spec.
  if (scheme === "ws:" && LOCAL_HOSTNAMES[url.hostname] !== true) {
    return { error: "relay link must be wss:// (plain ws:// is only allowed for localhost)" };
  }
  const port = url.port ? `:${url.port}` : "";
  return { origin: `${scheme}//${url.hostname}${port}` };
}

/**
 * Parse any accepted collab link form into its relay URL, room id, and key
 * material. Mirrors the host's grammar exactly: bare links resolve against
 * the default relay, scheme-less hosts infer wss, http(s) wrappers recurse
 * into a parseable fragment first, and the room secret accepts both the
 * dot-joined form and the legacy `#` (including its `%23` mangling).
 */
export function parseCollabLink(link: string): ParsedCollabLink | { error: string } {
  // Lenient input: terminals that open OSC 8 links through strict URL stacks
  // (macOS Foundation) percent-encode the legacy second `#` to `%23`.
  let text = link.trim().replace(/%23/gi, "#");
  // Bare `<roomId>.<key>` (legacy `<roomId>#<key>`) → default relay.
  const bare = BARE_LINK_RE.exec(text);
  if (bare) text = `${DEFAULT_RELAY_URL}/r/${bare[1]}.${bare[2]}`;
  // Scheme-less `host[:port]/r/…` → wss.
  else if (!text.includes("://")) text = `wss://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `Invalid collab link: ${link}` };
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && url.hash) {
    const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const parsed = parseCollabLink(inner);
    if (!("error" in parsed)) return parsed;
  }
  const normalized = normalizeRelayOrigin(url.origin);
  if ("error" in normalized) return normalized;
  const match = ROOM_PATH_RE.exec(url.pathname);
  if (!match) {
    // Non-http(s) deep links may also carry a complete collab link in the
    // fragment. http(s) links are handled once above so invalid fragments
    // fall through to direct relay validation instead of double-recursing.
    const inner = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (inner && url.protocol !== "http:" && url.protocol !== "https:") return parseCollabLink(inner);
    return { error: "Collab link must contain a /r/<roomId> path" };
  }
  const roomId = match[1]!;
  // Key rides dot-joined in the path (`/r/<roomId>.<key>`); legacy links
  // carry it in the fragment (`/r/<roomId>#<key>`).
  const fragment = match[2] ?? (url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  if (!fragment) {
    return { error: "Collab link is missing the <key> part" };
  }
  const secret = B64URL_RE.test(fragment) ? new Uint8Array(Buffer.from(fragment, "base64url")) : null;
  if (
    !secret ||
    (secret.byteLength !== COLLAB_ROOM_KEY_BYTES &&
      secret.byteLength !== COLLAB_ROOM_KEY_BYTES + COLLAB_WRITE_TOKEN_BYTES)
  ) {
    return { error: "Collab link key must be 32 (view) or 48 (full) base64url bytes" };
  }
  const key = secret.subarray(0, COLLAB_ROOM_KEY_BYTES);
  const writeToken = secret.byteLength > COLLAB_ROOM_KEY_BYTES ? secret.subarray(COLLAB_ROOM_KEY_BYTES) : undefined;
  return { wsUrl: `${normalized.origin}/r/${roomId}`, roomId, key, writeToken };
}
