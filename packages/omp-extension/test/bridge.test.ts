/**
 * The bridge, tested at the seam it was built for.
 *
 * Two properties carry the weight, and both are about what the bridge must
 * NOT do. It is a guest in a session someone is typing in, so a missing
 * daemon must produce no socket attempt at all, and a refused or dropped one
 * must produce a bounded retry rather than a throw into the session or a loop
 * at full speed. Those are asserted directly, because they are the difference
 * between optional infrastructure and a session someone loses work in.
 *
 * The positive half is the registration and the two directions of traffic: the
 * frame the daemon needs to see a live terminal, the `sendMessage` call a
 * steer becomes, and the activity a phone watches a turn through.
 *
 * Time never passes here. The retry timer is a recorded call on the fake
 * context, driven by hand, so the delays are values under assertion rather
 * than waits.
 */

import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  assistantText,
  BRIDGE_BACKOFF_MS,
  Bridge,
  type BridgeContext,
  type BridgeDeps,
  type BridgePi,
  type BridgeSocket,
  bridgeBackoffDelayMs,
  wireOmpdBridge,
} from "../src/index.ts";

const SESSION = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const NEXT_SESSION = "019feebf-6449-7000-9474-a2ae1f871930";
const URL = "ws://127.0.0.1:7777/v1/socket?token=tok_local";

class FakeSocket implements BridgeSocket {
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  closedWith: { code?: number; reason?: string } | null = null;

  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.();
  }

  /** The daemon accepted the connection. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The daemon, or the network, dropped it. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.(JSON.stringify(frame));
  }
}

interface Scheduled {
  fn: () => void;
  ms: number;
  cleared: boolean;
}

interface Fixture {
  bridge: Bridge;
  ctx: BridgeContext;
  sockets: FakeSocket[];
  timers: Scheduled[];
  sent: Array<{ message: string; options: { deliverAs: string; triggerTurn: boolean } }>;
  /** Run the pending retry, as omp's managed timer would. */
  fireTimer(): void;
  /** Change what `getSessionId` answers, as `/resume` does. */
  setSessionId(id: string): void;
}

function fixture(opts: { url?: string | null; urls?: Array<string | null>; throwOnCreate?: boolean } = {}): Fixture {
  const sockets: FakeSocket[] = [];
  const timers: Scheduled[] = [];
  const sent: Fixture["sent"] = [];
  let sessionId = SESSION;
  const urls = opts.urls ?? [opts.url === undefined ? URL : opts.url];
  let urlCursor = 0;

  const pi: BridgePi = {
    sendMessage: (message, options) => {
      sent.push({ message, options });
    },
  };

  const ctx: BridgeContext = {
    cwd: "/work/ompd",
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => "steering the terminal",
    },
    setTimeout: (fn, ms) => {
      const scheduled: Scheduled = { fn, ms, cleared: false };
      timers.push(scheduled);
      return scheduled;
    },
    clearTimer: timer => {
      (timer as Scheduled).cleared = true;
    },
  };

  const deps: BridgeDeps = {
    readSocketUrl: () => {
      // The last entry repeats, so a fixture can answer once and then hold.
      const url = urls[Math.min(urlCursor, urls.length - 1)] ?? null;
      urlCursor += 1;
      return url;
    },
    createSocket: url => {
      if (opts.throwOnCreate === true) throw new Error("refused");
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    // Jitter off, so a delay assertion is about the backoff and not about luck.
    random: () => 0,
  };

  return {
    bridge: new Bridge(pi, ctx, deps),
    ctx,
    sockets,
    timers,
    sent,
    fireTimer: () => {
      const pending = timers.filter(timer => !timer.cleared).at(-1);
      if (pending === undefined) throw new Error("no timer was scheduled");
      pending.fn();
    },
    setSessionId: id => {
      sessionId = id;
    },
  };
}

