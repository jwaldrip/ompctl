/**
 * The turn that is underway, as the last row of the conversation.
 *
 * This was a badge in the header and that was the wrong place. A header says
 * what a session IS; chat says what is HAPPENING, and "the agent is working on
 * what I just sent" is a fact about the conversation, so it belongs where the
 * next agent row is about to appear: under the operator's own prompt, above the
 * composer, in the scroll rather than floating over it.
 *
 * Two rules come from omp's own TUI rather than from taste, both verified in
 * `packages/coding-agent/src/modes/controllers/event-controller.ts`:
 *
 *  - **It does not vanish when text starts arriving.** `#handleMessageUpdate`,
 *    the token handler, calls `#ensureWorkingLoaderWhileStreaming()` on every
 *    delta, and the only place the loader stops is `#finishAgentEnd`. So the
 *    indicator runs beside streaming prose for the whole turn. An indicator
 *    that disappeared at the first token would go dark exactly when a tool
 *    starts and nothing is streaming, which is the gap the report was about.
 *  - **The label follows the work.** `#updateWorkingMessageFromIntent` replaces
 *    `Working…` with the tool's own intent, so a label that changes with what
 *    is happening is the convention, not a departure from it.
 *
 * What is deliberately NOT copied is the TUI's placement in a fixed status
 * container above the prompt. Here it is a row of the log, because a phone's
 * log is scrolled and an indicator pinned outside it would sit over the
 * transcript instead of following it.
 *
 * Movement is a claim. The dots animate only while work is genuinely in
 * flight, and they stop the moment the derived state says it is not: no timer,
 * nothing decaying, no spinner kept alive by a clock after the frames stopped.
 */

import { type JSX, memo, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { rhythm } from "../design/rhythm.ts";
import { Kicker, Label } from "../design/text.tsx";
import { ground, ink, type SignalName, signal, stroke } from "../design/tokens.ts";
import type { ConversationActivity, ConversationActivityKind } from "../session/activity.ts";

/**
 * Each state's colour, from the one palette and by the meaning already
 * assigned there: amber is work in flight, ochre is held on a person. Total
 * over the kinds that can reach this row, so there is no fallback branch able
 * to give a resting state a colour it should never have had.
 */
const TONES: Record<ConversationActivityKind, SignalName> = {
  running: "amber",
  working: "amber",
  waiting: "ochre",
};

export interface ActivityRowProps {
  /** Already gated by `conversationActivity`, so this is never a resting state. */
  activity: ConversationActivity;
  /**
   * Motion seam. Left undefined in production so the real accessibility
   * setting is read once; a test supplies it to drive both branches without a
   * native module.
   */
  reduceMotion?: boolean;
  /** The gutter's word, matching the surface's own attribution vocabulary. */
  speaker?: string;
  testID?: string;
}

export const ActivityRow = memo(function ActivityRow({
  activity,
  reduceMotion,
  speaker = "agent",
  testID = "session-activity",
}: ActivityRowProps): JSX.Element {
  const tone = signal[TONES[activity.kind]];
  const systemReduceMotion = useSystemReduceMotion(reduceMotion);
  const animate = activity.live && !systemReduceMotion;

  return (
    <View
      style={styles.row}
      testID={testID}
      accessible
      // A status region, not an alert: it must not interrupt what the operator
      // is reading, and `polite` is the only level that does not. The
      // announcement is derived from state that does not change per token, so
      // a streaming turn does not re-announce.
      accessibilityLiveRegion="polite"
      accessibilityLabel={activity.announcement}
    >
      {/*
        The same gutter every other row of this conversation uses, with the
        same word: this IS the next agent row, in the only state it can be in
        before it has anything to say.
      */}
      <View style={[styles.gutter, { borderLeftColor: tone }]}>
        <Kicker color={tone}>{speaker}</Kicker>
      </View>
      <View style={styles.body}>
        {animate ? (
          <WorkingDots color={tone} />
        ) : (
          <View style={[styles.dot, { backgroundColor: tone }]} testID={`${testID}-dot`} />
        )}
        <Label color={ink.muted} numberOfLines={1} testID={`${testID}-label`}>
          {activity.label}
        </Label>
      </View>
    </View>
  );
});

/**
 * Three dots, brightening in turn.
 *
 * An interval rather than `Animated`, because what has to be provable here is
 * that motion STOPS: this component unmounts the moment `live` goes false, and
 * an interval cleared in an effect's teardown is a guarantee a driver-side
 * animation is not. Two hundred milliseconds is slow enough to read as
 * deliberate rather than as a loading spinner, which the list already owns for
 * its history page.
 */
function WorkingDots({ color }: { color: string }): JSX.Element {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setPhase(current => (current + 1) % 3);
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.dots}>
      {[0, 1, 2].map(index => (
        <View
          key={index}
          style={[styles.dot, { backgroundColor: color, opacity: index === phase ? 1 : 0.3 }]}
          testID={index === phase ? "session-activity-dot-lit" : undefined}
        />
      ))}
    </View>
  );
}

