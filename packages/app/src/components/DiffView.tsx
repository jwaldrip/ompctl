/**
 * Unified diff viewer for file edits.
 *
 * Renders oldText vs newText as a unified diff with a file header, hunk
 * boundaries, line numbers, and +/- gutters tinted with signal washes.
 *
 * Exposes `renderLine` so syntax highlighting can be wired in without
 * changing this container.
 */

import type { JSX, ReactNode } from "react";
import { useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { TouchableRipple } from "react-native-paper";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { face, radius, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import { buildHunks, computeLineDiff, type DiffOp } from "./diff.ts";

/** Lines of diff shown before collapsing. Rationale: one screen on a phone. */
export const DIFF_PREVIEW_LINES = 16;

export interface DiffViewProps {
  path: string;
  oldText: string;
  newText: string;
  /** Optional syntax highlighter hook. Receives line text and detected file extension. */
  renderLine?: (line: string, lang: string | null) => ReactNode;
}

type RenderItem = { kind: "header"; id: string; header: string } | { kind: "line"; id: string; op: DiffOp };

export function DiffView({ path, oldText, newText, renderLine }: DiffViewProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const theme = useOmpTheme();
  const { ground, ink, signal, signalWash } = theme;

  const { dir, basename } = useMemo(() => splitPath(path), [path]);
  const lang = useMemo(() => detectLang(path), [path]);

  const hunks = useMemo(() => {
    const ops = computeLineDiff(oldText, newText);
    return buildHunks(ops);
  }, [oldText, newText]);

  const items = useMemo(() => {
    const flattened: RenderItem[] = [];
    for (let h = 0; h < hunks.length; h += 1) {
      const hunk = hunks[h];
      if (hunk === undefined) continue;
      flattened.push({
        kind: "header",
        id: `hunk-${h}-${hunk.header}`,
        header: hunk.header,
      });
      for (let l = 0; l < hunk.lines.length; l += 1) {
        const op = hunk.lines[l];
        if (op === undefined) continue;
        flattened.push({
          kind: "line",
          id: `line-${h}-${l}-${op.type}-${op.oldLine ?? 0}-${op.newLine ?? 0}`,
          op,
        });
      }
    }
    return flattened;
  }, [hunks]);

  const totalLines = items.length;
  const clamped = !open && totalLines > DIFF_PREVIEW_LINES;
  const visibleItems = clamped ? items.slice(0, DIFF_PREVIEW_LINES) : items;

  return (
    <View style={[styles.container, { backgroundColor: ground.base, borderColor: ground.line }]} testID="diff-view">
      <View
        style={[styles.fileHeader, { backgroundColor: ground.surface, borderColor: ground.line }]}
        testID="diff-file-header"
      >
        <Glyph name="edit" size={11} color={ink.muted} />
        <Text numberOfLines={1} style={styles.headerText}>
          {dir.length > 0 ? <Text style={{ color: ink.muted }}>{dir}</Text> : null}
          <Text style={[styles.basename, { color: ink.bright }]}>{basename}</Text>
        </Text>
      </View>

      {hunks.length === 0 ? (
        <View style={styles.empty} testID="diff-empty">
          <Label color={ink.muted}>No changes</Label>
        </View>
      ) : (
        <View style={styles.content}>
          {visibleItems.map(item => {
            if (item.kind === "header") {
              return (
                <View
                  key={item.id}
                  style={[styles.hunkHeader, { backgroundColor: ground.surface, borderColor: ground.line }]}
                  testID="diff-hunk-header"
                >
                  <Text style={[styles.hunkHeaderText, { color: ink.muted }]}>{item.header}</Text>
                </View>
              );
            }

            const op = item.op;
            const isAdded = op.type === "added";
            const isDeleted = op.type === "deleted";
            const testID = isAdded ? "diff-line-added" : isDeleted ? "diff-line-deleted" : "diff-line-context";

            return (
              <View key={item.id} style={styles.lineRow} testID={testID}>
                <Text style={[styles.lineNumber, { color: ink.faint }]}>
                  {op.oldLine !== undefined ? String(op.oldLine) : " "}
                </Text>
                <Text style={[styles.lineNumber, { color: ink.faint }]}>
                  {op.newLine !== undefined ? String(op.newLine) : " "}
                </Text>
                <View
                  style={[
                    styles.gutter,
                    isAdded && { backgroundColor: signalWash.ready },
                    isDeleted && { backgroundColor: signalWash.failed },
                  ]}
                  testID="diff-gutter"
                >
                  <Text
                    style={[
                      styles.signText,
                      isAdded && { color: signal.ready },
                      isDeleted && { color: signal.failed },
                      !isAdded && !isDeleted && { color: "transparent" },
                    ]}
                  >
                    {isAdded ? "+" : isDeleted ? "-" : " "}
                  </Text>
                </View>
                <View style={styles.codeTextWrapper}>
                  {renderLine !== undefined ? (
                    renderLine(op.text, lang)
                  ) : (
                    <Text
                      style={[
                        styles.codeText,
                        isAdded && { color: ink.bright },
                        isDeleted && { color: ink.muted },
                        !isAdded && !isDeleted && { color: ink.plain },
                      ]}
                    >
                      {op.text}
                    </Text>
                  )}
                </View>
              </View>
            );
          })}

          {totalLines > DIFF_PREVIEW_LINES ? (
            <TouchableRipple
              accessibilityRole="button"
              accessibilityLabel={open ? "Collapse diff" : `Show all ${totalLines} lines`}
              onPress={() => {
                setOpen(!open);
              }}
              style={styles.more}
              testID="diff-expand"
            >
              <View style={styles.moreRow}>
                <Glyph name="chevron" size={10} color={ink.muted} />
                <Label color={ink.muted}>{open ? "collapse" : `Show all ${totalLines} lines`}</Label>
              </View>
            </TouchableRipple>
          ) : null}
        </View>
      )}
    </View>
  );
}

function splitPath(filePath: string): { dir: string; basename: string } {
  const slash = filePath.lastIndexOf("/");
  if (slash < 0) return { dir: "", basename: filePath };
  return {
    dir: filePath.slice(0, slash + 1),
    basename: filePath.slice(slash + 1),
  };
}

function detectLang(filePath: string): string | null {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return null;
  return filePath.slice(dot + 1).toLowerCase();
}

const styles = StyleSheet.create({
  container: {
    borderWidth: stroke.hair,
    borderRadius: radius.control,
    overflow: "hidden",
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
    paddingVertical: 5,
    paddingHorizontal: rhythm.cardPad,
    borderBottomWidth: stroke.hair,
  },
  headerText: {
    fontFamily: face.mono,
    fontSize: 12,
    flex: 1,
  },
  basename: {
    fontFamily: face.monoMedium,
    fontWeight: "600",
  },
  empty: {
    padding: rhythm.cardPad,
    alignItems: "center",
  },
  content: {
    flexDirection: "column",
  },
  hunkHeader: {
    paddingVertical: 2,
    paddingHorizontal: rhythm.cardPad,
    borderTopWidth: stroke.hair,
    borderBottomWidth: stroke.hair,
  },
  hunkHeaderText: {
    fontFamily: face.mono,
    fontSize: 10,
    letterSpacing: 0.2,
  },
  lineRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 18,
  },
  lineNumber: {
    width: 28,
    textAlign: "right",
    fontFamily: face.mono,
    fontSize: 10,
    paddingRight: 4,
  },
  gutter: {
    width: 18,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
  },
  signText: {
    fontFamily: face.monoMedium,
    fontSize: 11,
    fontWeight: "bold",
    textAlign: "center",
  },
  codeTextWrapper: {
    flex: 1,
    paddingLeft: 6,
    paddingRight: rhythm.cardPad,
    justifyContent: "center",
  },
  codeText: {
    fontFamily: face.mono,
    fontSize: 11,
    lineHeight: 16,
  },
  more: {
    minHeight: rhythm.minTarget,
    justifyContent: "center",
    paddingHorizontal: rhythm.cardPad,
    borderTopWidth: stroke.hair,
    borderTopColor: "rgba(255,255,255,0.05)",
  },
  moreRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
  },
});
