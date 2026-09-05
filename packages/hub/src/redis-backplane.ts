/**
 * The backplane Cloud Run actually runs on.
 *
 * Two connections, because a Redis connection in subscribe mode cannot issue
 * ordinary commands. One publishes and holds the presence leases, the other
 * does nothing but listen on this instance's channel.
 *
 * Leases are compare-and-set on renew and compare-and-delete on release, both
 * as scripts so the check and the write cannot be separated by another
 * instance's write. Without that, an instance whose lease had already been
 * taken over by a reconnecting daemon would renew or delete the new holder's
 * entry, and the daemon would become unroutable while looking perfectly
 * healthy.
 *
 * A daemon reconnecting to a different instance overwrites the lease outright.
 * That is deliberate: the daemon's live socket is the truth about where it is,
 * and the previous holder finds out when its next renew returns false.
 */

import { RedisClient } from "bun";
import type { Backplane, DisruptionHandler, EnvelopeHandler, RelayEnvelope } from "./backplane.ts";

const LEASE_PREFIX = "ompd:hub:daemon:";
const CHANNEL_PREFIX = "ompd:hub:inst:";

/** Extend only if this instance still holds it. */
const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

/** Delete only if this instance still holds it. */
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/**
 * How often this instance proves to itself that it can still receive.
 *
 * A subscription is per-connection state, and `RedisClient` replaces its socket
 * on its own. Nothing re-issues the `SUBSCRIBE` when it does, so the loss is
 * invisible from the publishing side: `PUBLISH` to a channel with no subscriber
 * succeeds and reports zero, and this process has no reason to look at that
 * number. Meanwhile the commands connection stays useful, because it renews a
 * lease every few seconds and reconnects on demand.
 *
 * The result is a relay that answers `linked` to every device, because that
 * needs only the registry and the lease, and then routes nothing at all. So the
 * receive path is checked rather than assumed, by sending a message to this
 * instance's own channel and requiring it to arrive.
 *
 * It doubles as the only traffic the subscriber connection ever carries between
 * sessions, which is what made it the connection an idle reaper collects and
 * the commands connection one it leaves alone.
 */
const PROBE_INTERVAL_MS = 5_000;

/**
 * How long the receive path may stay unproven before it is declared lost.
 *
 * Two missed probes rather than one: a single publish can lose a race with a
 * reconnect that is already healing itself, and replacing a working connection
 * costs every session on it.
 */
const PROBE_DEADLINE_MS = 12_000;

/**
 * The subscriber never reconnects on its own. A reconnected socket carries no
 * subscription (nothing re-issues `SUBSCRIBE`), so Bun's automatic reconnect
 * buys this connection nothing: the probe above is what notices the loss and
 * `#checkReceivePath` replaces the whole client. Worse, a client caught
 * mid-reconnect when it is closed rejects that reconnect on a promise nobody
 * holds, which surfaced as `RedisError: Connection closed` between tests in
 * roughly one run in three while every test passed. With no reconnect there
 * is no such promise: a killed subscriber socket closes, `onclose` reports it,
 * and the replacement is the only path back.
 */
const SUBSCRIBER_OPTIONS = { autoReconnect: false } as const;

export interface RedisBackplaneOptions {
  url: string;
  instanceId: string;
  /** Test seam, matching `HubOptions`, so a deadline can be reached on demand. */
  now?: () => number;
}

/**
 * Narrows an unknown thrown/rejected value to Bun's specific "the socket
 * closed while this was in flight" RedisError, the one documented shape of
 * teardown noise `close()` deliberately swallows. Anything else keeps
 * surfacing.
 */
function isRedisConnectionClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (!("code" in err)) return false;
  return err.code === "ERR_REDIS_CONNECTION_CLOSED";
}

