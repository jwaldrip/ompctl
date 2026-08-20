import { useCallback, useEffect, useState } from "react";
import { NativeModules, Platform } from "react-native";
import type { Entry } from "../session/model.ts";

export type NarrationAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

/**
 * The device speech contract narration needs.
 *
 * `speak` resolves when one segment has finished, which lets JavaScript keep
 * streamed segments in order. `stop` interrupts that segment and clears any
 * native queue. A native implementation needs only these two methods.
 */
export interface NarrationSpeech {
  readonly availability: NarrationAvailability;
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}

/** The React Native module shape that makes device narration available. */
export interface OmpctlNarrationModule {
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
}

export type NarrationPlatform = "ios" | "android" | "web" | "macos" | "windows" | string;

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  ios: "iOS",
  android: "Android",
  web: "web",
  macos: "macOS",
  windows: "Windows",
};

/**
 * Bind the shared pipeline to one optional native module.
 *
 * Platform capability is checked here rather than inferred by the control. A
 * missing module remains a named state on every target instead of a button
 * that accepts a tap and produces silence.
 */
export function createDeviceNarrationSpeech(
  platform: NarrationPlatform,
  module: OmpctlNarrationModule | undefined,
): NarrationSpeech {
  if (module === undefined || typeof module.speak !== "function" || typeof module.stop !== "function") {
    const name = PLATFORM_NAMES[platform] ?? platform;
    return {
      availability: {
        available: false,
        reason: `Narration is unavailable on ${name}: this build has no OmpctlNarration text-to-speech module.`,
      },
      speak: async () => {},
      stop: async () => {},
    };
  }

  return {
    availability: { available: true },
    speak: async text => {
      await module.speak(text);
    },
    stop: async () => {
      await module.stop();
    },
  };
}

const nativeNarration = (NativeModules as Readonly<Record<string, unknown>>).OmpctlNarration;

function isNarrationModule(value: unknown): value is OmpctlNarrationModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OmpctlNarrationModule>;
  return typeof candidate.speak === "function" && typeof candidate.stop === "function";
}

export const deviceNarrationSpeech = createDeviceNarrationSpeech(
  Platform.OS,
  isNarrationModule(nativeNarration) ? nativeNarration : undefined,
);

interface NarrationCursor {
  /** The cumulative assistant text observed on the last render. */
  seen: string;
  /** Text not yet closed by a speaking boundary. */
  pending: string;
}

interface Segments {
  readonly ready: readonly string[];
  readonly pending: string;
}

const MAX_SEGMENT_CHARS = 220;

/**
 * Cut text at speech-sized boundaries without waiting for the whole turn.
 * Sentence punctuation starts narration promptly; the size cap prevents one
 * punctuation-free paragraph from becoming a single long native utterance.
 */
function takeSegments(text: string, flush: boolean): Segments {
  const ready: string[] = [];
  let start = 0;
  let lastBreak = -1;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (/\s/.test(char)) lastBreak = index;

    const next = text[index + 1];
    const sentenceEnd = (char === "." || char === "!" || char === "?") && (next === undefined || /\s/.test(next));
    const paragraphEnd = char === "\n" && next === "\n";
    const sizeEnd = index - start >= MAX_SEGMENT_CHARS && lastBreak >= start;
    if (!sentenceEnd && !paragraphEnd && !sizeEnd) continue;

    const end = sizeEnd && !sentenceEnd && !paragraphEnd ? lastBreak + 1 : index + 1;
    const segment = normaliseSegment(text.slice(start, end));
    if (segment.length > 0) ready.push(segment);
    start = end;
    lastBreak = -1;
    index = end - 1;
  }

  const remainder = text.slice(start);
  if (!flush) return { ready, pending: remainder };

  const final = normaliseSegment(remainder);
  if (final.length > 0) ready.push(final);
  return { ready, pending: "" };
}

