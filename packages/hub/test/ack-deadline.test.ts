/**
 * The ack deadline, through the real relay.
 *
 * The hub tears any leg whose cumulative acknowledgement stays behind what it
 * has relayed for longer than its deadline. That guard is only fair if a
 * healthy leg acks current, and the handshake makes that subtle: the first
 * relayed frame in each direction is unsealed, so a leg that acks its sealed
 * channel's receipt count is one behind forever and every session dies at the
 * deadline no matter how alive it is. These tests pin both edges of that. An
 * idle session outlives the deadline on each leg -- the case no other test
 * covers, because they all finish a turn inside the deadline -- and a leg that
 * genuinely stops acknowledging is still torn, so making idling safe has not
 * neutered the guard.
 *
 * The hub's clock is injected, so the deadline is crossed by moving a number
 * rather than by waiting out real seconds. The tick that enforces the deadline
 * still runs on the hub's real interval, so each test leaves room for it to
 * fire. The shared harness binds `Date.now`, which is why the single-hub
 * fixture here is its counterpart with the clock threaded through.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  type AcceptResult,
  connectThroughHub,
  type DialSocket,
  type SessionAcceptor,
  TunnelDaemon,
  type TunnelSocketLike,
} from "@ompd/tunnel";
import { RecordingAudit } from "../src/audit.ts";
import { MemoryBackplane, MemoryBus } from "../src/backplane.ts";
import { Hub } from "../src/hub.ts";
import { MemoryRegistry } from "../src/registry.ts";
import { browserTransport, enroll, type FleetFixture, OPERATOR_TOKEN, until } from "./harness.ts";

/** The hub's own deadline is module-private. These tests only need to land decisively past it. */
const PAST_DEADLINE_MS = 60_000;
/**
 * Real milliseconds left for the hub's upkeep tick to run after the clock has
 * moved. The tick is a real interval created at listen time, so no fake-timer
 * patch can drive it; only its clock input is injectable. Two tick intervals
 * plus margin, so one missed scheduling still leaves a tick inside the
 * window. This is the one deliberate real delay in this file: everything
 * else is awaited by its own event.
 */
const SETTLE_MS = 12_000;

interface ClockedFleet extends FleetFixture {
  /** Move the hub's clock forward by `ms`. */
  advance(ms: number): void;
}

/**
 * Hubs as `startHubs` builds them, over one shared routing table, but with
 * the clock in the test's hand. Two instances share the clock because the
 * deadline each of them enforces must be crossed for both at once.
 */
async function startClockedHubs(count: number): Promise<ClockedFleet> {
  let clock = Date.now();
  const now = () => clock;

  const bus = new MemoryBus(now);
  const registry = new MemoryRegistry();
  const hubs: FleetFixture["hubs"] = [];

  for (let i = 0; i < count; i++) {
    const audit = new RecordingAudit();
    const backplane = new MemoryBackplane(bus, `inst-${i}`);
    const hub = new Hub({
      registry,
      backplane,
      operatorToken: OPERATOR_TOKEN,
      host: "127.0.0.1",
      port: 0,
      audit: audit.record,
      now,
    });
    const port = await hub.listen();
    hubs.push({ hub, url: `ws://127.0.0.1:${port}`, audit, backplane });
  }

  return {
    bus,
    registry,
    hubs,
    async stop(): Promise<void> {
      for (const entry of hubs) await entry.hub.stop();
    },
    advance(ms: number): void {
      clock += ms;
    },
  };
}

/**
 * An acceptor that echoes whatever it is given, tagged with the daemon's name.
 * The same stand-in the end-to-end suite uses: enough to drive a frame through
 * the session after the idle window, which is what "still alive" has to mean.
 */
function echoAcceptor(name: string, tokens: Record<string, string>): SessionAcceptor {
  return {
    accept(token, send): AcceptResult {
      const deviceId = tokens[token];
      if (deviceId === undefined) return { ok: false, reason: "unknown" };
      return {
        ok: true,
        deviceId,
        deliver: raw => send(JSON.stringify({ from: name, echo: JSON.parse(raw) })),
        close: () => {},
      };
    },
  };
}

interface Wired {
  daemon: TunnelDaemon;
  daemonId: string;
}

async function startDaemon(fleet: ClockedFleet, name: string, token: string): Promise<Wired> {
  const identity = await enroll(fleet, name);
  const daemon = new TunnelDaemon({
    hubUrl: fleet.hubs[0]?.url ?? "",
    identity,
    acceptor: echoAcceptor(name, { [token]: `dev_${name}` }),
    transport: browserTransport,
  });
  running.push(daemon);
  daemon.start();
  await until(() => daemon.registered, `${name} to register`);
  return { daemon, daemonId: identity.daemonId };
}

/**
 * Open a client and collect what it receives. `hubUrl` overrides which
 * instance the client lands on, for the split-leg tests; without it the
 * client takes the fleet's first hub.
 */
