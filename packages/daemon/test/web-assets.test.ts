import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPolicy, Store } from "@ompd/core";
import { generateWebAssets } from "../../../scripts/gen-web-assets.ts";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { WEB_ASSETS, WEB_ASSETS_BUILT } from "../src/web-assets.ts";
import { createFakeHost } from "./fake-host.ts";

describe("embedded web assets generator and gateway serving", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ompd-web-assets-test-"));
  const fixtureDist = join(tmpDir, "dist");
  const fixtureAssetsDir = join(fixtureDist, "assets");
  const generatedModule = join(tmpDir, "generated-web-assets.ts");

  mkdirSync(fixtureAssetsDir, { recursive: true });
  writeFileSync(
    join(fixtureDist, "index.html"),
    "<!doctype html><html><head><title>Fixture App</title><script type=\"module\" src=\"/assets/fixture.js\"></script></head><body><h1>Loaded</h1></body></html>",
  );
  writeFileSync(join(fixtureAssetsDir, "fixture-font.ttf"), "TTF_FIXTURE_BINARY_DATA");

  generateWebAssets({ distDir: fixtureDist, outFile: generatedModule });

  const dbPath = join(tmpDir, "test.db");
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

  let gateway: Gateway | undefined;

  afterAll(async () => {
    if (gateway) await gateway.close();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("committed web-assets.ts is the untracked stub form", () => {
    expect(WEB_ASSETS_BUILT).toBe(false);
    expect(Object.keys(WEB_ASSETS)).toHaveLength(0);
  });

  test("generator correctly encodes fixture dist into TypeScript asset map", async () => {
    const generated = (await import(generatedModule)) as {
      WEB_ASSETS: Record<string, string>;
      WEB_ASSETS_BUILT: boolean;
    };

    expect(generated.WEB_ASSETS_BUILT).toBe(true);
    expect(generated.WEB_ASSETS["/index.html"]).toBeDefined();
    expect(generated.WEB_ASSETS["/assets/fixture-font.ttf"]).toBeDefined();
  });

  test("gateway serves fixture index.html at root with text/html content type", async () => {
    const generated = (await import(generatedModule)) as {
      WEB_ASSETS: Record<string, string>;
      WEB_ASSETS_BUILT: boolean;
    };

    gateway = new Gateway({
      supervisor,
      store,
      events,
      port: 0,
      sessions: hosts,
      embeddedAssets: {
        assets: generated.WEB_ASSETS,
        built: generated.WEB_ASSETS_BUILT,
      },
    });

    const port = await gateway.listen();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const text = await res.text();
    expect(text).toContain("<title>Fixture App</title>");
    expect(text).toContain("script type=\"module\"");
  });

  test("gateway serves fixture ttf font with font/ttf content type", async () => {
    const port = await gateway!.listen();
    const res = await fetch(`http://127.0.0.1:${port}/assets/fixture-font.ttf`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/ttf");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const text = await res.text();
    expect(text).toBe("TTF_FIXTURE_BINARY_DATA");
  });

  test("gateway returns 404 for missing static asset", async () => {
    const port = await gateway!.listen();
    const res = await fetch(`http://127.0.0.1:${port}/assets/missing.png`);
    expect(res.status).toBe(404);
  });
});
