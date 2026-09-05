/**
 * The two values an operator types, and the split between them.
 *
 * The shape here is the whole point: the hub field holds an address and nothing
 * else, and the daemon's identity travels inside the credential. The previous
 * split put a 64-character fingerprint in the address, which made the field 110
 * characters long and unusable by hand.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_HUB_URL,
  formatDeviceCredential,
  parseDeviceCredential,
  parsePairTarget,
  parsePairTargetOutcome,
} from "../src/pairing.ts";

const BODY = "a".repeat(64);
const DAEMON = `dmn_${BODY}`;

describe("parsePairTarget", () => {
  test("nothing typed means the hosted hub, because that is the common case", () => {
    expect(parsePairTarget("")).toEqual({ transport: "hub", hubUrl: DEFAULT_HUB_URL });
    expect(parsePairTarget("   ")).toEqual({ transport: "hub", hubUrl: DEFAULT_HUB_URL });
  });

  test("a bare host is a hub, because that is how a hub is written down", () => {
    expect(parsePairTarget("hub.ompctl.ai")).toEqual({ transport: "hub", hubUrl: "wss://hub.ompctl.ai" });
    expect(parsePairTarget("hub.example.com:8443")).toEqual({ transport: "hub", hubUrl: "wss://hub.example.com:8443" });
  });

  test("a websocket base is a hub, and a trailing slash does not change it", () => {
    expect(parsePairTarget("wss://hub.example.com")).toEqual({ transport: "hub", hubUrl: "wss://hub.example.com" });
    expect(parsePairTarget("wss://hub.example.com/")).toEqual({ transport: "hub", hubUrl: "wss://hub.example.com" });
    expect(parsePairTarget("ws://127.0.0.1:8787")).toEqual({ transport: "hub", hubUrl: "ws://127.0.0.1:8787" });
  });

  test("a websocket url with a path on loopback is allowed for direct socket", () => {
    expect(parsePairTarget("ws://127.0.0.1:7777/v1/socket")).toEqual({
      transport: "direct",
      url: "ws://127.0.0.1:7777/v1/socket",
    });
    expect(parsePairTarget("ws://localhost:7777/v1/socket")).toEqual({
      transport: "direct",
      url: "ws://localhost:7777/v1/socket",
    });
    expect(parsePairTarget("ws://[::1]:7777/v1/socket")).toEqual({
      transport: "direct",
      url: "ws://[::1]:7777/v1/socket",
    });
  });

  test("a websocket url on a non-loopback host requires wss to protect bearer tokens", () => {
    expect(parsePairTarget("wss://10.4.1.221:7777/v1/socket")).toEqual({
      transport: "direct",
      url: "wss://10.4.1.221:7777/v1/socket",
    });
    expect(parsePairTarget("ws://10.4.1.221:7777/v1/socket")).toBeNull();
    expect(parsePairTargetOutcome("ws://10.4.1.221:7777/v1/socket")).toEqual({
      kind: "refused",
      reason: "use wss:// for a host that is not this machine",
    });
    expect(parsePairTargetOutcome("ws://daemon.remote.internal:7777/v1/socket")).toEqual({
      kind: "refused",
      reason: "use wss:// for a host that is not this machine",
    });
  });

  test("refuses what is not an address rather than guessing", () => {
    expect(parsePairTarget("not an address")).toBeNull();
    expect(parsePairTarget("https://hub.example.com")).toBeNull();
    expect(parsePairTarget("wss://")).toBeNull();
  });
});

describe("device credentials", () => {
  test("round-trips, and the dmn_ prefix is implied rather than typed", () => {
    const formatted = formatDeviceCredential({ daemonId: DAEMON, token: "tok_abc" });
    expect(formatted).toBe(`${BODY}.tok_abc`);
    expect(parseDeviceCredential(formatted)).toEqual({ daemonId: DAEMON, token: "tok_abc" });
  });

  test("accepts a credential that already carries the prefix, so either paste works", () => {
    expect(formatDeviceCredential({ daemonId: BODY, token: "t" })).toBe(`${BODY}.t`);
  });

  test("a token by itself is not a credential: it names no daemon", () => {
    expect(parseDeviceCredential("tok_abc")).toBeNull();
    expect(parseDeviceCredential(`${BODY}.`)).toBeNull();
    expect(parseDeviceCredential(`.${"tok"}`)).toBeNull();
    expect(parseDeviceCredential(`${"a".repeat(63)}.tok`)).toBeNull();
    expect(parseDeviceCredential(`${"z".repeat(64)}.tok`)).toBeNull();
  });

  test("a token may contain the separator, because only the first one splits", () => {
    expect(parseDeviceCredential(`${BODY}.tok.with.dots`)).toEqual({ daemonId: DAEMON, token: "tok.with.dots" });
  });
});
