/**
 * ompctl's rows, rendered inside assistant-ui.
 *
 * assistant-ui owns list mechanics and message identity; it owns none of the
 * pixels. Every row here is the component the transcript already draws, reached
 * through the source `Entry` that rode along on `metadata.custom` (see
 * `adapter.ts`). Nothing is re-derived from assistant-ui's own vocabulary,
 * which is what keeps a tool's status rail, its touched locations and a
 * clearance's decision intact rather than flattened into parts and labels.
 *
 * This is a deliberate duplicate of `EntryRow` in
 * `packages/app/src/components/Transcript.tsx` (lines 157-240 and its
 * `row` / `gutter` / `prose` / `cardRow` styles at 279-288), not an import: the
 * cutover deletes `EntryRow` along with the hand-rolled `FlatList` around it,
 * and until then the two must be comparable side by side. Every visual and
 * accessibility decision below is that file's, and the reasons are its reasons:
 *
 *  - The gutter, not a bubble. Two speakers, one of them holding the device.
 *  - `testID` is CONSTANT per kind, never keyed by entry id. A path scenario
 *    finds the agent's reply by enumerating every row carrying `entry-assistant`
 *    and comparing labels; uniquifying these once broke that step while the
 *    product was demonstrably correct on device. List identity comes from the
 *    key extractor, never from here.
 *  - The accessibility label is the raw `entry.text`, prefixed by the speaker.
 *    It is what the round-trip gate reads, so `RichText` owns pixels only.
 *
 * One thing this file must never do: put a tool's `title` or `input` into a
 * label, a kicker or any generic surface. omp builds ACP's `title` from the
 * call's own arguments, so it carries command lines, paths and whatever token
 * was on that command line. `ToolCard` and `ApprovalCard` render those fields
 * themselves and already decide what of them is safe to show; nothing here
 * repeats them.
 */

