/**
 * The device voice seam for memo speech: microphone in, agent speech out.
 *
 * Everything else in the memo path is real today: the wire frames, the
 * client methods, the console state, the composer control. The one piece no
 * target of this app can supply yet is a native module that both captures
 * PCM and plays it back. `OmpctlNarration` is deliberately not it: that
 * module owns text to speech for narration and its tested speak/stop
 * contract stays separate, the same way `say` and `speech` frames stay
 * separate on the wire. So this seam resolves a module of its own, named
 * `OmpctlVoice`, and until one exists every platform reports capture and
 * playback unavailable by name and the composer says so rather than showing
 * a microphone that cannot work. When a native module lands it implements
 * the interface below and nothing above this seam changes.
 *
 * What a native implementation owes:
 * - capture at exactly the rate it is handed, mono signed 16-bit
 *   little-endian PCM, delivered as `voice_chunk` events carrying base64.
 *   The rate is the wire contract, not a request: the daemon does not
 *   resample what arrives.
 * - a `stopCapture` that resolves only after the final chunk event has been
 *   emitted, so a caller can send `audio_end` after, not beside, the last
 *   audio frame.
 * - a `stopCapture` that also releases the microphone when no utterance is
 *   open, so the seam's `cancel` can call it unconditionally.
 * - a `startCapture` that is legal immediately after a stop or a cancel.
 * - `playPcm` that resolves when the chunk finishes, so JavaScript can keep
 *   the daemon's ordered `speech` segments ordered on the speaker.
 */

import { NativeEventEmitter, type NativeModule, NativeModules, Platform } from "react-native";

export type VoiceAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/**
 * The rate every `audio` frame this app sends and every `speech` frame it
 * receives is in. Mirrors `WIRE_SAMPLE_RATE` in
 * `packages/daemon/src/voice/bridge.ts`, which is the contract: the app
 * package does not depend on the daemon package, so the number is copied
 * once, named, and never invented here.
 */
export const WIRE_SAMPLE_RATE = 16_000;

/** The React Native module shape that makes device voice available. */
export interface OmpctlVoiceModule {
  /** Begin streaming capture. Chunks arrive as `voice_chunk` events. */
  startCapture(sampleRate: number): Promise<void>;
  /** Finish capture. Resolves only after the final chunk event has fired. */
  stopCapture(): Promise<void>;
  /** Play one base64 PCM16 chunk at `WIRE_SAMPLE_RATE`. Resolves when done. */
  playPcm(base64: string): Promise<void>;
  /** Stop any playing speech audio. */
  stopPlayback(): Promise<void>;
  /** The event surface capture chunks arrive on. The real module streams these as device events; see `withEventStream`. */
  addListener(eventName: "voice_chunk", listener: (event: { pcm: string }) => void): { remove(): void };
}

/** Streaming microphone capture, chunk by chunk, at the wire rate. */
export interface VoiceCapture {
  readonly availability: VoiceAvailability;
  /**
   * Begin one utterance. `onChunk` receives base64 mono PCM16 chunks at
   * `WIRE_SAMPLE_RATE`, each becoming one `audio` frame. Must resolve
   * before the first chunk is expected.
   */
  start(onChunk: (pcm: string) => void): Promise<void>;
  /** Finish the utterance. Resolves after the final `onChunk`. */
  stop(): Promise<void>;
  /** Abandon the utterance: release the microphone, produce nothing more. */
  cancel(): void;
}

/** Ordered playback of the daemon's synthesized speech. */
export interface SpeechPlayback {
  readonly availability: VoiceAvailability;
  /** Play one base64 PCM16 chunk. Resolves when it has finished. */
  play(pcm: string): Promise<void>;
  /** Stop any playing speech audio. */
  stop(): Promise<void>;
}

/** Both halves of the device voice path, as one injectable pair. */
export interface MemoVoice {
  readonly capture: VoiceCapture;
  readonly playback: SpeechPlayback;
}

export type VoicePlatform = "ios" | "android" | "web" | "macos" | "windows" | string;

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  ios: "iOS",
  android: "Android",
  web: "web",
  macos: "macOS",
  windows: "Windows",
};

function unavailable(reason: string): VoiceAvailability {
  return { available: false, reason };
}

/**
 * Bind the capture half to one optional native module. A missing module is
 * a named state on every target, not a button that accepts a press and
 * produces silence.
 */
