/**
 * The owned session's composer, on assistant-ui's `ComposerPrimitive`.
 *
 * This is #131's one-surface contract rebuilt on the library rather than a new
 * design, so the rules it exists to hold are worth restating: they are the
 * reason a message box reads as a message box instead of a control panel.
 *
 *  - **The surface owns the box.** One rounded container at `radius.surface`
 *    carries the background and the only border. Nothing inside it draws a
 *    second one.
 *  - **The field is borderless.** Transparent and unpadded on the sides,
 *    because the surface already padded it. A field with its own edge is a box
 *    in a box, which was the whole defect.
 *  - **One emphasis per surface.** Send is filled and round at `radius.pill`.
 *    The paperclip, the microphone and the model are ghosts from
 *    `design/controls.ts`: a 44-point target, a rounded press state, and no
 *    permanent cage.
 *  - **Chrome is not content.** Nothing sits here permanently to explain a
 *    control. A refusal appears when there is one, dictation appears while
 *    there is dictation, and instructions live on accessibility hints where
 *    they cost no pixels.
 *
 * Two states for the action, and they are not the same control: idle it sends,
 * mid-turn it becomes an interrupt. Both wear the same geometry in the same
 * slot, so the paperclip never moves when the turn state changes. The field
 * stays editable while a turn runs; only sending is held.
 *
 * ## What the runtime owns now, and what a screen still passes
 *
 * The whole point of moving onto the primitives is that the composer's own
 * state stops being a prop. `text`, `busy` and `enabled` are gone: the text
 * lives in `composer.text`, "a turn is in flight" is `thread.isRunning`, "this
 * device cannot steer at all" is `thread.isDisabled`, and "it may type but the
 * send will be refused" is folded into `composer.canSend` by the store's
 * `isSendDisabled`. Every one of those is read from the runtime below and none
 * of them is a parameter, which is what makes the two-state action impossible
 * to wire wrong from a call site.
 *
 * What a screen still owns is what only a screen knows: the words for an empty
 * field, the platform picker, the microphone's device state, this session's
 * model, and the prose for a refusal the daemon has not yet issued.
 *
 * ## Where the primitives could not be used, precisely
 *
 * Three of them, measured against `@assistant-ui/react-native@0.1.38` rather
 * than assumed, because each one changes what this file has to do:
 *
 *  - `ComposerPrimitive.AddAttachment` cannot open a picker. Its
 *    implementation renders `Pressable` with `disabled` and
 *    `accessibilityRole` and no `onPress` at all, and its props are
 *    `Omit<PressableProps, "onPress" | "children">`, so a consumer cannot
 *    supply one either. The only thing it contributes is
 *    `useComposerAddAttachment().disabled`, which is `!composer.isEditing` and
 *    therefore always false on a thread composer. The paperclip is a plain
 *    `Pressable` for that reason.
 *  - `ComposerPrimitive.Attachments` iterates the runtime's attachment list
 *    and hands its child only `{ attachment }`, never the index. #131's chips
 *    are positional -- positional testIDs, positional removal, an ordinal in
 *    the accessibility label -- so the band reads `composer.attachments` from
 *    the same store directly. `AttachmentPrimitive.Remove` is out for a second
 *    reason: it spreads consumer props *after* its own `onPress` and omits
 *    `onPress` from its type, so a consumer can neither compose with its
 *    handler nor replace it.
 *  - `ComposerPrimitive.Input` ignores `thread.isDisabled`. The shared
 *    `composerInputDisabled` predicate exists in core but the React Native
 *    input never reads it, so `editable` is set here. Its web Enter-to-send
 *    path has the matching hole: it calls `composer.send()`, and
 *    `composer.canSend` does not include `isDisabled`, so a plain Enter with
 *    no link would dispatch. The primitive checks `isDefaultPrevented()` on a
 *    chained `onKeyPress` first, which is where that is closed below.
 *
 * ## Why an image is an assistant-ui attachment rather than local state
 *
 * A prompt is words plus whatever images the operator attached, and #131's
 * rule is that an image-only prompt is as sendable as a text-only one. On the
 * primitives that is not a choice: `composer.canSend` is `!isEmpty && ...` and
 * `isEmpty` reads `composer.attachments`, so images held in this component's
 * own state would leave an image-only prompt unsendable and would never reach
 * the dispatched message. So each accepted image is pushed into the runtime as
 * a `CreateAttachment`, which needs no `AttachmentAdapter`: the composer core
 * stores a `CreateAttachment` complete and sends it untouched. They ride out on
 * `AppendMessage.attachments`, and the store's `onNew` maps them back to
 * `PromptImage[]`.
 */

