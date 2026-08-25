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
 * Every composer reaches both halves through here. `Composer` and
 * `OmpComposer` lay them out; neither draws them. `OmpComposer` used to carry
 * its own copy of the paperclip and its own copy of the chip band, which is
 * two arrangements of one control, which is two conventions -- exactly the
 * defect the placement rules exist to stop. There is one of each now.
 *
 * ## What Paper supplies here, and what it could not
 *
 * The paperclip and a chip's remove badge are `IconButton`: a real control
 * with a real press treatment, instead of a `Pressable` wearing a hand-rolled
 * `ghost` style and a `pressed` fill. `design/controls.ts` is gone with them.
 *
 * A chip is `Surface` plus that `IconButton`, and deliberately NOT Paper's
 * `Chip`, measured against `react-native-paper@5.15.3` rather than assumed.
 * Three things, each fatal on its own:
 *
 *  - `Chip`'s close affordance is a bare `Pressable` carrying only
 *    `accessibilityRole` and `closeIconAccessibilityLabel`. It takes no
 *    `testID` and no prop supplies one, so `<prefix>-attachment-remove-<n>`
 *    -- the handle removal is driven by, in two test files and in the
 *    simulator proof -- would simply cease to exist.
 *  - `Chip` puts `testID` on its inner ripple and hard-codes the bordered
 *    outer `Surface` to `<testID>-container`, so `<prefix>-attachment-<n>`
 *    would stop naming the box an operator sees and start naming something
 *    inside it.
 *  - `Chip` always renders a `Text` label from required `children`, and its
 *    `avatar` slot is cloned to 24x24 inside a wrapper. An attachment chip
 *    has no text at all; it is a 48-point thumbnail and a way to take it off.
 *
 * So the chip is built from the two Paper components that can carry it, and
 * every testID and every positional accessibility label survives.
 */

