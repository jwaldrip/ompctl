/**
 * The one way a harness puts ompctl's design system above what it mounts.
 *
 * Paper's components read their colours, faces and radii from the provider. A
 * `Button` or a `Chip` rendered without one comes out in Material's palette,
 * so any test asserting themed output has to wrap -- and every test doing that
 * by hand would be six slightly different wrappers within a week.
 *
 * `scheme` is fixed rather than read from the host, because `useColorScheme()`
 * follows the machine's appearance setting and a frame that changes with the
 * time of day is not a fixture.
 */

import type { JSX, ReactNode } from "react";
import { OmpThemeProvider } from "../src/design/OmpTheme.tsx";

export function WithOmpTheme({
  children,
  scheme = "dark",
}: {
  children: ReactNode;
  scheme?: "light" | "dark";
}): JSX.Element {
  return <OmpThemeProvider scheme={scheme}>{children}</OmpThemeProvider>;
}
