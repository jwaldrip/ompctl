/**
 * Where a device connects, as a value both ends can print and parse.
 *
 * The phone shipped unusable for a reason that had nothing to do with the
 * phone: the app suggested `ws://127.0.0.1:7777/v1/socket`, and on a phone
 * loopback is the phone. The operator was expected to already know the
 * daemon's address. The daemon is the only thing that knows it, so the daemon
 * says it, and this file is the shape of what it says.
 *
 * ## Deliberately no credential
 *
 * An endpoint is not a secret and nothing here carries one. The bearer token
 * stays where `ompd approve` puts it: printed once, copied by the operator,
 * typed into its own field. Putting it in a URL alongside the address would
 * read as convenient and would push a long-lived credential through clipboard
 * history, shell history, and -- once anything registers this scheme -- OS
 * deep-link dispatch, all of which are logged in places a token should never
 * be. The pairing code is not a substitute either: it is short by design and
 * authorizes nothing, and a device that could spend one to collect a token
 * would have turned six digits into a credential.
 *
 * So this is an address, the operator remains the one who hands over the
 * credential, and the two halves stay separate.
 *
 * ## Two transports, because there are two situations
 *
 * `direct` is a websocket the device opens itself: loopback for a client on
 * the same machine, a LAN address for a phone on the same network. `hub` is a
 * daemon reached through a relay it dialled out to, which is the only thing
 * that works when the laptop is behind NAT. A hub endpoint is not a URL the
 * client opens: it is a hub base plus the daemon's pinned fingerprint, because
 * the session inside it is sealed to that daemon and the relay is not a party
 * to it. See `docs/hub.md`.
 */

/** Scheme both endpoint forms share. */
export const ENDPOINT_SCHEME = "ompd:";

export type Endpoint = { transport: "direct"; url: string } | { transport: "hub"; hubUrl: string; daemonId: string };

/** How far an endpoint reaches, which is the only thing an operator picking one cares about. */
export type EndpointReach = "same-machine" | "same-network" | "anywhere";

export interface EndpointOffer {
  endpoint: Endpoint;
  reach: EndpointReach;
  /** Why this one, in the words a chooser needs: what it reaches and what it does not. */
  note: string;
}

/** Schemes a direct endpoint may name. Anything else is not a daemon socket. */
const SOCKET_SCHEMES: Record<string, true> = { "ws:": true, "wss:": true };

/** Schemes a hub base may name. `ws:` is allowed for a local hub under test. */
const HUB_SCHEMES: Record<string, true> = { "ws:": true, "wss:": true };

/** The hosted hub. An operator who does not run their own never types this. */
export const DEFAULT_HUB_HOST = "hub.ompctl.ai";
export const DEFAULT_HUB_URL = `wss://${DEFAULT_HUB_HOST}`;

/**
 * Where a device should connect, from the one line an operator typed.
 *
 * The daemon's identity is deliberately NOT here: it travels inside the
 * credential, because the daemon is the only party that knows it and the
 * operator should not have to copy a fingerprint by hand. That leaves this
 * field with one job, and an empty one means the hosted hub -- which is the
 * common case, so the common case is typing nothing.
 *
 * A bare host is accepted because that is how a hub is written down. A
 * websocket URL carrying a path is a direct daemon socket instead: only a
 * daemon exposes `/v1/socket`, and a hub base never has a path, so the two are
 * distinguishable without asking the operator which they meant.
 */
export type PairTarget = { transport: "hub"; hubUrl: string } | { transport: "direct"; url: string };

