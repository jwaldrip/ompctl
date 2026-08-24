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

import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";

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
  testID?: string;
}

export function SessionLoadFailed({
  title,
  message,
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
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    alignItems: "center",
    backgroundColor: ground.base,
    flex: 1,
    gap: space.step,
    justifyContent: "center",
    padding: space.gulf,
  },
  skeleton: { alignSelf: "stretch", gap: space.snug, marginTop: space.step },
  bar: { backgroundColor: ground.raised, borderBottomWidth: stroke.hair, borderBottomColor: ground.line, height: 14 },
  barWide: { width: "100%" },
  barMid: { width: "78%" },
  barNarrow: { width: "46%" },
});
