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
import type { JSX, ReactElement } from "react";
import { useMemo, useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { useFollowNewest } from "../components/useFollowNewest.ts";
import { MAINTAIN_VISIBLE_CONTENT_POSITION, useTopHistoryPagination } from "../components/useTopHistoryPagination.ts";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, space } from "../design/tokens.ts";
import type { ImageAttachmentPicker } from "../platform/attachments.ts";
import type { Entry } from "../session/model.ts";
import { entryOf, type OmpStoreInput, ompStore } from "./adapter.ts";
import { OmpComposer, type OmpComposerProps } from "./OmpComposer.tsx";
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

export interface OmpThreadProps extends OmpStoreInput {
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
  /** The composer's picker seam. Not Expo: `react-native-image-picker`. */
  picker: ImageAttachmentPicker;
  /** What the empty field says: where this screen states its own gate. */
  placeholder: string;
  /** What assistive technology hears on send, with the target named. */
  sendLabel: string;
  /**
   * The microphone, whole. One object rather than several props so a caller
   * cannot wire half of it; see `OmpComposerProps.voice`.
   */
  voice: OmpComposerProps["voice"];
  /** This session's resolved model and thinking level, already formatted. */
  model: string | null;
  /** Open this session's config surface. Absent where there is none. */
  onOpenConfig?: () => void;
}

export function OmpThread(props: OmpThreadProps): JSX.Element {
  const runtime = useOmpAssistantRuntime(props);

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
  const first = props.session.entries[0];
  const headKey = first === undefined ? null : first.kind === "assistant" ? first.rowId : first.id;

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
    <AssistantRuntimeProvider runtime={runtime}>
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
          ListFooterComponent={props.footer ?? null}
        >
          {({ message }) => (
            <OmpRow message={message} canApprove={props.canApprove} refusal={props.refusal} onDecide={props.onDecide} />
          )}
        </ThreadPrimitive.MessagesFlatList>

        <OmpComposer
          prefix="composer"
          picker={props.picker}
          placeholder={props.placeholder}
          sendLabel={props.sendLabel}
          voice={props.voice}
          model={props.model}
          onOpenConfig={props.onOpenConfig}
          refusal={props.refusal}
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
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

const styles = StyleSheet.create({
  root: { flex: 1 },
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
