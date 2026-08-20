/**
 * One live terminal session: its recent turns, plus a prompt surface.
 *
 * A session running in a terminal has no agent row, so this device cannot
 * `attach` to it and there is no update stream to replay. What it can have is
 * the session's own file: the daemon reads the tail of that JSONL and serves
 * it as `session_tail`, which is the history this screen renders. Above the
 * composer, oldest first, so the newest turn sits closest to where the
 * operator types. Tapping a session with a thousand messages in it used to
 * open a composer over an empty pane, which reads as a broken session rather
 * than as a surface that never had a transcript.
 *
 * Everything below the history is a hint rather than transcript, and the two
 * must not be conflated: the daemon delivers prompts to the terminal as the
 * operator's own turn and reports turn progress back as `tui_activity`, so
 * sent, working, the last reply, and the daemon's refusal when the terminal
 * has no bridge all continue below the tail as they arrive. The next open
 * re-reads the file, at which point today's hints are simply part of the
 * history.
 *
 * The composer here is not `Composer`, on purpose. That control turns its
 * send button into an interrupt while a turn runs, because an agent's turn
 * can be cancelled from here. A terminal's cannot, and sending mid-turn is a
 * steer, the delivery the daemon itself defaults to, so the button stays
 * Send while the session is eligible, even when a turn is already running.
 */

import type { SessionLiveStatus, TranscriptTailMessage } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useRef, useState } from "react";
import type { ListRenderItemInfo } from "react-native";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TuiPromptAccess, TuiSessionState } from "../console/state.ts";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

export interface TerminalSessionScreenProps {
  title: string;
  cwd: string;
  /** Current index truth. Null means the daemon no longer lists this session. */
  status: SessionLiveStatus | null;
  /** Scope truth after the daemon hello, or the stored pairing hint before it. */
  promptAccess: TuiPromptAccess;
  /** This session's served transcript tail plus the hints the console holds about it. */
  tui: TuiSessionState;
  connection: ConnectionState;
  onBack: () => void;
  onSubmit: (text: string) => void;
}

function notLiveGuidance(status: SessionLiveStatus | null): string {
  switch (status) {
    case null:
      return "The daemon no longer lists this session. Return to Sessions to refresh before trying another action.";
    case "live-tui":
      return "This session is still live in its terminal.";
    case "live-ompd":
      return "An ompd agent now owns this session, not the terminal. Return to Sessions to open its agent log.";
    case "dormant":
      return "No terminal owns this session now. Return to Sessions to resume it from its current state.";
    case "archived":
      return "This session is archived and cannot be steered. Return to Sessions to choose an available session.";
  }
}

