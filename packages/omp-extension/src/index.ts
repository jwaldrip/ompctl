/**
 * The ompd bridge: one omp session's leg to the local ompd daemon.
 *
 * `ompd install` copies this file verbatim into the active agent directory's
 * `extensions/ompd-bridge/index.ts`, so omp discovers and runs it in every
 * session with no per-session step. Once running it does one thing: it tells
 * the daemon "a live TUI owns this session" (`tui_register`) and then serves
 * two directions -- `tui_steer` frames become `pi.sendUserMessage` calls, so a
 * phone can prompt the terminal session that is already open, and turn
 * progress flows back as `tui_activity`, so that phone can see the turn it
 * started actually happening.
 *
 * This is deliberately NOT the takeover path. Takeover asks a TUI to stop
 * rendering and host an ACP server, which only omp itself can do; steering
 * leaves the terminal exactly as it is and injects messages through the
 * extension API. The daemon keeps both doors and picks per frame.
 *
 * The prime directive is silence. The bridge is a guest in a session someone
 * is actively typing in, and ompd is optional infrastructure: when no daemon
 * is running, when the token is absent, or when the socket drops, the session
 * must not break, hang, or print anything. Every entry point omp can call is
 * wrapped so a throw here is contained, the reconnect delay is bounded so a
 * missing daemon can never become a retry storm, and the operator token is
 * read from disk, held in memory, and never logged, interpolated, or echoed.
 *
 * Self-contained on purpose: the only runtime imports are node builtins, so
 * the installed copy under `~/.omp` needs nothing but what every omp host
 * already provides.
 *
 * One developer escape hatch: set OMPD_BRIDGE_DEBUG to a file path and the
 * bridge appends one JSON line per lifecycle fact it observes (see
 * `bridgeTrace`). Off by default, silent in the session either way.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/**
 * The slice of a websocket the bridge uses. Structural, like the client in
 * `@ompd/core`, because DOM handler shapes are contravariantly incompatible
 * with the narrower signatures a test double wants to provide.
 */
