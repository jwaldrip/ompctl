/**
 * One session, as a row in the browser.
 *
 * Open and archive are the everyday actions, and they must not read as the
 * same kind of thing. Open is the primary tap target, spans the row, and
 * reads as an affirmative "go here." Archive sits in a fixed corner, is
 * quieter than the row it sits in, and its glyph is a box, not a blade:
 * nothing about it should make a person hesitate the way a delete control
 * would.
 *
 * Delete is the third action and it is deliberately not one of those two. A
 * first press only arms the row: the row's content is replaced by a band
 * naming the session, and only a second press on that band's own control
 * destroys anything. That band puts the destructive control at the leading
 * edge, where the title was, and puts Keep at the trailing edge, under
 * exactly the corner a thumb reaching for archive lands on. So a mis-reach
 * arms at worst, and a second mis-reach cancels.
 *
 * `dormant`, `live-tui`, and `live-ompd` all take you into the session, but
 * they are not the same verb: a dormant session is resumed, a live-ompd one
 * is attached to, and a live terminal session is prompted, because that is
 * all a terminal can accept from here. The label and glyph say which, so the
 * affordance never pretends they are interchangeable.
 */

import type { JSX } from "react";
import { memo, useCallback, useState } from "react";
import { Pressable, type PressableStateCallbackType, StyleSheet, View } from "react-native";
import type { ScopeAccess } from "../console/state.ts";
import { shortenPath } from "../design/format.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { BrowserSession, SessionStatus } from "../session/browser.ts";
import { formatAge, formatBytes, SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

export interface SessionRowProps {
  session: BrowserSession;
  /** Whether the row shows its cwd. Off inside a group, where the header already says it. */
  showCwd?: boolean;
  onOpen: (session: BrowserSession) => void;
  onArchive: (session: BrowserSession) => void;
  onUnarchive: (session: BrowserSession) => void;
  /**
   * Destroy this session's transcript. Called only from the armed band's own
   * control, never from the first press, so a row can reach this exactly
   * once per two deliberate taps.
   */
  onDelete: (session: BrowserSession) => void;
  /**
   * Whether this pairing holds the manage scope deleting spends. `missing`
   * disables the control and names the reason on it rather than hiding it: a
   * control that vanished would leave an operator wondering whether this
   * build can delete at all. `unknown` (an older pairing or daemon that
   * never reported scopes) stays enabled, and the daemon's refusal is what
   * corrects it.
   */
  deleteAccess: ScopeAccess;
  now?: number;
}

const OPEN_GLYPH: Record<SessionStatus, GlyphName> = {
  "live-tui": "send",
  "live-ompd": "attach",
  dormant: "resume",
  archived: "restore",
};

const OPEN_LABEL: Record<SessionStatus, string> = {
  "live-tui": "Prompt",
  "live-ompd": "Attach",
  dormant: "Resume",
  archived: "Restore",
};

/**
 * Memoised, and every closure it hands a `Pressable` is either hoisted to the
 * module or `useCallback`-stable.
 *
 * A row is the unit a list of 534 of them re-renders, so identity is not a
 * micro-optimisation here: the parent re-renders on every socket frame, and
 * without `memo` each frame walks every mounted row's subtree. `memo` only
 * earns that if the props hold still, which is why the three handlers are
 * required to be stable identities (see `FleetScreen`) and why the pressed
 * styles below are module constants rather than arrow functions built per
 * render.
 */
export const SessionRow = memo(function SessionRow({
  session,
  showCwd = false,
  onOpen,
  onArchive,
  onUnarchive,
  onDelete,
  deleteAccess,
  now,
}: SessionRowProps): JSX.Element {
  const tone = signal[SESSION_STATUS_SIGNALS[session.status]];
  const archived = session.status === "archived";
  const name = session.title || "Untitled session";
  /**
   * Whether this row is asking to be confirmed. Local, and the one piece of
   * state a row owns: it is one row's transient question, nothing outside the
   * row consults it, and two rows armed at once harms nobody. It also cannot
   * outlive the row, so a deleted session's armed band cannot land on
   * whatever row takes its place.
   */
  const [armed, setArmed] = useState(false);

  const open = useCallback(() => {
    onOpen(session);
  }, [onOpen, session]);
  const archiveOrRestore = useCallback(() => {
    if (session.status === "archived") {
      onUnarchive(session);
    } else {
      onArchive(session);
    }
  }, [onArchive, onUnarchive, session]);
  const arm = useCallback(() => {
    setArmed(true);
  }, []);
  const keep = useCallback(() => {
    setArmed(false);
  }, []);
  const confirmDelete = useCallback(() => {
    // Disarmed first, so the band cannot be pressed twice while the fleet
    // waits for the daemon's answer and the row is still on screen.
    setArmed(false);
    onDelete(session);
  }, [onDelete, session]);
  const openActionStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.openAction,
      { backgroundColor: signalWash[SESSION_STATUS_SIGNALS[session.status]] },
      pressed && styles.actionPressed,
    ],
    [session.status],
  );

  if (armed) {
    return (
      <View testID={`session-row-${session.id}`} style={styles.row}>
        <View style={[styles.bar, { backgroundColor: signal.oxide }]} />

        <Pressable
          testID={`session-delete-confirm-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${name} permanently`}
          onPress={confirmDelete}
          style={confirmActionStyle}
        >
          <Glyph name="delete" size={13} color={signal.oxide} />
          <Kicker color={signal.oxide}>Delete</Kicker>
        </Pressable>

        <View style={styles.confirmBody}>
          <Label color={ink.bright} numberOfLines={2} testID={`session-delete-prompt-${session.id}`}>
            {`Delete ${name}? Its transcript leaves this machine for good.`}
          </Label>
        </View>

        <Pressable
          testID={`session-delete-cancel-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Keep ${name}`}
          onPress={keep}
          style={keepActionStyle}
        >
          <Kicker color={ink.plain}>Keep</Kicker>
        </Pressable>
      </View>
    );
  }
  return (
    <View testID={`session-row-${session.id}`} style={styles.row}>
      <View style={[styles.bar, { backgroundColor: tone }]} />

      <View style={styles.body}>
        <View style={styles.headline}>
          <Title numberOfLines={1} style={styles.title}>
            {session.title || "Untitled session"}
          </Title>
          <Kicker color={tone} testID={`session-status-${session.id}`}>
            {STATUS_LABELS[session.status]}
          </Kicker>
        </View>

        {showCwd ? (
          <View style={styles.cwdRow}>
            <Glyph name="folder" size={10} color={ink.faint} />
            <Label color={ink.muted} numberOfLines={1} style={styles.cwd}>
              {shortenPath(session.cwd, 3)}
            </Label>
          </View>
        ) : null}

        <View style={styles.readings}>
          <Reading testID={`session-age-${session.id}`} value={formatAge(session.createdAt, now)} label="age" />
          <Reading
            testID={`session-active-${session.id}`}
            value={formatAge(session.lastActiveAt, now)}
            label="active"
          />
          <Reading testID={`session-messages-${session.id}`} value={String(session.messageCount)} label="msgs" />
          <Reading testID={`session-size-${session.id}`} value={formatBytes(session.sizeBytes)} label="size" />
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          testID={`session-open-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${OPEN_LABEL[session.status]} ${session.title}, ${STATUS_LABELS[session.status]}`}
          onPress={open}
          style={openActionStyle}
        >
          <Glyph name={OPEN_GLYPH[session.status]} size={13} color={tone} />
        </Pressable>

        <Pressable
          testID={archived ? `session-unarchive-${session.id}` : `session-archive-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={archived ? `Unarchive ${session.title}` : `Archive ${session.title}`}
          onPress={archiveOrRestore}
          style={archiveActionStyle}
        >
          <Glyph name={archived ? "restore" : "archive"} size={13} color={ink.faint} />
        </Pressable>

        <Pressable
          testID={`session-delete-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={
            deleteAccess === "missing"
              ? `Delete ${name} unavailable: this pairing holds no manage scope`
              : `Delete ${name}`
          }
          accessibilityState={{ disabled: deleteAccess === "missing" }}
          disabled={deleteAccess === "missing"}
          onPress={arm}
          style={deleteActionStyle}
        >
          <Glyph name="delete" size={13} color={deleteAccess === "missing" ? ink.faint : signal.oxide} />
        </Pressable>
      </View>
    </View>
  );
});

