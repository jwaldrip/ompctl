/**
 * Nothing in this interface may hide something else.
 *
 * Two ways it already had. A session row laid its four readings across the
 * full row width while the action buttons sat at the trailing edge as later
 * siblings, so the size reading ran underneath them and only the sliver in
 * the gap between the two buttons was visible: on an iPad the number read
 * `10.` and then a stray `e`. And the notice floated absolutely above the
 * composer, which on 2026-08-19 put a connectivity complaint physically on
 * top of the reply it was complaining about not receiving.
 *
 * Both are the same defect wearing different clothes, so both are pinned
 * here as a class rather than as two screen fixes. The rules are the ones
 * that actually make occlusion impossible:
 *
 * - a row clips its own content, so nothing can paint outside its box;
 * - a flex item holding text can shrink, because a flex item's minimum is its
 *   content by default and that floor is what produces the overflow;
 * - a row of readings wraps rather than overflowing;
 * - a notice is a band in the column, not a layer over it.
 *
 * A third arrived on 2026-08-22, the same shape once more: a fixed 340-point
 * master pane squeezed the fleet list until the pane's own edge cut the sort
 * bar's SIZE chip down to a bare S. So the class gains its third rule:
 *
 * - a row of column labels is never wider than its container lets it be
 *   seen: the container either fits it, scrolls it, or the bay is wide
 *   enough at its floor that neither is needed.
 *
 * A fourth, the same day, on the tablet: the composer's surface colour
 * stopped one inset short of the screen edge, because the view paying the
 * bottom inset was transparent and the shell's base colour showed through
 * the gap below the message box. So the class gains its fourth rule:
 *
 * - the view that pays a composer's bottom inset paints the composer's
 *   surface, because no child can paint a parent's padding.
 * The wrap form of it landed the same day. The cowork rail pinned its nav
 * column at 64 points while `CONNECTORS` lays out at 89.34, so the rail did
 * not clip the label, it broke the word: `CONNECT` over `ORS`. The terminal
 * gutter had it too, 68 points holding `Sent to this terminal`. Neither is a
 * clip, so the rule above did not catch either, and the class gains one more:
 *
 * - a fixed-width container fits the label it holds, or the label has a space
 *   to wrap at. A single word wider than its container has nowhere to go, and
 *   an engine out of room breaks the word rather than the line.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { space, stroke } from "../src/design/tokens.ts";
import { advance, type TypeStyleName, unbreakable } from "./type-metrics.ts";

const root = `${import.meta.dir}/..`;

async function source(file: string): Promise<string> {
  return await Bun.file(`${root}/${file}`).text();
}

/** The body of one `StyleSheet.create` entry, so a rule is read from the style it belongs to rather than from the file at large. */
function styleBlock(text: string, name: string): string {
  const start = text.indexOf(`${name}: {`);
  if (start === -1) throw new Error(`no style named ${name}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated style ${name}`);
}

describe("a session row cannot paint under its own actions", () => {
  test("the row clips, the body can shrink, and the readings wrap", async () => {
    const text = await source("src/components/SessionRow.tsx");
    expect(styleBlock(text, "row")).toContain('overflow: "hidden"');
    // Without this the readings set a floor the body cannot go under, and the
    // overflow lands beneath the actions.
    expect(styleBlock(text, "body")).toContain("minWidth: 0");
    expect(styleBlock(text, "readings")).toContain('flexWrap: "wrap"');
  });
});

