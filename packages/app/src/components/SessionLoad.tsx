/**
 * What a detail pane shows before it has the session it opened.
 *
 * Two states, and the difference between them is the whole point. A pane that
 * is waiting says so under the name of the session it is waiting for, which is
 * what makes a row press feel like it landed: the operator sees the session
 * they touched, not the one they left. A pane whose open was refused says the
 * daemon's own words, under the same name, and never falls back to the session
 * that was there before -- restoring the previous log would tell them the tap
 * did nothing when in fact it was answered with a no.
 *
 * Neither is the transcript's empty state. `Nothing on this strip yet` is a
 * claim about a session that has arrived and has no turns, and a pane that
 * showed it while still waiting would be reporting an absence it has not
 * verified. That confusion is exactly what this component exists to end.
 */

import type { ConnectionState } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export interface SessionLoadingProps {
  /** The session being waited for, named so the pane is visibly its own. */
  title: string;
  testID?: string;
}

export function SessionLoading({ title, testID = "session-loading" }: SessionLoadingProps): JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={`Loading ${title}`}
      accessibilityRole="progressbar"
      style={styles.panel}
      testID={testID}
    >
      <Glyph name="activity" size={22} color={signal.amber} />
      <Kicker color={signal.amber}>Loading</Kicker>
      <Body color={ink.bright} numberOfLines={2} testID={`${testID}-title`}>
        {title}
      </Body>
      {/*
        The skeleton is three rules where turns will be, not a spinner alone:
        it says what is about to appear and where, so the pane reads as this
        session arriving rather than as an app thinking about something.
      */}
      <View style={styles.skeleton}>
        <View style={[styles.bar, styles.barWide]} />
        <View style={[styles.bar, styles.barMid]} />
        <View style={[styles.bar, styles.barNarrow]} />
      </View>
    </View>
  );
}

export interface SessionLoadFailedProps {
  /** The session whose open was refused. */
  title: string;
  /** The daemon's own words. Never paraphrased: the operator acts on them. */
  message: string;
  onRetry?: () => void;
  testID?: string;
}

export function SessionLoadFailed({
  title,
  message,
  onRetry,
  testID = "session-load-failed",
}: SessionLoadFailedProps): JSX.Element {
  return (
    <View
      accessible
      accessibilityLabel={`${title} could not be opened. ${message}`}
      style={styles.panel}
      testID={testID}
    >
      <Glyph name="warning" size={22} color={signal.oxide} />
      <Kicker color={signal.oxide}>Could not open</Kicker>
      <Body color={ink.bright} numberOfLines={2} testID={`${testID}-title`}>
        {title}
      </Body>
      <Label color={ink.plain} testID={`${testID}-message`}>
        {message}
      </Label>
      {onRetry === undefined ? null : (
        <Pressable
          accessibilityLabel="Retry loading history"
          accessibilityRole="button"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryButton, pressed && { backgroundColor: ground.active }]}
          testID={`${testID}-retry`}
        >
          <Glyph color={signal.amber} name="resume" size={13} />
          <Label color={ink.bright}>Retry</Label>
        </Pressable>
      )}
    </View>
  );
}

export interface SessionLoadStalledProps {
  /** The session whose answer was lost with the socket. */
  title: string;
  /** The link's own state, so the band says whether recovery is under way. */
  connection: ConnectionState;
  testID?: string;
}

/**
 * The link went down before this session arrived.
 *
 * Neither the refusal band nor the skeleton, because it is neither: no verdict
 * was reached, and no answer is on its way on the socket that was asked. The
 * distinction belongs to the operator -- "could not open" is something they
 * have to act on, and this is something the reconnect is already acting on.
 * Wearing the refusal band for a flap is how an operator learns to ignore the
 * one that means it.
 */
export function SessionLoadStalled({
  title,
  connection,
  testID = "session-load-stalled",
}: SessionLoadStalledProps): JSX.Element {
  const detail =
    connection === "connecting" || connection === "reconnecting"
      ? "Reconnecting, then asking again."
      : connection === "connected"
        ? "The link is back. Open this row again to ask."
        : "No link. This session is asked for again as soon as there is one.";
  return (
    <View accessible accessibilityLabel={`${title} did not arrive: ${detail}`} style={styles.panel} testID={testID}>
      <Glyph name="link" size={22} color={signal.slate} />
      <Kicker color={signal.slate}>Link lost</Kicker>
      <Body color={ink.bright} numberOfLines={2} testID={`${testID}-title`}>
        {title}
      </Body>
      <Label color={ink.plain} testID={`${testID}-detail`}>
        {detail}
      </Label>
    </View>
  );
}

const styles = StyleSheet.create({
  // All three states wear one panel. The gutter is the screen's, so a pane
  // that is still waiting is inset exactly as far as the transcript that
  // replaces it: this was 32 all round, the widest inset in the app, and the
  // session name jumped left the moment the log arrived.
  //
  // `sectionGap` vertically, because the glyph, the state word, the session
  // name and the skeleton are four different kinds of thing rather than a run
  // of rows.
  panel: {
    alignItems: "center",
    backgroundColor: ground.base,
    flex: 1,
    gap: rhythm.rowGap,
    justifyContent: "center",
    paddingHorizontal: rhythm.gutter,
    paddingVertical: rhythm.sectionGap,
  },
  skeleton: { alignSelf: "stretch", gap: rhythm.rowGapTight, marginTop: rhythm.rowGap },
  bar: { backgroundColor: ground.raised, borderBottomWidth: stroke.hair, borderBottomColor: ground.line, height: 14 },
  barWide: { width: "100%" },
  barMid: { width: "78%" },
  barNarrow: { width: "46%" },
  retryButton: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    marginTop: space.snug,
  },
});
