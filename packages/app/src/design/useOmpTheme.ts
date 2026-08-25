/**
 * The theme hook every surface uses.
 *
 * Separate from `OmpTheme.tsx` so a module that needs the theme does not import
 * the provider, and so this file stays free of JSX -- `renderers.tsx`,
 * `tokens.ts` consumers and the pure-function tests all reach for it.
 *
 * Paper's `useTheme` is generic and defaults to `MD3Theme`, which knows nothing
 * about `rhythm`, `ground`, `ink` or `signal`. Passing the parameter here once
 * is what makes `theme.rhythm.gutter` a checked read at every call site instead
 * of a cast, and it is why no surface should ever import `useTheme` from
 * `react-native-paper` directly.
 */

import { useTheme } from "react-native-paper";
import type { OmpTheme } from "./theme.ts";

export function useOmpTheme(): OmpTheme {
  return useTheme<OmpTheme>();
}
