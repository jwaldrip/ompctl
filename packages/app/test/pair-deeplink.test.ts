/**
 * Pairing links, including under React Native's `URL`.
 *
 * The custom-scheme form is the one that could only ever fail on a device:
 * React Native derives `hostname` with an http-only regex, so `ompctl://pair`
 * reports an empty hostname there while Bun reports "pair". A test that only
 * runs against Bun's URL cannot see that, so this file installs a stand-in with
 * React Native's semantics and asserts both forms still parse.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { handlePairDeepLink, parseCollabDeepLink, parsePairDeepLink } from "../src/platform/deeplink.ts";

const BODY = "a".repeat(64);
const DAEMON = `dmn_${BODY}`;
const TOKEN = `${BODY}.tok_abc`;
const RealURL = globalThis.URL;

/** React Native's implementation, reduced to the getters this module could read. */
class ReactNativeURL {
  #url: string;
  constructor(url: string) {
    this.#url = url;
  }
  get protocol(): string {
    const m = this.#url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
    return m ? `${m[1]}:` : "";
  }
  get hostname(): string {
    const m = this.#url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
    return m ? (m[1] ?? "") : "";
  }
  get host(): string {
    return this.hostname;
  }
  get origin(): string {
    return this.hostname.length === 0 ? "null" : `https://${this.hostname}`;
  }
  get pathname(): string {
    const m = this.#url.match(/https?:\/\/[^/]+(\/[^?#]*)?/);
    return m ? (m[1] ?? "/") : "/";
  }
  get search(): string {
    const m = this.#url.match(/\?([^#]*)/);
    return m ? `?${m[1]}` : "";
  }
  get hash(): string {
    const i = this.#url.indexOf("#");
    return i < 0 ? "" : this.#url.slice(i);
  }
}

function withReactNativeUrl<T>(fn: () => T): T {
  globalThis.URL = ReactNativeURL as unknown as typeof URL;
  try {
    return fn();
  } finally {
    globalThis.URL = RealURL;
  }
}

afterEach(() => {
  globalThis.URL = RealURL;
});

describe("parsePairDeepLink", () => {
  test("accepts the custom-scheme and universal-link forms", () => {
    const expected = { hubUrl: "wss://hub.example.com", daemonId: DAEMON, token: "tok_abc", scopes: [] };
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}&hub=hub.example.com`)).toEqual(expected);
    expect(parsePairDeepLink(`https://app.ompctl.ai/pair?token=${TOKEN}&hub=hub.example.com`)).toEqual(expected);
  });

  test("both forms still parse under React Native's URL", () => {
    withReactNativeUrl(() => {
      expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}`)).toEqual({
        hubUrl: "wss://hub.ompctl.ai",
        daemonId: DAEMON,
        token: "tok_abc",
        scopes: [],
      });
      expect(parsePairDeepLink(`https://app.ompctl.ai/pair?token=${TOKEN}`)).not.toBeNull();
      // The collab form shares the same string parsing, and was broken the same way.
      expect(parseCollabDeepLink("ompctl://collab/room_0123456789")).toEqual({ roomId: "room_0123456789" });
    });
  });

  test("an omitted hub means the hosted hub", () => {
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}`)?.hubUrl).toBe("wss://hub.ompctl.ai");
  });

  test("carries the granted scopes, and a link without them still parses", () => {
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}&hub=hub.example.com&scopes=read,prompt`)).toEqual({
      hubUrl: "wss://hub.example.com",
      daemonId: DAEMON,
      token: "tok_abc",
      scopes: ["read", "prompt"],
    });
    // The encoded comma, exactly as the CLI prints the parameter.
    expect(
      parsePairDeepLink(`https://app.ompctl.ai/pair?token=${TOKEN}&scopes=read%2Cprompt%2Capprove`)?.scopes,
    ).toEqual(["read", "prompt", "approve"]);
    // An older link carries no scopes and parses exactly as it always did.
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}&hub=hub.example.com`)?.scopes).toEqual([]);
    // An empty parameter is an empty list, not a parse failure.
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}&scopes=`)?.scopes).toEqual([]);
  });

  test("refuses a lookalike origin, a missing token, and a token naming no daemon", () => {
    expect(parsePairDeepLink(`https://app.ompctl.ai.evil.example/pair?token=${TOKEN}`)).toBeNull();
    expect(parsePairDeepLink("ompctl://pair")).toBeNull();
    expect(parsePairDeepLink("ompctl://pair?token=tok_abc")).toBeNull();
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}&hub=not%20an%20address`)).toBeNull();
  });

  test("refuses a hub that names a daemon socket, which a credential cannot be used through", () => {
    expect(parsePairDeepLink(`ompctl://pair?token=${TOKEN}&hub=ws://10.4.1.221:7777/v1/socket`)).toBeNull();
  });

  test("reports whether an incoming URL was a pairing route", () => {
    const seen: string[] = [];
    expect(handlePairDeepLink(`ompctl://pair?token=${TOKEN}`, link => seen.push(link.daemonId))).toBe(true);
    expect(handlePairDeepLink("ompctl://collab/room_0123456789", link => seen.push(link.daemonId))).toBe(false);
    expect(seen).toEqual([DAEMON]);
  });
});
