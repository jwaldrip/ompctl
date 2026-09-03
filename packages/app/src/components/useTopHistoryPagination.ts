/**
 * Loading older history when the reader reaches the top, for every surface
 * that shows a session's log.
 *
 * There are two of those and they are not variants of each other. The owned
 * session's `Transcript` renders reducer `Entry` rows keyed by
 * `transcriptRowKey`, pages through `historyBefore`, and knows nothing about
 * terminals. `TerminalSessionScreen` renders its own `LogRow` union keyed by
 * `row.key`, pages through `tui.historyCursor`, and interleaves live hints
 * that are not history at all. Both had a manual button; only one grew the
 * automatic behaviour, and duplicating the state machine into the other is how
 * the two would drift.
 *
 * So the machine lives here and the surfaces keep their own rows. What it
 * needs from a caller is deliberately minimal and deliberately not a list: a
 * cursor to identify the page, a key identifying the current head row, and the
 * follower it should cooperate with.
 *
 * ## The five rules, and why each exists
 *
 * 1. **A page has an identity.** Dedup compares cursors, not booleans. A
 *    boolean `loading` guard reopens the moment a request settles, and a
 *    request that settled without moving the cursor is exactly the case that
 *    must stay shut.
 * 2. **An undefined cursor is a value.** `null` and `undefined` collapse to
 *    one sentinel rather than comparing unequal to everything. A bare
 *    `null !== undefined` guard never matched, so it never locked, and a
 *    callsite with no cursor re-fired on every scroll frame. Collapsed, such a
 *    caller gets one automatic page and the button after that.
 * 3. **A failure stays locked until a person asks again.** The lock is never
 *    cleared by a loading transition, only by a cursor that actually changed,
 *    which is the daemon answering with new history. A reader parked at the
 *    top of a page that keeps failing would otherwise re-fire on every frame.
 *    The button is the retry, and it is deliberate.
 * 4. **The anchor is consumed once, by a real prepend.** It is armed by
 *    whichever control started the load and released by the first content
 *    growth that ALSO moved the head row. Streaming text, a new tool card, an
 *    arriving terminal hint and a footer all grow the list without touching
 *    row zero, so they fall through and the pending anchor survives for the
 *    growth that is actually a prepend. Tying it to a loading boolean instead
 *    would let any of those consume it, and the real prepend would then land
 *    unanchored.
 * 5. **The manual control arms the anchor too.** It cannot be wired straight
 *    to the caller's `onLoadEarlier`: a manual page that skipped the anchor
 *    drops the reader wherever the prepend left them, which is the bug the
 *    automatic path exists to avoid.
 */

import { useCallback, useRef } from "react";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { Platform } from "react-native";
import type { FollowNewest, ScrollsToEnd } from "./useFollowNewest.ts";
import { isNearTop } from "./useFollowNewest.ts";

/**
 * The identity of one history page, as a value that is always comparable.
 * See rule 2: the absence of a cursor is a key, not an incomparable.
 */
export type PageKey = string;

export function pageKeyOf(cursor: number | null | undefined): PageKey {
  return cursor === null || cursor === undefined ? "unkeyed" : `c${cursor}`;
}

/**
 * The list surface this drives.
 *
 * Structural rather than `FlatList`, for the reason `ScrollsToEnd` is: a test
 * hands it a recorder. `scrollToOffset` is optional because only the Android
 * branch calls it and a recorder need not implement what it never receives.
 */
export interface PaginatedList extends ScrollsToEnd {
  scrollToOffset?(options: { offset: number; animated?: boolean }): void;
}

export interface TopHistoryPaginationOptions {
  /** Whether an older page exists to ask for. */
  canLoadEarlier: boolean;
  /** Whether one is outstanding right now. */
  loadingEarlier: boolean;
  /** The caller's own request. Undefined disables both paths entirely. */
  onLoadEarlier: (() => void) | undefined;
  /** Identifies the page on screen. See rule 1 and rule 2. */
  cursor: number | null | undefined;
  /**
   * A stable key for the current head row, in whatever key space the surface
   * already uses. This is the prepend detector, so it must be the same
   * function the list's own `keyExtractor` uses, or a prepend and a re-render
   * become indistinguishable.
   */
  headKey: string | null;
  /** The follower this cooperates with, so one list has one scroll owner. */
  follow: FollowNewest;
  /**
   * Platform seam. Left undefined in production so the real platform answers;
   * a test sets it to drive the Android anchor branch without a native module.
   */
  platformOS?: string;
}

