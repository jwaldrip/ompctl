/**
 * The owned session's log, rendered by assistant-ui's primitives.
 *
 * What is being proven here is narrow and worth stating: assistant-ui owns the
 * list, message identity and part dispatch, and it owns no state. Every row is
 * still one of our components, because the source `Entry` rides along on
 * `metadata.custom` and the renderer reads it back rather than re-deriving
 * anything from assistant-ui's vocabulary. So a tool card keeps its kind, its
 * locations and its status, and a clearance keeps its decision, without any of
 * it having to survive a round trip.
 *
 * Three props are handed straight to the underlying `FlatList` and they are the
 * reason this can replace `Transcript` without giving anything up:
 *
 *  - `ListHeaderComponent` carries the "Load earlier" control, so #129's shared
 *    top-history machine still drives it.
 *  - `ListFooterComponent` carries `ActivityRow`, so #133's inline working row
 *    still sits under the operator's turn and above the composer, inside the
 *    list where the follower counts it as content.
 *  - `maintainVisibleContentPosition` plus `onScroll` / `onContentSizeChange`
 *    and a real `FlatList` ref keep the prepend anchor working.
 *
 * All four of assistant-ui's own scroll flags are turned OFF on purpose. Its
 * `autoScroll` and `scrollToBottomOn*` default to true and would fight
 * `useFollowNewest`, whose behaviour we have tests for: a reader scrolled up to
 * read history is not dragged to the bottom when a turn starts. Two followers
 * on one list is one too many, and ours is the one with proof behind it.
 */

import { useExternalStoreRuntime } from "@assistant-ui/core/react";
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react-native";
import { type JSX, type ReactNode, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { Label } from "../design/text.tsx";
import { ground, ink, signal, space } from "../design/tokens.ts";
import type { Entry } from "../session/model.ts";
import { entryOf, type OmpStoreInput, ompStore } from "./adapter.ts";

/**
 * The runtime, from `@assistant-ui/core/react` because that is the only place
 * `useExternalStoreRuntime` is exported. Memoised on the inputs that actually
 * change the store, so a re-render that changed nothing does not hand the
 * runtime a fresh adapter object.
 */
export function useOmpAssistantRuntime(input: OmpStoreInput) {
  const store = useMemo(
    () => ompStore(input),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the store is a
    // projection of exactly these; including `input` itself would rebuild on
    // every render because callers pass a fresh object literal.
    [input.agent, input.session, input.connection, input.load, input.promptAccess, input.onSubmit, input.onCancel],
  );
  return useExternalStoreRuntime(store);
}

export interface OmpThreadProps extends OmpStoreInput {
  /** The "Load earlier" control, from the shared top-history machine. */
  header?: ReactNode;
  /** The inline activity row. Absent when no turn is underway. */
  footer?: ReactNode;
  /** Rendered per row, given the entry this message was built from. */
  renderEntry: (entry: Entry) => ReactNode;
}

export function OmpThread(props: OmpThreadProps): JSX.Element {
  const runtime = useOmpAssistantRuntime(props);

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
          ListHeaderComponent={props.header === undefined ? null : <>{props.header}</>}
          ListFooterComponent={props.footer === undefined ? null : <>{props.footer}</>}
        >
          {({ message }) => <OmpRow message={message} renderEntry={props.renderEntry} />}
        </ThreadPrimitive.MessagesFlatList>

        <ComposerPrimitive.Root style={styles.composer} testID="aui-composer">
          <ComposerPrimitive.Input
            testID="aui-composer-input"
            style={styles.input}
            multiline
            placeholder="Say something to this agent"
            placeholderTextColor={ink.faint}
          />
          <ComposerPrimitive.Send testID="aui-composer-send" style={styles.send}>
            <Label color={ink.plain}>Send</Label>
          </ComposerPrimitive.Send>
          <ComposerPrimitive.Cancel testID="aui-composer-cancel" style={styles.cancel}>
            <Label color={ink.plain}>Stop</Label>
          </ComposerPrimitive.Cancel>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

/**
 * One row. The entry is read back off the message rather than reconstructed,
 * which is what makes this conversion lossless.
 *
 * A message with no entry is not ours, and there is exactly one producer of
 * those: while `isRunning` is true and the newest message is the operator's,
 * the external-store runtime synthesizes a placeholder assistant message of
 * its own. Measured, not assumed -- the same session renders
 * `["aui-row-user", "aui-row-foreign"]` with `state: "busy"` and
 * `["aui-row-user"]` with `state: "idle"`.
 *
 * It renders nothing, deliberately. That placeholder is assistant-ui's answer
 * to the same question `ActivityRow` answers, and the two disagree about the
 * part that matters: the placeholder is replaced the moment assistant text
 * starts streaming, while omp's own TUI keeps its loader running for the whole
 * turn (`#handleMessageUpdate` -> `#ensureWorkingLoaderWhileStreaming`, stopped
 * only in `#finishAgentEnd`). #133 shipped the TUI's semantics after reading
 * that source, so the footer row owns the claim and this one is suppressed.
 * Rendering both would put two working indicators on one turn.
 *
 * `isRunning` is still reported, because it is what enables
 * `ComposerPrimitive.Cancel`.
 */
function OmpRow({
  message,
  renderEntry,
}: {
  message: { metadata?: { custom?: Record<string, unknown> } };
  renderEntry: (entry: Entry) => ReactNode;
}): JSX.Element | null {
  const entry = entryOf(message);
  if (entry === null) return null;
  return (
    <View style={styles.row} testID={`aui-row-${entry.kind}`}>
      {renderEntry(entry)}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { flex: 1, backgroundColor: ground.base },
  row: { flexDirection: "row", gap: space.step },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space.snug,
    padding: space.step,
    backgroundColor: ground.surface,
  },
  input: { flex: 1, color: ink.plain, minHeight: 44 },
  send: { minHeight: 44, justifyContent: "center", paddingHorizontal: space.step },
  cancel: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: space.step,
    backgroundColor: signal.oxide,
  },
});
