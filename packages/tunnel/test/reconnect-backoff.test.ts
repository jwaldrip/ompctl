/**
 * Backoff against a hub that accepts a registration and then drops it.
 *
 * Observed on Jason's daemon after the generation fix landed. The stale-socket
 * race was gone (every close read `gen=N live=N`, none superseded) but the
 * LINKED badge on his phone still flopped. `~/.ompd/ompd.log` explains it: six
 * disconnect/register cycles between 13:07:08 and 13:07:15 UTC, and every one
 * of them logged `attempt=1`, with reconnect delays of 50ms, 280ms, 113ms,
 * 336ms and 408ms.
 *
 * `attempt` was reset to 0 the moment a `registered` frame arrived, so a leg
 * that registered and died a second later started its next backoff from the
 * floor. The exponential backoff existed and never engaged. The contrast is in
 * the logs: pointed at a hub that never accepts at all, the same binary walks
 * 487, 432, 1567, 1025, 3773, 9244, 6976, 15177ms exactly as designed.
 *
 * That matters because the hub tears the phone's leg the instant the daemon's
 * leg drops. The phone reconnects and replays its attach set, that burst is
 * relayed onto the fresh daemon leg, and the hub rate-limits the leg at 200
 * frames burst (`RATE_BURST`, hub.ts), closing it 4429. The first close of the
 * observed burst was exactly that. Retrying 100ms later re-enters the loop
 * before the token bucket has refilled; backing off lets it drain.
 *
 * A registration is therefore not proof of a healthy link. Outliving a
 * stability window is.
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

  send(data: string): void {
    this.written.push(data);
  }

  close(): void {}

  drop(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/**
 * `random: () => 1` makes full jitter return the ceiling exactly, so a delay
 * reads the backoff rather than a sample of it. The clock is manual because
 * "how long did this leg live" is the thing under test.
 */
function wired(opts: { minBackoffMs?: number; maxBackoffMs?: number } = {}) {
  const legs: FakeLeg[] = [];
  const pending: Array<() => void> = [];
  const logs: string[] = [];
  const identity = generateIdentity();
  let clock = Date.parse("2026-08-24T13:07:00.000Z");

  const daemon = new TunnelDaemon({
    hubUrl: "wss://hub.example",
    identity,
    acceptor: {
      accept: () => ({ ok: true as const, deviceId: "dev_a", close: () => {}, deliver: () => {} }),
    },
    minBackoffMs: opts.minBackoffMs ?? 500,
    maxBackoffMs: opts.maxBackoffMs ?? 30_000,
    transport: () => {
      const leg = new FakeLeg();
      legs.push(leg);
      return leg;
    },
    schedule: fn => {
      pending.push(fn);
      return { cancel: () => {} };
    },
    onLog: message => logs.push(message),
    random: () => 1,
    now: () => clock,
  });

  const register = (leg: FakeLeg): void => {
    leg.onmessage?.(JSON.stringify({ t: "challenge", v: PROTOCOL_VERSION, nonce: "n" }));
    leg.onmessage?.(JSON.stringify({ t: "registered", daemonId: identity.daemonId, instanceId: "inst_1" }));
  };

  const runReconnects = (): void => {
    for (const fn of pending.splice(0)) fn();
  };

  /** Delays in the order the close lines reported them. */
  const delays = (): number[] =>
    logs
      .filter(line => line.includes("decision=reconnect"))
      .map(line => Number(/delay=(\d+)ms/.exec(line)?.[1] ?? "-1"));

  const attempts = (): number[] =>
    logs
      .filter(line => line.includes("decision=reconnect"))
      .map(line => Number(/attempt=(\d+)/.exec(line)?.[1] ?? "-1"));

  return {
    daemon,
    legs,
    logs,
    register,
    runReconnects,
    delays,
    attempts,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("TunnelDaemon backoff against a flapping hub", () => {
  test("a leg that registers and dies at once still escalates its backoff", () => {
    const { daemon, legs, register, runReconnects, delays, attempts, advance } = wired();

    daemon.start();
    // Five cycles of exactly what the hub did: accept the registration, then
    // drop the leg about a second later.
    for (let cycle = 0; cycle < 5; cycle++) {
      const leg = legs[cycle];
      if (leg === undefined) throw new Error(`no leg dialed for cycle ${cycle}`);
      register(leg);
      advance(1_000);
      leg.drop(1006, "Connection ended");
      runReconnects();
    }

    // Before the fix every one of these read attempt=1 and a sub-500ms delay,
    // which is what let the daemon re-enter the hub's rate limit immediately.
    expect(attempts()).toEqual([1, 2, 3, 4, 5]);
    expect(delays()).toEqual([500, 1000, 2000, 4000, 8000]);
  });

  test("a leg that stayed up is not treated as a flap", () => {
    const { daemon, legs, register, runReconnects, delays, attempts, advance } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg dialed");
    register(first);
    // The ordinary case in his log: hourly drops off a link that was healthy
    // in between. Recovery must stay immediate for these.
    advance(3_600_000);
    first.drop(1006, "Connection ended");
    runReconnects();

    const second = legs[1];
    if (second === undefined) throw new Error("no second leg dialed");
    register(second);
    advance(3_600_000);
    second.drop(1006, "Connection ended");
    runReconnects();

    expect(attempts()).toEqual([1, 1]);
    expect(delays()).toEqual([500, 500]);
  });

  test("a flap that recovers into a durable link clears the escalation", () => {
    const { daemon, legs, register, runReconnects, delays, advance } = wired();

    daemon.start();
    // Two quick flaps, then one that holds.
    for (let cycle = 0; cycle < 2; cycle++) {
      const leg = legs[cycle];
      if (leg === undefined) throw new Error(`no leg dialed for cycle ${cycle}`);
      register(leg);
      advance(1_000);
      leg.drop(1006, "Connection ended");
      runReconnects();
    }
    const settled = legs[2];
    if (settled === undefined) throw new Error("no third leg dialed");
    register(settled);
    advance(600_000);
    settled.drop(1006, "Connection ended");
    runReconnects();

    // 500, 1000 while flapping, then back to the floor once a leg proved out.
    expect(delays()).toEqual([500, 1000, 500]);
  });

  test("a hub that never accepts still escalates, unchanged", () => {
    const { daemon, legs, runReconnects, delays, advance } = wired();

    daemon.start();
    for (let cycle = 0; cycle < 4; cycle++) {
      const leg = legs[cycle];
      if (leg === undefined) throw new Error(`no leg dialed for cycle ${cycle}`);
      advance(10);
      leg.drop(1006, "Failed to connect");
      runReconnects();
    }

    // This path already worked and must keep working: it is the behaviour the
    // scratch-instance run against a dead port demonstrated.
    expect(delays()).toEqual([500, 1000, 2000, 4000]);
  });

  test("escalation is capped at the ceiling", () => {
    const { daemon, legs, register, runReconnects, delays, advance } = wired({
      minBackoffMs: 500,
      maxBackoffMs: 2_000,
    });

    daemon.start();
    for (let cycle = 0; cycle < 5; cycle++) {
      const leg = legs[cycle];
      if (leg === undefined) throw new Error(`no leg dialed for cycle ${cycle}`);
      register(leg);
      advance(1_000);
      leg.drop(1006, "Connection ended");
      runReconnects();
    }

    expect(delays()).toEqual([500, 1000, 2000, 2000, 2000]);
  });
});
