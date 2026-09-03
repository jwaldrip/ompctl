/**
 * The theme hook's contract, both halves.
 *
 * `useOmpTheme` declares `OmpTheme`, and outside a provider Paper hands back
 * `MD3LightTheme` -- a real object with none of ompctl's keys on it. Without the
 * guard the declared type is a lie and the first surface to read
 * `theme.rhythm.cardPad` crashes. With it, the signature is true everywhere.
 *
 * Both directions are asserted in the same file on purpose. A test that only
 * proved the bare case would pass against a hook that IGNORED the provider, and
 * that hook would quietly render the dark theme in daylight.
 */

import "./rnw.ts";

import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { useOmpTheme } = await import("../src/design/useOmpTheme.ts");
const { ompDarkTheme, ompLightTheme } = await import("../src/design/theme.ts");
const { WithOmpTheme } = await import("./theme.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Mount a probe and hand back the theme it saw. */
function themeSeenBy(wrap: (probe: React.JSX.Element) => React.JSX.Element): Record<string, unknown> {
  const seen: { theme: Record<string, unknown> | null } = { theme: null };
  function Probe(): null {
    seen.theme = useOmpTheme() as unknown as Record<string, unknown>;
    return null;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(wrap(<Probe />));
  });
  act(() => {
    root.unmount();
  });
  host.remove();
  if (seen.theme === null) throw new Error("the probe never rendered");
  return seen.theme;
}

test("outside a provider the hook still returns a whole OmpTheme", () => {
  const theme = themeSeenBy(probe => probe);
  // The keys a surface reads on its first line. Paper's default theme has none
  // of them, so this is exactly what the guard supplies.
  expect(theme.rhythm).toBe(ompDarkTheme.rhythm);
  expect(theme.ground).toBe(ompDarkTheme.ground);
  expect(theme.ink).toBe(ompDarkTheme.ink);
  expect(theme.signal).toBe(ompDarkTheme.signal);
  expect(theme.dark).toBe(true);
});

test("inside a provider the provider's theme wins, so the guard is not a bypass", () => {
  const dark = themeSeenBy(probe => <WithOmpTheme scheme="dark">{probe}</WithOmpTheme>);
  expect(dark.ground).toBe(ompDarkTheme.ground);

  const light = themeSeenBy(probe => <WithOmpTheme scheme="light">{probe}</WithOmpTheme>);
  // The half a bare-case-only test could not see: a hook that ignored the
  // provider would return the dark ground here and still pass everything above.
  expect(light.ground).toBe(ompLightTheme.ground);
  expect(light.dark).toBe(false);
  // Shared across both themes, so a light surface still measures the same.
  expect(light.rhythm).toBe(ompDarkTheme.rhythm);
});
