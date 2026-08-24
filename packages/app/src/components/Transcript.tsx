/**
 * The running log for one agent.
 *
 * A `FlatList` rather than a mapped `ScrollView`, because a long session runs to
 * thousands of entries and every one of them stays mounted in the naive form.
 * The reducer already gives each entry a stable id and shares by reference for
 * anything that did not change, so the list's own row memoisation actually
 * holds and a streaming token repaints one row.
 *
 * Speaker attribution is a left gutter rather than a bubble. Chat bubbles put
 * the message on alternating sides, which halves the usable width on a phone
 * and buys nothing here: there are only ever two speakers and one of them is
 * the person holding the device.
 */

import type { ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import type { JSX } from "react";
import { useCallback, useRef } from "react";
import type { ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { ActivityIndicator, FlatList, Platform, Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Code, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";
import { type Entry, transcriptRowKey } from "../session/model.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { RichText } from "./rich/RichText.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { isNearTop, useFollowNewest } from "./useFollowNewest.ts";

/**
 * The identity of one history page, as a value that is always comparable.
 *
 * A cursor of `null` or `undefined` collapses to a single key rather than
 * comparing unequal to everything, which is what a bare `null !== undefined`
 * guard did: it never matched, so it never locked, and a callsite with no
 * cursor re-fired on every scroll frame. Collapsed, such a callsite gets one
 * automatic page and the button after that, which is a smaller loss than a
 * request storm and is stated in `TranscriptProps`.
 */
type PageKey = string;

function pageKeyOf(cursor: number | null | undefined): PageKey {
  return cursor === null || cursor === undefined ? "unkeyed" : `c${cursor}`;
}

export interface TranscriptProps {
  entries: readonly Entry[];
  canApprove: boolean;
  /** Why approval is refused, when the daemon has said so. */
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  /** The daemon's prose summary of the last settled turn, when there is one. */
  spoken?: string | null;
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  /**
   * The cursor identifying the page currently on screen, which is what makes
   * "this page was already asked for" answerable. A callsite that cannot
   * report one still works, at the cost of a single automatic page: see
   * `pageKeyOf`.
   */
  historyCursor?: number | null;
}

export function Transcript({
  entries,
  canApprove,
  refusal,
  onDecide,
  spoken,
  canLoadEarlier,
  loadingEarlier,
  onLoadEarlier,
  historyCursor,
}: TranscriptProps): JSX.Element {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Entry>) => (
      <EntryRow entry={item} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />
    ),
    [canApprove, refusal, onDecide],
  );

  // Opening a session lands on the newest entry, and a streaming turn keeps
  // it there, unless the operator has scrolled up to read.
  const follow = useFollowNewest();
  const listRef = useRef<FlatList | null>(null);

  /**
   * The page an automatic request has already been fired for.
   *
   * Deliberately never cleared by a loading transition. A request that fails
   * and leaves the cursor where it was must stay locked, or the operator
   * sitting at the top re-fires the same failing page on every scroll frame.
   * Only a page key that actually changed -- which is the daemon answering
   * with new history -- unlocks the next automatic page. The button is the
   * deliberate retry.
   */
  const requestedPage = useRef<PageKey | null>(null);

  /**
   * The head row key as of this render, read by `onContentSizeChange`, which
   * runs after commit and therefore sees the entries the prepend delivered.
   */
  const headKey = entries.length > 0 ? transcriptRowKey(entries[0] as Entry) : null;
  const headKeyRef = useRef<string | null>(headKey);
  headKeyRef.current = headKey;

  /**
   * A load whose prepend has not been observed yet, and the head it was
   * requested against.
   *
   * Armed by whichever control started the load, auto or manual, and consumed
   * exactly once, by the first content growth that also moved the head. Tying
   * it to the head rather than to a loading boolean is what keeps it correct:
   * the order of a parent's rerender against the list's layout callback is
   * not something this component can observe, but "the first row is a
   * different row now" is.
   */
  const pendingAnchor = useRef<{ headKeyAtRequest: string | null } | null>(null);
  const lastScrollY = useRef<number>(0);
  const prevContentHeight = useRef<number>(0);

  const pageKey = pageKeyOf(historyCursor);

  const startLoad = useCallback(() => {
    if (onLoadEarlier === undefined) return;
    requestedPage.current = pageKey;
    pendingAnchor.current = { headKeyAtRequest: headKeyRef.current };
    onLoadEarlier();
  }, [onLoadEarlier, pageKey]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      follow.onScroll(event);
      const offsetY = event.nativeEvent.contentOffset.y;
      lastScrollY.current = offsetY;
      if (!isNearTop(offsetY)) return;
      if (canLoadEarlier !== true || onLoadEarlier === undefined || loadingEarlier === true) return;
      // The whole dedup: this page has already been asked for automatically.
      if (requestedPage.current === pageKey) return;
      startLoad();
    },
    [follow, canLoadEarlier, onLoadEarlier, loadingEarlier, pageKey, startLoad],
  );

  /**
   * The button is a deliberate act, so it fires whatever the guard says. It
   * arms the anchor exactly as the automatic path does, which is why it
   * cannot be wired straight to `onLoadEarlier`: a manual page that skipped
   * the anchor would drop the reader wherever the prepend left them.
   */
  const handleLoadEarlierPress = useCallback(() => {
    if (loadingEarlier === true) return;
    startLoad();
  }, [loadingEarlier, startLoad]);

  const setListRef = useCallback(
    (list: FlatList | null) => {
      listRef.current = list;
      follow.ref(list);
    },
    [follow],
  );

  const handleContentSizeChange = useCallback(
    (_width: number, height: number) => {
      const previous = prevContentHeight.current;
      prevContentHeight.current = height;

      const pending = pendingAnchor.current;
      // A prepend is the only growth that moves the head. Streaming text, a
      // new tool card and a footer all grow the list without touching row
      // zero, so they fall out here and the wait survives for the real one.
      if (pending !== null && headKeyRef.current !== pending.headKeyAtRequest) {
        pendingAnchor.current = null;
        // iOS keeps the reader in place natively through
        // `maintainVisibleContentPosition`; adjusting again there would move
        // them twice.
        if (Platform.OS === "android" && previous > 0 && height > previous) {
          listRef.current?.scrollToOffset({ offset: lastScrollY.current + (height - previous), animated: false });
        }
      }

      follow.onContentSizeChange();
    },
    [follow],
  );

  return (
    <FlatList
      testID="transcript"
      ref={setListRef}
      style={styles.list}
      data={entries as Entry[]}
      keyExtractor={transcriptRowKey}
      renderItem={renderItem}
      onScroll={handleScroll}
      onContentSizeChange={handleContentSizeChange}
      scrollEventThrottle={follow.scrollEventThrottle}
      // `minIndexForVisible` alone. `autoscrollToTopThreshold` is the opposite
      // of what history wants: it tells the list to jump to the very top when
      // content is inserted above and the reader is already near it, which is
      // exactly the state an auto-load happens in. It was throwing the reader
      // onto the newly inserted oldest row instead of holding their place.
      maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      automaticallyAdjustKeyboardInsets
      ListHeaderComponent={
        canLoadEarlier && onLoadEarlier !== undefined ? (
          <View style={styles.header}>
            {loadingEarlier && <ActivityIndicator size="small" />}
            <Pressable
              testID="history-load-earlier"
              accessibilityRole="button"
              accessibilityLabel="Load earlier transcript entries"
              disabled={loadingEarlier}
              onPress={handleLoadEarlierPress}
              style={({ pressed }) => [styles.earlier, pressed && { backgroundColor: ground.active }]}
            >
              <Glyph name="resume" size={11} color={ink.muted} />
              <Label color={ink.muted}>{loadingEarlier ? "Loading earlier…" : "Load earlier"}</Label>
            </Pressable>
          </View>
        ) : null
      }
      ListFooterComponent={
        spoken === null || spoken === undefined || spoken.length === 0 ? null : <Spoken text={spoken} />
      }
      ListEmptyComponent={<Empty />}
    />
  );
}

