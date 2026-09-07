/**
 * A collapsed group of tool calls, with local expand/collapse.
 *
 * Consecutive read-only tools and bookkeeping calls are collapsed by default into
 * a single quiet summary row. Tapping the row expands the group to show the
 * full member ToolCards.
 */

import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Chip, Divider, Surface, TouchableRipple } from "react-native-paper";
import type { ToolGroupEntry, ToolGroupKind } from "../assistant/grouping.ts";
import { Glyph, type GlyphName } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Title } from "../design/text.tsx";
import { radius, stroke, toolSignal, type as typeScale } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import { ToolCard } from "./ToolCard.tsx";

const GROUP_GLYPHS: Record<ToolGroupKind, GlyphName> = {
  read: "read",
  search: "search",
  fetch: "fetch",
  bookkeeping: "tasks",
};

export function ToolGroupCard({ group }: { group: ToolGroupEntry }): JSX.Element {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const open = userToggled ?? group.expandedDefault;
  const theme = useOmpTheme();
  const { ground, ink } = theme;
  const signalName = toolSignal(group.status);
  const tone = theme.signal[signalName];
  const glyph = GROUP_GLYPHS[group.groupKind] ?? "other";
  const isBookkeeping = group.groupKind === "bookkeeping";

  return (
    <Surface
      mode="flat"
      elevation={0}
      style={[styles.card, { backgroundColor: ground.raised, borderColor: ground.line }]}
      testID={`tool-group-${group.id}`}
    >
      <View style={[styles.rail, { backgroundColor: tone }]} />
      <View style={styles.body}>
        <TouchableRipple
          accessibilityRole="button"
          accessibilityLabel={open ? `Collapse ${group.title}` : `Expand ${group.title}`}
          onPress={() => setUserToggled(!open)}
          testID={`tool-group-toggle-${group.id}`}
          style={styles.headerRipple}
        >
          <View style={styles.head}>
            <Glyph name={glyph} size={13} color={isBookkeeping ? ink.muted : tone} />
            <Title
              numberOfLines={1}
              style={styles.title}
              color={isBookkeeping ? ink.muted : ink.bright}
              testID={`tool-group-title-${group.id}`}
            >
              {group.title}
            </Title>
            <View style={styles.actions}>
              <Chip
                compact
                accessibilityRole="text"
                style={[styles.pill, { backgroundColor: theme.signalWash[signalName], borderColor: tone }]}
                textStyle={[styles.statusText, { color: tone }]}
                testID={`tool-group-status-${group.id}`}
              >
                {group.status.replace("_", " ")}
              </Chip>
              <View style={[styles.chevronWrap, { transform: [{ rotate: open ? "90deg" : "0deg" }] }]}>
                <Glyph name="chevron" size={10} color={ink.muted} />
              </View>
            </View>
          </View>
        </TouchableRipple>

        {open ? (
          <View style={styles.members} testID={`tool-group-members-${group.id}`}>
            <Divider style={styles.divider} />
            {group.entries.map(entry => (
              <ToolCard key={entry.id} entry={entry} />
            ))}
          </View>
        ) : null}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    borderWidth: stroke.hair,
    borderRadius: radius.control,
    overflow: "hidden",
  },
  rail: { width: 3 },
  body: { flex: 1, padding: rhythm.cardPad, gap: rhythm.cardGap },
  headerRipple: {
    borderRadius: radius.control,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.cardGap,
  },
  title: {
    flex: 1,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
  },
  chevronWrap: {
    justifyContent: "center",
    alignItems: "center",
  },
  pill: {
    borderWidth: stroke.hair,
  },
  statusText: {
    ...typeScale.kicker,
    textTransform: "uppercase",
    marginVertical: rhythm.pairGap,
  },
  members: {
    gap: rhythm.cardStack,
  },
  divider: {
    marginBottom: rhythm.cardGap,
  },
});
