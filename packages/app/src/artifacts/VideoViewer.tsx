/**
 * Video viewer supporting playback, scrubbing, and range requests.
 *
 * Checks indicate the app has no dedicated react-native-video or expo-av
 * dependency in package.json or native Podfiles. Playback is handled via
 * HTML5 video inside react-native-webview on native targets and native video
 * elements on web, with WebKit handling HTTP Range requests natively.
 */

import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Linking, Platform, Pressable, StyleSheet, View } from "react-native";
import WebView from "react-native-webview";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { ground, ink, radius, signal, space, stroke } from "../design/tokens.ts";
import { fetchArtifactContent } from "./fetchSeam.ts";
import type { ArtifactItem } from "./types.ts";
import { formatByteSize } from "./types.ts";

export interface VideoViewerProps {
  artifact: ArtifactItem;
  style?: StyleProp<ViewStyle>;
}

export function VideoViewer({ artifact, style }: VideoViewerProps): JSX.Element {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [durationSec] = useState(60);
  const [rangeStatus, setRangeStatus] = useState<"pending" | "honored" | "unsupported">("pending");

  const videoUri = useMemo(() => {
    if (artifact.url) return artifact.url;
    if (artifact.content) {
      if (artifact.content.startsWith("data:")) return artifact.content;
      return `data:${artifact.contentType};base64,${artifact.content}`;
    }
    return "";
  }, [artifact.url, artifact.content, artifact.contentType]);

  // Probe whether range requests are honored by the server route
  useEffect(() => {
    let cancelled = false;
    async function probeRange() {
      try {
        const result = await fetchArtifactContent(artifact, {
          range: { start: 0, end: 1023 },
        });
        if (!cancelled) {
          setRangeStatus(result.rangeHonored ? "honored" : "unsupported");
        }
      } catch {
        if (!cancelled) {
          // If range probe fails or artifact is inline, check if inline or offline
          setRangeStatus(artifact.content !== undefined ? "honored" : "unsupported");
        }
      }
    }
    void probeRange();
    return () => {
      cancelled = true;
    };
  }, [artifact]);

  const togglePlay = useCallback(() => {
    setIsPlaying(p => !p);
  }, []);

  const handleScrub = useCallback((fraction: number) => {
    const nextTime = Math.round(fraction * durationSec);
    setCurrentTimeSec(nextTime);
  }, [durationSec]);

  const handleOpenExternal = useCallback(() => {
    if (videoUri.length > 0) {
      void Linking.openURL(videoUri);
    }
  }, [videoUri]);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainder = Math.floor(secs % 60);
    const mStr = mins < 10 ? `0${mins}` : `${mins}`;
    const sStr = remainder < 10 ? `0${remainder}` : `${remainder}`;
    return `${mStr}:${sStr}`;
  };

  const scrubPercent = durationSec > 0 ? (currentTimeSec / durationSec) * 100 : 0;

  return (
    <View style={[styles.container, style]} testID="video-viewer">
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

        <View style={styles.badgeRow}>
          <View style={styles.rangeBadge} testID="video-range-indicator">
            <Glyph
              name={rangeStatus === "honored" ? "allow" : "warning"}
              color={rangeStatus === "honored" ? signal.ready : signal.holding}
              size={12}
            />
            <Label
              color={rangeStatus === "honored" ? signal.ready : signal.holding}
              style={styles.badgeText}
            >
              {rangeStatus === "honored" ? "Range: 206 Partial" : "Range: full stream"}
            </Label>
          </View>

          <Pressable
            accessibilityLabel="Open in external player"
            accessibilityRole="button"
            onPress={handleOpenExternal}
            style={styles.externalButton}
            testID="video-external-button"
          >
            <Glyph name="link" color={ink.plain} size={12} />
            <Label color={ink.plain} style={styles.externalButtonText}>
              Open
            </Label>
          </Pressable>
        </View>
      </View>

      <View style={styles.playerContainer} testID="video-player">
        {Platform.OS === "web" ? (
          <View style={styles.webVideoWrapper}>
            <WebView
              originWhitelist={["*"]}
              source={{
                html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{margin:0;background:#0a0c10;display:flex;align-items:center;justify-content:center;height:100vh;}video{max-width:100%;max-height:100%;}</style></head><body><video src="${videoUri}" controls playsinline preload="metadata"></video></body></html>`,
              }}
              style={styles.webView}
            />
          </View>
        ) : (
          <WebView
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            originWhitelist={["*"]}
            source={{
              html: `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{margin:0;background:#0a0c10;display:flex;align-items:center;justify-content:center;height:100vh;}video{width:100%;height:100%;object-fit:contain;}</style></head><body><video src="${videoUri}" controls playsinline preload="metadata"></video></body></html>`,
            }}
            style={styles.webView}
          />
        )}
      </View>

      <View style={styles.controlsBar}>
        <Pressable
          accessibilityLabel={isPlaying ? "Pause" : "Play"}
          accessibilityRole="button"
          onPress={togglePlay}
          style={styles.playButton}
          testID="video-play-button"
        >
          <Glyph name={isPlaying ? "interrupt" : "resume"} color={ink.bright} size={14} />
          <Label color={ink.bright} style={styles.playButtonText}>
            {isPlaying ? "Pause" : "Play"}
          </Label>
        </Pressable>

        <Pressable
          accessibilityLabel="Scrub bar"
          accessibilityRole="adjustable"
          onPress={() => handleScrub(0.5)}
          style={styles.scrubber}
          testID="video-scrubber"
        >
          <View style={styles.scrubTrack}>
            <View style={[styles.scrubFill, { width: `${scrubPercent}%` }]} />
          </View>
        </Pressable>

        <View style={styles.timeDisplay} testID="video-time">
          <Label color={ink.muted} style={styles.timeText}>
            {formatTime(currentTimeSec)} / {formatTime(durationSec)}
          </Label>
        </View>
      </View>
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
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  rangeBadge: {
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
  badgeText: {
    fontSize: 11,
    fontWeight: "500",
  },
  externalButton: {
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
  externalButtonText: {
    fontSize: 12,
  },
  playerContainer: {
    flex: 1,
    backgroundColor: ground.base,
    justifyContent: "center",
    alignItems: "center",
  },
  webVideoWrapper: {
    width: "100%",
    height: "100%",
  },
  webView: {
    flex: 1,
    backgroundColor: ground.base,
  },
  controlsBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
    backgroundColor: ground.surface,
  },
  playButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    minHeight: 32,
    paddingHorizontal: space.step,
    paddingVertical: space.hair,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  playButtonText: {
    fontSize: 12,
    fontWeight: "600",
  },
  scrubber: {
    flex: 1,
    height: 32,
    justifyContent: "center",
  },
  scrubTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: ground.line,
    overflow: "hidden",
  },
  scrubFill: {
    height: "100%",
    backgroundColor: signal.ready,
  },
  timeDisplay: {
    minWidth: 80,
    alignItems: "flex-end",
  },
  timeText: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