/**
 * The platform's reduce-motion setting, read once and then followed.
 *
 * An explicit prop wins, which is the seam a test drives. Production passes
 * nothing and gets the real answer; a platform without the API reports false,
 * which is the same posture the app's other capability probes take.
 */
function useSystemReduceMotion(override: boolean | undefined): boolean {
  const [enabled, setEnabled] = useState(false);
  // Read rather than depended on: an override that arrives later must not
  // cancel a subscription the component still needs if it goes away again.
  const overridden = useRef(override !== undefined);
  overridden.current = override !== undefined;
  useEffect(() => {
    if (overridden.current) return;
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled?.()
      .then(value => {
        if (alive) setEnabled(value === true);
      })
      .catch(() => {
        // No API on this platform. Motion stays on, which is the same choice
        // every other surface in this app makes when a capability is unknown.
      });
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", value => {
      setEnabled(value === true);
    });
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return override ?? enabled;
}

const styles = StyleSheet.create({
  // This IS the next agent row, so its geometry is the entry row's geometry,
  // token for token: `renderers.tsx` styles `row` and `gutter` exactly this
  // way. One point of divergence and the working row stops being the turn
  // beginning and starts being chrome that happens to be inside the list.
  //
  // It pays no gutter and no vertical inset on purpose. The list's content
  // container pays both -- `paddingHorizontal: rhythm.gutter` and
  // `gap: rhythm.rowGap` in `OmpThread.tsx`, `padding: rhythm.gutter` in
  // `TerminalSessionScreen.tsx` -- and this row renders inside it, so paying
  // again would indent the one row of the conversation that must not be
  // indented: 16 here plus 16 there is 32, and the working row would sit a
  // step right of the prompt it is answering.
  //
  // Held to one line's height so the composer does not move when the label
  // changes from a word to a phrase.
  row: { flexDirection: "row", gap: rhythm.rowGapTight, minHeight: 28, alignItems: "center" },
  gutter: {
    width: rhythm.attribution,
    borderLeftWidth: stroke.heavy,
    paddingLeft: rhythm.glyphGap,
    alignItems: "flex-start",
    alignSelf: "stretch",
    justifyContent: "center",
  },
  // The dots are the label's own indicator rather than a sibling of it, which
  // is the same relationship a glyph has to its word.
  body: { flex: 1, flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap },
  // Glyph geometry, not layout spacing: the three dots and the air between
  // them are how this one indicator is DRAWN, the same way `size={14}` draws a
  // Glyph. `rhythm` prices the space between things on screen, and pricing the
  // inside of a five-point dot off the four-point grid would round it away.
  dots: { flexDirection: "row", gap: 3 },
  dot: { width: 5, height: 5, backgroundColor: ground.edge },
});
