/**
 * The reconnect storm: a dead socket's close event steering the live one.
 *
 * Observed as hundreds of abnormal 1006 closes and a repeating
 * `tunnel closed (4409 replaced by a newer connection); reconnecting` in one
 * daemon's log, with the hub tearing sessions at its ack deadline
 * (`relay_broken`, "daemon side stopped acknowledging relayed frames") the
 * whole time.
 *
 * The hub is behaving correctly at both ends of that. Registering a daemon
 * replaces any earlier leg for the same id and closes it 4409 (`hub.ts`
 * `#register`), which is what keeps one daemon's sessions from splitting
 * across two legs. Tearing a session whose daemon stopped acking is what the
 * deadline is for.
 *
 * The defect is that `TunnelDaemon` bound one `onclose` per dialed socket but
 * let it act on state owned by whichever socket is current. So the 4409 for a
 * socket already superseded ran against its own replacement: nulled the live
 * socket (which silently turned every later `#send`, acks included, into a
 * no-op and so produced the hub's `relay_broken`), tore the live socket's
 * sessions, cleared `registered`, and dialed *again* -- which the hub answered
 * by 4409-ing the leg that had just registered. That is the loop.
 *
 * Driven through the two seams the class already exposes for it, `transport`
 * and `schedule`, so the ordering is exact rather than raced: no sockets, no
 * timers, no hub.
 */

import { describe, expect, test } from "bun:test";
import type { DialSocket } from "../src/daemon.ts";
import { TunnelDaemon } from "../src/daemon.ts";
import { generateIdentity } from "../src/identity.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

/** One dialed leg, recording what the daemon wrote to it. */
class FakeLeg implements DialSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  readonly written: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  send(data: string): void {
    this.written.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code: code ?? 1000, reason: reason ?? "" };
  }

  /** What the hub would say on connect, and the daemon's answer to it. */
  challenge(nonce: string): void {
    this.onmessage?.(JSON.stringify({ t: "challenge", v: PROTOCOL_VERSION, nonce }));
  }

  registered(daemonId: string, instanceId: string): void {
    this.onmessage?.(JSON.stringify({ t: "registered", daemonId, instanceId }));
  }

  deliver(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame));
  }

  /** The hub dropping this leg, with no close frame (Bun's idle timeout) or with 4409. */
  drop(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  framesOfType(t: string): Array<Record<string, unknown>> {
    return this.written.map(raw => JSON.parse(raw) as Record<string, unknown>).filter(frame => frame.t === t);
  }
}

/** The daemon under test, with every timer and socket in the test's hands. */
function wired() {
  const legs: FakeLeg[] = [];
  const pending: Array<() => void> = [];
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
    // Reconnects are queued rather than timed, so "did this close schedule a
    // redial" is a question the test can answer exactly.
    schedule: fn => {
      pending.push(fn);
      return { cancel: () => {} };
    },
    onLog: message => logs.push(message),
    random: () => 0,
    // Fixed, because the log lines are asserted on: the timestamp is part of
    // the diagnostic surface, not decoration.
    now: () => Date.parse("2026-08-24T06:00:00.000Z"),
  });

  /** Take one leg from dialed to registered, the way the hub would. */
  const register = (leg: FakeLeg, instanceId: string): void => {
    leg.challenge(`nonce-${instanceId}`);
    leg.registered(identity.daemonId, instanceId);
  };

  /** Run every queued reconnect, as the backoff timer eventually would. */
  const runReconnects = (): void => {
    for (const fn of pending.splice(0)) fn();
  };

  return { daemon, legs, pending, logs, identity, register, runReconnects };
}

