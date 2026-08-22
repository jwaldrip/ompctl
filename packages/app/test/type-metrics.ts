/**
 * How wide a label actually is.
 *
 * Layout rules about text need real typographic widths, and a fixed-width
 * container that cannot fit its own label is invisible in source: `CONNECTORS`
 * reads as ten harmless characters next to `width: 64`. These advances are
 * measured with CoreText against the vendored faces in `src/design/fonts`, at
 * the exact size and tracking the type scale applies, and upper cased for
 * `kicker` because `Kicker` renders with `textTransform: "uppercase"`.
 *
 * The table is data rather than a computation because pair kerning makes a
 * per-character table wrong: `STATUS` sums to 43.857 in raw glyph advances and
 * lays out at 48.565 once the face's kern pairs and the 1.1 tracking are both
 * applied. Only the shaper knows, so the shaper is what produced these.
 *
 * `no-hidden-content.test.ts` proves the table faithful rather than asking to
 * be trusted: it re-derives `SORT_BAR_CONTENT_WIDTH` from these numbers
 * through the formula `SortBar` publishes, and lands on the 382 that component
 * arrived at from an independent measurement.
 *
 * Re-measure with a CoreText harness that registers the file, builds a CTLine
 * with the face and the tracking as kern, and reads
 * `CTLineGetTypographicBounds`:
 *   ./measure src/design/fonts/Archivo-Medium.ttf Archivo-Medium 11 1.1 CONNECTORS
 */

/** The type-scale entries that appear inside a fixed-width container. */
export type TypeStyleName = "kicker" | "label";

/**
 * Advances in points. Keys are the string as it is laid out, so `kicker` keys
 * are upper case: that is what the shaper measured and what the screen draws.
 * A label missing from here is a failure, never a pass, because a zero would
 * make any container look wide enough.
 */
const ADVANCES: Record<TypeStyleName, Readonly<Record<string, number>>> = {
  // Archivo-Medium, 11pt, letterSpacing 1.1, upper case.
  kicker: {
    TASKS: 41.118,
    SKILLS: 43.945,
    CONNECTORS: 89.342,
    PLUGINS: 55.935,
    YOU: 27.115,
    AGENT: 43.956,
    THINKING: 61.974,
    SENT: 33.99,
    REPLY: 40.26,
    // The phrase the terminal gutter used to hold, and its words. Kept
    // measured after it was cut back so a regression to it prices as the width
    // failure it is, rather than dying as an unmeasured label and hiding which
    // word was too wide. TERMINAL is the one that broke: 64.999 against the 58
    // points a 68-point gutter left.
    "SENT TO THIS TERMINAL": 155.947,
    TO: 17.303,
    THIS: 29.59,
    TERMINAL: 64.999,
    "LAST REPLY": 75.834,
    LAST: 32.219,
    // Every shape `elapsed` can produce, widest first. The day form is the one
    // that decided the terminal gutter: 58.729 did not fit the 58 points a
    // 68-point gutter left, and a stamp has no space to wrap at.
    "365D 23H": 58.729,
    "365D": 31.394,
    "23H": 23.98,
    "23:59:59": 53.57,
    "--:--": 23.617,
    // The sort bar's five, kept here so the table can be checked against the
    // width that component published from its own independent measurement.
    STATUS: 48.565,
    AGE: 26.95,
    "LAST ACTIVE": 81.829,
    MESSAGES: 71.28,
    SIZE: 29.183,
  },
  // Archivo-Medium, 12pt, letterSpacing 0.3, as written.
  label: {
    "1": 6.864,
    "9": 7.188,
    "99": 14.376,
    "100": 21.24,
    "999": 21.564,
  },
};

/** One label's laid-out width in points, or a thrown error if nobody measured it. */
export function advance(style: TypeStyleName, text: string): number {
  const key = style === "kicker" ? text.toUpperCase() : text;
  const width = ADVANCES[style][key];
  if (width === undefined) {
    throw new Error(
      `no measured advance for ${style} "${key}". Measure it with CoreText against ` +
        `src/design/fonts and add it to test/type-metrics.ts; an unmeasured label ` +
        `cannot be checked, and defaulting one to zero would pass every container.`,
    );
  }
  return width;
}

/** The widest run of a label that no layout engine can break up, and its width. */
export interface Unbreakable {
  /** The run itself: the whole label, or its widest word. */
  run: string;
  /** That run's width in points. A container narrower than this breaks it. */
  width: number;
  /** True when the label has nowhere to wrap, so it has to fit whole. */
  atomic: boolean;
}

/**
 * What a container has to fit for this label to stay readable.
 *
 * A label with a space in it can wrap, so only its widest word has to fit. One
 * with no space has to fit whole: there is nowhere to break, and an engine out
 * of room breaks the word itself, which is how a 64-point rail turned
 * `CONNECTORS` into `CONNECT` over `ORS`.
 *
 * Splitting on whitespace only, deliberately. A layout engine will break
 * inside a token like `23:59:59` before it gives up, so treating punctuation
 * as a wrap opportunity would clear a container that in fact cuts the stamp.
 */
export function unbreakable(style: TypeStyleName, text: string): Unbreakable {
  const words = text.split(/\s+/).filter(word => word.length > 0);
  if (words.length <= 1) return { run: text, width: advance(style, text), atomic: true };
  let widest = words[0] as string;
  for (const word of words) if (advance(style, word) > advance(style, widest)) widest = word;
  return { run: widest, width: advance(style, widest), atomic: false };
}
