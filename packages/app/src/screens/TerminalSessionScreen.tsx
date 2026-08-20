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
 * Send and stays enabled.
 */

import type { TranscriptTailMessage } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useRef, useState } from "react";
import type { ListRenderItemInfo } from "react-native";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TuiSessionState } from "../console/state.ts";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { bottomInsetFor, useKeyboardInset } from "../design/useKeyboardInset.ts";
import { SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

export interface TerminalSessionScreenProps {
  title: string;
  cwd: string;
  /** This session's served transcript tail plus the hints the console holds about it. */
  tui: TuiSessionState;
  connection: ConnectionState;
  onBack: () => void;
  onSubmit: (text: string) => void;
}

export function TerminalSessionScreen(props: TerminalSessionScreenProps): JSX.Element {
  const { tui, connection } = props;
  // The row vocabulary is the one status vocabulary the contract produces;
  // this screen paints the same colour the fleet row carries.
  const tone = signal[SESSION_STATUS_SIGNALS["live-tui"]];
  const insets = useSafeAreaInsets();
  // The same mechanism the agent log uses: KeyboardAvoidingView is inert on an
  // iPad, so the keyboard's measured height is paid as padding instead.
  const keyboardInset = useKeyboardInset();

  const [text, setText] = useState("");
  const trimmed = text.trim();
  const connected = connection === "connected";
  const canSend = connected && trimmed.length > 0;

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
          {STATUS_LABELS["live-tui"]}
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
        {tui.refusal === null ? null : (
          <View testID="terminal-refusal" style={styles.refusal}>
            <View style={styles.refusalHead}>
              <Glyph name="warning" size={13} color={signal.oxide} />
              <Label color={signal.oxide}>No bridge to this terminal</Label>
            </View>
            <Body color={ink.bright}>{tui.refusal}</Body>
          </View>
        )}

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

        {/*
          The explainer exists for a surface with nothing on it: served
          history, a hint, or a turn in flight all mean the operator can see
          what this screen is, and repeating the introduction underneath a
          transcript is noise.
        */}
        {tui.history.length > 0 ||
        tui.refusal !== null ||
        tui.sent !== null ||
        tui.reply !== null ||
        tui.busy ? null : (
          <Body color={ink.muted} testID="terminal-explainer">
            This session is live in a terminal on the machine. What is sent from here is delivered to it as your own
            turn, and its progress is reported back here as it happens.
          </Body>
        )}
      </View>

      {/*
        Below the composer sits either the keyboard or the home indicator,
        never both. This was a KeyboardAvoidingView, which does nothing on an
        iPad: the send control's frame is identical with the keyboard up and
        down, so the control sits behind the keyboard and nobody can press it.
      */}
      <View style={{ paddingBottom: bottomInsetFor(keyboardInset, insets.bottom) }} testID="terminal-composer-safe">
        <View style={styles.composer}>
          <TextInput
            testID="terminal-composer-input"
            style={[styles.field, type.body, !connected && styles.fieldOff]}
            value={text}
            onChangeText={setText}
            editable={connected}
            multiline
            placeholder={connected ? "Say something to this terminal" : "No link"}
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
