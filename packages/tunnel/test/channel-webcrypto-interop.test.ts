/**
 * The ported channel has to interoperate with the one it replaces.
 *
 * A daemon already installed on a machine runs the WebCrypto implementation; an
 * app updated from the store runs this one. If HKDF or AES-GCM disagreed by a
 * byte, every sealed frame between them would fail to authenticate and the
 * session would look like a flaky network rather than a protocol break.
 *
 * So this derives the same keys both ways and seals with each, then opens with
 * the other. WebCrypto is available in Bun, which is what makes the comparison
 * possible here at all.
 */
import { describe, expect, test } from "bun:test";
import { fromBase64Url, utf8 } from "../src/bytes.ts";
import { deriveChannelKeys, SealedChannel } from "../src/channel.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

const KEY_BITS = 256;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const SECRET = new Uint8Array(32).fill(7);
const TRANSCRIPT = utf8("transcript-under-test");

/** The implementation this replaced, kept verbatim as the reference. */
async function webCryptoKeys(): Promise<{ c2d: CryptoKey; d2c: CryptoKey }> {
  const ikm = await crypto.subtle.importKey("raw", SECRET, "HKDF", false, ["deriveBits"]);
  const derive = async (label: string): Promise<CryptoKey> => {
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: TRANSCRIPT, info: utf8(label) },
      ikm,
      KEY_BITS,
    );
    return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  };
  return {
    c2d: await derive(`ompd-tunnel-c2d-v${PROTOCOL_VERSION}`),
    d2c: await derive(`ompd-tunnel-d2c-v${PROTOCOL_VERSION}`),
  };
}

function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(NONCE_BYTES - 8, BigInt(counter), false);
  return nonce;
}

function aadFor(counter: number): Uint8Array {
  return utf8(`v${PROTOCOL_VERSION}|${counter}`);
}

describe("the ported channel on the wire with the WebCrypto one", () => {
  test("HKDF derives the same key material both ways", async () => {
    const ported = deriveChannelKeys(SECRET, TRANSCRIPT);
    const ikm = await crypto.subtle.importKey("raw", SECRET, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: TRANSCRIPT, info: utf8(`ompd-tunnel-c2d-v${PROTOCOL_VERSION}`) },
      ikm,
      KEY_BITS,
    );
    expect(Array.from(ported.c2d)).toEqual(Array.from(new Uint8Array(bits)));
  });

  test("a frame WebCrypto sealed opens here", async () => {
    const reference = await webCryptoKeys();
    const plaintext = '{"t":"hello","from":"webcrypto"}';
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceFor(0), additionalData: aadFor(0), tagLength: TAG_BYTES * 8 },
      reference.c2d,
      utf8(plaintext),
    );
    // Base64url exactly as the wire carries it.
    const wire = Buffer.from(new Uint8Array(sealed)).toString("base64url");

    const daemonSide = new SealedChannel(deriveChannelKeys(SECRET, TRANSCRIPT), "daemon");
    expect(await daemonSide.open(wire)).toBe(plaintext);
  });

  test("a frame sealed here opens under WebCrypto", async () => {
    const clientSide = new SealedChannel(deriveChannelKeys(SECRET, TRANSCRIPT), "client");
    const plaintext = '{"t":"hello","from":"noble"}';
    const wire = await clientSide.seal(plaintext);
    const raw = fromBase64Url(wire);
    expect(raw).not.toBeNull();

    const reference = await webCryptoKeys();
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonceFor(0), additionalData: aadFor(0), tagLength: TAG_BYTES * 8 },
      reference.c2d,
      raw ?? new Uint8Array(),
    );
    expect(new TextDecoder().decode(opened)).toBe(plaintext);
  });
});
