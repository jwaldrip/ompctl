/**
 * The vocabulary every surface in this app draws from.
 *
 * Two rules make this file worth having. Colour is meaning: a hue is only in
 * the palette because it says something an operator has to read at a glance,
 * and nothing here is decorative. And the ground is near-black with bright
 * accents drawn from the app icon, giving high-contrast legibility for long
 * operational shifts where signals and status need immediate recognition.
 *
 * No gradients, no translucency, no rounded corners. A strip either is or is
 * not, and a soft edge on a failure state is a lie about how the run went.
 */

import type { AgentState } from "@ompd/core/contracts";
import type { ToolStatus } from "../session/model.ts";

// ---------------------------------------------------------------------------
// Ground
// ---------------------------------------------------------------------------

/**
 * Near-black ground steps, from deepest to lightest. Every step shares a hue
 * so stacking two of them reads as depth rather than as a different material.
 */
export const ground = {
  /** Behind everything. The window itself. */
  base: "#0a0c10",
  /** A panel sitting on the base: the bay, the composer, the readout. */
  surface: "#11151c",
  /** A card sitting on a panel: a tool call, an approval. */
  raised: "#181d26",
  /** Pressed, selected, or otherwise held. */
  active: "#1f2632",
  /** Hairlines. Structure, not decoration. */
  line: "#1c2230",
  /** A heavier rule where a section genuinely ends. */
  edge: "#262d38",
} as const;

/**
 * Type colours. Four steps is enough: anything finer stops being a hierarchy
 * and starts being an accident.
 */
export const ink = {
  /** Primary reading text. */
  bright: "#f4f7fb",
  /** Labels, secondary prose. */
  plain: "#cfd7e2",
  /** Primary reading text alias for plain. */
  primary: "#cfd7e2",
  /** Units, timestamps, the quiet half of a data pair. */
  muted: "#8b96a6",
  /** Present but not to be read unless looked for. */
  faint: "#7a8595",
  /** On top of a filled signal or brand swatch. */
  inverse: "#0a0c10",
} as const;

// ---------------------------------------------------------------------------
// Brand
// ---------------------------------------------------------------------------

/**
 * Brand accent tokens from the app icon.
 */
export const brand = {
  /** Actions, links, focus, selection, primary button fill with ink.inverse text. */
  azure: "#5b9dff",
  /** Brand amber accent. */
  amber: "#ffb020",
} as const;

export type BrandName = keyof typeof brand;

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

/**
 * Six colours, six meanings, no overlap. A seventh would mean two of them are
 * saying the same thing and the operator now has to remember which.
 */
export const signal = {
  /** Working. A turn is in flight and tokens are moving. */
  working: "#ffb020",
  /** Ready. Idle, healthy, waiting on a person rather than on itself. */
  ready: "#3ddc84",
  /** Holding. Blocked on something that is not an error: a clearance, a host. */
  holding: "#ff7a45",
  /** Failed. A run that will not finish without someone. */
  failed: "#ff4d4d",
  /** Cold. Stopped on purpose, transcript retained, nothing running. */
  cold: "#7d8794",
  /** Reasoning. Thought rather than reply; never the same weight as an answer. */
  reasoning: "#a78bfa",
} as const;

export type SignalName = keyof typeof signal;

/**
 * The dim companion to each signal, for a fill behind text of that colour.
 * Mixed against `ground.surface` rather than lightened, so a filled chip sits
 * in the same material as the panel under it.
 */
export const signalWash = {
  working: "#352c1d",
  ready: "#18332c",
  holding: "#352422",
  failed: "#351d23",
  cold: "#21262e",
  reasoning: "#28273d",
} as const satisfies Record<SignalName, string>;

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/**
 * Faces are referenced by their PostScript name, which is what iOS and macOS
 * match on. Android matches the filename, and the vendored files are named to
 * agree with their PostScript name for exactly that reason.
 *
 * `weight` is deliberately absent from the styles below: naming a face and a
 * numeric weight at the same time makes Android synthesise a bold on top of a
 * face that already is one.
 */
export const face = {
  regular: "Archivo-Regular",
  medium: "Archivo-Medium",
  semibold: "Archivo-SemiBold",
  mono: "IBMPlexMono-Regular",
  monoMedium: "IBMPlexMono-Medium",
} as const;