function normaliseSegment(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function assistantProse(entries: readonly Entry[]): Array<Extract<Entry, { kind: "assistant" }>> {
  const prose: Array<Extract<Entry, { kind: "assistant" }>> = [];
  for (const entry of entries) {
    if (entry.kind === "assistant" && !entry.thought) prose.push(entry);
  }
  return prose;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Stateful bridge from cumulative transcript rows to ordered speech segments.
 *
 * The transcript grows by replacement: each render carries the whole reply so
 * far. Cursors retain the prefix already observed, and only the new suffix can
 * enter the speech queue. Tool, system, user, and thought rows never get a
 * cursor, so they cannot be spoken accidentally.
 */
export class SessionNarrator {
  readonly #speech: NarrationSpeech;
  readonly #onFailure: (message: string) => void;
  readonly #cursors = new Map<string, NarrationCursor>();
  #enabled = false;
  #generation = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(speech: NarrationSpeech, onFailure: (message: string) => void = () => {}) {
    this.#speech = speech;
    this.#onFailure = onFailure;
  }

  /** Enable future speech and baseline every row already on screen. */
  start(entries: readonly Entry[]): boolean {
    if (!this.#speech.availability.available) return false;
    if (this.#enabled) return true;

    this.#enabled = true;
    this.#generation += 1;
    this.#cursors.clear();
    for (const entry of assistantProse(entries)) {
      this.#cursors.set(entry.id, { seen: entry.text, pending: "" });
    }
    return true;
  }

  /** Consume the latest cumulative transcript state. */
  update(entries: readonly Entry[]): void {
    if (!this.#enabled) return;

    for (const entry of assistantProse(entries)) {
      const before = this.#cursors.get(entry.id) ?? { seen: "", pending: "" };

      // ACP message chunks append. If a future producer replaces text instead,
      // baseline the replacement rather than repeating a prefix the user may
      // already have heard.
      if (!entry.text.startsWith(before.seen)) {
        this.#cursors.set(entry.id, { seen: entry.text, pending: "" });
        continue;
      }

      const delta = entry.text.slice(before.seen.length);
      const segments = takeSegments(before.pending + delta, !entry.streaming);
      this.#cursors.set(entry.id, { seen: entry.text, pending: segments.pending });
      for (const segment of segments.ready) this.#enqueue(segment);
    }
  }

  /** Stop the current utterance and invalidate everything queued behind it. */
  stop(): void {
    if (!this.#enabled) return;
    this.#enabled = false;
    this.#generation += 1;
    this.#cursors.clear();

    const queued = this.#tail.catch(() => {});
    const stopped = this.#speech.stop().catch(cause => {
      this.#onFailure(`Narration could not stop: ${errorMessage(cause)}`);
    });
    this.#tail = Promise.all([queued, stopped]).then(() => {});
  }

  /** Test and lifecycle seam: resolves after everything accepted so far settles. */
  whenIdle(): Promise<void> {
    return this.#tail;
  }

  #enqueue(text: string): void {
    const generation = this.#generation;
    this.#tail = this.#tail
      .catch(() => {})
      .then(async () => {
        if (!this.#enabled || generation !== this.#generation) return;
        await this.#speech.speak(text);
      })
      .catch(cause => {
        if (!this.#enabled || generation !== this.#generation) return;
        this.#enabled = false;
        this.#generation += 1;
        this.#cursors.clear();
        this.#onFailure(`Narration stopped: ${errorMessage(cause)}`);
      });
  }
}

export interface NarrationState {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly reason: string | null;
  toggle(): void;
}

/** Keep one narrator aligned with the selected session's cumulative entries. */
export function useNarration(entries: readonly Entry[], speech: NarrationSpeech = deviceNarrationSpeech): NarrationState {
  const [enabled, setEnabled] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [narrator] = useState(
    () =>
      new SessionNarrator(speech, message => {
        setEnabled(false);
        setFailure(message);
      }),
  );

  useEffect(() => {
    narrator.update(entries);
  }, [entries, narrator]);

  useEffect(
    () => () => {
      narrator.stop();
    },
    [narrator],
  );

  const toggle = useCallback(() => {
    if (!speech.availability.available) return;
    if (enabled) {
      narrator.stop();
      setEnabled(false);
      return;
    }
    setFailure(null);
    setEnabled(narrator.start(entries));
  }, [enabled, entries, narrator, speech.availability.available]);

  return {
    available: speech.availability.available,
    enabled,
    reason: speech.availability.available ? failure : speech.availability.reason,
    toggle,
  };
}
