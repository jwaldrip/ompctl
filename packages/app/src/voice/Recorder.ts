/**
 * The microphone seam for collaboration voice notes.
 *
 * Everything else in the send path is real today: the hold control, the wire
 * frame, the daemon's authentication and fan-out. The one piece no target of
 * this app can supply yet is PCM capture. `react-native-vision-camera` (4.7.3)
 * records audio only as a track inside a video file, which is AAC in an MP4 or
 * MOV container, not the `pcm_s16le` the daemon stores and replays, and
 * decoding a container in JS would need a dependency this app does not carry.
 * Every other capture route is the same story, so rather than pretend, the
 * default recorder reports itself unavailable and the collab screen renders a
 * named cannot-record state instead of a button that cannot work. When a
 * native module lands it implements `Recorder` and nothing above this seam
 * changes.
 *
 * What an implementation owes:
 * - mono signed 16-bit little-endian PCM as base64. If hardware capture is
 *   stereo, downmix at the seam; the frame declares `channels: 1` and no layer
 *   after this one can repair a channel count.
 * - a truthfully reported `sampleRate`, an integer in 8_000..96_000. The
 *   daemon stores a finished note's rate verbatim and never resamples it, so a
 *   lie here plays back at the wrong pitch forever. 16_000 is preferred: that
 *   is the rate the daemon's whole voice stack runs at
 *   (`packages/daemon/src/voice/bridge.ts`, `WIRE_SAMPLE_RATE`), so a clip
 *   captured there needs no conversion anywhere.
 * - a permission ask that resolves before any hold begins, and a `cancel`
 *   that releases the microphone without producing a clip.
 */

import type { CollabAudioFormat } from "@ompd/core/contracts";

/** One finished hold, ready to become a `collab_voice_note`. */
export interface RecorderClip {
  /** Base64 mono signed 16-bit little-endian PCM. */
  readonly base64Pcm: string;
  /** The rate `base64Pcm` was captured at, reported truthfully. */
  readonly sampleRate: number;
}

/** The OS microphone permission, read before the first hold. */
export type MicPermission = "granted" | "denied" | "unasked";

export interface Recorder {
  /**
   * Whether this platform can capture PCM at all. False is a property of the
   * build, not a busy state: the caller renders a named unavailable state and
   * never asks for permission or a hold.
   */
  available(): boolean;
  permission(): MicPermission;
  /** Ask once, before any hold. Resolves with the resulting state. */
  requestPermission(): Promise<MicPermission>;
  /** Begin capturing. Must resolve before `stop` returns its clip. */
  start(): Promise<void> | void;
  /** Finish the hold and hand over everything it captured. */
  stop(): Promise<RecorderClip>;
  /** Abandon a live hold: release the microphone, produce nothing. */
  cancel(): void;
}

/**
 * Wire limits copied from the daemon's own validation
 * (`packages/daemon/src/collab/rooms.ts`, `#requireVoiceNote`), so a clip the
 * control would send can never be a frame the daemon must reject.
 */
export const MAX_AUDIO_BASE64_CHARS = 1_400_000;
export const MIN_SAMPLE_RATE_HZ = 8_000;
export const MAX_SAMPLE_RATE_HZ = 96_000;

/**
 * Why this clip cannot be sent, in plain language for the person holding the
 * phone, or null when it can. The conditions mirror the daemon's rules one
 * for one; the messages exist so the refusal is named here rather than
 * bounced off the room.
 */
export function clipRejection(clip: RecorderClip): string | null {
  if (clip.base64Pcm.length === 0) return "nothing was recorded";
  if (clip.base64Pcm.length > MAX_AUDIO_BASE64_CHARS) {
    return "the recording is too long for this room";
  }
  if (
    !Number.isInteger(clip.sampleRate) ||
    clip.sampleRate < MIN_SAMPLE_RATE_HZ ||
    clip.sampleRate > MAX_SAMPLE_RATE_HZ
  ) {
    return `this build recorded at ${clip.sampleRate} Hz, which the room cannot carry`;
  }
  return null;
}

/** A note id the daemon accepts: plain `[A-Za-z0-9_-]`, unique per hold. */
export function mintNoteId(now: number = Date.now(), random: () => number = Math.random): string {
  return `note_${now.toString(36)}_${Math.floor(random() * 1e9).toString(36)}`;
}

/**
 * The audio member of a `CollabVoiceNoteInput`. The seam fixes mono, so
 * `channels` is a constant rather than a caller's guess.
 */
export function clipAudio(clip: RecorderClip): CollabAudioFormat & { pcm: string } {
  return { encoding: "pcm_s16le", sampleRateHz: clip.sampleRate, channels: 1, pcm: clip.base64Pcm };
}

/** The honest default: no target of this app captures PCM today. */
class UnavailableRecorder implements Recorder {
  available(): boolean {
    return false;
  }

  // Never reached in the screen, which renders the unavailable state first.
  // Returning inert values rather than throwing keeps the seam total for any
  // caller that probes before deciding.
  permission(): MicPermission {
    return "unasked";
  }

  requestPermission(): Promise<MicPermission> {
    return Promise.resolve("unasked");
  }

  start(): Promise<void> {
    return Promise.reject(new Error("no recorder is available on this platform"));
  }

  stop(): Promise<RecorderClip> {
    return Promise.reject(new Error("no recorder is available on this platform"));
  }

  cancel(): void {}
}

/** The recorder every platform gets until a native capture module exists. */
export function createRecorder(): Recorder {
  return new UnavailableRecorder();
}
