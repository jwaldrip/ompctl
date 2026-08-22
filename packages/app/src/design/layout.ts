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

// ---------------------------------------------------------------------------
// The fleet bay's width when the split is on
// ---------------------------------------------------------------------------

/**
 * The fraction of the window the fleet bay asks for on a split screen: two
 * fifths. The bay is the list an operator scans while the log pane beside it
 * holds a conversation, and the log keeps the larger share because code
 * blocks and diffs are the widest things either pane shows.
 */
export const SPLIT_BAY_FRACTION = 0.4;

/**
 * The bay's floor, and why 400: the bay's own chrome must fit whole. The
 * sort bar measures 382 points at the default type size
 * (`SORT_BAR_CONTENT_WIDTH` in components/SortBar.tsx), so the floor is the
 * next four-point step with room to spare, and
 * `test/no-hidden-content.test.ts` pins the relationship. A window whose
 * two fifths fall short of this (an iPad mini in portrait) still grants it,
 * because a column label cut at the pane edge is worse than a narrower log.
 * At accessibility type sizes the bar can outgrow even this floor, and then
 * it scrolls rather than clips.
 */
export const SPLIT_BAY_MIN = 400;

/**
 * The bay's ceiling, because a react-native-web window has no natural
 * maximum width: past 560 the bay is dead air beside short titles while the
 * log pane starves, so the fraction stops applying and the log takes the
 * remainder.
 */
export const SPLIT_BAY_MAX = 560;

/**
 * The bay's width for a window `width` points wide: the fraction, clamped to
 * the floor and the ceiling. Pure, so a test can walk it across every screen
 * class without rendering.
 */
export function splitBayWidth(width: number): number {
  return Math.min(SPLIT_BAY_MAX, Math.max(SPLIT_BAY_MIN, Math.round(width * SPLIT_BAY_FRACTION)));
}

/** The fleet bay's width for the current window. Read only when the split is on. */
export function useSplitBayWidth(): number {
  return splitBayWidth(useWindowDimensions().width);
}
