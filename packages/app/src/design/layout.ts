/**
 * Two questions, not one.
 *
 * 1. Is this a tablet-class screen? Answered from the SHORTEST side, because
 *    that is the one number that does not change when the device rotates. A
 *    tablet held in portrait is still a tablet, and the widest phone's short
 *    side (440pt) is nowhere near the narrowest tablet's (744pt on iPad mini),
 *    so the classes separate cleanly without a table of device names.
 * 2. Is there room for the bay and a log side by side right now? That is a
 *    question about the CURRENT width, and a phone in landscape can answer yes.
 *
 * Keying the split off current width alone is what made an iPad in portrait
 * (820pt, under `SPLIT_WIDTH`) fall back to the single-pane phone layout.
 */

import { useWindowDimensions } from "react-native";

/** Width at which the bay and a log fit on screen together. */
export const SPLIT_WIDTH = 860;

/**
 * Shortest side at or above which a screen is tablet-class, in any rotation.
 * Above every phone's short side, below every tablet's.
 */
export const TABLET_MIN_SIDE = 600;

/** Widest a single column of form fields should ever get, by screen class. */
export const FORM_MAX_WIDTH = { phone: 480, tablet: 640 } as const;

export function useIsTablet(): boolean {
  const { width, height } = useWindowDimensions();
  return Math.min(width, height) >= TABLET_MIN_SIDE;
}

/**
 * A tablet always gets the two-pane layout, including portrait: it has the
 * physical room, and rotating a device should not change which panes exist.
 */
export function useSplitLayout(): boolean {
  const { width, height } = useWindowDimensions();
  return width >= SPLIT_WIDTH || Math.min(width, height) >= TABLET_MIN_SIDE;
}

/** The form cap for this screen: wider on a tablet, never full-bleed. */
export function useFormMaxWidth(): number {
  return useIsTablet() ? FORM_MAX_WIDTH.tablet : FORM_MAX_WIDTH.phone;
}
