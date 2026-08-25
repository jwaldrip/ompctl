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
 *    The paperclip, the microphone and the model are ghosts: a 44-point
 *    target, a press treatment, and no permanent cage.
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
 * ## Where the pixels come from now
 *
 * Paper supplies the controls, `rhythm` supplies the air, and assistant-ui
 * still supplies the conversation.
 *
 *  - The box is a Paper `Surface`, flat and unelevated. It replaces
 *    `ComposerPrimitive.Root`, which costs nothing to give up: `Root` is a
 *    `View` passthrough with no context, no hook and no behaviour
 *    (`ComposerRoot.tsx` is ten lines). `Input`, `Send` and `Cancel` are the
 *    primitives that read the runtime, and all three stay.
 *  - The microphone is an `IconButton`, and so are the paperclip and a chip's
 *    remove badge by way of `AttachmentsBar`. `design/controls.ts` and its
 *    hand-rolled `ghost` styles are deleted: a 44-point target, a rounded
 *    press state and no permanent edge is what an `IconButton` already is.
 *  - The model control is a Paper `TouchableRipple` rather than a `Button`,
 *    because `Button` renders the label as its own `Text` at
 *    `<testID>-text` and puts the icon before it. This control is a word then
 *    a chevron, and `session-model-label` has to stay the label's own handle.
 *  - Every gap is a `rhythm` job. The dock pays `gutter` horizontally, so the
 *    message box shares one left edge with the header and the readout above
 *    it, and `dockPad` vertically, because the home indicator already reserves
 *    its own space.
 *
 * Structural measurement stays in the `StyleSheet` block and colour is read
 * off `useOmpTheme()`, which is not a style preference: react-native-web
 * compiles only `StyleSheet.create` values into its atomic sheet and writes
 * everything else to the element, so a width written at render time is
 * invisible to the checks that price this surface.
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
 *    therefore always false on a thread composer.
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
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { IconButton, Surface, TouchableRipple } from "react-native-paper";
import { AttachmentControl, AttachmentsBar, useImageAttachments } from "../components/AttachmentsBar.tsx";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Label } from "../design/text.tsx";
import { radius, space, stroke, type } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
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

