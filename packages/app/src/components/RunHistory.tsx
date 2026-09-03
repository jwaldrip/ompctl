/**
 * What a routine actually did, run by run.
 *
 * A routine card already said what its actions are and how the newest run left
 * each of them. That is the routine's current state, and it is not a record: it
 * cannot answer "did the nine o'clock fire go through", and it cannot reach the
 * work. Every prompt action the scheduler runs opens an ACP session, and that
 * session is an ordinary session on this daemon, held by an agent while it runs
 * and on disk afterwards. So the run history's job is two things: state each
 * run plainly, and hand each action's session to the app's one session opener.
 *
 * ## Why this caps rather than virtualizes
 *
 * A routine's runs are nested inside its card, inside the screen's own
 * `ScrollView`, and there is one list per routine rather than one list on the
 * screen. React Native declines to window a `VirtualizedList` nested in a
 * same-orientation `ScrollView`: it warns and renders every cell, so a
 * `FlatList` here would bound nothing while looking like it did. A cap with an
 * explicit control to lift it bounds the mounted rows for real, and it says out
 * loud how much history is being withheld.
 *
 * ## Why a missing link renders and does nothing
 *
 * `ActionRun.sessionId` is optional, and absent means either that the run
 * predates the field or that the action never got as far as opening a session.
 * Neither is knowable from here, and neither is "the session is gone". So the
 * control renders, disabled, saying so. Hiding the row would make an old run
 * look like a run with fewer actions, and guessing an id would send the
 * operator to somebody else's transcript.
 */

import type { ActionRun, ActionRunState, Run, RunState } from "@ompd/core/contracts";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Surface } from "react-native-paper";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, stroke } from "../design/tokens.ts";
import type { SignalName } from "../session/browser.ts";
import { formatAge } from "../session/browser.ts";

/**
 * How many runs a routine shows before the control has to be used, and how many
 * each use adds. Three is what fits under a card's actions without the card
 * itself becoming the scroll, and the daemon sends ten per routine on a read,
 * so the first page is a third of a full answer rather than a token.
 */
export const RUNS_PER_PAGE = 3;

const RUN_STATE_SIGNALS: Record<RunState, SignalName> = {
  queued: "slate",
  running: "amber",
  succeeded: "sage",
  failed: "oxide",
  skipped: "slate",
  timed_out: "oxide",
};

const RUN_STATE_LABELS: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  skipped: "Skipped",
  timed_out: "Timed out",
};

/**
 * An action has one state a run does not: refused. A refusal is the daemon
 * declining to run the action at all, which is neither a failure of the work
 * nor a skip, so it wears the holding colour rather than either of theirs.
 */
const ACTION_STATE_SIGNALS: Record<ActionRunState, SignalName> = {
  queued: "slate",
  running: "amber",
  succeeded: "sage",
  failed: "oxide",
  refused: "ochre",
  skipped: "slate",
  timed_out: "oxide",
};

const ACTION_STATE_LABELS: Record<ActionRunState, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  refused: "Refused",
  skipped: "Skipped",
  timed_out: "Timed out",
};

/**
 * The distinct sessions one run reached. Distinct rather than a count of
 * actions carrying an id: the number is offered as a count of sessions, and two
 * actions naming one session would otherwise read as two places to go.
 */
function linkedSessionIds(run: Run): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const action of run.actions) {
    if (action.sessionId !== undefined) ids.add(action.sessionId);
  }
  return ids;
}

/** What one action has to say for itself beyond its state, or nothing. */
function outcomeOf(action: ActionRun): string | undefined {
  return action.refusal?.reason ?? action.error ?? action.summary;
}

export interface RunHistoryProps {
  /** The routine these runs belong to, for the testIDs and the controls' labels. */
  routineId: string;
  /** This routine's runs, newest first, as the daemon ordered them. */
  runs: readonly Run[];
  /** How many of them this card is showing. */
  shown: number;
  onShowMore: (routineId: string) => void;
  /** The run whose actions are open, or null. One at a time, across the screen. */
  openRunId: string | null;
  onToggleRun: (runId: string) => void;
  /**
   * The app's session opener, by session id. It resolves the transport itself
   * from the session index, so this component never decides whether a link
   * lands on an owned log, a co-driven terminal, or a resume claim.
   */
  onOpenSession: (sessionId: string) => void;
}

