/**
 * Tests for the Hermes surface gate itself.
 *
 * The gate's scenarios prove the client paths; these prove the gate. A surface
 * installer that quietly stopped deleting a global, or a restore that leaked
 * the phone's globals into the rest of the suite, would turn every later ok
 * into a vacuous pass, which is the one failure mode worse than not checking:
 * `check-hermes-surface.ts` would keep reporting green while proving nothing.
 *
 * The historical failure strings are asserted verbatim because
 * `explainSurface` exists to name the global from whatever phrasing the
 * runtime produced: Bun says `ReferenceError: TextDecoder is not defined`,
 * Hermes said `Property 'TextDecoder' doesn't exist`, and both have to land on
 * the same explanation or the operator-facing report regresses to a shrug.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { explainSurface, installHermesSurface } from "./check-hermes-surface.ts";

let restore: (() => void) | null = null;

beforeEach(() => {
  restore = installHermesSurface();
});

afterEach(() => {
  restore?.();
  restore = null;
});

describe("the installed surface", () => {
  test("deletes what the phone lacks", () => {
    expect(typeof TextDecoder).toBe("undefined");
    expect(typeof Buffer).toBe("undefined");
  });

  test("keeps what the phone has", () => {
    // TextEncoder is present on Hermes; deleting it would be stricter than
    // the device and would fail legitimate encoding.
    expect(typeof TextEncoder).toBe("function");
    expect(new TextEncoder().encode("señal").length).toBe(6);
  });

  test("crypto carries getRandomValues and nothing else", () => {
    expect(typeof globalThis.crypto.getRandomValues).toBe("function");
    expect(globalThis.crypto.subtle).toBeUndefined();
    // Randomness stays real under the model: two draws differ, because a
    // broken CSPRNG stand-in would make the handshake pass for a reason no
    // device can offer.
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const first = Array.from(bytes);
    globalThis.crypto.getRandomValues(bytes);
    expect(Array.from(bytes)).not.toEqual(first);
  });

  test("a dependency-style TextDecoder reach throws, the device's failure shape", () => {
    // `@noble/ciphers`'s bytesToUtf8 is literally this body. A stubbed
    // (rather than deleted) global would return undefined here and let the
    // defect class slip through unthrown.
    const bytesToUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
    expect(() => bytesToUtf8(new Uint8Array([104, 105]))).toThrow();
  });

  test("URL lies the way React Native's does", () => {
    expect(new URL("wss://hub.ompctl.ai").host).toBe("");
    expect(new URL("wss://hub.ompctl.ai").hostname).toBe("");
    expect(new URL("https://hub.ompctl.ai/x").host).toBe("hub.ompctl.ai");
    expect((URL as unknown as { parse?: unknown }).parse).toBeUndefined();
    // The append lie: a stripped token must survive in the URL.
    const url = new URL("https://h.test/l?token=secret&x=1");
    url.searchParams.delete("token");
    expect(url.toString()).toContain("token=secret");
  });

  test("restores Bun's globals completely", () => {
    const before = {
      decoder: typeof TextDecoder,
      buffer: typeof Buffer,
      subtle: typeof globalThis.crypto.subtle,
      host: new URL("wss://hub.ompctl.ai").host,
    };
    restore?.();
    restore = null;
    expect(typeof TextDecoder).toBe("function");
    expect(typeof Buffer).toBe("function");
    expect(typeof globalThis.crypto.subtle).toBe("object");
    expect(new URL("wss://hub.ompctl.ai").host).toBe("hub.ompctl.ai");
    // What the surface looked like while installed, asserted after the fact
    // so the restore itself is the code under test.
    expect(before).toEqual({ decoder: "undefined", buffer: "undefined", subtle: "undefined", host: "" });
  });
});

describe("explainSurface", () => {
  test("names TextDecoder from both runtimes' phrasings", () => {
    expect(explainSurface(new ReferenceError("TextDecoder is not defined"))).toContain("TextDecoder");
    expect(explainSurface(new Error("Property 'TextDecoder' doesn't exist"))).toContain("TextDecoder");
    expect(explainSurface(new Error("Property 'TextDecoder' doesn't exist"))).toContain("TextEncoder IS present");
  });

  test("names the WebCrypto family the phone never had", () => {
    const explained = explainSurface(new TypeError("Cannot read properties of undefined (reading 'importKey')"));
    expect(explained).toContain("WebCrypto");
  });

  test("names Buffer", () => {
    expect(explainSurface(new ReferenceError("Buffer is not defined"))).toContain("Buffer is absent");
  });

  test("names the URLSearchParams gap by its current truth", () => {
    const explained = explainSurface(new TypeError("params.delete is not a function"));
    expect(explained).toContain("toString() composes by append");
  });

  test("labels an unrecognised shape rather than guessing", () => {
    expect(explainSurface(new Error("something novel"))).toContain("unrecognised failure shape");
  });
});