/** The microphone's glyph, and the send disc's. Icon weight, not spacing. */
const MIC_GLYPH = 15;
const ACTION_GLYPH = 15;
/** The chevron beside the model name, a step smaller than the word it follows. */
const CHEVRON_GLYPH = 11;

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
  const theme = useOmpTheme();
  const { fontScale } = useWindowDimensions();
  // A larger face owns more vertical room per line, so a fixed pixel ceiling
  // buries the action row behind the keyboard at accessibility sizes. Keep the
  // same baseline field at 1x and reduce the visible line count as the face
  // grows; the multiline input scrolls instead of taking the action away.
  const fieldMaxHeight = Math.max(rhythm.minTarget, FIELD_MAX_HEIGHT / (fontScale * fontScale));
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
   */
  const images = useMemo(() => {
    const found: PromptImage[] = [];
    for (const attachment of held) {
      const image = promptImageOf(attachment);
      if (image !== null) found.push(image);
    }
    return found;
  }, [held]);
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
  const micTone = voice.capturing ? theme.signal.amber : micDisabled ? theme.ink.faint : theme.ink.plain;

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
    // leaves them. The screen gutter is paid HERE and only here, so the three
    // alternate bands the shell draws in this slot share the composer's left
    // edge; the shell's own wrapper pays nothing horizontally.
    <View style={styles.dock} testID={`${prefix}-dock`}>
      <Surface
        mode="flat"
        elevation={0}
        testID={`${prefix}-surface`}
        style={[styles.surface, { backgroundColor: theme.ground.raised, borderColor: theme.ground.line }]}
      >
        <ComposerPrimitive.Input
          testID={`${prefix}-input`}
          style={[styles.field, { color: isDisabled ? theme.ink.faint : theme.ink.bright, maxHeight: fieldMaxHeight }]}
          // The value and its setter are the runtime's; the primitive holds
          // both and its props type forbids passing either.
          editable={!isDisabled}
          numberOfLines={2}
          scrollEnabled
          multiline
          placeholder={placeholder}
          placeholderTextColor={theme.ink.faint}
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
          inside the same surface. One band, drawn in one place for both
          composers, absent entirely while there is nothing to say -- so an
          ordinary empty composer is the field and the row.
        */}
        <AttachmentsBar band={band} prefix={prefix} />

        {/*
          Prose in the column, never a layer over it, and never permanently: a
          refusal or a live dictation occupies real space between the words and
          the action row, so a long one pushes the row down rather than painting
          across it.
        */}
        {hasNotes ? (
          <View style={styles.band}>
            {refusal === undefined ? null : (
              <Label color={theme.ink.plain} testID={`${prefix}-refusal`}>
                {refusal}
              </Label>
            )}
            {micNotice === null ? null : (
              <Label color={theme.ink.plain} testID={`${prefix}-mic-status`}>
                {micNotice}
              </Label>
            )}
            {voice.dictation === null ? null : (
              <Label color={theme.ink.bright} testID={`${prefix}-dictation`}>
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
              The paperclip, from the same file that owns the chips, so the two
              halves of one band cannot end up with two arrangements. It carries
              no visible label on purpose: the row is a row of gestures and the
              band above explains this one. Assistive technology hears both.
            */}
            <AttachmentControl band={band} prefix={prefix} />
          </View>

          <View style={styles.group} testID={`${prefix}-actions-right`}>
            {/*
              This session's model, in the row with the words it will be spent
              on, named rather than labelled `Config`. Falls back to the
              surface's own name when the daemon has told this device neither,
              because inventing a model here would be worse than a generic word.
            */}
            {onOpenConfig === undefined ? null : (
              <TouchableRipple
                testID="session-open-config"
                accessibilityRole="button"
                accessibilityLabel={
                  model === null
                    ? "Open this session's mode and model"
                    : `Open this session's mode and model, now ${model}`
                }
                onPress={onOpenConfig}
                borderless
                rippleColor={theme.ground.active}
                style={styles.labelled}
              >
                <View style={styles.labelledContent}>
                  <Label color={theme.ink.muted} numberOfLines={1} testID="session-model-label">
                    {model ?? "Config"}
                  </Label>
                  <Glyph name="chevron" size={CHEVRON_GLYPH} color={theme.ink.faint} />
                </View>
              </TouchableRipple>
            )}

            <IconButton
              testID={`${prefix}-mic`}
              accessibilityLabel={voice.capturing ? "Stop the microphone and send" : "Speak to this agent"}
              // The sentence that used to sit permanently under the field. It
              // costs nothing here and it is the whole of what a screen reader
              // needs.
              accessibilityHint={micStatus}
              accessibilityState={{ disabled: micDisabled, selected: voice.capturing }}
              disabled={micDisabled}
              onPress={voice.onToggle}
              icon={({ size }) => <Glyph name="mic" size={size} color={micTone} />}
              size={MIC_GLYPH}
              // Held on is a wash rather than a border, so turning the
              // microphone on does not change the row's silhouette.
              containerColor={voice.capturing ? theme.ground.active : "transparent"}
              rippleColor={theme.ground.active}
              style={[styles.iconTarget, styles.noMargin]}
              contentStyle={styles.iconTarget}
            />

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

              These two stay `ComposerPrimitive` where every other control on
              the row is Paper's, because the runtime drives them: `Send` reads
              `useComposerSend()` and `Cancel` reads `useComposerCancel()`, so
              the action cannot drift from the thread it acts on.
            */}
            {canCancel ? (
              <ComposerPrimitive.Cancel
                testID={`${prefix}-cancel`}
                accessibilityLabel="Interrupt this turn"
                style={({ pressed }) => [
                  styles.emphasis,
                  { backgroundColor: theme.signal.oxide },
                  pressed && styles.pressedDim,
                ]}
              >
                <Glyph name="interrupt" size={ACTION_GLYPH} color={theme.ink.inverse} />
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send
                testID={`${prefix}-send`}
                accessibilityLabel={sendLabel}
                accessibilityState={{ disabled: sendHeld }}
                disabled={sendHeld}
                style={({ pressed }) => [
                  styles.emphasis,
                  // Held is present and unmistakably not ready: a filled but
                  // quiet disc rather than a vanished control, because an
                  // operator has to see where send lives before they have
                  // typed anything.
                  { backgroundColor: sendHeld ? theme.ground.active : theme.signal.sage },
                  pressed && !sendHeld && styles.pressedDim,
                ]}
              >
                <Glyph name="send" size={ACTION_GLYPH} color={sendHeld ? theme.ink.faint : theme.ink.inverse} />
              </ComposerPrimitive.Send>
            )}
          </View>
        </View>
      </Surface>
    </View>
  );
}

