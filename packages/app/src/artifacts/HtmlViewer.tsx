/**
 * Sandboxed HTML viewer for untrusted, agent-authored HTML reports and artifacts.
 *
 * Configured in direct opposition to WebViewDriver:
 * - NO network access: originWhitelist is pinned to ["about:blank"] and all
 *   network navigation requests are refused.
 * - Strict Content-Security-Policy injected: default-src 'none', connect-src 'none'.
 * - NO bridge or message handler to the host app or daemon.
 * - Local file access disabled (allowFileAccess=false, allowUniversalAccessFromFileURLs=false).
 * - Incognito with isolated non-persistent storage.
 * - Escape hatch: "Open in browser" button to launch the artifact in the system browser.
 */

import type { JSX } from "react";
import { useCallback, useMemo } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import WebView, { type WebViewNavigation } from "react-native-webview";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { ground, ink, radius, signal, space, stroke } from "../design/tokens.ts";
import type { ArtifactItem } from "./types.ts";
import { formatByteSize } from "./types.ts";

export interface HtmlViewerProps {
  artifact: ArtifactItem;
  style?: StyleProp<ViewStyle>;
}

export const STRICT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-ancestors 'none';";

export interface SandboxedHtmlPolicy {
  csp: string;
  originWhitelist: readonly string[];
  allowNetworkAccess: boolean;
}

export function getSandboxedHtmlPolicy(_html?: string): SandboxedHtmlPolicy {
  return {
    csp: STRICT_CSP,
    originWhitelist: ["about:blank"] as const,
    allowNetworkAccess: false,
  };
}

/**
 * Injects CSP meta tag into the head of untrusted HTML content.
 */
export function injectStrictCsp(rawHtml: string): string {
  const metaTag = `<meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">`;
  if (rawHtml.includes("<head>")) {
    return rawHtml.replace("<head>", `<head>${metaTag}`);
  }
  if (rawHtml.includes("<html>")) {
    return rawHtml.replace("<html>", `<html><head>${metaTag}</head>`);
  }
  return `<head>${metaTag}</head>${rawHtml}`;
}

export function HtmlViewer({ artifact, style }: HtmlViewerProps): JSX.Element {
  const sandboxedHtml = useMemo(() => {
    const raw = artifact.content ?? "<html><body><p>Empty HTML artifact</p></body></html>";
    return injectStrictCsp(raw);
  }, [artifact.content]);

  const handleOpenExternal = useCallback(() => {
    if (artifact.url) {
      void Linking.openURL(artifact.url);
    }
  }, [artifact.url]);

  /**
   * Refuse all network navigations from within untrusted HTML.
   * Only about:blank or initial data loads are permitted.
   */
  const onShouldStartLoadWithRequest = useCallback((request: WebViewNavigation) => {
    if (request.url.startsWith("about:blank") || request.url.startsWith("data:")) {
      return true;
    }
    // Block any outbound or external URLs
    return false;
  }, []);

  return (
    <View style={[styles.container, style]} testID="html-viewer">
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
          <View style={styles.sandboxBadge} testID="html-sandbox-banner">
            <Glyph name="clearance" color={signal.ready} size={11} />
            <Label color={signal.ready} style={styles.sandboxBadgeText}>
              Sandboxed (offline)
            </Label>
          </View>

          <Pressable
            accessibilityLabel="Open in real browser"
            accessibilityRole="button"
            onPress={handleOpenExternal}
            style={styles.openButton}
            testID="html-open-external-button"
          >
            <Glyph name="browser" color={ink.bright} size={12} />
            <Label color={ink.bright} style={styles.openButtonText}>
              Open in browser
            </Label>
          </Pressable>
        </View>
      </View>

      <View style={styles.frameContainer} testID="html-viewer-frame">
        <WebView
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          domStorageEnabled={false}
          geolocationEnabled={false}
          incognito
          javaScriptEnabled
          mediaPlaybackRequiresUserAction
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          originWhitelist={["about:blank"]}
          sharedCookiesEnabled={false}
          source={{ html: sandboxedHtml }}
          style={styles.webView}
          thirdPartyCookiesEnabled={false}
        />
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
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
  },
  sandboxBadge: {
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
  sandboxBadgeText: {
    fontSize: 11,
    fontWeight: "500",
  },
  openButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    minHeight: 28,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.control,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  openButtonText: {
    fontSize: 12,
    fontWeight: "600",
  },
  frameContainer: {
    flex: 1,
    backgroundColor: ground.base,
  },
  webView: {
    flex: 1,
    backgroundColor: ground.base,
  },
});
