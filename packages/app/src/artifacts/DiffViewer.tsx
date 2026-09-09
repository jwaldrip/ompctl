/**
 * Unified diff viewer for viewing patch artifacts and file edits.
 *
 * Renders unified diffs with added lines tinted in signalWash.ready and removed
 * lines tinted in signalWash.alarm, with line numbers and hunk headers legible
 * at a glance.
 */

import type { JSX } from "react";
import { useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { computeLineDiff } from "../components/diff.ts";

import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { face, ground, ink, radius, signal, signalWash, space, stroke } from "../design/tokens.ts";
import type { ArtifactItem } from "./types.ts";

export interface DiffViewerProps {
  artifact: ArtifactItem;
  style?: StyleProp<ViewStyle>;
}

interface ParsedDiffLine {
  kind: "add" | "remove" | "context" | "hunk" | "header";
  text: string;
  oldNum?: number;
  newNum?: number;
}

export function DiffViewer({ artifact, style }: DiffViewerProps): JSX.Element {
  const { lines, addCount, removeCount } = useMemo(() => {
    // If oldContent and newContent are supplied, compute using computeLineDiff
    if (artifact.oldContent !== undefined && artifact.newContent !== undefined) {
      const ops = computeLineDiff(artifact.oldContent, artifact.newContent);
      let oldIdx = 1;
      let newIdx = 1;
      let adds = 0;
      let rems = 0;
      const parsed: ParsedDiffLine[] = [];

      for (const op of ops) {
        if (op.type === "added") {
          adds++;
          parsed.push({ kind: "add", text: op.text, newNum: newIdx++ });
        } else if (op.type === "deleted") {
          rems++;
          parsed.push({ kind: "remove", text: op.text, oldNum: oldIdx++ });
        } else {
          parsed.push({ kind: "context", text: op.text, oldNum: oldIdx++, newNum: newIdx++ });
        }
      }
      return { lines: parsed, addCount: adds, removeCount: rems };
    }

    // Otherwise parse standard unified patch string from content
    const raw = artifact.content ?? "";
    const rawLines = raw.split("\n");
    const parsed: ParsedDiffLine[] = [];
    let adds = 0;
    let rems = 0;
    let oldCounter = 1;
    let newCounter = 1;

    for (const line of rawLines) {
      if (line.startsWith("---") || line.startsWith("+++")) {
        parsed.push({ kind: "header", text: line });
      } else if (line.startsWith("@@")) {
        parsed.push({ kind: "hunk", text: line });
        // Try to parse hunk header: @@ -old,count +new,count @@
        const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (match) {
          oldCounter = Number.parseInt(match[1] ?? "1", 10);
          newCounter = Number.parseInt(match[2] ?? "1", 10);
        }
      } else if (line.startsWith("+")) {
        adds++;
        parsed.push({ kind: "add", text: line.slice(1), newNum: newCounter++ });
      } else if (line.startsWith("-")) {
        rems++;
        parsed.push({ kind: "remove", text: line.slice(1), oldNum: oldCounter++ });
      } else {
        const text = line.startsWith(" ") ? line.slice(1) : line;
        parsed.push({ kind: "context", text, oldNum: oldCounter++, newNum: newCounter++ });
      }
    }

    return { lines: parsed, addCount: adds, removeCount: rems };
  }, [artifact.content, artifact.oldContent, artifact.newContent]);

  return (
    <View style={[styles.container, style]} testID="diff-viewer">
      <View style={styles.toolbar}>
        <View style={styles.meta}>
          <Label color={ink.bright} numberOfLines={1} style={styles.filename}>
            {artifact.name}
          </Label>
        </View>

        <View style={styles.stats}>
          <View style={styles.statBadge}>
            <Text style={[styles.statText, { color: signal.ready }]}>+{addCount}</Text>
          </View>
          <View style={styles.statBadge}>
            <Text style={[styles.statText, { color: signal.failed }]}>-{removeCount}</Text>
          </View>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator style={styles.horizontalScroll}>
        <ScrollView style={styles.verticalScroll}>
          <View style={styles.diffTable}>
            {lines.map((line, idx) => {
              if (line.kind === "header") {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff is positional, so line order is the identity
                  <View key={idx} style={styles.headerRow}>
                    <Text style={styles.headerText}>{line.text}</Text>
                  </View>
                );
              }
              if (line.kind === "hunk") {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff is positional, so line order is the identity
                  <View key={idx} style={styles.hunkRow} testID="diff-hunk-header">
                    <Text style={styles.hunkText}>{line.text}</Text>
                  </View>
                );
              }

              const isAdd = line.kind === "add";
              const isRem = line.kind === "remove";

              const rowBg = isAdd ? signalWash.ready : isRem ? signalWash.failed : "transparent";
              const textColor = isAdd ? signal.ready : isRem ? signal.failed : ink.plain;
              const sign = isAdd ? "+" : isRem ? "-" : " ";

              return (
                <View
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff is positional, so line order is the identity
                  key={idx}
                  style={[styles.lineRow, { backgroundColor: rowBg }]}
                  testID={isAdd ? "diff-added-line" : isRem ? "diff-removed-line" : "diff-context-line"}
                >
                  <View style={styles.lineNumberCol}>
                    <Text style={styles.lineNum}>{line.oldNum ?? ""}</Text>
                  </View>
                  <View style={styles.lineNumberCol}>
                    <Text style={styles.lineNum}>{line.newNum ?? ""}</Text>
                  </View>
                  <View style={styles.signCol}>
                    <Text style={[styles.signText, { color: textColor }]}>{sign}</Text>
                  </View>
                  <View style={styles.codeCol}>
                    <Text style={[styles.codeText, { color: textColor }]}>
                      {line.text.length === 0 ? " " : line.text}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

const LINE_HEIGHT = 20;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ground.base,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
    backgroundColor: ground.surface,
  },
  meta: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    flex: 1,
  },
  filename: {
    fontWeight: "600",
  },
  stats: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  statBadge: {
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  statText: {
    fontFamily: face.mono,
    fontSize: 12,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  horizontalScroll: {
    flex: 1,
  },
  verticalScroll: {
    flex: 1,
  },
  diffTable: {
    minWidth: "100%",
  },
  headerRow: {
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    backgroundColor: ground.raised,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  headerText: {
    fontFamily: face.mono,
    fontSize: 11,
    color: ink.muted,
  },
  hunkRow: {
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderBottomWidth: stroke.hair,
    borderColor: ground.line,
  },
  hunkText: {
    fontFamily: face.mono,
    fontSize: 11,
    color: ink.faint,
  },
  lineRow: {
    flexDirection: "row",
    height: LINE_HEIGHT,
    alignItems: "center",
  },
  lineNumberCol: {
    width: 40,
    alignItems: "flex-end",
    paddingRight: space.tight,
  },
  lineNum: {
    fontFamily: face.mono,
    fontSize: 11,
    color: ink.faint,
    fontVariant: ["tabular-nums"],
  },
  signCol: {
    width: 20,
    alignItems: "center",
  },
  signText: {
    fontFamily: face.mono,
    fontSize: 12,
    fontWeight: "600",
  },
  codeCol: {
    flex: 1,
    paddingRight: space.snug,
  },
  codeText: {
    fontFamily: face.mono,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
  },
});
