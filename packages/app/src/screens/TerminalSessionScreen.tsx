/**
 * One live terminal session: its recent turns, plus a prompt surface.
 *
 * A session running in a terminal has no agent row, so this device cannot
 * `attach` to it and there is no update stream to replay. What it can have is
 * the session's own file: the daemon reads a page of that JSONL and serves
 * it as `session_tail`, which is the history this screen renders. Above the
 * composer, oldest first, so the newest turn sits closest to where the
 * operator types. Tapping a session with a thousand messages in it used to
 * open a composer over an empty pane, which reads as a broken session rather
 * than as a surface that never had a transcript.
 *
 * The page is a window, not the conversation, and every answer carries the
 * offset the next older one starts from. So the head of the log is a Load
 * earlier control, the same one under the same id the agent log uses, and
 * pressing it walks the file backwards until its start, where the control
 * goes away. What stood there before was a kicker reading that older turns
 * were not shown: true, and a dead end on a session whose recent screenfuls
 * are all tool traffic.
 *
 * Sent and the last reply are turns of this conversation, not chrome: the
 * daemon delivers prompts to the terminal as the operator's own turn and
 * reports the answer back as `tui_activity`, so both render as rows
 * continuing the tail, in the same gutter-and-prose language as a served
 * turn. Only what is not a turn stays a band below the log: the busy kicker,
 * the daemon's refusals, the explainer, and the boundary notice. The log
 * itself pins to the bottom of the pane, so a short conversation sits
 * against the composer instead of leaving a void under the operator's last
 * words. The next open re-reads the file, at which point today's hints are
 * simply part of the history, and `logRows` stands a hint down when the tail
 * already ends with its words.
 *
 * The composer here is not `Composer`, on purpose. That control turns its
 * send button into an interrupt while a turn runs, because an agent's turn
 * can be cancelled from here. A terminal's cannot, and sending mid-turn is a
 * steer, the delivery the daemon itself defaults to, so the button stays
 * Send while the session is eligible, even when a turn is already running.
 */