describe("registration", () => {
  test("registers the live session with its cwd, title, and pid", () => {
    const f = fixture();
    f.bridge.connect();

    const socket = f.sockets[0];
    expect(socket?.url).toBe(URL);
    socket?.accept();

    expect(socket?.sent).toEqual([
      {
        t: "tui_register",
        sessionId: SESSION,
        cwd: "/work/ompd",
        title: "steering the terminal",
        pid: process.pid,
      },
    ]);
  });

  test("a session switch re-registers the new id on a fresh socket", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();

    f.setSessionId(NEXT_SESSION);
    f.bridge.reconnect();
    f.sockets[1]?.accept();

    expect(f.sockets[0]?.closedWith).toEqual({ code: 1000, reason: "ompd bridge stopped" });
    expect(f.sockets[1]?.sent[0]).toMatchObject({ t: "tui_register", sessionId: NEXT_SESSION });
    expect(f.bridge.sessionId).toBe(NEXT_SESSION);
  });

  test("a session with no id yet registers nothing and opens no socket", () => {
    const f = fixture();
    f.setSessionId("");
    f.bridge.connect();

    expect(f.sockets).toEqual([]);
    expect(f.timers).toEqual([]);
  });
});

describe("no daemon", () => {
  test("a missing endpoint or token file opens no socket and schedules no retry", () => {
    const f = fixture({ url: null });
    // The whole contract in one line: this must not throw either.
    expect(() => f.bridge.connect()).not.toThrow();
    expect(f.sockets).toEqual([]);
    expect(f.timers).toEqual([]);
  });

  test("a daemon that stood down between attempts stops the retry loop", () => {
    // Present at first, gone by the retry: a graceful `ompd stop` removes the
    // endpoint file, and polling a daemon that announced its absence is the
    // storm this avoids.
    const f = fixture({ urls: [URL, null] });
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.drop();

    expect(f.timers).toHaveLength(1);
    f.fireTimer();

    // One socket, and no second timer: the loop is over, not merely quiet for
    // one round.
    expect(f.sockets).toHaveLength(1);
    expect(f.timers).toHaveLength(1);
  });
});

describe("reconnect", () => {
  test("a dropped socket retries with a bounded, growing delay and never throws", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();

    // Six drops is past the point where an unbounded curve would leave the
    // ceiling behind: 500ms doubling six times is 32s, above the 30s cap.
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      expect(() => f.sockets.at(-1)?.drop()).not.toThrow();
      const pending = f.timers.at(-1);
      expect(pending).toBeDefined();
      delays.push(pending?.ms ?? -1);
      f.fireTimer();
    }

    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16_000]);
    expect(delays.every(delay => delay <= BRIDGE_BACKOFF_MS.max)).toBe(true);
    expect(f.sockets).toHaveLength(7);
  });

  test("the delay stops growing at the ceiling", () => {
    const beyond = bridgeBackoffDelayMs(40, () => 0);
    expect(beyond).toBe(BRIDGE_BACKOFF_MS.max);
    // Jitter only ever shortens the wait, so the ceiling cannot be breached.
    expect(bridgeBackoffDelayMs(40, () => 1)).toBeLessThan(BRIDGE_BACKOFF_MS.max);
    expect(bridgeBackoffDelayMs(40, () => 1)).toBeGreaterThanOrEqual(0);
  });

  test("a socket constructor that throws is a refusal, not an exception in the session", () => {
    const f = fixture({ throwOnCreate: true });
    expect(() => f.bridge.connect()).not.toThrow();
    expect(f.sockets).toEqual([]);
    expect(f.timers.at(-1)?.ms).toBe(500);
  });

  test("a successful reconnect resets the delay", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.drop();
    f.fireTimer();
    f.sockets[1]?.accept();
    f.sockets[1]?.drop();

    expect(f.timers.at(-1)?.ms).toBe(500);
  });
});