function Reading({ value, label, testID }: { value: string; label: string; testID: string }): JSX.Element {
  return (
    <View style={styles.reading}>
      <Data color={ink.plain} testID={testID}>
        {value}
      </Data>
      <Label color={ink.faint} style={styles.readingLabel}>
        {label}
      </Label>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
    minHeight: TOUCH_TARGET,
    // Nothing in this row may paint outside its own box. The actions are
    // siblings that reserve their width, so anything that overflows the body
    // lands underneath them and is silently hidden: a size reading sliced in
    // half by a button reads as a rendering fault, not as a narrow column.
    overflow: "hidden",
  },
  bar: { width: 3 },
  // `minWidth: 0` is what actually lets this shrink. A flex item's minimum is
  // its content by default, so without it the readings below set a floor the
  // body cannot go under, and the overflow is what collides with the actions.
  body: { flex: 1, minWidth: 0, paddingVertical: space.snug, paddingHorizontal: space.wide, gap: space.tight },
  headline: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.snug },
  title: { flexShrink: 1 },
  cwdRow: { flexDirection: "row", alignItems: "center", gap: space.tight },
  cwd: { flex: 1, minWidth: 0 },
  // Wrapping rather than truncating: these are four short facts, and a
  // narrow pane should cost a second line, not a severed number.
  readings: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: space.wide,
    marginTop: space.hair,
  },
  reading: { flexDirection: "row", alignItems: "baseline", gap: space.tight },
  readingLabel: { textTransform: "none" },
  actions: {
    flexDirection: "row",
    alignItems: "stretch",
    borderLeftWidth: stroke.hair,
    borderLeftColor: ground.line,
  },
  openAction: {
    width: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
  },
  archiveAction: {
    width: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  // Separated from archive by a heavier rule than the hairlines elsewhere in
  // this row, because the two controls beside each other are the reversible
  // action and the irreversible one, and the eye needs to be told.
  deleteAction: {
    width: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderLeftWidth: stroke.heavy,
    borderLeftColor: ground.edge,
  },
  // The armed band's own controls. The destructive one sits at the leading
  // edge, where the title was and where no control was before, so no muscle
  // memory reaches it; Keep takes the trailing corner the everyday actions
  // occupy.
  confirmAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.wide,
    justifyContent: "center",
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
  },
  // Shrinkable for the same reason `body` is: the prompt names the session,
  // titles are long, and a name that overflowed would paint under Keep.
  confirmBody: { flex: 1, minWidth: 0, paddingVertical: space.snug, paddingHorizontal: space.wide },
  keepAction: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.wide,
    minWidth: TOUCH_TARGET,
    borderLeftWidth: stroke.hair,
    borderLeftColor: ground.line,
  },
  actionPressed: { backgroundColor: ground.active },
});

// One closure each for the whole app rather than two per row per render. The
// third pressed style is per-row on purpose: its fill is the session's own
// status wash, so it cannot be hoisted without passing the status back in.
const archiveActionStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.archiveAction,
  pressed && styles.actionPressed,
];
const deleteActionStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.deleteAction,
  pressed && styles.actionPressed,
];
const confirmActionStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.confirmAction,
  pressed && styles.actionPressed,
];
const keepActionStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.keepAction,
  pressed && styles.actionPressed,
];