describe("TunnelDaemon stale socket ownership", () => {
  test("a superseded leg's 4409 does not unseat the leg that replaced it", () => {
    const { daemon, legs, register, runReconnects, pending } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    expect(daemon.registered).toBe(true);

    // The hub's idle timeout drops the leg with no close frame. This is a
    // legitimate close of the current socket, so it must reconnect.
    first.drop(1006, "");
    expect(pending).toHaveLength(1);
    runReconnects();

    const second = legs[1];
    if (second === undefined) throw new Error("no second leg was dialed");
    register(second, "hub-2");
    expect(daemon.registered).toBe(true);

    // Now the late 4409 for the *first* leg lands, which is exactly what the
    // hub sends when the second leg's registration replaced it. It is about a
    // socket that is already gone, so it must change nothing.
    first.drop(4409, "replaced by a newer connection");

    expect(daemon.registered).toBe(true);
    // No third dial: the storm was this close redialing on the live leg's
    // behalf, and the hub answering that dial by 4409-ing the live leg.
    expect(pending).toHaveLength(0);
    expect(legs).toHaveLength(2);
  });

  test("the live leg keeps sending after a superseded leg closes", () => {
    const { daemon, legs, register, runReconnects } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    first.drop(1006, "");
    runReconnects();

    const second = legs[1];
    if (second === undefined) throw new Error("no second leg was dialed");
    register(second, "hub-2");
    first.drop(4409, "replaced by a newer connection");

    // The ack path is the one that mattered in production: a nulled socket
    // made every ack a silent no-op, and the hub tore the session at its
    // deadline as a leg that had stopped acknowledging. A pong proves the
    // same `#send` the acks travel down still reaches the live leg.
    second.deliver({ t: "ping" });
    expect(second.framesOfType("pong")).toHaveLength(1);
  });

  test("a superseded leg's close does not tear the live leg's sessions", () => {
    const { daemon, legs, register, runReconnects } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    first.drop(1006, "");
    runReconnects();

    const second = legs[1];
    if (second === undefined) throw new Error("no second leg was dialed");
    register(second, "hub-2");
    second.deliver({ t: "open", sessionId: "ses_live" });
    expect(daemon.sessionCount).toBe(1);

    first.drop(4409, "replaced by a newer connection");
    expect(daemon.sessionCount).toBe(1);
  });

  test("the current leg closing still reconnects and still tears its own sessions", () => {
    const { daemon, legs, register, runReconnects, pending } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    first.deliver({ t: "open", sessionId: "ses_a" });
    expect(daemon.sessionCount).toBe(1);

    first.drop(4409, "replaced by a newer connection");

    // Nothing superseded this one, so the ordinary recovery must be intact:
    // sessions gone, registration dropped, redial queued.
    expect(daemon.sessionCount).toBe(0);
    expect(daemon.registered).toBe(false);
    expect(pending).toHaveLength(1);
    runReconnects();
    expect(legs).toHaveLength(2);
  });

  test("stop is not undone by a superseded leg closing afterwards", () => {
    const { daemon, legs, register, runReconnects, pending } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    first.drop(1006, "");
    runReconnects();
    const second = legs[1];
    if (second === undefined) throw new Error("no second leg was dialed");
    register(second, "hub-2");

    daemon.stop();
    first.drop(4409, "replaced by a newer connection");
    second.drop(1006, "");

    expect(pending).toHaveLength(0);
    expect(legs).toHaveLength(2);
    expect(daemon.registered).toBe(false);
  });
});

describe("TunnelDaemon reconnect logging", () => {
  test("each close says when, which leg, why, and what was decided", () => {
    const { daemon, legs, logs, register, runReconnects } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    first.drop(1006, "");
    runReconnects();
    const second = legs[1];
    if (second === undefined) throw new Error("no second leg was dialed");
    register(second, "hub-2");
    first.drop(4409, "replaced by a newer connection");

    const closes = logs.filter(line => line.startsWith("tunnel closed"));
    expect(closes).toHaveLength(2);

    // The close that owned its leg: it reconnected, and the line says so
    // along with how long the leg lasted and the wait, which is what makes a
    // storm's cadence readable and a flap distinguishable from a clean drop.
    expect(closes[0]).toBe(
      'tunnel closed at=2026-08-24T06:00:00.000Z gen=1 live=1 code=1006 reason="" lived=0ms decision=reconnect attempt=1 delay=0ms',
    );
    // The superseded one names both generations, so a log reader can see the
    // close was about a leg two dials old rather than the live one.
    expect(closes[1]).toBe(
      'tunnel closed at=2026-08-24T06:00:00.000Z gen=1 live=2 code=4409 reason="replaced by a newer connection" decision=ignored_superseded',
    );
  });

  test("the churn markers the path check greps for survive the new format", () => {
    const { daemon, legs, logs, register } = wired();

    daemon.start();
    const first = legs[0];
    if (first === undefined) throw new Error("no leg was dialed");
    register(first, "hub-1");
    first.drop(4409, "replaced by a newer connection");

    // `scripts/check-path.ts` counts churn with `includes("tunnel closed")`
    // and `includes("4409")`, and matches `/tunnel (registered|closed|error)/`.
    // Those substrings are load-bearing outside this package.
    const line = logs.find(entry => entry.includes("tunnel closed"));
    expect(line).toBeDefined();
    expect(line).toContain("4409");
    expect(/tunnel (registered|closed|error)/.test(line ?? "")).toBe(true);
  });
});
