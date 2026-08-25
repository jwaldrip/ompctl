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
   * It was 76 plus a 12 point gap, so 88 points of a 390 point phone -- 22% of
   * the width -- went to a label before a single word of the conversation. The
   * widest word it holds is "thinking" at `type.kicker` (11pt, tracked 1.1),
   * which measures about 56 points, so 64 clears it and hands 24 points back to
   * every line of prose.
   */
  attribution: 64,

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
