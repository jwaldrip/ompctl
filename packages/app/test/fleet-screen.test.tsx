/**
 * FleetScreen, rendered.
 *
 * Same discipline as `smoke.test.tsx`: react-native-web is the shipped web
 * target rather than a test double. Dynamic style values (a status colour
 * computed from a prop) render inline, which is what lets `smoke.test.tsx`
 * assert on raw `rgba(...)` values; static `StyleSheet.create()` values (a
 * fixed width, a min-height) compile to atomic CSS classes instead, whose
 * rules live in `StyleSheet.getSheet().textContent` rather than in the
 * markup. `render()` below concatenates both, so a width or height audit of
 * "the rendered tree" covers what a real page would actually ship.
 *
 * Two corpora, because the list is windowed. 42 sessions across 12 directories
 * for everything the header and the toolbar report, which is computed from the
 * whole corpus whether or not a row is mounted; and 6 sessions across 3
 * directories for the assertions about a specific row or group, which have to
 * be inside the mounted window to be assertable at all. `fleet-scale.test.tsx`
 * owns the window's own bound. A test that needs a particular row on screen
 * and asks for it out of 42 is not testing the row, it is testing where the
 * virtualizer happened to stop.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScopeAccess } from "../src/console/state.ts";
import type { BrowserSession, BrowserState } from "../src/session/browser.ts";
import { EMPTY_BROWSER } from "../src/session/browser.ts";
import { makeSessionCorpus } from "./fixtures/session-corpus.ts";

// Dynamic on purpose, same reason as `smoke.test.tsx`: a static import of
// "react-native" here would resolve before `./rnw.ts`'s `mock.module` call
// could substitute it.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { StyleSheet } = await import("react-native");

const NOW = Date.parse("2026-03-01T00:00:00.000Z");
const CORPUS = makeSessionCorpus(12);

/**
 * Small enough that every row and every group header is inside the first
 * window: 3 directories, 6 sessions, one of them archived.
 */
const WINDOWED = makeSessionCorpus(3);

function browserState(overrides: Partial<BrowserState> = {}): BrowserState {
  return { ...EMPTY_BROWSER, sessions: CORPUS, ...overrides };
}

function windowedState(overrides: Partial<BrowserState> = {}): BrowserState {
  return { ...EMPTY_BROWSER, sessions: WINDOWED, ...overrides };
}

const NOOP_SESSION = (_session: BrowserSession) => {};
const NOOP_FIELD = () => {};
const NOOP_CWD = () => {};
const NOOP = () => {};

/**
 * `getSheet` is a react-native-web extension the `react-native` type surface
 * does not declare; the standard types have no way to express it, so this is
 * an unchecked cast onto a real, stable API rather than onto guessed shape.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/**
 * RNW's sheet is process-global: importing a screen registers its styles even
 * when that screen is not rendered. Keep only rules whose class selector
 * appears in this markup. That makes layout assertions about FleetScreen, not
 * desktop-only declarations from other screens such as Cowork's 300px sidebar.
 */