export interface TopHistoryPagination {
  /** Spread onto the list. Composes the follower's ref with this machine's. */
  ref: (list: PaginatedList | null) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: (width: number, height: number) => void;
  scrollEventThrottle: number;
  /** The manual control's press handler. Arms the anchor; see rule 5. */
  onPressLoadEarlier: () => void;
}

export function useTopHistoryPagination(options: TopHistoryPaginationOptions): TopHistoryPagination {
  const { canLoadEarlier, loadingEarlier, onLoadEarlier, cursor, headKey, follow } = options;
  const platformOS = options.platformOS ?? Platform.OS;

  const listRef = useRef<PaginatedList | null>(null);
  /** The page an automatic request has already been fired for. See rule 3. */
  const requestedPage = useRef<PageKey | null>(null);
  /** Read by callbacks that run after commit, so they see the head this render has. */
  const headKeyRef = useRef<string | null>(headKey);
  headKeyRef.current = headKey;
  const pendingAnchor = useRef<{ headKeyAtRequest: string | null } | null>(null);
  const lastScrollY = useRef(0);
  const prevContentHeight = useRef(0);

  const pageKey = pageKeyOf(cursor);

  const startLoad = useCallback(() => {
    if (onLoadEarlier === undefined) return;
    requestedPage.current = pageKey;
    pendingAnchor.current = { headKeyAtRequest: headKeyRef.current };
    onLoadEarlier();
  }, [onLoadEarlier, pageKey]);

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      follow.onScroll(event);
      const offsetY = event.nativeEvent.contentOffset.y;
      lastScrollY.current = offsetY;
      if (!isNearTop(offsetY)) return;
      if (!canLoadEarlier || onLoadEarlier === undefined || loadingEarlier) return;
      // The whole dedup: this page has already been asked for automatically.
      if (requestedPage.current === pageKey) return;
      startLoad();
    },
    [follow, canLoadEarlier, onLoadEarlier, loadingEarlier, pageKey, startLoad],
  );

  const onPressLoadEarlier = useCallback(() => {
    if (loadingEarlier) return;
    startLoad();
  }, [loadingEarlier, startLoad]);

  const ref = useCallback(
    (list: PaginatedList | null) => {
      listRef.current = list;
      follow.ref(list);
    },
    [follow],
  );

  const onContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const previous = prevContentHeight.current;
      prevContentHeight.current = height;

      const pending = pendingAnchor.current;
      // Rule 4: only growth that moved the head is a prepend.
      if (pending !== null && headKeyRef.current !== pending.headKeyAtRequest) {
        pendingAnchor.current = null;
        // iOS holds the reader natively through
        // `maintainVisibleContentPosition`; adjusting there would move them
        // twice. Android has no such support, so the offset is restored by
        // hand from the growth this callback just measured.
        if (platformOS === "android" && previous > 0 && height > previous) {
          listRef.current?.scrollToOffset?.({ offset: lastScrollY.current + (height - previous), animated: false });
        }
      }

      follow.onContentSizeChange();
    },
    [follow, platformOS],
  );

  return { ref, onScroll, onContentSizeChange, scrollEventThrottle: follow.scrollEventThrottle, onPressLoadEarlier };
}

/**
 * What both lists pass to `maintainVisibleContentPosition`.
 *
 * `minIndexForVisible` alone, and never `autoscrollToTopThreshold`. That option
 * is the opposite of what history wants: it tells the list to jump to the very
 * top when content is inserted above and the reader is already near it, which
 * is exactly the state an auto-load happens in. It was throwing the reader onto
 * the newly inserted oldest row instead of holding their place.
 *
 * Shared as a value so the two surfaces cannot drift on it, and so the reason
 * lives once.
 */
export const MAINTAIN_VISIBLE_CONTENT_POSITION = { minIndexForVisible: 0 } as const;
