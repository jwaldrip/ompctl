/**
 * The owned session's log and composer, on assistant-ui's primitives.
 *
 * assistant-ui owns the list, message identity and part dispatch. It owns no
 * state: `messages` is the reducer's `Entry[]`, the converter is ours, and every
 * action dispatches back through `OmpdClient`. Each row is still one of our
 * components, because the source `Entry` rides on `metadata.custom` and
 * `OmpEntryRow` reads it back rather than re-deriving anything from
 * assistant-ui's vocabulary.
 *
 * Four props go straight to the underlying `FlatList`, and they are why this
 * replaces `Transcript` without giving anything up:
 *
 *  - `ref`, `onScroll`, `onContentSizeChange`, `scrollEventThrottle` and
 *    `maintainVisibleContentPosition` from `useTopHistoryPagination`, so #129's
 *    shared machine drives the prepend anchor and cursor dedup here exactly as
 *    it does on the terminal.
 *  - `ListHeaderComponent` carries the "Load earlier" control.
 *  - `ListFooterComponent` carries `ActivityRow`, so #133's working row stays
 *    inside the list under the operator's turn and above the composer, where
 *    the follower counts it as content.
 *
 * All four of assistant-ui's own scroll flags are OFF. They default true and
 * would fight `useFollowNewest`, whose behaviour has tests: a reader scrolled up
 * to read history is not dragged to the bottom when a turn starts. Measured with
 * the flags false, the library installs nothing on the list -- the only props it
 * adds are `data`, `keyExtractor`, `renderItem` and its own `ref` plumbing -- so
 * ours are the only scroll handlers in play.
 */