function EntryRow({
  entry,
  canApprove,
  refusal,
  onDecide,
}: {
  entry: Entry;
  canApprove: boolean;
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
}): JSX.Element {
  switch (entry.kind) {
    case "user":
      return (
        <View
          style={styles.row}
          // Constant across every row of this kind, and it must stay that
          // way: the path scenario finds the agent's reply by enumerating
          // every row carrying this exact id (`labelsOf("entry-assistant")`)
          // and comparing labels, so keying rows by entry id would hide the
          // one row the round trip exists to prove. List identity already
          // comes from keyExtractor. A driver that cannot tolerate several
          // matches must enumerate or index, never assert single-match
          // visibility on this id.
          testID="entry-user"
          accessible
          accessibilityLabel={`you: ${entry.text}`}
        >
          <View style={[styles.gutter, { borderLeftColor: ink.faint }]}>
            <Kicker color={ink.muted}>you</Kicker>
          </View>
          <RichText text={entry.text} />
        </View>
      );

    case "assistant":
      return (
        <View
          style={styles.row}
          // Constant, for the same reason as the user row above: the path
          // scenario enumerates every row carrying this id to find the reply
          // that echoes its nonce. Uniquifying these once broke that step
          // while the product was demonstrably correct on device.
          testID="entry-assistant"
          accessible
          accessibilityLabel={`${entry.thought ? "thinking" : "agent"}: ${entry.text}`}
        >
          <View style={[styles.gutter, { borderLeftColor: entry.thought ? signal.violet : signal.sage }]}>
            <Kicker color={entry.thought ? signal.violet : signal.sage}>{entry.thought ? "thinking" : "agent"}</Kicker>
            {entry.streaming ? <Glyph name="activity" size={9} color={signal.amber} /> : null}
          </View>
          <RichText muted={entry.thought} text={entry.text} />
        </View>
      );

    case "tool":
      return (
        <View style={styles.cardRow}>
          <ToolCard entry={entry} />
        </View>
      );

    case "approval":
      return (
        <View style={styles.cardRow}>
          <ApprovalCard entry={entry} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />
        </View>
      );

    default:
      // A payload this build has never seen. An operator watching an agent run
      // is owed the truth that something happened, even unnamed.
      return (
        <View style={styles.row} testID={`entry-unknown-${entry.id}`}>
          <View style={[styles.gutter, { borderLeftColor: ground.edge }]}>
            <Glyph name="unknown" size={11} color={ink.faint} />
          </View>
          <View style={styles.prose}>
            <Label color={ink.muted}>{entry.label}</Label>
          </View>
        </View>
      );
  }
}

