/**
 * The app root's palette, under a device that asks for light.
 *
 * This is the test the suite did not have, and its absence shipped a real
 * regression: `OmpThemeProvider` used to resolve `useColorScheme()`, so a phone
 * set to light appearance drew a dark header and a dark narration band over a
 * cream transcript, a cream context strip and a cream composer. Every existing
 * theme test passed through it, because `test/theme.tsx` pins `scheme` and the
 * hook's own test asserts the provider in both directions on purpose. Pinning
 * the scheme is right for a fixture and it is exactly what hid this: nothing
 * mounted the tree the way production mounts it, which is with no `scheme` at
 * all.
 *
 * So this file asserts the root, not the hook, and it asserts it on the device
 * that broke: light. Two things have to hold together.
 *
 *  - **The premise is checked first.** A test that asserted "the app is dark"
 *    on a device already reporting dark would pass against the bug. The first
 *    test proves the harness's device really does report light appearance, so
 *    the second one is answering the question it claims to.
 *  - **Coherence is the assertion, not darkness.** 43 files still import
 *    `ground` / `ink` / `signal` straight from `tokens.ts`, which is the dark
 *    ramp and nothing else. The invariant that actually broke is that the theme
 *    a surface reads through `useOmpTheme()` and the ramp an unmigrated surface
 *    imports directly must be the SAME objects. That is asserted by identity
 *    below, so it keeps holding as those files migrate and stops holding the
 *    moment the provider consults the device again.
 *
 * The last test renders Paper's own components, because the hook agreeing with
 * the tokens would still leave a `Button` and a `Chip` free to paint Material's
 * palette if the provider were not above them.
 */

import "./rnw.ts";

import { expect, test } from "bun:test";
import { act, type JSX } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

// Dynamic on purpose, and the only reason it has to be: bun loads a file's
// whole static import graph before any module body runs, so a static import of
// anything reaching `react-native` would pull the real module in before
// `./rnw.ts` could substitute react-native-web for it.
const { OmpThemeProvider, useOmpTheme } = await import("../src/design/OmpTheme.tsx");
const { ompDarkTheme, ompLightTheme } = await import("../src/design/theme.ts");
const { ground, ink, signal, signalWash } = await import("../src/design/tokens.ts");
const { useColorScheme, View } = await import("react-native");
const { Button, Chip, Divider } = await import("react-native-paper");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Mount `tree` for one commit and hand back whatever `read` saw inside it. */
function mounted<T>(tree: (probe: JSX.Element) => JSX.Element, read: () => T): T {
  const seen: { value: T | null } = { value: null };
  function Probe(): null {
    seen.value = read();
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(tree(<Probe />));
  });
  act(() => {
    root.unmount();
  });
  host.remove();
  if (seen.value === null) throw new Error("the probe never rendered");
  return seen.value;
}

/**
 * Every way react-native-web might spell one of our hex colours once it has
 * been through a style resolver. Named because "does this colour appear" is not
 * a substring search, and getting the list wrong is how this assertion lies:
 * RNW normalises to `rgba(r,g,b,1.00)` with no spaces, so a matcher that only
 * knew hex and `rgb(...)` found nothing in a tree full of ompctl colours and
 * would have reported the light ramp absent for the same reason. The alpha is
 * left off the end deliberately, so a tone still counts when Paper hands it
 * over at partial opacity.
 */
function spellings(hex: string): string[] {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [
    hex.toLowerCase(),
    hex.toUpperCase(),
    `rgb(${r}, ${g}, ${b})`,
    `rgb(${r},${g},${b})`,
    `rgba(${r},${g},${b},`,
    `rgba(${r}, ${g}, ${b},`,
  ];
}

test("the premise: this harness's device reports LIGHT appearance", () => {
  // Not decoration. Without this, every assertion below could be answering
  // "is a dark device dark", which the regression also satisfied.
  expect(
    mounted(
      probe => probe,
      () => useColorScheme() ?? "unset",
    ),
  ).toBe("light");
});

test("the production root takes ompctl dark on a light device, and does not ask", () => {
  // Exactly how `App.tsx` mounts it: no `scheme` prop.
  const theme = mounted(
    probe => <OmpThemeProvider>{probe}</OmpThemeProvider>,
    () => useOmpTheme() as unknown as Record<string, unknown>,
  );

  expect(theme.dark).toBe(true);
  expect(theme.ground).toBe(ompDarkTheme.ground);
  expect(theme.ink).toBe(ompDarkTheme.ink);
  // The half that names the defect: an unmigrated surface importing `ground`
  // from `tokens.ts` and a migrated one reading `theme.ground` have to be
  // holding the same object, or the app is two palettes at once.
  expect(theme.ground).toBe(ground);
  expect(theme.ink).toBe(ink);
  expect(theme.signal).toBe(signal);
  expect(theme.signalWash).toBe(signalWash);
  // And it is genuinely not the light theme, which is still defined.
  expect(theme.ground).not.toBe(ompLightTheme.ground);
});

test("the scheme prop is still a real harness seam, so a theme fixture keeps working", () => {
  const light = mounted(
    probe => <OmpThemeProvider scheme="light">{probe}</OmpThemeProvider>,
    () => useOmpTheme() as unknown as Record<string, unknown>,
  );
  expect(light.ground).toBe(ompLightTheme.ground);
  expect(light.dark).toBe(false);
});

test("Paper's own components under the production root paint one dark ompctl palette", () => {
  const markup = renderToStaticMarkup(
    <OmpThemeProvider>
      <View>
        <Divider />
        <Chip>status</Chip>
        <Button mode="contained">send</Button>
      </View>
    </OmpThemeProvider>,
  );

  // Nothing from the light ramp may appear. This is the assertion that fails
  // loudly if the provider starts reading the device again: on this light
  // device every one of these would arrive.
  for (const [name, hex] of Object.entries({ ...ompLightTheme.ground, ...ompLightTheme.ink })) {
    expect(
      spellings(hex).some(form => markup.includes(form)),
      `light ramp ${name} (${hex}) reached Paper`,
    ).toBe(false);
  }

  // Material's own default must not appear either: the provider is what keeps
  // MD3 purple out, and a tree rendered without one would show it here.
  expect(spellings("#6750A4").some(form => markup.includes(form))).toBe(false);

  // And the dark ramp did arrive, so this is not passing on an empty render.
  const darkTones = [ground.base, ground.surface, ground.raised, ground.line, ground.edge, signal.sage];
  expect(
    darkTones.some(hex => spellings(hex).some(form => markup.includes(form))),
    "no ompctl dark tone reached Paper",
  ).toBe(true);
});
