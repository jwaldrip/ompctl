/**
 * AES-256-GCM sealing for the daemon's collab guest leg.
 *
 * A port of omp's `seal`/`open`/envelope helpers
 * (`packages/coding-agent/src/collab/{crypto,protocol}.ts`), not an import,
 * for the same reason as the link parser: the daemon speaks the wire protocol
 * without linking the coding agent. WebCrypto only — no crypto dependency is
 * needed or allowed here.
 *
 * Sealed layout: `[12B IV][ciphertext+tag]`. Wire envelope:
 * `[4B uint32 BE peerId][sealed payload]`. Guest→relay envelopes always carry
 * peerId 0; the relay rewrites it to the sender's id.
 */

import type { CollabGuestFrame, CollabHostFrame } from "./guest-frames.ts";

const AES_ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
export const ENVELOPE_HEADER_LENGTH = 4;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

/**
 * Import a raw 32-byte room key as a non-extractable AES-GCM key. The
 * non-extractable bit matters: once imported, the material can only be used
 * through this handle, so the guest leg cannot accidentally hand the raw key
 * to a serializer or logger after startup.
 */
export function importRoomKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", asStrict(raw), AES_ALGORITHM, false, ["encrypt", "decrypt"]);
}

export async function seal(key: CryptoKey, frame: CollabGuestFrame): Promise<Uint8Array> {
  const iv = new Uint8Array(IV_LENGTH);
  crypto.getRandomValues(iv);
  const plaintext = TEXT_ENCODER.encode(JSON.stringify(frame));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGORITHM, iv }, key, plaintext));
  const out = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, IV_LENGTH);
  return out;
}

/** Inverse of {@link seal}. Throws on auth failure or malformed input. */
export async function open(key: CryptoKey, data: Uint8Array): Promise<CollabHostFrame> {
  if (data.byteLength <= IV_LENGTH) {
    throw new Error("Sealed frame too short");
  }
  const iv = asStrict(data.subarray(0, IV_LENGTH));
  const ciphertext = asStrict(data.subarray(IV_LENGTH));
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: AES_ALGORITHM, iv }, key, ciphertext));
  return JSON.parse(TEXT_DECODER.decode(plaintext)) as CollabHostFrame;
}

export function packEnvelope(peerId: number, sealed: Uint8Array): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER_LENGTH + sealed.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(sealed, ENVELOPE_HEADER_LENGTH);
  return out;
}

export function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
  if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
  const peerId = new DataView(data.buffer, data.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
  return { peerId, payload: data.subarray(ENVELOPE_HEADER_LENGTH) };
}

/** WebCrypto requires a plain ArrayBuffer-backed view at offset zero. */
function asStrict(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
