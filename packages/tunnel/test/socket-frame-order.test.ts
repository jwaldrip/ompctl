/**
 * Two sealed frames delivered in one tick.
 *
 * `TunnelSocket.#onData` routes on a phase that only advances after an `await`
 * for a decrypt, so dispatching frames concurrently let two that arrived
 * together both read the pre-transition phase. The daemon's `ready` and the
 * gateway's `hello` are exactly that pair -- the daemon seals them back to back
 * the moment a credential is admitted -- and the second was then judged a failed
 * session confirmation. The client reported "daemon refused the credential" and
 * tore down a session the daemon had admitted and audited `ok`.
 *
 * It reproduced against a live hub perhaps half the time, and inserting a single
 * `console.error` on the daemon's send path was enough to hide it. So the test
 * does what the network only sometimes does: hands both frames over in the same
 * tick, with no scheduling gap for the phase to advance in.
 */
import { describe, expect, test } from "bun:test";
import { SealedChannel } from "../src/channel.ts";
import { answerClientHandshake } from "../src/handshake.ts";
import { generateIdentity } from "../src/identity.ts";
import { connectThroughHub, type TunnelSocketLike } from "../src/index.ts";

/** A wire this test drives directly, standing in for the hub's relay leg. */
class FakeWire implements TunnelSocketLike {
  /** Part of the contract; this wire is open from construction. */
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  /** Everything the client wrote, so the test can answer it. */
  readonly written: string[] = [];

  send(data: string): void {
    this.written.push(data);
  }
  close(): void {}

  /** Deliver frames with no scheduling gap between them. */
  deliverTogether(...frames: string[]): void {
    for (const frame of frames) this.onmessage?.(frame);
  }
}

describe("TunnelSocket inbound ordering", () => {
  test("a hello arriving with ready does not read as a refused credential", async () => {
    const wire = new FakeWire();
    // A real identity: the client pins the id and verifies the signature, so a
    // made-up one would fail the handshake before reaching the ordering bug.
    const identity = generateIdentity();
    const daemonId = identity.daemonId;
    const socket = connectThroughHub({
      hubUrl: "wss://hub.example",
      daemonId,
      token: "device-token",
      transport: () => wire,
    });

    const failures: string[] = [];
    socket.onclose = info => failures.push(info.reason);
    let opened = false;
    socket.onopen = () => {
      opened = true;
    };

    // --- the hub links this client to the daemon it asked for ---------------
    const sessionId = "s-test";
    wire.onmessage?.(JSON.stringify({ t: "linked", v: 1, sessionId, daemonId, publicKey: identity.publicKey }));
    await Bun.sleep(10);
    // The client's `hello` is the first thing it writes after `linked`.
    // The client wraps everything in the relay's envelope; the handshake frame
    // is the payload inside it.
    const envelope = JSON.parse(wire.written[0] ?? "{}");
    const hello0 = JSON.parse(envelope.payload ?? "{}");
    const daemon = await answerClientHandshake({
      hello: hello0,
      sessionId,
      daemonId,
      privateKey: identity.privateKey,
    });

    wire.written.length = 0;
    wire.onmessage?.(JSON.stringify({ t: "data", rseq: 0, payload: JSON.stringify(daemon.auth) }));
    // The client verifies the daemon and seals its credential; both are async.
    await Bun.sleep(20);

    const channel = new SealedChannel(daemon.keys, "daemon");
    // Drain the credential the client sealed, so the daemon channel's receive
    // counter matches what a real daemon would have consumed.
    const credential = wire.written.find(w => w.includes('"data"'));
    expect(credential).toBeDefined();
    await channel.open(JSON.parse(credential ?? "{}").payload);

    // --- the pair that used to break it, in one tick -----------------------
    const ready = await channel.seal(JSON.stringify({ t: "ready", deviceId: "dev_1" }));
    const hello = await channel.seal(JSON.stringify({ t: "hello", deviceId: "dev_1", agents: [] }));
    const delivered: string[] = [];
    socket.onmessage = data => delivered.push(data);
    wire.deliverTogether(
      JSON.stringify({ t: "data", rseq: 1, payload: ready }),
      JSON.stringify({ t: "data", rseq: 2, payload: hello }),
    );
    await Bun.sleep(40);

    // The session must be open, and the greeting must have been handed to the
    // caller as session data rather than mistaken for the confirmation.
    expect(failures).toEqual([]);
    expect(opened).toBe(true);
    expect(delivered.map(d => JSON.parse(d).t)).toEqual(["hello"]);
  });
});