function openClient(
  fleet: ClockedFleet,
  daemonId: string,
  token: string,
  transport = browserTransport,
  hubUrl?: string,
) {
  const received: string[] = [];
  let opened = false;
  let closed: { code: number; reason: string } | null = null;

  const socket = connectThroughHub({
    hubUrl: hubUrl ?? fleet.hubs[0]?.url ?? "",
    daemonId,
    token,
    transport,
  });
  openSockets.push(socket);
  socket.onopen = () => {
    opened = true;
  };
  socket.onmessage = data => received.push(data);
  socket.onclose = info => {
    closed = info;
  };
  return {
    socket,
    received,
    get opened() {
      return opened;
    },
    get closed() {
      return closed;
    },
  };
}

let fleet: ClockedFleet | null = null;
const running: TunnelDaemon[] = [];
const openSockets: TunnelSocketLike[] = [];

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.close();
  for (const daemon of running.splice(0)) daemon.stop();
  await fleet?.stop();
  fleet = null;
});

describe("the ack deadline", () => {
  test("a client session left idle past the deadline stays open", async () => {
    fleet = await startClockedHubs(1);
    const wired = await startDaemon(fleet, "alpha", "token-a");
    const client = openClient(fleet, wired.daemonId, "token-a");
    await until(() => client.opened, "the session to open");

    // Nothing is exchanged from here on. The clock moves past the deadline
    // while the real hub keeps ticking, so if the leg were behind, this is
    // exactly the window in which it would be torn.
    fleet.advance(PAST_DEADLINE_MS);
    await Bun.sleep(SETTLE_MS);

    const torn = fleet.hubs[0]?.audit.forAction("session.torn") ?? [];
    expect(torn).toHaveLength(0);
    expect(client.closed).toBeNull();

    // Alive means usable, not merely unclosed: a turn still completes.
    client.socket.send(JSON.stringify({ t: "prompt", text: "still here" }));
    await until(() => client.received.length > 0, "a post-idle answer");
    expect(JSON.parse(client.received[0] ?? "{}")).toEqual({
      from: "alpha",
      echo: { t: "prompt", text: "still here" },
    });
  }, 30_000);

  test("a daemon leg left idle past the deadline stays open", async () => {
    fleet = await startClockedHubs(1);
    const wired = await startDaemon(fleet, "alpha", "token-a");
    const client = openClient(fleet, wired.daemonId, "token-a");
    await until(() => client.opened, "the session to open");

    fleet.advance(PAST_DEADLINE_MS);
    await Bun.sleep(SETTLE_MS);

    const torn = fleet.hubs[0]?.audit.forAction("session.torn") ?? [];
    expect(torn).toHaveLength(0);
    // The daemon-side session record itself survived, not just the socket.
    expect(wired.daemon.sessionCount).toBe(1);

    client.socket.send(JSON.stringify({ t: "prompt", text: "still here" }));
    await until(() => client.received.length > 0, "a post-idle answer");
    expect(JSON.parse(client.received[0] ?? "{}").from).toBe("alpha");
  }, 30_000);

  test("a client that stops acknowledging relayed frames is torn", async () => {
    fleet = await startClockedHubs(1);
    const wired = await startDaemon(fleet, "alpha", "token-a");
    const client = openClient(fleet, wired.daemonId, "token-a", muteAcks);
    await until(() => client.opened, "the session to open");

    fleet.advance(PAST_DEADLINE_MS);
    await until(() => client.closed !== null, "the silent client leg to be torn", 15_000);

    const torn = fleet.hubs[0]?.audit.forAction("session.torn") ?? [];
    expect(torn[0]?.code).toBe("relay_broken");
    expect(torn[0]?.detail?.message).toBe("client side stopped acknowledging relayed frames");
    // The daemon was told too, so it is not left holding a dead session.
    await until(() => wired.daemon.sessionCount === 0, "the daemon to drop the torn session");
  }, 30_000);

  test("a daemon that stops acknowledging relayed frames is torn", async () => {
    fleet = await startClockedHubs(1);
    const identity = await enroll(fleet, "alpha");
    const daemon = new TunnelDaemon({
      hubUrl: fleet.hubs[0]?.url ?? "",
      identity,
      acceptor: echoAcceptor("alpha", { "token-a": "dev_a" }),
      transport: muteDaemonAcks,
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the silent daemon to register");

    const client = openClient(fleet, identity.daemonId, "token-a");
    await until(() => client.opened, "the session to open");

    fleet.advance(PAST_DEADLINE_MS);
    await until(() => client.closed !== null, "the silent daemon leg to be torn", 15_000);

    const torn = fleet.hubs[0]?.audit.forAction("session.torn") ?? [];
    expect(torn[0]?.code).toBe("relay_broken");
    expect(torn[0]?.detail?.message).toBe("daemon side stopped acknowledging relayed frames");
    expect(daemon.sessionCount).toBe(0);
  }, 30_000);

  test("a session split across two hub instances outlives the deadline on both legs", async () => {
    fleet = await startClockedHubs(2);
    // The daemon dials instance A only; the client lands on instance B, which
    // holds no leg for it and routes over the shared table. That is the
    // topology the removed ack envelope existed for, and the only one where
    // crediting an ack anywhere but the socket it arrived on could plausibly
    // have been load-bearing.
    const wired = await startDaemon(fleet, "alpha", "token-a");
    const client = openClient(fleet, wired.daemonId, "token-a", browserTransport, fleet.hubs[1]?.url ?? "");
    await until(() => client.opened, "the cross-instance session to open");

    // A turn each way first, so both ledgers hold real counts before idling.
    client.socket.send(JSON.stringify({ t: "prompt", text: "across" }));
    await until(() => client.received.length > 0, "a cross-instance answer");

    fleet.advance(PAST_DEADLINE_MS);
    await Bun.sleep(SETTLE_MS);

    // Neither instance tore anything. The client leg is judged on B, where
    // its acks arrive; the daemon-side session is judged on A, where the
    // daemon's acks arrive. Neither count ever needed to travel.
    for (const entry of fleet.hubs) {
      expect(entry.audit.forAction("session.torn")).toHaveLength(0);
    }
    expect(wired.daemon.sessionCount).toBe(1);
    expect(client.closed).toBeNull();

    client.socket.send(JSON.stringify({ t: "prompt", text: "still here" }));
    await until(() => client.received.length > 1, "a post-idle answer");
    expect(JSON.parse(client.received[1] ?? "{}").echo).toEqual({ t: "prompt", text: "still here" });
  }, 30_000);

  test("a healthy chatty client does not keep a silent daemon leg alive", async () => {
    fleet = await startClockedHubs(1);
    const identity = await enroll(fleet, "alpha");
    const daemon = new TunnelDaemon({
      hubUrl: fleet.hubs[0]?.url ?? "",
      identity,
      acceptor: echoAcceptor("alpha", { "token-a": "dev_a" }),
      transport: muteDaemonAcks,
    });
    running.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the silent daemon to register");

    const client = openClient(fleet, identity.daemonId, "token-a");
    await until(() => client.opened, "the session to open");

    // The client acks every frame it is given, throughout the window. Before
    // the ledger fix its counts were also landing on the daemon-side session
    // ledger, and a daemon that had stopped acknowledging rode them past its
    // own deadline undetected.
    fleet.advance(PAST_DEADLINE_MS);
    const chatter = (async () => {
      for (let i = 0; i < 40 && client.closed === null; i++) {
        client.socket.send(JSON.stringify({ t: "prompt", text: `chatter ${i}` }));
        await Bun.sleep(250);
      }
    })();
    await until(() => client.closed !== null, "the silent daemon leg to be torn", 15_000);
    await chatter;

    const torn = fleet.hubs[0]?.audit.forAction("session.torn") ?? [];
    expect(torn[0]?.code).toBe("relay_broken");
    expect(torn[0]?.detail?.message).toBe("daemon side stopped acknowledging relayed frames");
    expect(daemon.sessionCount).toBe(0);
  }, 30_000);
});

/**
 * A client transport that swallows exactly the cumulative acks.
 *
 * The handshake and every sealed frame still flow, so the leg is healthy in
 * every respect but one: it never tells the relay what it has taken in. That
 * is what a client that stopped acknowledging looks like from the hub's side,
 * and it is the case the deadline guard exists for.
 */
function muteAcks(target: string): TunnelSocketLike {
  const inner = browserTransport(target);
  return {
    get readyState() {
      return inner.readyState;
    },
    set readyState(value: number) {
      inner.readyState = value;
    },
    send: data => {
      const frame = JSON.parse(data) as { t?: string };
      if (frame.t === "ack") return;
      inner.send(data);
    },
    close: (code, reason) => inner.close(code, reason),
    get onopen() {
      return inner.onopen;
    },
    set onopen(fn) {
      inner.onopen = fn;
    },
    get onclose() {
      return inner.onclose;
    },
    set onclose(fn) {
      inner.onclose = fn;
    },
    get onerror() {
      return inner.onerror;
    },
    set onerror(fn) {
      inner.onerror = fn;
    },
    get onmessage() {
      return inner.onmessage;
    },
    set onmessage(fn) {
      inner.onmessage = fn;
    },
  };
}

/** The daemon-side counterpart: acks vanish, everything else flows. */
function muteDaemonAcks(target: string): DialSocket {
  const inner = browserTransport(target);
  const socket: DialSocket = {
    send: data => {
      const frame = JSON.parse(data) as { t?: string };
      if (frame.t === "ack") return;
      inner.send(data);
    },
    close: (code, reason) => inner.close(code, reason),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
  };
  inner.onopen = () => socket.onopen?.();
  inner.onclose = info => socket.onclose?.(info);
  inner.onerror = info => socket.onerror?.(info);
  inner.onmessage = data => socket.onmessage?.(data);
  return socket;
}
