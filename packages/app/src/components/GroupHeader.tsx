/**
 * A directory group's header.
 *
 * Collapsed, this is the entire group: a path, a count, and the worst status
 * inside it. That has to be enough on its own, because a phone with 93 groups
 * spends most of its scroll collapsed, and a header that says nothing until
 * opened defeats the point of grouping at all.
 */

import type { JSX } from "react";
import { memo, useCallback } from "react";
import { Pressable, type PressableStateCallbackType, StyleSheet, View } from "react-native";
import { shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Data, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { SessionGroup } from "../session/browser.ts";
import { SESSION_STATUS_SIGNALS, STATUS_LABELS } from "../session/browser.ts";

export interface GroupHeaderProps {
  group: SessionGroup;
  collapsed: boolean;
  onToggle: (cwd: string) => void;
}

/** Memoised for the same reason `SessionRow` is: 93 of these scroll past one list. */
export const GroupHeader = memo(function GroupHeader({ group, collapsed, onToggle }: GroupHeaderProps): JSX.Element {
  const tone = signal[SESSION_STATUS_SIGNALS[group.worstStatus]];
  const toggle = useCallback(() => {
    onToggle(group.cwd);
  }, [onToggle, group.cwd]);

  return (
    <Pressable
      testID={`group-header-${group.cwd}`}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      accessibilityLabel={`${shortenPath(group.cwd, 4)}, ${group.totalCount} sessions, ${STATUS_LABELS[group.worstStatus]}`}
      onPress={toggle}
      style={headerStyle}
    >
      <View style={[styles.dot, { backgroundColor: tone }]} />
      <Glyph name="folder" size={13} color={ink.muted} />
      <Label color={ink.bright} numberOfLines={1} style={styles.path} testID={`group-path-${group.cwd}`}>
        {shortenPath(group.cwd, 4)}
      </Label>
      <Data color={ink.muted} testID={`group-count-${group.cwd}`}>
        {group.totalCount}
      </Data>
      <View style={[styles.chevron, collapsed && styles.chevronCollapsed]}>
        <Glyph name="chevron" size={12} color={ink.faint} />
      </View>
    </Pressable>
  );
});

const headerStyle = ({ pressed }: PressableStateCallbackType) => [styles.header, pressed && styles.headerPressed];

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    paddingHorizontal: space.wide,
    minHeight: TOUCH_TARGET,
    backgroundColor: ground.raised,
    borderBottomWidth: stroke.hair,
    borderTopWidth: stroke.hair,
    borderColor: ground.edge,
  },
  headerPressed: { backgroundColor: ground.active },
  dot: { width: 6, height: 6 },
  path: { flex: 1 },
  chevron: { paddingLeft: space.tight, transform: [{ rotate: "0deg" }] },
  chevronCollapsed: { transform: [{ rotate: "-90deg" }] },
});
