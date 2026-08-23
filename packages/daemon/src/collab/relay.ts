/**
 * Content-blind collab relay.
 *
 * omp's collab protocol puts a room between one host terminal and its guests,
 * with every payload sealed before it touches the socket (oh-my-pi's
 * docs/collab.md is the specification). This module is the room's meeting
 * point on this machine: the daemon already owns an HTTP server, and a relay
 * living on it means a room between a terminal and the phone never leaves
 * the machine.
 *
 * The relay sees room ids, connection counts, ciphertext frame sizes, and the
 * 4-byte routing prefix naming which guest a frame targets. It never sees a
 * key and never parses a payload, which is the property that makes serving it
 * without authentication safe: possession of the link is the trust boundary,
 * and the link's key bytes never reach the relay. It is also the only shape
 * that interoperates: omp's CollabSocket has no credential to present on the
 * relay leg, so a token gate here would break `/collab ws://127.0.0.1:<port>`
 * without closing a hole, since every byte forwarded is ciphertext to anyone
 * but the room's members. Exposure is bounded by the daemon's bind, loopback
 * unless the operator deliberately rebinds; a local process that can reach
 * the relay could host or join rooms only with keys it already holds, which
 * is nothing it could not do with its own loopback socket.
 *
 * Behavior mirrors the reference relay in oh-my-pi
 * (packages/collab-web/scripts/local-relay.ts), which the client contract is
 * pinned against: a host creates its room, a second host is refused with
 * 4009, a guest arriving before any host is refused with 4004, host frames
 * route by their 4-byte prefix (0 broadcasts, N targets guest N), guest
 * frames are stamped with the sender's id and delivered to the host, and a
 * host leaving dissolves the room with a room-closed control frame and a
 * 4001. The close codes are load-bearing: the client's reconnect logic treats
 * 4001, 4004, 4009 and 4029 as fatal and every other code as worth retrying.
 */

import type { ServerWebSocket } from "bun";

/**
 * Room id grammar from omp's link parser: base64url, 10 to 64 chars. Rooms
 * omp generates are 16 random bytes, so guessing one is not a path in.
 */
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

/** Bytes of routing prefix ahead of the sealed payload in every envelope. */
const ENVELOPE_PEER_BYTES = 4;

// Close codes the client treats as fatal, named in its reconnect table.
const CLOSE_ROOM_CLOSED = 4001;
const CLOSE_NO_SUCH_ROOM = 4004;
const CLOSE_HOST_CONFLICT = 4009;
const CLOSE_ROOM_FULL = 4029;
/**
 * Not in the client's fatal table, so a refusal with it is retried with
 * backoff rather than surfaced as terminal. Used where waiting is the honest
 * answer: the relay itself full, or a leg that stopped draining.
 */
const CLOSE_TRY_AGAIN = 1013;

/**
 * Rooms one daemon holds at once. A real machine needs a handful; the cap is
 * there so the map stays bounded if a local process starts opening host
 * connections it never uses. Any number here is arbitrary; 256 refuses long
 * past the point legitimate use gives up.
 */
const MAX_ROOMS = 256;
/**
 * Guests one room holds. A phone and a browser or two is real use; 32 bounds
 * the fan-out map a room keeps. The client has a first-class fatal for this
 * (4029), so the refusal reads as "room is full" rather than a dropped
 * connection.
 */
const MAX_GUESTS_PER_ROOM = 32;

/**
 * What a relay socket carries. Set once at upgrade and never mutated except
 * `peerId`, assigned in `open`; the gateway dispatches on the discriminant.
 */
export interface RelaySocketData {
  /** Present on relay legs only; gateway sockets never carry it. */
  collabRelay: true;
  roomId: string;
  role: "host" | "guest";
  /** Guests are numbered from 1 as they join; the host stays 0. */
  peerId: number;
}

export function isRelaySocketData(data: unknown): data is RelaySocketData {
  return typeof data === "object" && data !== null && "collabRelay" in data;
}

export type RelaySocket = ServerWebSocket<RelaySocketData>;

interface Room {
  host: RelaySocket;
  guests: Map<number, RelaySocket>;
  /** Never recycled within a room's life: a reused id would misroute targeted frames. */
  nextPeerId: number;
}

export class CollabRelay {
  readonly #rooms = new Map<string, Room>();
  /**
   * Set once this relay has closed any leg itself. `Gateway.close` reads it:
   * on Bun 1.3.x a server-side websocket close poisons the promise
   * `server.stop(true)` returns (it never settles, measured against 1.3.14),
   * so the gateway may only await its own shutdown when no relay refusal or
   * dissolution ever fired.
   */
  #closedLegs = false;

