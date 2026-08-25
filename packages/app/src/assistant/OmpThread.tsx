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
 * ours are the only scroll handlers in play. That is asserted rather than
 * remembered: `test/transcript-pagination.test.tsx` reads the props reaching the
 * real list and fails if a library `onLayout` ever arrives, which is the tell
 * that one of the four flipped back to its default.
 *
 * Paper supplies this surface's pixels and nothing else. `style` and
 * `contentContainerStyle` are the only props below that the design system
 * touches; every scroll and anchor prop belongs to the machine above.
 */

import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react-native";
import type { JSX, ReactElement, ReactNode } from "react";
import { useMemo, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Surface } from "react-native-paper";
import { useFollowNewest } from "../components/useFollowNewest.ts";
import { MAINTAIN_VISIBLE_CONTENT_POSITION, useTopHistoryPagination } from "../components/useTopHistoryPagination.ts";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Code, Label } from "../design/text.tsx";
import { radius, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import type { Entry } from "../session/model.ts";
import { entryOf, messageRowId, type OmpStoreInput, ompStore } from "./adapter.ts";
import { OmpEntryRow } from "./renderers.tsx";
import { useOmpRuntime } from "./runtime.ts";

/**
 * The history control's glyph, handed to Paper as a source rather than a name.
 *
 * Paper's `Icon` routes a STRING through `settings.icon`, which only exists
 * under `OmpThemeProvider`; with no provider above it, the string form falls
 * through to Paper's bundled Material renderer, which has no font here and
 * draws a literal box. A FUNCTION source is called directly
 * (`typeof s === "function"` in Paper's `Icon.tsx`), so the real glyph draws
 * whether a provider is mounted or not.
 *
 * It also moves the failure earlier: a glyph this app has no drawing for is a
 * `GlyphName` compile error here, where a string would have been a blank space
 * at runtime. Hoisted to module scope so its identity is stable across renders,
 * which is what Paper's `isEqualIcon` memo compares.
 */
function resumeGlyph({ size, color }: { size: number; color: string }): JSX.Element {
  return <Glyph name="resume" size={size} color={color} />;
}

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
  /** A non-message card which belongs above the transcript and must scroll with it. */
  header?: ReactElement | null;
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
  // The ground the log sits on is the one runtime-varying value here: every
  // measurement below is structural and lives in the StyleSheet as a rhythm
  // job, but the base changes with the device's scheme.
  const theme = useOmpTheme();

  /**
   * The head row's key, in the same key space the list uses. `MessagesFlatList`
   * keys on the converted message id and `convertEntry` emits `messageRowId`,
   * so this calls the same function rather than restating its rule -- two
   * derivations would make a prepend and a re-render indistinguishable to the
   * shared machine.
   */
  const first = props.entries[0];
  const headKey = first === undefined ? null : messageRowId(first);

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
        <Button
          testID="history-load-earlier"
          mode="text"
          icon={resumeGlyph}
          // No `loading`: Paper's spinner would replace the glyph, so the
          // control's identity would flicker on every page. Greyed out and
          // saying so is the whole in-progress signal, and it is the shape the
          // terminal's control of the same name carries.
          disabled={props.loadingEarlier === true}
          accessibilityLabel="Load earlier transcript entries"
          onPress={pagination.onPressLoadEarlier}
          // Paper's text mode paints itself `colors.primary`, which is signal
          // sage. Sage means "this is the action that completes the turn" and
          // the composer's send disc owns it; a way back through history is not
          // that, and it was `ink.muted` before. Paper hands this to the label
          // AND the icon, so the glyph follows.
          textColor={theme.ink.muted}
          // Paper computes `roundness * 5` for a v3 button and hands it to the
          // touchable inline: measured at 40 points without this, which is a
          // pill. The one pill in this app is the composer's send disc, for the
          // same reason sage is: that shape means "completes the action".
          style={styles.earlierShape}
          contentStyle={styles.earlier}
          labelStyle={styles.earlierLabel}
        >
          {props.loadingEarlier === true ? "Loading earlier…" : "Load earlier"}
        </Button>
      </View>
    ) : null;

  const header =
    props.header === null || props.header === undefined ? (
      earlier
    ) : (
      <>
        {props.header}
        {earlier}
      </>
    );

  return (
    <ThreadPrimitive.Root style={styles.root} testID="aui-thread">
      <ThreadPrimitive.MessagesFlatList
        testID="aui-messages"
        style={[styles.list, { backgroundColor: theme.ground.base }]}
        contentContainerStyle={styles.listContent}
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
        ListHeaderComponent={header}
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
        // The surface an operator sees before their first turn. It is the
        // shipped `Transcript`'s own, kept rather than re-invented: a cutover
        // that drops a state a session can actually be in leaves a blank pane
        // where there was a sentence.
        //
        // "Empty" here is the LIST's emptiness, not the session's, and the two
        // differ in exactly one case: while `isRunning` holds with no rows yet,
        // the external-store runtime synthesizes its optimistic placeholder, so
        // the list has a message (which `OmpRow` draws as nothing) and this does
        // not render. That is the right answer rather than a gap -- the footer's
        // working row is already saying what is happening, and "Nothing on this
        // strip yet" would contradict it.
        ListEmptyComponent={<Empty />}
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
 * A session with nothing in it yet, which is every session's first state.
 *
 * Lifted from `Transcript` for the reason `Spoken` is: the cutover must not
 * silently drop a surface an operator already had. The list is the library's
 * now, so this rides in `ListEmptyComponent` rather than being rendered beside
 * it -- the empty slot belongs to the list that knows it has no rows.
 */
function Empty(): JSX.Element {
  const theme = useOmpTheme();
  return (
    <View style={styles.empty} testID="transcript-empty">
      <Glyph name="bay" size={22} color={theme.ground.edge} />
      <Label color={theme.ink.muted}>Nothing on this strip yet.</Label>
    </View>
  );
}

/**
 * What the daemon would say out loud, shown as text because this build has no
 * voice of its own. Lifted from `Transcript` rather than re-invented: the
 * cutover must not silently drop a surface an operator already had.
 */
function Spoken({ text }: { text: string }): JSX.Element {
  const theme = useOmpTheme();
  return (
    <Surface
      mode="flat"
      elevation={0}
      style={[styles.spoken, { backgroundColor: theme.ground.surface, borderLeftColor: theme.signal.violet }]}
      testID="transcript-say"
    >
      <Glyph name="link" size={11} color={theme.signal.violet} />
      <Code color={theme.ink.plain} style={styles.spokenText}>
        {text}
      </Code>
    </Surface>
  );
}

/**
 * The negative right margin Paper hangs on a text-mode button's icon.
 *
 * Paper expects the label's own 16 to cancel it, which lands the glyph 8 from
 * its word. An icon and its label stop reading as one object past about four
 * points, which is what `rhythm.glyphGap` names, so the label pays the overhang
 * back and then the gap. Paper's own icon margins are not reachable from a
 * call site; this is the half that is.
 */
const PAPER_ICON_OVERHANG = 8;

/**
 * Every measurement on this surface, each one a named rhythm job.
 *
 * Nothing here is a bare number and nothing here is a colour: the two colours
 * that vary with the device's scheme are composed at the call site, and the
 * geometry stays in the sheet so a source-scraping check can still read it.
 */
const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  list: { flex: 1, minHeight: 0 },
  /**
   * The screen gutter and the row rhythm, paid once for the whole log.
   *
   * The header control, every turn, the spoken row and the empty state all
   * render inside this container, so none of them pays a screen inset a second
   * time -- which is what made the transcript read as padded out.
   */
  listContent: { paddingHorizontal: rhythm.gutter, gap: rhythm.rowGap },
  // The control belongs to the history above it rather than standing as its own
  // section, so it pays the tight step.
  header: { alignItems: "center", paddingVertical: rhythm.rowGapTight },
  // A control living inside a surface, which is the radius every other control
  // in this app takes. Paper's own `roundness * 5` would make it a pill.
  earlierShape: { borderRadius: radius.control },
  // The control's own geometry: a finger target Paper's button is short of, and
  // its own horizontal padding, which belongs to the button rather than to the
  // log under it.
  earlier: { minHeight: rhythm.minTarget, paddingHorizontal: rhythm.controlPad },
  // Paper's MD3 label margins are 10 vertical and 16 horizontal, neither on the
  // grid. The height is the content row's job now, and the horizontal is the
  // glyph gap once the overhang is paid back.
  earlierLabel: { marginVertical: 0, marginHorizontal: PAPER_ICON_OVERHANG + rhythm.glyphGap },
  // A card inside the log, so a card's inner pad -- the gutter is already paid
  // by the content container -- and a full section's air above it, because what
  // the daemon said out loud is not another turn.
  spoken: {
    flexDirection: "row",
    gap: rhythm.cardGap,
    padding: rhythm.cardPad,
    marginTop: rhythm.sectionGap,
    borderLeftWidth: stroke.heavy,
  },
  spokenText: { flex: 1 },
  empty: { alignItems: "center", gap: rhythm.rowGap, paddingVertical: rhythm.sectionGap },
});
