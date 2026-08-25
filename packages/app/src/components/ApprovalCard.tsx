/**
 * A clearance request: the one card in the app that is a decision rather than a
 * record.
 *
 * Three properties are load-bearing. It cannot be mistaken for a tool card, so
 * it is the only entry with a full ochre border rather than a rail. And a
 * settled card stays in place showing what was decided, because a clearance
 * that vanishes on tap leaves no evidence of what was approved.
 *
 * The third used to be "allow and reject are the same size and the same weight",
 * on the reasoning that making the safe answer larger teaches an operator to hit
 * the big button without reading. Three identical controls taught something
 * worse: that the three are interchangeable. They are not. Allow answers this
 * one call, reject refuses it, and `always` grants a standing permission that
 * outlives the card. So the emphasis is Paper's to express -- `contained`,
 * `outlined`, `text` -- and it is the same three-step ladder every other decision
 * in the app uses, rather than three hand-rolled `Pressable`s that happened to
 * share a border. Size is not what stops a mis-tap; a full finger target on each
 * and a different shape per answer is.
 *
 * `always` is still a separate control rather than a checkbox on `allow`.
 * Granting a standing permission is a different act from approving one command,
 * and a modifier riding on a button is how it gets granted by accident.
 *
 * Measurement lives in the `StyleSheet` block, written as `rhythm.<job>`, so the
 * source scrape in `test/no-hidden-content.test.ts` can still read the shapes a
 * container is built from. Only colour comes off the theme at render time.
 */

