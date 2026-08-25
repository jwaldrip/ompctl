/**
 * The operator's checkpoint between planning and execution.
 *
 * A plan update can arrive just before ACP asks for its answer, so the card
 * becomes visible for either fact. Its controls stay disabled until the
 * elicitation supplies a request id: a button that looks live but cannot reach
 * ACP would teach an operator that their decision landed when it did not.
 */

import type { PlanReviewChoice } from "@ompd/core/contracts";
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { Button, Surface } from "react-native-paper";
import { rhythm } from "../design/rhythm.ts";
import { Body, Kicker, Label } from "../design/text.tsx";
import { radius, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import type { PlanEntry, PlanReview } from "../session/model.ts";

export interface PlanCardProps {
  plan: readonly PlanEntry[];
  review: PlanReview | null;
  canApprove: boolean;
  refusal?: string;
  onRespond: (requestId: string, choice: PlanReviewChoice) => void;
}

export function PlanCard({ plan, review, canApprove, refusal, onRespond }: PlanCardProps): JSX.Element | null {
  const theme = useOmpTheme();
  const hasPendingPlan = review !== null || plan.some(entry => entry.status === "pending");
  if (!hasPendingPlan) return null;

  const canRespond = review !== null && canApprove;
  const respond = (choice: PlanReviewChoice): void => {
    if (review === null) return;
    onRespond(review.requestId, choice);
  };

  return (
    <Surface elevation={0} mode="flat" style={[styles.card, { borderColor: theme.signal.ochre }]} testID="plan-review">
      <View style={styles.head}>
        <Kicker color={theme.signal.ochre}>plan review</Kicker>
        <Label color={theme.ink.muted}>{review === null ? "waiting for plan details" : "approval required"}</Label>
      </View>
      {review === null ? null : <Body color={theme.ink.plain}>{review.message}</Body>}
      {plan.length === 0 ? null : (
        <View style={[styles.steps, { borderLeftColor: theme.ground.edge }]}>
          {plan.map((entry, index) => (
            <Label
              color={entry.status === "completed" ? theme.ink.muted : theme.ink.plain}
              // biome-ignore lint/suspicious/noArrayIndexKey: PlanEntry carries no stable id; the plan list is replaced wholesale, never reordered.
              key={`${index}-${entry.content}`}
            >
              {entry.status === "completed" ? "Done" : "Plan"} {entry.content}
            </Label>
          ))}
        </View>
      )}
      {/*
       * Contained then outlined, the approval card's order and its geometry:
       * one filled control per surface says which press ends the wait, and the
       * other stays a real control rather than a second emphasis competing
       * with it. `compact` for the same reason that card states -- Paper's
       * default spends 24 points either side of a label, its compact geometry
       * spends 8, which is `rhythm.controlPad` and on grid.
       *
       * Where this row differs from that card's: it wraps rather than splitting
       * into equal columns. Three one-word labels fit three ways; "Approve and
       * execute" at a larger type size does not fit half a phone, and Paper's
       * label is one line, so an equal split would ellipsise the decision
       * itself. A second row is a worse layout than a cut word is a defect.
       */}
      <View style={styles.actions}>
        <Button
          accessibilityLabel="Approve and execute"
          compact
          contentStyle={styles.decisionContent}
          disabled={!canRespond}
          mode="contained"
          onPress={() => {
            respond("Approve and execute");
          }}
          testID="plan-approve"
        >
          Approve and execute
        </Button>
        <Button
          accessibilityLabel="Refine plan"
          compact
          contentStyle={styles.decisionContent}
          disabled={!canRespond}
          mode="outlined"
          onPress={() => {
            respond("Refine plan");
          }}
          testID="plan-refine"
          textColor={theme.signal.ochre}
        >
          Refine plan
        </Button>
      </View>
      {!canApprove ? (
        <Label color={theme.ink.muted}>{refusal ?? "This device does not hold the approve scope."}</Label>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  // No top margin. `SessionScreen`'s body pays `rhythm.rowGap` between every
  // instrument in the working area, so a margin here is the second charge for
  // one gap: 12 plus 8 is 20, which is a step on nothing. `cardStack` would be
  // right if this card sat in a run of cards, and it does not -- the context
  // strip above it is a band and the transcript below it is a list. The
  // horizontal gutter stays, because that body pays no inset of its own and
  // this card has to line up with the strip and the transcript.
  card: {
    borderRadius: radius.control,
    borderWidth: stroke.heavy,
    gap: rhythm.cardGap,
    marginHorizontal: rhythm.gutter,
    padding: rhythm.cardPad,
  },
  head: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  steps: { borderLeftWidth: stroke.hair, gap: rhythm.cardGap, paddingLeft: rhythm.indent },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: rhythm.cardGap },
  // Paper's own button is 36 tall at md3, which is not a finger target. A floor
  // rather than a height, so dynamic type grows the control instead of clipping
  // the word in it. The label's own inset comes from `compact` at the call site
  // rather than from an override here; it is the same 8 `rhythm.controlPad` is.
  decisionContent: { minHeight: rhythm.minTarget },
});