export function RunHistory({
  routineId,
  runs,
  shown,
  onShowMore,
  openRunId,
  onToggleRun,
  onOpenSession,
}: RunHistoryProps): JSX.Element {
  const visible = runs.slice(0, shown);
  const withheld = runs.length - visible.length;
  /** What one more press reveals, which is a page unless the tail is shorter. */
  const nextPage = Math.min(RUNS_PER_PAGE, withheld);
  return (
    <View style={styles.runs} testID={`routine-${routineId}-runs`}>
      <View style={styles.runsHead}>
        <Glyph name="restore" size={12} color={ink.muted} />
        <Kicker color={ink.muted}>{runs.length === 1 ? "1 run" : `${runs.length} runs`}</Kicker>
      </View>

      {runs.length === 0 ? (
        <Body color={ink.muted} testID={`routine-${routineId}-runs-empty`}>
          This routine has not run yet.
        </Body>
      ) : null}

      {visible.map(run => (
        <RunCard
          key={run.id}
          run={run}
          open={openRunId === run.id}
          onToggleRun={onToggleRun}
          onOpenSession={onOpenSession}
        />
      ))}

      {withheld > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${nextPage} more of this routine's ${runs.length} runs`}
          onPress={() => onShowMore(routineId)}
          style={moreStyle}
          testID={`routine-${routineId}-runs-more`}
        >
          <Glyph name="chevron" size={12} color={ink.plain} />
          <Label color={ink.plain}>{`Show ${nextPage} more of ${runs.length}`}</Label>
        </Pressable>
      ) : null}
    </View>
  );
}

