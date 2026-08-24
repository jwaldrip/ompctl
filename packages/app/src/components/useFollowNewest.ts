/**
 * Keeping a transcript pinned to its newest entry, without stealing the view
 * from someone reading history.
 *
 * Two surfaces render a session's log and each had half of this wrong. The
 * owned-session transcript had no follow at all, so opening a session left the
 * operator at the top of whatever window had loaded, which is not where the
 * conversation is. The terminal log had the opposite: an unconditional
 * `scrollToEnd` on every content-size change, which is correct for an arriving
 * turn and wrong for a `Load earlier` prepend, because a prepend also changes
 * content size and the jump lands the operator at the bottom of the history
 * they just asked for.
 *
 * So follow is conditional on where the operator already is:
 *
 * - The first paint pins to the newest entry. There is no reading position to
 *   protect yet, and the newest entry is what the surface is for.
 * - A later growth follows only while the operator is near the bottom. Someone
 *   sitting at the newest row wants the next row; someone who scrolled up to
 *   read does not, and moving them is the behaviour that makes a transcript
 *   feel untrustworthy.
 * - A prepend needs no special case, which is the point of keying on position
 *   rather than on what changed: `Load earlier` sits at the head of the list,
 *   so pressing it means scrolling away from the bottom first, and near-bottom
 *   is already false by the time the older page arrives.
 *
 * `maintainVisibleContentPosition` was the alternative and is not used: it is
 * unimplemented on react-native-web, which compiles this same source, so it
 * would fix the phone and silently do nothing on the web build. An inverted
 * list was the other, and it inverts every layout decision above this file
 * (headers become footers, the keyboard inset flips) to buy a default this
 * hook provides in one place.
 *
 * The decision lives in `createFollower`, which is plain state and no React.
 * That is what lets the rules be asserted directly: a hook cannot be called
 * outside a component, and rendering a list to reach it would put a renderer
 * between the assertion and the rule, in a harness where no list scrolls.
 */

import { useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/**
 * How close to the end still counts as being at the end, in points.
 *
 * Not zero: a list rarely rests exactly at its maximum offset. Momentum
 * settles a pixel or two short, a row's own padding lands mid-point, and the
 * keyboard's inset animation moves the floor while it opens. A screenful would
 * be too generous, since it would follow while a whole entry the operator is
 * reading is still on screen.
 */
export const NEAR_BOTTOM_SLACK = 48;

/**
 * How close to the start still counts as being near the top, in points.
 * Used for auto-loading transcript history when user scrolls near the beginning.
 */
export const NEAR_TOP_SLACK = 48;

/** How often a list reports scrolling. Frequent enough to notice a thumb leaving the bottom. */
export const SCROLL_EVENT_THROTTLE_MS = 100;

/**
 * Whether a scroll position counts as the end of the list.
 *
 * Pure and exported so the cases this exists for are asserted directly rather
 * than inferred from a rendered list, which reports no scroll offset in the
 * test harness.
 */

/**
 * Whether a scroll position counts as being near the top of the list.
 * Used to trigger auto-loading of older transcript messages.
 */
export function isNearTop(offset: number): boolean {
  return offset <= NEAR_TOP_SLACK;
}
export function isNearBottom(offset: number, contentLength: number, viewportLength: number): boolean {
  // A list shorter than its viewport has its end on screen by definition, and
  // the arithmetic below would answer with a negative floor.
  if (contentLength <= viewportLength) return true;
  return offset >= contentLength - viewportLength - NEAR_BOTTOM_SLACK;
}

/**
 * The slice of a list this drives.
 *
 * Structural rather than `FlatList`, so a test can hand it a recorder. It
 * names only `scrollToEnd`, because that is all that is called: an earlier
 * version also declared `props.data`, which no code here reads and which a
 * real `FlatList` does not satisfy, since its data is an `ArrayLike` rather
 * than an array.
 */
export interface ScrollsToEnd {
  scrollToEnd(options?: { animated?: boolean }): void;
}

/** What a list spreads onto itself to follow its newest entry. */
export interface FollowNewest {
  ref: (list: ScrollsToEnd | null) => void;
  onContentSizeChange: () => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  scrollEventThrottle: number;
}

/**
 * The follow decision, as ordinary state.
 *
 * One per surface, held across renders by the hook below. Everything a caller
 * needs is bound here rather than recreated per render, so the handlers keep
 * stable identities without a memo.
 */
export function createFollower(): FollowNewest {
  let list: ScrollsToEnd | null = null;
  let painted = false;
  let nearBottom = true;

  return {
    ref: (next: ScrollsToEnd | null): void => {
      list = next;
      // A remount is a fresh surface: the next paint pins again rather than
      // inheriting a reading position from the list that just went away.
      if (next === null) painted = false;
    },

    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      nearBottom = isNearBottom(contentOffset.y, contentSize.height, layoutMeasurement.height);
    },

    onContentSizeChange: (): void => {
      // The first paint has no reading position to protect; every later growth
      // follows only from the bottom, which is what leaves a prepend alone.
      if (painted && !nearBottom) return;
      painted = true;
      try {
        // Never animated. This runs on the first paint and on every arriving
        // entry of a streaming turn, where an animation would be a permanent
        // slide rather than a transition.
        list?.scrollToEnd({ animated: false });
      } catch {
        // A host with no real scroller has nothing to scroll, and the newest
        // entry is already the last thing drawn. A missing scroller must not
        // take the surface down with it.
      }
    },

    scrollEventThrottle: SCROLL_EVENT_THROTTLE_MS,
  };
}

/** One follower per mounted surface, kept across its renders. */
export function useFollowNewest(): FollowNewest {
  const follower = useRef<FollowNewest | null>(null);
  follower.current ??= createFollower();
  return follower.current;
}
