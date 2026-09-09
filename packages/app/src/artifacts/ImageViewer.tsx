/**
 * Image viewer with fit, zoom, and pan controls.
 *
 * Designed for inspecting screenshots (e.g. 3x on a 390pt screen), diagrams,
 * and generated assets.
 */

import type { JSX } from "react";
import { useMemo, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Image, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Body, Label } from "../design/text.tsx";
import { ground, ink, radius, space, stroke } from "../design/tokens.ts";
import type { ArtifactItem } from "./types.ts";
import { formatByteSize } from "./types.ts";

export interface ImageViewerProps {
  artifact: ArtifactItem;
  style?: StyleProp<ViewStyle>;
}

const ZOOM_STEPS = [0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

export function ImageViewer({ artifact, style }: ImageViewerProps): JSX.Element {
  const [zoomIndex, setZoomIndex] = useState(2); // 1.0 (100%) by default

  const currentScale = ZOOM_STEPS[zoomIndex] ?? 1;

  const imageUri = useMemo(() => {
    if (artifact.url) return artifact.url;
    if (artifact.content) {
      if (artifact.content.startsWith("data:")) return artifact.content;
      return `data:${artifact.contentType};base64,${artifact.content}`;
    }
    return "";
  }, [artifact.url, artifact.content, artifact.contentType]);

  const canZoomIn = zoomIndex < ZOOM_STEPS.length - 1;
  const canZoomOut = zoomIndex > 0;

  const handleZoomIn = () => {
    if (canZoomIn) setZoomIndex(i => i + 1);
  };

  const handleZoomOut = () => {
    if (canZoomOut) setZoomIndex(i => i - 1);
  };

  const handleReset = () => {
    setZoomIndex(2); // reset to 1.0
  };

  const zoomPercent = `${Math.round(currentScale * 100)}%`;

  return (
    <View style={[styles.container, style]} testID="image-viewer">
      <View style={styles.toolbar}>
        <View style={styles.meta}>
          <Label color={ink.bright} numberOfLines={1} style={styles.filename}>
            {artifact.name}
          </Label>
          {artifact.byteSize !== undefined ? (
            <Label color={ink.muted} style={styles.size}>
              {formatByteSize(artifact.byteSize)}
            </Label>
          ) : null}
        </View>

        <View style={styles.controls}>
          <Pressable
            accessibilityLabel="Zoom out"
            accessibilityRole="button"
            disabled={!canZoomOut}
            onPress={handleZoomOut}
            style={[styles.button, !canZoomOut && styles.buttonDisabled]}
            testID="image-zoom-out"
          >
            <Glyph name="search" color={canZoomOut ? ink.bright : ink.faint} size={12} />
            <Label color={canZoomOut ? ink.bright : ink.faint} style={styles.buttonLabel}>
              -
            </Label>
          </Pressable>

          <View style={styles.zoomPill} testID="image-zoom-level">
            <Label color={ink.plain} style={styles.zoomText}>
              {zoomPercent}
            </Label>
          </View>

          <Pressable
            accessibilityLabel="Zoom in"
            accessibilityRole="button"
            disabled={!canZoomIn}
            onPress={handleZoomIn}
            style={[styles.button, !canZoomIn && styles.buttonDisabled]}
            testID="image-zoom-in"
          >
            <Glyph name="search" color={canZoomIn ? ink.bright : ink.faint} size={12} />
            <Label color={canZoomIn ? ink.bright : ink.faint} style={styles.buttonLabel}>
              +
            </Label>
          </Pressable>

          <Pressable
            accessibilityLabel="Reset zoom to fit"
            accessibilityRole="button"
            onPress={handleReset}
            style={styles.button}
            testID="image-zoom-reset"
          >
            <Glyph name="restore" color={ink.plain} size={12} />
            <Label color={ink.plain} style={styles.buttonLabel}>
              Fit
            </Label>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollVertical}
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        showsVerticalScrollIndicator
        style={styles.viewport}
      >
        <ScrollView
          contentContainerStyle={styles.scrollHorizontal}
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
        >
          <View style={[styles.imageWrapper, { transform: [{ scale: currentScale }] }]}>
            {imageUri.length > 0 ? (
              <Image
                accessibilityLabel={artifact.name}
                resizeMode="contain"
                source={{ uri: imageUri }}
                style={styles.image}
                testID="image-viewer-image"
              />
            ) : (
              <View style={styles.emptyState}>
                <Body color={ink.muted}>No image content available</Body>
              </View>
            )}
          </View>
        </ScrollView>
      </ScrollView>
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
  size: {
    fontVariant: ["tabular-nums"],
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: 28,
    minWidth: 32,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    justifyContent: "center",
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonLabel: {
    fontSize: 12,
    fontWeight: "600",
  },
  zoomPill: {
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    minWidth: 44,
    alignItems: "center",
  },
  zoomText: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  viewport: {
    flex: 1,
    backgroundColor: ground.base,
  },
  scrollVertical: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  scrollHorizontal: {
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  imageWrapper: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.step,
  },
  image: {
    minWidth: 320,
    minHeight: 320,
    maxWidth: 1200,
    maxHeight: 1200,
  },
  emptyState: {
    padding: space.wide,
    alignItems: "center",
    justifyContent: "center",
  },
});