export function createDeviceVoiceCapture(platform: VoicePlatform, module: OmpctlVoiceModule | undefined): VoiceCapture {
  if (module === undefined) {
    const name = PLATFORM_NAMES[platform] ?? platform;
    return {
      availability: unavailable(
        `Voice input is unavailable on ${name}: this build has no OmpctlVoice microphone module.`,
      ),
      // Never reached in the composer, which renders the unavailable state
      // first. Rejecting rather than no-op keeps the seam honest for any
      // caller that probes late: a recording that never produces a chunk
      // must fail loudly, not hang as a recording that never ends.
      start: async () => {
        throw new Error("no voice capture is available on this platform");
      },
      stop: async () => {},
      cancel: () => {},
    };
  }

  // One live listener per seam instance: a start that follows a stop or a
  // cancel replaces the listener rather than stacking a second one, and two
  // seam instances never share a microphone subscription.
  let subscription: { remove(): void } | null = null;
  const detach = (): void => {
    subscription?.remove();
    subscription = null;
  };

  return {
    availability: { available: true },
    start: async onChunk => {
      const listener = module.addListener("voice_chunk", event => {
        // An empty chunk is no audio, and a frame with no audio is traffic
        // the daemon's buffer accounting would still pay for.
        if (event.pcm.length > 0) onChunk(event.pcm);
      });
      // Registered before the await, not after: a cancel that lands while
      // `startCapture` is still pending must already be able to detach
      // this listener, or chunks from a capture that was cancelled mid-open
      // would keep flowing into the next utterance.
      subscription = listener;
      try {
        await module.startCapture(WIRE_SAMPLE_RATE);
      } catch (cause) {
        detach();
        throw cause;
      }
      subscription = listener;
    },
    stop: async () => {
      try {
        await module.stopCapture();
      } finally {
        detach();
      }
    },
    cancel: () => {
      detach();
      void module.stopCapture().catch(() => {
        // Cancel releases hardware; a module with nothing left to release
        // has still released it, and the operator has no remedy for the error.
      });
    },
  };
}

/**
 * Bind the playback half to one optional native module, with the same
 * honesty rule as capture: unavailable is a named state, never silence the
 * operator cannot distinguish from an agent that said nothing.
 */
export function createDeviceSpeechPlayback(
  platform: VoicePlatform,
  module: OmpctlVoiceModule | undefined,
): SpeechPlayback {
  if (module === undefined) {
    const name = PLATFORM_NAMES[platform] ?? platform;
    return {
      availability: unavailable(
        `Agent speech audio is unavailable on ${name}: this build has no OmpctlVoice playback module.`,
      ),
      play: async () => {},
      stop: async () => {},
    };
  }

  return {
    availability: { available: true },
    play: async pcm => {
      await module.playPcm(pcm);
    },
    stop: async () => {
      await module.stopPlayback();
    },
  };
}

const nativeVoice = (NativeModules as Readonly<Record<string, unknown>>).OmpctlVoice;

function isVoiceModule(value: unknown): value is OmpctlVoiceModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OmpctlVoiceModule>;
  return (
    typeof candidate.startCapture === "function" &&
    typeof candidate.stopCapture === "function" &&
    typeof candidate.playPcm === "function" &&
    typeof candidate.stopPlayback === "function"
  );
}

/**
 * Chunks arrive as device events, not through the module's own `addListener`.
 *
 * A JS function handed to a bridged method crosses as a single-shot callback:
 * React Native's `convertJSIFunctionToCallback` drops the callback after one
 * call and `LOG(FATAL)`s on the second ("Callback arg cannot be called more
 * than once"), and Android's `CallbackImpl` throws the same way. A stream of
 * audio chunks through that hop would therefore hard-crash the app on chunk
 * two. The event emitter is the one surface that streams, so the real module
 * is wrapped here and the seam above keeps the injectable shape its tests use.
 */
function withEventStream(native: OmpctlVoiceModule): OmpctlVoiceModule {
  const emitter = new NativeEventEmitter(native as unknown as NativeModule);
  return {
    startCapture: rate => native.startCapture(rate),
    stopCapture: () => native.stopCapture(),
    playPcm: pcm => native.playPcm(pcm),
    stopPlayback: () => native.stopPlayback(),
    addListener: (eventName, listener) => emitter.addListener(eventName, listener),
  };
}

const module = isVoiceModule(nativeVoice) ? withEventStream(nativeVoice) : undefined;

/** The pair every platform gets: live where the native module exists, named otherwise. */
export const deviceMemoVoice: MemoVoice = {
  capture: createDeviceVoiceCapture(Platform.OS, module),
  playback: createDeviceSpeechPlayback(Platform.OS, module),
};