import type { PromptImage, SessionLiveStatus, TranscriptTailMessage } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback } from "react";
import { FlatList, type ListRenderItemInfo, Pressable, StyleSheet, View } from "react-native";
import { ActivityPip } from "../components/ActivityPip.tsx";
import { Composer } from "../components/Composer.tsx";
import { SessionLoadFailed, SessionLoading, SessionLoadStalled } from "../components/SessionLoad.tsx";
import { useFollowNewest } from "../components/useFollowNewest.ts";
import { MAINTAIN_VISIBLE_CONTENT_POSITION, useTopHistoryPagination } from "../components/useTopHistoryPagination.ts";
import type { SessionLoad, TuiPromptAccess, TuiSessionState } from "../console/state.ts";
import { elapsed, shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
import { SafeScreen, useOwnedBottomInset } from "../design/SafeScreen.tsx";
import { Body, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import { bottomInsetFor, useKeyboardInset } from "../design/useKeyboardInset.ts";
import { imageAttachmentPicker } from "../platform/attachments.ts";
import { tuiActivity } from "../session/activity.ts";
import { SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

export interface TerminalSessionScreenProps {
  title: string;
  cwd: string;
  /** Current index truth. Null means the daemon no longer lists this session. */
  status: SessionLiveStatus | null;
  /** Scope truth after the daemon hello, or the stored pairing hint before it. */
  promptAccess: TuiPromptAccess;
  /**
   * Whether this pane has the terminal session it opened. A row press commits
   * the session and arms this before the daemon has answered, so the pane is
   * this row's from the moment it is touched.
   */
  load: SessionLoad;
  /** Motion seam for the activity indicator. Unset in production. */
  reduceMotion?: boolean;
  /** This session's served transcript tail plus the hints the console holds about it. */
  tui: TuiSessionState;
  connection: ConnectionState;
  onBack: () => void;
  /**
   * Ask for the page of turns older than the ones on screen. The screen
   * offers this only while `tui.historyCursor` names one, so a press always
   * has a page to ask for.
   */
  onLoadEarlier: () => void;
  onSubmit: (text: string, images?: PromptImage[]) => void;
}

/**
 * The gutter's second line for a live hint, where a served turn shows its
 * elapsed stamp. One word each, because the gutter leaves 66 points for text
 * and `Sent to this terminal` needs 155.95 of them. Wrapping could not save
 * it either: its longest word alone (TERMINAL, 65.00) outgrew the 58 points
 * the old 68-point gutter left, so the column broke the word rather than the
 * phrase. Cutting it back to one word loses nothing. The gutter's first line
 * already says `you` or `agent`, the row's accessibility label repeats that
 * attribution in front of the words, and the row's own testID names which
 * kind this is. The phrase was saying the same thing a third time, in the
 * narrowest column on the screen.
 */
export const HINT_WORDS = { sent: "sent", reply: "reply" } as const;

function notLiveGuidance(status: SessionLiveStatus | null): string {
  switch (status) {
    case null:
      return "The daemon no longer lists this session. Return to Sessions to refresh before trying another action.";
    case "live-tui":
      return "This session is still live in its terminal.";
    case "live-ompd":
      return "An ompd agent now owns this session, not the terminal. Return to Sessions to open its agent log.";
    case "dormant":
      return "No terminal owns this session now. Return to Sessions to resume it from its current state.";
    case "archived":
      return "This session is archived and cannot be steered. Return to Sessions to choose an available session.";
  }
}

/**
 * One row of the conversation this screen renders: a served turn, or a live
 * hint continuing it.
 *
 * The key is carried on the row rather than derived at render time, and a
 * turn's is its depth from the newest turn rather than its index from the
 * top. Older pages prepend, so an index from the top renumbers every row
 * already on screen each time the operator loads earlier; depth from the
 * newest never moves, because nothing is ever inserted below a turn. Hints
 * are keyed by what they are: there is at most one of each.
 */
type LogRow =
  | { kind: "turn"; key: string; message: TranscriptTailMessage }
  | { kind: "sent"; key: string; text: string }
  | { kind: "reply"; key: string; text: string };

/**
 * The conversation the log renders: the served tail, then this device's live
 * hints continuing below it as they arrive.
 *
 * A hint whose words the tail already ends with stands down. The daemon
 * re-reads the session file on every open, so once the terminal has written
 * the turn the same words are on screen twice, once as history and once as
 * the echo, and rendering both would read as a stutter. Only the tail's
 * final turn is compared: a match deeper in the tail is not adjacent to the
 * hint, and hiding the echo then would drop the only row saying what this
 * device last said or heard.
 */
function logRows(tui: TuiSessionState): LogRow[] {
  const newest = tui.history.length - 1;
  const rows: LogRow[] = tui.history.map((message, index) => ({
    kind: "turn",
    key: `turn:${newest - index}`,
    message,
  }));
  const tailEnd = tui.history.at(-1);
  if (tui.sent !== null && !(tailEnd?.role === "user" && tailEnd.text === tui.sent)) {
    rows.push({ kind: "sent", key: "sent", text: tui.sent });
  }
  if (tui.reply !== null && !(tailEnd?.role === "assistant" && tailEnd.text === tui.reply)) {
    rows.push({ kind: "reply", key: "reply", text: tui.reply });
  }
  return rows;
}

export function TerminalSessionScreen(props: TerminalSessionScreenProps): JSX.Element {
  const { tui, connection, status, promptAccess, load } = props;
  const tablet = useIsTablet();
  // The latest index row, not the row that opened this route, decides whether
  // steering is still safe. A terminal can close while the screen remains.
  const liveTerminal = status === "live-tui";
  const activity = tuiActivity(tui, connection, load, liveTerminal);
  const tone = status === null ? signal.oxide : signal[SESSION_STATUS_SIGNALS[status]];
  const statusLabel = status === null ? "Unavailable" : STATUS_LABELS[status];
  const ownedBottom = useOwnedBottomInset();
  // The same mechanism the agent log uses: KeyboardAvoidingView is inert on an
  // iPad, so the keyboard's measured height is paid as padding instead.
  const keyboardInset = useKeyboardInset();
  const rows = logRows(tui);

  const connected = connection === "connected";
  const composerEnabled = connected && liveTerminal && promptAccess !== "missing" && tui.refusalKind !== "scope";
  const placeholder = !connected
    ? "No link"
    : !liveTerminal
      ? "Session is not live in a terminal"
      : promptAccess === "missing" || tui.refusalKind === "scope"
        ? "Prompt scope required"
        : "Say something to this terminal";

  /**
   * The tail arrives oldest first, so the newest turn is the last row, and a
   * list left at the top would show the operator the oldest of the last
   * thirty turns. Driven by content size rather than by mount, because rows
   * measure after layout and a scroll issued before that lands nowhere.
   *
   * Conditional on position, which is what `Load earlier` needs: an older
   * page also grows the content, and pinning to the end there would drop the
   * operator at the bottom of the history they just asked for.
   */
  const follow = useFollowNewest();

  /**
   * The same top-history machine the owned transcript runs, on this surface's
   * own rows and its own cursor.
   *
   * The head key comes from `rows[0].key`, which is exactly what this list's
   * `keyExtractor` returns. That sameness is what makes a prepend detectable
   * here: an arriving live hint and a streaming reply both grow this log
   * without touching row zero, so they cannot consume an anchor armed for the
   * older page still in flight.
   *
   * `tui.historyCursor` is null when the daemon's last page reached the start
   * of the file, which is also what removes the manual control, so `canLoad`
   * and the button agree by construction rather than by two separate checks.
   */
  const historyCursor = tui.historyCursor;
  const pagination = useTopHistoryPagination({
    canLoadEarlier: historyCursor !== null,
    loadingEarlier: tui.historyLoadingEarlier,
    onLoadEarlier: props.onLoadEarlier,
    cursor: historyCursor,
    headKey: rows[0]?.key ?? null,
    follow,
  });

  const renderRow = useCallback(({ item, index }: ListRenderItemInfo<LogRow>): JSX.Element => {
    const mine = item.kind === "turn" ? item.message.role === "user" : item.kind === "sent";
    const words = item.kind === "turn" ? item.message.text : item.text;
    // A live hint continues the conversation where a served turn shows its
    // timestamp, so the gutter's second line names which one this row is.
    const under =
      item.kind === "turn" ? (
        item.message.at === "" ? null : (
          <Kicker color={ink.faint}>{elapsed(item.message.at)}</Kicker>
        )
      ) : (
        <Kicker color={ink.faint}>{item.kind === "sent" ? HINT_WORDS.sent : HINT_WORDS.reply}</Kicker>
      );
    // Gutter attribution rather than alternating bubbles, the same call
    // `Transcript` made: there are only ever two speakers and bubbles halve
    // the usable width on a phone.
    const row = (
      <>
        <View style={[styles.gutter, { borderLeftColor: mine ? ink.faint : signal.sage }]}>
          <Kicker color={mine ? ink.muted : signal.sage}>{mine ? "you" : "agent"}</Kicker>
          {under}
        </View>
        <Body color={ink.bright} style={styles.prose}>
          {words}
        </Body>
      </>
    );
    return (
      <View
        style={styles.turn}
        testID={`terminal-turn-${index}`}
        // A nested Body is often invisible to an accessibility query even
        // when it is on screen, so the row carries the words itself.
        accessible
        accessibilityLabel={`${mine ? "you" : "agent"}: ${words}`}
      >
        {item.kind === "turn" ? (
          row
        ) : (
          // The hint's own id sits one level in: the row is a row of this
          // log like any other, and the hint identity is what queries read.
          <View testID={item.kind === "sent" ? "terminal-sent" : "terminal-reply"} style={styles.hintSkin}>
            {row}
          </View>
        )}
      </View>
    );
  }, []);

  /**
   * The way back through the conversation, in the same words and under the
   * same id the agent log's transcript uses: one act, one idiom. Offered
   * only while the daemon's last page named an older one, so reaching the
   * start of the file removes the control rather than leaving a press that
   * can never answer.
   */
  const earlier =
    tui.historyCursor === null ? null : (
      <Pressable
        testID="history-load-earlier"
        accessibilityRole="button"
        accessibilityLabel="Load earlier turns of this terminal session"
        accessibilityState={{ disabled: tui.historyLoadingEarlier }}
        disabled={tui.historyLoadingEarlier}
        onPress={pagination.onPressLoadEarlier}
        style={({ pressed }) => [styles.earlier, pressed && { backgroundColor: ground.active }]}
      >
        <Glyph name="resume" size={11} color={ink.muted} />
        <Label color={ink.muted}>{tui.historyLoadingEarlier ? "Loading earlier…" : "Load earlier"}</Label>
      </Pressable>
    );

  return (
    <SafeScreen edges={{ top: true, bottom: false, left: true, right: true }} testID="terminal-session">
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Pressable
          testID="terminal-back"
          accessibilityRole="button"
          accessibilityLabel="Back to sessions"
          onPress={props.onBack}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: ground.active }]}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain} testID="terminal-back-label">
            Sessions
          </Label>
        </Pressable>

        <View style={styles.ident}>
          <Title heading numberOfLines={1} testID="terminal-title">
            {props.title || "Untitled session"}
          </Title>
          <View style={styles.meta}>
            <Glyph name="folder" size={10} color={ink.faint} />
            <Label color={ink.muted} numberOfLines={1} style={styles.origin}>
              {shortenPath(props.cwd, 3)}
            </Label>
          </View>
        </View>

        {/*
          The terminal's own activity, from its turn boundaries. Narrower than
          an owned agent's because the bridge forwards no tool events; see
          `tuiActivity` for the missing producer.
        */}
        <ActivityPip activity={activity} compact={!tablet} reduceMotion={props.reduceMotion} />
        <Kicker color={tone} testID="terminal-state">
          {statusLabel}
        </Kicker>
      </View>

      {load.phase === "loading" ? (
        <SessionLoading title={props.title || "Untitled session"} />
      ) : load.phase === "stalled" ? (
        <SessionLoadStalled connection={connection} title={props.title || "Untitled session"} />
      ) : load.phase === "failed" ? (
        <SessionLoadFailed
          message={load.error ?? "The daemon refused this session."}
          title={props.title || "Untitled session"}
        />
      ) : rows.length === 0 ? (
        // No turns yet, and a cursor still naming older file: a session whose
        // recent screenfuls are pure tool traffic opens with nothing to show
        // and everything still to read, so the control has to be reachable
        // without a log to head.
        earlier === null ? null : (
          <View style={styles.earlierAlone}>{earlier}</View>
        )
      ) : (
        <FlatList
          ref={pagination.ref}
          testID="terminal-log"
          style={styles.log}
          contentContainerStyle={styles.logContent}
          data={rows}
          // The row's own key, built where the rows are: turns carry no id of
          // their own, and a key derived from the index here would renumber
          // every row on screen each time an older page prepends.
          keyExtractor={row => row.key}
          renderItem={renderRow}
          ListHeaderComponent={earlier}
          maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
          onContentSizeChange={pagination.onContentSizeChange}
          onScroll={pagination.onScroll}
          scrollEventThrottle={pagination.scrollEventThrottle}
        />
      )}

      {/*
        Every hint and refusal below is a claim about a session this pane has.
        While the open is still outstanding, or once it has been refused, the
        pane has none, and a "not a live terminal session" band over a session
        that simply has not arrived would be a diagnosis of the wrong thing.
      */}
      <View style={[styles.hints, rows.length === 0 && styles.hintsFill]}>
        {load.phase !== "ready" ? null : (
          <>
            {liveTerminal ? null : (
              <View testID="terminal-not-live-tui" style={styles.refusal}>
                <View style={styles.refusalHead}>
                  <Glyph name="warning" size={13} color={signal.oxide} />
                  <Label color={signal.oxide}>Not a live terminal session</Label>
                </View>
                <Body color={ink.bright}>{notLiveGuidance(status)}</Body>
              </View>
            )}

            {promptAccess === "missing" || tui.refusalKind === "scope" ? (
              <View testID="terminal-scope-refusal" style={styles.refusal}>
                <View style={styles.refusalHead}>
                  <Glyph name="warning" size={13} color={signal.oxide} />
                  <Label color={signal.oxide}>Prompt scope required</Label>
                </View>
                <Body color={ink.bright}>
                  {tui.refusalKind === "scope" && tui.refusal !== null
                    ? tui.refusal
                    : "This device does not hold the prompt scope. Pair it again with prompt access before steering this terminal."}
                </Body>
              </View>
            ) : null}

            {tui.refusalKind === "owner-gone" && tui.refusal !== null ? (
              <View testID="terminal-owner-gone" style={styles.refusal}>
                <View style={styles.refusalHead}>
                  <Glyph name="warning" size={13} color={signal.oxide} />
                  <Label color={signal.oxide}>Owning terminal is unreachable</Label>
                </View>
                <Body color={ink.bright}>{tui.refusal}</Body>
              </View>
            ) : null}

            {tui.replyUnavailable ? (
              <View testID="terminal-reply-unavailable" style={styles.refusal}>
                <View style={styles.refusalHead}>
                  <Glyph name="warning" size={13} color={signal.ochre} />
                  <Label color={signal.ochre}>Reply stayed in the terminal</Label>
                </View>
                <Body color={ink.bright}>
                  This turn ended without readable assistant text. Its full transcript and tool output remain in the
                  owning terminal.
                </Body>
              </View>
            ) : null}

            {tui.busy ? (
              <Kicker color={tone} testID="terminal-busy">
                Working in the terminal
              </Kicker>
            ) : null}

            {liveTerminal &&
            tui.history.length === 0 &&
            tui.refusal === null &&
            tui.sent === null &&
            tui.reply === null &&
            !tui.replyUnavailable &&
            !tui.busy ? (
              <Body color={ink.muted} testID="terminal-explainer">
                This session is live in a terminal on the machine. This phone steers it without taking ownership, and
                live progress returns here.
              </Body>
            ) : null}

            <Label color={ink.faint} testID="terminal-transcript-limit" style={styles.boundary}>
              Only recent text and live assistant replies appear here. The full transcript and tool output stay in the
              terminal.
            </Label>
          </>
        )}
      </View>

      {/*
        Below the composer sits either the keyboard or the home indicator,
        never both. This was a KeyboardAvoidingView, which does nothing on an
        iPad: the send control's frame is identical with the keyboard up and
        down, so the control sits behind the keyboard and nobody can press it.

        The pad is the inset this screen owns, zero when a shell above has
        already paid it, and the paying view paints the composer's surface:
        a parent's padding is outside every child, so a transparent pad owner
        is how the shell's base colour ends up showing between the message
        box and the screen edge.
      */}
      <View
        style={[styles.composerSafe, { paddingBottom: bottomInsetFor(keyboardInset, ownedBottom) }]}
        testID="terminal-composer-safe"
      >
        {/*
          The same control the agent log uses, with no interrupt: a terminal's
          turn cannot be cancelled from here, so `onCancel` is absent and the
          send stays Send even mid-turn, which is the steer the daemon itself
          defaults to. Everything else about the surface is shared, because
          two arrangements of one composer is two conventions.
        */}
        <Composer
          prefix="terminal-composer"
          picker={imageAttachmentPicker}
          enabled={composerEnabled}
          placeholder={placeholder}
          sendLabel="Send to this terminal"
          busy={tui.busy}
          onSubmit={props.onSubmit}
        />
      </View>
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  // The band that owns the screen's bottom edge. It paints the composer's
  // surface because it is the view that pays the inset below the composer:
  // a parent's padding is outside every child, so a transparent pad owner is
  // how the shell's base colour ends up showing between the message box and
  // the screen edge.
  composerSafe: { backgroundColor: ground.surface },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.heavy,
  },
  back: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
  },
  ident: { flex: 1, gap: space.tight },
  meta: { flexDirection: "row", alignItems: "center", gap: space.tight },
  origin: { flexShrink: 1 },
  log: { flex: 1, backgroundColor: ground.base },
  // The content container grows to fill the pane and packs its rows at the
  // end, so a short conversation sits at the bottom against the composer
  // instead of leaving a void under the operator's last words. Once the tail
  // outgrows the pane both declarations are inert and the list just scrolls.
  logContent: { padding: space.step, gap: space.step, flexGrow: 1, justifyContent: "flex-end" },
  // The same control shape the agent log's transcript uses for the same act,
  // so the two surfaces do not teach two different gestures for going back
  // through a conversation.
  earlier: {
    minHeight: TOUCH_TARGET,
    alignSelf: "center",
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  // With no turns to head, the control stands where the log would be rather
  // than crowding the bands under it.
  earlierAlone: { paddingTop: space.step, alignItems: "center" },
  turn: { flexDirection: "row", gap: space.step },
  // A hint row wraps its gutter and prose once more so the hint's own
  // testID can sit inside the row that carries the turn's positional one.
  hintSkin: { flex: 1, flexDirection: "row", gap: space.step },
  gutter: {
    // 76 to match `Transcript`'s gutter exactly, which is the point: the
    // module doc calls this the same gutter-and-prose language a served turn
    // uses, and the two columns differing by 8 points was drift rather than a
    // decision. The hairline and the padding leave 66 points for text, which
    // fits every word this column holds: AGENT (43.96), REPLY (40.26), and
    // the widest stamp `elapsed` can produce (365D 23H, 58.73, which the old
    // 58 points cut in half). Measured with CoreText in the face `Kicker`
    // renders; test/no-hidden-content.test.ts re-measures and fails if a word
    // stops fitting.
    width: 76,
    borderLeftWidth: stroke.heavy,
    paddingLeft: space.snug,
    gap: space.tight,
    alignItems: "flex-start",
  },
  prose: { flex: 1 },
  // Only non-turns live here: the busy kicker, refusals, the explainer, and
  // the boundary. The bands claim just what they need under the log. With no
  // rows at all there is nothing above them, and filling the pane is what
  // puts the explainer where the transcript would have been rather than
  // crushing it against the composer.
  hints: { gap: space.step, padding: space.step },
  hintsFill: { flex: 1 },
  refusal: { gap: space.snug, borderWidth: stroke.hair, borderColor: signal.oxide, padding: space.step },
  refusalHead: { flexDirection: "row", alignItems: "center", gap: space.tight },
  boundary: { marginTop: "auto", paddingTop: space.snug },
});