describe("a notice occupies space rather than covering it", () => {
  test("the toast is not absolutely positioned", async () => {
    const text = await source("src/components/Toast.tsx");
    expect(styleBlock(text, "toast")).not.toContain('position: "absolute"');
  });

  test("no component floats a dismissible notice over the console", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("src/components/*.tsx").scan({ cwd: root })) {
      const text = await source(file);
      // A notice is identified by what it does, not by its name: it carries a
      // live region for a screen reader and a tap that clears it.
      const isNotice = text.includes("accessibilityLiveRegion") && text.includes("onDismiss");
      if (isNotice && text.includes('position: "absolute"')) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

describe("a column label cannot be cut at its container's edge", () => {
  test("the sort bar's chips scroll rather than clip", async () => {
    const text = await source("src/components/SortBar.tsx");
    // The bar is the fleet's one row of column labels, and the bay's edge is
    // exactly where it was being cut. A horizontal ScrollView keeps overflow
    // reachable; any other container crops it at the pane edge.
    expect(text).toMatch(/<ScrollView[^>]*horizontal/);
  });

  test("the bay's floor fits the whole sort bar at rest", async () => {
    // The rule the floor exists for: at the default type size every chip and
    // the arrow must be on screen without a swipe, so the floor can never
    // sit under the bar's measured width. The imports are dynamic because a
    // static one would resolve react-native before ./rnw.ts substitutes it,
    // and the widths are read from the modules rather than matched out of
    // the source because they are computed, not written down.
    const { SORT_BAR_CONTENT_WIDTH } = await import("../src/components/SortBar.tsx");
    const { SPLIT_BAY_MIN } = await import("../src/design/layout.ts");
    expect(SPLIT_BAY_MIN).toBeGreaterThanOrEqual(SORT_BAR_CONTENT_WIDTH);
  });

  test("the bay's width is computed from the window, never a fixed literal", async () => {
    const text = await source("src/console/Console.tsx");
    // 340 on every tablet whatever the screen is the defect; the literal in
    // the style sheet is how it happened. The lookbehind keeps a
    // borderRightWidth from satisfying the check the way a width property
    // would fail it.
    expect(styleBlock(text, "splitBay")).not.toMatch(/(?<![A-Za-z])width\s*:/);
    expect(text).toContain("useSplitBayWidth()");
  });
});

describe("a composer's surface reaches the edge it pads to", () => {
  test("the view paying the inset below a composer paints the composer's surface", async () => {
    for (const file of ["src/screens/SessionScreen.tsx", "src/screens/TerminalSessionScreen.tsx"]) {
      const text = await source(file);
      expect(styleBlock(text, "composerSafe")).toContain("backgroundColor: ground.surface");
      // The colour and the pad must be one view: a parent's padding is
      // outside every child, so a pad sitting on a transparent wrapper is
      // exactly the strip of base colour below the message box the operator
      // reported on the tablet.
      expect(text).toMatch(/styles\.composerSafe,\s*\{\s*paddingBottom: bottomInsetFor\(/);
    }
  });
});

/**
 * A style property in points, whether the source writes it as a number or as a
 * spacing token. Read out of the real style block, so narrowing a container or
 * growing its padding fails the rule instead of sliding past it. Comments are
 * stripped first: several of these blocks quote widths in prose.
 */
function styleNumber(block: string, property: string): number {
  const found = new RegExp(`(?<![A-Za-z])${property}\\s*:\\s*([A-Za-z0-9_.]+)`).exec(block.replace(/\/\/.*$/gm, ""));
  if (found === null) return 0;
  const written = found[1] as string;
  if (/^[0-9.]+$/.test(written)) return Number(written);
  const [table, key] = written.split(".");
  const tokens: Record<string, Record<string, number>> = { space, stroke };
  const value = tokens[table as string]?.[key as string];
  if (value === undefined) throw new Error(`cannot resolve ${property}: ${written}`);
  return value;
}

/** Every fixed-width container in the app that holds text, and the labels it can hold. */
interface LabelledColumn {
  what: string;
  file: string;
  style: string;
  type: TypeStyleName;
  labels: readonly string[];
}

/**
 * The quoted values of a property inside one named declaration, so a label set
 * is read from the declaration that owns it. Throws on an empty result: a
 * silent zero labels would clear every container it was asked about.
 */
function declaredStrings(text: string, name: string, property: string): readonly string[] {
  const declaration = new RegExp(`(?:const|let|var)\\s+${name}\\b`).exec(text);
  if (declaration === null) throw new Error(`no declaration named ${name} to read labels from`);
  const start = declaration.index;
  const end = text.indexOf(";", start);
  const body = text.slice(start, end === -1 ? undefined : end);
  const found = [...body.matchAll(new RegExp(`${property}:\\s*"([^"]+)"`, "g"))].map(match => match[1] as string);
  if (found.length === 0) throw new Error(`no ${property} entries inside ${name}`);
  return found;
}

/**
 * The labels each column can be asked to hold, read out of the declarations
 * that own them so adding a destination or renaming a hint word re-prices the
 * rule with no edit here. Read as source text rather than imported, like every
 * other rule in this file: importing a screen would drag its whole component
 * tree into a check that renders nothing.
 */
async function labelledColumns(): Promise<readonly LabelledColumn[]> {
  const cowork = await source("src/screens/CoworkScreen.tsx");
  const terminal = await source("src/screens/TerminalSessionScreen.tsx");
  return [
    {
      what: "the cowork rail's nav column",
      file: "src/screens/CoworkScreen.tsx",
      style: "navSide",
      type: "kicker",
      labels: declaredStrings(cowork, "DESTINATIONS", "label"),
    },
    {
      what: "the terminal log's attribution gutter",
      file: "src/screens/TerminalSessionScreen.tsx",
      style: "gutter",
      type: "kicker",
      // The two speakers, the two hint words, and every shape `elapsed` can
      // put on the gutter's second line. The day form is the widest of those.
      labels: [
        "you",
        "agent",
        ...declaredStrings(terminal, "HINT_WORDS", "(?:sent|reply)"),
        "365d 23h",
        "23:59:59",
        "--:--",
      ],
    },
    {
      what: "the transcript's attribution gutter",
      file: "src/assistant/renderers.tsx",
      style: "gutter",
      type: "kicker",
      labels: ["you", "agent", "thinking"],
    },
    {
      what: "a routine action's order badge",
      file: "src/screens/RoutinesScreen.tsx",
      style: "actionOrder",
      type: "label",
      // Actions are added one control tap at a time, so three digits is the
      // ceiling worth pricing; 999 is the widest of them, not 100.
      labels: ["1", "999"],
    },
  ];
}

describe("a fixed-width container cannot break the word it holds", () => {
  test("every labelled column fits its longest unbreakable run", async () => {
    const failures: string[] = [];
    for (const column of await labelledColumns()) {
      const block = styleBlock(await source(column.file), column.style);
      const room =
        styleNumber(block, "width") -
        styleNumber(block, "paddingLeft") -
        styleNumber(block, "paddingRight") -
        styleNumber(block, "paddingHorizontal") * 2 -
        styleNumber(block, "borderLeftWidth") -
        styleNumber(block, "borderRightWidth");
      for (const label of column.labels) {
        const { run, width, atomic } = unbreakable(column.type, label);
        if (width > room) {
          failures.push(
            `${column.what} leaves ${room} points, but ${atomic ? "the label" : `the word`} ` +
              `"${run}" from "${label}" lays out at ${width}: it will be broken mid-word`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test("a marker column that cannot be sized to its content is a floor, not a width", async () => {
    // The ordered-list marker is the one column whose content has no ceiling:
    // `100.` already outgrows 20 points and a long enough list keeps going. A
    // `minWidth` still aligns the short markers it was there for and can never
    // cut one, where a `width` would.
    const block = styleBlock(await source("src/components/rich/RichText.tsx"), "listMarker");
    expect(block).toMatch(/minWidth\s*:/);
    expect(block).not.toMatch(/(?<![A-Za-z])width\s*:/);
  });

  test("the measured advances agree with the width SortBar published from its own", async () => {
    // The table this rule reads is only worth as much as its numbers. SortBar
    // measured its five labels independently and published the total; deriving
    // that same total from this table, through the formula that component
    // states, is what makes the table evidence rather than an assertion.
    const { SORT_BAR_CONTENT_WIDTH } = await import("../src/components/SortBar.tsx");
    const labels = ["Status", "Age", "Last active", "Messages", "Size"];
    const chips = labels.length;
    const arrow = 8;
    const derived = Math.ceil(
      labels.reduce((total, label) => total + advance("kicker", label), 0) +
        arrow +
        chips * (space.snug * 2) +
        (chips - 1) * space.tight +
        space.tight +
        space.snug * 2,
    );
    expect(derived).toBe(SORT_BAR_CONTENT_WIDTH);
  });
});