describe("steering", () => {
  test("a tui_steer becomes a sendMessage that triggers a turn", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.deliver({ t: "tui_steer", sessionId: SESSION, text: "run the failing test" });

    expect(f.sent).toEqual([{ message: "run the failing test", options: { deliverAs: "steer", triggerTurn: true } }]);
  });

  test("the requested delivery mode is honoured", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.deliver({ t: "tui_steer", sessionId: SESSION, text: "later", deliverAs: "followUp" });
    f.sockets[0]?.deliver({ t: "tui_steer", sessionId: SESSION, text: "next", deliverAs: "nextTurn" });

    expect(f.sent.map(call => call.options.deliverAs)).toEqual(["followUp", "nextTurn"]);
  });

  test("an unknown delivery mode falls back to a steer rather than being dropped", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.deliver({ t: "tui_steer", sessionId: SESSION, text: "go", deliverAs: "telepathy" });

    expect(f.sent).toEqual([{ message: "go", options: { deliverAs: "steer", triggerTurn: true } }]);
  });

  test("a steer for another session, garbage, and an empty text are all ignored", () => {
    const f = fixture();
    f.bridge.connect();
    const socket = f.sockets[0];
    socket?.accept();

    socket?.deliver({ t: "tui_steer", sessionId: NEXT_SESSION, text: "wrong conversation" });
    socket?.deliver({ t: "tui_steer", sessionId: SESSION, text: "" });
    socket?.deliver({ t: "something_else", sessionId: SESSION, text: "not a steer" });
    socket?.onmessage?.("{ not json");
    socket?.onmessage?.(new Uint8Array([1, 2, 3]));

    expect(f.sent).toEqual([]);
  });

  test("a sendMessage that throws is contained inside the message handler", () => {
    const sockets: FakeSocket[] = [];
    const pi: BridgePi = {
      sendMessage: () => {
        throw new Error("the session refused the steer");
      },
    };
    const ctx: BridgeContext = {
      cwd: "/work/ompd",
      sessionManager: { getSessionId: () => SESSION, getSessionName: () => undefined },
      setTimeout: fn => fn,
      clearTimer: () => {},
    };
    const bridge = new Bridge(pi, ctx, {
      readSocketUrl: () => URL,
      createSocket: url => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    });
    bridge.connect();
    sockets[0]?.accept();

    expect(() => sockets[0]?.deliver({ t: "tui_steer", sessionId: SESSION, text: "boom" })).not.toThrow();
  });
});

describe("activity", () => {
  test("turn boundaries and assistant text are reported to the daemon", () => {
    const f = fixture();
    f.bridge.connect();
    const socket = f.sockets[0];
    socket?.accept();

    f.bridge.reportTurnStart();
    f.bridge.reportAssistantText("here is what I found");
    f.bridge.reportTurnEnd();

    expect(socket?.sent.slice(1)).toEqual([
      { t: "tui_activity", sessionId: SESSION, kind: "turn_start" },
      { t: "tui_activity", sessionId: SESSION, kind: "assistant_text", text: "here is what I found" },
      { t: "tui_activity", sessionId: SESSION, kind: "turn_end" },
    ]);
  });

  test("activity while the socket is down is dropped, not queued or thrown", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.drop();

    expect(() => f.bridge.reportTurnStart()).not.toThrow();
    // The reconnect is what restores reporting; nothing is buffered meanwhile,
    // because a hint about a turn is worthless once the turn has moved on.
    f.fireTimer();
    f.sockets[1]?.accept();
    f.bridge.reportTurnEnd();

    expect(f.sockets[1]?.sent.slice(1)).toEqual([{ t: "tui_activity", sessionId: SESSION, kind: "turn_end" }]);
  });

  test("assistant text comes from assistant messages only", () => {
    expect(assistantText({ role: "assistant", content: [{ type: "text", text: "hello" }] })).toBe("hello");
    expect(
      assistantText({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "first" },
          { type: "toolCall", name: "bash" },
          { type: "text", text: "second" },
        ],
      }),
    ).toBe("first\nsecond");
    expect(assistantText({ role: "user", content: [{ type: "text", text: "a prompt" }] })).toBeUndefined();
    expect(assistantText({ role: "assistant", content: [{ type: "toolCall", name: "bash" }] })).toBeUndefined();
    expect(assistantText({ role: "assistant", content: [{ type: "text", text: "" }] })).toBeUndefined();
    expect(assistantText(null)).toBeUndefined();
    expect(assistantText("a string")).toBeUndefined();
    expect(assistantText({ role: "assistant" })).toBeUndefined();
  });
});

