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
import { formatTokens } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
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
  connecting: "holding",
  connected: "ready",
  reconnecting: "holding",
  offline: "failed",
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

function formatCostReading(amount: number, currency: string = "USD"): string {
  if (!Number.isFinite(amount)) return "--";
  const digits = amount > 0 && amount < 0.01 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(amount);
  } catch {
    return `$${amount.toFixed(digits)}`;
  }
}

/**
 * Context pressure as a fraction, or null when there is nothing to report.
 *
 * Two jobs in one place because they were two answers to one question before.
 *
 * `null` is not zero. A bar at zero claims the window is empty, which is the
 * same lie the readout refuses to tell with a dash, so a session that has
 * reported no usage draws no bar at all.
 *
 * And the value is CLAMPED, because Paper's `ProgressBar` interpolates over
 * [0, 1] and clamps neither end. omp keeps counting past a model's nominal
 * size, so an over-budget window handed Paper a number above 1 and got a fill
 * wider than its own track plus an accessibility value above 100. The colour
 * ramp is unaffected: `pressureSignal` already saturates at failed, so only
 * the drawing was wrong, which is exactly the kind of thing no assertion on the
 * figure beside it would have caught.
 */
function pressureFraction(usage: Usage | null): number | null {
  if (usage === null || usage.size === 0) return null;
  const fraction = usage.used / usage.size;
  if (!Number.isFinite(fraction)) return null;
  return Math.min(Math.max(fraction, 0), 1);
}

export function StatusReadout({ state, attempt, delayMs, usage, clearances }: StatusReadoutProps): JSX.Element {
  const isTablet = useIsTablet();
  const tone = signal[LINK_SIGNALS[state]];
  const wash = signalWash[LINK_SIGNALS[state]];
  const fraction = pressureFraction(usage);
  const pressure = fraction === null ? ink.faint : signal[pressureSignal(fraction)];

  return (
    <View style={[styles.readout, !isTablet && styles.readoutCompact]} testID="status-readout">
      <View style={[styles.instruments, !isTablet && styles.instrumentsCompact]}>
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

        <View style={[styles.meters, !isTablet && styles.metersCompact]}>
          <Meter
            compact={!isTablet}
            glyph="load"
            label="context"
            tone={pressure}
            testID="status-context"
            value={
              usage === null || usage.size === 0 ? null : `${formatTokens(usage.used)}/${formatTokens(usage.size)}`
            }
          />
          <Meter
            compact={!isTablet}
            glyph="cost"
            label="spend"
            tone={ink.bright}
            testID="status-spend"
            value={usage === null ? null : formatCostReading(usage.costAmount, usage.costCurrency)}
          />
          {clearances > 0 ? (
            <Meter
              compact={!isTablet}
              glyph="clearance"
              label="holding"
              tone={signal.holding}
              testID="status-clearances"
              value={String(clearances)}
            />
          ) : null}
        </View>
      </View>

      {/*
        The one number an operator watches, drawn as well as printed. `42k/200k`
        is the fact and it stays exactly as it was; a filled bar is how far
        through the window that is, at arm's length, without arithmetic.
        Tablets keep this bar; compact phone screens keep the readout to one line.
      */}
      {fraction === null || !isTablet ? null : (
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
  compact = false,
}: {
  glyph: "load" | "cost" | "clearance";
  label: string;
  /** The reading, or null when the agent has not reported one. */
  value: string | null;
  tone: string;
  testID: string;
  compact?: boolean;
}): JSX.Element {
  if (compact) {
    return (
      <View style={styles.meterCompact} accessible accessibilityLabel={`${label}: ${value ?? "not reported"}`}>
        <Glyph name={glyph} size={10} color={ink.faint} />
        {value === null ? (
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

  return (
    <View style={styles.meter}>
      <View style={styles.meterHead}>
        <Glyph name={glyph} size={10} color={ink.faint} />
        <Label color={ink.faint}>{label}</Label>
      </View>
      {value === null ? (
        // No usage report has arrived from the agent, so there is no number.
        // A bare "--" in this slot read as a value: as a zero, or as a
        // failure, and both are claims the app cannot make. Words say what
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
  readout: {
    gap: rhythm.rowGapTight,
    paddingHorizontal: rhythm.gutter,
    paddingVertical: space.snug,
    backgroundColor: ground.surface,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
  },
  readoutCompact: {
    gap: 0,
    paddingVertical: space.tight,
  },
  instruments: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.wide,
  },
  instrumentsCompact: {
    gap: space.snug,
  },
  link: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
    paddingHorizontal: rhythm.controlPad,
    paddingVertical: space.tight,
    borderLeftWidth: stroke.heavy,
  },
  meters: { flexDirection: "row", gap: rhythm.rowGap },
  metersCompact: { gap: space.snug, alignItems: "center" },
  meter: { gap: rhythm.pairGap },
  meterCompact: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap },
  meterHead: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap },
  pressure: { borderRadius: radius.flat },
});
