/**
 * A glyph name has to name a drawing, and no two names may draw the same thing.
 *
 * The Config control on the session head rendered `commands`, which was mapped
 * to `fa-slash`. That glyph is Font Awesome's negation stroke, the diagonal you
 * overlay on another icon to mean "not". Alone at fourteen points it is a bare
 * diagonal rule, which is what got screenshotted and reported as a broken
 * icon. Nothing was broken in the rendering sense: the path data was real and
 * the name resolved. The map was wrong, and no check could see it.
 *
 * Two more of the same defect were in the same map. `move` and `activity` were
 * both `fa-diagram-project`, and `plan` and `tasks` were both `fa-list-check`,
 * so four distinct meanings drew two shapes and an operator scanning a row
 * could not tell them apart.
 *
 * All three are the same class: a name whose drawing does not carry its
 * meaning. The part of that a machine can hold is pinned here.
 *
 * - a name must resolve to an icon that has path data, so a typo'd or missing
 *   entry cannot ship as an empty box;
 * - two names must not share one `IconDefinition`, unless the pair is listed
 *   in `SHARED_ON_PURPOSE` below with the reason written beside it.
 *
 * The third rule this file was going to carry is already enforced by the
 * compiler and is deliberately absent: `<Glyph name="configg">` fails
 * `bun run check` with `TS2820: Type '"configg"' is not assignable to type
 * 'GlyphName'`, because `GlyphProps.name` is the `GlyphName` union itself. A
 * test asserting the same thing could never fail, so it is not written.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";

/**
 * Pairs allowed to draw the same shape, each with the reason it is one meaning
 * wearing two names rather than two meanings collapsed into one drawing.
 *
 * Empty, and the intent is that it stays that way: every sharing this map had
 * turned out to be a defect. It exists so a future deliberate one has to be
 * written down here to pass, instead of passing silently.
 *
 * Three names on one drawing has no entry shape here and fails outright,
 * which is the right answer until somebody has an actual case for it.
 */
const SHARED_ON_PURPOSE: ReadonlyArray<{ names: readonly [string, string]; reason: string }> = [];

/**
 * `icons.tsx` is imported dynamically because a static import is hoisted above
 * `./rnw.ts`'s side effects, and the module reaches `react-native` through
 * `@fortawesome/react-native-fontawesome` before the substitution is
 * registered. This is the same reason `no-hidden-content.test.ts` imports
 * `SortBar.tsx` dynamically.
 */
async function glyphs(): Promise<Record<string, IconDefinition>> {
  const icons = await import("../src/design/icons.tsx");
  return icons.GLYPHS;
}

/** The path data an icon actually draws, flattened because a definition may hold one path or several. */
function pathData(icon: IconDefinition): string {
  const raw = icon.icon[4];
  return Array.isArray(raw) ? raw.join("") : raw;
}

describe("every glyph name draws something", () => {
  test("each entry resolves to an icon with path data", async () => {
    const map = await glyphs();
    // An undefined entry is what a typo'd or Pro-only import leaves behind:
    // the name still type-checks, and the icon is a hole.
    const empty = Object.entries(map)
      .filter(([, icon]) => icon === undefined || pathData(icon).length === 0)
      .map(([name]) => name);
    expect(empty).toEqual([]);
  });
});

describe("no two glyph names draw the same shape", () => {
  test("each IconDefinition is spent once, or the sharing is written down", async () => {
    const map = await glyphs();
    const byIcon = new Map<string, string[]>();
    for (const [name, icon] of Object.entries(map)) {
      // Keyed on the drawing rather than the object, so two imports of one
      // glyph collide here the same way one shared reference does.
      const key = `${icon.prefix}:${icon.iconName}`;
      byIcon.set(key, [...(byIcon.get(key) ?? []), name]);
    }

    const allowed = new Set(SHARED_ON_PURPOSE.map(entry => [...entry.names].sort().join("+")));
    const shared = [...byIcon]
      .filter(([, names]) => names.length > 1)
      .map(([key, names]) => ({ key, pair: [...names].sort().join("+") }))
      .filter(entry => !allowed.has(entry.pair))
      .map(entry => `${entry.pair} both draw ${entry.key}`);

    expect(shared).toEqual([]);
  });

  test("a name listed as an intentional sharing is one this map actually holds", async () => {
    const map = await glyphs();
    const unknown = SHARED_ON_PURPOSE.flatMap(entry => entry.names).filter(name => !(name in map));
    // An allowance for a name that no longer exists is a stale exception, and
    // stale exceptions are how a duplicate creeps back in unnoticed.
    expect(unknown).toEqual([]);
  });

  test("every intentional sharing carries a reason", () => {
    expect(SHARED_ON_PURPOSE.filter(entry => entry.reason.trim().length === 0)).toEqual([]);
  });
});
