/**
 * The ramp grows its line box with its glyphs.
 *
 * React Native scales `fontSize` for the operator's text-size setting and
 * scales nothing else. `tokens.ts` pairs every size with an ABSOLUTE
 * `lineHeight` and an absolute `letterSpacing`, so before this every one of
 * these components drew larger glyphs inside a line box that had not moved.
 *
 * Found on hardware, not here, which is the point of the file. On an iPhone 17
 * simulator at extra-extra-extra-large -- the largest ORDINARY size, not an
 * accessibility one -- IDLE rendered as "IDLI", SESSION as "SESSIO", LINKED as
 * "LINKE", context as "conte:". On an iPad Pro 13-inch at the same setting,
 * with six hundred points of pane to spare, STOPPED came out "STOPPE" and a 1/1
 * count chip came out "1..". Room was never the problem; the line box was.
 *
 * So the assertions below are about the RATIO, not about any particular number:
 * whatever a scale does to `fontSize`, it must do to `lineHeight` and to
 * `letterSpacing`, or the glyphs outgrow their box again at some size nobody
 * tested. Reading the rendered declarations rather than the token means a ramp
 * entry that is written and never applied fails here.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { resetWindowSize, setFontScale } from "./rnw.ts";

const { Body, Code, Data, Display, Kicker, Label, Title } = await import("../src/design/text.tsx");
const { type: typeScale } = await import("../src/design/tokens.ts");
const { StyleSheet } = await import("react-native");

/**
 * `getSheet` is a react-native-web extension its own web build publishes and its
 * types do not: static StyleSheet values compile to atomic classes whose
 * declarations live in one injected sheet rather than in the markup. Same cast
 * `composer-actions.test.tsx` and `terminal-session.test.tsx` make, named here
 * for the same reason they name it.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every declaration reaching an element, from both places RNW puts one: the
 * `style` attribute for a value computed at render time, an atomic class for one
 * registered at module scope.
 *
 * Scoped to the element's OWN classes, never the whole sheet. A whole-sheet scan
 * is how `pair-screen.test.tsx` came to report a max-width belonging to a Paper
 * component it never rendered.
 */
function declarationsOf(el: HTMLElement): string {
  const inline = el.getAttribute("style") ?? "";
  const classes = el.className.split(/\s+/).filter(Boolean);
  const own = rnwStyleSheet
    .getSheet()
    .textContent.split("\n")
    .filter(rule => classes.some(name => rule.startsWith(`.${name}{`)))
    .join("\n");
  return `${inline}\n${own}`.replace(/\s+/g, "");
}

/** One numeric declaration off an element, or null when nothing sets it. */
function points(el: HTMLElement, property: string): number | null {
  const found = new RegExp(`(?:^|;|\\{)${property}:(-?[0-9.]+)px`).exec(declarationsOf(el));
  return found === null ? null : Number(found[1]);
}

/** Render one line component at a font scale and hand back its element. */
function lineAt(node: (text: string) => React.JSX.Element, fontScale: number): HTMLElement {
  setFontScale(fontScale);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node("Wg"));
  });
  const el = host.querySelector<HTMLElement>('[data-testid="probe"]');
  if (el === null) throw new Error("the line did not render");
  // Read before unmounting: the atomic classes stay in the sheet, but the
  // element has to still be attached for its own class list to be readable.
  const measured = el.cloneNode(true) as HTMLElement;
  measured.className = el.className;
  act(() => {
    root.unmount();
  });
  host.remove();
  return measured;
}

const RAMP = [
  ["kicker", typeScale.kicker, (t: string) => <Kicker testID="probe">{t}</Kicker>],
  ["label", typeScale.label, (t: string) => <Label testID="probe">{t}</Label>],
  ["body", typeScale.body, (t: string) => <Body testID="probe">{t}</Body>],
  ["title", typeScale.title, (t: string) => <Title testID="probe">{t}</Title>],
  ["display", typeScale.display, (t: string) => <Display testID="probe">{t}</Display>],
  ["data", typeScale.data, (t: string) => <Data testID="probe">{t}</Data>],
  ["code", typeScale.code, (t: string) => <Code testID="probe">{t}</Code>],
] as const;

describe("every entry of the ramp scales its line box with its glyphs", () => {
  for (const [name, entry, render] of RAMP) {
    test(`${name} grows its line height in step with the operator's text size`, () => {
      try {
        const plain = lineAt(render, 1);
        // The default size is untouched, which is what makes this safe to ship:
        // nothing already measured against the ramp moves.
        expect(points(plain, "line-height")).toBe(entry.lineHeight);

        const big = lineAt(render, 1.5);
        const grown = points(big, "line-height");
        if (grown === null) throw new Error(`${name} rendered no line-height at 1.5`);
        // The ratio, not the number: whatever the platform does to fontSize has
        // to reach the box, or the glyphs outgrow it at some untested size.
        expect(grown).toBeCloseTo(entry.lineHeight * 1.5, 5);
      } finally {
        resetWindowSize();
      }
    });
  }

  test("tracking scales too, so a tracked-out kicker does not outrun its column", () => {
    try {
      // The kicker is the one that broke first on device, because its 1.1 points
      // of tracking are a tenth of its own size: held constant while the glyphs
      // grew, the word's advance and its spacing stop agreeing.
      const plain = lineAt(t => <Kicker testID="probe">{t}</Kicker>, 1);
      expect(points(plain, "letter-spacing")).toBe(typeScale.kicker.letterSpacing);

      const big = lineAt(t => <Kicker testID="probe">{t}</Kicker>, 1.5);
      const grown = points(big, "letter-spacing");
      if (grown === null) throw new Error("no letter-spacing at 1.5");
      expect(grown).toBeCloseTo(typeScale.kicker.letterSpacing * 1.5, 5);
    } finally {
      resetWindowSize();
    }
  });
});
