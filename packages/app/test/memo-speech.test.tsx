/**
 * The memo speech path: microphone in, agent speech out.
 *
 * Three layers, each tested against the layer below it rather than against
 * a mock of itself. The seam binds an optional native module and must name
 * its own absence. The reducer folds `transcript` frames and the local
 * capture echo. The hook owns the impure edge: chunks become `audio`
 * frames, `audio_end` follows the last chunk, and a link drop ends the
 * utterance rather than streaming it nowhere. The composer control is the
 * contract with the operator: a missing prompt scope disables it with the
 * reason stated, never hides it.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent, AgentId } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleEvent, ConsoleState } from "../src/console/state.ts";
import type { ConsoleActions } from "../src/console/useConsole.ts";
import type { Connection } from "../src/platform/connection.ts";
import type { SessionVoice } from "../src/screens/SessionScreen.tsx";
import { EMPTY_SESSION } from "../src/session/model.ts";
import type { MemoVoice, OmpctlVoiceModule } from "../src/voice/memo.ts";

// These modules import React Native. Loading them after rnw.ts is what makes
// this test exercise the web target instead of Bun trying to load native
// code, which is why the imports below are dynamic despite being literal
// paths: the ordering is the fixture.

const { createDeviceSpeechPlayback, createDeviceVoiceCapture, WIRE_SAMPLE_RATE } = await import("../src/voice/memo.ts");
const { apply, emptyConsole, promptScopeAccess, tuiPromptAccess } = await import("../src/console/state.ts");
const { useConsole } = await import("../src/console/useConsole.ts");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT: Agent = {
  id: "agt_memo",
  name: "memo probe",
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/work",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  labels: {},
};

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

/** A native module canned to the interface the seam resolves. */
class FakeVoiceModule implements OmpctlVoiceModule {
  readonly captureRates: number[] = [];
  readonly played: string[] = [];
  readonly playbackStops: number[] = [];
  stopCalls = 0;
  private readonly listeners = new Set<(event: { pcm: string }) => void>();

