import { describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!(globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom) {
  GlobalRegistrator.register();
  (globalThis as { __ompdHappyDom?: boolean }).__ompdHappyDom = true;
}

import { DEFAULT_HUB_HOST, formatDeviceCredential } from "@ompd/core/pairing";
import {
  connectionFromDirectInput,
  connectionFromPairUrl,
  defaultPairTargetForOrigin,
  directSocketUrlForOrigin,
  isDaemonHealthPayload,
  isDaemonOrigin,
} from "../src/platform/portal.ts";

describe("web portal pure functions: URL in, Connection out", () => {
  const daemonId = `dmn_${"f".repeat(64)}`;
  const token = "device_tok_1234567890abcdef";
  const formattedToken = formatDeviceCredential({ daemonId, token });

  describe("(b) pair deep-link URL parsing and history stripping", () => {
    test("parses https://app.ompctl.ai/pair URL with token in fragment and produces hub Connection", () => {
      // URL has token in fragment, hub and scopes in query
      window.location.href = `https://app.ompctl.ai/pair?hub=hub.ompctl.ai&scopes=read,prompt#token=${encodeURIComponent(formattedToken)}`;
      expect(window.location.search).toBe("?hub=hub.ompctl.ai&scopes=read,prompt");
      expect(window.location.hash).toContain("token=");

      const conn = connectionFromPairUrl(window.location.href);
      expect(conn).not.toBeNull();
      expect(conn).toEqual({
        transport: "hub",
        hubUrl: "wss://hub.ompctl.ai",
        daemonId,
        token,
        scopes: ["read", "prompt"],
      });

      // Verifies history.replaceState stripped BOTH query and fragment from address bar
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
      expect(window.location.pathname).toBe("/pair");
    });

    test("accepts legacy query token form for backwards compatibility", () => {
      window.location.href = `https://app.ompctl.ai/pair?token=${encodeURIComponent(formattedToken)}&hub=hub.ompctl.ai&scopes=read`;

      const conn = connectionFromPairUrl(window.location.href);
      expect(conn).not.toBeNull();
      expect(conn).toEqual({
        transport: "hub",
        hubUrl: "wss://hub.ompctl.ai",
        daemonId,
        token,
        scopes: ["read"],
      });
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
    });

    test("returns null for malformed or missing token", () => {
      const conn = connectionFromPairUrl("https://app.ompctl.ai/pair?hub=hub.ompctl.ai#token=invalid");
      expect(conn).toBeNull();
    });

    test("returns null for non-pairing paths on app.ompctl.ai", () => {
      const conn = connectionFromPairUrl(
        `https://app.ompctl.ai/other?hub=hub.ompctl.ai#token=${encodeURIComponent(formattedToken)}`,
      );
      expect(conn).toBeNull();
    });
  });

  describe("(c) daemon origin direct transport and health validation", () => {
    test("directSocketUrlForOrigin maps http and https origins to ws and wss /v1/socket", () => {
      expect(directSocketUrlForOrigin("http://127.0.0.1:7777")).toBe("ws://127.0.0.1:7777/v1/socket");
      expect(directSocketUrlForOrigin("http://localhost:8080")).toBe("ws://localhost:8080/v1/socket");
      expect(directSocketUrlForOrigin("https://daemon.example.com")).toBe("wss://daemon.example.com/v1/socket");
    });

    test("isDaemonHealthPayload rejects deploy server payload with service field", () => {
      expect(isDaemonHealthPayload({ ok: true, service: "ompctl-web" })).toBe(false);
      expect(isDaemonHealthPayload({ ok: true, service: "ompd", version: "0.1.0", homeId: "abc" })).toBe(false);
    });

    test("isDaemonHealthPayload accepts valid daemon payload and rejects incomplete shapes", () => {
      expect(isDaemonHealthPayload({ ok: true, version: "0.1.0", homeId: "abc123hash" })).toBe(true);
      expect(isDaemonHealthPayload({ ok: true, version: "0.1.0" })).toBe(false);
      expect(isDaemonHealthPayload({ ok: true, homeId: "abc123hash" })).toBe(false);
      expect(isDaemonHealthPayload({ ok: false, version: "0.1.0", homeId: "abc123hash" })).toBe(false);
    });

    test("isDaemonOrigin rejects app.ompctl.ai without fetching health", async () => {
      let called = false;
      const fakeFetch = async () => {
        called = true;
        return new Response(JSON.stringify({ ok: true }));
      };
      const result = await isDaemonOrigin("https://app.ompctl.ai", fakeFetch as unknown as typeof fetch);
      expect(result).toBe(false);
      expect(called).toBe(false);
    });

    test("isDaemonOrigin returns true when /v1/health answers with authentic daemon payload", async () => {
      const fakeFetch = async (url: string | URL | Request) => {
        expect(String(url)).toBe("http://127.0.0.1:7777/v1/health");
        return new Response(JSON.stringify({ ok: true, version: "0.1.0", homeId: "daemon-home-id" }), {
          status: 200,
        });
      };
      const result = await isDaemonOrigin("http://127.0.0.1:7777", fakeFetch as unknown as typeof fetch);
      expect(result).toBe(true);
    });

    test("isDaemonOrigin returns false when /v1/health is web deploy server", async () => {
      const fakeFetch = async () => new Response(JSON.stringify({ ok: true, service: "ompctl-web" }), { status: 200 });
      const result = await isDaemonOrigin("http://127.0.0.1:8080", fakeFetch as unknown as typeof fetch);
      expect(result).toBe(false);
    });

    test("defaultPairTargetForOrigin selects direct socket when daemon, hosted hub otherwise", () => {
      expect(defaultPairTargetForOrigin("http://127.0.0.1:7777", true)).toBe("ws://127.0.0.1:7777/v1/socket");
      expect(defaultPairTargetForOrigin("http://127.0.0.1:7777", false)).toBe(DEFAULT_HUB_HOST);
      expect(defaultPairTargetForOrigin("https://app.ompctl.ai", false)).toBe(DEFAULT_HUB_HOST);
    });

    test("connectionFromDirectInput produces direct Connection from target and pasted operator token", () => {
      const conn = connectionFromDirectInput("ws://127.0.0.1:7777/v1/socket", "operator-secret-token-12345");
      expect(conn).not.toBeNull();
      expect(conn).toEqual({
        transport: "direct",
        url: "ws://127.0.0.1:7777/v1/socket",
        token: "operator-secret-token-12345",
        scopes: [],
      });
    });

    test("connectionFromPairUrl rejects direct token without daemon proof (isDaemon !== true)", () => {
      const url = "http://127.0.0.1:7799/?token=operator-direct-token&scopes=read,prompt";
      // No opts.isDaemon passed
      expect(connectionFromPairUrl(url)).toBeNull();
      // opts.isDaemon false
      expect(connectionFromPairUrl(url, { isDaemon: false })).toBeNull();
    });

    test("connectionFromPairUrl accepts direct token with daemon proof (isDaemon === true)", () => {
      window.location.href = "http://127.0.0.1:7799/?token=operator-direct-token&scopes=read,prompt,manage";

      const conn = connectionFromPairUrl(window.location.href, { isDaemon: true });
      expect(conn).not.toBeNull();
      expect(conn).toEqual({
        transport: "direct",
        url: "ws://127.0.0.1:7799/v1/socket",
        token: "operator-direct-token",
        scopes: ["read", "prompt", "manage"],
      });
      expect(window.location.search).toBe("");
    });
  });
});
