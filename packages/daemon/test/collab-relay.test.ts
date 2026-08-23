/**
 * The collab relay, tested through a real Gateway so the wiring is what is
 * under test: the route interception ahead of the static fallback, the
 * dispatch that keeps relay legs out of the authenticated socket path, and
 * the room contract itself, which mirrors the reference relay in oh-my-pi
 * (packages/collab-web/test/local-relay.test.ts) because omp's client is
 * pinned to those exact close codes and control frames.
 *
 * Every payload in these tests is random bytes. That is not a shortcut: the
 * relay's safety property is that it routes ciphertext it cannot read, so the
 * tests deliberately hand it frames that are not JSON and not parseable, and
 * a relay that inspected a payload would fail them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPolicy, Store } from "@ompd/core";
import { Gateway } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const ROOM = "RelayRoom_12345";
// Waits below are bounded so a missing event fails with what was awaited
// rather than hanging the file; the awaited thing is always a real socket
// event, which fake timers cannot drive across a real loopback connection.
const REQUEST_TIMEOUT_MS = 1_000;

const gateways: Gateway[] = [];
const stores: Store[] = [];
const scratch: string[] = [];
const sockets: WebSocket[] = [];

interface Harness {
  base: string;
  gateway: Gateway;
}

async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "collab-relay-db-"));
  scratch.push(dir);
  const store = new Store(join(dir, "ompd.db"));
  stores.push(store);
  const fake = createFakeHost();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
  });
  const gateway = new Gateway({ supervisor: sup, store, port: 0 });
  gateways.push(gateway);
  const port = await gateway.listen();
  return { base: `http://127.0.0.1:${port}`, gateway };
}

// The envelope is the relay's whole grammar: a 4-byte big-endian peer id
// ahead of payload bytes it never reads.
function packEnvelope(peerId: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.byteLength);
  new DataView(out.buffer).setUint32(0, peerId, false);
  out.set(payload, 4);
  return out;
}

function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } {
  if (data.byteLength < 4) throw new Error("frame shorter than its routing prefix");
  const peerId = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, false);
  return { peerId, payload: data.subarray(4) };
}

interface Inbox {
  queue: MessageEvent[];
  waiters: Array<(event: MessageEvent) => void>;
}

const inboxes = new Map<WebSocket, Inbox>();

function socket(base: string, path: string): WebSocket {
  const ws = new WebSocket(`${base.replace(/^http:/, "ws:")}${path}`);
  ws.binaryType = "arraybuffer";
  const inbox: Inbox = { queue: [], waiters: [] };
  inboxes.set(ws, inbox);
  ws.addEventListener("message", event => {
    const waiter = inbox.waiters.shift();
    if (waiter) waiter(event as MessageEvent);
    else inbox.queue.push(event as MessageEvent);
  });
  sockets.push(ws);
  return ws;
}

function nextMessage(ws: WebSocket, label: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MessageEvent> {
  const inbox = inboxes.get(ws);
  if (inbox === undefined) throw new Error("socket not created via socket()");
  const queued = inbox.queue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  const { promise, resolve, reject } = Promise.withResolvers<MessageEvent>();
  const onEvent = (event: MessageEvent): void => {
    clearTimeout(timer);
    resolve(event);
  };
  const timer = setTimeout(() => {
    const idx = inbox.waiters.indexOf(onEvent);
    if (idx !== -1) inbox.waiters.splice(idx, 1);
    reject(new Error(`timed out waiting for ${label}`));
  }, timeoutMs);
  inbox.waiters.push(onEvent);
  return promise;
}

function waitEvent<T extends Event>(
  ws: WebSocket,
  type: string,
  label: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const onEvent = (event: Event): void => {
    cleanup();
    resolve(event as T);
  };
  const cleanup = (): void => {
    ws.removeEventListener(type, onEvent);
    clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error(`timed out waiting for ${label}`));
  }, timeoutMs);
  ws.addEventListener(type, onEvent);
  return promise;
}

function waitOpen(ws: WebSocket): Promise<Event> {
  if (ws.readyState === WebSocket.OPEN) return Promise.resolve(new Event("open"));
  return waitEvent(ws, "open", "socket open");
}

async function waitText(ws: WebSocket, label: string): Promise<string> {
  const event = await nextMessage(ws, label);
  if (typeof event.data !== "string") throw new Error(`${label} was not TEXT`);
  return event.data;
}

async function waitBinary(ws: WebSocket, label: string): Promise<Uint8Array> {
  const event = await nextMessage(ws, label);
  const data: unknown = event.data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error(`${label} was not binary`);
}

function closeSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) closeSocket(ws);
  inboxes.clear();
  while (gateways.length > 0) await gateways.pop()?.close();
  while (stores.length > 0) stores.pop()?.close();
  while (scratch.length > 0) rmSync(scratch.pop() ?? "", { recursive: true, force: true });
});

describe("collab relay", () => {
  test("joins a room and routes opaque envelopes both ways", async () => {
    const h = await harness();
    const host = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host);

    const guest1 = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest1);
    expect(JSON.parse(await waitText(host, "first peer join"))).toEqual({ t: "peer-joined", peer: 1 });

    const guest2 = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest2);
    expect(JSON.parse(await waitText(host, "second peer join"))).toEqual({ t: "peer-joined", peer: 2 });

    // A guest frame reaches the host stamped with the sender's id, payload
    // untouched. The payload is deliberately not valid anything: the relay
    // may not be reading it.
    const guestPayload = new Uint8Array([0, 159, 146, 150]);
    guest1.send(packEnvelope(0, guestPayload));
    const fromGuest = unpackEnvelope(await waitBinary(host, "guest envelope"));
    expect(fromGuest.peerId).toBe(1);
    expect(fromGuest.payload).toEqual(guestPayload);

    // Host prefix 0 broadcasts to every guest, bytes unchanged.
    const broadcastPayload = new Uint8Array([255, 0, 1]);
    const broadcast1 = waitBinary(guest1, "broadcast to guest 1");
    const broadcast2 = waitBinary(guest2, "broadcast to guest 2");
    host.send(packEnvelope(0, broadcastPayload));
    expect(unpackEnvelope(await broadcast1)).toEqual({ peerId: 0, payload: broadcastPayload });
    expect(unpackEnvelope(await broadcast2)).toEqual({ peerId: 0, payload: broadcastPayload });

    // Host prefix N reaches only guest N.
    const targetedPayload = new Uint8Array([7, 7, 7]);
    const targeted = waitBinary(guest2, "targeted guest 2 frame");
    host.send(packEnvelope(2, targetedPayload));
    expect(unpackEnvelope(await targeted)).toEqual({ peerId: 2, payload: targetedPayload });

    const guest1Next = waitBinary(guest1, "next guest 1 broadcast");
    host.send(packEnvelope(0, new Uint8Array([5])));
    expect(unpackEnvelope(await guest1Next).payload).toEqual(new Uint8Array([5]));
  });

  test("refuses a guest arriving before any host with 4004, then hosts the room normally", async () => {
    const h = await harness();
    const early = socket(h.base, `/r/${ROOM}?role=guest`);
    const close = await waitEvent<CloseEvent>(early, "close", "early guest close");
    expect(close.code).toBe(4004);
    expect(close.reason).toBe("no such room");

    // The refused guest left nothing behind: the same room id hosts cleanly.
    const host = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host);
    const guest = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest);
    expect(JSON.parse(await waitText(host, "peer join after refusal"))).toEqual({ t: "peer-joined", peer: 1 });
  });

  test("dissolves the room when the host drops first, and the id is reusable after", async () => {
    const h = await harness();
    const host = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host);
    const guest = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest);
    expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

    const closure = waitText(guest, "room close control");
    const guestClose = waitEvent<CloseEvent>(guest, "close", "guest room close");
    host.close(1000);
    expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
    expect((await guestClose).code).toBe(4001);

    // Dissolution is real: the room id hosts again from scratch, with peer
    // numbering restarted rather than carried over from the dead room.
    const host2 = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host2);
    const guest2 = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest2);
    expect(JSON.parse(await waitText(host2, "peer join on reused room"))).toEqual({ t: "peer-joined", peer: 1 });
  });

  test("keeps the room when a guest drops first, and never recycles its peer id", async () => {
    const h = await harness();
    const host = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host);
    const guest1 = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest1);
    expect(JSON.parse(await waitText(host, "first peer join"))).toEqual({ t: "peer-joined", peer: 1 });

    const left = waitText(host, "peer left");
    guest1.close(1000);
    expect(JSON.parse(await left)).toEqual({ t: "peer-left", peer: 1 });

    // The room outlived the guest: a new guest joins the same host, on a
    // fresh id so a stale targeted frame can never reach the wrong peer.
    const guest2 = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest2);
    expect(JSON.parse(await waitText(host, "second peer join"))).toEqual({ t: "peer-joined", peer: 2 });

    const payload = new Uint8Array([42]);
    const echoed = waitBinary(guest2, "broadcast after rejoin");
    host.send(packEnvelope(0, payload));
    expect(unpackEnvelope(await echoed).payload).toEqual(payload);
  });

  test("refuses a second host with 4009 without disturbing the live room", async () => {
    const h = await harness();
    const host = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host);
    const guest = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest);
    expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

    const duplicate = socket(h.base, `/r/${ROOM}?role=host`);
    const duplicateClose = await waitEvent<CloseEvent>(duplicate, "close", "duplicate host close");
    expect(duplicateClose.code).toBe(4009);
    expect(duplicateClose.reason).toBe("a host is already connected for this room");

    // The refused host's close did not tear the room down: the guest still
    // receives what the live host broadcasts.
    const payload = new Uint8Array([3, 1, 4]);
    const received = waitBinary(guest, "broadcast after duplicate refusal");
    host.send(packEnvelope(0, payload));
    expect(unpackEnvelope(await received).payload).toEqual(payload);
  });

  test("ignores TEXT frames and short binaries without dropping the leg", async () => {
    const h = await harness();
    const host = socket(h.base, `/r/${ROOM}?role=host`);
    await waitOpen(host);
    const guest = socket(h.base, `/r/${ROOM}?role=guest`);
    await waitOpen(guest);
    expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

    // Neither is part of the protocol; the relay must act on neither and must
    // not answer either, because both arrive where only ciphertext belongs.
    guest.send("this is not an envelope");
    guest.send(new Uint8Array([1, 2]));

    const payload = new Uint8Array([9, 9]);
    const received = waitBinary(host, "frame after noise");
    guest.send(packEnvelope(0, payload));
    const envelope = unpackEnvelope(await received);
    expect(envelope.peerId).toBe(1);
    expect(envelope.payload).toEqual(payload);
  });

  test("answers bad room requests without an upgrade and leaves the authenticated surface alone", async () => {
    const h = await harness();

    const upgradeRequired = await fetch(`${h.base}/r/${ROOM}?role=host`);
    expect(upgradeRequired.status).toBe(426);

    const badRole = await fetch(`${h.base}/r/${ROOM}?role=owner`);
    expect(badRole.status).toBe(404);

    const noRole = await fetch(`${h.base}/r/${ROOM}`);
    expect(noRole.status).toBe(404);

    // Non-room paths keep their existing routing, which the rest of this
    // package's suite already pins; what matters here is the boundary on the
    // other side.

    // The relay interception sits ahead of the bearer check for /r/ only;
    // the authenticated API still refuses a request with no token.
    const agents = await fetch(`${h.base}/v1/agents`);
    expect(agents.status).toBe(401);
  });

  test("reports the relay origin in the shape a collab host consumes", async () => {
    const h = await harness();
    expect(h.gateway.collabRelayUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });
});
