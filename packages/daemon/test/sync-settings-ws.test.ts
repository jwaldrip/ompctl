/**
 * The `settings_read`/`settings_write` websocket frames from the wire: the
 * sealed-socket road the daemon's settings take to a hub-relayed phone, which
 * cannot reach the HTTP route at all. Everything the HTTP route enforces must
 * hold here too -- the read gate on asking, the manage gate on changing, the
 * refusal of a malformed write -- or the frame would be a weaker door beside a
 * strong one, and the phone is the client that can only use the frame.
 *
 * The socket helper follows gateway-sessions-ws.test.ts: every wait is on an
 * arriving frame, never on a clock.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type ClientFrame, DefaultPolicy, SCOPE_MANAGE, SCOPE_READ, type ServerFrame, Store } from "@ompd/core";
import { Gateway, GatewayEvents, type SyncSettings } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const sockets: Array<{ close(): void }> = [];

/**
 * Deadline for waiting on a frame that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 3000;

async function daemon(settings: SyncSettings = { policyMode: "standard", keepAwake: true }) {
  const path = `/tmp/ompd-settings-ws-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const gateway = new Gateway({
    store,
    supervisor: new Supervisor({ store, policy: new DefaultPolicy(), spawnHost: hosts.spawn }),
    events: new GatewayEvents(),
    port: 0,
    syncConfig: {
      read: () => settings,
      apply: next => Object.assign(settings, next),
    },
  });
  gateways.push(gateway);
  const port = await gateway.listen();

  const pair = async (name: string, scopes: string[]) => {
    const paired = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, publicKey: name }),
    });
    const code = ((await paired.json()) as { code: string }).code;
    return gateway.approvePairing(code, scopes);
  };

  const connect = async (token: string) => {
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

    const client = {
      frames,
      send: (frame: ClientFrame) => ws.send(JSON.stringify(frame)),
      next: (match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame> => {
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
    sockets.push(client);
    return client;
  };

  return { settings, pair, connect };
}

function isSettings(frame: ServerFrame): boolean {
  return frame.t === "settings";
}

function isRefusal(frame: ServerFrame, code: string): boolean {
  return frame.t === "error" && frame.code === code;
}

describe("the settings websocket frames", () => {
  test("a read-scoped phone is answered with the settings shape", async () => {
    const target = await daemon({ policyMode: "strict", keepAwake: false });
    const reader = await target.connect(await target.pair("settings-reader", [SCOPE_READ]));

    reader.send({ t: "settings_read" });
    const answer = await reader.next(isSettings, "settings frame");
    expect(answer).toEqual({ t: "settings", policyMode: "strict", keepAwake: false });
  });

  test("a manage-scoped phone writes and is answered with what now persists", async () => {
    const target = await daemon();
    const watcher = await target.connect(await target.pair("settings-watcher", [SCOPE_READ]));
    const manager = await target.connect(await target.pair("settings-manager", [SCOPE_MANAGE]));

    manager.send({ t: "settings_write", policyMode: "trusted", keepAwake: false });
    const answer = await manager.next(isSettings, "settings frame after write");
    expect(answer).toEqual({ t: "settings", policyMode: "trusted", keepAwake: false });

    // The read-back on a second socket, not the echo on the first: what
    // persisted is what every other client will be told.
    watcher.send({ t: "settings_read" });
    const confirmed = await watcher.next(isSettings, "settings frame after write from another socket");
    expect(confirmed).toEqual({ t: "settings", policyMode: "trusted", keepAwake: false });
    expect(target.settings).toEqual({ policyMode: "trusted", keepAwake: false });
  });

  test("refusals are named: scope on the write, shape on the values", async () => {
    const target = await daemon();
    const reader = await target.connect(await target.pair("settings-reader", [SCOPE_READ]));
    const manager = await target.connect(await target.pair("settings-manager", [SCOPE_READ, SCOPE_MANAGE]));

    reader.send({ t: "settings_write", policyMode: "strict", keepAwake: true });
    const scopeRefusal = await reader.next(frame => isRefusal(frame, "unauthorized"), "unauthorized error");
    expect(scopeRefusal.t).toBe("error");

    // The wire is not a place to assume the contract held: an out-of-union
    // policy value is a bad_frame, not a guess. Asked by the manager, because
    // the scope gate stands before the shape check, same as every handler.
    manager.send({ t: "settings_read" });
    await manager.next(isSettings, "settings frame before malformed write");
    manager.send({ t: "settings_write", policyMode: "yolo", keepAwake: true } as unknown as ClientFrame);
    const shapeRefusal = await manager.next(frame => isRefusal(frame, "bad_frame"), "bad_frame error");
    expect(shapeRefusal.t).toBe("error");

    expect(target.settings).toEqual({ policyMode: "standard", keepAwake: true });
  });

  test("a phone with no read scope cannot even ask", async () => {
    const target = await daemon();
    const prompter = await target.connect(await target.pair("settings-prompter", [SCOPE_MANAGE]));

    // Manage does not imply read: the ask itself is watching, and the door
    // says so rather than answering with values this device may not see.
    prompter.send({ t: "settings_read" });
    const refusal = await prompter.next(frame => isRefusal(frame, "unauthorized"), "unauthorized error");
    expect(refusal.t).toBe("error");
  });
});

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close();
  while (gateways.length) await gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});