/**
 * What the daemon would say out loud. Shown as text because this build has no
 * voice of its own yet, and a summary that only exists as audio nobody plays is
 * a summary that was never delivered.
 */
function Spoken({ text }: { text: string }): JSX.Element {
  return (
    <View style={styles.spoken} testID="transcript-say">
      <Glyph name="link" size={11} color={signal.violet} />
      <Code color={ink.plain} style={styles.spokenText}>
        {text}
      </Code>
    </View>
  );
}

function Empty(): JSX.Element {
  return (
    <View style={styles.empty} testID="transcript-empty">
      <Glyph name="bay" size={22} color={ground.edge} />
      <Label color={ink.muted}>Nothing on this strip yet.</Label>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: ground.base },
  content: { padding: space.wide, gap: space.step },
  header: { flexDirection: "row", alignItems: "center", gap: space.step, paddingVertical: space.tight },
  earlier: {
    minHeight: 44,
    alignSelf: "center",
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  row: { flexDirection: "row", gap: space.step },
  gutter: {
    width: 76,
    borderLeftWidth: stroke.heavy,
    paddingLeft: space.snug,
    gap: space.tight,
    alignItems: "flex-start",
  },
  prose: { flex: 1 },
  cardRow: { marginVertical: space.tight },
  spoken: {
    flexDirection: "row",
    gap: space.snug,
    padding: space.step,
    marginTop: space.snug,
    backgroundColor: ground.surface,
    borderLeftWidth: stroke.heavy,
    borderLeftColor: signal.violet,
  },
  spokenText: { flex: 1 },
  empty: { alignItems: "center", gap: space.step, paddingVertical: space.gulf },
});
