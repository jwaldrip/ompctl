/**
 * The composer's attachments: the paperclip, the selected chips, and the
 * honest refusal.
 *
 * Three states, and none of them is "missing". Where the platform picker
 * exists, the control picks and each selected image shows as a removable
 * chip. Where it does not, the control stays, disabled, with the reason
 * named beside it: a vanished button reads as a vanished feature, and the
 * operator has no way to tell "this build cannot" from "this daemon
 * refused". A pick that busts the wire budgets is refused here by name too,
 * before anything is sent, so the daemon's own refusal is the backstop
 * rather than the first word the operator hears.
 *
 * This is one band wearing two positions, which is why it exports a hook and
 * two views rather than a single component. The control belongs in the
 * composer's lower action row, at its left end, because that is where every
 * surface a person has already used puts this gesture; the chips and the
 * refusal belong above that row, under the words they will ride with,
 * because a chip is part of the prompt and a refusal is a sentence rather
 * than a 44-point control. `useImageAttachments` owns the state both halves
 * read, so the two positions can never disagree about what this prompt is
 * carrying.
 *
 * Both composers reach this through `Composer`, which is the only thing that
 * lays the two halves out. Nothing else may place them, because a second
 * arrangement is a second convention.
 */

import {
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_REFUSAL_REASONS,
  type PromptImage,
  parsePromptImages,
} from "@ompd/core/contracts";
import type { JSX } from "react";
import { useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { ImageAttachmentPicker } from "../platform/attachments.ts";

export interface UseImageAttachments {
  /** The platform seam: live picker, or its named absence. */
  picker: ImageAttachmentPicker;
  /** The images already riding this prompt, in send order. */
  images: PromptImage[];
  /** The one way the set changes: a full replacement, so remove is as first-class as add. */
  onImages: (images: PromptImage[]) => void;
  /** False when the composer itself is offline or ineligible; picking is held with the reason named. */
  enabled: boolean;
}

/**
 * What one composer's attachment band is, as the control and the chips both
 * see it. A single object rather than seven props, so the two halves cannot
 * be wired to different state.
 */
export interface AttachmentBand {
  /** The images riding this prompt, in send order. */
  readonly images: readonly PromptImage[];
  /** Open the platform picker. A no-op while held, or while a sheet is already up. */
  readonly pick: () => void;
  /** Drop one image by position. Removal is positional because the chips are. */
  readonly remove: (index: number) => void;
  /** True when pressing the control cannot reach a picker at all. */
  readonly disabled: boolean;
  /** Why picking is held, or what the last pick refused. Empty when neither. */
  readonly status: string;
  /** True only while the reason is this build's permanent absence of a picker. */
  readonly unavailable: boolean;
}

export function useImageAttachments({ picker, images, onImages, enabled }: UseImageAttachments): AttachmentBand {
  // The last thing the operator asked the band to do that it could not, so a
  // refusal stays readable until the next action replaces it. Not a queue of
  // errors: one live sentence is what a person standing in a composer reads.
  const [notice, setNotice] = useState<string | null>(null);
  // One picker at a time: a second press while the sheet is up would stack
  // responses, and the second response's room would double-count the first.
  const [picking, setPicking] = useState(false);

  const full = images.length >= MAX_PROMPT_IMAGES;
  // Cheapest refusal first, the mic gate's own ladder: what this build can
  // do, then the link, then the count. An unavailable picker names itself
  // permanently; the other two are conditions that pass.
  const gate: string | null = !picker.availability.available
    ? picker.availability.reason
    : !enabled
      ? "No link"
      : full
        ? "This prompt is carrying all the images the wire allows."
        : null;
  const disabled = gate !== null;

  const pick = (): void => {
    if (disabled || picking) return;
    setNotice(null);
    setPicking(true);
    void picker
      .pick(MAX_PROMPT_IMAGES - images.length)
      .then(({ images: picked, refused }) => {
        // Whatever the seam already refused by name comes first: it measured
        // the image against the wire's own ceiling and knows why, which is
        // more than this band can reconstruct from a missing chip.
        const notices = [...refused];
        // Each candidate is then checked against the merged set the wire
        // would actually carry, so the count and total budgets bind here,
        // before a frame is built, with the shared vocabulary rather than a
        // local approximation of it.
        const accepted: PromptImage[] = [];
        for (const candidate of picked) {
          const merged = parsePromptImages([...images, ...accepted, candidate]);
          if (merged.ok) accepted.push(candidate);
          else notices.push(`Image not attached: ${PROMPT_IMAGE_REFUSAL_REASONS[merged.refusal]}`);
        }
        if (accepted.length > 0) onImages([...images, ...accepted]);
        // One live sentence is what a person standing in a composer reads, so
        // the rest are counted rather than stacked into a wall of text that
        // the two-line slot would clip anyway.
        const [first, ...rest] = notices;
        setNotice(first === undefined ? null : rest.length === 0 ? first : `${first} Plus ${rest.length} more.`);
        setPicking(false);
      })
      .catch((cause: unknown) => {
        setNotice(cause instanceof Error ? cause.message : "The photo picker failed.");
        setPicking(false);
      });
  };

  return {
    images,
    pick,
    remove: index => {
      onImages(images.filter((_, at) => at !== index));
      setNotice(null);
    },
    disabled,
    status: gate ?? notice ?? "",
    unavailable: !picker.availability.available,
  };
}

/**
 * The paperclip: the one control that adds to a prompt something other than
 * words. It carries no visible label on purpose, because the row it sits in
 * is a row of gestures and the band above it is where this one explains
 * itself; assistive technology hears the whole sentence.
 */
export function AttachmentControl({ band, prefix }: { band: AttachmentBand; prefix: string }): JSX.Element {
  return (
    <Pressable
      testID={`${prefix}-attach`}
      accessibilityRole="button"
      accessibilityLabel="Attach an image to this prompt"
      // The picker offers photos and nothing else, so the hint says photos.
      // The paperclip is the gesture's icon everywhere; it is not a claim
      // that this build can attach a document.
      accessibilityHint="Choose images from this device's photo library"
      accessibilityState={{ disabled: band.disabled }}
      disabled={band.disabled}
      onPress={band.pick}
      style={({ pressed }) => [
        styles.attach,
        pressed && !band.disabled && { backgroundColor: ground.active },
        band.disabled && styles.attachOff,
      ]}
    >
      <Glyph
        name="attachment"
        size={14}
        color={band.disabled ? ink.faint : band.images.length > 0 ? signal.sage : ink.plain}
      />
    </Pressable>
  );
}

/**
 * What this prompt is carrying, and what it could not: the chips and the one
 * live sentence, between the words and the action row.
 *
 * The wrapper renders even while empty and silent, because the status slot is
 * held permanently on a build with no picker and a band that comes and goes
 * would move the action row under the operator's thumb mid-compose.
 */
export function AttachmentsBar({ band, prefix }: { band: AttachmentBand; prefix: string }): JSX.Element {
  return (
    <View testID={`${prefix}-attachments`}>
      {band.images.length === 0 ? null : (
        <View style={styles.chips}>
          {band.images.map((image, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a prompt's attachments are a positional composition list, not records with identity: removal is by position, the testIDs are by position, and the daemon never echoes them back to key against.
            <View key={`${prefix}-attachment-${index}`} style={styles.chip} testID={`${prefix}-attachment-${index}`}>
              <Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.thumb} />
              <Pressable
                testID={`${prefix}-attachment-remove-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove image ${index + 1}`}
                onPress={() => {
                  band.remove(index);
                }}
                style={({ pressed }) => [styles.remove, pressed && { backgroundColor: ground.active }]}
              >
                <Glyph name="deny" size={10} color={ink.plain} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
      {/* The reason the control cannot be used, or the last pick's refusal.
          The unavailable case holds this slot permanently; every other case
          only borrows it until the next action. */}
      {band.status === "" ? null : (
        <Label
          color={band.unavailable ? ink.plain : ink.faint}
          style={styles.notice}
          testID={`${prefix}-attach-status`}
          numberOfLines={2}
        >
          {band.status}
        </Label>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  attach: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: stroke.hair,
  },
  attachOff: { borderColor: ground.edge },
  notice: { flexShrink: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.snug, paddingVertical: space.tight },
  chip: {
    borderWidth: stroke.hair,
    borderColor: ground.line,
    padding: space.tight,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.tight,
  },
  thumb: { width: 48, height: 48, backgroundColor: ground.base },
  remove: {
    minHeight: 28,
    minWidth: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