describe("shutdown", () => {
  test("closes the socket cleanly and stops retrying", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();

    f.bridge.stop();

    expect(f.sockets[0]?.closedWith).toEqual({ code: 1000, reason: "ompd bridge stopped" });
    // The close must not look like a drop: a deliberate teardown that
    // scheduled a reconnect would keep a shut-down session's bridge alive.
    expect(f.timers.filter(timer => !timer.cleared)).toEqual([]);
    expect(f.sockets).toHaveLength(1);
  });

  test("a pending retry is cleared, and a later connect does nothing", () => {
    const f = fixture();
    f.bridge.connect();
    f.sockets[0]?.accept();
    f.sockets[0]?.drop();
    expect(f.timers).toHaveLength(1);

    f.bridge.stop();
    expect(f.timers[0]?.cleared).toBe(true);

    f.bridge.connect();
    expect(f.sockets).toHaveLength(1);
  });
});

/**
 * The event wiring, driven through a recorded `pi`.
 *
 * This is the half that pins the event NAMES. Everything above tests a bridge
 * someone already called; these tests fail if `session_start`, `turn_start`,
 * `message_end`, `turn_end`, `session_switch`, or `session_shutdown` is
 * renamed or dropped, which is the only way to catch binding to an event omp
 * does not emit.
 */
