/**
 * A task's own metadata: what was asked, how it's going, and a door to the
 * session doing the work.
 *
 * Deliberately not a transcript. The session running this task is a
 * different surface's job — this panel answers "what is this task" and hands
 * off with `onOpenSession` rather than duplicating a second transcript
 * renderer next to `SessionScreen`'s.
 */

import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { TASK_STATE_LABELS, TASK_STATE_SIGNALS } from "../cowork/tasks.ts";
import type { Task } from "../cowork/types.ts";
import { elapsed } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { Body, Data, Display, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export interface TaskDetailProps {
  task: Task;
  onOpenSession: (agentId: string) => void;
  onRetry?: () => void;
  now?: number;
}

export function TaskDetail({ task, onOpenSession, onRetry, now }: TaskDetailProps): JSX.Element {
  const tone = signal[TASK_STATE_SIGNALS[task.state]];

  return (
    <ScrollView testID="task-detail" contentContainerStyle={styles.screen}>
      <View style={[styles.head, { borderBottomColor: tone }]}>
        <Display heading numberOfLines={2} testID="task-detail-title">
          {task.title}
        </Display>
        <Kicker color={tone} testID="task-detail-state">
          {TASK_STATE_LABELS[task.state]}
        </Kicker>
      </View>

      {task.skillName !== undefined ? (
        <View style={styles.row}>
          <Glyph name="skill" size={12} color={ink.faint} />
          <Label color={ink.muted}>{`/${task.skillName}`}</Label>
        </View>
      ) : null}

      <View style={styles.section}>
        <Kicker color={ink.muted}>Prompt</Kicker>
        <Body color={ink.plain}>{task.prompt}</Body>
      </View>

      {task.result !== undefined ? (
        <View style={styles.section} testID={task.state === "failed" ? "task-detail-failed" : "task-detail-result"}>
          <Kicker color={task.state === "failed" ? signal.failed : ink.muted}>
            {task.state === "failed" ? "Failed" : "Result"}
          </Kicker>
          <Body color={task.state === "failed" ? signal.failed : ink.plain}>{task.result}</Body>
        </View>
      ) : null}

      {task.state === "failed" && onRetry !== undefined ? (
        <Pressable
          testID="task-detail-retry"
          accessibilityRole="button"
          accessibilityLabel="Retry this failed task"
          onPress={onRetry}
          style={({ pressed }) => [styles.retryAction, pressed && { backgroundColor: ground.active }]}
        >
          {/* Client-side resubmit: triggers the existing task creation flow with the same prompt. */}
          <Glyph name="restore" size={13} color={signal.failed} />
          <Label color={signal.failed}>Retry</Label>
        </Pressable>
      ) : null}

      <View style={styles.meta}>
        <Data color={ink.faint}>{`Created ${elapsed(task.createdAt, now)} ago`}</Data>
        <Data color={ink.faint}>{`Updated ${elapsed(task.updatedAt, now)} ago`}</Data>
      </View>

      <Pressable
        testID="task-detail-open-session"
        accessibilityRole="button"
        accessibilityLabel="Open the session running this task"
        onPress={() => onOpenSession(task.agentId)}
        style={({ pressed }) => [styles.action, pressed && { backgroundColor: ground.active }]}
      >
        <Glyph name="link" size={13} color={signal.ready} />
        <Label color={signal.ready}>Open session</Label>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { padding: space.wide, gap: space.step },
  head: { gap: space.tight, paddingBottom: space.step, borderBottomWidth: stroke.heavy },
  row: { flexDirection: "row", alignItems: "center", gap: space.tight },
  section: { gap: space.tight },
  meta: { flexDirection: "row", gap: space.wide },
  action: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    minHeight: TOUCH_TARGET,
    borderWidth: stroke.hair,
    borderColor: signal.ready,
    alignSelf: "flex-start",
    paddingHorizontal: space.wide,
  },
  retryAction: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    minHeight: TOUCH_TARGET,
    borderWidth: stroke.hair,
    borderColor: signal.failed,
    alignSelf: "flex-start",
    paddingHorizontal: space.wide,
  },
});
