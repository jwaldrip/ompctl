/**
 * The one way a screen names the act it exists for.
 *
 * Two treatments used to compete for this job: a filled swatch on the
 * connections screen and an outlined ghost on the pair screen. The ghost
 * lost, because a hairline box holding quiet text is this design's text
 * field — the pair form's own inputs sit directly above it wearing the same
 * outline, and a control that reads as a field gets treated as one. The
 * filled swatch is what the rest of the app already chose for its primary
 * action (BrowseScreen, FolderPickerScreen, CoworkScreen, CloneProgress), so
 * this is that treatment, written once, plus the parked state the pair
 * form's endpoint-and-token gating needs and none of the others had.
 */

import type { JSX } from "react";
import { Pressable, type StyleProp, StyleSheet, type ViewStyle } from "react-native";
import { Title } from "./text.tsx";
import { ground, ink, signal, space, TOUCH_TARGET } from "./tokens.ts";

export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  style,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /**
   * Placement extras only: a margin, a flex share. A caller reaching for
   * this to restyle the fill is reintroducing the second treatment this
   * component exists to retire.
   */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}): JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.parked, style]}
      testID={testID}
    >
      <Title color={disabled ? ink.faint : ink.inverse}>{label}</Title>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    backgroundColor: signal.sage,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  // A filled button that cannot act keeps the shape and loses the signal:
  // the swatch drops to a raised panel and the label falls to faint, so the
  // control reads as parked rather than as gone. Removing it would hide the
  // moment the form becomes ready, which on the pair screen is the whole
  // point of watching it.
  parked: { backgroundColor: ground.raised },
});
