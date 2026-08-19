/**
 * The decoder has to work where `TextDecoder` does not exist.
 *
 * This is the test that was missing. The tunnel's UTF-8 decode was "made
 * portable" by importing `bytesToUtf8` from `@noble/ciphers`, which is exactly
 * `new TextDecoder().decode(bytes)`. Under Bun that passes every time. On a
 * phone it threw `Property 'TextDecoder' doesn't exist` inside the handshake,
 * so the sealed session never confirmed, the client reconnected forever, and
 * the operator saw an empty console reading "websocket error".
 *
 * The runtime modelled here is Hermes as it actually is: `TextEncoder` present,
 * `TextDecoder` absent. Deleting both would be stricter than the device and
 * would fail on key derivation, which legitimately encodes. Only the decoder is
 * missing, so only the decoder is removed.
 *
 * A grep for the identifier could not have caught this, because the call lived
 * inside a dependency. Running the real path with the global gone is what can.
 *
 * `packages/core/test/utf8-portability.test.ts` runs the same table against
 * core's byte-identical copy, which is what keeps the two from drifting.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { fromUtf8 } from "../src/bytes.ts";
import { deriveChannelKeys, SealedChannel } from "../src/channel.ts";

/** Well-formed inputs, where a decoder must produce exactly the original text. */
const WELL_FORMED: readonly { label: string; text: string }[] = [
  { label: "empty", text: "" },
  { label: "ascii", text: "hello, daemon" },
  { label: "two-byte", text: "café £ ¿qué?" },
  { label: "three-byte", text: "日本語テキスト" },
  { label: "four-byte astral", text: "🚀🔒👋" },
  { label: "mixed json", text: '{"t":"sessions","rows":[{"title":"café 日本 🚀"}]}' },
  { label: "astral across the batch boundary", text: `${"a".repeat(4095)}🚀${"b".repeat(10)}` },
  { label: "long ascii past one batch", text: "x".repeat(9000) },
];

/** Ill-formed inputs, where the contract is a replacement char and no throw. */
const ILL_FORMED: readonly { label: string; bytes: number[] }[] = [
  { label: "lone continuation byte", bytes: [0x80] },
  { label: "truncated three-byte", bytes: [0xe6, 0x97] },
  { label: "truncated four-byte", bytes: [0xf0, 0x9f, 0x9a] },
  { label: "overlong nul", bytes: [0xc0, 0x80] },
  { label: "utf-16 surrogate encoded as utf-8", bytes: [0xed, 0xa0, 0x80] },
  { label: "above the unicode range", bytes: [0xf7, 0xbf, 0xbf, 0xbf] },
  { label: "invalid lead", bytes: [0xff, 0x41] },
];

describe("fromUtf8 on a runtime with no TextDecoder", () => {
  const saved = globalThis.TextDecoder;

  beforeEach(() => {
    Reflect.deleteProperty(globalThis, "TextDecoder");
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "TextDecoder", { value: saved, configurable: true, writable: true });
  });

  for (const { label, text } of WELL_FORMED) {
    test(`round trips ${label}`, () => {
      expect(fromUtf8(new TextEncoder().encode(text))).toBe(text);
    });
  }

  for (const { label, bytes } of ILL_FORMED) {
    test(`replaces rather than throwing: ${label}`, () => {
      expect(fromUtf8(new Uint8Array(bytes))).toContain("\ufffd");
    });
  }

  test("a sealed frame opens, which is the call that died on device", async () => {
    const secret = new Uint8Array(32).fill(7);
    const transcript = new Uint8Array(16).fill(3);
    const keys = deriveChannelKeys(secret, transcript);
    const client = new SealedChannel(keys, "client");
    const daemon = new SealedChannel(keys, "daemon");

    const message = '{"t":"ready","v":1,"note":"café 日本 🚀"}';
    const sealed = await daemon.seal(message);
    // The exact step that threw inside the handshake's `#onReady`.
    expect(await client.open(sealed)).toBe(message);
  });
});

describe("fromUtf8 agrees with the platform decoder where there is one", () => {
  for (const { label, text } of WELL_FORMED) {
    test(`matches TextDecoder on ${label}`, () => {
      const bytes = new TextEncoder().encode(text);
      expect(fromUtf8(bytes)).toBe(new TextDecoder().decode(bytes));
    });
  }
});
