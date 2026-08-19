/**
 * Core's pairing decode has to work where `TextDecoder` does not exist.
 *
 * Same defect as the tunnel's, same cause: `fromUtf8` here called
 * `@noble/ciphers`'s `bytesToUtf8`, which is `new TextDecoder().decode(bytes)`.
 * The comment above it claimed portability, the tests passed under Bun, and a
 * phone scanning a pairing bundle threw.
 *
 * These go through the public API rather than the private helper, because
 * `parsePairingBundle` is what a device actually calls when the operator scans
 * a QR code or pastes a bundle, and that is the path that has to survive a
 * runtime with no decoder. The runtime modelled is Hermes as it is:
 * `TextEncoder` present, `TextDecoder` absent.
 *
 * The vector table mirrors `packages/tunnel/test/utf8-portability.test.ts`,
 * which is what keeps the two byte-identical copies of the decoder honest.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { encodePairingBundle, type PairingBundle, parsePairingBundle } from "../src/pairing.ts";

const LABELS: readonly { label: string; text: string }[] = [
  { label: "ascii", text: "Pixel 7" },
  { label: "two-byte", text: "Jasón's café phone" },
  { label: "three-byte", text: "日本語の電話" },
  { label: "four-byte astral", text: "phone 🚀🔒" },
  { label: "astral across the batch boundary", text: `${"a".repeat(4095)}🚀` },
];

function bundleWith(label: string): PairingBundle {
  return {
    v: 1,
    label,
    connection: {
      transport: "hub",
      hubUrl: "wss://hub.example.com",
      daemonId: `dmn_${"a".repeat(64)}`,
      token: "tok_portability",
      scopes: ["read", "prompt"],
    },
  } as PairingBundle;
}

describe("parsePairingBundle on a runtime with no TextDecoder", () => {
  const saved = globalThis.TextDecoder;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, "TextDecoder");
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "TextDecoder", { value: saved, configurable: true, writable: true });
  });

  for (const { label, text } of LABELS) {
    test(`round trips a bundle whose label is ${label}`, () => {
      // Encoding is fine on device: Hermes has `TextEncoder`. Decoding is the
      // step that threw, so the encode happens here and the decode is the test.
      const encoded = encodePairingBundle(bundleWith(text));
      const parsed = parsePairingBundle(encoded);
      expect(parsed).not.toBeNull();
      expect(parsed?.label).toBe(text);
    });
  }

  test("malformed base64 is still a null rather than a throw", () => {
    expect(parsePairingBundle("ompd-pair-v1:!!!not-base64!!!")).toBeNull();
  });
});
