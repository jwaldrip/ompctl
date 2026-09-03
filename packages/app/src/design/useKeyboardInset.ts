/**
 * The height the on-screen keyboard currently occupies, in points.
 *
 * Every screen whose primary control sits at the bottom needs this, and needs
 * it the same way. `KeyboardAvoidingView` was the obvious answer and it is
 * inert on an iPad: the control's frame is identical with the keyboard up and
 * down, so the send button sits behind the keyboard and neither a person nor an
 * automated run can reach it. Measuring what the platform reports and paying it
 * as padding is what actually moves the control, and it is one mechanism rather
 * than two, so nothing double counts.
 *
 * Zero on react-native-web, which has no on-screen keyboard to report, and that
 * is the correct answer there rather than a missing feature.
 */

import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const update = (event: { endCoordinates: { height: number } }) => setInset(event.endCoordinates.height);
    // iOS delivers a frame change while the input is still focused. That is the
    // event which has to move the dock before the keyboard covers it; waiting
    // for `keyboardDidShow` leaves a fixed composer under the first frame.
    const willShow = Keyboard.addListener("keyboardWillShow", update);
    const willChangeFrame = Keyboard.addListener("keyboardWillChangeFrame", update);
    const didShow = Keyboard.addListener("keyboardDidShow", update);
    const didChangeFrame = Keyboard.addListener("keyboardDidChangeFrame", update);
    const willHide = Keyboard.addListener("keyboardWillHide", () => setInset(0));
    const didHide = Keyboard.addListener("keyboardDidHide", () => setInset(0));
    return () => {
      willShow.remove();
      willChangeFrame.remove();
      didShow.remove();
      didChangeFrame.remove();
      willHide.remove();
      didHide.remove();
    };
  }, []);

  return inset;
}

/**
 * What to pay below a bottom-anchored control: the keyboard when it is up, the
 * home indicator otherwise. Never both, because a raised keyboard covers that
 * inset entirely and paying both leaves a gap the height of the indicator.
 */
export function bottomInsetFor(keyboardInset: number, safeAreaInset: number): number {
  return keyboardInset > 0 ? keyboardInset : safeAreaInset;
}