/** What the field's own height is allowed to grow to before it scrolls. */
const FIELD_MAX_HEIGHT = 140;

const styles = StyleSheet.create({
  dock: {
    paddingHorizontal: rhythm.gutter,
    paddingTop: rhythm.dockPad,
    paddingBottom: rhythm.dockPad,
  },
  // The one box on this control. Everything inside it is borderless, which is
  // the difference between a message surface and a control panel.
  surface: {
    gap: rhythm.rowGapTight,
    paddingHorizontal: rhythm.cardPad,
    paddingVertical: rhythm.cardPad,
    borderWidth: stroke.hair,
    borderRadius: radius.surface,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: rhythm.cardGap,
  },
  // Each end of the row. `flexShrink` so a long right group gives way rather
  // than pushing the paperclip off the left edge of a narrow phone.
  group: { flexDirection: "row", alignItems: "center", gap: rhythm.cardGap, flexShrink: 1 },
  // Borderless, transparent, and side-padded by the surface: a field with its
  // own edge is a box inside a box, which is the defect this shape exists to
  // stop. `minHeight` keeps a tap anywhere in the empty box landing on the
  // field rather than on the surface behind it, and keeps the box growing with
  // the type rather than clipping it; `maxHeight` is also what the primitive's
  // own web auto-grow clamps its measured height to.
  field: {
    ...type.body,
    minHeight: rhythm.minTarget,
    maxHeight: FIELD_MAX_HEIGHT,
    paddingHorizontal: 0,
    // The four points that keep the first line of a multiline field off the
    // top edge of its own 44-point box. Deliberately a raw grid step and not a
    // `rhythm` token: the scale names a control's own padding on the
    // horizontal axis only (`controlPad`), and borrowing a token whose job is
    // something else is the defect this scale exists to end.
    paddingVertical: space.tight,
    backgroundColor: "transparent",
    borderWidth: 0,
  },
  band: { gap: rhythm.rowGapTight },
  /**
   * The model control: a word and a chevron, so as tall and as round as the
   * ghosts beside it, only wider.
   */
  labelled: {
    minHeight: rhythm.minTarget,
    paddingHorizontal: rhythm.controlPad,
    justifyContent: "center",
    borderRadius: radius.control,
    flexShrink: 1,
  },
  labelledContent: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap, flexShrink: 1 },
  /**
   * A ghost target: the whole 44-point square, so a row of them keeps an even
   * rhythm and a finger lands on any of them.
   */
  iconTarget: { width: rhythm.minTarget, height: rhythm.minTarget, borderRadius: radius.control },
  /**
   * `IconButton` pays itself a six-point margin. A control in a row of
   * controls owes its rhythm to the row, not to itself.
   */
  noMargin: { margin: 0 },
  // The one emphasised control, and the reason the ghosts beside it can stay
  // quiet. Round rather than merely rounded: nothing else on the surface is, so
  // the shape alone answers "what do I press".
  emphasis: {
    width: rhythm.minTarget,
    height: rhythm.minTarget,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  pressedDim: { opacity: 0.72 },
});
