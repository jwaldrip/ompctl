/**
 * A clone, while it runs.
 *
 * Three states, and the panel never leaves the operator guessing which one it
 * is in: running (git's own lines, newest last), landed (the path that now
 * exists, with the obvious next move), or failed (what git said). The lines are
 * deliberately git's own words rather than a percentage this app invented from
 * them: a clone that stalls says so in its output, and a spinner would hide
 * exactly that.
 */

import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Glyph } from "../design/icons.tsx";
import { Code, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { CloneState } from "../remote/model.ts";

export function CloneProgress({
  clone,
  onDismiss,
  onOpenDestination,
}: {
  clone: CloneState;
  onDismiss: () => void;
  /** Offered only once the clone has landed: there is nothing to open before that. */
  onOpenDestination: (path: string) => void;
}): JSX.Element {
  const failed = clone.failure !== null;
  const landed = clone.path !== null;
  const accent = failed ? signal.oxide : landed ? signal.sage : signal.amber;

  return (
    <View style={styles.panel} testID="clone-progress">
      <View style={styles.heading}>
        <Glyph name={failed ? "warning" : "repo"} color={accent} size={13} />
        <Kicker color={accent}>{failed ? "Clone failed" : landed ? "Cloned" : "Cloning"}</Kicker>
      </View>
      <Title numberOfLines={1} testID="clone-url">
        {clone.url}
      </Title>
      <Code numberOfLines={1} testID="clone-destination">
        {clone.path ?? clone.parent}
      </Code>

      {failed ? (
        <Label color={signal.oxide} testID="clone-failure">
          {clone.failure}
        </Label>
      ) : (
        <ScrollView style={styles.lines} testID="clone-lines">
          {clone.lines.map(line => (
            <Code key={line.seq} numberOfLines={1}>
              {line.text}
            </Code>
          ))}
          {clone.lines.length === 0 ? <Code color={ink.faint}>waiting for git</Code> : null}
        </ScrollView>
      )}

      <View style={styles.actions}>
        {landed && clone.path !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => onOpenDestination(clone.path ?? "")}
            style={[styles.action, styles.primary]}
            testID="clone-open"
          >
            <Text style={styles.primaryText}>Open it</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={onDismiss} style={styles.action} testID="clone-dismiss">
          <Text style={styles.actionText}>{failed || landed ? "Done" : "Hide"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: ground.raised,
    borderColor: ground.edge,
    borderWidth: stroke.hair,
    gap: space.snug,
    padding: space.step,
  },
  heading: { alignItems: "center", flexDirection: "row", gap: space.snug },
  // Bounded on purpose: the panel sits over a list the operator is still using,
  // and a growing log would push that list off the screen.
  lines: { maxHeight: 120 },
  actions: { flexDirection: "row", gap: space.snug },
  action: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.step,
  },
  actionText: { ...type.label, color: ink.plain },
  primary: { backgroundColor: signal.sage, flex: 1 },
  primaryText: { ...type.title, color: ink.inverse },
});
