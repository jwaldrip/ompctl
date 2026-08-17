/**
 * The default wire, against a real WebSocket server.
 *
 * Every other tunnel test injects a `DialTransport` that already speaks
 * `DialSocket`, which is the right seam for protocol tests and the reason a
 * broken default shipped: a fake that hands `onmessage` a string can never
 * catch a real `WebSocket` handing it a `MessageEvent`. So this file uses no
 * fake transport at all. It serves a socket, dials it with the shipped default,
 * and asserts the contract at the boundary where the two actually meet.
 */
import { describe, expect, test } from "bun:test";
import { dialWebSocket } from "../src/daemon.ts";

/** A server that echoes one frame back, then closes with a nameable code. */
function serve(onOpenSend: string): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      open(ws) {
        ws.send(onOpenSend);
      },
      message(ws, data) {
        ws.send(`echo:${String(data)}`);
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, stop: () => void server.stop(true) };
}

describe("dialWebSocket", () => {
  test("delivers inbound frames as strings, not MessageEvents", async () => {
    // A frame the protocol would actually carry. The bug this guards turned it
    // into "[object MessageEvent]", which `JSON.parse` rejects and the daemon
    // swallows, so the assertion below is on the parsed shape rather than only
    // on `typeof`: a stringified event is a string too.
    const frame = JSON.stringify({ t: "challenge", v: 1, nonce: "abc" });
    const { url, stop } = serve(frame);
    try {
      const socket = dialWebSocket(url);
      const received = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no frame arrived")), 5_000);
        socket.onmessage = data => {
          clearTimeout(timer);
          expect(typeof data).toBe("string");
          resolve(JSON.parse(data));
        };
      });
      expect(received).toEqual({ t: "challenge", v: 1, nonce: "abc" });
      socket.close(1000, "done");
    } finally {
      stop();
    }
  });

  test("carries outbound frames to the server", async () => {
    const { url, stop } = serve(JSON.stringify({ t: "hello" }));
    try {
      const socket = dialWebSocket(url);
      const echoed = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no echo")), 5_000);
        socket.onmessage = data => {
          // The first frame is the server's greeting; the echo answers the send.
          if (!data.startsWith("echo:")) {
            socket.send("ping");
            return;
          }
          clearTimeout(timer);
          resolve(data);
        };
      });
      expect(echoed).toBe("echo:ping");
      socket.close(1000, "done");
    } finally {
      stop();
    }
  });

  test("reports the code and reason when the peer closes", async () => {
    // The direction that matters: the hub dropping this daemon's leg. A
    // locally-initiated close is not a substitute, because the reason a client
    // passes to `close()` is not echoed back to itself.
    const server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("expected a websocket upgrade", { status: 426 });
      },
      websocket: {
        open(ws) {
          ws.close(4321, "on purpose");
        },
        // Required by the handler type. This server closes before any client
        // frame can arrive, so reaching it would itself be the surprise.
        message() {},
      },
    });
    try {
      const socket = dialWebSocket(`ws://127.0.0.1:${server.port}`);
      const info = await new Promise<{ code: number; reason: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("never closed")), 5_000);
        socket.onclose = closed => {
          clearTimeout(timer);
          resolve(closed);
        };
      });
      // The daemon's backoff logs this pair; an adapter that dropped it would
      // reconnect forever with nothing to say why.
      expect(info.code).toBe(4321);
      expect(info.reason).toBe("on purpose");
    } finally {
      server.stop(true);
    }
  });

  test("reports an error with a message rather than undefined", async () => {
    // Nothing listens here, so the dial fails at the transport.
    const socket = dialWebSocket("ws://127.0.0.1:1/");
    const message = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no error surfaced")), 5_000);
      const settle = (m: string): void => {
        clearTimeout(timer);
        resolve(m);
      };
      socket.onerror = info => settle(info.message);
      // Some runtimes only close on a failed dial. Either path must yield text,
      // because the daemon logs this and `undefined` explains nothing.
      socket.onclose = closed => settle(closed.reason.length > 0 ? closed.reason : "closed without a reason");
    });
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toBe("undefined");
  });
});
