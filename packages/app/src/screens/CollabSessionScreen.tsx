/**
 * A room opened from a collaboration link.
 *
 * The deep link names a room, not a capability. The paired-device connection
 * supplies authority, and the daemon is the source of participant identity.
 */

import { SCOPE_PROMPT, type CollabVoiceNoteFrame, type CollabVoiceParticipant } from "@ompd/core/contracts";
import type { ConnectionState, OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { createOmpdClient } from "../console/useConsole.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Data, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import { type CollabAudioPlayer, CollabVoiceQueue } from "../voice/collab-voice.ts";
import { clipAudio, clipRejection, createRecorder, mintNoteId, type Recorder, type RecorderClip } from "../voice/Recorder.ts";

const defaultAudioPlayer: CollabAudioPlayer = {
  play: async () => {},
};

/**
 * The hold auto-stops here so a finished clip always fits the room. Sixteen
 * kilohertz mono s16le is 32 KB/s of PCM and 42_667 base64 characters per
 * second, and the daemon refuses a note past 1_400_000 characters; 30 s lands
 * at 1.28 M characters with margin. A recorder faster than 16 kHz is still
 * caught after the hold by the clip-length check, which is why both guards
 * exist rather than this one alone.
 */
const MAX_HOLD_MS = 30_000;
const ELAPSED_TICK_MS = 200;

/** One hold at a time, from finger down to the send-or-discard decision. */
type HoldPhase =
  | { kind: "idle" }
  | { kind: "holding" }
  | { kind: "review"; clip: RecorderClip; durationMs: number };

interface LiveHold {
  /** start() can still be settling when the finger lifts; endHold awaits it. */
  start: Promise<void>;
  beganAt: number;
  /** The auto-stop and the finger can race; first one through ends the hold. */
  ended: boolean;
}

export function CollabSessionScreen({
  roomId,
  connection,
  player,
  recorder,
  onClose,
  createClient = createOmpdClient,
}: {
  roomId: string;
  connection: Connection;
  player?: CollabAudioPlayer;
  /** The microphone seam. The default is unavailable on every platform today. */
  recorder?: Recorder;
  onClose: () => void;
  /** Seam for tests: builds the socket client this room rides. */
  createClient?: (connection: Connection) => OmpdClient;
}): JSX.Element {
  const client = useMemo(() => createClient(connection), [connection, createClient]);
  const [participants, setParticipants] = useState<readonly CollabVoiceParticipant[]>([]);
  const [voiceNotes, setVoiceNotes] = useState<readonly CollabVoiceNoteFrame[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const voiceQueue = useMemo(() => new CollabVoiceQueue(player ?? defaultAudioPlayer), [player]);

  const mic = useMemo(() => recorder ?? createRecorder(), [recorder]);
  const [micPermission, setMicPermission] = useState(() => mic.permission());
  const [asking, setAsking] = useState(false);
  const [phase, setPhase] = useState<HoldPhase>({ kind: "idle" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [sendFailure, setSendFailure] = useState<string | null>(null);

  /**
   * The note id of the last send whose answer has not arrived. The daemon
   * answers a published note with the broadcast echo (success) or an error
   * frame (refusal); this is how a refusal is attributed to the hold that
   * caused it rather than to the room in general.
   */
  const pendingNoteRef = useRef<string | null>(null);
  // The hold's timers. Named rather than inlined because the handle type is
  // the thing that silently breaks across tsconfig and platform changes, and
  // one name localizes that the way WebViewDriver's TimerHandle already does.
  type TimerHandle = ReturnType<typeof setTimeout>;
  const holdRef = useRef<LiveHold | null>(null);
  const tickRef = useRef<TimerHandle | null>(null);
  const autoStopRef = useRef<TimerHandle | null>(null);

  useEffect(() => {
    const offStatus = client.on("status", ({ state }) => setConnectionState(state));
    const offParticipants = client.on("room_participants", event => {
      if (event.roomId === roomId) setParticipants(event.participants);
    });
    const offVoice = client.on("collab_voice", event => {
      const frame = event.frame;
      if (frame.roomId === roomId && frame.t === "collab_voice_note") {
        voiceQueue.enqueue(frame);
        setVoiceNotes(prev => (prev.some(n => n.noteId === frame.noteId) ? prev : [...prev, frame]));
        // The daemon commits a note then fans it out to every member of the
        // room, this socket included (rooms.ts broadcasts inside
        // publishVoiceNote), so the sender's own row arrives as the same frame
        // everyone else hears. There is deliberately no local append: an
        // optimistic row would flash a note the daemon may still refuse for
        // scope or size, and clearing it again would need exactly this dedupe.
        if (pendingNoteRef.current === frame.noteId) pendingNoteRef.current = null;
      }
    });
    const offHistory = client.on("collab_voice_history", event => {
      if (event.roomId === roomId) {
        for (const note of event.notes) voiceQueue.enqueue(note);
        setVoiceNotes(event.notes);
      }
    });
    const offError = client.on("error", event => {
      setNotice(event.message);
      // A refusal landing while one of this screen's notes is unanswered is
      // that note's refusal. It is named on the control as well as the room
      // notice, because the person holding the phone needs to know their note
      // did not land, not only that something in the room went wrong.
      if (pendingNoteRef.current !== null) {
        setSendFailure(event.message);
        pendingNoteRef.current = null;
      }
    });

    client.start();
    client.joinRoom(roomId);
    return () => {
      client.leaveRoom(roomId);
      offStatus();
      offParticipants();
      offVoice();
      offHistory();
      offError();
      client.close();
    };
  }, [client, roomId, voiceQueue.enqueue]);

  const clearHoldTimers = (): void => {
    if (tickRef.current !== null) clearInterval(tickRef.current);
    if (autoStopRef.current !== null) clearTimeout(autoStopRef.current);
    tickRef.current = null;
    autoStopRef.current = null;
  };

  const endHold = async (): Promise<void> => {
    const hold = holdRef.current;
    if (hold === null || hold.ended) return;
    hold.ended = true;
    clearHoldTimers();
    holdRef.current = null;
    const durationMs = Math.max(0, Date.now() - hold.beganAt);
    try {
      await hold.start;
      const clip = await mic.stop();
      const rejection = clipRejection(clip);
      if (rejection !== null) {
        // Never hand the room a frame the daemon is certain to reject; name
        // the refusal here, where the hold was.
        setSendFailure(rejection);
        setPhase({ kind: "idle" });
        return;
      }
      setPhase({ kind: "review", clip, durationMs });
    } catch (error) {
      setSendFailure(`recording failed: ${error instanceof Error ? error.message : "the microphone stopped"}`);
      setPhase({ kind: "idle" });
    }
  };

  const beginHold = (): void => {
    if (phase.kind !== "idle") return;
    setSendFailure(null);
    const hold: LiveHold = { start: Promise.resolve(mic.start()), beganAt: Date.now(), ended: false };
    holdRef.current = hold;
    setElapsedMs(0);
    setPhase({ kind: "holding" });
    tickRef.current = setInterval(() => {
      if (holdRef.current === hold) setElapsedMs(Date.now() - hold.beganAt);
    }, ELAPSED_TICK_MS);
    autoStopRef.current = setTimeout(() => void endHold(), MAX_HOLD_MS);
  };

  const cancelHold = (): void => {
    const hold = holdRef.current;
    if (hold === null || hold.ended) return;
    hold.ended = true;
    clearHoldTimers();
    holdRef.current = null;
    // Leaving mid-hold must not ship a half-spoken instruction: cancel
    // releases the microphone and the clip is dropped without a frame.
    mic.cancel();
  };

  // Navigation away unmounts this screen, and that is the only moment this
  // cleanup is allowed to run: holding the latest cancel in a ref keeps a
  // mid-life re-render from ending a live hold.
  const cancelHoldRef = useRef(cancelHold);
  cancelHoldRef.current = cancelHold;
  useEffect(() => () => cancelHoldRef.current(), []);

  const askPermission = (): void => {
    if (asking) return;
    setAsking(true);
    // Asked here, before any hold, so the OS dialog never interrupts a live
    // recording and a denial is known before a finger goes down.
    mic
      .requestPermission()
      .then(state => setMicPermission(state))
      .catch(() => setMicPermission("denied"))
      .finally(() => setAsking(false));
  };

  const sendReview = (): void => {
    if (phase.kind !== "review") return;
    const { clip, durationMs } = phase;
    const rejection = clipRejection(clip);
    if (rejection !== null) {
      setSendFailure(rejection);
      setPhase({ kind: "idle" });
      return;
    }
    const noteId = mintNoteId();
    // Fire and forget on purpose: the answer is the broadcast echo, and a
    // refusal is the error frame attributed to this note by pendingNoteRef.
    // There is no retry of an old clip; the daemon de-duplicates a note id,
    // and the honest fix for a refused note is a new hold.
    client.sendCollabVoiceNote({ roomId, noteId, audio: clipAudio(clip), durationMs });
    pendingNoteRef.current = noteId;
    setPhase({ kind: "idle" });
  };

  const discardReview = (): void => {
    setSendFailure(null);
    setPhase({ kind: "idle" });
  };

  /**
   * The gates run cheapest first: capability, then what this pairing may do,
   * then what the OS allows. Each refuses with its own named state rather
   * than a missing button, because a silently absent surface is exactly the
   * defect this screen exists not to have.
   */
  const recordGate = !mic.available()
    ? "unavailable"
    : !connection.scopes.includes(SCOPE_PROMPT)
      ? "scope"
      : micPermission === "denied"
        ? "denied"
        : micPermission === "unasked"
          ? "unasked"
          : "ready";

  return (
    <SafeScreen style={styles.screen} testID="collab-session">
      <View style={styles.header}>
        <View style={styles.heading}>
          <Kicker color={ink.muted}>Collaboration</Kicker>
          <Display heading>Shared room</Display>
        </View>
        <Pressable
          accessibilityLabel="Return to sessions"
          accessibilityRole="button"
          onPress={onClose}
          style={({ pressed }) => [styles.close, pressed && styles.closePressed]}
        >
          <Label color={ink.plain}>Sessions</Label>
        </Pressable>
      </View>

      <View style={styles.room}>
        <Kicker color={ink.muted}>Room ID</Kicker>
        <Body color={ink.bright} style={type.code} testID="collab-room-id">
          {roomId}
        </Body>
        <Label color={connectionState === "connected" ? signal.sage : ink.muted} testID="collab-connection-state">
          {connectionState === "connected" ? "Connected" : "Connecting to the daemon"}
        </Label>
      </View>

      {notice === null ? null : (
        <View style={styles.notice} accessibilityLiveRegion="polite" testID="collab-notice">
          <Body color={signal.ochre}>{notice}</Body>
        </View>
      )}

      <View style={styles.section} testID="collab-participants">
        <Kicker color={ink.muted}>In this room</Kicker>
        {participants.length === 0 ? (
          <Body color={ink.muted}>Waiting for a participant.</Body>
        ) : (
          participants.map(participant => (
            <View key={participant.id} style={styles.row}>
              <Label color={ink.bright}>{participant.displayName}</Label>
              <Label color={ink.muted}>{participant.kind === "agent" ? "Agent" : "Human"}</Label>
            </View>
          ))
        )}
      </View>

      <View style={styles.section} testID="collab-voice-notes">
        <Kicker color={ink.muted}>Voice Notes ({voiceNotes.length})</Kicker>
        {voiceNotes.length === 0 ? (
          <Body color={ink.muted}>No voice notes in this room yet.</Body>
        ) : (
          voiceNotes.map(note => (
            <View key={note.noteId} style={styles.row}>
              <View style={styles.noteMeta}>
                <Label color={note.participant.kind === "agent" ? signal.sage : ink.bright}>
                  #{note.sequence} {note.participant.displayName}
                </Label>
                <Label color={ink.muted}>{note.durationMs ? `${note.durationMs}ms` : "audio"}</Label>
              </View>
            </View>
          ))
        )}
      </View>

      <View style={styles.section} testID="collab-record">
        <Kicker color={ink.muted}>Speak</Kicker>
        {recordGate === "unavailable" ? (
          <View style={styles.recordState} testID="collab-record-unavailable">
            <Glyph color={signal.ochre} name="warning" size={16} />
            <Body color={ink.plain}>
              This build cannot record voice notes: it has no microphone module yet.
            </Body>
          </View>
        ) : null}
        {recordGate === "scope" ? (
          <View style={styles.recordState} testID="collab-record-scope-missing">
            <Glyph color={signal.ochre} name="warning" size={16} />
            <Body color={ink.plain}>This pairing cannot speak here: it is missing the prompt scope.</Body>
          </View>
        ) : null}
        {recordGate === "denied" ? (
          <View style={styles.recordState} testID="collab-record-permission-denied">
            <Glyph color={signal.ochre} name="warning" size={16} />
            <Body color={ink.plain}>
              Microphone access is off. Allow it for this app in system settings, then reopen this room.
            </Body>
          </View>
        ) : null}
        {recordGate === "unasked" ? (
          <Pressable
            accessibilityLabel="Enable the microphone"
            accessibilityRole="button"
            onPress={askPermission}
            style={({ pressed }) => [styles.hold, pressed && styles.holdPressed]}
            testID="collab-record-enable"
          >
            <Label color={ink.bright}>{asking ? "Asking the system" : "Enable microphone"}</Label>
          </Pressable>
        ) : null}
        {recordGate === "ready" ? (
          <>
            <Pressable
              accessibilityLabel="Hold to record a voice note"
              accessibilityRole="button"
              accessibilityState={phase.kind === "review" ? { disabled: true } : undefined}
              onPressIn={beginHold}
              onPressOut={() => void endHold()}
              style={({ pressed }) => [styles.hold, pressed && styles.holdPressed]}
              testID="collab-record-hold"
            >
              {phase.kind === "holding" ? (
                <View style={styles.holdLive}>
                  <Label color={signal.amber}>Recording</Label>
                  <Data color={ink.bright} testID="collab-record-elapsed">{`${Math.floor(elapsedMs / 1000)}s`}</Data>
                  <Label color={ink.muted}>Release to review</Label>
                </View>
              ) : phase.kind === "review" ? (
                // A sub-second hold still happened; "0s" would read as broken.
                <Label color={ink.bright}>
                  {`Recorded ${Math.max(1, Math.round(phase.durationMs / 1000))}s, send or discard below`}
                </Label>
              ) : (
                <Label color={ink.bright}>Hold to record</Label>
              )}
            </Pressable>
            {phase.kind === "review" ? (
              <View style={styles.reviewRow} testID="collab-record-review">
                <Pressable
                  accessibilityLabel="Send the voice note"
                  accessibilityRole="button"
                  onPress={sendReview}
                  style={({ pressed }) => [styles.hold, pressed && styles.holdPressed]}
                  testID="collab-record-send"
                >
                  <Glyph color={ink.bright} name="send" size={16} />
                  <Label color={ink.bright}>Send</Label>
                </Pressable>
                <Pressable
                  accessibilityLabel="Discard the voice note"
                  accessibilityRole="button"
                  onPress={discardReview}
                  style={({ pressed }) => [styles.hold, styles.discard, pressed && styles.holdPressed]}
                  testID="collab-record-discard"
                >
                  <Label color={ink.muted}>Discard</Label>
                </Pressable>
              </View>
            ) : null}
          </>
        ) : null}
        {sendFailure === null ? null : (
          <View style={styles.notice} accessibilityLiveRegion="polite" testID="collab-record-error">
            <Body color={signal.ochre}>{sendFailure}</Body>
          </View>
        )}
      </View>
    </SafeScreen>
  );
}
const styles = StyleSheet.create({
  screen: { gap: space.loose, padding: space.loose },
  header: { alignItems: "flex-start", flexDirection: "row", gap: space.step, justifyContent: "space-between" },
  heading: { flex: 1, gap: space.tight },
  close: {
    alignItems: "center",
    borderColor: ground.line,
    borderWidth: stroke.hair,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  closePressed: { backgroundColor: ground.active },
  room: { backgroundColor: ground.surface, gap: space.tight, padding: space.step },
  notice: { backgroundColor: signalWash.ochre, padding: space.step },
  section: { gap: space.tight },
  row: {
    alignItems: "center",
    borderBottomColor: ground.line,
    borderBottomWidth: stroke.hair,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: TOUCH_TARGET,
  },
  noteMeta: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  recordState: { alignItems: "flex-start", flexDirection: "row", gap: space.tight },
  hold: {
    alignItems: "center",
    borderColor: ground.line,
    borderWidth: stroke.hair,
    flexDirection: "row",
    gap: space.tight,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  holdPressed: { backgroundColor: ground.active },
  holdLive: { alignItems: "center", flexDirection: "row", gap: space.tight, justifyContent: "center" },
  reviewRow: { flexDirection: "row", gap: space.tight },
  discard: { flex: 1 },
});