import type { Attachment, CreateAttachment } from "@assistant-ui/core";
import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react-native";
import type { PromptImage } from "@ompd/core/contracts";
import { type JSX, useMemo } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { useImageAttachments } from "../components/AttachmentsBar.tsx";
import { ghost } from "../design/controls.ts";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, radius, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { ImageAttachmentPicker } from "../platform/attachments.ts";
import type { SessionVoice } from "../screens/SessionScreen.tsx";

export interface OmpComposerProps {
  /**
   * The testID every control on this surface is prefixed with, so one screen's
   * composer is addressable without the other's.
   */
  prefix: string;
  /** The platform seam images come from, live or named-absent. */
  picker: ImageAttachmentPicker;
  /** What the empty field says, which is where each screen states its own gate. */
  placeholder: string;
  /** What assistive technology hears on the send control, target named. */
  sendLabel: string;
  /**
   * The microphone, whole: device capability, this pairing's prompt scope,
   * whether the one microphone is busy elsewhere, and the live dictation. One
   * object rather than seven props, so a caller cannot wire half of it.
   */
  voice: SessionVoice;
  /**
   * This session's resolved model and thinking level, already formatted. Null
   * when the daemon has told this device neither, in which case the control
   * names the surface it opens rather than inventing a model.
   */
  model: string | null;
  /** Open this session's config surface. Absent where there is none to open. */
  onOpenConfig?: () => void;
  /**
   * Why a send will be refused, in words, when the screen knows one the daemon
   * has not yet had a chance to say: a missing prompt scope, a clearance still
   * waiting. The field stays usable and this states why the words will not go.
   */
  refusal?: string;
}

/**
 * `data:` URL in, `PromptImage` out. Non-greedy on the mime and `s` on the
 * payload because base64 has no newlines but a malformed one might.
 */
const IMAGE_DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * One image, as the runtime's own attachment. Positional id and name, because
 * the band is positional: an ordinal in the accessibility label, positional
 * removal, positional testIDs.
 *
 * That pairs with `onImages` being a full replacement and only works paired
 * with it. assistant-ui's store keys its per-attachment clients by id and
 * throws `Duplicate key` outright on a collision, so a reconcile that appended
 * without clearing first would not silently double an image, it would take the
 * screen down. Measured, not assumed: dropping the `clearAttachments` call
 * makes `assistant-composer.test.tsx` fail with exactly that error.
 */
function attachmentFor(image: PromptImage, at: number): CreateAttachment {
  return {
    id: `image-${at + 1}`,
    type: "image",
    name: `Image ${at + 1}`,
    contentType: image.mimeType,
    content: [{ type: "image", image: `data:${image.mimeType};base64,${image.data}` }],
  };
}

/** The same image read back off the runtime, or null for anything else. */
function promptImageOf(attachment: Attachment): PromptImage | null {
  const part = attachment.content?.[0];
  if (part === undefined || part.type !== "image") return null;
  const parsed = IMAGE_DATA_URL.exec(part.image);
  return parsed === null ? null : { mimeType: parsed[1] ?? "", data: parsed[2] ?? "" };
}

