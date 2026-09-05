/**
 * Where the operator says something. One control, every surface that takes a
 * prompt.
 *
 * The shape is the one a person already knows from every other composer they
 * have used: the words fill the top of the surface, and a single row of
 * gestures sits under them, inside the same box. The paperclip is at that
 * row's left end and everything that acts on what was typed is grouped at its
 * right end.
 *
 * ## One surface, and what that took
 *
 * Getting the controls into the right row was the first half. The second half
 * is that it has to read as *one object*, and the first pass did not. Reported
 * on a phone frame and true: a hairline rectangle for the field, nested inside
 * a hairline rectangle for the composer, beside a boxed paperclip and three
 * more equally boxed widgets, with an instructional sentence between them
 * making a fourth band. Every element correct, the whole thing a control
 * panel. A message box is a single thing you type into.
 *
 * So the visual rules here are as load-bearing as the layout ones:
 *
 *  - **The surface owns the box.** One rounded container carries the
 *    background and the only border. Nothing inside it draws a second one.
 *  - **The field is borderless.** It is transparent and unpadded on the sides,
 *    because the surface already padded it. A field with its own edge is a
 *    box in a box, which is the whole defect.
 *  - **One emphasis per surface.** Send is filled. The paperclip, the
 *    microphone, and the model are ghosts: a 44-point target, a rounded press
 *    state, and no permanent cage. Four boxes of equal weight is four things
 *    shouting; one filled control is an answer to "what do I press".
 *  - **Chrome is not content.** Nothing sits in this surface permanently to
 *    explain a control. A refusal appears when there is one, dictation appears
 *    while there is dictation, and the instructions live on the control's
 *    accessibility hint where they cost no pixels.
 *
 * ## The action itself
 *
 * Two states, and they are not the same control. Idle, it sends. Mid-turn it
 * becomes an interrupt where the turn can be cancelled from here, because the
 * useful thing to do while an agent is working is stop it, and queueing a
 * second prompt behind the first is how two instructions get interleaved into
 * one confused turn. Where a turn cannot be cancelled from here, `onCancel` is
 * absent and the send stays a send: prompting a terminal mid-turn is a steer,
 * the delivery the daemon itself defaults to. Both wear the same geometry in
 * the same slot, so the paperclip never moves when the turn state changes.
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
 * microphone and a session's model belong: they act on the turn being
 * composed. `notes` is prose those controls need *when they have any*, which
 * is why it is a slot rather than a string.
 */

import type { PromptImage } from "@ompd/core/contracts";
import type { JSX, ReactNode } from "react";
import { useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { ground, ink, radius, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
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
  onSubmit: (text: string, images?: PromptImage[]) => unknown;
  /**
   * Cancel the running turn. Present only where a turn can be cancelled from
   * here; with it, send becomes Stop while `busy`. Absent, sending stays
   * available mid-turn because it is a steer rather than a second instruction.
   */
  onCancel?: () => void;
  /**
   * The screen's own ghost controls for the action row's right group, rendered
   * before send: the microphone, this session's model. Their gates are the
   * screen's state, so the screen renders them and this component places them.
   */
  actions?: ReactNode;
  /**
   * Prose those controls need, between the words and the action row, and only
   * when there is some. Nothing permanent belongs here.
   */
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
  const stopping = busy && interruptible;

  const send = (): void => {
    if (!canSend) return;
    try {
      const result = onSubmit(trimmed, images.length > 0 ? images : undefined);
      if (result === false) return;
      if (result instanceof Promise) {
        result.then(
          sent => {
            if (sent === false) return;
            setText("");
            setImages([]);
          },
          () => {
            // Keep draft on rejection
          },
        );
        return;
      }
      setText("");
      setImages([]);
    } catch {
      // Keep draft on rejection
    }
  };

  return (
    // The dock pays the margin around the surface and paints nothing: the band
    // above it already carries the composer's colour down through the home
    // indicator, and a second opaque layer here would square the corners off
    // again from behind.
    <View style={styles.dock}>
      <View style={styles.surface} testID={`${prefix}-surface`}>
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
          The chips and the refusal, under the words they will ride with, and
          inside the same surface. The band is empty and invisible until there
          is something to say, so it costs no height in the ordinary case.
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
            {stopping ? (
              <Pressable
                testID={`${prefix}-cancel`}
                accessibilityRole="button"
                accessibilityLabel="Interrupt this turn"
                onPress={onCancel}
                style={({ pressed }) => [styles.emphasis, styles.stop, pressed && styles.stopPressed]}
              >
                <Glyph name="interrupt" size={15} color={ink.inverse} />
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
                  styles.emphasis,
                  canSend ? styles.sendReady : styles.sendHeld,
                  pressed && canSend && styles.sendPressed,
                ]}
              >
                <Glyph name="send" size={15} color={canSend ? ink.inverse : ink.faint} />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The terminal's composer sat at 12 across while its own header, the agent's
  // composer and every other band on the screen sat at 16. Four points of
  // misalignment between the message box and the header directly above it, on
  // the one screen a person types on. Both 8s were already `dockPad`; only the
  // 12 was wrong, and it was wrong because it was a step picked by size.
  dock: { paddingHorizontal: rhythm.gutter, paddingTop: rhythm.dockPad, paddingBottom: rhythm.dockPad },
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
  // own edge is a box inside a box, which is the defect this file exists to
  // stop. `minHeight` keeps a tap anywhere in the empty box landing on the
  // field rather than on the surface behind it.
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
  // The one emphasised control, and the reason the ghosts beside it can stay
  // quiet. Round rather than merely rounded: nothing else on the surface is,
  // so the shape alone answers "what do I press".
  emphasis: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  sendReady: { backgroundColor: signal.sage },
  // Present, unmistakably not ready. A filled-but-quiet disc rather than a
  // vanished control: an operator has to be able to see where send lives
  // before they have typed anything.
  sendHeld: { backgroundColor: ground.active },
  sendPressed: { backgroundColor: signal.sage, opacity: 0.72 },
  stop: { backgroundColor: signal.oxide },
  stopPressed: { opacity: 0.72 },
});
