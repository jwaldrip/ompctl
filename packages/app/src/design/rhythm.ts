/**
 * The semantic spacing scale: where the four-point grid actually gets spent.
 *
 * `tokens.ts` owns the grid (`space`), and the grid was never the problem. The
 * problem was that every surface picked its own step off it for the same job,
 * so the app had several different screen gutters, several row rhythms, and a
 * transcript attribution column 76 points wide on a 390 point phone. A grid is
 * not a system until each JOB on it has exactly one answer.
 *
 * So this file names jobs, not sizes. A surface asks for `rhythm.gutter`, never
 * for `space.wide`, and the day a gutter changes it changes for every screen at
 * once. Every value is a member of `space`, so the grid still holds; what is
 * fixed here is the mapping from job to step.
 *
 * Distinct from `layout.ts`, which answers a different question: that file is
 * about how many panes fit on a screen, this one is about the air between
 * things once they are on it.
 *
 * Read through the theme (`useOmpTheme().rhythm`) rather than imported by
 * surfaces, so a test can assert the token a surface used rather than the number
 * it happened to produce.
 */

import { space, TOUCH_TARGET } from "./tokens.ts";

export const rhythm = {
  /**
   * The horizontal inset from a screen's edge to its content. ONE value, every
   * screen, every platform. The transcript, the composer dock, the context
   * strip, the readout and the bay all pay exactly this, which is what makes a
   * column read as a column rather than as four panels that nearly line up.
   */
  gutter: space.wide,

  /**
   * Between consecutive rows of the same kind: two transcript turns, two
   * context rows, two list items. The rhythm a reader's eye locks onto.
   */
  rowGap: space.step,

  /** Between a row and something belonging to it: a chip band under a field. */
  rowGapTight: space.snug,

  /** Between sections that are genuinely different things. */
  sectionGap: space.loose,

  /**
   * A glyph to its own label, inside one control.
   *
   * Tighter than the gap between two controls on purpose: past about four
   * points an icon and its word stop reading as one object and start reading as
   * two things that happen to be adjacent, which is how a row of controls turns
   * into a row of orphaned glyphs. `controls.ts` already spent this value on
   * exactly this job before it had a name.
   */
  glyphGap: space.tight,

  /**
   * Two lines that are one thought: a headline and its subline, a value and its
   * unit. Closer than `rowGap`, because those two lines are not siblings -- the
   * second one only means anything under the first.
   */
  pairGap: space.hair,

  /**
   * A labelled control's own horizontal padding, edge to text.
   *
   * Control geometry rather than layout: it belongs to the button, not to the
   * surface the button sits on, which is why it does not follow `cardPad`.
   */
  controlPad: space.snug,

  /**
   * Inside a card, edge to content. Tool cards are the densest thing in the app
   * and they read as dense rather than cramped only because this is a step
   * tighter than the screen gutter: a card already sits inside one, and paying
   * the gutter twice is what made them look padded out.
   */
  cardPad: space.step,

  /** Between stacked elements inside one card. */
  cardGap: space.snug,

  /** Between two cards in a run. */
  cardStack: space.snug,

  /**
   * The transcript's attribution column: the gutter carrying "you" / "agent" /
   * "thinking" beside the prose.
   *
   * It was 76 wide with an 8 point left pad and a 12 point gap to the prose, so
   * 88 points of a 390 point phone -- 22% of the width -- went to a label before
   * a single word of the conversation.
   *
   * The number is set by one word and the arithmetic is not a guess. The gate in
   * `test/no-hidden-content.test.ts` computes the room a fixed column really has
   * as `width - paddingLeft - borderLeftWidth`, and the widest label is
   * "thinking" at `type.kicker`, which the repo's own CoreText table
   * (`test/type-metrics.ts`) measures at **61.974** points. With the column's 2
   * point signal rule and a `glyphGap` left pad that leaves 72 - 4 - 2 = 66, so
   * it clears by 4 and the gate can prove it.
   *
   * An earlier draft of this token said 64, on a guessed 56 point measurement.
   * It would have left 54 against 61.974 and clipped the word on every thought
   * row. Paired with the prose gap dropping from `rowGap` to `rowGapTight`, the
   * column now costs 80 rather than 88: 8 points back on every line of prose,
   * which is less than the first draft claimed and is what the metrics allow.
   */
  attribution: 72,

  /** One step of nesting: a subagent under its parent. */
  indent: space.loose,

  /** Between the two panes of a split screen. */
  paneGutter: space.wide,

  /** Smallest square a finger can reliably hit, so a surface needs one import. */
  minTarget: TOUCH_TARGET,

  /**
   * Composer surface to the safe-area edge. Deliberately snug: the home
   * indicator already reserves its own space, and paying a full gutter on top
   * of it left the composer floating above the screen edge.
   */
  dockPad: space.snug,
} as const;

export type Rhythm = typeof rhythm;
