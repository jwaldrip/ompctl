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
import { useCallback, useEffect, useRef } from "react";
import type { ListRenderItemInfo, NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Code, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";
import { type Entry, transcriptRowKey } from "../session/model.ts";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { RichText } from "./rich/RichText.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { useFollowNewest } from "./useFollowNewest.ts";

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
  /** The stable cursor identity of the current history range. Used by dedup guard. */
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
  // Track the cursor of the request in flight to prevent duplicate requests
  // from scroll bounce or repeated onScroll events at the same offset.
  // Stores the historyCursor value of the last auto-load request.
  const inFlightCursor = useRef<number | null>(null);
  // Track if current load is from pagination (vs streaming content)
  const paginationLoadInFlight = useRef<boolean>(false);

  // Track previous content height for Android manual anchor preservation
  const prevContentHeight = useRef<number>(0);
  const prevScrollY = useRef<number>(0);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Entry>) => (
      <EntryRow entry={item} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />
    ),
    [canApprove, refusal, onDecide],
  );

  // Opening a session lands on the newest entry, and a streaming turn keeps
  // it there, unless the operator has scrolled up to read.
  const follow = useFollowNewest();
  const flatListRef = useRef<FlatList>(null);

  // Auto-load earlier transcript when scrolling near the top.
  // Dedup using cursor identity: only one request per cursor, cleared when cursor changes.
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      follow.onScroll(event);

      // Record scroll position for Android manual anchor adjustment
      prevScrollY.current = event.nativeEvent.contentOffset.y;

      // Check if near top and should auto-load
      const { contentOffset } = event.nativeEvent;
      const nearTop = contentOffset.y <= 48; // NEAR_TOP_SLACK

      if (nearTop && canLoadEarlier && onLoadEarlier !== undefined && !loadingEarlier) {
        // Only fire if we're not already loading this exact cursor.
        // Store the cursor value to block duplicate requests at the same position.
        // This survives across re-renders, so 3 onScroll events at y=30 -> 1 request.
        if (inFlightCursor.current !== historyCursor) {
          inFlightCursor.current = historyCursor ?? null;
          paginationLoadInFlight.current = true;
          onLoadEarlier();
        }
      }
    },
    [follow, canLoadEarlier, onLoadEarlier, loadingEarlier, historyCursor],
  );

  // When loading completes, clear the in-flight guard
  useEffect(() => {
    if (!loadingEarlier) {
      inFlightCursor.current = null;
      paginationLoadInFlight.current = false;
    }
  }, [loadingEarlier]);

  // When cursor changes (new page loaded), clear the guard to enable next auto-load
  // biome-ignore lint/correctness/useExhaustiveDependencies: historyCursor prop must trigger guard reset
  useEffect(() => {
    inFlightCursor.current = null;
  }, [historyCursor]);

  // Preserve scroll anchor when prepending entries via maintainVisibleContentPosition.
  // This prop handles iOS natively. For Android, fallback via onContentSizeChange.
  const handleContentSizeChange = useCallback((_width: number, height: number) => {
    // Android manual anchor: only adjust for confirmed pagination prepends.
    // Do NOT adjust for streaming token growth or other content changes at the bottom.
    if (paginationLoadInFlight.current && prevContentHeight.current > 0 && height > prevContentHeight.current) {
      const delta = height - prevContentHeight.current;
      if (prevScrollY.current > 0 && flatListRef.current) {
        flatListRef.current.scrollToOffset({
          offset: prevScrollY.current + delta,
          animated: false,
        });
      }
    }
    prevContentHeight.current = height;
  }, []);

  return (
    <FlatList
      testID="transcript"
      ref={flatListRef}
      style={styles.list}
      data={entries as Entry[]}
      keyExtractor={transcriptRowKey}
      renderItem={renderItem}
      onScroll={handleScroll}
      onContentSizeChange={handleContentSizeChange}
      scrollEventThrottle={16}
      maintainVisibleContentPosition={{
        minIndexForVisible: 0,
        autoscrollToTopThreshold: 100,
      }}
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
              onPress={onLoadEarlier}
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
