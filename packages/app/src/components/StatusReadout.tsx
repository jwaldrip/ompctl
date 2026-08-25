/**
 * The two things an operator has to be able to see without asking: whether the
 * link is up, and what this session is costing.
 *
 * Connection state gets a filled bar rather than a dot, because a dot the size
 * of a full stop is not a status indicator on a phone held at arm's length. The
 * reconnect countdown is printed rather than animated: "retrying in 4s" is a
 * fact, and a spinner is a promise the app cannot keep.
 */

import type { ConnectionState } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { ProgressBar } from "react-native-paper";
import { formatMoney, formatTokens } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Data, Kicker, Label } from "../design/text.tsx";
import type { SignalName } from "../design/tokens.ts";
import { ground, ink, pressureSignal, radius, signal, signalWash, space, stroke } from "../design/tokens.ts";
import type { Usage } from "../session/model.ts";

/** What each connection state means, in the words shown on screen. */
const LINK_WORDS: Record<ConnectionState, string> = {
  connecting: "connecting",
  connected: "linked",
  reconnecting: "retrying",
  offline: "no link",
};

const LINK_SIGNALS: Record<ConnectionState, SignalName> = {
  connecting: "ochre",
  connected: "sage",
  reconnecting: "ochre",
  offline: "oxide",
};

export interface StatusReadoutProps {
  state: ConnectionState;
  /** Consecutive failed attempts. Printed once it stops being zero. */
  attempt: number;
  /** Milliseconds until the next attempt, when one is scheduled. */
  delayMs?: number;
  usage: Usage | null;
  /** Pending clearances across the whole fleet, not just the open session. */
  clearances: number;
}

export function StatusReadout({ state, attempt, delayMs, usage, clearances }: StatusReadoutProps): JSX.Element {
  const tone = signal[LINK_SIGNALS[state]];
  const wash = signalWash[LINK_SIGNALS[state]];
  const fraction = usage === null || usage.size === 0 ? null : usage.used / usage.size;
  const pressure = fraction === null ? ink.faint : signal[pressureSignal(fraction)];

  return (
    <View style={styles.readout} testID="status-readout">
      <View style={styles.instruments}>
        <View style={[styles.link, { backgroundColor: wash, borderColor: tone }]}>
          <Glyph name="link" size={11} color={tone} />
          <Kicker color={tone} testID="status-link">
            {LINK_WORDS[state]}
          </Kicker>
          {state === "reconnecting" && delayMs !== undefined ? (
            <Data color={ink.muted} testID="status-retry">{`${Math.max(1, Math.round(delayMs / 1000))}s`}</Data>
          ) : null}
          {attempt > 0 && state !== "connected" ? (
            <Data color={ink.faint} testID="status-attempt">{`#${attempt}`}</Data>
          ) : null}
        </View>

        <View style={styles.meters}>
          <Meter
            glyph="load"
            label="context"
            tone={pressure}
            testID="status-context"
            value={
              usage === null || usage.size === 0 ? null : `${formatTokens(usage.used)}/${formatTokens(usage.size)}`
            }
          />
          <Meter
            glyph="cost"
            label="spend"
            tone={ink.bright}
            testID="status-spend"
            value={usage === null ? null : formatMoney(usage.costAmount, usage.costCurrency)}
          />
          {clearances > 0 ? (
            <Meter
              glyph="clearance"
              label="holding"
              tone={signal.ochre}
              testID="status-clearances"
              value={String(clearances)}
            />
          ) : null}
        </View>
      </View>

      {/*
        The one number an operator watches, drawn as well as printed. `42k/200k`
        is the fact and it stays exactly as it was; a filled bar is how far
        through the window that is, at arm's length, without arithmetic. Paper's
        own `ProgressBar` rather than two nested Views, coloured by the same
        `pressureSignal` the figure beside it already wears, so the bar and the
        number can never disagree about how much room is left.

        Absent when the agent has reported no usage. A bar at zero is a claim
        that the window is empty, which is the same lie the readout refuses to
        tell with a dash.
      */}
      {fraction === null ? null : (
        <ProgressBar color={pressure} progress={fraction} style={styles.pressure} testID="status-pressure" />
      )}
    </View>
  );
}

function Meter({
  glyph,
  label,
  value,
  tone,
  testID,
}: {
  glyph: "load" | "cost" | "clearance";
  label: string;
  /** The reading, or null when the agent has not reported one. */
  value: string | null;
  tone: string;
  testID: string;
}): JSX.Element {
  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Glyph name={glyph} size={10} color={ink.faint} />
        <Label color={ink.faint}>{label}</Label>
      </View>
      {value === null ? (
        // No usage report has arrived from the agent, so there is no number.
        // A bare "--" in this slot read as a value — as a zero, or as a
        // failure — and both are claims the app cannot make. Words say what
        // the dash could not: the reading is absent because nothing upstream
        // has spoken. The row stays: hiding it would make a silent host
        // indistinguishable from a healthy one.
        <Label color={ink.faint} testID={testID}>
          not reported
        </Label>
      ) : (
        <Data color={tone} testID={testID}>
          {value}
        </Data>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // The band. A column now rather than a row, because the pressure bar spans
  // its whole width under the instruments: the bar is about the same fact as
  // the `context` figure, so it belongs beneath it rather than squeezed into
  // the row beside it.
  //
  // The gutter is the screen's, not this band's own idea of one: it was 16
  // here while the header above it was 12, which is exactly the kind of near
  // miss that reads as "the spacing is off" without any one number looking
  // wrong.
  readout: {
    gap: rhythm.rowGapTight,
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  instruments: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.wide,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
    paddingHorizontal: rhythm.controlPad,
    paddingVertical: space.tight,
    borderLeftWidth: stroke.heavy,
  },
  // Consecutive readings of the same kind, so the gap between them is the row
  // rhythm. It was 24, the section step, which is what made three numbers read
  // as three separate instruments rather than as one readout.
  meters: { flexDirection: "row", gap: rhythm.rowGap },
  meter: { gap: rhythm.pairGap },
  meterHead: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap },
  // Structure, so it is square: `radius.flat` is the token that says so, and a
  // rounded bar would be the one object-shaped thing in a band of rules.
  pressure: { borderRadius: radius.flat },
});
