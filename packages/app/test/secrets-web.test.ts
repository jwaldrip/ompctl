import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom) {
  GlobalRegistrator.register();
  (globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom = true;
}

import {
  deleteSecret,
  readSecret,
  SECRETS_PERSIST_ACROSS_LAUNCHES,
  writeSecret,
} from "../src/platform/secrets.web.ts";

describe("secrets.web", () => {
  const originalStorage = globalThis.localStorage;

  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalStorage,
      writable: true,
      configurable: true,
    });
  });

  test("SECRETS_PERSIST_ACROSS_LAUNCHES is true on web", () => {
    expect(SECRETS_PERSIST_ACROSS_LAUNCHES).toBe(true);
  });

  test("writeSecret writes directly to localStorage under the key", async () => {
    const key = "ompd.connection.token.test-1";
    const value = "secret-token-abc";
    await writeSecret(key, value);

    expect(globalThis.localStorage.getItem(key)).toBe(value);
    expect(await readSecret(key)).toBe(value);
  });

  test("readSecret reads values placed in localStorage", async () => {
    const key = "ompd.connection.token.test-2";
    const value = "external-token-xyz";
    globalThis.localStorage.setItem(key, value);

    expect(await readSecret(key)).toBe(value);
  });

  test("deleteSecret removes value from localStorage", async () => {
    const key = "ompd.connection.token.test-3";
    await writeSecret(key, "to-be-deleted");
    expect(globalThis.localStorage.getItem(key)).toBe("to-be-deleted");

    await deleteSecret(key);
    expect(globalThis.localStorage.getItem(key)).toBeNull();
    expect(await readSecret(key)).toBeNull();
  });

  test("written secret survives a fresh dynamic module import", async () => {
    const key = "ompd.connection.token.reload-test";
    const value = "persistent-token-12345";
    await writeSecret(key, value);

    // Test case intentionally exercises module loading boundary to simulate page reload.
    const reloaded = await import(`../src/platform/secrets.web.ts?bust=${Date.now()}`);
    expect(await reloaded.readSecret(key)).toBe(value);
  });

  test("writeSecret rejects when setItem throws (quota or security denial)", async () => {
    const throwingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError: DOM storage quota exceeded");
      },
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    };

    Object.defineProperty(globalThis, "localStorage", {
      value: throwingStorage,
      writable: true,
      configurable: true,
    });

    let caughtError: Error | null = null;
    try {
      await writeSecret("ompd.connection.token.fail", "secret");
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain("localStorage write failed");
    expect(caughtError?.message).toContain("QuotaExceededError");
  });

  test("writeSecret rejects and readSecret returns null when localStorage access throws", async () => {
    Object.defineProperty(globalThis, "localStorage", {
      get() {
        throw new Error("SecurityError: storage access denied");
      },
      configurable: true,
    });

    let caughtError: Error | null = null;
    try {
      await writeSecret("ompd.connection.token.denied", "secret");
    } catch (err) {
      caughtError = err as Error;
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain("storage refused to store secret");
    expect(caughtError?.message).toContain("SecurityError");

    expect(await readSecret("ompd.connection.token.denied")).toBeNull();
  });
});