import {
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_REFUSAL_REASONS,
  type PromptImage,
  parsePromptImages,
} from "@ompd/core/contracts";
import type { JSX } from "react";
import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { IconButton, Surface } from "react-native-paper";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { radius, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
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
 *
 * The glyph is handed over as a render function rather than as one of Paper's
 * icon names. The theme maps Paper's name slot onto `Glyph`, but only under
 * the provider, and a control mounted without one renders no icon at all and
 * warns about vector-icon packages this app does not ship. A function is the
 * other half of `IconSource` and it draws ompctl's own family unconditionally,
 * at the colour the gate already computed -- which matters, because
 * `getIconButtonColor` throws a custom icon colour away the moment the button
 * is disabled and would grey the paperclip in Material's grey.
 */
export function AttachmentControl({ band, prefix }: { band: AttachmentBand; prefix: string }): JSX.Element {
  const theme = useOmpTheme();
  const tone = band.disabled ? theme.ink.faint : band.images.length > 0 ? theme.signal.sage : theme.ink.plain;
  return (
    <IconButton
      testID={`${prefix}-attach`}
      accessibilityLabel="Attach an image to this prompt"
      // The picker offers photos and nothing else, so the hint says photos.
      // The paperclip is the gesture's icon everywhere; it is not a claim
      // that this build can attach a document.
      accessibilityHint="Choose images from this device's photo library"
      accessibilityState={{ disabled: band.disabled }}
      disabled={band.disabled}
      onPress={band.pick}
      icon={({ size }) => <Glyph name="attachment" size={size} color={tone} />}
      size={ATTACH_GLYPH}
      // A ghost: no fill until a finger is on it, and then the fill is the
      // ripple rather than a second style. `ghost.pressed` was this.
      containerColor="transparent"
      rippleColor={theme.ground.active}
      style={[styles.iconTarget, styles.noMargin]}
      contentStyle={styles.iconTarget}
    />
  );
}

/**
 * One image riding this prompt, as a chip you can take back off.
 *
 * Positional throughout -- positional testIDs, positional removal, an ordinal
 * in the accessibility label -- because a prompt's attachments are a
 * composition list rather than records with identity: the daemon never echoes
 * an id back to key against.
 */
function AttachmentChip({
  image,
  index,
  prefix,
  onRemove,
}: {
  image: PromptImage;
  index: number;
  prefix: string;
  onRemove: () => void;
}): JSX.Element {
  const theme = useOmpTheme();
  // The badge is 28 because the theme says a chip's remove affordance is 28,
  // and a finger needs 44. The difference is paid as hit slop rather than as a
  // 44-point disc, because a 44-point remove beside a 48-point thumbnail is a
  // chip that is mostly a delete button.
  const badge = theme.control.chipRemove;
  const grow = (theme.rhythm.minTarget - badge) / 2;
  const removeSize = { width: badge, height: badge };
  return (
    // A chip is an object you pick up, so it is the one thing inside a
    // composer allowed an edge, at the control radius rather than the
    // surface's.
    <Surface
      mode="flat"
      elevation={0}
      testID={`${prefix}-attachment-${index}`}
      style={[styles.chip, { backgroundColor: theme.ground.active, borderColor: theme.ground.line }]}
    >
      <Image
        source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
        style={[
          styles.thumb,
          { width: theme.control.thumb, height: theme.control.thumb, backgroundColor: theme.ground.base },
        ]}
      />
      <IconButton
        testID={`${prefix}-attachment-remove-${index}`}
        accessibilityLabel={`Remove image ${index + 1}`}
        onPress={onRemove}
        icon={({ size }) => <Glyph name="deny" size={size} color={theme.ink.plain} />}
        size={REMOVE_GLYPH}
        containerColor="transparent"
        rippleColor={theme.ground.raised}
        hitSlop={{ top: grow, bottom: grow, left: grow, right: grow }}
        style={[styles.roundedControl, styles.noMargin, removeSize]}
        contentStyle={removeSize}
      />
    </Surface>
  );
}

/**
 * What this prompt is carrying, and what it could not: the chips and the one
 * live sentence, between the words and the action row.
 *
 * Absent while there is nothing to show, so an ordinary empty composer is the
 * field and the row and nothing else. What must never disappear is the
 * *control*, which lives in the row and states its own disabled reason
 * through this band the moment there is a reason to state.
 */
export function AttachmentsBar({ band, prefix }: { band: AttachmentBand; prefix: string }): JSX.Element | null {
  const theme = useOmpTheme();
  if (band.images.length === 0 && band.status === "") return null;
  return (
    <View style={styles.band} testID={`${prefix}-attachments`}>
      {band.images.length === 0 ? null : (
        <View style={styles.chips}>
          {band.images.map((image, index) => (
            <AttachmentChip
              // biome-ignore lint/suspicious/noArrayIndexKey: a prompt's attachments are a positional composition list, not records with identity: removal is by position, the testIDs are by position, and the daemon never echoes them back to key against.
              key={`${prefix}-attachment-${index}`}
              image={image}
              index={index}
              prefix={prefix}
              onRemove={() => {
                band.remove(index);
              }}
            />
          ))}
        </View>
      )}
      {/* The reason the control cannot be used, or the last pick's refusal.
          The unavailable case holds this slot permanently; every other case
          only borrows it until the next action. */}
      {band.status === "" ? null : (
        <Label
          color={band.unavailable ? theme.ink.plain : theme.ink.faint}
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

/** The paperclip's glyph. Icon weight, not spacing: it is not on the grid. */
const ATTACH_GLYPH = 14;
/** The remove badge's glyph, small because the badge is. */
const REMOVE_GLYPH = 10;

const styles = StyleSheet.create({
  band: { gap: rhythm.rowGapTight },
  notice: { flexShrink: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: rhythm.cardGap },
  chip: {
    borderWidth: stroke.hair,
    borderRadius: radius.control,
    padding: rhythm.controlPad,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: rhythm.glyphGap,
  },
  thumb: { borderRadius: radius.control },
  /** The corner every control inside a surface wears. */
  roundedControl: { borderRadius: radius.control },
  /**
   * `IconButton` pays itself a six-point margin. A control in a row of
   * controls owes its rhythm to the row, not to itself.
   */
  noMargin: { margin: 0 },
  /**
   * A ghost target: the whole 44-point square, so a row of them keeps an even
   * rhythm and a finger lands on any of them.
   */
  iconTarget: { width: rhythm.minTarget, height: rhythm.minTarget, borderRadius: radius.control },
});
