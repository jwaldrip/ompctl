/**
 * The sort control.
 *
 * A list whose order you cannot name is a list you do not trust: this is the
 * one place the active field and its direction are always on screen, not
 * tucked behind a menu that has to be opened to be checked. Tapping a chip
 * that is already active flips its direction; tapping another chip switches
 * to it.
 *
 * The chips scroll rather than clip. At accessibility type sizes the row can
 * outgrow even the fleet bay's floor, and the escape is a swipe, never a
 * label cut at the pane edge.
 */

import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet } from "react-native";
import { Data, Kicker } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { SortField, SortSpec } from "../session/browser.ts";
import { SORT_LABELS } from "../session/browser.ts";

const FIELDS: readonly SortField[] = ["status", "age", "lastActive", "messageCount", "size"];

/**
 * Each label's advance in the bar's own face: the vendored Archivo-Medium at
 * the kicker's 11 points with its 1.1 tracking, upper case as the bar renders
 * it (measured with CoreText against the font in src/design/fonts). A field
 * added to FIELDS must be measured here or the Record's type errors, which is
 * the point of spelling the entries out.
 */
const LABEL_ADVANCES: Record<SortField, number> = {
  status: 48.56,
  age: 26.95,
  lastActive: 81.83,
  messageCount: 71.28,
  size: 29.18,
};

/** The active chip's direction arrow, IBM Plex Mono Medium at 13 points. */
const ARROW_ADVANCE = 8;

/**
 * Everything the bar needs to lie flat at the default type size: every label,
 * the arrow, each chip's padding, the gaps between chips and around the
 * arrow, and the row's own leading and trailing padding. Spacing reads the
 * tokens, so a spacing change re-prices this without an edit here. The fleet
 * bay's floor (`SPLIT_BAY_MIN` in design/layout.ts) must be at least this
 * wide, and `test/no-hidden-content.test.ts` pins that it stays so: a fixed
 * 340-point bay is what cut SIZE down to a bare S at the pane edge. Re-measure
 * the labels when wording changes; that test fails until the floor follows.
 */
export const SORT_BAR_CONTENT_WIDTH = Math.ceil(
  FIELDS.reduce((total, field) => total + LABEL_ADVANCES[field], 0) +
    ARROW_ADVANCE +
    FIELDS.length * (space.snug * 2) +
    (FIELDS.length - 1) * space.tight +
    space.tight +
    space.snug * 2,
);

export interface SortBarProps {
  sort: SortSpec;
  onChange: (field: SortField) => void;
}

export function SortBar({ sort, onChange }: SortBarProps): JSX.Element {
  return (
    <ScrollView
      testID="sort-bar"
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      {FIELDS.map(field => {
        const active = sort.field === field;
        return (
          <Pressable
            key={field}
            testID={`sort-chip-${field}`}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={
              active
                ? `Sort by ${SORT_LABELS[field]}, ${sort.direction === "asc" ? "ascending" : "descending"}`
                : `Sort by ${SORT_LABELS[field]}`
            }
            onPress={() => {
              onChange(field);
            }}
            style={({ pressed }) => [
              styles.chip,
              active && styles.chipActive,
              pressed && { backgroundColor: ground.active },
            ]}
          >
            <Kicker color={active ? signal.amber : ink.muted}>{SORT_LABELS[field]}</Kicker>
            {active ? (
              <Data color={signal.amber} testID={`sort-direction-${field}`}>
                {sort.direction === "asc" ? "\u2191" : "\u2193"}
              </Data>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { borderBottomWidth: stroke.hair, borderBottomColor: ground.line, backgroundColor: ground.surface },
  row: { flexDirection: "row", paddingHorizontal: space.snug, gap: space.tight },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    height: TOUCH_TARGET,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  chipActive: { borderBottomColor: signal.amber },
});