import type { ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
import { TouchableRipple } from "react-native-paper";
import { ApprovalCard } from "../components/ApprovalCard.tsx";
import { RichText } from "../components/rich/RichText.tsx";
import { ToolCard } from "../components/ToolCard.tsx";
import { ToolGroupCard } from "../components/ToolGroupCard.tsx";
import { Glyph } from "../design/icons.tsx";
import { attributionWidth, rhythm } from "../design/rhythm.ts";
import { Kicker, Label } from "../design/text.tsx";
import type { OmpTheme } from "../design/theme.ts";
import { radius, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import type { AssistantEntry, Entry } from "../session/model.ts";
import type { ToolGroupEntry } from "./grouping.ts";

export interface OmpEntryRowProps {
  entry: Entry | ToolGroupEntry;
  /** False when this device's pairing does not hold the approve scope. */
  canApprove: boolean;
  /** Why approval is refused, when the daemon has said so. */
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
}

export function OmpEntryRow({ entry, canApprove, refusal, onDecide }: OmpEntryRowProps): JSX.Element {
  // The attribution column grows with the text rather than the text being
  // capped to fit it: at the default size 72 leaves 66 points for a 61.974
  // point "thinking", which is 1.065x of headroom, so any accessibility size
  // at all broke the word while a default-size-only gate kept passing.
  const { fontScale } = useWindowDimensions();
  // Colour is the one thing here that genuinely varies at render time: the two
  // ramps invert between the light and dark themes, and a row that read `ink`
  // straight off `tokens.ts` would draw the dark ramp in daylight. Measurement
  // does not vary, so it stays in the `StyleSheet` block below where a source
  // scrape can still price the attribution column.
  const { ground, ink, signal } = useOmpTheme();
  switch (entry.kind) {
    case "user":
      return (
        <View style={styles.row} testID="entry-user" accessible accessibilityLabel={`you: ${entry.text}`}>
          <View style={[styles.gutter, { width: attributionWidth(fontScale), borderLeftColor: ink.faint }]}>
            <Kicker color={ink.muted} numberOfLines={1}>
              you
            </Kicker>
          </View>
          <RichText text={entry.text} />
        </View>
      );

    case "assistant":
      if (entry.thought) {
        return <ThinkingRow entry={entry} fontScale={fontScale} signal={signal} />;
      }
      return (
        <View style={styles.row} testID="entry-assistant" accessible accessibilityLabel={`agent: ${entry.text}`}>
          <View style={[styles.gutter, { width: attributionWidth(fontScale), borderLeftColor: signal.sage }]}>
            <Kicker color={signal.sage} numberOfLines={1}>
              agent
            </Kicker>
            {entry.streaming ? <Glyph name="activity" size={9} color={signal.amber} /> : null}
          </View>
          <RichText text={entry.text} />
        </View>
      );

    case "tool_group":
      return (
        <View style={styles.cardRow}>
          <ToolGroupCard group={entry as ToolGroupEntry} />
        </View>
      );

    case "tool":
      return (
        <View style={styles.cardRow}>
          <ToolCard entry={entry} />
        </View>
      );

    case "approval":
      // While it waits, the decision lives in the tray pinned above the
      // readout (`SessionScreen`), where the log cannot scroll it away. The
      // log marks the place with one line rather than a second copy of the
      // same three buttons, and draws the full card once the clearance is
      // settled, which is when it becomes a record.
      if (entry.decision === null) {
        return (
          <View
            style={styles.row}
            testID="entry-approval-pending"
            accessible
            accessibilityLabel={`clearance: waiting on ${entry.tool}, answer it below`}
          >
            <View style={[styles.gutter, { width: attributionWidth(fontScale), borderLeftColor: signal.ochre }]}>
              <Kicker color={signal.ochre} numberOfLines={1}>
                clearance
              </Kicker>
            </View>
            <View style={styles.prose}>
              <Label color={ink.muted}>{`Waiting on ${entry.tool}. Answer it below.`}</Label>
            </View>
          </View>
        );
      }
      return (
        <View style={styles.cardRow}>
          <ApprovalCard entry={entry} canApprove={canApprove} refusal={refusal} onDecide={onDecide} />
        </View>
      );

    default:
      // A payload this build has never seen. An operator watching an agent run
      // is owed the truth that something happened, even unnamed.
      return (
        <View style={styles.row} testID={`entry-unknown-${entry.id}`}>
          <View style={[styles.gutter, { width: attributionWidth(fontScale), borderLeftColor: ground.edge }]}>
            <Glyph name="unknown" size={11} color={ink.faint} />
          </View>
          <View style={styles.prose}>
            <Label color={ink.muted}>{entry.label}</Label>
          </View>
        </View>
      );
  }
}

function ThinkingRow({
  entry,
  fontScale,
  signal,
}: {
  entry: AssistantEntry;
  fontScale: number;
  signal: OmpTheme["signal"];
}): JSX.Element {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? entry.streaming;
  const lineCount = entry.text.length === 0 ? 0 : entry.text.split("\n").length;
  const lineLabel = lineCount === 1 ? "1 line" : `${lineCount} lines`;
  const summary = `Thinking, ${lineLabel}`;

  return (
    <View style={styles.row} testID="entry-assistant" accessible accessibilityLabel={`thinking: ${entry.text}`}>
      <View style={[styles.gutter, { width: attributionWidth(fontScale), borderLeftColor: signal.violet }]}>
        <Kicker color={signal.violet} numberOfLines={1}>
          thinking
        </Kicker>
        {entry.streaming ? <Glyph name="activity" size={9} color={signal.amber} /> : null}
      </View>
      <View style={styles.prose}>
        <TouchableRipple
          accessibilityRole="button"
          accessibilityLabel={expanded ? `Collapse thinking (${lineLabel})` : `Expand thinking (${lineLabel})`}
          testID={`thinking-toggle-${entry.id}`}
          onPress={() => setUserToggled(!expanded)}
          style={styles.thinkingToggle}
        >
          <View style={styles.thinkingSummaryRow}>
            <View style={[styles.chevronWrap, { transform: [{ rotate: expanded ? "90deg" : "0deg" }] }]}>
              <Glyph name="chevron" size={8} color={signal.violet} />
            </View>
            <Label color={signal.violet} testID={`thinking-summary-${entry.id}`}>
              {summary}
            </Label>
          </View>
        </TouchableRipple>
        {expanded ? (
          <View style={styles.thinkingBody} testID={`thinking-body-${entry.id}`}>
            <RichText muted text={entry.text} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The prose sits a tight step off the attribution column rather than a full
  // row gap: the column and the words are one turn, not two siblings, and the
  // 4 points saved are 4 more per line of conversation.
  row: { flexDirection: "row", gap: rhythm.rowGapTight },
  // The attribution column. `width` and its two insets are what
  // `no-hidden-content.test.ts` reads to prove "thinking" cannot be broken
  // mid-word, so all three stay written as tokens a source scrape can resolve.
  gutter: {
    width: rhythm.attribution,
    borderLeftWidth: stroke.heavy,
    paddingLeft: rhythm.glyphGap,
    // The live-turn dot is not a second line, it is the label's own indicator.
    gap: rhythm.glyphGap,
    alignItems: "flex-start",
  },
  prose: { flex: 1 },
  // A card asks for its own step of air on ONE side. The list's content
  // container already pays `rowGap` between every row (`OmpThread.tsx`), so a
  // symmetric margin here charged the separation twice and left a run of cards
  // sitting further apart than the turns around them.
  cardRow: { marginTop: rhythm.cardStack },
  thinkingToggle: {
    alignSelf: "flex-start",
    borderRadius: radius.control,
    paddingVertical: rhythm.pairGap,
    paddingHorizontal: rhythm.pairGap,
  },
  thinkingSummaryRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
  },
  thinkingBody: {
    marginTop: rhythm.pairGap,
  },
  chevronWrap: {
    justifyContent: "center",
    alignItems: "center",
  },
});
