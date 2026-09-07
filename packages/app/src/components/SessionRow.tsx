/**
 * One session, as a row in the browser.
 *
 * Tapping the row opens it. At rest, the trailing edge presents a single More
 * control (ellipsis glyph) that opens a menu containing Archive/Unarchive and
 * Delete.
 *
 * Delete arms an inline confirmation band with Delete on the leading edge and
 * Keep on the trailing edge. A second tap on Delete destroys the transcript;
 * Keep disarms the row.
 *
 * On compact screens (phones), the metrics line fits on one line by omitting
 * size, displaying age, active time, messages, and spend when cost is reported.
 * Full size readings display on tablets where width permits.
 */

import type { JSX } from "react";
import { memo, useCallback, useState } from "react";
import { Pressable, type PressableStateCallbackType, StyleSheet, View } from "react-native";
import type { ScopeAccess } from "../console/state.ts";
import { shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
import { Data, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { BrowserSession, SessionStatus } from "../session/browser.ts";
import { formatAge, formatBytes, SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

/**
 * Status tone bar width at the leading edge of each row.
 * Thin enough to avoid visual clutter while providing immediate status recognition.
 */
const STATUS_BAR_WIDTH = 3;

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
   * disables the control and names the reason on it rather than hiding it.
   */
  deleteAccess: ScopeAccess;
  now?: number;
  /** Injected initial menu open state for tests */
  defaultMenuOpen?: boolean;
}

const OPEN_LABEL: Record<SessionStatus, string> = {
  "live-tui": "Prompt",
  "live-ompd": "Attach",
  dormant: "Resume",
  archived: "Restore",
};

/**
 * Format spend amount for the metrics line: $0.42 for typical costs,
 * with up to four digits for sub-cent turns.
 */
export function formatCostReading(cost: number): string {
  if (!Number.isFinite(cost)) return "--";
  const digits = cost > 0 && cost < 0.01 ? 4 : 2;
  return `$${cost.toFixed(digits)}`;
}

export const SessionRow = memo(function SessionRow({
  session,
  showCwd = false,
  onOpen,
  onArchive,
  onUnarchive,
  onDelete,
  deleteAccess,
  now,
  defaultMenuOpen = false,
}: SessionRowProps): JSX.Element {
  const isTablet = useIsTablet();
  const tone = signal[SESSION_STATUS_SIGNALS[session.status]];
  const archived = session.status === "archived";
  const name = session.title || "Untitled session";

  const [armed, setArmed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(defaultMenuOpen);

  const open = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false);
      return;
    }
    onOpen(session);
  }, [menuOpen, onOpen, session]);

  const archiveOrRestore = useCallback(() => {
    setMenuOpen(false);
    if (session.status === "archived") {
      onUnarchive(session);
    } else {
      onArchive(session);
    }
  }, [onArchive, onUnarchive, session]);

  const arm = useCallback(() => {
    setMenuOpen(false);
    setArmed(true);
  }, []);

  const keep = useCallback(() => {
    setArmed(false);
  }, []);

  const confirmDelete = useCallback(() => {
    setArmed(false);
    onDelete(session);
  }, [onDelete, session]);

  if (armed) {
    return (
      <View testID={`session-row-${session.id}`} style={styles.row}>
        <View style={[styles.bar, { backgroundColor: signal.failed }]} />

        <Pressable
          testID={`session-delete-confirm-${session.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${name} permanently`}
          onPress={confirmDelete}
          style={confirmActionStyle}
        >
          <Glyph name="delete" size={13} color={signal.failed} />
          <Kicker color={signal.failed}>Delete</Kicker>
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
      <Pressable
        testID={`session-open-${session.id}`}
        accessibilityRole="button"
        accessibilityLabel={`${OPEN_LABEL[session.status]} ${name}, ${STATUS_LABELS[session.status]}`}
        onPress={open}
        style={openTargetStyle}
      >
        <View style={[styles.bar, { backgroundColor: tone }]} />

        <View style={styles.body}>
          <View style={styles.headline}>
            <Title numberOfLines={1} style={styles.title}>
              {name}
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

          <View style={styles.readings} testID={`session-metrics-${session.id}`}>
            <Reading testID={`session-age-${session.id}`} value={formatAge(session.createdAt, now)} label="age" />
            <Reading
              testID={`session-active-${session.id}`}
              value={formatAge(session.lastActiveAt, now)}
              label="active"
            />
            <Reading testID={`session-messages-${session.id}`} value={String(session.messageCount)} label="msgs" />
            {session.cost != null ? (
              <Reading
                testID={`session-spend-${session.id}`}
                value={formatCostReading(session.cost)}
                label="spend"
              />
            ) : null}
            {isTablet ? (
              <Reading testID={`session-size-${session.id}`} value={formatBytes(session.sizeBytes)} label="size" />
            ) : null}
          </View>
        </View>
      </Pressable>

      <View style={styles.actions}>
        {menuOpen ? (
          <View style={styles.menuActions} testID={`session-menu-${session.id}`}>
            <Pressable
              testID={archived ? `session-unarchive-${session.id}` : `session-archive-${session.id}`}
              accessibilityRole="button"
              accessibilityLabel={archived ? `Unarchive ${name}` : `Archive ${name}`}
              onPress={archiveOrRestore}
              style={menuItemStyle}
            >
              <Glyph name={archived ? "restore" : "archive"} size={13} color={ink.plain} />
              <Label color={ink.plain}>{archived ? "Restore" : "Archive"}</Label>
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
              style={menuItemStyle}
            >
              <Glyph name="delete" size={13} color={deleteAccess === "missing" ? ink.faint : signal.failed} />
              <Label color={deleteAccess === "missing" ? ink.faint : signal.failed}>Delete</Label>
            </Pressable>

            <Pressable
              testID={`session-more-${session.id}`}
              accessibilityRole="button"
              accessibilityLabel={`Close menu for ${name}`}
              onPress={() => setMenuOpen(false)}
              style={moreActionStyle}
            >
              <Glyph name="deny" size={11} color={ink.muted} />
            </Pressable>
          </View>
        ) : (
          <Pressable
            testID={`session-more-${session.id}`}
            accessibilityRole="button"
            accessibilityLabel={`More for ${name}`}
            onPress={() => setMenuOpen(true)}
            style={moreActionStyle}
          >
            <Glyph name="activity" size={13} color={ink.faint} />
          </Pressable>
        )}
      </View>
    </View>
  );
});

