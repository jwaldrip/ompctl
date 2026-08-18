/**
 * `parseEndpoint` under React Native's `URL`, which is not the one Bun has.
 *
 * Every other test in this repo runs against a real WHATWG `URL`, which is why a
 * hub endpoint that could never be entered on a phone passed the whole suite and
 * a check run on a laptop. React Native ships its own `URL` whose `host` getter
 * is literally `/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/` -- hardcoded to http and
 * https -- so it returns "" for `ompd:` and for `wss:`. `parseEndpoint` compared
 * that against "hub" and rejected every hub endpoint, and the pairing screen
 * showed "Not a daemon endpoint" for a byte-exact one.
 *
 * So this file installs a stand-in with those semantics and asserts the parser
 * does not depend on them. It is the only place the difference is observable
 * without a device.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isHubUrl, isSocketUrl, parseEndpoint } from "../src/pairing.ts";

const RealURL = globalThis.URL;

/**
 * React Native's implementation, reduced to the getters this module reads.
 *
 * `protocol`, `search`, and `searchParams` are derived generically there and are
 * reproduced faithfully; `host` carries the http-only regex verbatim, because
 * that is the whole point of the test.
 */
class ReactNativeURL {
  #url: string;
  constructor(url: string) {
    // RN accepts anything with a scheme and does no validation beyond that.
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url)) throw new TypeError(`Invalid URL: ${url}`);
    this.#url = url;
  }
  get protocol(): string {
    const m = this.#url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
    return m ? `${m[1]}:` : "";
  }
  get host(): string {
    const hostMatch = this.#url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
    const portMatch = this.#url.match(/:(\d+)(?=[/?#]|$)/);
    return hostMatch ? hostMatch[1] + (portMatch ? `:${portMatch[1]}` : "") : "";
  }
  get search(): string {
    const m = this.#url.match(/\?([^#]*)/);
    return m ? `?${m[1]}` : "";
  }
  get searchParams(): URLSearchParams {
    return new URLSearchParams(this.search);
  }
}

function withReactNativeUrl<T>(fn: () => T): T {
  // @ts-expect-error deliberately substituting a narrower implementation
  globalThis.URL = ReactNativeURL;
  try {
    return fn();
  } finally {
    globalThis.URL = RealURL;
  }
}

afterEach(() => {
  globalThis.URL = RealURL;
});

const DAEMON = `dmn_${"a".repeat(64)}`;
const HUB = "wss://hub.example.com";

describe("parseEndpoint under React Native's URL", () => {
  test("the stand-in really does drop the host for non-http schemes", () => {
    // Guards the test itself: if RN ever fixes `host`, this fails and says so
    // rather than leaving a test that proves nothing.
    withReactNativeUrl(() => {
      expect(new URL(`ompd://hub?url=${HUB}&daemon=${DAEMON}`).host).toBe("");
      expect(new URL("https://example.com/x").host).toBe("example.com");
    });
  });

  test("a hub endpoint still parses", () => {
    const endpoint = withReactNativeUrl(() => parseEndpoint(`ompd://hub?url=${HUB}&daemon=${DAEMON}`));
    expect(endpoint).not.toBeNull();
    expect(endpoint?.transport).toBe("hub");
    if (endpoint?.transport === "hub") {
      expect(endpoint.hubUrl).toBe(HUB);
      expect(endpoint.daemonId).toBe(DAEMON);
    }
  });

  test("a percent-encoded hub url still parses", () => {
    const encoded = `ompd://hub?url=${encodeURIComponent(HUB)}&daemon=${DAEMON}`;
    const endpoint = withReactNativeUrl(() => parseEndpoint(encoded));
    expect(endpoint?.transport).toBe("hub");
  });

  test("a direct socket endpoint still parses", () => {
    const endpoint = withReactNativeUrl(() => parseEndpoint("ws://10.0.0.5:7777/v1/socket"));
    expect(endpoint?.transport).toBe("direct");
  });

  test("a wss hub url and a ws socket url are still recognised", () => {
    withReactNativeUrl(() => {
      expect(isHubUrl(HUB)).toBe(true);
      expect(isSocketUrl("ws://10.0.0.5:7777/v1/socket")).toBe(true);
    });
  });

  test("another authority under the same scheme is still refused", () => {
    // The check this replaced existed to stop `ompd://something-else` reading as
    // a hub endpoint, so that has to survive the fix.
    const endpoint = withReactNativeUrl(() => parseEndpoint(`ompd://elsewhere?url=${HUB}&daemon=${DAEMON}`));
    expect(endpoint).toBeNull();
  });

  test("an endpoint carrying a token is still refused", () => {
    const endpoint = withReactNativeUrl(() =>
      parseEndpoint(`ompd://hub?url=${HUB}&daemon=${DAEMON}&token=should-not-ride-along`),
    );
    expect(endpoint).toBeNull();
  });
});
