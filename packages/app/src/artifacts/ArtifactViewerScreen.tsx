/**
 * Screen for viewing an artifact with the appropriate viewer surface,
 * with navigation back and an optional file tray to jump between multiple files.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Label, Title } from "../design/text.tsx";
import { ground, ink, radius, space, stroke } from "../design/tokens.ts";
import { ArtifactFileTray } from "./ArtifactFileTray.tsx";
import { CodeTextViewer } from "./CodeTextViewer.tsx";
import { DiffViewer } from "./DiffViewer.tsx";
import { FallbackViewer } from "./FallbackViewer.tsx";
import { fetchArtifactContent } from "./fetchSeam.ts";
import { HtmlViewer } from "./HtmlViewer.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import type { ArtifactItem } from "./types.ts";
import { formatByteSize } from "./types.ts";
import { VideoViewer } from "./VideoViewer.tsx";

export interface ArtifactViewerScreenProps {
  artifact: ArtifactItem;
  artifacts?: readonly ArtifactItem[];
  onBack: () => void;
  onSelectArtifact?: (artifact: ArtifactItem) => void;
}

export function ArtifactViewerScreen({
  artifact: initialArtifact,
  artifacts,
  onBack,
  onSelectArtifact,
}: ArtifactViewerScreenProps): JSX.Element {
  const [activeArtifact, setActiveArtifact] = useState<ArtifactItem>(initialArtifact);
  const [trayOpen, setTrayOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Sync if prop changes
  useEffect(() => {
    setActiveArtifact(initialArtifact);
  }, [initialArtifact]);

  // If text or code artifact needs content fetching
  useEffect(() => {
    let cancelled = false;
    async function loadContentIfNeeded() {
      if (
        (activeArtifact.kind === "code" ||
          activeArtifact.kind === "text" ||
          activeArtifact.kind === "diff" ||
          activeArtifact.kind === "html") &&
        activeArtifact.content === undefined &&
        activeArtifact.url !== undefined
      ) {
        setLoading(true);
        try {
          const res = await fetchArtifactContent(activeArtifact);
          if (!cancelled && typeof res.data === "string") {
            setActiveArtifact(prev => ({
              ...prev,
              content: res.data as string,
              byteSize: res.sizeBytes ?? prev.byteSize,
            }));
          }
        } catch {
          // Keep artifact as is if fetch fails
        } finally {
          if (!cancelled) setLoading(false);
        }
      }
    }

    void loadContentIfNeeded();
    return () => {
      cancelled = true;
    };
  }, [activeArtifact]);

  const handleSelectArtifact = useCallback(
    (item: ArtifactItem) => {
      setActiveArtifact(item);
      onSelectArtifact?.(item);
    },
    [onSelectArtifact],
  );

  const hasMultipleArtifacts = artifacts !== undefined && artifacts.length > 1;

  const renderActiveViewer = () => {
    switch (activeArtifact.kind) {
      case "image":
        return <ImageViewer artifact={activeArtifact} />;
      case "video":
        return <VideoViewer artifact={activeArtifact} />;
      case "code":
      case "text":
        return <CodeTextViewer artifact={activeArtifact} />;
      case "diff":
        return <DiffViewer artifact={activeArtifact} />;
      case "html":
        return <HtmlViewer artifact={activeArtifact} />;
      case "fallback":
      default:
        return <FallbackViewer artifact={activeArtifact} />;
    }
  };

  return (
    <SafeScreen style={styles.screen} testID="artifact-viewer-screen">
      <View style={styles.header}>
        <Pressable
          accessibilityLabel="Back"
          accessibilityRole="button"
          onPress={onBack}
          style={styles.backButton}
          testID="artifact-viewer-back-button"
        >
          <Glyph name="back" color={ink.bright} size={14} />
        </Pressable>

        <View style={styles.titleContainer}>
          <Title heading numberOfLines={1} style={styles.title}>
            {activeArtifact.name}
          </Title>
          <View style={styles.subtitleRow}>
            <Label color={ink.muted} style={styles.typeBadge}>
              {activeArtifact.kind.toUpperCase()}
            </Label>
            {activeArtifact.byteSize !== undefined ? (
              <Label color={ink.faint} style={styles.sizeText}>
                {formatByteSize(activeArtifact.byteSize)}
              </Label>
            ) : null}
            {loading ? (
              <Label color={ink.muted} style={styles.loadingText}>
                Loading content...
              </Label>
            ) : null}
          </View>
        </View>

        {hasMultipleArtifacts ? (
          <Pressable
            accessibilityLabel={trayOpen ? "Hide artifact list" : "Show artifact list"}
            accessibilityRole="button"
            onPress={() => setTrayOpen(o => !o)}
            style={[styles.trayButton, trayOpen && styles.trayButtonActive]}
            testID="artifact-tray-toggle"
          >
            <Glyph name="list" color={trayOpen ? ink.bright : ink.plain} size={14} />
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      <View style={styles.viewerContainer}>{renderActiveViewer()}</View>

      {hasMultipleArtifacts && trayOpen ? (
        <ArtifactFileTray
          artifacts={artifacts}
          onSelectArtifact={handleSelectArtifact}
          selectedId={activeArtifact.id}
          style={styles.tray}
        />
      ) : null}
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: ground.base,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
    backgroundColor: ground.surface,
  },
  backButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    marginRight: space.snug,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  titleContainer: {
    flex: 1,
    marginRight: space.snug,
  },
  title: {
    fontSize: 16,
    fontWeight: "600",
  },
  subtitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    marginTop: space.hair,
  },
  typeBadge: {
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  sizeText: {
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  loadingText: {
    fontSize: 11,
    fontStyle: "italic",
  },
  trayButton: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  trayButtonActive: {
    backgroundColor: ground.active,
    borderColor: ink.muted,
  },
  headerSpacer: {
    width: 36,
  },
  viewerContainer: {
    flex: 1,
  },
  tray: {
    maxHeight: 260,
  },
});