export class RedisBackplane implements Backplane {
  readonly instanceId: string;
  readonly #commands: RedisClient;
  readonly #url: string;
  readonly #channel: string;
  /**
   * Replaced rather than repaired when the receive path is lost.
   *
   * Re-issuing `SUBSCRIBE` on the existing client would depend on what state
   * that client is in after it swapped its own socket, which is exactly the
   * thing that cannot be established from out here. A new client has one
   * knowable state.
   */
  #subscriber: RedisClient;
  #onEnvelope: EnvelopeHandler | undefined;
  #onDisrupted: DisruptionHandler | undefined;
  #closing = false;
  /** When something last arrived on this instance's channel. */
  #heardAtMs: number;
  #probe: ReturnType<typeof setInterval> | undefined;
  /** Set while a replacement is in flight, so probes do not stack up on it. */
  #healing = false;
  readonly #now: () => number;

  private constructor(opts: RedisBackplaneOptions, commands: RedisClient, subscriber: RedisClient) {
    this.instanceId = opts.instanceId;
    this.#commands = commands;
    this.#subscriber = subscriber;
    this.#url = opts.url;
    this.#channel = CHANNEL_PREFIX + opts.instanceId;
    this.#now = opts.now ?? Date.now;
    this.#heardAtMs = this.#now();
  }

  static async connect(opts: RedisBackplaneOptions): Promise<RedisBackplane> {
    const commands = new RedisClient(opts.url);
    const subscriber = new RedisClient(opts.url, SUBSCRIBER_OPTIONS);
    await commands.connect();
    await subscriber.connect();
    const backplane = new RedisBackplane(opts, commands, subscriber);
    await backplane.#listen(subscriber);

    // Only the subscriber's silent death represents a routing hole (see
    // below): the commands client carries no standing state to lose, so its
    // close is unremarkable. But Bun's RedisClient reports every close
    // through this hook whether or not a handler is attached, and an
    // unhandled one surfaces as an unhandled error between test runs rather
    // than anything either `close()`'s try/catch or the caller can observe.
    // A handler -- even a no-op one -- is what makes that reporting land
    // somewhere instead of nowhere.
    commands.onclose = () => {};

    backplane.#probe = setInterval(() => void backplane.#checkReceivePath(), PROBE_INTERVAL_MS);
    // Nothing here should keep a process alive on its own account.
    backplane.#probe.unref?.();
    return backplane;
  }

