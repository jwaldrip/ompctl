/**
 * The fleet bay's width on a split screen.
 *
 * A fixed 340 was the defect: every tablet whatever its size gave the list
 * 340 points and asked the sort bar (382 at the default type size) and every
 * row title to fit inside. The width is now a fraction of the window with a
 * floor and a ceiling (design/layout.ts), and this file walks it the way the
 * app meets it: as the pure function across every screen class, and as the
 * real Console rendered at three windows, where the bay's width must appear
 * in the styles the rendered tree actually uses and must move when the
 * window does.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic on purpose, the same reason `fleet-screen.test.tsx` gives: these
// modules import react-native, which must resolve after ./rnw.ts has had its
// mock.module call to substitute it.
const { SPLIT_BAY_FRACTION, SPLIT_BAY_MAX, SPLIT_BAY_MIN, splitBayWidth } = await import("../src/design/layout.ts");
const { Console } = await import("../src/console/Console.tsx");
const { StyleSheet } = await import("react-native");

afterEach(resetWindowSize);

describe("the bay's width answers the window it lands on", () => {
  test("narrow windows get the floor however small their fraction is", () => {
    // An iPad mini in portrait (744) and a phone turned sideways past the
    // split threshold (860) both fall short of the floor on the fraction
    // alone, and the floor is what keeps the sort bar whole.
    expect(splitBayWidth(744)).toBe(SPLIT_BAY_MIN);
    expect(splitBayWidth(860)).toBe(SPLIT_BAY_MIN);
    expect(splitBayWidth(999)).toBe(SPLIT_BAY_MIN);
  });

  test("between the clamps the bay tracks its fraction of the window", () => {
    expect(splitBayWidth(1024)).toBe(Math.round(1024 * SPLIT_BAY_FRACTION));
    expect(splitBayWidth(1080)).toBe(432);
    expect(splitBayWidth(1280)).toBe(512);
    expect(splitBayWidth(1366)).toBe(546);
  });

  test("wide windows stop at the ceiling", () => {
    // A react-native-web window has no natural maximum; without the clamp a
    // 1920-point browser would hand the list half the monitor.
    expect(splitBayWidth(1400)).toBe(SPLIT_BAY_MAX);
    expect(splitBayWidth(1920)).toBe(SPLIT_BAY_MAX);
    expect(splitBayWidth(2560)).toBe(SPLIT_BAY_MAX);
  });

  test("the answer never runs backwards as the window widens", () => {
    let previous = 0;
    for (let width = 300; width <= 2600; width += 20) {
      const bay = splitBayWidth(width);
      expect(bay).toBeGreaterThanOrEqual(previous);
      expect(bay).toBeGreaterThanOrEqual(SPLIT_BAY_MIN);
      expect(bay).toBeLessThanOrEqual(SPLIT_BAY_MAX);
      previous = bay;
    }
  });
});

// ---------------------------------------------------------------------------
// The rendered console
// ---------------------------------------------------------------------------

/**
 * `getSheet` is a react-native-web extension the `react-native` type surface
 * does not declare; the cast is the same one `fleet-screen.test.tsx` carries.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/**
 * RNW's sheet is process-global: importing the console registers every
 * screen's styles even when only the fleet is rendered. Keep only rules whose
 * class selector appears in this markup, the same extraction
 * `fleet-screen.test.tsx` uses, so a width found here is a width this render
 * actually applied.
 */
function stylesForMarkup(markup: string): string {
  const classNames = new Set<string>();
  for (const match of markup.matchAll(/\bclass="([^"]*)"/g)) {
    const classAttribute = match[1];
    if (classAttribute === undefined) continue;
    for (const className of classAttribute.split(/\s+/)) {
      if (className) classNames.add(className);
    }
  }
  const inMarkup = (rule: string): boolean => {
    for (const className of classNames) {
      const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\.${escaped}(?=$|[\\s.#\\[:{])`).test(rule)) return true;
    }
    return false;
  };
  return [...rnwStyleSheet.getSheet().textContent.matchAll(/[^{}]+\{[^{}]*\}/g)]
    .filter(rule => inMarkup(rule[0]))
    .map(rule => rule[0])
    .join("\n");
}

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "prompt", "approve", "manage"],
};

const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [{ id: "local", label: "Studio Mac", connection: CONNECTION }],
};

/** The console at the current canned window, as markup plus the CSS this render used. */
function renderConsole(): string {
  const markup = renderToStaticMarkup(
    <Console
      connection={CONNECTION}
      daemonLabel="Studio Mac"
      connections={CONNECTIONS}
      onAddConnection={() => {}}
      onSelectConnection={() => {}}
      onUnpair={() => {}}
    />,
  );
  return `${markup}\n<style>${stylesForMarkup(markup)}</style>`;
}

describe("the rendered console's bay follows the window", () => {
  test("an iPad mini in portrait gets the floor, and the old 340 is gone", () => {
    setWindowSize(744, 1133);
    const html = renderConsole();
    expect(html).toMatch(/width:\s*400px/);
    expect(html).not.toMatch(/width:\s*340px/);
  });

  test("a wider tablet gets proportionally more than the floor", () => {
    setWindowSize(1080, 810);
    const html = renderConsole();
    expect(html).toMatch(/width:\s*432px/);
    // The floor value from the narrower render must not still be the bay's.
    expect(html).not.toMatch(/width:\s*400px/);
  });

  test("a desktop-width window stops at the ceiling", () => {
    setWindowSize(1440, 1080);
    const html = renderConsole();
    expect(html).toMatch(/width:\s*560px/);
    expect(html).not.toMatch(/width:\s*432px/);
  });

  test("a phone keeps the single-pane layout and no fixed bay width", () => {
    setWindowSize(390, 844);
    const html = renderConsole();
    expect(html).toContain('data-testid="fleet-surface"');
    // splitBayWidth(390) is 400, so this exact rule present would mean the
    // bay fixed its width on a phone too. The phone bay is flex, width-free.
    expect(html).not.toMatch(/width:\s*400px/);
  });
});
