/**
 * The send half of collaboration voice notes: the hold control, against the
 * real daemon contract.
 *
 * The client is the real `OmpdClient` over a canned socket, the same division
 * the invite and remote-start suites use: only the wire is fake, so the
 * `collab_voice_note` frames in `socket.sent` are the frames a daemon would
 * receive and validate. The microphone is the seam from
 * `src/voice/Recorder.ts`, faked here because no target of this app
 * implements it yet; everything above that seam is production code.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { ClientFrame, CollabVoiceNoteFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";
import type { MicPermission, Recorder, RecorderClip } from "../src/voice/Recorder.ts";

// Dynamic on purpose, the reason every screen test in this directory is: bun
// evaluates a file's static import graph before its body runs, so a static
// import would pull the real `react-native` in before `./rnw.ts` substitutes
// it with react-native-web.
const { CollabSessionScreen } = await import("../src/screens/CollabSessionScreen.tsx");
const { clipRejection, createRecorder, MAX_AUDIO_BASE64_CHARS, mintNoteId } = await import("../src/voice/Recorder.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ROOM_ID = "room_0123456789";
const DIRECT: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_test",
  scopes: ["read", "prompt"],
};

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  closedWith: SocketCloseInfo | null = null;

  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  framesOfType(t: ClientFrame["t"]): ClientFrame[] {
    return this.sent.filter(frame => frame.t === t);
  }
}

/** A real client on a canned wire; the scheduler never fires, so no ping or backoff timers run. */
function cannedClient(): { client: OmpdClient; socket: FakeSocket } {
  const socket = new FakeSocket("ws://127.0.0.1:7777/v1/socket");
  const client = new OmpdClient({
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_test",
    createSocket: () => socket,
    schedule: () => () => {},
    isOnline: () => true,
    probeCredential: () => Promise.resolve("unknown"),
  });
  return { client, socket };
}

/** A Recorder implementing the seam exactly the way a future native module would. */
class FakeRecorder implements Recorder {
  starts = 0;
  stops = 0;
  cancels = 0;
  capable = true;
  state: MicPermission = "granted";
  grants: MicPermission = "granted";
  clip: RecorderClip = { base64Pcm: "AAE=", sampleRate: 16_000 };
  stopError: Error | null = null;

  available(): boolean {
    return this.capable;
  }

  permission(): MicPermission {
    return this.state;
  }

  async requestPermission(): Promise<MicPermission> {
    this.state = this.grants;
    return this.grants;
  }

  async start(): Promise<void> {
    this.starts += 1;
  }

  async stop(): Promise<RecorderClip> {
    this.stops += 1;
    if (this.stopError !== null) throw this.stopError;
    return this.clip;
  }

  cancel(): void {
    this.cancels += 1;
  }
}

interface Room {
  host: HTMLElement;
  socket: FakeSocket;
  recorder: FakeRecorder;
  press(testID: string): void;
  pointerDown(testID: string): void;
  pointerUp(): void;
  query(testID: string): HTMLElement | null;
  text(testID: string): string;
  deliver(frame: ServerFrame): void;
  unmount(): void;
}