export interface BridgeSocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((data: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** The slice of `ExtensionContext` the bridge needs, so tests can fake it. */
export interface BridgeContext {
  readonly cwd: string;
  readonly sessionManager: {
    getSessionId(): string;
    getSessionName(): string | undefined;
  };
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/**
 * The slice of `ExtensionAPI` the bridge drives a session through.
 *
 * `sendUserMessage`, not `sendMessage`: a phone driving this terminal is the
 * operator driving it, so the words have to land as their own turn in the
 * transcript rather than as an injected custom message. That also decides the
 * option shape -- the prompt flow takes `steer` or `followUp` and has no
 * `nextTurn`, and it takes no `triggerTurn`, because taking the turn when the
 * session is idle is what the prompt flow already does.
 */
export interface BridgePi {
  sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

export interface BridgeDeps {
  /**
   * The daemon's published address and the operator token, or null when
   * either file is missing, empty, or not an address a socket could use.
   * The returned URL already carries the token as a query parameter; it is
   * for the socket constructor only and must never be logged.
   */
  readSocketUrl(): string | null;
  createSocket(url: string): BridgeSocket;
  random(): number;
  /**
   * Developer diagnostic, absent in production. Off by default and free when
   * off: see `bridgeTrace`. Injected by tests as a recorder; never a place to
   * send the token or the socket URL, which this module never traces.
   */
  trace?(kind: string, data: Record<string, unknown>): void;
}

/** Reconnect cadence. The ceiling is the "bounded" in bounded backoff. */
export const BRIDGE_BACKOFF_MS = { base: 500, max: 30_000, factor: 2 } as const;

/**
 * Delay before retry number `attempt` (zero-based), with jitter that only
 * shortens the wait so the ceiling is never breached.
 */
export function bridgeBackoffDelayMs(attempt: number, random: () => number): number {
  const exponent = Math.max(0, attempt);
  const raw = Math.min(BRIDGE_BACKOFF_MS.max, BRIDGE_BACKOFF_MS.base * BRIDGE_BACKOFF_MS.factor ** exponent);
  const spread = raw * 0.3 * random();
  return Math.max(0, Math.round(raw - spread));
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

/**
 * The production trace sink, and the whole of the bridge's observability.
 *
 * Why it exists: a bridge defect that presents as silence. Every layer here
 * swallows by design (the bridge to protect the session it guests in, omp's
 * runner to protect the process), so a handler that throws and an event that
 * never fired were indistinguishable, and exactly that ambiguity let a
 * ctx-identity defect reach a merge while its unit tests stayed green.
 *
 * A developer chasing a dead bridge runs omp with
 * `OMPD_BRIDGE_DEBUG=/tmp/ompd-bridge.jsonl` and reads one JSON object per
 * line: `registered`, `activity`, `retry_scheduled`, `stopped`,
 * `guard_reject` (the fingerprint of this defect class: a registered session
 * declining its own events), and `handler_error`. Off unless the variable
 * names a file, one env read when off, and its own throws are contained so a
 * read-only disk cannot cost the session anything. The token and the socket
 * URL it carries are never traced.
 */
export function bridgeTrace(env: NodeJS.ProcessEnv, kind: string, data: Record<string, unknown>): void {
  const target = env.OMPD_BRIDGE_DEBUG;
  if (target === undefined || target === "") return;
  try {
    appendFileSync(target, `${JSON.stringify({ ts: new Date().toISOString(), kind, ...data })}\n`);
  } catch {
    /* a diagnostic that broke the session would be worse than none */
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

const SOCKET_OPEN = 1;

/**
 * One registered session's connection to the daemon.
 *
 * Lifecycle: `connect` opens a socket and registers the session captured at
 * construction; `reconnect` is the session-switch path (close, then connect
 * again so the registration names the new session id -- the daemon refuses a
 * second registration on one socket by design); `stop` is terminal.
 *
 * Reconnect policy: a dropped or refused socket retries through the ctx's own
 * managed timer, which omp clears on shutdown and whose throws it contains.
 * The delay grows to a ceiling and stops there. A retry re-reads the daemon's
 * files: a daemon that stopped cleanly removes its endpoint file, and seeing
 * it gone is the signal to stand down entirely rather than poll a daemon that
 * announced its absence; a daemon that merely crashed leaves the file behind,
 * so the bridge keeps waiting at the ceiling for it to come back.
 */
export class Bridge {
  readonly #pi: BridgePi;
  readonly #ctx: BridgeContext;
  readonly #deps: BridgeDeps;
  #socket: BridgeSocket | null = null;
  /**
   * The session id the live socket registered, read from the context at
   * connect time rather than captured once. Interactive omp reuses one
   * session manager across `/resume` and forks, so the id is a property of
   * the moment, and a bridge that cached it would keep steering frames
   * addressed to a session the terminal has already left.
   */
  #registered = "";
  #attempt = 0;
  #timer: unknown = null;
  #stopped = false;

  constructor(pi: BridgePi, ctx: BridgeContext, deps: BridgeDeps) {
    this.#pi = pi;
    this.#ctx = ctx;
    this.#deps = deps;
  }

  /** The session id the live socket registered, or "" when not registered. */
  get sessionId(): string {
    return this.#registered;
  }

  /**
   * Whether an event context belongs to the session this bridge serves.
   *
   * Identity cannot live on the ctx object: omp builds a fresh context per
   * emitted event and hands the handler a prototype wrapper of even that
   * (observed against a real 17.3.7 session: ctx identity fails on every
   * event after the session_start that built this bridge). The reference that
   * IS stable across one runner's events is `sessionManager`, copied by the
   * runner into every context it mints and delegated through the wrapper, so
   * identity is decided there. It still separates sessions: another runner in
   * this process (a subagent, a startup flush from some other session) has
   * its own session manager, while a `/resume` keeps the same one and only
   * changes the id it answers with, which is precisely the session_switch
   * case this bridge reconnects on.
   */
  ownsContext(ctx: BridgeContext): boolean {
    return ctx.sessionManager === this.#ctx.sessionManager;
  }

  /** Close and re-register, for a switch to a different session id. */
  reconnect(): void {
    this.#closeSocket();
    this.#attempt = 0;
    this.connect();
  }

  connect(): void {
    if (this.#stopped) return;
    this.#clearTimer();
    const sessionId = this.#ctx.sessionManager.getSessionId();
    // No id means no session to register. Nothing to say and nobody to
    // say it to, so say nothing.
    if (sessionId.length === 0) return;
    const url = this.#deps.readSocketUrl();
    // Missing files mean there is no daemon to talk to: either none has
    // ever run here, or one stood down cleanly and removed its endpoint.
    // Either way this is terminal, because polling a daemon that
    // announced its absence is the well-mannered version of a retry storm.
    if (url === null) {
      this.#stopped = true;
      return;
    }
    let socket: BridgeSocket;
    try {
      socket = this.#deps.createSocket(url);
    } catch {
      // A constructor that throws is a refusal like any other: back off
      // and try again, never propagate into the session.
      this.#scheduleRetry();
      return;
    }
    this.#socket = socket;
    this.#registered = sessionId;
    // Every handler below contains its own throws. These callbacks run
    // in-process in a session someone is typing in, where an escaping
    // exception is a process-fatal uncaughtException, not a log line.
    socket.onopen = () => {
      try {
        this.#attempt = 0;
        this.#write({
          t: "tui_register",
          sessionId,
          cwd: this.#ctx.cwd,
          title: this.#ctx.sessionManager.getSessionName(),
          pid: process.pid,
        });
        this.#deps.trace?.("registered", { sessionId });
      } catch {
        /* an unsent registration leaves an idle socket; its close drives the retry */
      }
    };
    socket.onmessage = data => {
      try {
        this.#handleMessage(data);
      } catch {
        /* one bad frame, or one refused steer, must not cost the session its bridge */
      }
    };
    socket.onerror = () => {
      // Close always follows error on every websocket host, so letting
      // close drive recovery keeps the two from double-scheduling.
    };
    socket.onclose = () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#registered = "";
      this.#scheduleRetry();
    };
  }

  /** Terminal. Close the socket so the daemon deregisters immediately. */
  stop(): void {
    this.#stopped = true;
    this.#clearTimer();
    const was = this.#registered;
    this.#closeSocket();
    this.#deps.trace?.("stopped", { sessionId: was });
  }

  reportTurnStart(): void {
    this.#activity("turn_start");
  }

  reportAssistantText(text: string): void {
    this.#activity("assistant_text", text);
  }

  reportTurnEnd(): void {
    this.#activity("turn_end");
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const frame = parsed as { t?: unknown; sessionId?: unknown; text?: unknown; deliverAs?: unknown };
    // Only a steer for the session this socket registered. The daemon
    // already routes by registration, so a mismatch here means the socket
    // outlived a switch, and delivering it would put a phone's words into
    // the wrong conversation.
    if (frame.t !== "tui_steer" || frame.sessionId !== this.#registered) return;
    if (typeof frame.text !== "string" || frame.text.length === 0) return;
    // `followUp` waits for the running turn. Everything else is the default
    // prompt call with NO options, and that distinction is load-bearing:
    // omitting `deliverAs` takes the turn when the session is idle and steers
    // when one is streaming, while passing `deliverAs: "steer"` explicitly
    // only queues, in either state. Passing it would mean a phone prompt to an
    // idle terminal sat in a queue and visibly did nothing.
    if (frame.deliverAs === "followUp") {
      this.#pi.sendUserMessage(frame.text, { deliverAs: "followUp" });
      return;
    }
    this.#pi.sendUserMessage(frame.text);
  }

  #activity(kind: "assistant_text" | "turn_start" | "turn_end", text?: string): void {
    const socket = this.#socket;
    if (this.#stopped || socket === null || socket.readyState !== SOCKET_OPEN) return;
    const frame =
      text === undefined
        ? { t: "tui_activity", sessionId: this.#registered, kind }
        : { t: "tui_activity", sessionId: this.#registered, kind, text };
    try {
      socket.send(JSON.stringify(frame));
      this.#deps.trace?.("activity", { activityKind: kind, sessionId: this.#registered, textBytes: text?.length ?? 0 });
    } catch {
      /* a dropped hint about a row is worth less than the reconnect already under way */
    }
  }

  #write(frame: Record<string, unknown>): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== SOCKET_OPEN) throw new Error("bridge socket is not open");
    socket.send(JSON.stringify(frame));
  }

  #scheduleRetry(): void {
    if (this.#stopped) return;
    if (this.#timer !== null) return;
    const delayMs = bridgeBackoffDelayMs(this.#attempt, this.#deps.random);
    this.#attempt += 1;
    this.#deps.trace?.("retry_scheduled", { attempt: this.#attempt, delayMs });
    try {
      this.#timer = this.#ctx.setTimeout(() => {
        this.#timer = null;
        this.connect();
      }, delayMs);
    } catch {
      // A host whose managed timer refuses the work is a host this
      // cannot live in. Standing down beats taking the session down.
      this.#stopped = true;
    }
  }

  #clearTimer(): void {
    if (this.#timer === null) return;
    const timer = this.#timer;
    this.#timer = null;
    try {
      this.#ctx.clearTimer(timer);
    } catch {
      /* the pending retry is forgotten either way */
    }
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#registered = "";
    if (socket === null) return;
    // Detached first, so the close this triggers is not mistaken for a
    // drop and does not schedule a retry for a deliberate teardown.
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close(1000, "ompd bridge stopped");
    } catch {
      /* an uncloseable socket is the host's problem now */
    }
  }
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

/**
 * Bind a bridge to a session through omp's event surface.
 *
 * Events used, and why these and not their neighbours:
 * - `session_start` -- the earliest point where a ctx exists and the session
 *   id is stable. Guarded to `mode === "tui"`: a print or RPC run is not a
 *   live terminal someone can steer, and registering it would only add a row
 *   the daemon could never usefully drive.
 * - `session_switch` -- the interactive session moved to another session id
 *   (resume, fork). The daemon refuses re-registering a different id on one
 *   socket, so the bridge closes and reconnects to register the new one.
 * - `turn_start` / `turn_end` -- the boundaries of one assistant turn.
 * - `message_end` -- the finalized assistant message; its text blocks are
 *   the `assistant_text` activity. `message_update` is deliberately not used:
 *   token-by-token frames would be a transcript transport wearing an activity
 *   frame's clothes, and the daemon caps this frame at 64 KiB on purpose.
 * - `session_shutdown` -- close the socket so the daemon deregisters the
 *   session immediately rather than on TCP timeout.
 *
 * Bridges are keyed by the `pi` instance, one per session runner: a process
 * that hosts subagent sessions alongside the interactive one must not have a
 * subagent's lifecycle steal or stop the interactive session's bridge.
 */
/**
 * What a wiring handler reads from ctx: the bridge's slice, plus the mode
 * field the session_start guard keys on. Structural, like BridgeContext, so
 * omp's wider ExtensionContext satisfies it and tests fake exactly this.
 */
type WiringContext = BridgeContext & { readonly mode: string };

export function wireOmpdBridge(pi: ExtensionAPI, deps: BridgeDeps = defaultDeps()): void {
  const bridges = new WeakMap<ExtensionAPI, Bridge>();
  // The `guard_reject` trace fires only when a registered bridge declined an
  // event, which is the fingerprint of a routing defect: a session the daemon
  // knows about, going quiet for reasons no unit test with one shared ctx
  // object can reproduce. Events with no bridge at all (a print run) are the
  // norm, not a defect, and stay untraced.
  const forContext = (ctx: BridgeContext, event: string): Bridge | null => {
    const bridge = bridges.get(pi);
    if (bridge === undefined) return null;
    if (bridge.ownsContext(ctx)) return bridge;
    deps.trace?.("guard_reject", { event, registered: bridge.sessionId });
    return null;
  };
  // One wrapper for every binding, because a throw must never reach omp's
  // session: the runner would contain it, but into a channel this bridge
  // never sees, which is how a broken handler reads as a missing event.
  const contained =
    (event: string, run: (payload: unknown, ctx: WiringContext) => void) =>
    (payload: unknown, ctx: WiringContext): void => {
      try {
        run(payload, ctx);
      } catch (error) {
        try {
          deps.trace?.("handler_error", { event, error: error instanceof Error ? error.message : String(error) });
        } catch {
          /* a broken diagnostic must not compound a contained error */
        }
      }
    };

  pi.on(
    "session_start",
    contained("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") return;
      if (bridges.has(pi)) return;
      const bridge = new Bridge(pi, ctx, deps);
      bridges.set(pi, bridge);
      bridge.connect();
    }),
  );
  pi.on(
    "session_switch",
    contained("session_switch", (_event, ctx) => {
      const bridge = forContext(ctx, "session_switch");
      if (bridge !== null) bridge.reconnect();
    }),
  );
  pi.on(
    "turn_start",
    contained("turn_start", (_event, ctx) => {
      forContext(ctx, "turn_start")?.reportTurnStart();
    }),
  );
  pi.on(
    "message_end",
    contained("message_end", (event, ctx) => {
      const bridge = forContext(ctx, "message_end");
      if (bridge === null) return;
      const text = assistantText((event as { message?: unknown }).message);
      if (text !== undefined) bridge.reportAssistantText(text);
    }),
  );
  pi.on(
    "turn_end",
    contained("turn_end", (_event, ctx) => {
      forContext(ctx, "turn_end")?.reportTurnEnd();
    }),
  );
  pi.on(
    "session_shutdown",
    contained("session_shutdown", (_event, ctx) => {
      const bridge = forContext(ctx, "session_shutdown");
      if (bridge === null) return;
      bridges.delete(pi);
      bridge.stop();
    }),
  );
}

/**
 * The extension entry point omp calls. Registration only, per the extension
 * contract: every runtime action lives behind an event handler.
 */
export default function ompdBridge(pi: ExtensionAPI): void {
  wireOmpdBridge(pi);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Read the daemon's published endpoint and the operator token. Null, rather
 * than a throw, for every way "there is no daemon here" can look, because the
 * caller's contract is silence.
 *
 * The URL carries the token and is returned, never logged. Nothing in this
 * module interpolates it into a message or an error.
 */
function readSocketUrlFromFiles(env: NodeJS.ProcessEnv, homeDir: string): string | null {
  try {
    const home = env.OMPD_HOME ?? join(homeDir, ".ompd");
    const endpoint = readFileSync(join(home, "endpoint"), "utf8").trim();
    const token = readFileSync(join(home, "token"), "utf8").trim();
    if (!/^https?:\/\/[^/?#]+/.test(endpoint)) return null;
    if (token.length === 0) return null;
    const wsBase = endpoint.replace(/\/+$/, "").replace(/^http/, "ws");
    return `${wsBase}/v1/socket?token=${encodeURIComponent(token)}`;
  } catch {
    return null;
  }
}

/** `WebSocket` as omp hosts spell it, adapted onto the bridge's narrow seam. */
function createHostSocket(url: string): BridgeSocket {
  const ws = new WebSocket(url);
  const socket: BridgeSocket = {
    get readyState() {
      return ws.readyState;
    },
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    send: data => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
  ws.onopen = () => socket.onopen?.();
  ws.onclose = () => socket.onclose?.();
  ws.onerror = () => socket.onerror?.();
  ws.onmessage = event => socket.onmessage?.(event.data);
  return socket;
}

function defaultDeps(): BridgeDeps {
  return {
    readSocketUrl: () => readSocketUrlFromFiles(process.env, homedir()),
    createSocket: createHostSocket,
    random: () => Math.random(),
    trace: (kind, data) => bridgeTrace(process.env, kind, data),
  };
}

// ---------------------------------------------------------------------------
// Assistant text
// ---------------------------------------------------------------------------

/**
 * The text of a finalized assistant message, or undefined when the message is
 * not an assistant message or says nothing textual. Structural on purpose:
 * `AgentMessage` is a widening upstream union, and the bridge only ever needs
 * "is it an assistant message with text blocks".
 */
export function assistantText(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return undefined;
  const parts: string[] = [];
  for (const block of candidate.content) {
    if (block === null || typeof block !== "object") continue;
    const text = (block as { type?: unknown; text?: unknown }).text;
    if ((block as { type?: unknown }).type === "text" && typeof text === "string" && text.length > 0) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}
