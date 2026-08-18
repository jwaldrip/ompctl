/**
 * The sealed channel between a client and a daemon.
 *
 * Everything of substance rides inside this. The hub relays base64 and holds no
 * key that opens it, which is the only reason a public relay can be allowed to
 * broker access to machines that execute code.
 *
 * Two properties are worth being explicit about.
 *
 * **Direction has its own key.** Rather than separating the two flows by a bit
 * in the nonce, each gets a key of its own from HKDF. Nonce reuse across
 * directions then cannot happen by construction, and a frame captured in one
 * direction cannot be reflected back in the other.
 *
 * **Position is authenticated.** The counter is the nonce and also goes in the
 * additional data, and the receiver expects the exact next one. Reorder,
 * replay, and drop are then the same refusal, which is what lets the relay
 * treat any of them as a torn session rather than papering over one.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

const KEY_BITS = 256;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Ceiling on frames per direction per session.
 *
 * Far below what the counter could reach and far above any real session. A
 * channel that hits it is refused rather than wrapped, because a wrapped
 * counter is a repeated nonce, and a repeated nonce in GCM is a lost key.
 */
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

export type ChannelRole = "client" | "daemon";

/** Thrown when a frame does not authenticate. Always fatal to the session. */
export class ChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface ChannelKeys {
  /** Client to daemon. */
  readonly c2d: Uint8Array;
  /** Daemon to client. */
  readonly d2c: Uint8Array;
}

/**
 * Derive both directions from the ECDH secret and the handshake transcript.
 *
 * The transcript is the salt, so every field either party contributed is bound
 * into the key. A hub that altered any of them, including the daemon id it
 * claimed to be routing to, produces a different key on each side and the first
 * sealed frame fails to open.
 */
export function deriveChannelKeys(sharedSecret: Uint8Array, transcript: Uint8Array): ChannelKeys {
  // HKDF and AES-GCM come from `@noble` rather than WebCrypto, for the same
  // reason the curves already do one file over: the platforms this has to run
  // on do not all have it. React Native has no `crypto` object at all -- no
  // `subtle`, no `getRandomValues` -- so a phone could not open a sealed
  // channel, and the failure surfaced as `undefined is not a function` deep
  // inside a socket factory. An audited pure-JS implementation is the only
  // thing that behaves the same in Bun, a browser, and Hermes.
  //
  // These are also synchronous, which removes the reason `seal` and `open` had
  // to serialise themselves against overlapping calls. The chains below are
  // kept anyway: the counter contract is per-frame ordering, and that is worth
  // holding independently of whether the primitive happens to be async today.
  const derive = (label: string): Uint8Array => hkdf(sha256, sharedSecret, transcript, utf8(label), KEY_BITS / 8);
  return {
    c2d: derive(`ompd-tunnel-c2d-v${PROTOCOL_VERSION}`),
    d2c: derive(`ompd-tunnel-d2c-v${PROTOCOL_VERSION}`),
  };
}

export class SealedChannel {
  readonly #sendKey: Uint8Array;
  readonly #recvKey: Uint8Array;
  #sendCounter = 0;
  #recvCounter = 0;

  /**
   * Serialises each direction.
   *
   * `seal` and `open` return promises, so two overlapping calls would take
   * their counters in call order and could still be written in another. The
   * caller writes on completion, so frames would reach the wire transposed and
   * the far side, which requires the exact next counter, would refuse a stream
   * that was never actually corrupted.
   *
   * A daemon streaming two updates in the same tick is enough to hit it, so
   * ordering belongs here rather than in each caller: the counter lives in this
   * object, and so should the guarantee that it is honoured. The primitives are
   * synchronous now, which makes this cheap rather than unnecessary -- the
   * contract is the ordering, not the implementation that needed it.
   */
  #sendChain: Promise<unknown> = Promise.resolve();
  #recvChain: Promise<unknown> = Promise.resolve();

  constructor(keys: ChannelKeys, role: ChannelRole) {
    this.#sendKey = role === "client" ? keys.c2d : keys.d2c;
    this.#recvKey = role === "client" ? keys.d2c : keys.c2d;
  }

  /** Frames sealed so far. The relay uses this as its cumulative send count. */
  get sent(): number {
    return this.#sendCounter;
  }

  /** Frames opened so far. The relay reports this as its cumulative ack. */
  get received(): number {
    return this.#recvCounter;
  }

  seal(plaintext: string): Promise<string> {
    const sealed = this.#sendChain.then(() => this.#sealNow(plaintext));
    // Swallow on the chain itself so one failure does not reject every later
    // call; the caller still sees its own rejection through `sealed`.
    this.#sendChain = sealed.catch(() => {});
    return sealed;
  }

  open(sealed: string): Promise<string> {
    const opened = this.#recvChain.then(() => this.#openNow(sealed));
    this.#recvChain = opened.catch(() => {});
    return opened;
  }

  // `async` is kept on both despite the primitives now being synchronous: the
  // return type is part of this class's contract, and the chains above depend
  // on it.
  async #sealNow(plaintext: string): Promise<string> {
    if (this.#sendCounter >= MAX_COUNTER) throw new ChannelError("channel exhausted");
    const counter = this.#sendCounter++;
    const sealed = gcm(this.#sendKey, nonceFor(counter), aadFor(counter)).encrypt(utf8(plaintext));
    return toBase64Url(sealed);
  }

  async #openNow(sealed: string): Promise<string> {
    const raw = fromBase64Url(sealed);
    if (raw === null || raw.length < TAG_BYTES) throw new ChannelError("sealed frame was malformed");

    const counter = this.#recvCounter;
    let plaintext: Uint8Array;
    try {
      plaintext = gcm(this.#recvKey, nonceFor(counter), aadFor(counter)).decrypt(raw);
    } catch {
      // Indistinguishable on purpose: a forged tag, a replayed frame, and a
      // frame the relay dropped all land here, and the session is over either
      // way. Saying which would tell an attacker whether the counter was the
      // part that was wrong.
      throw new ChannelError("sealed frame did not authenticate");
    }

    this.#recvCounter++;
    return fromUtf8(plaintext);
  }
}

function nonceFor(counter: number): Uint8Array {
  const nonce = new Uint8Array(NONCE_BYTES);
  new DataView(nonce.buffer).setBigUint64(NONCE_BYTES - 8, BigInt(counter), false);
  return nonce;
}

function aadFor(counter: number): Uint8Array {
  return utf8(`v${PROTOCOL_VERSION}|${counter}`);
}
