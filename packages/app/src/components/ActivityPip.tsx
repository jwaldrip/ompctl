/**
 * The session's activity, in the header, always.
 *
 * Compact enough to sit beside the state kicker on a phone and never wide
 * enough to push the identity around: the dot is fixed, and the label sits in
 * a box whose width does not change with its text, because a header that
 * reflows every time a tool starts is a header an operator learns to ignore.
 *
 * Movement is a claim. The dots animate only while work is genuinely in
 * flight, and they stop the moment the derived state says it is not -- there is
 * no timer here and nothing decays. A pulse that keeps going because a frame
 * stopped arriving is precisely the defect this replaces.
 *
 * Announcements are deduplicated by label. A streaming turn re-renders this
 * component on every token and every tool frame, and a live region that
 * re-announced each of those would make VoiceOver unusable; it speaks when the
 * label actually changes and stays silent otherwise.
 */

import { type JSX, memo, useEffect, useRef, useState } from "react";
import { AccessibilityInfo, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { type SignalName, signal, signalWash, space } from "../design/tokens.ts";
import type { SessionActivity, SessionActivityKind } from "../session/activity.ts";

/**
 * Each state's colour, from the one palette and by the meaning already
 * assigned there: amber is work in flight, ochre is held on something that is
 * not an error, sage is ready, oxide is failed, slate is cold or unreachable.
 */
const TONES: Record<SessionActivityKind, SignalName> = {
  offline: "slate",
  linking: "slate",
  failed: "oxide",
  waiting: "ochre",
  running: "amber",
  working: "amber",
  stopped: "slate",
  ready: "sage",
};

export interface ActivityPipProps {
  activity: SessionActivity;
  /** Hide the label and keep the dot, where a header has no room for words. */
  compact?: boolean;
  /**
   * Motion seam. Left undefined in production so the real accessibility
   * setting is read once; a test supplies it to drive both branches without a
   * native module.
   */
  reduceMotion?: boolean;
  testID?: string;
}

export const ActivityPip = memo(function ActivityPip({
  activity,
  compact = false,
  reduceMotion,
  testID = "session-activity",
}: ActivityPipProps): JSX.Element {
  const tone = signal[TONES[activity.kind]];
  const systemReduceMotion = useSystemReduceMotion(reduceMotion);
  const animate = activity.live && !systemReduceMotion;

  return (
    <View
      accessibilityLabel={activity.announcement}
      // A status region, not an alert: it must not interrupt what the operator
      // is reading, and `polite` is the only level that does not.
      accessibilityLiveRegion="polite"
      accessible
      style={[styles.pip, { backgroundColor: signalWash[TONES[activity.kind]] }]}
      testID={testID}
    >
      {animate ? (
        <WorkingDots color={tone} />
      ) : (
        <View style={[styles.dot, { backgroundColor: tone }]} testID={`${testID}-dot`} />
      )}
      {compact ? null : (
        <Label color={tone} numberOfLines={1} testID={`${testID}-label`}>
          {activity.label}
        </Label>
      )}
      {/*
        The reason a stalled pane is not simply "no link": the glyph says the
        claim is about the transport, so the word beside it can stay short.
      */}
      {activity.kind === "offline" || activity.kind === "linking" ? <Glyph name="link" size={10} color={tone} /> : null}
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
 * deliberate rather than as a loading spinner, which the transcript already
 * owns.
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
  pip: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.tight,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    // A floor rather than a width: the label's own box is what holds the
    // layout still, and a wider word simply fills the space already reserved.
    minWidth: 96,
  },
  dots: { flexDirection: "row", gap: 3 },
  dot: { width: 5, height: 5 },
});
