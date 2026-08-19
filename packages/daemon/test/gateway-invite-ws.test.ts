/**
 * The `device_invite` websocket frame from the wire: the sealed-socket road
 * to minting a device credential, which is the only road that exists behind
 * a hub relay because the relay carries frames and never daemon HTTP.
 *
 * Everything here runs against a real gateway with a real store: the frame
 * is sent over a real websocket, the answer is read off the same wire, and
 * the minted token is proven a credential by authenticating a second
 * connection with it rather than by trusting the frame that carried it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientFrame, DefaultPolicy, SCOPE_APPROVE, SCOPE_READ, type ServerFrame, Store } from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

/**
 * Deadline for waiting on a frame that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 3000;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  /** Puts a mistyped field on the wire, past every client-side type. */
  sendRaw(raw: string): void;
  /** Resolve with the next frame matching `match`, driven by arrival. */
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

async function connect(port: number, token: string): Promise<SocketClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
  const opened = Promise.withResolvers<boolean>();
  const frames: ServerFrame[] = [];
  let cursor = 0;
  let pending: { check: () => boolean; settle: (frame: ServerFrame | null) => void; timer: Timer } | null = null;

  const drain = (): void => {
    if (!pending) return;
    if (!pending.check()) return;
    const waiter = pending;
    pending = null;
    clearTimeout(waiter.timer);
    waiter.settle(frames[cursor - 1] ?? null);
  };

  ws.addEventListener("open", () => opened.resolve(true));
  ws.addEventListener("error", () => opened.resolve(false));
  ws.addEventListener("close", () => opened.resolve(false));
  ws.addEventListener("message", event => {
    frames.push(JSON.parse(String(event.data)) as ServerFrame);
    drain();
  });

  if (!(await opened.promise)) throw new Error("expected the websocket to open");

  const client: SocketClient = {
    frames,
    send: frame => ws.send(JSON.stringify(frame)),
    sendRaw: raw => ws.send(raw),
    next: (match, label) => {
      const settled = Promise.withResolvers<ServerFrame>();
      const timer = setTimeout(() => {
        pending = null;
        settled.reject(new Error(`timed out waiting for ${label}`));
      }, SIGNAL_DEADLINE_MS);
      pending = {
        // The cursor advances past frames that do not match, so a later
        // `next` never re-matches a frame an earlier one already stepped over.
        check: () => {
          while (cursor < frames.length) {
            const frame = frames[cursor];
            cursor += 1;
            if (frame && match(frame)) return true;
          }
          return false;
        },
        settle: frame => {
          if (frame) settled.resolve(frame);
        },
        timer,
      };
      drain();
      return settled.promise;
    },
    close: () => ws.close(),
  };
  return client;
}

interface Harness {
  port: number;
  store: Store;
  /** Pairs a device over the real HTTP routes and returns its token. */
  pair(scopes: string[]): Promise<string>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(): Promise<Harness> {
  const dbPath = join(tempDir("gw-ws-invite-db-"), "ompd.db");
  paths.push(dbPath);
  const store = new Store(dbPath);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });

  const gw = new Gateway({ supervisor: sup, store, events, port: 0, sessions: hosts });
  gateways.push(gw);
  const port = await gw.listen();

  return {
    port,
    store,
    pair: async scopes => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    connect: token => connect(port, token),
  };
}

function isDeviceInvited(frame: ServerFrame): frame is Extract<ServerFrame, { t: "device_invited" }> {
  return frame.t === "device_invited";
}

/**
 * One real macrotask, deliberately not an event await: the assertion it
 * enables is that a frame the daemon must never send has not arrived, and a
 * negative has no event to await. Fifty milliseconds is the smallest window
 * longer than the daemon's own synchronous send path.
 */
async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 50);
  await promise;
}