function mountRoom(options: { recorder?: FakeRecorder; scopes?: string[] } = {}): Room {
  const recorder = options.recorder ?? new FakeRecorder();
  const { client, socket } = cannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const connection: Connection = options.scopes === undefined ? DIRECT : { ...DIRECT, scopes: options.scopes };

  act(() => {
    root.render(
      <CollabSessionScreen
        roomId={ROOM_ID}
        connection={connection}
        recorder={recorder}
        createClient={() => client}
        onClose={() => {}}
      />,
    );
  });
  // Bring the link up the way a daemon would: accept, then greet. The client
  // replays the room join on hello, so the room is live before any gesture.
  act(() => {
    socket.accept();
    socket.deliver({ t: "hello", deviceId: "dev_test", agents: [] });
  });

  const el = (testID: string): HTMLElement => {
    const element = host.querySelector(`[data-testid="${testID}"]`);
    if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} rendered`);
    return element;
  };

  return {
    host,
    socket,
    recorder,
    // Plain onPress rides the native click event in RNW, the same way every
    // other suite in this directory presses a button.
    press: testID => {
      act(() => {
        el(testID).click();
      });
    },
    // A hold is a press-in/press-out pair, which RNW's responder system
    // drives from mousedown/mouseup: down on the element begins the hold,
    // up anywhere releases it, exactly as a finger's touch does.
    pointerDown: testID => {
      act(() => {
        el(testID).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
      });
    },
    pointerUp: () => {
      act(() => {
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
      });
    },
    query: testID => {
      const element = host.querySelector(`[data-testid="${testID}"]`);
      return element instanceof HTMLElement ? element : null;
    },
    text: testID => el(testID).textContent ?? "",
    deliver: frame => {
      act(() => {
        socket.deliver(frame);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/**
 * RNW activates a press 50ms after it begins (DEFAULT_PRESS_DELAY_MS in its
 * PressResponder): onPressIn is a delayed timer, not a synchronous effect of
 * mousedown. A hold that means to be held therefore waits out that delay
 * before it is released, exactly as a finger does; onPressOut is immediate.
 */
const PRESS_IN_SETTLE_MS = 80;

/** Let the hold's microtasks commit, optionally after real milliseconds. */
async function settle(ms: number = 0): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    await promise;
  });
}

/** Hold, release, and hand back the one note frame the control sent, if any. */
async function holdAndSend(room: Room): Promise<Extract<ClientFrame, { t: "collab_voice_note" }>> {
  room.pointerDown("collab-record-hold");
  await settle(PRESS_IN_SETTLE_MS);
  room.pointerUp();
  await settle();
  room.press("collab-record-send");
  await settle();
  const sent = room.socket.framesOfType("collab_voice_note");
  if (sent.length !== 1) throw new Error(`expected exactly one voice note frame, got ${sent.length}`);
  return sent[0] as Extract<ClientFrame, { t: "collab_voice_note" }>;
}

/** The frame the daemon broadcasts back to every member, sender included. */
function echoFrame(noteId: string): CollabVoiceNoteFrame {
  return {
    t: "collab_voice_note",
    roomId: ROOM_ID,
    noteId,
    sequence: 1,
    createdAt: "2026-08-19T12:00:00.000Z",
    participant: { id: "dev_test", kind: "human" },
    audio: { pcm: "AAE=", encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    durationMs: 4,
  };
}

// ---------------------------------------------------------------------------
// The gates: each refusal is a named state on the control, never a missing
// button. A surface that silently shows nothing is the defect class this
// whole screen exists not to have.
// ---------------------------------------------------------------------------

describe("the record control's gates", () => {
  test("a platform without the recorder shows the named unavailable state, not a hidden button", () => {
    const recorder = new FakeRecorder();
    recorder.capable = false;
    const room = mountRoom({ recorder });

    expect(room.query("collab-record-unavailable")).not.toBeNull();
    expect(room.text("collab-record-unavailable")).toContain("cannot record");
    expect(room.query("collab-record-hold")).toBeNull();
    expect(recorder.starts).toBe(0);
    room.unmount();
  });

  test("a pairing without prompt scope names the refusal instead of offering the hold", () => {
    const room = mountRoom({ scopes: ["read"] });

    expect(room.query("collab-record-scope-missing")).not.toBeNull();
    expect(room.text("collab-record-scope-missing")).toContain("prompt scope");
    expect(room.query("collab-record-hold")).toBeNull();
    room.unmount();
  });

  test("microphone permission is asked before the first hold, never during one", async () => {
    const recorder = new FakeRecorder();
    recorder.state = "unasked";
    recorder.grants = "granted";
    const room = mountRoom({ recorder });

    expect(room.query("collab-record-enable")).not.toBeNull();
    expect(room.query("collab-record-hold")).toBeNull();
    expect(recorder.starts).toBe(0);

    room.press("collab-record-enable");
    await settle();

    expect(room.query("collab-record-hold")).not.toBeNull();
    // The hold has still not begun; the ask happened entirely before one.
    expect(recorder.starts).toBe(0);
    room.unmount();
  });

  test("a denied microphone is a named state naming the system setting it needs", () => {
    const recorder = new FakeRecorder();
    recorder.state = "denied";
    const room = mountRoom({ recorder });

    expect(room.query("collab-record-permission-denied")).not.toBeNull();
    expect(room.text("collab-record-permission-denied")).toContain("system settings");
    expect(room.query("collab-record-hold")).toBeNull();
    room.unmount();
  });
});

// ---------------------------------------------------------------------------
// The hold itself, and the frame it puts on the wire
// ---------------------------------------------------------------------------

describe("hold, review, send", () => {
  test("hold records with elapsed time, release reviews, and send emits the exact frame the daemon validates", async () => {
    const room = mountRoom();

    room.pointerDown("collab-record-hold");
    // The press only becomes active once RNW's press-in delay elapses.
    await settle(PRESS_IN_SETTLE_MS);
    expect(room.recorder.starts).toBe(1);
    expect(room.query("collab-record-elapsed")).not.toBeNull();

    room.pointerUp();
    await settle();
    expect(room.query("collab-record-review")).not.toBeNull();
    expect(room.recorder.stops).toBe(1);

    room.press("collab-record-send");
    await settle();

    const sent = room.socket.framesOfType("collab_voice_note");
    expect(sent).toHaveLength(1);
    const frame = sent[0] as Extract<ClientFrame, { t: "collab_voice_note" }>;
    // Exactly the shape `rooms.ts #requireVoiceNote` validates: nothing more,
    // nothing the daemon did not ask for.
    expect(Object.keys(frame).sort()).toEqual(["audio", "durationMs", "noteId", "roomId", "t"]);
    expect(frame.roomId).toBe(ROOM_ID);
    expect(frame.audio).toEqual({ encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1, pcm: "AAE=" });
    expect(frame.noteId).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(Number.isInteger(frame.durationMs)).toBe(true);
    expect(frame.durationMs).toBeGreaterThanOrEqual(0);
    room.unmount();
  });

  test("discard emits nothing and returns the control to idle", async () => {
    const room = mountRoom();

    room.pointerDown("collab-record-hold");
    await settle(PRESS_IN_SETTLE_MS);
    room.pointerUp();
    await settle();
    room.press("collab-record-discard");
    await settle();

    expect(room.socket.framesOfType("collab_voice_note")).toHaveLength(0);
    expect(room.query("collab-record-review")).toBeNull();
    expect(room.query("collab-record-hold")).not.toBeNull();
    room.unmount();
  });

  test("the sender's own note arrives as the daemon's broadcast, never a local append", async () => {
    const room = mountRoom();
    const frame = await holdAndSend(room);

    // No optimistic row: until the daemon's broadcast arrives, the room list
    // is untouched, because a note can still be refused for scope or size.
    expect(room.text("collab-voice-notes")).toContain("No voice notes");

    room.deliver(echoFrame(frame.noteId));
    await settle();

    expect(room.text("collab-voice-notes")).toContain("Voice Notes (1)");
    expect(room.text("collab-voice-notes")).toContain("#1");
    room.unmount();
  });

  test("a refusal to a sent note is named on the control", async () => {
    const room = mountRoom();
    await holdAndSend(room);

    room.deliver({ t: "error", code: "unauthorized", message: "voice notes require prompt scope" });
    await settle();

    expect(room.query("collab-record-error")).not.toBeNull();
    expect(room.text("collab-record-error")).toContain("voice notes require prompt scope");
    room.unmount();
  });

  test("navigation away mid-hold cancels the note instead of sending a partial one", async () => {
    const room = mountRoom();

    room.pointerDown("collab-record-hold");
    await settle(PRESS_IN_SETTLE_MS);
    room.unmount();

    expect(room.recorder.cancels).toBe(1);
    expect(room.recorder.stops).toBe(0);
    expect(room.socket.framesOfType("collab_voice_note")).toHaveLength(0);
  });

  test("a microphone that fails mid-hold names the failure instead of vanishing", async () => {
    const recorder = new FakeRecorder();
    recorder.stopError = new Error("microphone went away");
    const room = mountRoom({ recorder });

    room.pointerDown("collab-record-hold");
    await settle(PRESS_IN_SETTLE_MS);
    room.pointerUp();
    await settle();

    expect(room.query("collab-record-error")).not.toBeNull();
    expect(room.text("collab-record-error")).toContain("microphone went away");
    expect(room.query("collab-record-review")).toBeNull();
    room.unmount();
  });
});