import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react-native";
import type { JSX, ReactElement, ReactNode } from "react";
import { useMemo, useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useFollowNewest } from "../components/useFollowNewest.ts";
import { MAINTAIN_VISIBLE_CONTENT_POSITION, useTopHistoryPagination } from "../components/useTopHistoryPagination.ts";
import { Glyph } from "../design/icons.tsx";
import { Code, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";
import type { Entry } from "../session/model.ts";
import { assistantRowId, entryOf, type OmpStoreInput, ompStore } from "./adapter.ts";
import { OmpEntryRow } from "./renderers.tsx";
import { useOmpRuntime } from "./runtime.ts";

/**
 * The runtime, built once per meaningful state change.
 *
 * The actions go through a ref rather than the dependency list, and that is a
 * correctness fix rather than a tidy-up. Every callsite passes inline arrows
 * (`Console.tsx` does), so a memo depending on them rebuilt the store on every
 * single render and the memo's stated purpose did not hold for its only caller.
 * Capturing them once instead would dispatch through a stale closure. A ref is
 * the only shape that is both stable and current: the store identity survives a
 * re-render, and a press always reaches the newest handler.
 */
export function useOmpAssistantRuntime(input: OmpStoreInput) {
  const actions = useRef(input);
  actions.current = input;

  const { agent, session, connection, load, promptAccess, canApprove, refusal } = input;
  const store = useMemo(
    () =>
      ompStore({
        agent,
        session,
        connection,
        load,
        promptAccess,
        canApprove,
        refusal,
        onSubmit: (text, images) => actions.current.onSubmit(text, images),
        onCancel: () => actions.current.onCancel(),
        onDecide: (requestId, choice, scope) => actions.current.onDecide(requestId, choice, scope),
        onDecidePlan: (requestId, choice) => actions.current.onDecidePlan(requestId, choice),
      }),
    [agent, session, connection, load, promptAccess, canApprove, refusal],
  );
  return useOmpRuntime(store);
}

/**
 * What the LIST needs. The store's own fields are not here: the list reads the
 * thread through the provider, so a screen cannot accidentally hand the list one
 * session's rows while the provider holds another's.
 */
export interface OmpThreadListProps {
  /** Whether this device may answer a clearance, and why not when it may not. */
  canApprove: boolean;
  refusal?: string;
  onDecide: OmpStoreInput["onDecide"];
  /** The rows this pane holds, for the pagination machine's head key only. */
  entries: readonly Entry[];
  /** The daemon's prose summary of the last settled turn, when there is one. */
  spoken?: string | null;
  /**
   * The inline activity row. Absent when no turn is underway. An element rather
   * than a `ReactNode`: the list's footer slot takes an element or a component,
   * so a string would be a type error at the boundary instead of a render
   * surprise.
   */
  footer?: ReactElement | null;
  /**
   * The same three the shipped `Transcript` takes, so a screen swapping to this
   * surface changes one element and no props. The pagination machine lives in
   * here for the same reason it lived in there: the head key it compares has to
   * come from the same key space the list uses, and only this component knows
   * both.
   */
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  /** The cursor identifying the page on screen, which makes a repeat detectable. */
  historyCursor?: number | null;
}

/**
 * The runtime, provided to everything under it.
 *
 * Separate from the list because `SessionScreen` puts a `StatusReadout` between
 * its log and its composer, and `ComposerPrimitive` only works inside this
 * provider. A component that rendered list-then-composer together would move
 * that readout below the composer. So the provider spans the body and the two
 * surfaces stay where they were.
 */
export function OmpThreadProvider({ children, ...input }: OmpStoreInput & { children: ReactNode }): JSX.Element {
  const runtime = useOmpAssistantRuntime(input);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

/** The log itself. Must be rendered inside `OmpThreadProvider`. */
export function OmpThreadList(props: OmpThreadListProps): JSX.Element {
  // Opening a session lands on the newest entry, and a streaming turn keeps it
  // there, unless the operator has scrolled up to read.
  const follow = useFollowNewest();

  /**
   * The head row's key, in the same key space the list uses. `MessagesFlatList`
   * keys on the converted message id, and `convertEntry` emits `rowId` for an
   * assistant row and `id` for every other kind -- so this has to be that same
   * derivation, not `transcriptRowKey`, or a prepend and a re-render would be
   * indistinguishable to the shared machine.
   */
  const first = props.entries[0];
  const headKey = first === undefined ? null : first.kind === "assistant" ? assistantRowId(first) : first.id;

  const pagination = useTopHistoryPagination({
    canLoadEarlier: props.canLoadEarlier === true,
    loadingEarlier: props.loadingEarlier === true,
    onLoadEarlier: props.onLoadEarlier,
    cursor: props.historyCursor,
    headKey,
    follow,
  });

  const earlier =
    props.canLoadEarlier === true && props.onLoadEarlier !== undefined ? (
      <View style={styles.header}>
        {props.loadingEarlier === true && <ActivityIndicator size="small" />}
        <Pressable
          testID="history-load-earlier"
          accessibilityRole="button"
          accessibilityLabel="Load earlier transcript entries"
          disabled={props.loadingEarlier === true}
          onPress={pagination.onPressLoadEarlier}
          style={({ pressed }) => [styles.earlier, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="resume" size={11} color={ink.muted} />
          <Label color={ink.muted}>{props.loadingEarlier === true ? "Loading earlier…" : "Load earlier"}</Label>
        </Pressable>
      </View>
    ) : null;

  return (
    <ThreadPrimitive.Root style={styles.root} testID="aui-thread">
      <ThreadPrimitive.MessagesFlatList
        testID="aui-messages"
        style={styles.list}
        // Ours, not theirs. See the note at the top of this file.
        autoScroll={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnThreadSwitch={false}
        ref={pagination.ref}
        onScroll={pagination.onScroll}
        onContentSizeChange={pagination.onContentSizeChange}
        scrollEventThrottle={pagination.scrollEventThrottle}
        maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        ListHeaderComponent={earlier}
        // In the order the conversation happened: what the daemon said about
        // the LAST settled turn, then the turn running NOW. So the activity row
        // is the newest thing on screen, which is what makes the follower treat
        // it as content to stay pinned to.
        ListFooterComponent={
          <>
            {props.spoken === null || props.spoken === undefined || props.spoken.length === 0 ? null : (
              <Spoken text={props.spoken} />
            )}
            {props.footer}
          </>
        }
      >
        {({ message }) => (
          <OmpRow message={message} canApprove={props.canApprove} refusal={props.refusal} onDecide={props.onDecide} />
        )}
      </ThreadPrimitive.MessagesFlatList>
    </ThreadPrimitive.Root>
  );
}

/**
 * One row, rendered by our own component from the entry the message carries.
 *
 * A message with no entry renders nothing, and there is exactly one producer of
 * those: while `isRunning` is true and the newest message is the operator's, the
 * external-store runtime synthesizes a placeholder assistant message (identified
 * by `metadata.isOptimistic`). It answers the same question `ActivityRow`
 * answers, and disagrees on the part that matters -- the placeholder is replaced
 * when text starts streaming, while omp's own TUI keeps its loader for the whole
 * turn, which is the semantics #133 shipped. So the footer row owns the claim
 * and this one is suppressed. `isRunning` is still reported, because it is what
 * enables the composer's interrupt.
 */
function OmpRow({
  message,
  canApprove,
  refusal,
  onDecide,
}: {
  message: { metadata?: { custom?: Record<string, unknown> } };
  canApprove: boolean;
  refusal?: string;
  onDecide: OmpStoreInput["onDecide"];
}): JSX.Element | null {
  const entry: Entry | null = entryOf(message);
  if (entry === null) return null;
  return <OmpEntryRow entry={entry} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />;
}

/**
 * What the daemon would say out loud, shown as text because this build has no
 * voice of its own. Lifted from `Transcript` rather than re-invented: the
 * cutover must not silently drop a surface an operator already had.
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

const styles = StyleSheet.create({
  root: { flex: 1 },
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
  list: { flex: 1, backgroundColor: ground.base },
  header: { flexDirection: "row", alignItems: "center", gap: space.step, paddingVertical: space.tight },
  earlier: {
    minHeight: 44,
    alignSelf: "center",
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
});
