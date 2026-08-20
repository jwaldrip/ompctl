/**
 * An attachment the agent produced or referenced, as a block.
 *
 * Today a finished image is a URI in a wall of text, which is the transcript
 * lying by omission: the thing exists and the phone can show it. This block
 * shows what RN's `Image` can display, names honestly what it cannot, and
 * treats a load that failed on cellular as a state with a way out rather than
 * as a blank, because a silent blank reads as the app being broken.
 *
 * One implementation serves iOS, Android, and web, so there are no DOM
 * elements here and the one platform difference that exists (the load event's
 * payload shape) is confined to `dimensionsFrom`.
 */

import type { JSX } from "react";
import { useCallback, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Body, Data, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { AttachmentRef } from "./blocks.ts";

/**
 * The raster types RN's `Image` decodes on iOS, Android, and web alike, keyed
 * by the extension a daemon realistically emits. SVG is deliberately absent:
 * `Image` cannot rasterize it on native, so an honest file row beats a broken
 * frame on two of three platforms. HEIC and TIFF are absent for the same
 * reason, and one map serving both displayability and inference is what keeps
 * the two judgements from drifting apart.
 */
const IMAGE_MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
} as const satisfies Record<string, string>;

/**
 * The displayability test itself, spelled out rather than derived from the
 * extension map so the two tables sit side by side and a disagreement between
 * them is visible on one screen. A mime not listed here is not an error; it
 * is a file row.
 */
const DISPLAYABLE_MIMES: Record<string, true> = {
  "image/png": true,
  "image/jpeg": true,
  "image/gif": true,
  "image/webp": true,
};

/**
 * Agent output clusters near 3:2 screenshots, so that is the frame while the
 * intrinsic ratio is still unknown. The real ratio replaces it on load, and
 * the height cap catches anything taller regardless.
 */
const PLACEHOLDER_ASPECT = 3 / 2;

/** `Image` load and error events, reduced to the one field both shapes carry. */
interface ImageEvent {
  nativeEvent: unknown;
}

/**
 * The best type statement available, or none. The daemon's word wins when it
 * gave one, a data URI declares its own, and otherwise an exact image
 * extension on the name or URI is the only inference allowed: guessing an
 * image for a file we cannot identify is exactly how a broken frame gets
 * rendered.
 */
function resolveMime(ref: AttachmentRef): string | null {
  const given = ref.mime?.trim();
  if (given !== undefined && given.length > 0) return given.toLowerCase();
  const declared = /^data:([^;,]+)/.exec(ref.uri);
  if (declared !== null) return declared[1].toLowerCase();
  return imageMimeForExtension(ref.name) ?? imageMimeForExtension(ref.uri);
}