import type { ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Surface } from "react-native-paper";
import { Glyph, type GlyphName } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Body, Code, Kicker, Label } from "../design/text.tsx";
import { radius, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import type { ApprovalEntry } from "../session/model.ts";

export interface ApprovalCardProps {
  entry: ApprovalEntry;
  /** False when this device's pairing does not hold the approve scope. */
  canApprove: boolean;
  /** Why the controls are disabled, when they are. Shown rather than implied. */
  refusal?: string;
  onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
}

/**
 * A decision button's glyph, as a render prop rather than a name.
 *
 * Paper routes only a STRING `icon` through `settings.icon`, so `icon="allow"`
 * draws ompctl's glyph under the provider and Paper's own fallback -- a literal
 * box character, plus a warning about missing icon libraries -- anywhere else,
 * including a bare harness or a render frame that forgot to wrap. Handing over
 * the drawing works in both places, and it turns a name this app has no glyph
 * for into a compile error rather than a blank square.
 *
 * The colour is fixed per button rather than read from Paper's own argument,
 * because each mode carries its own: filled sage wants the inverse ink,
 * outlined oxide wants oxide, and the text button wants muted.
 */
function decisionGlyph(name: GlyphName, color: string): ({ size }: { size: number }) => JSX.Element {
  return ({ size }) => <Glyph name={name} size={size} color={color} />;
}

export function ApprovalCard({ entry, canApprove, refusal, onDecide }: ApprovalCardProps): JSX.Element {
  const { ground, ink, signal, signalWash } = useOmpTheme();
  const settled = entry.decision !== null;
  const tone = settled ? (entry.decision === "allow" ? signal.sage : signal.oxide) : signal.ochre;
  const preview = describeInput(entry.input);

  return (
    <Surface
      mode="flat"
      elevation={0}
      // Clipped, so the head's ochre wash cannot cross the rounded corner.
      style={[styles.card, { backgroundColor: ground.surface, borderColor: tone }]}
      testID={`approval-${entry.requestId}`}
    >
      <View style={[styles.head, { backgroundColor: settled ? ground.raised : signalWash.ochre }]}>
        <Glyph name="clearance" size={13} color={tone} />
        <Kicker color={tone} testID={`approval-state-${entry.requestId}`}>
          {settled ? (entry.decision === "allow" ? "allowed" : "rejected") : "clearance"}
        </Kicker>
        <Label color={ink.muted} numberOfLines={1} style={styles.tool}>
          {entry.tool}
        </Label>
      </View>

      <View style={styles.body}>
        <Body color={ink.bright} testID={`approval-title-${entry.requestId}`}>
          {entry.title}
        </Body>
        {preview !== null ? (
          <View style={[styles.input, { backgroundColor: ground.base, borderLeftColor: ground.edge }]}>
            <Code color={ink.plain} numberOfLines={8}>
              {preview}
            </Code>
          </View>
        ) : null}
      </View>

      {settled ? null : canApprove ? (
        <View style={styles.actions}>
          <Button
            compact
            mode="contained"
            icon={decisionGlyph("allow", ink.inverse)}
            testID={`approval-allow-${entry.requestId}`}
            accessibilityLabel="Allow"
            style={styles.decision}
            contentStyle={styles.decisionContent}
            buttonColor={signal.sage}
            textColor={ink.inverse}
            onPress={() => {
              onDecide(entry.requestId, "allow", "once");
            }}
          >
            Allow
          </Button>
          <Button
            compact
            mode="outlined"
            icon={decisionGlyph("deny", signal.oxide)}
            testID={`approval-deny-${entry.requestId}`}
            accessibilityLabel="Reject"
            style={[styles.decision, { borderColor: signal.oxide }]}
            contentStyle={styles.decisionContent}
            textColor={signal.oxide}
            onPress={() => {
              onDecide(entry.requestId, "deny", "once");
            }}
          >
            Reject
          </Button>
          <Button
            compact
            mode="text"
            icon={decisionGlyph("allow", ink.muted)}
            testID={`approval-always-${entry.requestId}`}
            accessibilityLabel="Always"
            style={styles.decision}
            contentStyle={styles.decisionContent}
            textColor={ink.muted}
            onPress={() => {
              onDecide(entry.requestId, "allow", "always");
            }}
          >
            Always
          </Button>
        </View>
      ) : (
        <View style={styles.refusal}>
          <Glyph name="unpair" size={11} color={ink.muted} />
          <Label color={ink.muted} testID={`approval-refusal-${entry.requestId}`}>
            {refusal ?? "This device does not hold the approve scope."}
          </Label>
        </View>
      )}
    </Surface>
  );
}

/**
 * The command, as text, when the payload has one worth showing. A tool's raw
 * input is arbitrary JSON and printing all of it turns a decision into a
 * reading exercise, so the shell-shaped fields win and everything else falls
 * back to compact JSON.
 */
function describeInput(input: unknown): string | null {
  if (typeof input === "string") return input.length > 0 ? input : null;
  if (typeof input !== "object" || input === null) return null;
  for (const key of ["command", "cmd", "script", "path", "file_path", "url"]) {
    const value: unknown = Reflect.get(input, key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  try {
    const json = JSON.stringify(input);
    return json === undefined || json === "{}" ? null : json;
  } catch {
    // A payload with a cycle in it is still a payload the operator is deciding
    // about; refusing to draw the card over it would be worse than no preview.
    return null;
  }
}

const styles = StyleSheet.create({
  card: { borderWidth: stroke.heavy, borderRadius: radius.control, overflow: "hidden" },
  // One pad, both axes. The head used to pay 12 across and 8 down, which is the
  // defect this change exists to remove: one job, one answer.
  head: { flexDirection: "row", alignItems: "center", gap: rhythm.cardGap, padding: rhythm.cardPad },
  tool: { flex: 1, textAlign: "right" },
  body: { padding: rhythm.cardPad, gap: rhythm.cardGap },
  // The command being authorised, quoted. Same treatment `RichText` gives a
  // quote block, and the same inner pad, because it is the same job: a block of
  // borrowed text inside something else.
  input: { padding: rhythm.cardPad, borderLeftWidth: stroke.hair },
  // `paddingTop: 0` because the body above already paid its own bottom inset;
  // charging it twice is what left a band of dead ground under the title.
  actions: { flexDirection: "row", gap: rhythm.cardGap, padding: rhythm.cardPad, paddingTop: 0 },
  // Three equal columns. Equal WIDTH, not equal weight: the mode carries the
  // weight, and every one of them is a full finger target, which Paper's own
  // 40 point button is not.
  //
  // `compact` at the call site is the whole reason there is no label override
  // here. Paper's default spends 16 points of icon inset and 24 either side of
  // the label, which is right for a screen with one action on it and ellipsises
  // "Always" to "Alwa..." when three share a card's width on a phone; its
  // compact geometry spends 8 and 8, on grid, and is the library's answer to
  // exactly this rather than ours.
  decision: { flex: 1 },
  decisionContent: { minHeight: rhythm.minTarget },
  refusal: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap, padding: rhythm.cardPad, paddingTop: 0 },
});