export function parsePairTarget(raw: string): PairTarget | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { transport: "hub", hubUrl: DEFAULT_HUB_URL };

  if (schemeOf(trimmed).length === 0) {
    // A host, optionally with a port. Anything else typed without a scheme is
    // not an address and is refused rather than guessed at.
    if (!/^[a-zA-Z0-9.-]+(?::\d+)?$/.test(trimmed)) return null;
    return { transport: "hub", hubUrl: `wss://${trimmed}` };
  }

  if (!isHubUrl(trimmed)) return null;
  const authority = authorityOf(trimmed);
  const rest = trimmed.slice(trimmed.indexOf(authority) + authority.length);
  const path = rest.split(/[?#]/, 1)[0] ?? "";
  if (path.length > 1) return { transport: "direct", url: trimmed };
  return { transport: "hub", hubUrl: normalizeHubUrl(trimmed) };
}

/**
 * The single secret a device is handed: which daemon, and the proof it may
 * speak for this device there.
 *
 * One field rather than two because the daemon id is not something an operator
 * can be expected to retype, and splitting it across the form is what made
 * pairing by hand unusable: the endpoint grew to 110 characters and carried a
 * 68-character fingerprint. The id is not secret, but it belongs with the
 * thing the daemon issues, so the daemon issues both together.
 */
export interface DeviceCredential {
  daemonId: string;
  token: string;
}

/** `dmn_` + the full SHA-256 of the daemon's public key, hex. */
const DAEMON_ID_BODY = /^[0-9a-f]{64}$/;
const DAEMON_ID_PREFIX = "dmn_";
const CREDENTIAL_SEPARATOR = ".";

/** The credential as one pasteable string. The `dmn_` prefix is implied. */
export function formatDeviceCredential(credential: DeviceCredential): string {
  const body = credential.daemonId.startsWith(DAEMON_ID_PREFIX)
    ? credential.daemonId.slice(DAEMON_ID_PREFIX.length)
    : credential.daemonId;
  return `${body}${CREDENTIAL_SEPARATOR}${credential.token}`;
}

/** The inverse, or null for anything that is not one. */
export function parseDeviceCredential(raw: string): DeviceCredential | null {
  const trimmed = raw.trim();
  const split = trimmed.indexOf(CREDENTIAL_SEPARATOR);
  if (split <= 0) return null;
  const body = trimmed.slice(0, split).toLowerCase();
  const token = trimmed.slice(split + 1);
  if (!DAEMON_ID_BODY.test(body) || token.length === 0) return null;
  return { daemonId: `${DAEMON_ID_PREFIX}${body}`, token };
}

export function encodeEndpoint(endpoint: Endpoint): string {
  if (endpoint.transport === "direct") return endpoint.url;
  const params = new URLSearchParams({ url: endpoint.hubUrl, daemon: endpoint.daemonId });
  return `ompd://hub?${params.toString()}`;
}

/**
 * A pasted or typed string to an endpoint, or null.
 *
 * Null for anything not usable, because this is the door untrusted input comes
 * through. A bare websocket URL is a direct endpoint, which is what an
 * operator copying one line from `ompd approve` will paste. An `https://` page
 * is refused rather than coerced: it is not a socket, and treating one as an
 * endpoint is how a bearer token ends up posted to a website.
 */
export function parseEndpoint(raw: string): Endpoint | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  // Nothing on this path may touch `URL`.
  //
  // React Native's `URL` is not a WHATWG implementation. Its `host` getter is
  // `/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/` and its `protocol` getter is derived
  // the same http/https-only way, so for `ompd:` and `wss:` -- the two schemes
  // this module exists to validate -- both come back empty. Bun has a real
  // `URL`, so every test and every check run on a laptop passed while the
  // shipped app rejected a byte-exact hub endpoint with "Not a daemon
  // endpoint", which made hub pairing impossible to enter by hand. Reading the
  // scheme, authority, and query out of the string is the same work with no
  // dependency on whose `URL` is present.
  if (schemeOf(trimmed) === ENDPOINT_SCHEME) {
    // Checking the authority keeps a future `ompd://something-else` from being
    // read as a hub endpoint.
    if (authorityOf(trimmed) !== "hub") return null;
    const params = queryOf(trimmed);
    const hubUrl = params.get("url");
    const daemonId = params.get("daemon");
    if (hubUrl === null || daemonId === null) return null;
    if (daemonId.length === 0 || !isHubUrl(hubUrl)) return null;
    // A credential must never ride along, so one that does is a refusal
    // rather than something to quietly drop: the operator pasted something
    // they believe carries their token, and silently discarding it would
    // leave them with a connection that fails to authenticate later.
    if (params.has("token")) return null;
    return { transport: "hub", hubUrl: normalizeHubUrl(hubUrl), daemonId };
  }

  if (!isSocketUrl(trimmed)) return null;
  return { transport: "direct", url: trimmed };
}

/** Whether `value` is a websocket endpoint a device may open directly. */
export function isSocketUrl(value: string): boolean {
  return SOCKET_SCHEMES[schemeOf(value)] === true && namesAHost(value);
}

/** Whether `value` is a usable hub base. */
export function isHubUrl(value: string): boolean {
  return HUB_SCHEMES[schemeOf(value)] === true && namesAHost(value);
}

/**
 * The scheme of a URL, read from the string, lowercased and including the colon.
 *
 * Not from `URL.protocol`: see `parseEndpoint` for why that getter cannot be
 * trusted on device for anything but http and https.
 *
 * `://` is required, not just the colon. A dot and a digit are both legal
 * scheme characters, so `hub.example.com:8443` matches a colon-only pattern and
 * a bare host with a port would be read as a scheme called `hub.example.com`.
 * Every scheme this module handles is hierarchical, so demanding the slashes
 * costs nothing and removes that whole class of misread.
 */
function schemeOf(value: string): string {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(value.trim());
  return match === null ? "" : `${(match[1] ?? "").toLowerCase()}:`;
}

/**
 * The query of a URL as parameters, read from the string.
 *
 * `URLSearchParams` is safe to use here where `URL` is not: React Native ships
 * a real one that parses a raw query string, and it is reached directly rather
 * than through the `URL.searchParams` getter.
 */
function queryOf(value: string): URLSearchParams {
  const trimmed = value.trim();
  const start = trimmed.indexOf("?");
  if (start < 0) return new URLSearchParams();
  const hash = trimmed.indexOf("#", start);
  return new URLSearchParams(hash < 0 ? trimmed.slice(start + 1) : trimmed.slice(start + 1, hash));
}

