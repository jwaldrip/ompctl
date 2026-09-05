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
  isDaemonOrigin,
} from "../src/platform/portal.ts";

describe("web portal pure functions: URL in, Connection out", () => {
  const daemonId = `dmn_${"f".repeat(64)}`;
  const token = "device_tok_1234567890abcdef";
  const formattedToken = formatDeviceCredential({ daemonId, token });

  describe("(b) pair deep-link URL parsing and history stripping", () => {
    test("parses https://app.ompctl.ai/pair URL and produces hub Connection", () => {
      // Navigate happy-dom window to the pairing URL
      window.location.href = `https://app.ompctl.ai/pair?token=${encodeURIComponent(formattedToken)}&hub=hub.ompctl.ai&scopes=read,prompt`;
      expect(window.location.search).toContain("token=");

      const conn = connectionFromPairUrl(window.location.href);
      expect(conn).not.toBeNull();
      expect(conn).toEqual({
        transport: "hub",
        hubUrl: "wss://hub.ompctl.ai",
        daemonId,
        token,
        scopes: ["read", "prompt"],
      });

      // Verifies history.replaceState stripped the query from the address bar
      expect(window.location.search).toBe("");
      expect(window.location.pathname).toBe("/pair");
    });

    test("parses pair URL without scopes, defaulting scopes to empty list", () => {
      window.location.href = `https://app.ompctl.ai/pair?token=${encodeURIComponent(formattedToken)}&hub=hub.custom.org:9443`;

      const conn = connectionFromPairUrl(window.location.href);
      expect(conn).not.toBeNull();
      expect(conn).toEqual({
        transport: "hub",
        hubUrl: "wss://hub.custom.org:9443",
        daemonId,
        token,
        scopes: [],
      });
      expect(window.location.search).toBe("");
    });

    test("returns null for malformed or missing token", () => {
      const conn = connectionFromPairUrl("https://app.ompctl.ai/pair?token=invalid&hub=hub.ompctl.ai");
      expect(conn).toBeNull();
    });

    test("returns null for non-pairing paths on app.ompctl.ai", () => {
      const conn = connectionFromPairUrl(
        `https://app.ompctl.ai/other?token=${encodeURIComponent(formattedToken)}&hub=hub.ompctl.ai`,
      );
      expect(conn).toBeNull();
    });
  });

  describe("(c) daemon origin direct transport and target defaults", () => {
    test("directSocketUrlForOrigin maps http and https origins to ws and wss /v1/socket", () => {
      expect(directSocketUrlForOrigin("http://127.0.0.1:7777")).toBe("ws://127.0.0.1:7777/v1/socket");
      expect(directSocketUrlForOrigin("http://localhost:8080")).toBe("ws://localhost:8080/v1/socket");
      expect(directSocketUrlForOrigin("https://daemon.example.com")).toBe("wss://daemon.example.com/v1/socket");
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

    test("isDaemonOrigin returns true when /v1/health answers ok:true", async () => {
      const fakeFetch = async (url: string | URL | Request) => {
        expect(String(url)).toBe("http://127.0.0.1:7777/v1/health");
        return new Response(JSON.stringify({ ok: true, service: "ompd" }), { status: 200 });
      };
      const result = await isDaemonOrigin("http://127.0.0.1:7777", fakeFetch as unknown as typeof fetch);
      expect(result).toBe(true);
    });

    test("isDaemonOrigin returns false when /v1/health answers with error or non-200", async () => {
      const fakeFetch = async () => new Response(JSON.stringify({ ok: false }), { status: 500 });
      const result = await isDaemonOrigin("http://127.0.0.1:7777", fakeFetch as unknown as typeof fetch);
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

    test("connectionFromDirectInput rejects empty token or non-direct targets", () => {
      expect(connectionFromDirectInput("ws://127.0.0.1:7777/v1/socket", "   ")).toBeNull();
      expect(connectionFromDirectInput("hub.ompctl.ai", "some-token")).toBeNull();
    });

    test("connectionFromPairUrl on daemon origin parses direct token query and strips history", () => {
      window.location.href = "http://127.0.0.1:7799/?token=operator-direct-token&scopes=read,prompt,manage";

      const conn = connectionFromPairUrl(window.location.href);
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
