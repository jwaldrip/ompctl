/**
 * The theme hook every surface uses.
 *
 * Separate from `OmpTheme.tsx` so a module that needs the theme does not import
 * the provider, and so this file stays free of JSX.
 *
 * ## The declared return type has to be true, including outside a provider
 *
 * Paper's `useTheme` is generic and defaults to `MD3Theme`, which knows nothing
 * about `rhythm`, `ground`, `ink` or `signal`. Passing the parameter makes
 * `theme.rhythm.gutter` a checked read at every call site rather than a cast,
 * and it is why no surface imports `useTheme` from `react-native-paper`
 * directly.
 *
 * But a type parameter is a claim, not a guarantee. With no provider above it,
 * Paper hands back `MD3LightTheme` -- a real object, missing every ompctl key --
 * and the cast would make `theme.rhythm.cardPad` a crash at the first surface
 * that read it. So the guard below is what makes the signature honest: outside a
 * provider this returns the app's own theme, which is a `OmpTheme`, which is
 * what the type says.
 *
 * That is a default, not a fallback papering over a mistake. The provider is
 * mounted once at the app root and `test/omp-theme.test.tsx` asserts both
 * halves: bare, this is `ompDarkTheme`; wrapped, the provider's theme wins.
 * Paper's own components still need the provider to get ompctl's colours, so
 * any harness asserting themed output wraps with `test/theme.tsx` regardless.
 */

import { useTheme } from "react-native-paper";
import { type OmpTheme, ompDarkTheme } from "./theme.ts";

export function useOmpTheme(): OmpTheme {
  // The cheapest possible probe, and it has to be an ompctl-only key: every
  // MD3 key is present on Paper's default theme, so checking one of those would
  // pass while `rhythm` was still missing.
  const theme = useTheme<Partial<OmpTheme>>();
  return theme.rhythm === undefined ? ompDarkTheme : (theme as OmpTheme);
}
