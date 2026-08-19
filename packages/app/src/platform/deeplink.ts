/**
 * Collaboration links have exactly two ingress forms:
 *
 * - `ompctl://collab/<roomId>` for custom-scheme delivery;
 * - `https://app.ompctl.ai/collab/<roomId>` for verified iOS Universal Links and
 *   Android App Links.
 *
 * The room id identifies a session but grants no capability. Pairing remains
 * the authority for joining or operating that session, so query strings and
 * fragments are refused rather than becoming an accidental credential channel.
 */

import { parseDeviceCredential, parsePairTarget } from "@ompd/core/pairing";

const COLLAB_HOST = "app.ompctl.ai";
const ROOM_ID = /^[A-Za-z0-9_-]{10,64}$/;

export interface CollabDeepLink {
  roomId: string;
}

/** The native Linking surface, kept structural so web and tests need no native module. */
export interface DeepLinkSource {
  getInitialURL(): Promise<string | null>;
  addEventListener(type: "url", listener: (event: { url: string }) => void): { remove(): void };
}

export type OpenCollabSession = (roomId: string) => void;

/**
 * Recognises only the product-owned link forms. In particular, a URL whose
 * hostname merely contains `app.ompctl.ai` must never become a navigation target.
 */
export function parseCollabDeepLink(raw: string): CollabDeepLink | null {
  // Read from the string for the same reason `parsePairDeepLink` does below:
  // React Native's `URL.hostname` is an http-only regex, so `ompctl://collab/x`
  // reports an empty hostname there and the custom-scheme form could never
  // match on a device. It passed every test, because Bun has a real URL.
  const parts = partsOf(raw);
  if (parts === null) return null;
  if (parts.query.length > 0) return null;

  const segments = parts.path.split("/").filter(Boolean);
  let roomId: string;
  if (parts.scheme === "ompctl:" && parts.authority === "collab") {
    if (segments.length !== 1) return null;
    roomId = segments[0] ?? "";
  } else if (parts.scheme === "https:" && parts.authority === COLLAB_HOST) {
    if (segments.length !== 2 || segments[0] !== "collab") return null;
    roomId = segments[1] ?? "";
  } else {
    return null;
  }

  return ROOM_ID.test(roomId) ? { roomId } : null;
}

/**
 * Pairing links have the same two ingress forms as collaboration links:
 *
 * - `ompctl://pair?token=<token>&hub=<host>&scopes=<a,b>`
 * - `https://app.ompctl.ai/pair?token=<token>&hub=<host>&scopes=<a,b>`
 *
 * `hub` is optional and defaults to the hosted hub. `scopes` is optional
 * too: it is the grant the link's token was minted with, carried so the
 * app's first paint is right rather than optimistic. A link without them
 * keeps today's behaviour (an empty list, which the console reads as "not
 * declared"), so links printed before the parameter existed still pair.
 *
 * Unlike a room id, a token IS a capability, which is why this is the one
 * link form allowed to carry a query: it is the same trust as the QR code
 * the daemon prints, delivered by a different transport, and it is the only
 * way to hand a device its credential without a human retyping 100
 * characters.
 *
 * Neither the scheme nor the authority is read from `URL`: React Native's
 * implementation derives `hostname` with an http-only regex, so
 * `ompctl://pair` reports an empty hostname there and a check against it can
 * only ever fail on device. See `parseEndpoint` in `@ompd/core/pairing`.
 */
export interface PairDeepLink {
  hubUrl: string;
  daemonId: string;
  token: string;
  /** The granted scopes, when the link carries them. Empty means undeclared. */
  scopes: string[];
}

export type OpenPairing = (link: PairDeepLink) => void;

/** Scheme, authority, path, and query, read from the string. */
function partsOf(raw: string): { scheme: string; authority: string; path: string; query: string } | null {
  const trimmed = raw.trim();
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(trimmed);
  if (match === null) return null;
  const after = trimmed.slice(match[0].length);
  const authority = after.split(/[/?#]/, 1)[0] ?? "";
  const rest = after.slice(authority.length);
  const hash = rest.indexOf("#");
  const withoutHash = hash < 0 ? rest : rest.slice(0, hash);
  const q = withoutHash.indexOf("?");
  return {
    scheme: `${(match[1] ?? "").toLowerCase()}:`,
    authority: authority.toLowerCase(),
    path: q < 0 ? withoutHash : withoutHash.slice(0, q),
    query: q < 0 ? "" : withoutHash.slice(q + 1),
  };
}

export function parsePairDeepLink(raw: string): PairDeepLink | null {
  const parts = partsOf(raw);
  if (parts === null) return null;

  const segments = parts.path.split("/").filter(Boolean);
  const custom = parts.scheme === "ompctl:" && parts.authority === "pair" && segments.length === 0;
  const universal =
    parts.scheme === "https:" && parts.authority === "app.ompctl.ai" && segments.length === 1 && segments[0] === "pair";
  if (!custom && !universal) return null;

  const params = new URLSearchParams(parts.query);
  const credential = parseDeviceCredential(params.get("token") ?? "");
  if (credential === null) return null;
  const target = parsePairTarget(params.get("hub") ?? "");
  // A link naming a daemon's own socket is not a pairing this can complete: the
  // credential carries a daemon id, which only means something through a hub.
  if (target === null || target.transport !== "hub") return null;

  // Comma-separated, and only ever a hint: the daemon reports the real grant
  // on hello and the console prefers that answer. Absent stays an empty list
  // so a link printed before scopes were carried pairs exactly as it did.
  const scopes = (params.get("scopes") ?? "")
    .split(",")
    .map(scope => scope.trim())
    .filter(scope => scope.length > 0);

  return { hubUrl: target.hubUrl, daemonId: credential.daemonId, token: credential.token, scopes };
}

/** Routes one untrusted platform URL only when it is a recognised pairing link. */
export function handlePairDeepLink(raw: string, openPairing: OpenPairing): boolean {
  const link = parsePairDeepLink(raw);
  if (link === null) return false;
  openPairing(link);
  return true;
}

/** Routes one untrusted platform URL only when it is a recognised collab link. */
export function handleCollabDeepLink(raw: string, openCollabSession: OpenCollabSession): boolean {
  const link = parseCollabDeepLink(raw);
  if (link === null) return false;
  openCollabSession(link.roomId);
  return true;
}

/**
 * Installs the cold-start and warm-link handlers for every product link form.
 * The returned cleanup is required when the host unmounts.
 */
export function listenForDeepLinks(
  source: DeepLinkSource,
  handlers: { openCollabSession: OpenCollabSession; openPairing: OpenPairing },
): () => void {
  let active = true;
  const route = (url: string): void => {
    // Pairing first: it is the only form that can act on a device that has no
    // connection yet, and the two forms cannot both match one URL.
    if (handlePairDeepLink(url, handlers.openPairing)) return;
    handleCollabDeepLink(url, handlers.openCollabSession);
  };

  void source.getInitialURL().then(
    url => {
      if (active && url !== null) route(url);
    },
    () => {
      // An unavailable initial URL is equivalent to launching without a link.
    },
  );
  const subscription = source.addEventListener("url", ({ url }) => {
    if (active) route(url);
  });

  return () => {
    active = false;
    subscription.remove();
  };
}
