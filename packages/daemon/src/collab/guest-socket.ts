/**
 * Reconnecting relay socket for the daemon's collab guest leg.
 *
 * A port of omp's `CollabSocket` semantics
 * (`packages/collab-web/src/lib/socket.ts`, itself a mirror of the coding
 * agent's `relay-client.ts`): connect to a relay room as a guest, seal/opens
 * AES-GCM frames in strict order, and reconnect with exponential backoff on
 * transient drops. Fatal relay close codes (room gone, host conflict, room
 * full), decryption failures, and bad-key frames never reconnect.
 *
 * The send and receive chains exist because WebCrypto is async: without the
 * serialization, two awaited `seal` calls can resolve out of call order and
 * put frames on the wire interleaved with their headers scrambled.
 */

import { open, packEnvelope, seal, unpackEnvelope } from "./guest-codec.ts";
import type { CollabGuestFrame, CollabHostFrame, RelayControlToGuest } from "./guest-frames.ts";

const FATAL_CLOSE_REASONS: Record<number, string> = {
  4001: "room closed",
  4004: "no such room",
  4009: "a host is already connected for this room",
  4029: "room is full",
};

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export interface CollabGuestSocketOptions {
  /** ws(s)://host[:port]/r/<roomId> — no query string. */
  wsUrl: string;
  /** Room key; a pending import promise is awaited inside the seal/open chains. */
  key: CryptoKey | PromiseLike<CryptoKey>;
}

export class CollabGuestSocket {
  /** Fires after every successful (re)connect; the guest re-sends `hello` here. */
  onOpen?: () => void;
  onFrame?: (frame: CollabHostFrame) => void;
  onControl?: (msg: RelayControlToGuest) => void;
  /** Fires once per terminal close (intentional, fatal code, or bad key). `willReconnect` is true only for transient drops that will retry. */
  onClose?: (reason: string, willReconnect: boolean) => void;

  readonly #opts: CollabGuestSocketOptions;
  #ws: WebSocket | null = null;
  #retryTimer: Timer | undefined;
  #attempt = 0;
  /** Terminal state: intentional close or fatal failure. Cleared by connect(). */
  #closed = false;
  /** Serializes seal() so frames hit the wire in send() order. */
  #sendChain: Promise<void> = Promise.resolve();
  /** Serializes open() so frames are delivered in arrival order. */
  #recvChain: Promise<void> = Promise.resolve();

  constructor(opts: CollabGuestSocketOptions) {
    this.#opts = opts;
  }

  connect(): void {
    if (this.#ws || this.#retryTimer) return;
    this.#closed = false;
    this.#attempt = 0;
    this.#openSocket();
  }

  send(frame: CollabGuestFrame): void {
    this.#sendChain = this.#sendChain
      .then(async () => {
        if (this.#closed) return;
        const sealed = await seal(await this.#opts.key, frame);
        const ws = this.#ws;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(packEnvelope(0, sealed));
      })
      .catch(() => {
        // Dropped frame; the socket-level close path reports actionable failures.
      });
  }

  /** Intentional close: clears any retry timer and suppresses reconnect. */
  close(): void {
    this.#clearRetry();
    this.#closed = true;
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // already closing/closed
      }
    }
  }

  #openSocket(): void {
    const ws = new WebSocket(`${this.#opts.wsUrl}?role=guest`);
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => {
      if (this.#ws !== ws) return;
      this.#attempt = 0;
      this.onOpen?.();
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.#ws !== ws) return;
      this.#handleMessage(ws, event.data);
    };
    ws.onerror = () => {
      // The paired close event carries the actionable state; nothing to do here.
    };
    ws.onclose = (event: CloseEvent) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#handleClose(event.code, event.reason);
    };
  }

  #handleMessage(ws: WebSocket, data: unknown): void {
    if (typeof data === "string") {
      try {
        this.onControl?.(JSON.parse(data) as RelayControlToGuest);
      } catch {
        // Malformed control message from the relay; nothing session-bearing rides it.
      }
      return;
    }
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
    if (!bytes) return;
    const envelope = unpackEnvelope(bytes);
    if (!envelope) return;
    this.#recvChain = this.#recvChain
      .then(async () => {
        if (this.#ws !== ws) return;
        let frame: CollabHostFrame;
        try {
          frame = await open(await this.#opts.key, envelope.payload);
        } catch {
          // Wrong key or corrupted frame; retrying cannot fix either.
          this.#failFatal("bad key or corrupted frame");
          return;
        }
        if (this.#ws !== ws) return;
        this.onFrame?.(frame);
      })
      .catch(() => {
        // Listener threw; keep the receive chain alive.
      });
  }

  #handleClose(code: number, reason: string): void {
    if (this.#closed) return;
    const fatalReason = FATAL_CLOSE_REASONS[code];
    if (fatalReason !== undefined) {
      this.#closed = true;
      this.onClose?.(fatalReason, false);
      return;
    }
    this.onClose?.(reason || `connection lost (code ${code})`, true);
    this.#scheduleRetry();
  }

  /** Decryption failure: wrong key or corrupted frame. Never reconnect. */
  #failFatal(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRetry();
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // already closing/closed
      }
    }
    this.onClose?.(reason, false);
  }

  #scheduleRetry(): void {
    const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
    this.#attempt++;
    const delay = base * (0.75 + Math.random() * 0.5);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      if (this.#closed) return;
      this.#openSocket();
    }, delay);
  }

  #clearRetry(): void {
    if (this.#retryTimer !== undefined) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }
}