// ---------------------------------------------------------------------------
// The seam itself: what it promises before any native module exists
// ---------------------------------------------------------------------------

describe("the Recorder seam", () => {
  test("the default recorder is honestly unavailable, on every platform it is asked on", () => {
    expect(createRecorder().available()).toBe(false);
  });

  test("a clip the daemon would refuse is named before it is ever sent", () => {
    expect(clipRejection({ base64Pcm: "", sampleRate: 16_000 })).toBe("nothing was recorded");
    expect(clipRejection({ base64Pcm: "A".repeat(MAX_AUDIO_BASE64_CHARS + 1), sampleRate: 16_000 })).toBe(
      "the recording is too long for this room",
    );
    expect(clipRejection({ base64Pcm: "AAE=", sampleRate: 192_000 })).toBe(
      "this build recorded at 192000 Hz, which the room cannot carry",
    );
    expect(clipRejection({ base64Pcm: "AAE=", sampleRate: 16_000 })).toBeNull();
    // A rate the room carries verbatim, like a 44.1 kHz module, passes: the
    // daemon stores the declared rate rather than resampling a finished note.
    expect(clipRejection({ base64Pcm: "AAE=", sampleRate: 44_100 })).toBeNull();
  });

  test("minted note ids fit the daemon's identifier rule and stay unique within a burst", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const id = mintNoteId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
      ids.add(id);
    }
    expect(ids.size).toBe(50);
  });
});