describe("the device_invite websocket frame", () => {
  test("an approve-scoped socket mints a credential that authenticates a later connection", async () => {
    const h = await harness();
    const inviterToken = await h.pair([SCOPE_READ, SCOPE_APPROVE]);
    const inviter = await h.connect(inviterToken);

    inviter.send({ t: "device_invite", name: "Kitchen iPad", scopes: [SCOPE_READ] });
    const answer = await inviter.next(isDeviceInvited, "device_invited");
    if (!isDeviceInvited(answer)) throw new Error("expected a device_invited frame");

    expect(answer.token).toBeString();
    expect(answer.token.length).toBeGreaterThan(0);
    expect(answer.name).toBe("Kitchen iPad");
    expect(answer.scopes).toEqual([SCOPE_READ]);

    // The proof the frame was not theatre: the minted value authenticates a
    // brand-new connection, which is the exact act the new device will
    // perform when it scans the QR. Asserted, not inferred from the 200 the
    // mint itself returned.
    const invited = await h.connect(answer.token);
    const hello = await invited.next(frame => frame.t === "hello", "hello for the minted token");
    if (hello.t !== "hello") throw new Error("expected a hello for the minted token");
    expect(hello.deviceId).not.toBe("");

    const newDevice = h.store
      .listDevices()
      .find(device => device.name === "Kitchen iPad" && device.revokedAt === undefined);
    expect(newDevice).toBeDefined();
    expect(newDevice?.scopes).toEqual([SCOPE_READ]);

    invited.close();
    inviter.close();
  });

  test("the answer reaches only the asking socket, never a second connected one", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_APPROVE]);
    const asker = await h.connect(token);
    const bystander = await h.connect(token);
    await bystander.next(frame => frame.t === "hello", "bystander hello");

    asker.send({ t: "device_invite", name: "Quiet tablet", scopes: [SCOPE_READ] });
    await asker.next(isDeviceInvited, "device_invited on the asking socket");
    await settle();

    expect(bystander.frames.some(frame => frame.t === "device_invited")).toBe(false);

    asker.close();
    bystander.close();
  });

  test("a socket without approve scope is refused and nothing is minted", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const client = await h.connect(token);
    const devicesBefore = h.store.listDevices().length;
    const auditBefore = h.store.listAudit().length;

    client.send({ t: "device_invite", name: "Sneaky phone", scopes: [SCOPE_READ] });
    const refusal = await client.next(frame => frame.t === "error", "error frame");
    if (refusal.t !== "error") throw new Error("expected an error frame");
    await settle();

    expect(refusal.code).toBe("unauthorized");
    expect(h.store.listDevices()).toHaveLength(devicesBefore);
    expect(h.store.listDevices().some(device => device.name === "Sneaky phone")).toBe(false);
    expect(h.store.listAudit()).toHaveLength(auditBefore);

    client.close();
  });

  test("a malformed frame is refused and nothing is minted", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_APPROVE]);
    const client = await h.connect(token);
    const devicesBefore = h.store.listDevices().length;
    const auditBefore = h.store.listAudit().length;

    // Two shapes of malformed: `scopes` is a string where the contract says
    // array, and `name` is a number where it says string. The wire is not a
    // place to assume anyone kept to the type, and either one reaching the
    // mint would persist garbage as a device identity.
    client.sendRaw(JSON.stringify({ t: "device_invite", name: "Broken client", scopes: "read" }));
    const scopesRefusal = await client.next(frame => frame.t === "error", "error frame for bad scopes");
    if (scopesRefusal.t !== "error") throw new Error("expected an error frame");
    client.sendRaw(JSON.stringify({ t: "device_invite", name: 42, scopes: [SCOPE_READ] }));
    const nameRefusal = await client.next(frame => frame.t === "error", "error frame for bad name");
    if (nameRefusal.t !== "error") throw new Error("expected an error frame");
    await settle();

    expect(scopesRefusal.code).toBe("bad_frame");
    expect(nameRefusal.code).toBe("bad_frame");
    expect(h.store.listDevices()).toHaveLength(devicesBefore);
    expect(h.store.listAudit()).toHaveLength(auditBefore);

    client.close();
  });

  test("a widened scope selection is refused by name and nothing is minted", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ, SCOPE_APPROVE]);
    const client = await h.connect(token);
    const devicesBefore = h.store.listDevices().length;

    client.send({ t: "device_invite", name: "Ambitious tablet", scopes: [SCOPE_READ, "manage"] });
    const refusal = await client.next(frame => frame.t === "error", "error frame");
    if (refusal.t !== "error") throw new Error("expected an error frame");
    await settle();

    expect(refusal.code).toBe("unauthorized");
    expect(refusal.message).toContain("manage");
    expect(h.store.listDevices()).toHaveLength(devicesBefore);

    client.close();
  });

  test("the audit line names the actor, the scopes, and the device, and never the token", async () => {
    const h = await harness();
    const inviterToken = await h.pair([SCOPE_READ, SCOPE_APPROVE]);
    const inviter = await h.connect(inviterToken);
    // The inviter's own device id, taken from the wire's hello rather than
    // from the harness, so the audit assertion names the actor as the daemon
    // saw it.
    const hello = await inviter.next(frame => frame.t === "hello", "hello");
    const actorId = hello.t === "hello" ? hello.deviceId : null;
    expect(actorId).toBeTruthy();

    inviter.send({ t: "device_invite", name: "Audited iPad", scopes: [SCOPE_READ] });
    const answer = await inviter.next(isDeviceInvited, "device_invited");
    if (!isDeviceInvited(answer)) throw new Error("expected a device_invited frame");
    const entry = h.store
      .listAudit()
      .find(row => row.action === "device.pair" && row.detail.origin === "device_invite");
    expect(entry).toBeDefined();
    expect(entry?.actorDeviceId).toBe(actorId);
    expect(entry?.outcome).toBe("ok");
    expect(entry?.detail.name).toBe("Audited iPad");
    expect(entry?.detail.scopes).toEqual([SCOPE_READ]);
    // The whole row, serialized: the one-time credential must appear nowhere
    // in it, not even under a key the schema does not know about.
    expect(JSON.stringify(entry ?? null)).not.toContain(answer.token);

    inviter.close();
  });
});

afterEach(async () => {
  for (const gw of gateways) await gw.close();
  for (const store of stores) store.close();
  for (const path of paths) rmSync(path, { force: true });
});

process.on("exit", () => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});