  get hasClosedLegs(): boolean {
    return this.#closedLegs;
  }

  /**
   * The socket data for a room upgrade, a refusal for a malformed room
   * request, or null when the path is not a room at all and the gateway
   * should keep routing.
   */
  upgradeData(url: URL): RelaySocketData | Response | null {
    const match = ROOM_PATH_RE.exec(url.pathname);
    if (match === null) return null;
    const role = url.searchParams.get("role");
    if (role !== "host" && role !== "guest") {
      // A room path with no legible role answers 404 like any other unknown
      // path: a probe learns nothing here that "not found" would not say.
      return new Response("not found", { status: 404 });
    }
    return { collabRelay: true, roomId: match[1]!, role, peerId: 0 };
  }

  open(ws: RelaySocket): void {
    const { roomId, role } = ws.data;
    if (role === "host") {
      if (this.#rooms.has(roomId)) {
        this.#refuse(ws, CLOSE_HOST_CONFLICT, "a host is already connected for this room");
        return;
      }
      if (this.#rooms.size >= MAX_ROOMS) {
        this.#refuse(ws, CLOSE_TRY_AGAIN, "relay is full");
        return;
      }
      this.#rooms.set(roomId, { host: ws, guests: new Map(), nextPeerId: 1 });
      return;
    }
    const room = this.#rooms.get(roomId);
    if (room === undefined) {
      this.#refuse(ws, CLOSE_NO_SUCH_ROOM, "no such room");
      return;
    }
    if (room.guests.size >= MAX_GUESTS_PER_ROOM) {
      this.#refuse(ws, CLOSE_ROOM_FULL, "room is full");
      return;
    }
    const peerId = room.nextPeerId++;
    ws.data.peerId = peerId;
    room.guests.set(peerId, ws);
    this.#forward(room.host, JSON.stringify({ t: "peer-joined", peer: peerId }));
  }

  message(ws: RelaySocket, message: string | Buffer): void {
    // Clients only ever send sealed binary envelopes. A TEXT frame carries
    // nothing the relay acts on, and parsing one would be reading a payload.
    if (typeof message === "string") return;
    const room = this.#rooms.get(ws.data.roomId);
    if (room === undefined) return;
    if (message.byteLength < ENVELOPE_PEER_BYTES) return;
    const view = new DataView(message.buffer, message.byteOffset, ENVELOPE_PEER_BYTES);
    if (ws.data.role === "host") {
      const peerId = view.getUint32(0, false);
      if (peerId === 0) {
        for (const guest of room.guests.values()) this.#forward(guest, message);
        return;
      }
      const guest = room.guests.get(peerId);
      if (guest !== undefined) this.#forward(guest, message);
      return;
    }
    // The guest claims nothing about who it is; the relay stamps its id over
    // the prefix in place before the host sees the frame.
    view.setUint32(0, ws.data.peerId, false);
    this.#forward(room.host, message);
  }

  close(ws: RelaySocket): void {
    const { roomId, role, peerId } = ws.data;
    const room = this.#rooms.get(roomId);
    if (room === undefined) return;
    if (role === "host") {
      // A refused second host shares the room id but owns nothing; its close
      // must not tear the live room down.
      if (room.host !== ws) return;
      this.#rooms.delete(roomId);
      this.#dissolveGuests(room);
      return;
    }
    if (room.guests.delete(peerId)) {
      this.#forward(room.host, JSON.stringify({ t: "peer-left", peer: peerId }));
    }
  }

  #dissolveGuests(room: Room): void {
    const closure = JSON.stringify({ t: "room-closed" });
    for (const guest of room.guests.values()) {
      guest.send(closure);
      this.#refuse(guest, CLOSE_ROOM_CLOSED, "room closed");
    }
    room.guests.clear();
  }

  /** Every server-side close goes through here so `hasClosedLegs` cannot miss one. */
  #refuse(ws: RelaySocket, code: number, reason: string): void {
    this.#closedLegs = true;
    ws.close(code, reason);
  }

  /**
   * Forward with one honesty rule about backpressure. Bun buffers per
   * connection up to its backpressureLimit and then reports further sends as
   * dropped. A relay that kept going after a drop would be handing the room a
   * ciphertext stream with silent gaps, and a guest cannot detect a gap in a
   * stream it cannot read. Closing the wedged leg is the recoverable failure:
   * the client reconnects and re-snapshots.
   */
  #forward(target: RelaySocket, data: string | Uint8Array): void {
    if (target.send(data) === 0) this.#refuse(target, CLOSE_TRY_AGAIN, "relay backpressure");
  }
}
