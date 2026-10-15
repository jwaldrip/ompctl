/**
 * Unit and render tests for Nerd Font glyph runs and PUA font substitution.
 *
 * Verifies that private-use code points (BMP and supplementary planes 15 and 16)
 * are split into symbol runs rendered in SymbolsNF, while plain text runs and
 * strings with no PUA glyphs render unchanged without extra DOM nesting.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { face } from "../src/design/tokens.ts";

// Dynamic import to allow rnw.ts to stub react-native before text.tsx evaluates.
const { Title, Text, splitGlyphRuns, isPuaCodePoint } = await import("../src/design/text.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("isPuaCodePoint", () => {
  test("identifies BMP PUA code points (U+E000 to U+F8FF)", () => {
    expect(isPuaCodePoint(0xe000)).toBe(true);
    expect(isPuaCodePoint(0xe711)).toBe(true);
    expect(isPuaCodePoint(0xf8ff)).toBe(true);
    expect(isPuaCodePoint(0xdfff)).toBe(false);
    expect(isPuaCodePoint(0xf900)).toBe(false);
  });

  test("identifies Plane 15 PUA code points (U+F0000 to U+FFFFD)", () => {
    expect(isPuaCodePoint(0xf0000)).toBe(true);
    expect(isPuaCodePoint(0xf011c)).toBe(true);
    expect(isPuaCodePoint(0xffffd)).toBe(true);
    expect(isPuaCodePoint(0xeffff)).toBe(false);
    expect(isPuaCodePoint(0xffffe)).toBe(false);
  });

  test("identifies Plane 16 PUA code points (U+100000 to U+10FFFD)", () => {
    expect(isPuaCodePoint(0x100000)).toBe(true);
    expect(isPuaCodePoint(0x10fffd)).toBe(true);
    expect(isPuaCodePoint(0x10fffe)).toBe(false);
  });
});

describe("splitGlyphRuns", () => {
  test("splits BMP glyph", () => {
    const runs = splitGlyphRuns("\uE711");
    expect(runs).toEqual([
      {
        text: "\uE711",
        isSymbol: true,
      },
    ]);
  });

  test("splits supplementary glyph U+F011C as a surrogate pair", () => {
    const runs = splitGlyphRuns("\u{F011C}");
    expect(runs).toEqual([
      {
        text: "\u{F011C}",
        isSymbol: true,
      },
    ]);
  });

  test('splits mixed text like "\\u{F011C} NOTCH: Setup"', () => {
    const runs = splitGlyphRuns("\u{F011C} NOTCH: Setup");
    expect(runs).toEqual([
      {
        text: "\u{F011C}",
        isSymbol: true,
      },
      {
        text: " NOTCH: Setup",
        isSymbol: false,
      },
    ]);
  });

  test("merges adjacent glyphs into one run", () => {
    const runs = splitGlyphRuns("\u{F011C}\u{F0FCE}");
    expect(runs).toEqual([
      {
        text: "\u{F011C}\u{F0FCE}",
        isSymbol: true,
      },
    ]);
  });

  test("returns one plain run when text has no PUA", () => {
    const runs = splitGlyphRuns("NOTCH: Setup");
    expect(runs).toEqual([
      {
        text: "NOTCH: Setup",
        isSymbol: false,
      },
    ]);
  });

  test("returns empty array for empty string", () => {
    const runs = splitGlyphRuns("");
    expect(runs).toEqual([]);
  });
});

describe("Text render integration", () => {
  test('Title with "\\u{F011C} NOTCH" renders nested element in SymbolsNF font', () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(<Title testID="test-title">{"\u{F011C} NOTCH"}</Title>);
    });

    const outer = container.firstElementChild as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.textContent).toBe("\u{F011C} NOTCH");

    const nestedElements = outer?.querySelectorAll("*") ?? [];
    expect(nestedElements.length).toBe(1);

    const symbolElement = nestedElements[0] as HTMLElement;
    expect(symbolElement.textContent).toBe("\u{F011C}");
    expect(symbolElement.style.fontFamily).toBe(face.symbols);

    // Verify surrounding text stays in parent
    const childNodes = Array.from(outer?.childNodes ?? []);
    expect(childNodes.length).toBe(2);
    expect(childNodes[0]).toBe(symbolElement);
    expect(childNodes[1]?.textContent).toBe(" NOTCH");
  });

  test("Title with string without PUA renders no nested element", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(<Title testID="plain-title">NOTCH</Title>);
    });

    const outer = container.firstElementChild as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.textContent).toBe("NOTCH");

    const nestedElements = outer?.querySelectorAll("*") ?? [];
    expect(nestedElements.length).toBe(0);
  });

  test("Text handles top-level array children with PUA", () => {
    const container = document.createElement("div");
    const root = createRoot(container);

    act(() => {
      root.render(
        <Text testID="array-text">
          {"Status: "}
          {"\u{F011C}"}
          {" online"}
        </Text>,
      );
    });

    const outer = container.firstElementChild as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.textContent).toBe("Status: \u{F011C} online");

    const nested = outer?.querySelectorAll("*") ?? [];
    expect(nested.length).toBe(1);
    const symbolElement = nested[0] as HTMLElement;
    expect(symbolElement.textContent).toBe("\u{F011C}");
    expect(symbolElement.style.fontFamily).toBe(face.symbols);
  });

  test("Text handles top-level Fragment children with PUA", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <Text testID="fragment-text">
          <Fragment key="frag">
            {"\u{F011C} inside fragment"}
            {" and more"}
          </Fragment>
        </Text>,
      );
    });

    const outer = container.firstElementChild as HTMLElement | null;
    expect(outer).not.toBeNull();
    expect(outer?.textContent).toBe("\u{F011C} inside fragment and more");

    const nested = outer?.querySelectorAll("*") ?? [];
    expect(nested.length).toBe(1);
    const symbolElement = nested[0] as HTMLElement;
    expect(symbolElement.textContent).toBe("\u{F011C}");
    expect(symbolElement.style.fontFamily).toBe(face.symbols);
  });
});
