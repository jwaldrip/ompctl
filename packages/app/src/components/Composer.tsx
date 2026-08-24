/**
 * Where the operator says something. One control, every surface that takes a
 * prompt.
 *
 * The shape is the one a person already knows from every other composer they
 * have used: the words fill the top of the surface, and a single row of
 * gestures sits under them, inside the same box. The paperclip is at that
 * row's left end and everything that acts on what was typed is grouped at its
 * right end. That grouping is the whole point of the row. Before it, the
 * attachment control sat above the field and the microphone sat above that in
 * a band of its own, so three controls belonging to one act were spread
 * across three horizontal bands and only one of them looked like part of the
 * composer.
 *
 * Two states of the action itself, and they are not the same control. Idle, it
 * sends. Mid-turn it becomes an interrupt where the turn can be cancelled from
 * here, because the useful thing to do while an agent is working is stop it,
 * and queueing a second prompt behind the first is how two instructions get
 * interleaved into one confused turn. Where a turn cannot be cancelled from
 * here, `onCancel` is absent and the send stays a send: prompting a terminal
 * mid-turn is a steer, the delivery the daemon itself defaults to.
 *
 * The field stays editable while a turn runs so the next prompt can be typed
 * during it. Only sending is held.
 *
 * A prompt is words plus whatever images the operator attached, so the
 * attachment band is part of this control, not a visitor to it: the chips
 * clear with the words on send, and an image-only prompt is as sendable as a
 * text-only one.
 *
 * The two things a screen owns rather than this component are passed in.
 * `actions` are its own controls for the row's right group, which is where a
 * microphone and a session's mode and model belong: they act on the turn
 * being composed, so they sit in the composer rather than in a screen header
 * a thumb cannot reach. `notes` is the prose those controls need, which
 * cannot live in the row because the row is 44 points of gestures and a
 * refusal is a sentence.
 */

import type { PromptImage } from "@ompd/core/contracts";
import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { ImageAttachmentPicker } from "../platform/attachments.ts";
import { AttachmentControl, AttachmentsBar, useImageAttachments } from "./AttachmentsBar.tsx";

export interface ComposerProps {
  /**
   * The testID every control on this surface is prefixed with, so one screen's
   * composer is addressable without the other's: `composer` for an agent's
   * log, `terminal-composer` for a terminal's.
   */
  prefix: string;
  /** The platform seam images come from, live or named-absent. */
  picker: ImageAttachmentPicker;
  /** False when there is no link, no scope, or the target cannot take a prompt. */
  enabled: boolean;
  /** What the empty field says, which is where each screen states its own gate. */
  placeholder: string;
  /** What assistive technology hears on the send control, target named. */
  sendLabel: string;
  /** True while a turn is in flight. */
  busy: boolean;
  onSubmit: (text: string, images?: PromptImage[]) => void;
  /**
   * Cancel the running turn. Present only where a turn can be cancelled from
   * here; with it, send becomes Stop while `busy`. Absent, sending stays
   * available mid-turn because it is a steer rather than a second instruction.
   */
  onCancel?: () => void;
  /**
   * The screen's own controls for the action row's right group, rendered
   * before send: the microphone, this session's mode and model. Their gates
   * are the screen's state, so the screen renders them and this component
   * places them.
   */
  actions?: ReactNode;
  /** The prose those controls need, between the words and the action row. */
  notes?: ReactNode;
}

export function Composer({
  prefix,
  picker,
  enabled,
  placeholder,
  sendLabel,
  busy,
  onSubmit,
  onCancel,
  actions,
  notes,
}: ComposerProps): JSX.Element {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const band = useImageAttachments({ picker, images, onImages: setImages, enabled });
  const trimmed = text.trim();
  // Only a surface that can cancel holds its send while a turn runs. Where it
  // cannot, holding would refuse the one thing the operator can still do.
  const interruptible = onCancel !== undefined;
  const canSend = enabled && !(busy && interruptible) && (trimmed.length > 0 || images.length > 0);

  const send = (): void => {
    if (!canSend) return;
    onSubmit(trimmed, images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
  };

  return (
    <View style={styles.composer} testID={`${prefix}-surface`}>
      <TextInput
        testID={`${prefix}-input`}
        style={[styles.field, type.body, !enabled && styles.fieldOff]}
        value={text}
        onChangeText={setText}
        editable={enabled}
        multiline
        placeholder={placeholder}
        placeholderTextColor={ink.faint}
        // Enter sends on a keyboard; Shift+Enter is a newline, which is what
        // `multiline` plus `submitBehavior: "submit"` leaves working.
        submitBehavior="submit"
        onSubmitEditing={send}
      />

      {/*
        The chips and the refusal, under the words they will ride with. The
        band renders its own named-unavailable state, so it is never
        conditionally hidden: a platform that cannot attach says so here
        rather than losing the control from the row below.
      */}
      <AttachmentsBar band={band} prefix={prefix} />
      {notes}

      {/*
        The action row: one row, two ends. Left is what adds to the prompt,
        right is what acts on it. `space-between` rather than a spacer view,
        so a row with nothing in its right group still puts the paperclip at
        the left edge, and neither end can drift when the other grows.
      */}
      <View style={styles.actions} testID={`${prefix}-actions`}>
        <View style={styles.group} testID={`${prefix}-actions-left`}>
          <AttachmentControl band={band} prefix={prefix} />
        </View>

        <View style={styles.group} testID={`${prefix}-actions-right`}>
          {actions}
          {busy && interruptible ? (
            <Pressable
              testID={`${prefix}-cancel`}
              accessibilityRole="button"
              accessibilityLabel="Interrupt this turn"
              onPress={onCancel}
              style={({ pressed }) => [
                styles.action,
                { borderColor: signal.oxide },
                pressed && { backgroundColor: ground.active },
              ]}
            >
              <Glyph name="interrupt" size={14} color={signal.oxide} />
              <Label color={signal.oxide}>Stop</Label>
            </Pressable>
          ) : (
            <Pressable
              testID={`${prefix}-send`}
              accessibilityRole="button"
              accessibilityLabel={sendLabel}
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={send}
              style={({ pressed }) => [
                styles.action,
                { borderColor: canSend ? signal.sage : ground.edge },
                pressed && { backgroundColor: ground.active },
              ]}
            >
              <Glyph name="send" size={14} color={canSend ? signal.sage : ink.faint} />
              <Label color={canSend ? signal.sage : ink.faint}>Send</Label>
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  composer: {
    gap: space.tight,
    padding: space.step,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.snug,
  },
  // Each end of the row. `flexShrink` so a long right group gives way rather
  // than pushing the paperclip off the left edge of a narrow phone.
  group: { flexDirection: "row", alignItems: "center", gap: space.snug, flexShrink: 1 },
  // No `flex: 1`: the field is its own row now, and a stretched child fills
  // the surface's width without being told to.
  field: {
    minHeight: TOUCH_TARGET,
    maxHeight: 140,
    paddingHorizontal: space.step,
    paddingVertical: space.snug,
    color: ink.bright,
    backgroundColor: ground.base,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  fieldOff: { color: ink.faint },
  action: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    borderWidth: stroke.hair,
  },
});
