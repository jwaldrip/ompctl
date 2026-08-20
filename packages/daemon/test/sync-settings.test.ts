import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, SCOPE_MANAGE, SCOPE_READ, Store } from "@ompd/core";
import { Gateway, GatewayEvents, type SyncSettings } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const gateways: Gateway[] = [];
const stores: Store[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  stores.splice(0).forEach(store => {
    store.close();
  });
  paths.splice(0).forEach(path => {
    rmSync(path, { force: true });
  });
});

// The settings surface is defined by the pairings it must tell apart: one that
// may only watch and one that may change, so both exist from the start rather
// than being minted per test.
async function daemon() {
  const path = `/tmp/ompd-sync-settings-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const settings: SyncSettings = { policyMode: "standard", keepAwake: true };
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
  const base = `http://127.0.0.1:${port}`;

  const token = async (name: string, scopes: string[]) => {
    const paired = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, publicKey: name }),
    });
    const code = ((await paired.json()) as { code: string }).code;
    return gateway.approvePairing(code, scopes);
  };
  const reader = await token("sync-settings-reader", [SCOPE_READ]);
  const manager = await token("sync-settings-manager", [SCOPE_MANAGE]);

  const request = (bearer: string, route: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${bearer}`);
    headers.set("content-type", "application/json");
    return fetch(`${base}${route}`, { ...init, headers });
  };
  return { settings, reader, manager, request };
}

describe("daemon settings", () => {
  test("GET returns the settings shape to a read-only pairing", async () => {
    const target = await daemon();

    const response = await target.request(target.reader, "/v1/sync-settings");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policyMode: "standard", keepAwake: true });
  });

  test("POST applies under manage and the daemon confirms the persisted values", async () => {
    const target = await daemon();

    const response = await target.request(target.manager, "/v1/sync-settings", {
      method: "POST",
      body: JSON.stringify({ policyMode: "trusted", keepAwake: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policyMode: "trusted", keepAwake: false });
    // The read-back, not the echo: a watch-only pairing sees what applied.
    const confirmed = await target.request(target.reader, "/v1/sync-settings");
    expect(await confirmed.json()).toEqual({ policyMode: "trusted", keepAwake: false });
    expect(target.settings).toEqual({ policyMode: "trusted", keepAwake: false });
  });

  test("refusals are named and leave the settings unchanged", async () => {
    const target = await daemon();

    const readOnlyWrite = await target.request(target.reader, "/v1/sync-settings", {
      method: "POST",
      body: JSON.stringify({ policyMode: "strict", keepAwake: true }),
    });
    expect(readOnlyWrite.status).toBe(403);

    const smuggled = await target.request(target.manager, "/v1/sync-settings", {
      method: "POST",
      body: JSON.stringify({ policyMode: "strict", keepAwake: true, deviceToken: "stolen" }),
    });
    expect(smuggled.status).toBe(400);

    expect(target.settings).toEqual({ policyMode: "standard", keepAwake: true });
  });
});