  /**
   * Attach a client to this instance's channel.
   *
   * `onclose` is registered here rather than once at connect, because the
   * client it belongs to is replaced. It is still worth having: when it does
   * fire it is the earliest possible notice, and the probe below is what covers
   * the case observed in practice, where the socket is replaced underneath and
   * no close is ever reported.
   */
  async #listen(client: RedisClient): Promise<void> {
    client.onclose = error => {
      if (this.#closing) return;
      this.#onDisrupted?.(`backplane subscriber closed: ${error instanceof Error ? error.message : error}`);
    };
    await client.subscribe(this.#channel, message => {
      // Every arrival counts, probe or envelope: what is being established is
      // that this channel still reaches this process, and a real envelope
      // proves it at least as well as a probe does.
      this.#heardAtMs = this.#now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      // A probe carries no `k`, so it is already not an envelope and needs no
      // case of its own downstream.
      if (parsed !== null && typeof parsed === "object" && "k" in parsed) {
        this.#onEnvelope?.(parsed as RelayEnvelope);
      }
    });
  }

  /**
   * Send this instance one message and require it to come back.
   *
   * The publish is what keeps the connection from being idle; the arrival is
   * what proves the subscription is still there. Failing that, the connection
   * is replaced and the loss is reported, because sessions relying on the path
   * that just went missing have to be torn down rather than left looking
   * connected.
   */
  async #checkReceivePath(): Promise<void> {
    if (this.#closing || this.#healing) return;
    try {
      await this.#commands.publish(this.#channel, JSON.stringify({ probe: this.instanceId }));
    } catch {
      // The commands client is down too. It reconnects on its own, and the
      // deadline below is what decides whether that was enough.
    }
    if (this.#now() - this.#heardAtMs <= PROBE_DEADLINE_MS) return;

    this.#healing = true;
    const stale = this.#subscriber;
    try {
      const replacement = new RedisClient(this.#url, SUBSCRIBER_OPTIONS);
      await replacement.connect();
      await this.#listen(replacement);
      this.#subscriber = replacement;
      // Treat the new connection as current, so one slow replacement does not
      // immediately trip the deadline again and replace it a second time.
      this.#heardAtMs = this.#now();
      // Silence the old client's close, which is now expected rather than news.
      stale.onclose = () => {};
      try {
        // `close` may reject asynchronously when the connection was already
        // lost. Awaiting keeps the rejection attached to this healing cycle
        // instead of leaking into the next test or hub request.
        await stale.close();
      } catch (err) {
        if (!isRedisConnectionClosedError(err)) throw err;
      }
      this.#onDisrupted?.("backplane subscriber stopped receiving; resubscribed on a new connection");
    } catch (cause) {
      // Still unroutable. Report it every cycle rather than once: the hub's
      // response is to tear down sessions it can no longer serve, and any
      // session opened since the last report needs the same answer.
      this.#onDisrupted?.(
        `backplane subscriber stopped receiving and could not be replaced: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      this.#healing = false;
    }
  }

  /**
   * Every operation is a no-op once closed.
   *
   * Shutting down a hub closes its websockets, and their close handlers report
   * the departure through here. Those run after `stop` has begun, so without
   * this they issue commands against a client that is being torn down and the
   * abort surfaces as an unhandled rejection. A closed backplane routes
   * nothing, which is the honest answer rather than an error.
   */
  async claimDaemon(daemonId: string, ttlMs: number): Promise<void> {
    if (this.#closing) return;
    await this.#commands.send("SET", [LEASE_PREFIX + daemonId, this.instanceId, "PX", String(ttlMs)]);
  }

  async renewDaemon(daemonId: string, ttlMs: number): Promise<boolean> {
    if (this.#closing) return false;
    const result = await this.#commands.send("EVAL", [
      RENEW_SCRIPT,
      "1",
      LEASE_PREFIX + daemonId,
      this.instanceId,
      String(ttlMs),
    ]);
    return Number(result) === 1;
  }

  async releaseDaemon(daemonId: string): Promise<void> {
    if (this.#closing) return;
    await this.#commands.send("EVAL", [RELEASE_SCRIPT, "1", LEASE_PREFIX + daemonId, this.instanceId]);
  }

  async locateDaemon(daemonId: string): Promise<string | null> {
    if (this.#closing) return null;
    return await this.#commands.get(LEASE_PREFIX + daemonId);
  }

  async send(instanceId: string, envelope: RelayEnvelope): Promise<void> {
    if (this.#closing) return;
    await this.#commands.publish(CHANNEL_PREFIX + instanceId, JSON.stringify(envelope));
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.#onEnvelope = handler;
  }

  onDisrupted(handler: DisruptionHandler): void {
    this.#onDisrupted = handler;
  }

  /**
   * Idempotent. The hub closes its backplane on shutdown and an owner may
   * close it again; a second close must not be an error, and closing an
   * already-closed client throws.
   */
  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    clearInterval(this.#probe);
    this.#probe = undefined;
    // Unsubscribe before closing. `close()` aborts whatever the client still
    // has in flight, and an active subscription is exactly that: the abort
    // surfaces as an unhandled rejection rather than an exception this could
    // catch, so the subscription has to be wound down first.
    try {
      await this.#subscriber.unsubscribe(this.#channel);
    } catch {
      // Already gone, which is the state this was trying to reach.
    }

    // Closing a client rejects every command still in flight on it with the
    // "connection closed" error. Those commands belong to their callers: the
    // hub's socket and envelope handlers, which `Hub#detached` keeps out of
    // the unhandled-rejection path once `stop()` has begun. A process-level
    // `unhandledRejection` listener used to sit here for the same purpose; it
    // never caught one, because Bun's test runner reports a floating
    // rejection before any listener sees it, which is how a green suite kept
    // exiting 1. The owner-side catch is the fix; nothing here can be.
    for (const client of [this.#subscriber, this.#commands]) {
      try {
        // Bun's type surface has described this as void in some releases,
        // while Redis 7 teardown returns a promise that rejects when the
        // connection was already lost. `await` handles both shapes.
        await client.close();
      } catch (err) {
        if (!isRedisConnectionClosedError(err)) throw err;
        // Already closed. Nothing to release and nothing to report.
      }
    }
  }
}
