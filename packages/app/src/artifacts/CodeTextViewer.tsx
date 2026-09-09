/**
 * Monospace code and text viewer with line numbers and virtualization.
 *
 * Handles large files (e.g. 20,000 lines) with a fixed-height windowed FlatList
 * so memory stays bounded. Horizontal scrolling is isolated so it does not
 * capture vertical gestures.
 */

import Clipboard from "@react-native-clipboard/clipboard";
import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";
import type { ListRenderItemInfo, StyleProp, ViewStyle } from "react-native";
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { face, ground, ink, radius, space, stroke } from "../design/tokens.ts";
import type { ArtifactItem } from "./types.ts";
import { formatByteSize } from "./types.ts";

export interface CodeTextViewerProps {
  artifact: ArtifactItem;
  style?: StyleProp<ViewStyle>;
}

const LINE_HEIGHT = 20;

interface LineItem {
  index: number;
  text: string;
}

export function CodeTextViewer({ artifact, style }: CodeTextViewerProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const rawText = artifact.content ?? "";

  const lines = useMemo<LineItem[]>(() => {
    if (rawText.length === 0) return [];
    const split = rawText.split("\n");
    return split.map((text, index) => ({ index: index + 1, text }));
  }, [rawText]);

  const totalLines = lines.length;
  const lineCountLabel = `${totalLines.toLocaleString()} lines`;

  // Dynamic width for line number gutter depending on digits
  const gutterWidth = useMemo(() => {
    const digits = Math.max(2, String(totalLines).length);
    return Math.max(36, digits * 9 + space.snug);
  }, [totalLines]);

  const handleCopy = useCallback(() => {
    Clipboard.setString(rawText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [rawText]);

  const getItemLayout = useCallback(
    (_: unknown, index: number) => ({
      length: LINE_HEIGHT,
      offset: LINE_HEIGHT * index,
      index,
    }),
    [],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<LineItem>) => {
      return (
        <View style={styles.row} testID="code-line-item">
          <View style={[styles.gutter, { width: gutterWidth }]} testID="code-line-numbers">
            <Text style={styles.lineNumber}>{item.index}</Text>
          </View>
          <ScrollView
            directionalLockEnabled
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator={false}
            style={styles.lineScroll}
          >
            <Text style={styles.codeText}>{item.text.length === 0 ? " " : item.text}</Text>
          </ScrollView>
        </View>
      );
    },
    [gutterWidth],
  );

  return (
    <View style={[styles.container, style]} testID="code-text-viewer">
      <View style={styles.toolbar}>
        <View style={styles.meta}>
          <Label color={ink.bright} numberOfLines={1} style={styles.filename}>
            {artifact.name}
          </Label>
          <Label color={ink.muted} style={styles.lineCount} testID="code-line-count">
            {lineCountLabel}
          </Label>
          {artifact.byteSize !== undefined ? (
            <Label color={ink.faint} style={styles.size}>
              {formatByteSize(artifact.byteSize)}
            </Label>
          ) : null}
        </View>

        <Pressable
          accessibilityLabel={copied ? "Copied" : "Copy code"}
          accessibilityRole="button"
          onPress={handleCopy}
          style={styles.copyButton}
          testID="code-copy-button"
        >
          <Glyph name="copy" color={copied ? ink.bright : ink.plain} size={12} />
          <Label color={copied ? ink.bright : ink.plain} style={styles.copyText}>
            {copied ? "Copied" : "Copy"}
          </Label>
        </Pressable>
      </View>

      <FlatList
        data={lines}
        getItemLayout={getItemLayout}
        initialNumToRender={40}
        keyExtractor={item => String(item.index)}
        maxToRenderPerBatch={40}
        renderItem={renderItem}
        style={styles.list}
        windowSize={5}
      />
    </View>
  );
}

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
    marginRight: space.step,
  },
  filename: {
    fontWeight: "600",
  },
  lineCount: {
    fontVariant: ["tabular-nums"],
    fontSize: 12,
  },
  size: {
    fontVariant: ["tabular-nums"],
    fontSize: 12,
  },
  copyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  copyText: {
    fontSize: 12,
    fontWeight: "500",
  },
  list: {
    flex: 1,
    backgroundColor: ground.base,
  },
  row: {
    flexDirection: "row",
    height: LINE_HEIGHT,
    alignItems: "center",
  },
  gutter: {
    alignItems: "flex-end",
    paddingRight: space.snug,
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
    backgroundColor: ground.surface,
    height: LINE_HEIGHT,
    justifyContent: "center",
  },
  lineNumber: {
    fontFamily: face.mono,
    fontSize: 11,
    color: ink.faint,
    fontVariant: ["tabular-nums"],
  },
  lineScroll: {
    flex: 1,
    paddingLeft: space.snug,
    height: LINE_HEIGHT,
  },
  codeText: {
    fontFamily: face.mono,
    fontSize: 12,
    lineHeight: LINE_HEIGHT,
    color: ink.bright,
  },
});
