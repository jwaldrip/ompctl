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
import { signal } from "../src/design/tokens.ts";
import type { BrowserSession, BrowserState } from "../src/session/browser.ts";
import { EMPTY_BROWSER } from "../src/session/browser.ts";
import { makeSessionCorpus } from "./fixtures/session-corpus.ts";

// Dynamic on purpose, same reason as `smoke.test.tsx`: a static import of
// "react-native" here would resolve before `./rnw.ts`'s `mock.module` call
// could substitute it.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { SessionRow } = await import("../src/components/SessionRow.tsx");
const { StyleSheet } = await import("react-native");

/** Read off the screen rather than imported by name: see the note above the dynamic imports. */
type FleetLink = Parameters<typeof FleetScreen>[0]["link"];

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

/** A `#rrggbb` token as react-native-web writes it into a class rule. */
function rgbaOf(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1.00)`;
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

const CONNECTED: FleetLink = { connection: "connected", attempt: 0, indexed: true };

/** Markup plus only the atomic CSS used by that rendered page. */
function render(browser: BrowserState, deleteAccess: ScopeAccess = "granted", link: FleetLink = CONNECTED): string {
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
      link={link}
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

  test("every group carries its directory name and count when grouping is enabled", () => {
    const windowed = render(windowedState({ grouped: true }));
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

  test("the active sort is nameable: the default recency activity chip is marked active", () => {
    expect(html).toContain(`data-testid="sort-chip-lastActive"`);
    expect(html).toContain(`data-testid="sort-direction-lastActive"`);
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

/**
 * The three absences. Observed on 2026-09-06: a phone holding a revoked
 * pairing, and later one behind a dead tunnel, both drew "0 sessions" and
 * "Start one with ompd agents create" over a daemon holding 699 sessions.
 * An empty roster is the daemon's finding; before the first index, and with
 * the link down, it is this device not knowing.
 */
describe("an absent roster is only 'no sessions' once the daemon has said so", () => {
  test("before the first index arrives the bay is loading, not empty", () => {
    const html = render({ ...EMPTY_BROWSER, sessions: [] }, "granted", { ...CONNECTED, indexed: false });
    expect(html).toContain('data-testid="fleet-loading"');
    expect(html).toContain("Loading sessions.");
    expect(html).not.toContain("No sessions.");
    expect(html).not.toContain("ompd agents create");
  });

  test("with the link down the bay says so, and the header shows the link instead of a count", () => {
    const html = render({ ...EMPTY_BROWSER, sessions: [] }, "granted", {
      connection: "reconnecting",
      attempt: 3,
      indexed: false,
    });
    expect(html).toContain('data-testid="fleet-unreachable"');
    expect(html).toContain("Not connected to the daemon.");
    expect(html).toContain("Reconnecting, attempt 3.");
    expect(html).toContain('data-testid="fleet-link"');
    expect(html).toContain(">reconnecting<");
    expect(html).not.toContain('data-testid="fleet-count"');
    expect(html).not.toContain("0 sessions");
    expect(html).not.toContain("No sessions.");
  });

  test("a stale list under a dropped link keeps its rows and wears the link word", () => {
    const html = render(windowedState(), "granted", { connection: "offline", attempt: 0, indexed: true });
    expect(html).toContain('data-testid="session-row-');
    expect(html).toContain(">offline<");
    expect(html).not.toContain('data-testid="fleet-count"');
  });

  test("a first connection that is still connecting says connecting, not empty", () => {
    const html = render({ ...EMPTY_BROWSER, sessions: [] }, "granted", {
      connection: "connecting",
      attempt: 0,
      indexed: false,
    });
    expect(html).toContain(">connecting<");
    expect(html).toContain("Connecting.");
    expect(html).not.toContain("No sessions.");
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

  test("archive and delete are in the row's more menu, not persistent columns", () => {
    // Persistent columns at rest are gone; the trailing action is the single More control
    expect(html).toContain(`data-testid="session-more-${dormant.id}"`);
    expect(html).toContain(`More for ${dormant.title}`);
    expect(html).not.toContain(`data-testid="session-archive-${dormant.id}"`);
    expect(html).not.toContain(`data-testid="session-delete-${dormant.id}"`);
  });

  test("opening the more menu exposes archive and delete controls", () => {
    const menuHtml = renderToStaticMarkup(
      <SessionRow
        session={dormant}
        defaultMenuOpen
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(menuHtml).toContain(`data-testid="session-archive-${dormant.id}"`);
    expect(menuHtml).toContain(`Archive ${dormant.title}`);
    expect(menuHtml).toContain(`data-testid="session-delete-${dormant.id}"`);
    expect(menuHtml.toLowerCase()).not.toContain("destroy");
  });

  test("an archived row's menu action reads Restore, not Resume or Attach", () => {
    const archived = WINDOWED.find(s => s.status === "archived") as BrowserSession;
    const menuHtml = renderToStaticMarkup(
      <SessionRow
        session={archived}
        defaultMenuOpen
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(menuHtml).toContain(`data-testid="session-unarchive-${archived.id}"`);
    expect(menuHtml).toContain(`Restore ${archived.title}`);
  });
});

describe("collapsed group status precedence, rendered", () => {
  test("a collapsed group still shows its count and worst-status colour", () => {
    const dir = "/Users/op/dev/src/github.com/op/repo-0"; // 1 session, live-tui (d=0,i=0 -> statuses[0])
    const collapsed: BrowserState = windowedState({ grouped: true, collapsedGroups: new Set([dir]) });
    const html = render(collapsed);
    expect(html).toContain(`data-testid="group-header-${dir}"`);
    expect(html).toContain(`data-testid="group-count-${dir}"`);
    // amber is live-tui's signal colour; the collapsed header still carries it.
    // react-native-web writes the token out as rgba, so the assertion reads it
    // from the token rather than pinning a hex that a retheme would change.
    const headerStart = html.indexOf(`group-header-${dir}`);
    const headerRegion = html.slice(Math.max(0, headerStart - 300), headerStart + 400);
    expect(headerRegion).toContain(rgbaOf(signal.working));
  });

  test("collapsing a group removes its rows from the list but not its header", () => {
    const dir = "/Users/op/dev/src/github.com/op/repo-2"; // 3 sessions
    // Show archived too, so every session in the group is accounted for
    // regardless of status; the point here is collapse, not visibility.
    const group = WINDOWED.filter(s => s.cwd === dir);
    const expanded = render(windowedState({ grouped: true, showArchived: true }));
    const collapsed = render(windowedState({ grouped: true, showArchived: true, collapsedGroups: new Set([dir]) }));

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
  test("default is a flat list without group headers", () => {
    const html = render(windowedState());
    expect(html).not.toContain('data-testid="group-header-');
    for (const session of WINDOWED.filter(s => s.status !== "archived")) {
      expect(html).toContain(`data-testid="session-row-${session.id}"`);
    }
  });

  test("turning grouping on renders group headers", () => {
    const html = render(windowedState({ grouped: true }));
    expect(html).toContain('data-testid="group-header-');
  });
});

describe("search and project filters, rendered", () => {
  test("renders search input with placeholder", () => {
    const html = render(browserState());
    expect(html).toContain('data-testid="fleet-search"');
    expect(html).toContain('placeholder="Search sessions..."');
  });

  test("project filter uses a picker in the search row instead of a chip bar", () => {
    const html = render(browserState());
    expect(html).not.toContain('data-testid="project-filter-bar"');
    expect(html).toContain('data-testid="project-picker-trigger"');
    expect(html).toContain("All projects");

    // Selected project renders as a single removable chip with brand.azure
    const selectedHtml = render(browserState({ project: "/Users/op/dev/src/github.com/op/repo-0" }));
    expect(selectedHtml).toContain('data-testid="project-chip-selected"');
    expect(selectedHtml).toContain("repo-0");
    expect(selectedHtml).toContain('data-testid="project-chip-clear"');
    // Selection uses brand.azure (#5b9dff), never amber signal.working
    expect(selectedHtml).toContain("rgba(91,157,255,1");
  });

  test("active sort chip uses brand.azure, not amber signal.working", () => {
    const html = render(browserState());
    expect(html).toContain('data-testid="sort-direction-lastActive"');
    const chipStart = html.indexOf('data-testid="sort-chip-lastActive"');
    const chipRegion = html.slice(chipStart, chipStart + 350);
    expect(chipRegion).toContain("rgba(91,157,255,1");
    expect(chipRegion).not.toContain("rgba(255,176,32,1");
  });

  test("row metrics container has no-wrap style and single-line structure", () => {
    const html = render(windowedState());
    // Check each session has its metrics container
    const target = WINDOWED[0]?.id as string;
    expect(html).toContain(`data-testid="session-metrics-${target}"`);
    // Style sheet includes nowrap for flexWrap
    expect(html).toContain("flex-wrap:nowrap");
  });

  test("row metrics fit on one line and support spend reading", () => {
    const sessionWithCost: BrowserSession = {
      ...(WINDOWED[0] as BrowserSession),
      cost: 0.42,
    };
    const htmlWithCost = renderToStaticMarkup(
      <SessionRow
        session={sessionWithCost}
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(htmlWithCost).toContain(`data-testid="session-spend-${sessionWithCost.id}"`);
    expect(htmlWithCost).toContain("$0.42");
    expect(htmlWithCost).toContain("spend");
    // On compact screens (phone width), size is dropped
    expect(htmlWithCost).not.toContain(`data-testid="session-size-${sessionWithCost.id}"`);

    // Null cost renders no spend reading, never a zero
    const sessionNullCost: BrowserSession = {
      ...(WINDOWED[0] as BrowserSession),
      cost: null,
    };
    const htmlNullCost = renderToStaticMarkup(
      <SessionRow
        session={sessionNullCost}
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(htmlNullCost).not.toContain(`data-testid="session-spend-${sessionNullCost.id}"`);
    expect(htmlNullCost).not.toContain("spend");
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
    const moreTag = markup.match(/<[^>]*data-testid="session-more-[^"]*"[^>]*>/)?.[0] ?? "";
    const moreRules = rulesDeclaring(css, classListOf(moreTag));
    expect(moreTag).not.toBe("");
    expect(moreRules).not.toMatch(/padding-right/);
    expect(moreRules).not.toMatch(/margin-right/);
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

describe("the fleet header List/Board view toggle", () => {
  test("renders list and board toggle buttons in the fleet header", () => {
    const markup = render(browserState({ view: "list" }));
    expect(markup).toContain('data-testid="fleet-view-toggle"');
    expect(markup).toContain('data-testid="view-toggle-list"');
    expect(markup).toContain('data-testid="view-toggle-board"');
  });

  test("renders the board when view is 'board' and list when view is 'list'", () => {
    const listMarkup = render(browserState({ view: "list" }));
    expect(listMarkup).toContain('data-testid="fleet-list"');
    expect(listMarkup).not.toContain('data-testid="session-board"');

    const boardMarkup = render(browserState({ view: "board" }));
    expect(boardMarkup).toContain('data-testid="session-board"');
    expect(boardMarkup).not.toContain('data-testid="fleet-list"');
  });
});