function RunCard({
  run,
  open,
  onToggleRun,
  onOpenSession,
}: {
  run: Run;
  open: boolean;
  onToggleRun: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const tone = signal[RUN_STATE_SIGNALS[run.state]];
  const linked = linkedSessionIds(run);
  // Two readings, never one invented: a run with no finish stamp is still
  // running, and saying "ended" of it would be a time this run never reached.
  const timing =
    run.finishedAt === undefined
      ? `started ${formatAge(run.startedAt)} ago, still running`
      : `started ${formatAge(run.startedAt)} ago, ended ${formatAge(run.finishedAt)} ago`;
  const sessions = linked.size === 1 ? "1 linked session" : `${linked.size} linked sessions`;
  return (
    <Surface elevation={0} style={styles.run} testID={`run-${run.id}`}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${RUN_STATE_LABELS[run.state]} run, ${timing}, ${sessions}. ${
          open ? "Hide" : "Show"
        } what each action did`}
        accessibilityState={{ expanded: open }}
        onPress={() => onToggleRun(run.id)}
        style={runHeadStyle}
        testID={`run-${run.id}-toggle`}
      >
        <View style={[styles.bar, { backgroundColor: tone }]} />
        <View style={styles.runCopy}>
          <View style={styles.runHeadline}>
            <Kicker color={tone} testID={`run-${run.id}-state`}>
              {RUN_STATE_LABELS[run.state]}
            </Kicker>
            <Label color={ink.muted} testID={`run-${run.id}-sessions`}>
              {sessions}
            </Label>
          </View>
          <Label color={ink.muted} testID={`run-${run.id}-timing`}>
            {timing}
          </Label>
          {run.error === undefined ? null : (
            <Label color={signal.oxide} testID={`run-${run.id}-error`}>
              {run.error}
            </Label>
          )}
        </View>
        <Glyph name={open ? "up" : "chevron"} size={12} color={ink.faint} />
      </Pressable>

      {!open ? null : run.actions.length === 0 ? (
        // A run can end before any action starts: a singleton skip, or a
        // daemon that went down between the fire and the first host. The
        // header carries the reason, and this says why there is nothing under
        // it rather than leaving the toggle looking broken.
        <View style={styles.runAction} testID={`run-${run.id}-no-actions`}>
          <Body color={ink.muted}>This run ended before any action started.</Body>
        </View>
      ) : (
        run.actions.map(action => (
          <RunActionRow key={action.actionId} run={run} action={action} onOpenSession={onOpenSession} />
        ))
      )}
    </Surface>
  );
}

function RunActionRow({
  run,
  action,
  onOpenSession,
}: {
  run: Run;
  action: ActionRun;
  onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const tone = signal[ACTION_STATE_SIGNALS[action.state]];
  const outcome = outcomeOf(action);
  const sessionId = action.sessionId;
  return (
    <View style={styles.runAction} testID={`run-${run.id}-action-${action.actionId}`}>
      <View style={styles.runCopy}>
        <View style={styles.runHeadline}>
          <Label color={ink.plain}>{action.actionName}</Label>
          <Kicker color={tone} testID={`run-${run.id}-action-${action.actionId}-state`}>
            {ACTION_STATE_LABELS[action.state]}
          </Kicker>
        </View>
        {outcome === undefined ? null : (
          <Body color={action.refusal === undefined && action.error === undefined ? ink.muted : signal.oxide}>
            {outcome}
          </Body>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          sessionId === undefined
            ? `No session to open for ${action.actionName}: this run recorded none for it`
            : `Open the session ${action.actionName} ran in`
        }
        accessibilityState={{ disabled: sessionId === undefined }}
        disabled={sessionId === undefined}
        onPress={sessionId === undefined ? undefined : () => onOpenSession(sessionId)}
        style={sessionId === undefined ? openDisabledStyle : openStyle}
        testID={`run-${run.id}-action-${action.actionId}-open`}
      >
        <Glyph
          name={sessionId === undefined ? "unknown" : "attach"}
          size={13}
          color={sessionId === undefined ? ink.faint : signal.sage}
        />
        <Label color={sessionId === undefined ? ink.faint : signal.sage}>
          {sessionId === undefined ? "No session" : "Open session"}
        </Label>
      </Pressable>
    </View>
  );
}
// Hoisted, so a card's rows do not hand the pressables a fresh style function
// on every render of the screen above them. The structural measurements are
// semantic rhythm jobs rather than picked `space.*` steps, so the card can
// change as one surface when the design system changes.
const runHeadStyle = ({ pressed }: { pressed: boolean }) => [styles.runHead, pressed && styles.pressed];
const moreStyle = ({ pressed }: { pressed: boolean }) => [styles.more, pressed && styles.pressed];
const openStyle = ({ pressed }: { pressed: boolean }) => [styles.open, pressed && styles.pressed];

const styles = StyleSheet.create({
  runs: {
    gap: rhythm.pairGap,
    paddingTop: rhythm.rowGap,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  runsHead: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap },
  run: {
    borderWidth: stroke.hair,
    borderColor: ground.line,
    backgroundColor: ground.surface,
    padding: rhythm.cardPad,
  },
  runHead: { flexDirection: "row", alignItems: "center", gap: rhythm.cardGap, minHeight: rhythm.minTarget },
  /** The state's own colour as a rule down the run's leading edge. */
  bar: { alignSelf: "stretch", width: stroke.heavy },
  runCopy: { flex: 1, minWidth: 0, gap: rhythm.pairGap },
  runHeadline: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: rhythm.cardGap },
  runAction: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: rhythm.minTarget,
    gap: rhythm.cardGap,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  open: {
    minHeight: rhythm.minTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: rhythm.glyphGap,
    paddingHorizontal: rhythm.controlPad,
    backgroundColor: signalWash.sage,
  },
  openDisabled: { backgroundColor: ground.active },
  more: {
    minHeight: rhythm.minTarget,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: rhythm.glyphGap,
  },
  pressed: { backgroundColor: ground.active },
});

const openDisabledStyle = [styles.open, styles.openDisabled];
