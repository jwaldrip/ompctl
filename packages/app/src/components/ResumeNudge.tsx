/**
 * Guidance when opening long or old dormant sessions.
 *
 * Prevents operators from inadvertently resuming stale, context-heavy
 * sessions across tasks. Shows a sheet on phones or a dialog on tablets
 * with the facts and offers "Start fresh here" as the primary action and
 * "Resume anyway" as the secondary.
 */

import type { JSX } from "react";
import { memo } from "react";
import { Modal, Pressable, type PressableStateCallbackType, StyleSheet, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
import { Body, Label, Title } from "../design/text.tsx";
import { brand, ground, ink, radius, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { BrowserSession } from "../session/browser.ts";

/**
 * Sessions older than 24 hours: context is stale, repo state has moved,
 * and the agent is likely to drift across tasks.
 */
export const RESUME_NUDGE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Sessions with over 200 messages: large transcripts accumulate token baggage,
 * degrade prefill speed, and increase hallucination/drift across tasks.
 */
export const RESUME_NUDGE_MESSAGES = 200;

export function formatTimeAgo(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "some time ago";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${days === 1 ? "day" : "days"} ago`;
  const months = Math.floor(days / 30);
  return `${months} ${months === 1 ? "month" : "months"} ago`;
}

export function formatResumeNudgeSentence(session: BrowserSession, now: number = Date.now()): string {
  const messages = session.messageCount.toLocaleString();
  const word = session.messageCount === 1 ? "message" : "messages";
  const ago = formatTimeAgo(session.lastActiveAt, now);
  return `This session has ${messages} ${word} and was last active ${ago}. Long sessions get slower and drift across tasks.`;
}

export function shouldNudgeResume(
  session: BrowserSession,
  resumedSessionIds?: ReadonlySet<string>,
  now: number = Date.now(),
): boolean {
  if (session.status !== "dormant") return false;
  if (resumedSessionIds?.has(session.id)) return false;
  const then = Date.parse(session.lastActiveAt);
  const age = Number.isNaN(then) ? 0 : Math.max(0, now - then);
  return age > RESUME_NUDGE_AGE_MS || session.messageCount > RESUME_NUDGE_MESSAGES;
}

export interface ResumeNudgeProps {
  session: BrowserSession;
  onStartFresh: () => void;
  onResumeAnyway: () => void;
  onClose: () => void;
  now?: number;
}

const primaryStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.primaryButton,
  pressed && styles.primaryButtonPressed,
];

const secondaryStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.secondaryButton,
  pressed && styles.secondaryButtonPressed,
];

export const ResumeNudge = memo(function ResumeNudge({
  session,
  onStartFresh,
  onResumeAnyway,
  onClose,
  now,
}: ResumeNudgeProps): JSX.Element {
  const isTablet = useIsTablet();
  const sentence = formatResumeNudgeSentence(session, now);

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose}>
      <View style={isTablet ? styles.popoverOverlay : styles.sheetOverlay}>
        <Pressable
          testID="resume-nudge-backdrop"
          accessibilityLabel="Close resume guidance"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          testID={isTablet ? "resume-nudge-dialog" : "resume-nudge-sheet"}
          style={isTablet ? styles.popoverSurface : styles.sheetSurface}
        >
          {!isTablet ? <View style={styles.sheetHandle} /> : null}
          <View style={styles.header}>
            <Title color={ink.bright}>Resume session?</Title>
            <Pressable
              testID="resume-nudge-close"
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={space.snug}
              style={styles.closeBtn}
            >
              <Glyph name="deny" size={12} color={ink.faint} />
            </Pressable>
          </View>
          <View style={styles.content}>
            <Body color={ink.plain} testID="resume-nudge-facts">
              {sentence}
            </Body>
          </View>
          <View style={styles.actions}>
            <Pressable
              testID="resume-nudge-start-fresh"
              accessibilityRole="button"
              accessibilityLabel="Start fresh here"
              onPress={onStartFresh}
              style={primaryStyle}
            >
              <Label color={ink.inverse} style={styles.primaryText}>
                Start fresh here
              </Label>
            </Pressable>
            <Pressable
              testID="resume-nudge-resume-anyway"
              accessibilityRole="button"
              accessibilityLabel="Resume anyway"
              onPress={onResumeAnyway}
              style={secondaryStyle}
            >
              <Label color={ink.plain} style={styles.secondaryText}>
                Resume anyway
              </Label>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const DIALOG_MAX_WIDTH = 460;

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10, 12, 16, 0.7)",
  },
  sheetOverlay: {
    flex: 1,
    justifyContent: "flex-end",
  },
  sheetSurface: {
    backgroundColor: ground.surface,
    borderTopLeftRadius: radius.surface,
    borderTopRightRadius: radius.surface,
    borderTopWidth: stroke.hair,
    borderColor: ground.edge,
    paddingHorizontal: space.wide,
    paddingBottom: space.loose,
    paddingTop: space.snug,
    gap: space.step,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: ground.edge,
    alignSelf: "center",
    marginBottom: space.tight,
  },
  popoverOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.step,
  },
  popoverSurface: {
    width: "100%",
    maxWidth: DIALOG_MAX_WIDTH,
    backgroundColor: ground.surface,
    borderRadius: radius.surface,
    borderWidth: stroke.hair,
    borderColor: ground.edge,
    padding: space.wide,
    gap: space.step,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  closeBtn: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  content: {
    paddingVertical: space.tight,
  },
  actions: {
    gap: space.snug,
    marginTop: space.tight,
  },
  primaryButton: {
    minHeight: TOUCH_TARGET,
    borderRadius: radius.control,
    backgroundColor: brand.azure,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.wide,
  },
  primaryButtonPressed: {
    opacity: 0.85,
  },
  primaryText: {
    color: ink.inverse,
  },
  secondaryButton: {
    minHeight: TOUCH_TARGET,
    borderRadius: radius.control,
    backgroundColor: ground.active,
    borderWidth: stroke.hair,
    borderColor: ground.edge,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: space.wide,
  },
  secondaryButtonPressed: {
    backgroundColor: ground.raised,
  },
  secondaryText: {
    color: ink.plain,
  },
});
