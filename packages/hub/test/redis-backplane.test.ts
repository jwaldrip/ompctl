/**
 * The backplane Cloud Run actually runs on, against a real Redis.
 *
 * Skipped unless `OMPD_TEST_REDIS_URL` names one, because a test that quietly
 * passes without the dependency it is testing is worse than no test. Start one
 * with `docker run --rm -p 6379:6379 redis:7-alpine` and set the variable.
 *
 * What is worth proving here is the part a memory implementation cannot: that
 * two processes agree about where a daemon is, that a lease actually expires,
 * and that compare-and-set stops a stale instance from evicting the live one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { generateIdentity, TunnelDaemon } from "@ompd/tunnel";
import { RedisClient } from "bun";
import { RecordingAudit } from "../src/audit.ts";
import type { RelayEnvelope } from "../src/backplane.ts";
import { Hub } from "../src/hub.ts";
import { RedisBackplane } from "../src/redis-backplane.ts";
import { MemoryRegistry } from "../src/registry.ts";
import { browserTransport, connectThroughHub, until } from "./harness.ts";

const url = process.env.OMPD_TEST_REDIS_URL;
const describeRedis = url === undefined ? describe.skip : describe;

const backplanes: RedisBackplane[] = [];
const hubs: Hub[] = [];
const daemons: TunnelDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.stop();
  for (const hub of hubs.splice(0)) await hub.stop();
  for (const backplane of backplanes.splice(0)) await backplane.close();
});

async function backplane(instanceId: string): Promise<RedisBackplane> {
  const created = await RedisBackplane.connect({ url: url ?? "", instanceId: `${instanceId}-${crypto.randomUUID()}` });
  backplanes.push(created);
  return created;
}

interface SoloFixture {
  port: number;
  daemonId: string;
  backplane: RedisBackplane;
}

/** One hub instance holding both legs, over redis: the deployed arrangement. */
async function soloHub(): Promise<SoloFixture> {
  const registry = new MemoryRegistry();
  const identity = generateIdentity();
  await registry.enroll({ publicKey: identity.publicKey, label: "solo" });

  const plane = await backplane("solo");
  const hub = new Hub({
    registry,
    backplane: plane,
    host: "127.0.0.1",
    port: 0,
    audit: new RecordingAudit().record,
  });
  hubs.push(hub);
  const port = await hub.listen();

  const daemon = new TunnelDaemon({
    hubUrl: `ws://127.0.0.1:${port}`,
    identity,
    transport: browserTransport,
    acceptor: {
      accept: (token, send) =>
        token === "token-a"
          ? { ok: true, deviceId: "dev_a", deliver: raw => send(`echoed:${raw}`), close: () => {} }
          : { ok: false, reason: "unknown" },
    },
  });
  daemons.push(daemon);
  daemon.start();
  await until(() => daemon.registered, "the daemon to register");
  return { port, daemonId: identity.daemonId, backplane: plane };
}

/**
 * One relayed round trip, reporting what came back or why nothing did.
 *
 * Returns rather than asserts so a caller can retry it: a relay recovering
 * from a lost subscription is exactly a sequence of attempts where the early
 * ones legitimately fail.
 */
async function relayEcho(fixture: SoloFixture, text: string): Promise<string> {
  const got: string[] = [];
  let opened = false;
  let failed = "";
  const socket = connectThroughHub({
    hubUrl: `ws://127.0.0.1:${fixture.port}`,
    daemonId: fixture.daemonId,
    token: "token-a",
    transport: browserTransport,
  });
  socket.onopen = () => {
    opened = true;
    socket.send(text);
  };
  socket.onerror = info => {
    failed = info.message;
  };
  socket.onmessage = data => got.push(data);
  try {
    await until(() => got.length === 1 || failed !== "", "a relayed answer", 3000);
  } catch {
    // A relay that routes nothing produces no frame and no error, so the
    // timeout is the answer rather than a failure to get one.
  }
  socket.close();
  if (got.length > 0) return got[0] ?? "";
  if (failed !== "") return `error:${failed}`;
  return opened ? "opened-but-silent" : "never-opened";
}

