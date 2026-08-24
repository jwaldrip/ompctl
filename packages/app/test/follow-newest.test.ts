/**
 * The four cases a transcript's scroll behaviour has to get right, and a gate
 * so neither surface grows its own version again.
 *
 * These are asserted against the decision rather than against a rendered
 * list, because the test harness renders react-native-web into happy-dom,
 * where a list reports no scroll offset and `scrollToEnd` is not a real
 * scroller. Driving the hook's own inputs is the difference between proving
 * the rule and proving that a mock was called.
 */

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import {
  createFollower,
  type FollowNewest,
  isNearBottom,
  NEAR_BOTTOM_SLACK,
} from "../src/components/useFollowNewest.ts";

/**
 * One scroll event's worth of geometry, in the shape react-native reports it.
 * Only the three fields the hook reads are filled: inventing the rest would
 * suggest the hook depends on them.
 */
function scrollTo(
  offset: number,
  contentHeight: number,
  viewportHeight: number,
): NativeSyntheticEvent<NativeScrollEvent> {
  return {
    nativeEvent: {
      contentOffset: { x: 0, y: offset },
      contentSize: { width: 0, height: contentHeight },
      layoutMeasurement: { width: 0, height: viewportHeight },
    },
  } as NativeSyntheticEvent<NativeScrollEvent>;
}

/**
 * A follower plus a recorder for the one call it makes.
 *
 * `createFollower` rather than the hook, deliberately: a hook cannot be called
 * outside a component, and rendering a host component to reach one would put a
 * renderer between the assertion and the rule.
 */
function follower(): { follow: FollowNewest; ends: number } {
  const state = { ends: 0 };
  const follow = createFollower();
  follow.ref({
    scrollToEnd: () => {
      state.ends += 1;
    },
  });
  return {
    follow,
    get ends() {
      return state.ends;
    },
  };
}

describe("isNearBottom", () => {
  test("a list shorter than its viewport is always at its end", () => {
    // The arithmetic would otherwise answer with a negative floor, and a
    // transcript with two entries must still follow the third.
    expect(isNearBottom(0, 200, 800)).toBe(true);
  });

  test("resting a hair short of the maximum offset still counts as the bottom", () => {
    // Momentum settles a pixel or two short and the keyboard's inset moves the
    // floor while it opens, so an exact comparison would stop following for
    // reasons the operator cannot see.
    expect(isNearBottom(2000 - 800 - NEAR_BOTTOM_SLACK, 2000, 800)).toBe(true);
    expect(isNearBottom(2000 - 800, 2000, 800)).toBe(true);
  });

  test("a screenful up from the end is not the bottom", () => {
    expect(isNearBottom(400, 2000, 800)).toBe(false);
  });
});

describe("following the newest entry", () => {
  test("a freshly loaded transcript lands on its newest entry", () => {
    const f = follower();
    f.follow.onContentSizeChange();
    expect(f.ends).toBe(1);
  });

  test("an arriving entry follows while the operator sits at the bottom", () => {
    const f = follower();
    f.follow.onContentSizeChange();
    f.follow.onScroll(scrollTo(1200, 2000, 800));
    f.follow.onContentSizeChange();
    expect(f.ends).toBe(2);
  });

  test("an arriving entry leaves the view alone while the operator reads history", () => {
    const f = follower();
    f.follow.onContentSizeChange();
    // Scrolled well up: a streaming turn must not yank the row being read.
    f.follow.onScroll(scrollTo(200, 2000, 800));
    f.follow.onContentSizeChange();
    expect(f.ends).toBe(1);
  });

  test("a Load earlier prepend does not jump to the bottom", () => {
    const f = follower();
    f.follow.onContentSizeChange();
    // The control sits at the head of the list, so reaching it means scrolling
    // away from the bottom first. The older page then grows the content.
    f.follow.onScroll(scrollTo(0, 2000, 800));
    f.follow.onContentSizeChange();
    expect(f.ends).toBe(1);
  });

  test("a remounted surface pins again rather than inheriting a reading position", () => {
    const f = follower();
    f.follow.onContentSizeChange();
    f.follow.onScroll(scrollTo(0, 2000, 800));
    f.follow.ref(null);
    const reattached = follower();
    reattached.follow.onContentSizeChange();
    expect(reattached.ends).toBe(1);
  });
});

describe("one notion of follow", () => {
  test("no list drives its own scroll instead of the shared hook", async () => {
    // Both surfaces had half of this wrong independently, which is what a
    // second hand-rolled copy would reintroduce.
    const offenders: string[] = [];
    for await (const file of new Glob("src/**/*.tsx").scan({ cwd: `${import.meta.dir}/..` })) {
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
      if (source.includes("scrollToEnd")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
