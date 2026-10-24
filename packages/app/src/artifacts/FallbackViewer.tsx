/**
 * Fallback viewer for unrecognized binary or non-previewable file types.
 *
 * Honestly names the file name, detected MIME type, and size, and provides
 * options to open in an external application or share the file, never leaving
 * a blank screen.
 */

import type { JSX } from "react";
import { useCallback } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Body, Label, Title } from "../design/text.tsx";
import { ground, ink, radius, space, stroke } from "../design/tokens.ts";
import type { ArtifactItem } from "./types.ts";
import { formatByteSize } from "./types.ts";

export interface FallbackViewerProps {
  artifact: ArtifactItem;
  style?: StyleProp<ViewStyle>;
}

export function FallbackViewer({ artifact, style }: FallbackViewerProps): JSX.Element {
  const handleOpen = useCallback(() => {
    if (artifact.url) {
      void Linking.openURL(artifact.url);
    }
  }, [artifact.url]);

  const handleShare = useCallback(() => {
    if (artifact.url) {
      void Share.share({
        title: artifact.name,
        url: artifact.url,
        message: `Artifact: ${artifact.name}`,
      });
    }
  }, [artifact.url, artifact.name]);

  return (
    <View style={[styles.container, style]} testID="fallback-viewer">
      <View style={styles.card}>
        <View style={styles.iconCircle}>
          <Glyph name="unknown" color={ink.muted} size={28} />
        </View>

        <Title heading numberOfLines={2} style={styles.filename} testID="fallback-filename">
          {artifact.name}
        </Title>

        <View style={styles.metaRow}>
          <Label color={ink.muted} style={styles.metaText} testID="fallback-type">
            {artifact.contentType || "Unknown file type"}
          </Label>
          <Label color={ink.faint} style={styles.metaDivider}>
            •
          </Label>
          <Label color={ink.muted} style={styles.metaText} testID="fallback-size">
            {formatByteSize(artifact.byteSize)}
          </Label>
        </View>

        <Body color={ink.faint} style={styles.description}>
          This file format cannot be rendered inline in ompctl. You can open it in an
          external system app or share it to another device.
        </Body>

        <View style={styles.actionRow}>
          <Pressable
            accessibilityLabel="Open with external application"
            accessibilityRole="button"
            onPress={handleOpen}
            style={styles.primaryButton}
            testID="fallback-open-button"
          >
            <Glyph name="link" color={ink.inverse} size={14} />
            <Label color={ink.inverse} style={styles.primaryButtonText}>
              Open in external app
            </Label>
          </Pressable>

          <Pressable
            accessibilityLabel="Share file"
            accessibilityRole="button"
            onPress={handleShare}
            style={styles.secondaryButton}
            testID="fallback-share-button"
          >
            <Glyph name="attachment" color={ink.bright} size={14} />
            <Label color={ink.bright} style={styles.secondaryButtonText}>
              Share
            </Label>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ground.base,
    alignItems: "center",
    justifyContent: "center",
    padding: rhythm.gutter,
  },
  card: {
    maxWidth: 440,
    width: "100%",
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    borderRadius: radius.surface,
    padding: rhythm.sectionGap,
    alignItems: "center",
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.step,
  },
  filename: {
    textAlign: "center",
    marginBottom: space.snug,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    marginBottom: space.step,
  },
  metaText: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  metaDivider: {
    fontSize: 12,
  },
  description: {
    textAlign: "center",
    marginBottom: space.loose,
    paddingHorizontal: space.snug,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    width: "100%",
    justifyContent: "center",
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    minHeight: 38,
    paddingHorizontal: space.wide,
    paddingVertical: space.snug,
    borderRadius: radius.control,
    backgroundColor: ink.bright,
  },
  primaryButtonText: {
    fontSize: 13,
    fontWeight: "600",
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    minHeight: 38,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: "500",
  },
});