function hasClassSelector(rule: string, className: string): boolean {
  const escapedClassName = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\.${escapedClassName}(?=$|[\\s.#\\[:{])`).test(rule);
}

function stylesForMarkup(markup: string): string {
  const classNames = new Set<string>();
  for (const match of markup.matchAll(/\bclass="([^"]*)"/g)) {
    const classAttribute = match[1];
    if (classAttribute === undefined) continue;
    for (const className of classAttribute.split(/\s+/)) {
      if (className) classNames.add(className);
    }
  }

  return [...rnwStyleSheet.getSheet().textContent.matchAll(/[^{}]+\{[^{}]*\}/g)]
    .filter(rule => [...classNames].some(className => hasClassSelector(rule[0], className)))
    .map(rule => rule[0])
    .join("\n");
}

/** Markup plus only the atomic CSS used by that rendered page. */
function render(browser: BrowserState, deleteAccess: ScopeAccess = "granted"): string {
  const markup = renderToStaticMarkup(
    <FleetScreen
      browser={browser}
      onSort={NOOP_FIELD}
      onToggleGroup={NOOP_CWD}
      onToggleGrouped={NOOP}
      onToggleArchived={NOOP}
      onOpen={NOOP_SESSION}
      onArchive={NOOP_SESSION}
      onUnarchive={NOOP_SESSION}
      onDelete={NOOP_SESSION}
      deleteAccess={deleteAccess}
      now={NOW}
    />,
  );
  return `${markup}\n<style>${stylesForMarkup(markup)}</style>`;
}

describe("RNW style rule scoping", () => {
  test("matches complete class selector tokens, not class-name prefixes", () => {
    expect(hasClassSelector(".r-width-1{width:1px}", "r-width-1")).toBe(true);
    expect(hasClassSelector(".r-width-12{width:12px}", "r-width-1")).toBe(false);
  });
});

describe("the session browser renders a realistic corpus", () => {
  const html = render(browserState());

  test("every group in the mounted window carries its directory name and count", () => {
    const windowed = render(windowedState());
    for (let d = 0; d < 3; d++) {
      expect(windowed).toContain(`repo-${d}`);
      expect(windowed).toContain(`data-testid="group-count-/Users/op/dev/src/github.com/op/repo-${d}"`);
    }
  });

  test("the visible count excludes archived by default", () => {
    const archivedCount = CORPUS.filter(s => s.status === "archived").length;
    const visibleCount = CORPUS.length - archivedCount;
    expect(archivedCount).toBeGreaterThan(0);
    expect(html).toContain(`${visibleCount} sessions`);
  });

  test("archived hidden count is shown on the toggle", () => {
    const archivedCount = CORPUS.filter(s => s.status === "archived").length;
    expect(html).toContain(`data-testid="archived-hidden-count"`);
    expect(html).toContain(`>${archivedCount}<`);
  });

  test("the active sort is nameable: the default status chip is marked active", () => {
    expect(html).toContain(`data-testid="sort-chip-status"`);
    expect(html).toContain(`data-testid="sort-direction-status"`);
  });

  test("nothing renders an emoji where an icon belongs", () => {
    expect(html).toContain("<svg");
    expect(/\p{Extended_Pictographic}/u.test(html)).toBe(false);
  });

  test("an empty browser says so rather than showing nothing", () => {
    const empty = render({ ...EMPTY_BROWSER, sessions: [] });
    expect(empty).toContain("No sessions.");
    expect(empty).toContain("0 sessions");
  });
});

describe("open and archive are visually distinct actions", () => {
  const live = WINDOWED.find(s => s.status === "live-tui") as BrowserSession;
  const dormant = WINDOWED.find(s => s.status === "dormant") as BrowserSession;
  const html = render(windowedState());

  test("a dormant row's canonical open action reads Resume, not Archive or Delete", () => {
    expect(html).toContain(`data-testid="session-open-${dormant.id}"`);
    expect(html).toContain(`Resume ${dormant.title}`);
  });

  test("a live-tui row's canonical open action reads Prompt, distinct from a dormant Resume", () => {
    expect(html).toContain(`data-testid="session-open-${live.id}"`);
    expect(html).toContain(`Prompt ${live.title}`);
  });

  test("archive is a separate control from open, with its own testID and label", () => {
    expect(html).toContain(`data-testid="session-archive-${dormant.id}"`);
    expect(html).toContain(`Archive ${dormant.title}`);
    // The open and archive actions are separate pressables with distinct
    // canonical identities.
    expect(html).not.toContain(`data-testid="session-archive-${dormant.id}"data-testid="session-open-${dormant.id}"`);
  });

  test("archive's label never says delete, remove, or destroy", () => {
    const archiveButtonRegion = html.slice(
      html.indexOf(`session-archive-${dormant.id}`) - 40,
      html.indexOf(`session-archive-${dormant.id}`) + 120,
    );
    expect(archiveButtonRegion.toLowerCase()).not.toContain("delete");
    expect(archiveButtonRegion.toLowerCase()).not.toContain("destroy");
  });

  test("an archived row's primary action reads Restore, not Resume or Attach", () => {
    const archived = WINDOWED.find(s => s.status === "archived") as BrowserSession;
    // Archived is hidden by default; show it to reach the row at all.
    const withArchived = render(windowedState({ showArchived: true }));
    expect(withArchived).toContain(`data-testid="session-unarchive-${archived.id}"`);
    expect(withArchived).toContain(`Restore ${archived.title}`);
  });
});

describe("collapsed group status precedence, rendered", () => {
  test("a collapsed group still shows its count and worst-status colour", () => {
    const dir = "/Users/op/dev/src/github.com/op/repo-0"; // 1 session, live-tui (d=0,i=0 -> statuses[0])
    const collapsed: BrowserState = windowedState({ collapsedGroups: new Set([dir]) });
    const html = render(collapsed);
    expect(html).toContain(`data-testid="group-header-${dir}"`);
    expect(html).toContain(`data-testid="group-count-${dir}"`);
    // amber is live-tui's signal colour; the collapsed header still carries it.
    const headerStart = html.indexOf(`group-header-${dir}`);
    const headerRegion = html.slice(Math.max(0, headerStart - 300), headerStart + 400);
    expect(headerRegion).toContain("rgba(224,163,58,1.00)");
  });

  test("collapsing a group removes its rows from the list but not its header", () => {
    const dir = "/Users/op/dev/src/github.com/op/repo-2"; // 3 sessions
    // Show archived too, so every session in the group is accounted for
    // regardless of status; the point here is collapse, not visibility.
    const group = WINDOWED.filter(s => s.cwd === dir);
    const expanded = render(windowedState({ showArchived: true }));
    const collapsed = render(windowedState({ showArchived: true, collapsedGroups: new Set([dir]) }));

    expect(group.length).toBeGreaterThan(1);
    for (const session of group) {
      expect(expanded).toContain(`data-testid="session-row-${session.id}"`);
      expect(collapsed).not.toContain(`data-testid="session-row-${session.id}"`);
    }
    // The header survives collapse in both renders.
    expect(collapsed).toContain(`data-testid="group-header-${dir}"`);
  });
});

describe("grouping toggle", () => {
  test("turning grouping off renders a flat list with cwd shown per row", () => {
    const html = render(windowedState({ grouped: false }));
    expect(html).not.toContain('data-testid="group-header-');
    // Every row of the small corpus, from three different directories.
    for (const session of WINDOWED.filter(s => s.status !== "archived")) {
      expect(html).toContain(`data-testid="session-row-${session.id}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// 390px: the real test, not a desktop window
// ---------------------------------------------------------------------------

/**
 * This environment inlines styles directly (`smoke.test.tsx` already proves
 * that by asserting on raw `rgba(...)` values), so every fixed pixel width in
 * the rendered tree is visible as `width:<n>px` in the markup. A component
 * that hardcoded something wider than a 390px phone would show up here as a
 * `width` well past 390; nothing in SessionRow, GroupHeader, or SortBar
 * declares one; the max fixed width in the whole tree is the two 44px touch
 * targets (Design tokens: `TOUCH_TARGET`) plus the 3px status bar, all
 * flex-adjacent to text columns that carry `flexShrink`/`numberOfLines={1}`.
 */
describe("renders at a 390px phone width without a fixed width past it", () => {
  const html = render(browserState());

  test("row height: session rows and group headers both use the 44px touch target as their minimum", () => {
    // TOUCH_TARGET = 44. SessionRow's row and GroupHeader's header both set
    // minHeight to it (see components/SessionRow.tsx, components/GroupHeader.tsx).
    const rowMinHeights = [...html.matchAll(/min-height:\s*44px/gi)];
    expect(rowMinHeights.length).toBeGreaterThan(0);
  });

  test("no declared width in the rendered tree exceeds the 390px viewport", () => {
    const widths = [...html.matchAll(/width:\s*(\d+(?:\.\d+)?)px/gi)].map(m => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    const max = Math.max(...widths);
    expect(max).toBeLessThanOrEqual(390);
    // The actual ceiling is the 44px touch target column, well under budget.
    expect(max).toBeLessThanOrEqual(44);
  });

  test("text columns that could overflow are clamped to one line", () => {
    // Title and path text use numberOfLines={1}, which react-native-web
    // compiles to a `overflow-x:hidden;overflow-y:hidden;` class plus
    // text-overflow ellipsis, so a long title never pushes the row wider
    // than its flex container.
    expect(html).toMatch(/overflow-x:hidden/);
    expect(html).toContain("text-overflow:ellipsis");
  });
});

// ---------------------------------------------------------------------------
// The header's controls belong at the screen's trailing content edge
// ---------------------------------------------------------------------------

/**
 * `render()` concatenates markup and the atomic CSS it uses, so a test can
 * read a specific element's classes out of the markup and then check what
 * those classes declare, the same discipline the 390px suite above applies to
 * widths. Returns the full opening tag so attribute order never matters.
 */
function openingTagAt(markup: string, index: number): string {
  const start = markup.lastIndexOf("<div", index);
  return start === -1 ? "" : markup.slice(start, markup.indexOf(">", start) + 1);
}

/**
 * RNW writes an element's atomic classes as one space-separated attribute;
 * this is the extraction the two tests below share, kept as a named step
 * because the empty-class fallback is easy to get wrong inline.
 */
function classListOf(tag: string): string[] {
  return (tag.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/).filter(name => name.length > 0);
}

/**
 * The subset of the sheet whose selector addresses one of these classes,
 * joined for regex matching. Scopes every assertion to the element under
 * test, so a margin or flex elsewhere in the tree cannot satisfy it.
 */
function rulesDeclaring(css: string, classes: readonly string[]): string {
  return css
    .split("\n")
    .filter(rule => classes.some(name => hasClassSelector(rule, name)))
    .join("\n");
}

describe("the header's controls sit at the trailing content edge", () => {
  const page = render(browserState());
  const sheetStart = page.indexOf("\n<style>");
  const markup = page.slice(0, sheetStart);
  const css = page.slice(sheetStart);
  /**
   * The level this harness can honestly observe. happy-dom computes no real
   * layout, so a rendered rectangle for the head strip and one for a row
   * would both read zero and any geometric assertion would be vacuous. What
   * the harness does have is the atomic CSS each element's style compiles
   * to, and the defect's whole mechanism lives there: `head` carried
   * `paddingHorizontal: space.wide`, a 16px `padding-right` that parked the
   * toggles inboard of the rows' flush action column, seen by eye on the
   * iPad. These tests read that sheet, so restoring the old padding fails
   * them outright rather than by approximation.
   */
  const headTag = markup.match(/<[^>]*data-testid="fleet-head"[^>]*>/)?.[0] ?? "";
  const headClasses = classListOf(headTag);
  const headRules = rulesDeclaring(css, headClasses);

  test("the strip takes no trailing inset: the toggles reach the rows' trailing edge", () => {
    // `fleet-head` anchors the strip; without it the tag lookup finds
    // nothing and this test fails rather than passing on an empty ruleset.
    expect(headClasses.length).toBeGreaterThan(0);
    const trailingInsets = [...headRules.matchAll(/padding-right:\s*(\d+(?:\.\d+)?)px/g)].map(m => Number(m[1]));
    expect(Math.max(0, ...trailingInsets)).toBe(0);
  });

  test("the strip keeps its leading inset: the title still leads on the shared content edge", () => {
    // SortBar's chips and the group headers both lead on `space.wide`
    // (16px); a fix that dropped the strip's padding altogether would put
    // the title outboard of every strip beneath it, the same defect on the
    // other edge.
    expect(headClasses.length).toBeGreaterThan(0);
    expect(headRules).toMatch(/padding-left:\s*16px/);
  });

  test("the rows' trailing action column is the flush edge the toggles align to", () => {
    // The other half of the contract. Every row's trailing-most control is
    // its delete action, a bare 44px target with no padding or margin of
    // its own, so the column it forms is the screen's trailing edge itself.
    // If the rows ever gain a trailing inset, this fails instead of letting
    // the two edges drift apart in opposite directions.
    const deleteTag = markup.match(/<[^>]*data-testid="session-delete-[^"]*"[^>]*>/)?.[0] ?? "";
    const deleteRules = rulesDeclaring(css, classListOf(deleteTag));
    expect(deleteTag).not.toBe("");
    expect(deleteRules).not.toMatch(/padding-right/);
    expect(deleteRules).not.toMatch(/margin-right/);
  });

  test("the title group flexes to absorb the slack, not a spacer's worth of it", () => {
    // The wrapper View around the title is the last div opened before the
    // title's own tag; it must be the element carrying flex, or the toggles
    // after it drift back toward the count the way the phone screenshot
    // showed.
    const leadTag = openingTagAt(markup, markup.indexOf('data-testid="fleet-title"'));
    const leadClasses = classListOf(leadTag);
    expect(leadClasses.length).toBeGreaterThan(0);
    // RNW compiles `flex: 1` differently across versions: the grow/shrink/
    // basis shorthand, atomized longhand, or the bare `flex:1` this repo's
    // RNW actually emits. The pin is the contract, this group takes the
    // remaining width, not one compiler's spelling of it.
    expect(rulesDeclaring(css, leadClasses)).toMatch(/flex:\s*1\s+1\s+0%|flex-grow:\s*1|flex:\s*1\s*;/);
  });

  test("the toggles add no margin of their own; the head's gap spaces the strip", () => {
    // Both toggles share `styles.toggle`, so whichever rule set each carries,
    // none of it may declare a margin: a leftover marginLeft here would fight
    // the right alignment the title group's flex just bought.
    for (const id of ["grouped-toggle", "archived-toggle"]) {
      const tag = markup.match(new RegExp(`<[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
      const classes = classListOf(tag);
      expect(classes.length).toBeGreaterThan(0);
      expect(rulesDeclaring(css, classes)).not.toMatch(/margin-left/);
    }
  });
});
