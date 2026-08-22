/**
 * The composer's image attachments: the control, the selected chips, and the
 * honest refusal, as one band.
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
 * Both composers embed this band inside their surface: unlike the microphone,
 * which is a mode of speaking, an attachment is part of the prompt being
 * composed, so it belongs with the words it will ride with.
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

export interface AttachmentsBarProps {
  /** The platform seam: live picker, or its named absence. */
  picker: ImageAttachmentPicker;
  /** The images already riding this prompt, in send order. */
  images: PromptImage[];
  /** The one way the set changes: a full replacement, so remove is as first-class as add. */
  onImages: (images: PromptImage[]) => void;
  /** False when the composer itself is offline or ineligible; picking is held with the reason named. */
  enabled: boolean;
  /** TestID prefix shared by every control in the band, e.g. `composer` or `terminal-composer`. */
  prefix: string;
}

export function AttachmentsBar({ picker, images, onImages, enabled, prefix }: AttachmentsBarProps): JSX.Element {
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

  return (
    <View testID={`${prefix}-attachments`}>
      <View style={styles.row}>
        <Pressable
          testID={`${prefix}-attach`}
          accessibilityRole="button"
          accessibilityLabel="Attach an image to this prompt"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={pick}
          style={({ pressed }) => [
            styles.attach,
            pressed && !disabled && { backgroundColor: ground.active },
            disabled && styles.attachOff,
          ]}
        >
          <Glyph name="image" size={14} color={disabled ? ink.faint : images.length > 0 ? signal.sage : ink.plain} />
        </Pressable>
        {/* The reason the control cannot be used, or the last pick's refusal.
            The unavailable case holds this slot permanently; every other case
            only borrows it until the next action. */}
        <Label
          color={picker.availability.available ? ink.faint : ink.plain}
          style={styles.notice}
          testID={`${prefix}-attach-status`}
          numberOfLines={2}
        >
          {gate ?? notice ?? ""}
        </Label>
      </View>
      {images.length === 0 ? null : (
        <View style={styles.chips}>
          {images.map((image, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a prompt's attachments are a positional composition list, not records with identity: removal is by position, the testIDs are by position, and the daemon never echoes them back to key against.
            <View key={`${prefix}-attachment-${index}`} style={styles.chip} testID={`${prefix}-attachment-${index}`}>
              <Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.thumb} />
              <Pressable
                testID={`${prefix}-attachment-remove-${index}`}
                accessibilityRole="button"
                accessibilityLabel={`Remove image ${index + 1}`}
                onPress={() => {
                  onImages(images.filter((_, at) => at !== index));
                  setNotice(null);
                }}
                style={({ pressed }) => [styles.remove, pressed && { backgroundColor: ground.active }]}
              >
                <Glyph name="deny" size={10} color={ink.plain} />
              </Pressable>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.tight },
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