describeRedis("redis backplane", () => {
  test("presence is visible from another instance", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const daemonId = generateIdentity().daemonId;

    expect(await b.locateDaemon(daemonId)).toBeNull();
    await a.claimDaemon(daemonId, 5_000);
    expect(await b.locateDaemon(daemonId)).toBe(a.instanceId);
  });

  test("a lease expires on its own, so a dead instance stops being an address", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const daemonId = generateIdentity().daemonId;

    // Short on purpose: the property is that nothing has to clean up after an
    // instance that was killed without running any shutdown code.
    await a.claimDaemon(daemonId, 150);
    expect(await b.locateDaemon(daemonId)).toBe(a.instanceId);
    await until(async () => (await b.locateDaemon(daemonId)) === null, "the lease to lapse");
  });

  test("renew only extends a lease this instance still holds", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const daemonId = generateIdentity().daemonId;

    await a.claimDaemon(daemonId, 5_000);
    expect(await a.renewDaemon(daemonId, 5_000)).toBe(true);

    // The daemon reconnects to B, which takes the lease over. A must not be
    // able to renew or release it now: doing either would make the daemon
    // unroutable while looking perfectly healthy.
    await b.claimDaemon(daemonId, 5_000);
    expect(await a.renewDaemon(daemonId, 5_000)).toBe(false);
    await a.releaseDaemon(daemonId);
    expect(await b.locateDaemon(daemonId)).toBe(b.instanceId);
  });

  test("envelopes reach the addressed instance and nobody else", async () => {
    const a = await backplane("a");
    const b = await backplane("b");
    const c = await backplane("c");

    const atB: RelayEnvelope[] = [];
    const atC: RelayEnvelope[] = [];
    b.onEnvelope(envelope => atB.push(envelope));
    c.onEnvelope(envelope => atC.push(envelope));

    await a.send(b.instanceId, { k: "open", sessionId: "s1", from: a.instanceId, daemonId: "dmn_x" });
    await until(() => atB.length === 1, "the envelope to arrive at B");
    expect(atB[0]?.sessionId).toBe("s1");
    expect(atC).toEqual([]);
  });

  test("a client on one instance reaches a daemon held by another, over redis", async () => {
    const registry = new MemoryRegistry();
    const identity = generateIdentity();
    await registry.enroll({ publicKey: identity.publicKey, label: "alpha" });

    const hubA = new Hub({
      registry,
      backplane: await backplane("hub-a"),
      host: "127.0.0.1",
      port: 0,
      audit: new RecordingAudit().record,
    });
    const hubB = new Hub({
      registry,
      backplane: await backplane("hub-b"),
      host: "127.0.0.1",
      port: 0,
      audit: new RecordingAudit().record,
    });
    hubs.push(hubA, hubB);
    const portA = await hubA.listen();
    const portB = await hubB.listen();

    const daemon = new TunnelDaemon({
      hubUrl: `ws://127.0.0.1:${portA}`,
      identity,
      transport: browserTransport,
      acceptor: {
        accept: (token, send) =>
          token === "token-a"
            ? { ok: true, deviceId: "dev_a", deliver: raw => send(`echoed:${raw}`), close: () => {} }
            : { ok: false, reason: "unknown" },
      },
    });
    daemons.push(daemon);
    daemon.start();
    await until(() => daemon.registered, "the daemon to register with hub A");

    const got: string[] = [];
    let opened = false;
    const socket = connectThroughHub({
      hubUrl: `ws://127.0.0.1:${portB}`,
      daemonId: identity.daemonId,
      token: "token-a",
      transport: browserTransport,
    });
    socket.onopen = () => {
      opened = true;
    };
    socket.onmessage = data => got.push(data);
    await until(() => opened, "a session across two hub processes");

    socket.send("ping");
    await until(() => got.length === 1, "the answer back across redis");
    expect(got[0]).toBe("echoed:ping");
    socket.close();
  });

  /**
   * The shape production runs, which the two-instance test above does not cover.
   *
   * `max_instance_count = 1` puts both legs of every session in one process,
   * and every cross-leg frame still leaves through redis and has to come back.
   * So the deployed relay depends on this instance's own channel reaching this
   * instance, and nothing proved that until here.
   */
  test("a client reaches a daemon held by the same instance, over redis", async () => {
    const fixture = await soloHub();
    expect(await relayEcho(fixture, "ping")).toBe("echoed:ping");
  });

  /**
   * A subscription is per-connection state, and `RedisClient` replaces its
   * socket on its own without re-issuing `SUBSCRIBE`.
   *
   * That failure is silent in the worst way. `PUBLISH` to a channel with no
   * subscriber succeeds, the commands connection keeps answering lease lookups,
   * and so the hub keeps telling every device `linked` and then routes nothing:
   * a phone that lists sessions gets an empty fleet, forever, with no error on
   * either leg. The two connections do not even fail together, because the
   * commands one renews a lease every few seconds while the subscriber carries
   * no bytes at all between sessions and is the one an idle reaper collects.
   *
   * `CLIENT KILL TYPE pubsub` reproduces exactly that asymmetry.
   */
  test("the receive path is restored after its subscription is lost", async () => {
    const fixture = await soloHub();
    expect(await relayEcho(fixture, "before")).toBe("echoed:before");

    // Killed by client id off `CLIENT LIST`, not by `TYPE pubsub`. Under RESP3
    // a subscribed client is not necessarily in subscriber mode, so the type
    // filter can match nothing and this test would then pass without ever
    // breaking the thing it exists to break. The `sub` count is the fact that
    // actually identifies the receive path, and asserting something was killed
    // is what stops a silent no-op from reading as a pass.
    const killer = new RedisClient(url ?? "");
    await killer.connect();
    const listing = String(await killer.send("CLIENT", ["LIST"]));
    let killed = 0;
    for (const line of listing.split("\n")) {
      const id = /(?:^| )id=(\d+)/.exec(line)?.[1];
      const subs = Number(/(?:^| )sub=(\d+)/.exec(line)?.[1] ?? "0");
      if (id === undefined || subs === 0) continue;
      killed += Number(await killer.send("CLIENT", ["KILL", "ID", id]));
    }
    killer.close();
    expect(killed).toBeGreaterThan(0);

    // The lease is untouched, which is what makes this invisible: the hub still
    // believes the daemon is reachable and still admits every client.
    expect(await fixture.backplane.locateDaemon(fixture.daemonId)).not.toBeNull();

    // Awaiting the relay itself rather than a duration: recovery is whatever
    // the backplane's own probe deadline makes it, and the only thing worth
    // asserting is that a device can reach the daemon again without either
    // side reconnecting.
    await until(
      async () => (await relayEcho(fixture, "after")) === "echoed:after",
      "the relay to route again after losing its subscription",
      40_000,
    );
    // Longer than bun's default, necessarily: recovery is bounded by the
    // backplane's probe deadline, which is deliberately slower than one missed
    // probe so that a reconnect already healing itself is not interrupted.
  }, 60_000);
});