describe("wiring", () => {
  interface Wired {
    handlers: Map<string, (event: unknown, ctx: unknown) => void>;
    sockets: FakeSocket[];
    sent: Array<{ message: string; options: { deliverAs: string; triggerTurn: boolean } }>;
    ctx(overrides?: { mode?: string; sessionId?: string }): unknown;
    fire(event: string, payload: unknown, ctx: unknown): void;
  }

  function wired(url: string | null = URL): Wired {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const sockets: FakeSocket[] = [];
    const sent: Wired["sent"] = [];
    const pi = {
      sendMessage: (message: string, options: { deliverAs: string; triggerTurn: boolean }) => {
        sent.push({ message, options });
      },
      on: (event: string, handler: (payload: unknown, ctx: unknown) => void) => {
        handlers.set(event, handler);
      },
    };
    const deps: BridgeDeps = {
      readSocketUrl: () => url,
      createSocket: socketUrl => {
        const socket = new FakeSocket(socketUrl);
        sockets.push(socket);
        return socket;
      },
      random: () => 0,
    };
    // The real `ExtensionAPI` is far wider than the bridge touches, and a
    // faithful fake of it would test the fake. This is the same seam the
    // daemon's own tests use for upstream types.
    wireOmpdBridge(pi as unknown as ExtensionAPI, deps);

    return {
      handlers,
      sockets,
      sent,
      ctx: (overrides = {}) => ({
        mode: overrides.mode ?? "tui",
        cwd: "/work/ompd",
        sessionManager: {
          getSessionId: () => overrides.sessionId ?? SESSION,
          getSessionName: () => "steering the terminal",
        },
        setTimeout: (fn: () => void, ms: number) => ({ fn, ms }),
        clearTimer: () => {},
      }),
      fire: (event, payload, ctx) => {
        const handler = handlers.get(event);
        if (handler === undefined) throw new Error(`nothing is bound to ${event}`);
        handler(payload, ctx);
      },
    };
  }

  test("session_start registers the live session", () => {
    const w = wired();
    const ctx = w.ctx();
    w.fire("session_start", { type: "session_start" }, ctx);
    w.sockets[0]?.accept();

    expect(w.sockets[0]?.sent[0]).toEqual({
      t: "tui_register",
      sessionId: SESSION,
      cwd: "/work/ompd",
      title: "steering the terminal",
      pid: process.pid,
    });
  });

  test("a print or rpc session is not a terminal anyone can steer, so nothing connects", () => {
    const w = wired();
    w.fire("session_start", { type: "session_start" }, w.ctx({ mode: "print" }));
    expect(w.sockets).toEqual([]);
  });

  test("turn boundaries and assistant text flow back as activity", () => {
    const w = wired();
    const ctx = w.ctx();
    w.fire("session_start", { type: "session_start" }, ctx);
    w.sockets[0]?.accept();

    w.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx);
    w.fire(
      "message_end",
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "found it" }] } },
      ctx,
    );
    // A user message is not activity: echoing the operator's own words back to
    // the phone that sent them is noise, and for a locally typed prompt it is
    // a leak of the terminal into a frame meant for turn progress.
    w.fire(
      "message_end",
      { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      ctx,
    );
    w.fire("turn_end", { type: "turn_end", turnIndex: 0, message: { role: "assistant", content: [] } }, ctx);

    expect(w.sockets[0]?.sent.slice(1)).toEqual([
      { t: "tui_activity", sessionId: SESSION, kind: "turn_start" },
      { t: "tui_activity", sessionId: SESSION, kind: "assistant_text", text: "found it" },
      { t: "tui_activity", sessionId: SESSION, kind: "turn_end" },
    ]);
  });

  test("a steer arriving on the socket reaches the session", () => {
    const w = wired();
    const ctx = w.ctx();
    w.fire("session_start", { type: "session_start" }, ctx);
    w.sockets[0]?.accept();
    w.sockets[0]?.deliver({ t: "tui_steer", sessionId: SESSION, text: "from the phone" });

    expect(w.sent).toEqual([{ message: "from the phone", options: { deliverAs: "steer", triggerTurn: true } }]);
  });

  test("events from another session in this process are ignored", () => {
    const w = wired();
    w.fire("session_start", { type: "session_start" }, w.ctx());
    w.sockets[0]?.accept();

    // A subagent session's own context, with its own id. Its turns are not the
    // interactive session's turns, and its shutdown is not the terminal's.
    const other = w.ctx({ sessionId: NEXT_SESSION });
    w.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, other);
    w.fire("session_shutdown", { type: "session_shutdown" }, other);

    expect(w.sockets[0]?.sent).toHaveLength(1);
    expect(w.sockets[0]?.closedWith).toBeNull();
  });

  test("session_shutdown closes the socket", () => {
    const w = wired();
    const ctx = w.ctx();
    w.fire("session_start", { type: "session_start" }, ctx);
    w.sockets[0]?.accept();
    w.fire("session_shutdown", { type: "session_shutdown" }, ctx);

    expect(w.sockets[0]?.closedWith).toEqual({ code: 1000, reason: "ompd bridge stopped" });
  });

  test("session_switch re-registers the id the session moved to", () => {
    const w = wired();
    let sessionId = SESSION;
    const ctx = {
      mode: "tui",
      cwd: "/work/ompd",
      sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined },
      setTimeout: (fn: () => void, ms: number) => ({ fn, ms }),
      clearTimer: () => {},
    };
    w.fire("session_start", { type: "session_start" }, ctx);
    w.sockets[0]?.accept();

    // Interactive omp reuses one session manager across a resume, so the id
    // changes underneath the same context object.
    sessionId = NEXT_SESSION;
    w.fire("session_switch", { type: "session_switch", reason: "resume" }, ctx);
    w.sockets[1]?.accept();

    expect(w.sockets[1]?.sent[0]).toMatchObject({ t: "tui_register", sessionId: NEXT_SESSION });
  });

  test("no daemon means the session never sees a socket or a throw", () => {
    const w = wired(null);
    const ctx = w.ctx();
    expect(() => w.fire("session_start", { type: "session_start" }, ctx)).not.toThrow();
    expect(w.sockets).toEqual([]);
    // And the session keeps working: activity events on a bridge that never
    // connected are inert rather than fatal.
    expect(() => w.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 0 }, ctx)).not.toThrow();
  });
});
