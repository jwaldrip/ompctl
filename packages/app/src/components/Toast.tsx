/**
 * A transient message.
 *
 * Not a modal, and deliberately not a floating layer either: an operator
 * mid-turn must never have to dismiss something before they can read their own
 * log, and a notice that paints over the transcript hides the very thing it is
 * reporting on. It occupies a band of the column above the composer, takes a
 * tap to clear, and announces itself politely rather than interrupting
 * whatever a screen reader was already saying.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet } from "react-native";
import { Label } from "../design/text.tsx";
import { ground, ink, space } from "../design/tokens.ts";

export function Toast({
  message,
  onDismiss,
  testID = "toast",
}: {
  message: string;
  onDismiss: () => void;
  /** A notice about the link reports as `toast-link` so a check can tell it from an action notice. */
  testID?: string;
}): JSX.Element {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={`${message}. Dismiss.`}
      accessibilityLiveRegion="polite"
      onPress={onDismiss}
      style={styles.toast}
    >
      <Label color={ink.bright}>{message}</Label>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  toast: {
    marginHorizontal: space.wide,
    marginBottom: space.wide,
    padding: space.step,
    backgroundColor: ground.active,
    borderLeftWidth: 2,
    borderLeftColor: ink.plain,
  },
});