export function TerminalSessionScreen(props: TerminalSessionScreenProps): JSX.Element {
  const { tui, connection, status, promptAccess } = props;
  // The latest index row, not the row that opened this route, decides whether
  // steering is still safe. A terminal can close while the screen remains.
  const liveTerminal = status === "live-tui";
  const tone = status === null ? signal.oxide : signal[SESSION_STATUS_SIGNALS[status]];
  const statusLabel = status === null ? "Unavailable" : STATUS_LABELS[status];
  const insets = useSafeAreaInsets();

  const [text, setText] = useState("");
  const trimmed = text.trim();
  const connected = connection === "connected";
  const composerEnabled = connected && liveTerminal && promptAccess !== "missing" && tui.refusalKind !== "scope";
  const canSend = composerEnabled && trimmed.length > 0;
  const placeholder = !connected
    ? "No link"
    : !liveTerminal
      ? "Session is not live in a terminal"
      : promptAccess === "missing" || tui.refusalKind === "scope"
        ? "Prompt scope required"
        : "Say something to this terminal";

  const submit = (): void => {
    if (!canSend) return;
    props.onSubmit(trimmed);
    setText("");
  };

  const log = useRef<FlatList<TranscriptTailMessage>>(null);
  /**
   * The tail arrives oldest first, so the newest turn is the last row, and a
   * list left at the top would show the operator the oldest of the last
   * thirty turns. Driven by content size rather than by mount, because rows
   * measure after layout and a scroll issued before that lands nowhere.
   */
  const showNewest = useCallback((): void => {
    try {
      log.current?.scrollToEnd({ animated: false });
    } catch {
      // A host with no real scroller has nothing to scroll. The tail is
      // already correct without the courtesy, so a missing scroller must not
      // take the screen down with it.
    }
  }, []);

  const renderTurn = useCallback(({ item, index }: ListRenderItemInfo<TranscriptTailMessage>): JSX.Element => {
    const mine = item.role === "user";
    // Gutter attribution rather than alternating bubbles, the same call
    // `Transcript` made: there are only ever two speakers and bubbles halve
    // the usable width on a phone.
    return (
      <View
        style={styles.turn}
        testID={`terminal-turn-${index}`}
        // A nested Body is often invisible to an accessibility query even
        // when it is on screen, so the row carries the words itself.
        accessible
        accessibilityLabel={`${mine ? "you" : "agent"}: ${item.text}`}
      >
        <View style={[styles.gutter, { borderLeftColor: mine ? ink.faint : signal.sage }]}>
          <Kicker color={mine ? ink.muted : signal.sage}>{mine ? "you" : "agent"}</Kicker>
          {item.at === "" ? null : <Kicker color={ink.faint}>{elapsed(item.at)}</Kicker>}
        </View>
        <Body color={ink.bright} style={styles.prose}>
          {item.text}
        </Body>
      </View>
    );
  }, []);

  return (
    <SafeScreen edges={{ top: true, bottom: false, left: true, right: true }} testID="terminal-session">
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Pressable
          testID="terminal-back"
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
          onPress={props.onBack}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain} testID="terminal-back-label">
            Sessions
          </Label>
        </Pressable>

        <View style={styles.ident}>
          <Title heading numberOfLines={1} testID="terminal-title">
            {props.title || "Untitled session"}
          </Title>
          <View style={styles.meta}>
            <Glyph name="folder" size={10} color={ink.faint} />
            <Label color={ink.muted} numberOfLines={1} style={styles.origin}>
              {shortenPath(props.cwd, 3)}
            </Label>
          </View>
        </View>

        <Kicker color={tone} testID="terminal-state">
          {statusLabel}
        </Kicker>
      </View>

      {tui.history.length === 0 ? null : (
        <FlatList
          ref={log}
          testID="terminal-log"
          style={styles.log}
          contentContainerStyle={styles.logContent}
          data={tui.history as TranscriptTailMessage[]}
          // Turns carry no id of their own: the daemon serves words, not
          // rows. Position plus timestamp is stable within one served tail,
          // and a new tail replaces the list wholesale anyway.
          keyExtractor={(message, index) => `${index}:${message.at}`}
          renderItem={renderTurn}
          ListHeaderComponent={
            tui.historyTruncated ? (
              <Kicker color={ink.faint} testID="terminal-log-truncated">
                Older turns are not shown
              </Kicker>
            ) : null
          }
          onContentSizeChange={showNewest}
        />
      )}

      <View style={[styles.hints, tui.history.length === 0 && styles.hintsFill]}>
        {liveTerminal ? null : (
          <View testID="terminal-not-live-tui" style={styles.refusal}>
            <View style={styles.refusalHead}>
              <Glyph name="warning" size={13} color={signal.oxide} />
              <Label color={signal.oxide}>Not a live terminal session</Label>
            </View>
            <Body color={ink.bright}>{notLiveGuidance(status)}</Body>
          </View>
        )}

        {promptAccess === "missing" || tui.refusalKind === "scope" ? (
          <View testID="terminal-scope-refusal" style={styles.refusal}>
            <View style={styles.refusalHead}>
              <Glyph name="warning" size={13} color={signal.oxide} />
              <Label color={signal.oxide}>Prompt scope required</Label>
            </View>
            <Body color={ink.bright}>
              {tui.refusalKind === "scope" && tui.refusal !== null
                ? tui.refusal
                : "This device does not hold the prompt scope. Pair it again with prompt access before steering this terminal."}
            </Body>
          </View>
        ) : null}

        {tui.refusalKind === "owner-gone" && tui.refusal !== null ? (
          <View testID="terminal-owner-gone" style={styles.refusal}>
            <View style={styles.refusalHead}>
              <Glyph name="warning" size={13} color={signal.oxide} />
              <Label color={signal.oxide}>Owning terminal is unreachable</Label>
            </View>
            <Body color={ink.bright}>{tui.refusal}</Body>
          </View>
        ) : null}

        {tui.replyUnavailable ? (
          <View testID="terminal-reply-unavailable" style={styles.refusal}>
            <View style={styles.refusalHead}>
              <Glyph name="warning" size={13} color={signal.ochre} />
              <Label color={signal.ochre}>Reply stayed in the terminal</Label>
            </View>
            <Body color={ink.bright}>
              This turn ended without readable assistant text. Its full transcript and tool output remain in the owning
              terminal.
            </Body>
          </View>
        ) : null}

        {tui.busy ? (
          <Kicker color={tone} testID="terminal-busy">
            Working in the terminal
          </Kicker>
        ) : null}

        {tui.sent === null ? null : (
          <View testID="terminal-sent">
            <Label color={ink.muted}>Sent to this terminal</Label>
            <Body color={ink.bright}>{tui.sent}</Body>
          </View>
        )}

        {tui.reply === null ? null : (
          <View testID="terminal-reply">
            <Label color={ink.muted}>Last reply</Label>
            <Body color={ink.bright}>{tui.reply}</Body>
          </View>
        )}

        {liveTerminal &&
        tui.history.length === 0 &&
        tui.refusal === null &&
        tui.sent === null &&
        tui.reply === null &&
        !tui.replyUnavailable &&
        !tui.busy ? (
          <Body color={ink.muted} testID="terminal-explainer">
            This session is live in a terminal on the machine. This phone steers it without taking ownership, and live
            progress returns here.
          </Body>
        ) : null}

        <Label color={ink.faint} testID="terminal-transcript-limit" style={styles.boundary}>
          Only recent text and live assistant replies appear here. The full transcript and tool output stay in the
          terminal.
        </Label>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={0}>
        {/*
          Home-indicator inset lives on a child, not on KeyboardAvoidingView,
          for the same reason as the agent log: KAV's padding behavior owns
          paddingBottom while the keyboard is moving.
        */}
        <View style={{ paddingBottom: insets.bottom }} testID="terminal-composer-safe">
          <View style={styles.composer}>
            <TextInput
              testID="terminal-composer-input"
              style={[styles.field, type.body, !composerEnabled && styles.fieldOff]}
              value={text}
              onChangeText={setText}
              editable={composerEnabled}
              multiline
              placeholder={placeholder}
              placeholderTextColor={ink.faint}
              // Enter sends on a keyboard; Shift+Enter is a newline. Sending
              // stays available mid-turn: a second prompt steers the running
              // turn, which is the delivery the daemon defaults to.
              submitBehavior="submit"
              onSubmitEditing={submit}
            />

            <Pressable
              testID="terminal-composer-send"
              accessibilityRole="button"
              accessibilityLabel="Send to this terminal"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={submit}
              style={({ pressed }) => [
                styles.action,
                { borderColor: canSend ? signal.sage : ground.edge },
                pressed && { backgroundColor: ground.active },
              ]}
            >
              <Glyph name="send" size={14} color={canSend ? signal.sage : ink.faint} />
              <Label color={canSend ? signal.sage : ink.faint}>Send</Label>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.heavy,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
  },
  ident: { flex: 1, gap: space.tight },
  meta: { flexDirection: "row", alignItems: "center", gap: space.tight },
  origin: { flexShrink: 1 },
  log: { flex: 1, backgroundColor: ground.base },
  logContent: { padding: space.step, gap: space.step },
  turn: { flexDirection: "row", gap: space.step },
  gutter: {
    width: 68,
    borderLeftWidth: stroke.heavy,
    paddingLeft: space.snug,
    gap: space.tight,
    alignItems: "flex-start",
  },
  prose: { flex: 1 },
  // The hints sit under the history, so they claim only what they need. With
  // no history there is nothing above them, and filling the pane is what puts
  // the explainer where the transcript would have been rather than crushing
  // it against the composer.
  hints: { gap: space.step, padding: space.step },
  hintsFill: { flex: 1 },
  refusal: { gap: space.snug, borderWidth: stroke.hair, borderColor: signal.oxide, padding: space.step },
  refusalHead: { flexDirection: "row", alignItems: "center", gap: space.tight },
  boundary: { marginTop: "auto", paddingTop: space.snug },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.snug,
    padding: space.step,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
  field: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    maxHeight: 140,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    color: ink.bright,
    backgroundColor: ground.base,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  fieldOff: { color: ink.faint },
  action: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    borderWidth: stroke.hair,
  },
});
