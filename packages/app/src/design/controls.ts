/**
 * The ghost control: a pressable that is a target without being a box.
 *
 * This exists because of one report on a phone frame. The composer's action
 * row had a paperclip, a model control, a microphone, and a send, and every
 * one of them wore a hairline border and square corners. Four cages of equal
 * weight, on a surface that also had a bordered field inside a bordered
 * container. Each element was individually defensible and the whole thing read
 * as a terminal control panel rather than as a message box.
 *
 * The fix is not "smaller borders". It is that a 44-point touch target and a
 * drawn border were never the same requirement. A finger needs the target. The
 * eye needs to be told which control is the answer, and it can only be told
 * that if the others stop shouting. So the controls that support an action are
 * ghosts: full target, rounded press state, no permanent edge, and the one
 * control that completes the action is filled.
 *
 * Kept in `design/` rather than beside the composer because both the composer
 * and the screens that hand it controls have to draw the same shape, and a
 * style exported from a component would make those screens import the
 * component to style a button.
 */

import { StyleSheet } from "react-native";
import { ground, radius, space, TOUCH_TARGET } from "./tokens.ts";

export const ghost = StyleSheet.create({
  /** Icon-only: a square target, so a row of them keeps an even rhythm. */
  icon: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  /** Icon plus a word: as tall, as round, only wider. */
  labelled: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    borderRadius: radius.control,
  },
  /** Under a finger. */
  pressed: { backgroundColor: ground.active },
  /**
   * Held on, for a control with an on state: a wash rather than a border, so
   * turning the microphone on does not change the row's silhouette.
   */
  live: { backgroundColor: ground.active },
});