function Reading({ value, label, testID }: { value: string; label: string; testID: string }): JSX.Element {
  return (
    <View style={styles.reading}>
      <Data color={ink.plain} testID={testID} numberOfLines={1}>
        {value}
      </Data>
      <Label color={ink.faint} style={styles.readingLabel} numberOfLines={1}>
        {label}
      </Label>
    </View>
  );
}

const openTargetStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.openTarget,
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

const moreActionStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.moreAction,
  pressed && styles.actionPressed,
];

const menuItemStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.menuItem,
  pressed && styles.actionPressed,
];

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
    minHeight: TOUCH_TARGET,
    overflow: "hidden",
  },
  openTarget: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
    minWidth: 0,
  },
  bar: {
    width: STATUS_BAR_WIDTH,
  },
  body: {
    flex: 1,
    minWidth: 0,
    paddingVertical: space.snug,
    paddingHorizontal: space.wide,
    gap: space.tight,
  },
  headline: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.snug,
  },
  title: {
    flexShrink: 1,
  },
  cwdRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  cwd: {
    flex: 1,
    minWidth: 0,
  },
  readings: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: space.snug,
    marginTop: space.hair,
    overflow: "hidden",
  },
  reading: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: space.tight,
  },
  readingLabel: {
    textTransform: "none",
  },
  actions: {
    flexDirection: "row",
    alignItems: "stretch",
    borderLeftWidth: stroke.hair,
    borderLeftColor: ground.line,
  },
  moreAction: {
    width: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  menuActions: {
    flexDirection: "row",
    alignItems: "stretch",
    backgroundColor: ground.surface,
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    minHeight: TOUCH_TARGET,
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
  },
  confirmAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.wide,
    justifyContent: "center",
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
  },
  confirmBody: {
    flex: 1,
    minWidth: 0,
    paddingVertical: space.snug,
    paddingHorizontal: space.wide,
  },
  keepAction: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.wide,
    minWidth: TOUCH_TARGET,
    borderLeftWidth: stroke.hair,
    borderLeftColor: ground.line,
  },
  actionPressed: {
    backgroundColor: ground.active,
  },
});
