/**
 * One live terminal session, as a prompt surface.
 *
 * This is deliberately not the agent log. A session running in a terminal has
 * no agent row and no transcript this device can attach to; pretending it
 * does would render an empty log beside a composer and call that a session.
 * What the terminal does offer is thinner and still useful: the daemon
 * delivers prompts to it as the operator's own turn, and reports turn
 * progress back as hints. So this screen is a composer first, plus whatever
 * hints have arrived: sent, working, the last reply, or the daemon's refusal
 * when the terminal has no bridge.
 *
 * The composer here is not `Composer`, on purpose. That control turns its
 * send button into an interrupt while a turn runs, because an agent's turn
 * can be cancelled from here. A terminal's cannot, and sending mid-turn is a
 * steer, the delivery the daemon itself defaults to, so the button stays
 * Send and stays enabled.
 */

import type { ConnectionState } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { TuiSessionState } from "../console/state.ts";
import { shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import { SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

export interface TerminalSessionScreenProps {
  title: string;
  cwd: string;
  /** Hints the console holds about this terminal session. */
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

  const [text, setText] = useState("");
  const trimmed = text.trim();
  const connected = connection === "connected";
  const canSend = connected && trimmed.length > 0;

  const submit = (): void => {
    if (!canSend) return;
    props.onSubmit(trimmed);
    setText("");
  };

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

      <View style={styles.hints}>
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

        {tui.refusal !== null || tui.sent !== null || tui.reply !== null || tui.busy ? null : (
          <Body color={ink.muted} testID="terminal-explainer">
            This session is live in a terminal on the machine. What is sent from here is delivered to it as your own
            turn, and its progress is reported back here as it happens.
          </Body>
        )}
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
  hints: { flex: 1, gap: space.step, padding: space.step },
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