  emitChunk(pcm: string): void {
    for (const listener of this.listeners) listener({ pcm });
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  startCapture(sampleRate: number): Promise<void> {
    this.captureRates.push(sampleRate);
    return Promise.resolve();
  }

  stopCapture(): Promise<void> {
    this.stopCalls += 1;
    return Promise.resolve();
  }

  playPcm(base64: string): Promise<void> {
    this.played.push(base64);
    return Promise.resolve();
  }

  stopPlayback(): Promise<void> {
    this.playbackStops.push(1);
    return Promise.resolve();
  }

  addListener(_eventName: "voice_chunk", listener: (event: { pcm: string }) => void): { remove(): void } {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }
}

describe("the device voice seam", () => {
  test("names the missing native module for capture and playback per platform", () => {
    for (const [platform, name] of [
      ["ios", "iOS"],
      ["android", "Android"],
      ["web", "web"],
    ] as const) {
      const capture = createDeviceVoiceCapture(platform, undefined);
      expect(capture.availability.available).toBe(false);
      if (capture.availability.available) throw new Error("missing module reported available");
      expect(capture.availability.reason).toContain(name);
      expect(capture.availability.reason).toContain("OmpctlVoice");

      const playback = createDeviceSpeechPlayback(platform, undefined);
      expect(playback.availability.available).toBe(false);
      if (playback.availability.available) throw new Error("missing module reported available");
      expect(playback.availability.reason).toContain(name);
      expect(playback.availability.reason).toContain("OmpctlVoice");
    }
  });

  test("capture asks the module for the wire rate and forwards each chunk as it arrives", async () => {
    const module = new FakeVoiceModule();
    const capture = createDeviceVoiceCapture("ios", module);
    expect(capture.availability.available).toBe(true);

    const chunks: string[] = [];
    await capture.start(pcm => chunks.push(pcm));
    // The rate is the daemon's wire contract, so the seam hands over
    // WIRE_SAMPLE_RATE rather than a rate of its own choosing.
    expect(module.captureRates).toEqual([WIRE_SAMPLE_RATE]);
    expect(WIRE_SAMPLE_RATE).toBe(16_000);

    module.emitChunk("AAAA");
    module.emitChunk("");
    module.emitChunk("BBBB");
    // An empty chunk is no audio and must not become a frame.
    expect(chunks).toEqual(["AAAA", "BBBB"]);
  });

  test("stop detaches the listener and a later start attaches exactly one again", async () => {
    const module = new FakeVoiceModule();
    const capture = createDeviceVoiceCapture("ios", module);

    await capture.start(() => {});
    expect(module.listenerCount()).toBe(1);
    await capture.stop();
    expect(module.listenerCount()).toBe(0);

    const chunks: string[] = [];
    await capture.start(pcm => chunks.push(pcm));
    expect(module.listenerCount()).toBe(1);
    module.emitChunk("CCCC");
    expect(chunks).toEqual(["CCCC"]);
  });

  test("cancel releases the microphone without producing another chunk", () => {
    const module = new FakeVoiceModule();
    const capture = createDeviceVoiceCapture("ios", module);
    const chunks: string[] = [];
    void capture.start(pcm => chunks.push(pcm));

    capture.cancel();
    expect(module.listenerCount()).toBe(0);
    expect(module.stopCalls).toBe(1);
    module.emitChunk("DDDD");
    expect(chunks).toEqual([]);
  });

  test("playback maps one chunk to one playPcm call", async () => {
    const module = new FakeVoiceModule();
    const playback = createDeviceSpeechPlayback("ios", module);
    expect(playback.availability.available).toBe(true);
    await playback.play("EEEE");
    expect(module.played).toEqual(["EEEE"]);
    await playback.stop();
    expect(module.playbackStops.length).toBe(1);
  });

  test("an unavailable capture rejects a start rather than hanging as a recording", async () => {
    const capture = createDeviceVoiceCapture("web", undefined);
    let rejected: string | null = null;
    await capture
      .start(() => {})
      .catch((cause: unknown) => {
        rejected = String(cause);
      });
    expect(rejected).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function drive(events: readonly ConsoleEvent[], from: ConsoleState = emptyConsole([])): ConsoleState {
  let state = from;
  for (const event of events) state = apply(state, event);
  return state;
}

describe("dictation and capture state", () => {
  test("transcript frames replace the dictation and carry the final flag", () => {
    const state = drive([
      { t: "transcript", event: { agentId: "a1", text: "run the", final: false } },
      { t: "transcript", event: { agentId: "a1", text: "run the tests", final: true } },
      { t: "transcript", event: { agentId: "a2", text: "other agent", final: true } },
    ]);
    expect(state.dictation.get("a1")).toEqual({ text: "run the tests", final: true });
    expect(state.dictation.get("a2")).toEqual({ text: "other agent", final: true });
  });

  test("opening the mic retires the previous utterance's words; closing keeps the last ones", () => {
    const state = drive([
      { t: "transcript", event: { agentId: "a1", text: "stale words", final: true } },
      { t: "voice_capture", agentId: "a1" },
    ]);
    expect(state.capturing).toBe("a1");
    expect(state.dictation.get("a1")).toBeUndefined();

    const heard = apply(state, { t: "transcript", event: { agentId: "a1", text: "fresh words", final: true } });
    const closed = apply(heard, { t: "voice_capture", agentId: null });
    expect(closed.capturing).toBeNull();
    expect(closed.dictation.get("a1")).toEqual({ text: "fresh words", final: true });
  });

  test("one microphone: a second agent's open replaces the first, and closing when closed changes nothing", () => {
    const state = drive([
      { t: "voice_capture", agentId: "a1" },
      { t: "voice_capture", agentId: "a2" },
    ]);
    expect(state.capturing).toBe("a2");
    const closed = apply(state, { t: "voice_capture", agentId: null });
    expect(apply(closed, { t: "voice_capture", agentId: null })).toBe(closed);
  });
});

describe("the three-way prompt scope rule", () => {
  test("the daemon's hello wins, and an empty stored grant is unknown, not missing", () => {
    const hello = (scopes: string[]): ConsoleEvent => ({
      t: "agents",
      event: { agents: [AGENT], deviceId: "dev", scopes },
    });

    expect(promptScopeAccess(drive([hello(["read", "prompt"])]), [])).toBe("granted");
    expect(promptScopeAccess(drive([hello(["read"])]), ["prompt"])).toBe("missing");
    expect(promptScopeAccess(emptyConsole([]), [])).toBe("unknown");
    expect(promptScopeAccess(emptyConsole([]), ["read", "prompt"])).toBe("granted");
    expect(promptScopeAccess(emptyConsole([]), ["read"])).toBe("missing");
  });

  test("the terminal's selector is the same rule under its historic name", () => {
    const state = drive([{ t: "agents", event: { agents: [AGENT], deviceId: "dev", scopes: ["read"] } }]);
    expect(tuiPromptAccess(state, [])).toBe("missing");
    expect(tuiPromptAccess(emptyConsole([]), [])).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// The hook: the impure edge between capture, playback, and the client
// ---------------------------------------------------------------------------

/**
 * The client surface `useConsole` touches, canned the way `fleet-index.test.tsx`
 * cans it, plus the two audio methods this path spends.
 */
class CannedClient {
  readonly sentAudio: Array<{ agentId: AgentId; pcm: string }> = [];
  readonly endedAudio: AgentId[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  on(name: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter(entry => entry !== listener),
      );
    };
  }
  start(): void {}
  close(): void {}
  reconnectNow(): void {}
  attach(): void {}
  detach(): void {}
  listSessions(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  sessionTail(): void {}
  sessionHistory(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}

  sendAudio(agentId: AgentId, pcm: string): void {
    this.sentAudio.push({ agentId, pcm });
  }

  endAudio(agentId: AgentId): void {
    this.endedAudio.push(agentId);
  }
}

/** A capture whose stop can be held open, because ordering is the contract. */
class FakeCapture {
  readonly availability = { available: true } as const;
  starts = 0;
  cancels = 0;
  stopCalls = 0;
  releaseStop: (() => void) | null = null;
  private onChunk: ((pcm: string) => void) | null = null;

  start(onChunk: (pcm: string) => void): Promise<void> {
    this.starts += 1;
    this.onChunk = onChunk;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return new Promise<void>(resolve => {
      this.releaseStop = resolve;
    });
  }

  cancel(): void {
    this.cancels += 1;
    this.onChunk = null;
  }

  say(pcm: string): void {
    this.onChunk?.(pcm);
  }
}

class FakePlayback {
  readonly availability = { available: true } as const;
  readonly played: string[] = [];
  private readonly gates: Array<() => void> = [];

  play(pcm: string): Promise<void> {
    this.played.push(pcm);
    return new Promise<void>(resolve => {
      this.gates.push(resolve);
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  /** Let the oldest unfinished play finish. */
  releaseOne(): void {
    this.gates.shift()?.();
  }
}

/** A fresh pair per test: counts are assertions, so instances never share them. */
function liveVoice(): MemoVoice & { capture: FakeCapture; playback: FakePlayback } {
  return { capture: new FakeCapture(), playback: new FakePlayback() };
}

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "approve", "manage", "prompt"],
};

interface MountedVoice {
  client: CannedClient;
  capture: FakeCapture;
  playback: FakePlayback;
  state: () => ConsoleState;
  actions: () => ConsoleActions;
  unmount: () => void;
}

function mountConsole(voice: MemoVoice, connection: Connection = CONNECTION): MountedVoice {
  const client = new CannedClient();
  const capture = voice.capture as FakeCapture;
  const playback = voice.playback as FakePlayback;
  let latest: [ConsoleState, ConsoleActions] | null = null;
  function Probe(props: { connection: Connection }): null {
    latest = useConsole(props.connection, () => client as unknown as OmpdClient, voice);
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<Probe connection={connection} />);
  });
  return {
    client,
    capture,
    playback,
    state: () => (latest as NonNullable<typeof latest>)[0],
    actions: () => (latest as NonNullable<typeof latest>)[1],
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("the hook streams an utterance over the existing audio frames", () => {
  test("each chunk becomes one audio frame; audio_end follows the resolved stop", async () => {
    const mounted = mountConsole(liveVoice());
    try {
      act(() => {
        mounted.actions().startVoice("agt_memo");
      });
      expect(mounted.capture.starts).toBe(1);
      expect(mounted.state().capturing).toBe("agt_memo");

      act(() => {
        mounted.capture.say("AAAA");
        mounted.capture.say("BBBB");
      });
      expect(mounted.client.sentAudio).toEqual([
        { agentId: "agt_memo", pcm: "AAAA" },
        { agentId: "agt_memo", pcm: "BBBB" },
      ]);

      act(() => {
        mounted.actions().stopVoice();
      });
      expect(mounted.capture.stopCalls).toBe(1);
      expect(mounted.state().capturing).toBeNull();
      // The end frame waits for the final chunk, so a stop still pending
      // must not have produced it yet.
      expect(mounted.client.endedAudio).toEqual([]);
      await act(async () => {
        mounted.capture.releaseStop?.();
      });
      expect(mounted.client.endedAudio).toEqual(["agt_memo"]);
    } finally {
      mounted.unmount();
    }
  });

  test("a transcript frame becomes dictation state the composer can render", () => {
    const mounted = mountConsole(liveVoice());
    try {
      act(() => {
        mounted.client.emit("transcript", { agentId: "agt_memo", text: "run the tests", final: true });
      });
      expect(mounted.state().dictation.get("agt_memo")).toEqual({ text: "run the tests", final: true });
    } finally {
      mounted.unmount();
    }
  });

  test("speech frames play in arrival order, one at a time", async () => {
    const mounted = mountConsole(liveVoice());
    try {
      await act(async () => {
        mounted.client.emit("speech", { agentId: "agt_memo", pcm: "FIRST" });
        mounted.client.emit("speech", { agentId: "agt_memo", pcm: "SECOND" });
      });
      // Both frames arrived while the first was still playing; the queue
      // must hold the second rather than start it beside the first.
      expect(mounted.playback.played).toEqual(["FIRST"]);
      await act(async () => {
        mounted.playback.releaseOne();
      });
      expect(mounted.playback.played).toEqual(["FIRST", "SECOND"]);
      await act(async () => {
        mounted.playback.releaseOne();
      });
    } finally {
      mounted.unmount();
    }
  });

  test("a platform that cannot capture never opens the mic or sends a frame", () => {
    const unavailable: MemoVoice = {
      capture: {
        availability: { available: false, reason: "Voice input is unavailable on web." },
        start: async () => {
          throw new Error("unavailable seam must not be started");
        },
        stop: async () => {},
        cancel: () => {},
      },
      playback: {
        availability: { available: false, reason: "no playback" },
        play: async () => {},
        stop: async () => {},
      },
    };
    const mounted = mountConsole(unavailable);
    try {
      act(() => {
        mounted.actions().startVoice("agt_memo");
      });
      expect(mounted.state().capturing).toBeNull();
      expect(mounted.client.sentAudio).toEqual([]);
      expect(mounted.client.endedAudio).toEqual([]);
    } finally {
      mounted.unmount();
    }
  });

  test("a pairing the daemon says holds no prompt scope is refused without frames, with a notice", () => {
    const mounted = mountConsole(liveVoice());
    try {
      act(() => {
        mounted.client.emit("agents", { agents: [AGENT], deviceId: "dev", scopes: ["read"] });
      });
      act(() => {
        mounted.actions().startVoice("agt_memo");
      });
      expect(mounted.capture.starts).toBe(0);
      expect(mounted.client.sentAudio).toEqual([]);
      expect(mounted.state().notice).toContain("prompt scope");
    } finally {
      mounted.unmount();
    }
  });

  test("a link drop mid-utterance cancels the mic and says the message was not delivered", () => {
    const mounted = mountConsole(liveVoice());
    try {
      act(() => {
        mounted.actions().startVoice("agt_memo");
      });
      act(() => {
        mounted.client.emit("status", { state: "reconnecting", attempt: 1, delayMs: 500 });
      });
      expect(mounted.capture.cancels).toBe(1);
      expect(mounted.state().capturing).toBeNull();
      expect(mounted.state().notice).toContain("not delivered");
      // And no end frame: the daemon's buffers died with the socket.
      expect(mounted.client.endedAudio).toEqual([]);
    } finally {
      mounted.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The composer control
// ---------------------------------------------------------------------------

function voiceProps(overrides: Partial<SessionVoice> = {}): SessionVoice {
  return {
    access: "granted",
    mic: { available: true },
    speech: { available: true },
    dictation: null,
    capturing: false,
    busyElsewhere: false,
    onToggle: () => {},
    ...overrides,
  };
}

interface MountedSession {
  text: (testID: string) => string;
  attr: (testID: string, name: string) => string | null;
  unmount: () => void;
}

function mountSession(voice: SessionVoice): MountedSession {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <SessionScreen
        agent={AGENT}
        session={EMPTY_SESSION}
        load={{ phase: "ready", generation: 0, error: null }}
        context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
        connection="connected"
        attempt={0}
        canApprove
        spoken={null}
        fleetClearances={0}
        onBack={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
        voice={voice}
      />,
    );
  });
  return {
    text: testID => host.querySelector(`[data-testid="${testID}"]`)?.textContent ?? "",
    attr: (testID, name) => host.querySelector(`[data-testid="${testID}"]`)?.getAttribute(name) ?? null,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("the composer microphone control", () => {
  test("a missing prompt scope disables the control beside the composer and states why, never hides it", () => {
    const mounted = mountSession(voiceProps({ access: "missing" }));
    try {
      // The gate is the control's existence: hiding it is the defect class
      // this app refuses. A null attr means the node itself is gone, which
      // fails the assertion below because "true" is not null.
      expect(mounted.attr("composer-mic", "aria-disabled")).toBe("true");
      expect(mounted.text("composer-mic-status")).toContain("prompt scope");
      expect(mounted.text("composer-mic-status")).toContain("Pair it again");
    } finally {
      mounted.unmount();
    }
  });

  test("a platform that cannot capture names the gap instead of a button that cannot work", () => {
    const mounted = mountSession(
      voiceProps({ mic: { available: false, reason: "Voice input is unavailable on web: no module." } }),
    );
    try {
      expect(mounted.attr("composer-mic", "aria-disabled")).toBe("true");
      expect(mounted.text("composer-mic-status")).toContain("Voice input is unavailable on web: no module.");
    } finally {
      mounted.unmount();
    }
  });

  test("recording shows a clear recording state and the live dictation beneath it", () => {
    const mounted = mountSession(voiceProps({ capturing: true, dictation: { text: "run the tests", final: false } }));
    try {
      expect(mounted.attr("composer-mic", "aria-disabled")).not.toBe("true");
      expect(mounted.text("composer-mic-status")).toContain("Recording");
      expect(mounted.text("composer-dictation")).toContain("run the tests");
      expect(mounted.text("composer-dictation")).toContain("...");
    } finally {
      mounted.unmount();
    }
  });

  test("a final dictation settles without the trailing marker", () => {
    const mounted = mountSession(voiceProps({ dictation: { text: "run the tests", final: true } }));
    try {
      expect(mounted.text("composer-dictation")).toBe("run the tests");
    } finally {
      mounted.unmount();
    }
  });

  test("an idle control with no speech playback names that gap too", () => {
    const mounted = mountSession(
      voiceProps({ speech: { available: false, reason: "Agent speech audio is unavailable on web." } }),
    );
    try {
      expect(mounted.text("composer-mic-status")).toContain("Agent speech audio is unavailable on web.");
    } finally {
      mounted.unmount();
    }
  });
});
