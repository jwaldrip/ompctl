/**
 * One session, as a row in the browser.
 *
 * Open and archive are the two actions, and they must not read as the same
 * kind of thing. Open is the primary tap target, spans the row, and reads as
 * an affirmative "go here." Archive sits in a fixed corner, is quieter than
 * the row it sits in, and its glyph is a box, not a blade: nothing about it
 * should make a person hesitate the way a delete control would.
 *
 * `dormant`, `live-tui`, and `live-ompd` all take you into the session, but
 * they are not the same verb: a dormant session is resumed, a live-ompd one
 * is attached to, and a live terminal session is prompted, because that is
 * all a terminal can accept from here. The label and glyph say which, so the
 * affordance never pretends they are interchangeable.
 */

import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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

export function SessionRow({
  session,
  showCwd = false,
  onOpen,
  onArchive,
  onUnarchive,
  now,
}: SessionRowProps): JSX.Element {
  const tone = signal[SESSION_STATUS_SIGNALS[session.status]];
  const archived = session.status === "archived";

  return (
    <View testID={`session-row-${session.id}`} style={styles.row}>
      <View style={[styles.bar, { backgroundColor: tone }]} />

      <Pressable
        testID={`session-open-${session.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${OPEN_LABEL[session.status]} ${session.title}, ${STATUS_LABELS[session.status]}`}
        onPress={() => {
          onOpen(session);
        }}
        style={({ pressed }) => [styles.body, pressed && { backgroundColor: ground.active }]}
      >
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
      </Pressable>

      <View style={styles.actions}>
        <Pressable
          testID={`session-open-action-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={`${OPEN_LABEL[session.status]} ${session.title}`}
          onPress={() => {
            onOpen(session);
          }}
          style={({ pressed }) => [
            styles.openAction,
            { backgroundColor: signalWash[SESSION_STATUS_SIGNALS[session.status]] },
            pressed && styles.actionPressed,
          ]}
        >
          <Glyph name={OPEN_GLYPH[session.status]} size={13} color={tone} />
        </Pressable>

        <Pressable
          testID={archived ? `session-unarchive-${session.id}` : `session-archive-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={archived ? `Unarchive ${session.title}` : `Archive ${session.title}`}
          onPress={() => {
            if (archived) {
              onUnarchive(session);
            } else {
              onArchive(session);
            }
          }}
          style={({ pressed }) => [styles.archiveAction, pressed && styles.actionPressed]}
        >
          <Glyph name={archived ? "restore" : "archive"} size={13} color={ink.faint} />
        </Pressable>
      </View>
    </View>
  );
}

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
  },
  bar: { width: 3 },
  body: { flex: 1, paddingVertical: space.snug, paddingHorizontal: space.wide, gap: space.tight },
  headline: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: space.snug },
  title: { flexShrink: 1 },
  cwdRow: { flexDirection: "row", alignItems: "center", gap: space.tight },
  cwd: { flex: 1 },
  readings: { flexDirection: "row", alignItems: "center", gap: space.wide, marginTop: space.hair },
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
  actionPressed: { backgroundColor: ground.active },
});
