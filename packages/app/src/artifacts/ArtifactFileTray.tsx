/**
 * Artifact file tray for listing, filtering, and switching between multiple files.
 *
 * Provides a scannable surface for multiple artifacts produced by a session
 * or located in a browsed directory, with kind badges and direct navigation
 * to the corresponding viewer.
 */

import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Glyph, type GlyphName } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label, Title } from "../design/text.tsx";
import { face, ground, ink, radius, space, stroke } from "../design/tokens.ts";
import type { ArtifactItem, ArtifactKind } from "./types.ts";
import { formatByteSize } from "./types.ts";

export interface ArtifactFileTrayProps {
  artifacts: readonly ArtifactItem[];
  selectedId?: string;
  onSelectArtifact: (artifact: ArtifactItem) => void;
  style?: StyleProp<ViewStyle>;
}

type FilterTab = "all" | "media" | "code" | "html";

function getGlyphForKind(kind: ArtifactKind): GlyphName {
  switch (kind) {
    case "image":
      return "attachment";
    case "video":
      return "resume";
    case "code":
      return "read";
    case "diff":
      return "edit";
    case "html":
      return "browser";
    case "text":
      return "read";
    case "fallback":
      return "unknown";
  }
}

function getKindBadgeLabel(kind: ArtifactKind): string {
  switch (kind) {
    case "image":
      return "IMAGE";
    case "video":
      return "VIDEO";
    case "code":
      return "CODE";
    case "diff":
      return "DIFF";
    case "html":
      return "HTML";
    case "text":
      return "TEXT";
    case "fallback":
      return "FILE";
  }
}

export function ArtifactFileTray({
  artifacts,
  selectedId,
  onSelectArtifact,
  style,
}: ArtifactFileTrayProps): JSX.Element {
  const [filter, setFilter] = useState<FilterTab>("all");

  const filteredArtifacts = useMemo(() => {
    if (filter === "all") return artifacts;
    if (filter === "media") {
      return artifacts.filter(a => a.kind === "image" || a.kind === "video");
    }
    if (filter === "code") {
      return artifacts.filter(a => a.kind === "code" || a.kind === "diff" || a.kind === "text");
    }
    if (filter === "html") {
      return artifacts.filter(a => a.kind === "html");
    }
    return artifacts;
  }, [artifacts, filter]);

  return (
    <View style={[styles.container, style]} testID="artifact-file-tray">
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Title heading numberOfLines={1} style={styles.title}>
            Artifacts
          </Title>
          <View style={styles.countBadge} testID="artifact-tray-count">
            <Text style={styles.countText}>{artifacts.length}</Text>
          </View>
        </View>

        <View style={styles.filterRow}>
          <FilterPill label="All" active={filter === "all"} onPress={() => setFilter("all")} />
          <FilterPill label="Media" active={filter === "media"} onPress={() => setFilter("media")} />
          <FilterPill label="Code & Diffs" active={filter === "code"} onPress={() => setFilter("code")} />
          <FilterPill label="HTML" active={filter === "html"} onPress={() => setFilter("html")} />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.listContent} style={styles.list}>
        {filteredArtifacts.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Label color={ink.muted}>No artifacts matching filter</Label>
          </View>
        ) : (
          filteredArtifacts.map(item => {
            const isSelected = selectedId === item.id;
            return (
              <Pressable
                key={item.id}
                accessibilityLabel={`Open ${item.name}`}
                accessibilityRole="button"
                onPress={() => onSelectArtifact(item)}
                style={[styles.itemRow, isSelected && styles.itemRowSelected]}
                testID={`artifact-tray-item-${item.name}`}
              >
                <View style={styles.glyphBox}>
                  <Glyph name={getGlyphForKind(item.kind)} color={isSelected ? ink.bright : ink.plain} size={14} />
                </View>

                <View style={styles.itemMain}>
                  <Label
                    color={isSelected ? ink.bright : ink.plain}
                    numberOfLines={1}
                    style={styles.itemName}
                  >
                    {item.name}
                  </Label>
                  <View style={styles.badgeRow}>
                    <View style={styles.kindBadge}>
                      <Text style={styles.kindBadgeText}>{getKindBadgeLabel(item.kind)}</Text>
                    </View>
                    {item.byteSize !== undefined ? (
                      <Label color={ink.muted} style={styles.itemSize}>
                        {formatByteSize(item.byteSize)}
                      </Label>
                    ) : null}
                  </View>
                </View>

                <Glyph name="chevron" color={ink.faint} size={11} />
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

function FilterPill({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      accessibilityLabel={`Filter by ${label}`}
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.filterPill, active && styles.filterPillActive]}
    >
      <Text style={[styles.filterPillText, active && styles.filterPillTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  header: {
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: space.snug,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
  },
  countBadge: {
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.pill,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  countText: {
    fontFamily: face.mono,
    fontSize: 11,
    color: ink.muted,
    fontVariant: ["tabular-nums"],
  },
  filterRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  filterPill: {
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  filterPillActive: {
    backgroundColor: ground.active,
    borderColor: ink.muted,
  },
  filterPillText: {
    fontSize: 11,
    color: ink.muted,
  },
  filterPillTextActive: {
    color: ink.bright,
    fontWeight: "600",
  },
  list: {
    maxHeight: 280,
  },
  listContent: {
    paddingVertical: space.hair,
  },
  emptyContainer: {
    padding: space.wide,
    alignItems: "center",
    justifyContent: "center",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  itemRowSelected: {
    backgroundColor: ground.active,
  },
  glyphBox: {
    width: 24,
    alignItems: "center",
    justifyContent: "center",
    marginRight: space.step,
  },
  itemMain: {
    flex: 1,
    marginRight: space.step,
  },
  itemName: {
    fontWeight: "500",
    marginBottom: space.hair,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  kindBadge: {
    paddingHorizontal: space.tight,
    paddingVertical: 1,
    borderRadius: 3,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  kindBadgeText: {
    fontSize: 9,
    fontWeight: "700",
    color: ink.muted,
    letterSpacing: 0.5,
  },
  itemSize: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
});
