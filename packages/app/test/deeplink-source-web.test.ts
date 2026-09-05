import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom) {
  GlobalRegistrator.register();
  (globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom = true;
}

import {
  nativeDeepLinks,
  resetInitialUrlReadForTesting,
} from "../src/platform/deeplink-source.web.ts";

describe("deeplink-source.web", () => {
  beforeEach(() => {
    resetInitialUrlReadForTesting();
  });

  test("getInitialURL delivers the initial URL once and scrubs search and fragment from location", async () => {
    window.location.href = "https://app.ompctl.ai/pair?hub=hub.ompctl.ai#token=secret-cred-123";
    expect(window.location.search).toBe("?hub=hub.ompctl.ai");
    expect(window.location.hash).toBe("#token=secret-cred-123");

    const first = await nativeDeepLinks.getInitialURL();
    expect(first).toBe("https://app.ompctl.ai/pair?hub=hub.ompctl.ai#token=secret-cred-123");

    // Address bar scrubbed: both query parameters and fragment removed
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/pair");

    // Delivered only once: subsequent calls return null
    const second = await nativeDeepLinks.getInitialURL();
    expect(second).toBeNull();
  });

  test("addEventListener is a clean no-op returning a removable subscription", () => {
    let called = false;
    const sub = nativeDeepLinks.addEventListener("url", () => {
      called = true;
    });
    expect(sub).toBeDefined();
    expect(typeof sub.remove).toBe("function");
    sub.remove();
    expect(called).toBe(false);
  });
});
