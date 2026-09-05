import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { DefaultPolicy, Store } from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { WEB_ASSETS } from "../src/web-assets.ts";
import { createFakeHost } from "./fake-host.ts";

describe("embedded web assets", () => {
  const dbPath = `/tmp/ompd-assets-${crypto.randomUUID()}.db`;
  const store = new Store(dbPath);
  const events = new GatewayEvents();
  const fake = createFakeHost();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const supervisor = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    events,
    spawnHost: hosts.spawn,
  });
  const gateway = new Gateway({
    supervisor,
    store,
    events,
    port: 0,
    sessions: hosts,
  });

  afterAll(async () => {
    await gateway.close();
    store.close();
    rmSync(dbPath, { force: true });
  });

  test("serves index.html at root with text/html content type", async () => {
    const port = await gateway.listen();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const text = await res.text();
    expect(text).toContain("<html");
    expect(text).toContain("script type=\"module\"");
  });

  test("serves embedded ttf font with font/ttf content type", async () => {
    const port = await gateway.listen();
    const ttfPath = Object.keys(WEB_ASSETS).find(k => k.endsWith(".ttf"));
    expect(ttfPath).toBeDefined();

    const res = await fetch(`http://127.0.0.1:${port}${ttfPath}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/ttf");
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  test("returns 404 for missing static asset", async () => {
    const port = await gateway.listen();
    const res = await fetch(`http://127.0.0.1:${port}/assets/missing-asset.png`);
    expect(res.status).toBe(404);
  });
});
