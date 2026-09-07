/**
 * A leg the hub has stopped speaking on is dead, whether or not the socket
 * says so.
 *
 * Observed on Jason's daemon on 2026-09-06. The hub pings every registered leg
 * every 5s and closes one it hears nothing from within 120s, so its side of a
 * dead link is gone in minutes. The daemon's side had no clock of its own: it
 * answered pings and otherwise waited, and a TCP connection that died without
 * a FIN (the laptop slept) delivered neither a ping nor a close. `ompd status`
 * read "registered with hub instance inst_74d3…" for 28 hours while the hub
 * answered every phone `daemon_offline: enrolled but not connected`, and the
 * portal drew that as "0 sessions".
 *
 * Nothing on this side writes unless the hub speaks first, so the dead
 * socket never even failed a send. Silence has to be the signal.
 */

import { describe, expect, test } from "bun:test";
import type { DialSocket } from "../src/daemon.ts";
import { TunnelDaemon } from "../src/daemon.ts";
import { generateIdentity } from "../src/identity.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

class FakeLeg implements DialSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  readonly written: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];

  send(data: string): void {
    this.written.push(data);
  }

  /** Records the ask and reports nothing: a dead TCP socket closes when the kernel gives up, not now. */
  close(code?: number, reason?: string): void {
    this.closes.push({ code: code ?? 1005, reason: reason ?? "" });
  }

  deliver(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame));
  }

  /** The kernel finally reporting the close, long after the fact. */
  drop(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/**
 * Two timer seams, read separately: `reconnects` is what a lost leg
 * scheduled, `watchdogs` is what the liveness clock is waiting on. Firing a
 * watchdog by hand is the deadline passing.
 */
function wired(silenceDeadlineMs = 30_000) {
  const legs: FakeLeg[] = [];
  const reconnects: Array<() => void> = [];
  const watchdogs: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const logs: string[] = [];
  const identity = generateIdentity();

  const daemon = new TunnelDaemon({
    hubUrl: "wss://hub.example",
    identity,
    acceptor: {
      accept: () => ({ ok: true as const, deviceId: "dev_a", close: () => {}, deliver: () => {} }),
    },
    transport: () => {
      const leg = new FakeLeg();
      legs.push(leg);
      return leg;
    },
    schedule: fn => {
      reconnects.push(fn);
      return { cancel: () => {} };
    },
    watchdog: (fn, ms) => {
      const entry = { fn, ms, cancelled: false };
      watchdogs.push(entry);
      return {
        cancel: () => {
          entry.cancelled = true;
        },
      };
    },
    silenceDeadlineMs,
    onLog: message => logs.push(message),
    random: () => 1,
    now: () => Date.parse("2026-09-06T01:05:41.000Z"),
  });

  const register = (leg: FakeLeg): void => {
    leg.deliver({ t: "challenge", v: PROTOCOL_VERSION, nonce: "n" });
    leg.deliver({ t: "registered", daemonId: identity.daemonId, instanceId: "inst_1" });
  };

  /** The one watchdog still armed, or a failure: the daemon must hold exactly one clock per leg. */
  const armed = (): { fn: () => void; ms: number } => {
    const live = watchdogs.filter(entry => !entry.cancelled);
    if (live.length !== 1) throw new Error(`expected one armed watchdog, found ${live.length}`);
    const only = live[0];
    if (only === undefined) throw new Error("unreachable");
    return only;
  };

  return { daemon, legs, reconnects, watchdogs, logs, register, armed };
}

describe("TunnelDaemon against a hub that has gone silent", () => {
  test("a registered leg that hears nothing for the deadline is replaced", () => {
    const { daemon, legs, reconnects, register, armed, logs } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first);
    expect(daemon.registered).toBe(true);

    // A few pings arrive, each one resetting the clock; the leg is healthy.
    for (let i = 0; i < 3; i++) first.deliver({ t: "ping" });
    expect(first.written.filter(raw => raw.includes('"pong"'))).toHaveLength(3);
    expect(armed().ms).toBe(30_000);
    expect(reconnects).toHaveLength(0);

    // Then nothing, for the whole deadline. The socket itself says nothing
    // either: that is the whole point.
    armed().fn();

    expect(daemon.registered).toBe(false);
    expect(first.closes).toEqual([{ code: 4008, reason: "hub silent" }]);
    expect(reconnects).toHaveLength(1);
    const verdict = logs.find(line => line.includes("presumed dead"));
    expect(verdict).toContain("code=4008");
    expect(verdict).toContain("decision=reconnect");

    // The redial goes out, and the new leg registers as any leg would.
    for (const fn of reconnects.splice(0)) fn();
    const second = legs[1];
    if (second === undefined) throw new Error("the presumed-dead leg was not replaced");
    register(second);
    expect(daemon.registered).toBe(true);
  });

  test("the dead leg's late close changes nothing", () => {
    const { daemon, legs, reconnects, register, armed } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first);
    armed().fn();
    for (const fn of reconnects.splice(0)) fn();
    const second = legs[1];
    if (second === undefined) throw new Error("no second leg was dialed");
    register(second);
    second.deliver({ t: "open", sessionId: "ses_live" });
    expect(daemon.sessionCount).toBe(1);

    // Minutes later the kernel gives up on the old socket and reports it.
    first.drop(1006, "");

    expect(daemon.registered).toBe(true);
    expect(daemon.sessionCount).toBe(1);
    expect(reconnects).toHaveLength(0);
    expect(legs).toHaveLength(2);
  });

  test("a dial the hub never answers is a dead leg too", () => {
    const { daemon, legs, reconnects, armed } = wired();

    daemon.start();
    expect(legs).toHaveLength(1);
    // No challenge, no anything: the dial hangs.
    armed().fn();

    expect(reconnects).toHaveLength(1);
    for (const fn of reconnects.splice(0)) fn();
    expect(legs).toHaveLength(2);
  });

  test("a leg the hub closed normally does not also get a silence verdict", () => {
    const { daemon, legs, reconnects, register, watchdogs, logs } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first);
    first.drop(1006, "Connection ended");
    expect(reconnects).toHaveLength(1);

    // Every clock armed for that leg is cancelled with it; firing the last one
    // anyway (a timer that had already been dispatched) must be inert.
    expect(watchdogs.every(entry => entry.cancelled)).toBe(true);
    for (const entry of watchdogs) entry.fn();
    expect(reconnects).toHaveLength(1);
    expect(logs.filter(line => line.includes("presumed dead"))).toHaveLength(0);
  });

  test("stopping the daemon disarms the watchdog", () => {
    const { daemon, legs, register, watchdogs, reconnects } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first);
    daemon.stop();

    expect(watchdogs.every(entry => entry.cancelled)).toBe(true);
    for (const entry of watchdogs) entry.fn();
    expect(reconnects).toHaveLength(0);
    expect(legs).toHaveLength(1);
  });
});