export function OmpComposer({
  prefix,
  picker,
  placeholder,
  sendLabel,
  voice,
  model,
  onOpenConfig,
  refusal,
}: OmpComposerProps): JSX.Element {
  const aui = useAui();
  /**
   * Every gate on this surface, from the runtime rather than a prop.
   *
   * `isDisabled` is "this device cannot steer at all" -- no link, a dead
   * session, a pane whose open was refused -- and it is the one that takes the
   * field away. `canSend` already folds in the store's `isSendDisabled`, which
   * is the narrower gate that leaves the operator typing and refuses only the
   * send. `canCancel` is `capabilities.cancel && isRunning`, which is exactly
   * #131's `busy && interruptible`: it is true only where a turn is in flight
   * AND this surface can stop it.
   */
  const isDisabled = useAuiState(s => s.thread.isDisabled);
  const canSend = useAuiState(s => s.composer.canSend);
  const canCancel = useAuiState(s => s.composer.canCancel);
  const held = useAuiState(s => s.composer.attachments);

  /**
   * The prompt's images, both directions, over the runtime's own attachment
   * list. `useImageAttachments` is the shipped gate ladder and refusal
   * vocabulary and it stays the only copy of both; what changes here is only
   * where the accepted set lands. `onImages` is a full replacement by
   * contract, and the runtime honours that synchronously: `clearAttachments`
   * empties the list before it yields, and a `CreateAttachment` is appended
   * before `addAttachment` yields, so the list is exactly `next`, in order, on
   * the next render.
   *
   * One pass produces both views of that list, so a chip and the image it
   * stands for can never end up at different positions: `chips` keeps the
   * runtime's own attachment id for React, and `images` is the same sequence in
   * the wire's vocabulary for the band's gates and for positional removal.
   */
  const chips = useMemo(() => {
    const found: { id: string; image: PromptImage }[] = [];
    for (const attachment of held) {
      const image = promptImageOf(attachment);
      if (image !== null) found.push({ id: attachment.id, image });
    }
    return found;
  }, [held]);
  const images = useMemo(() => chips.map(chip => chip.image), [chips]);
  const band = useImageAttachments({
    picker,
    images,
    enabled: !isDisabled,
    onImages: next => {
      void aui.composer.clearAttachments();
      next.forEach((image, at) => {
        void aui.composer.addAttachment(attachmentFor(image, at));
      });
    },
  });

  /**
   * The microphone gate, cheapest refusal first: what this build can do, what
   * this pairing may do, whether the one microphone is busy elsewhere, then the
   * link. Every refusal is named beside the button rather than taking the
   * control away, because a missing button is read as a missing feature, and
   * `unknown` scope stays pressable exactly as the three-way rule requires: the
   * daemon's refusal, not a local guess, is what turns it off.
   */
  const micGate = !voice.mic.available
    ? "unavailable"
    : voice.access === "missing"
      ? "scope"
      : voice.busyElsewhere
        ? "busy"
        : isDisabled
          ? "offline"
          : "ready";
  const micDisabled = micGate !== "ready" && !voice.capturing;
  // The same ladder, restated so each branch reads its own availability object
  // and TypeScript can narrow it: a gate label cannot carry the reason.
  const micStatus = !voice.mic.available
    ? voice.mic.reason
    : voice.access === "missing"
      ? "This device does not hold the prompt scope. Pair it again with prompt access to speak to this agent."
      : voice.busyElsewhere
        ? "The microphone is already open in another session."
        : isDisabled
          ? "No link"
          : voice.capturing
            ? "Recording"
            : voice.speech.available
              ? "Tap to speak; the agent answers out loud."
              : voice.speech.reason;
  /**
   * The same sentence minus the one form of it that is an instruction rather
   * than news. "Tap to speak" sat under the field permanently, made a band of
   * its own, and was the last thing keeping this surface from reading as one
   * message box. It is the microphone's accessibility hint now.
   */
  const micNotice = micGate === "ready" && !voice.capturing && voice.speech.available ? null : micStatus;

  /**
   * Send is held whenever the runtime says the composer cannot send, or when
   * this device cannot steer at all. The second half is this file's because
   * `composer.canSend` does not include `isDisabled`.
   */
  const sendHeld = isDisabled || !canSend;
  const hasNotes = micNotice !== null || voice.dictation !== null || refusal !== undefined;

  return (
    // The dock pays the margin around the surface and paints nothing: the band
    // above it already carries the composer's colour down through the home
    // indicator, and a second opaque layer here would square the corners off
    // again from behind. The keyboard and the safe-area inset are the screen's,
    // paid once on the view that also paints, exactly as the shipped composer
    // leaves them.
    <View style={styles.dock}>
      <ComposerPrimitive.Root style={styles.surface} testID={`${prefix}-surface`}>
        <ComposerPrimitive.Input
          testID={`${prefix}-input`}
          style={[styles.field, type.body, isDisabled && styles.fieldOff]}
          // The value and its setter are the runtime's; the primitive holds
          // both and its props type forbids passing either.
          editable={!isDisabled}
          multiline
          placeholder={placeholder}
          placeholderTextColor={ink.faint}
          // Enter sends on a keyboard, Shift+Enter is a newline. On native that
          // is `submitBehavior` plus `onSubmitEditing`; on web the primitive
          // owns the key handler and calls `composer.send()` without the
          // `isDisabled` half of the gate, so a held plain Enter is cancelled
          // here before it reaches it.
          submitBehavior="submit"
          onKeyPress={event => {
            const native = event.nativeEvent;
            // React Native's `TextInputKeyPressEventData` carries only `key`.
            // react-native-web hands the DOM keyboard event straight through,
            // which is where `shiftKey` comes from and the only target where
            // the primitive's Enter path exists to be cancelled.
            const shift = "shiftKey" in native && native.shiftKey === true;
            if (native.key === "Enter" && !shift && sendHeld) event.preventDefault();
          }}
          onSubmitEditing={() => {
            if (!sendHeld) aui.composer.send();
          }}
        />

        {/*
          The chips and the sentences, under the words they will ride with and
          inside the same surface. Absent entirely while there is nothing to
          say, so an ordinary empty composer is the field and the row.
        */}
        {chips.length === 0 && band.status === "" ? null : (
          <View style={styles.band} testID={`${prefix}-attachments`}>
            {chips.length === 0 ? null : (
              <View style={styles.chips}>
                {chips.map(({ id, image }, index) => (
                  <View key={id} style={styles.chip} testID={`${prefix}-attachment-${index}`}>
                    <Image source={{ uri: `data:${image.mimeType};base64,${image.data}` }} style={styles.thumb} />
                    <Pressable
                      testID={`${prefix}-attachment-remove-${index}`}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove image ${index + 1}`}
                      onPress={() => {
                        band.remove(index);
                      }}
                      style={({ pressed }) => [styles.remove, pressed && styles.removePressed]}
                    >
                      <Glyph name="deny" size={10} color={ink.plain} />
                    </Pressable>
                  </View>
                ))}
              </View>
            )}
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
        )}

        {/*
          Prose in the column, never a layer over it, and never permanently: a
          refusal or a live dictation occupies real space between the words and
          the action row, so a long one pushes the row down rather than painting
          across it.
        */}
        {hasNotes ? (
          <View style={styles.band}>
            {refusal === undefined ? null : (
              <Label color={ink.plain} testID={`${prefix}-refusal`}>
                {refusal}
              </Label>
            )}
            {micNotice === null ? null : (
              <Label color={ink.plain} testID={`${prefix}-mic-status`}>
                {micNotice}
              </Label>
            )}
            {voice.dictation === null ? null : (
              <Label color={ink.bright} testID={`${prefix}-dictation`}>
                {voice.dictation.final ? voice.dictation.text : `${voice.dictation.text} ...`}
              </Label>
            )}
          </View>
        ) : null}

        {/*
          The action row: one row, two ends. Left is what adds to the prompt,
          right is what acts on it. `space-between` rather than a spacer view,
          so neither end can drift when the other grows.
        */}
        <View style={styles.actions} testID={`${prefix}-actions`}>
          <View style={styles.group} testID={`${prefix}-actions-left`}>
            {/*
              The paperclip. A plain Pressable rather than
              `ComposerPrimitive.AddAttachment`, which renders no `onPress` and
              forbids one; see the note at the top of this file. It carries no
              visible label on purpose: the row is a row of gestures and the
              band above explains this one. Assistive technology hears both.
            */}
            <Pressable
              testID={`${prefix}-attach`}
              accessibilityRole="button"
              accessibilityLabel="Attach an image to this prompt"
              accessibilityHint="Choose images from this device's photo library"
              accessibilityState={{ disabled: band.disabled }}
              disabled={band.disabled}
              onPress={band.pick}
              style={({ pressed }) => [ghost.icon, pressed && !band.disabled && ghost.pressed]}
            >
              <Glyph
                name="attachment"
                size={14}
                color={band.disabled ? ink.faint : chips.length > 0 ? signal.sage : ink.plain}
              />
            </Pressable>
          </View>

          <View style={styles.group} testID={`${prefix}-actions-right`}>
            {/*
              This session's model, in the row with the words it will be spent
              on, named rather than labelled `Config`. Falls back to the
              surface's own name when the daemon has told this device neither,
              because inventing a model here would be worse than a generic word.
            */}
            {onOpenConfig === undefined ? null : (
              <Pressable
                testID="session-open-config"
                accessibilityRole="button"
                accessibilityLabel={
                  model === null
                    ? "Open this session's mode and model"
                    : `Open this session's mode and model, now ${model}`
                }
                onPress={onOpenConfig}
                style={({ pressed }) => [ghost.labelled, pressed && ghost.pressed]}
              >
                <Label color={ink.muted} numberOfLines={1} testID="session-model-label">
                  {model ?? "Config"}
                </Label>
                <Glyph name="chevron" size={11} color={ink.faint} />
              </Pressable>
            )}

            <Pressable
              testID={`${prefix}-mic`}
              accessibilityRole="button"
              accessibilityLabel={voice.capturing ? "Stop the microphone and send" : "Speak to this agent"}
              // The sentence that used to sit permanently under the field. It
              // costs nothing here and it is the whole of what a screen reader
              // needs.
              accessibilityHint={micStatus}
              accessibilityState={{ disabled: micDisabled, selected: voice.capturing }}
              disabled={micDisabled}
              onPress={voice.onToggle}
              style={({ pressed }) => [
                ghost.icon,
                voice.capturing && ghost.live,
                pressed && !micDisabled && ghost.pressed,
              ]}
            >
              <Glyph
                name="mic"
                size={15}
                color={voice.capturing ? signal.amber : micDisabled ? ink.faint : ink.plain}
              />
            </Pressable>

            {/*
              The one emphasised control, in one slot, wearing one geometry.
              Which of the two it is comes from `canCancel`, which is the
              runtime's own `capabilities.cancel && isRunning`: mid-turn on a
              surface that can stop the turn, this is an interrupt, because the
              useful thing to do while an agent is working is stop it and
              queueing a second prompt behind the first is how two instructions
              get interleaved into one confused turn. Where a turn cannot be
              cancelled from here the send stays a send, which is why `disabled`
              is passed explicitly: the library's own predicate holds every send
              while `thread.isRunning`, and prompting a terminal mid-turn is a
              steer rather than a second instruction.
            */}
            {canCancel ? (
              <ComposerPrimitive.Cancel
                testID={`${prefix}-cancel`}
                accessibilityLabel="Interrupt this turn"
                style={({ pressed }) => [styles.emphasis, styles.stop, pressed && styles.stopPressed]}
              >
                <Glyph name="interrupt" size={15} color={ink.inverse} />
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send
                testID={`${prefix}-send`}
                accessibilityLabel={sendLabel}
                accessibilityState={{ disabled: sendHeld }}
                disabled={sendHeld}
                style={({ pressed }) => [
                  styles.emphasis,
                  sendHeld ? styles.sendHeld : styles.sendReady,
                  pressed && !sendHeld && styles.sendPressed,
                ]}
              >
                <Glyph name="send" size={15} color={sendHeld ? ink.faint : ink.inverse} />
              </ComposerPrimitive.Send>
            )}
          </View>
        </View>
      </ComposerPrimitive.Root>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { paddingHorizontal: space.step, paddingTop: space.snug, paddingBottom: space.snug },
  // The one box on this control. Everything inside it is borderless, which is
  // the difference between a message surface and a control panel.
  surface: {
    gap: space.snug,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    borderRadius: radius.surface,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.snug,
  },
  // Each end of the row. `flexShrink` so a long right group gives way rather
  // than pushing the paperclip off the left edge of a narrow phone.
  group: { flexDirection: "row", alignItems: "center", gap: space.tight, flexShrink: 1 },
  // Borderless, transparent, and side-padded by the surface: a field with its
  // own edge is a box inside a box, which is the defect this shape exists to
  // stop. `minHeight` keeps a tap anywhere in the empty box landing on the
  // field rather than on the surface behind it; `maxHeight` is also what the
  // primitive's own web auto-grow clamps its measured height to.
  field: {
    minHeight: TOUCH_TARGET,
    maxHeight: 140,
    paddingHorizontal: 0,
    paddingVertical: space.tight,
    color: ink.bright,
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  fieldOff: { color: ink.faint },
  band: { gap: space.tight },
  notice: { flexShrink: 1 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.snug },
  // A chip is an object you pick up, so it is the one thing inside the surface
  // that wears an edge, at the control radius rather than the surface's.
  chip: {
    backgroundColor: ground.active,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    borderRadius: radius.control,
    padding: space.tight,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.tight,
  },
  thumb: { width: 48, height: 48, borderRadius: radius.control, backgroundColor: ground.base },
  remove: {
    minHeight: 28,
    minWidth: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  removePressed: { backgroundColor: ground.active },
  // The one emphasised control, and the reason the ghosts beside it can stay
  // quiet. Round rather than merely rounded: nothing else on the surface is, so
  // the shape alone answers "what do I press".
  emphasis: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  sendReady: { backgroundColor: signal.sage },
  // Present, unmistakably not ready. A filled-but-quiet disc rather than a
  // vanished control: an operator has to be able to see where send lives before
  // they have typed anything.
  sendHeld: { backgroundColor: ground.active },
  sendPressed: { backgroundColor: signal.sage, opacity: 0.72 },
  stop: { backgroundColor: signal.oxide },
  stopPressed: { opacity: 0.72 },
});