function imageMimeForExtension(value: string): string | null {
  const lastSegment = value.split(/[?#]/)[0].split("/").pop() ?? "";
  const dot = lastSegment.lastIndexOf(".");
  if (dot < 0) return null;
  const mime = (IMAGE_MIME_BY_EXTENSION as Record<string, string>)[lastSegment.slice(dot + 1).toLowerCase()];
  return mime ?? null;
}

/**
 * Intrinsic size, from whichever payload the platform actually sent: native
 * reports it in `source`, RNW forwards the DOM load event whose `target`
 * carries naturalWidth and naturalHeight. Neither exists on the other, and a
 * zero ratio would collapse the frame, so unknown stays null.
 */
function dimensionsFrom(event: ImageEvent): { width: number; height: number } | null {
  const nativeEvent = event.nativeEvent as {
    source?: { width?: number; height?: number };
    target?: { naturalWidth?: number; naturalHeight?: number };
  };
  const width = nativeEvent.source?.width ?? nativeEvent.target?.naturalWidth ?? 0;
  const height = nativeEvent.source?.height ?? nativeEvent.target?.naturalHeight ?? 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Attachment sizes in the same magnitude-first discipline as `formatTokens`:
 * whether this is a screenshot or a log dump matters more than the exact
 * count, and a fixed-point ramp keeps a column of them comparable.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`;
  const megabytes = kilobytes / 1024;
  if (megabytes < 1024) return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
  const gigabytes = megabytes / 1024;
  return `${gigabytes.toFixed(gigabytes < 10 ? 1 : 0)} GB`;
}

export function AttachmentBlock({ ref }: { ref: AttachmentRef }): JSX.Element {
  const mime = resolveMime(ref);
  const displayable = mime !== null && DISPLAYABLE_MIMES[mime] === true && ref.uri.length > 0;
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [fullSize, setFullSize] = useState(false);
  const { height: windowHeight } = useWindowDimensions();

  const onLoad = useCallback((event: ImageEvent): void => {
    const size = dimensionsFrom(event);
    if (size !== null) setRatio(size.width / size.height);
  }, []);

  const onError = useCallback((): void => {
    setFailed(true);
  }, []);

  const retry = useCallback((): void => {
    // A fresh mount is the only retry RN's Image offers: bumping the key
    // starts a new load attempt rather than replaying a cached failure.
    setRatio(null);
    setFailed(false);
    setAttempt(current => current + 1);
  }, []);

  if (!displayable) {
    return (
      <View style={[styles.card, styles.row]} testID="attachment-file">
        <Glyph name="read" size={13} color={ink.muted} />
        <View style={styles.fileBody}>
          <Body numberOfLines={2}>{ref.name}</Body>
          <Meta mime={mime} bytes={ref.bytes} />
        </View>
      </View>
    );
  }

  if (failed) {
    return (
      <View style={[styles.card, styles.row]} testID="attachment-failed">
        <Glyph name="warning" size={13} color={signal.oxide} />
        <View style={styles.fileBody}>
          <Body numberOfLines={2}>{ref.name}</Body>
          <Kicker color={signal.oxide}>Could not load</Kicker>
          <Meta mime={mime} bytes={ref.bytes} />
        </View>
        <Pressable
          accessibilityLabel={`Try loading ${ref.name} again`}
          accessibilityRole="button"
          onPress={retry}
          style={styles.retry}
          testID="attachment-retry"
        >
          <Glyph name="resume" size={12} color={ink.plain} />
          <Label color={ink.plain}>Try again</Label>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityLabel={`Open ${ref.name} full size`}
        accessibilityRole="button"
        onPress={() => {
          setFullSize(true);
        }}
        testID="attachment-image"
      >
        <Image
          accessibilityLabel={ref.name}
          key={attempt}
          onError={onError}
          onLoad={onLoad}
          resizeMode="contain"
          source={{ uri: ref.uri }}
          style={[styles.inline, { aspectRatio: ratio ?? PLACEHOLDER_ASPECT, maxHeight: Math.round(windowHeight / 2) }]}
          testID="attachment-inline-image"
        />
      </Pressable>
      <Modal
        animationType="none"
        onRequestClose={() => {
          setFullSize(false);
        }}
        transparent
        visible={fullSize}
      >
        <Pressable
          accessibilityLabel={`Close ${ref.name}`}
          accessibilityRole="button"
          onPress={() => {
            setFullSize(false);
          }}
          style={styles.fullBackdrop}
          testID="attachment-full"
        >
          <Image
            accessibilityLabel={ref.name}
            resizeMode="contain"
            source={{ uri: ref.uri }}
            style={styles.fullImage}
          />
          <Label color={ink.muted} numberOfLines={1}>
            {ref.name}
          </Label>
        </Pressable>
      </Modal>
    </View>
  );
}

/**
 * The quiet second line of a row that cannot show its payload: what the daemon
 * said the file is, and how big it said it is. Absent facts stay absent; an
 * invented type here would be the same dishonesty this block exists to stop.
 */
function Meta({ mime, bytes }: { mime: string | null; bytes: number | null }): JSX.Element | null {
  if (mime === null && bytes === null) return null;
  return (
    <View style={styles.meta}>
      {mime !== null ? <Data color={ink.muted}>{mime}</Data> : null}
      {bytes !== null ? <Data color={ink.muted}>{formatBytes(bytes)}</Data> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  // Text rows pad; the image runs edge to edge so the frame is the picture.
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.snug,
    padding: space.step,
  },
  fileBody: { flex: 1, gap: space.hair },
  // Indented past the glyph column, the same alignment ToolCard gives its
  // secondary lines, so the two card shapes read as one family.
  meta: { flexDirection: "row", gap: space.snug, paddingLeft: space.wide + space.tight },
  retry: {
    minHeight: TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    paddingHorizontal: space.snug,
  },
  inline: { width: "100%", backgroundColor: ground.base },
  fullBackdrop: { flex: 1, backgroundColor: ground.base, padding: space.loose, gap: space.snug },
  fullImage: { flex: 1, width: "100%" },
});