/**
 * A type scale, not a set of sizes. Every entry names the job it does, so a
 * surface picks by role and the ramp stays consistent across five platforms
 * with five different default metrics.
 */
export const type = {
  /** Section kickers and the smallest labels. Tracked out to stay legible. */
  kicker: { fontFamily: face.medium, fontSize: 11, letterSpacing: 1.1, lineHeight: 14 },
  /** Field labels and chip text. */
  label: { fontFamily: face.medium, fontSize: 12, letterSpacing: 0.3, lineHeight: 16 },
  /** Body prose: transcript messages, descriptions. */
  body: { fontFamily: face.regular, fontSize: 15, lineHeight: 22 },
  /** A card's headline: an agent name, a tool title. */
  title: { fontFamily: face.semibold, fontSize: 16, lineHeight: 22 },
  /** The one thing on a screen that is the screen. */
  display: { fontFamily: face.semibold, fontSize: 22, lineHeight: 28 },
  /** Numbers a person compares against other numbers. */
  data: { fontFamily: face.monoMedium, fontSize: 13, letterSpacing: 0.2, lineHeight: 18 },
  /** Command output, paths, anything where alignment carries meaning. */
  code: { fontFamily: face.mono, fontSize: 12, lineHeight: 18 },
} as const;

// ---------------------------------------------------------------------------
// Measure
// ---------------------------------------------------------------------------

/** A four-point grid. Every gap and inset in the app is one of these. */
export const space = {
  hair: 2,
  tight: 4,
  snug: 8,
  step: 12,
  wide: 16,
  loose: 24,
  gulf: 32,
} as const;

/**
 * Corner radii, by the job the corner does.
 *
 * This file used to say "square, everywhere" and export a single `0` for it.
 * The app never honoured that: `PlanCard` drew 8 and 6, the routines badge drew
 * 12, and nothing read the token at all. What finally decided it was the
 * composer. Square corners plus a hairline on every element turned the message
 * box into a terminal control panel: a nested input rectangle inside a
 * rectangle, beside three equally boxed widgets. A composer is one object a
 * person types into, and the corner is most of what says so.
 *
 * So the rule is narrower than "no rounding" and it is still a rule: structure
 * stays square, objects round. A rule, a gutter, a divider is structure. A
 * thing you type into, press, or pick up is an object.
 */
export const radius = {
  /** Structure: rules, gutters, dividers, anything that is not an object. */
  flat: 0,
  /** A control living inside a surface: a ghost icon button, an attachment chip. */
  control: 8,
  /** A surface read as one object, the composer above all. */
  surface: 14,
  /** Fully round, reserved for the one action a surface emphasises. */
  pill: 999,
} as const;

/** Hairline structure. `heavy` is a rule; `hair` is a division. */
export const stroke = { hair: 1, heavy: 2 } as const;

/** Smallest square a finger can reliably hit. */
export const TOUCH_TARGET = 44;

// ---------------------------------------------------------------------------
// Meaning
// ---------------------------------------------------------------------------

/**
 * Agent state to signal. This mapping is the reason the palette has six
 * entries: each state a person has to act on differently gets its own colour,
 * and the two that need nothing (`stopped`) share the one that means so.
 */
const AGENT_SIGNALS: Record<AgentState, SignalName> = {
  provisioning: "holding",
  starting: "holding",
  idle: "ready",
  busy: "working",
  waiting: "holding",
  stopped: "cold",
  failed: "failed",
};

export function agentSignal(state: AgentState): SignalName {
  return AGENT_SIGNALS[state] ?? "cold";
}

const TOOL_SIGNALS: Record<ToolStatus, SignalName> = {
  pending: "cold",
  in_progress: "working",
  completed: "ready",
  failed: "failed",
};

export function toolSignal(status: ToolStatus): SignalName {
  return TOOL_SIGNALS[status] ?? "cold";
}

/**
 * Context pressure. A window filling up is the single most useful number on
 * the board, and it earns a colour change rather than a percentage nobody
 * reads: ready while there is room, holding once the end is in sight, failed when
 * the next turn may not fit.
 */
export function pressureSignal(fraction: number): SignalName {
  if (!Number.isFinite(fraction) || fraction <= 0) return "cold";
  if (fraction >= 0.9) return "failed";
  if (fraction >= 0.7) return "holding";
  return "ready";
}