/**
 * Whether the string itself names a host, read before the URL parser gets it.
 *
 * `new URL("ws:///v1/socket")` does not fail and does not leave the host
 * empty: it takes the first path segment, so that string silently becomes a
 * connection to a host called `v1`. An operator who typed it plainly left the
 * address out. Checking the written authority is what keeps a typo from
 * becoming a connection somewhere nobody named.
 */
/**
 * The authority of a URL, read from the string.
 *
 * Not from `URL.host`, deliberately. React Native's `URL` is not a WHATWG
 * implementation and its `host` getter is hardcoded to http and https, so it
 * returns "" for every other scheme -- including the `ompd:` endpoint form and
 * the `wss:` hub URLs this module exists to validate.
 */
function authorityOf(value: string): string {
  const trimmed = value.trim();
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(trimmed);
  if (scheme === null) return "";
  return trimmed.slice(scheme[0].length).split(/[/?#]/, 1)[0] ?? "";
}

function namesAHost(value: string): boolean {
  return authorityOf(value).length > 0;
}

/**
 * A hub base with any trailing slash removed.
 *
 * `TunnelSocket` appends `/v1/link/<id>` to whatever it is given, so a base
 * ending in `/` produces a double slash that some proxies route and others
 * 404. Normalizing once here means neither end has to remember.
 */
export function normalizeHubUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** One line naming an endpoint, for a CLI listing or a device's status row. */
export function describeEndpoint(endpoint: Endpoint): string {
  return endpoint.transport === "direct" ? endpoint.url : `${endpoint.hubUrl} (daemon ${endpoint.daemonId})`;
}

/**
 * A completed pairing, ready to save without another network round trip.
 *
 * Unlike `Endpoint`, this carries the bearer token -- which is exactly why it
 * is never encoded as a `http(s)://` or `ompd://`/`ompctl://` URL. A token in
 * a URL rides through OS deep-link dispatch (Universal Links validation,
 * Android intent resolution, Handoff, Siri Suggestions indexing, share
 * sheets), all of which log or index it somewhere a long-lived credential
 * should never sit -- the same reasoning `Endpoint` above already rejects for
 * its own, non-secret case. `BUNDLE_PREFIX` is deliberately not a registered
 * URL scheme: no OS treats it as a link, so scanning one only ever reaches
 * this app's own in-app QR reader, never the OS deep-link path.
 *
 * A `PairingBundle` is minted by a device that already holds `approve` scope
 * -- the CLI (`ompd approve` / `ompd invite`) for a device's first pairing,
 * or an already-paired app for a second device -- immediately after that
 * device's own deliberate approval decision. It is never produced from an
 * unauthenticated pairing code by itself.
 */
export type PairedConnection =
  | { transport: "direct"; url: string; token: string; scopes: string[] }
  | { transport: "hub"; hubUrl: string; daemonId: string; token: string; scopes: string[] };

export interface PairingBundle {
  v: 1;
  /** The device name the approver chose, shown on the scanning side before it saves anything. */
  label: string;
  connection: PairedConnection;
}

/** Marks a scanned/pasted string as a pairing bundle, not a URL. See `PairingBundle` above. */
export const BUNDLE_PREFIX = "ompd-pair-v1:";

/** Render a bundle for a QR code or terminal display. Opaque text, not a link. */
export function encodePairingBundle(bundle: PairingBundle): string {
  return BUNDLE_PREFIX + toBase64Url(toUtf8(JSON.stringify(bundle)));
}

/** The inverse of `encodePairingBundle`, or null for anything malformed or foreign. */
export function parsePairingBundle(raw: string): PairingBundle | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(BUNDLE_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(fromBase64Url(trimmed.slice(BUNDLE_PREFIX.length))));
  } catch {
    return null;
  }
  return coercePairingBundle(parsed);
}

function coercePairingBundle(value: unknown): PairingBundle | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.label !== "string") return null;
  const connection = coercePairedConnection(v.connection);
  if (connection === null) return null;
  return { v: 1, label: v.label, connection };
}

function coercePairedConnection(value: unknown): PairedConnection | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.token !== "string" || c.token.length === 0) return null;
  if (!Array.isArray(c.scopes) || !c.scopes.every(s => typeof s === "string")) return null;
  const scopes = c.scopes as string[];
  if (c.transport === "direct" && typeof c.url === "string" && isSocketUrl(c.url)) {
    return { transport: "direct", url: c.url, token: c.token, scopes };
  }
  if (
    c.transport === "hub" &&
    typeof c.hubUrl === "string" &&
    isHubUrl(c.hubUrl) &&
    typeof c.daemonId === "string" &&
    c.daemonId.length > 0
  ) {
    return { transport: "hub", hubUrl: normalizeHubUrl(c.hubUrl), daemonId: c.daemonId, token: c.token, scopes };
  }
  return null;
}

/** Portable base64url, without assuming `Buffer` (Bun/CLI) or `btoa` (Hermes/app) exist. */
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? "" : B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? "" : B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const index = B64URL_ALPHABET.indexOf(ch);
    if (index === -1) continue;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}
