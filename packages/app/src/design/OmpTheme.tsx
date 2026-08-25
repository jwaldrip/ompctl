/**
 * The one provider that puts ompctl's design system under the whole app.
 *
 * Two jobs, and the second is the one that keeps Paper from looking like Paper.
 *
 * `PaperProvider` publishes the theme, so every `Button`, `Chip`, `Divider`,
 * `Surface` and `ProgressBar` below it comes out in ompctl's palette, faces and
 * radii with nothing passed at the call site.
 *
 * `settings.icon` replaces Paper's icon renderer with ompctl's `Glyph`. That
 * matters for three separate reasons. Paper's default renderer expects
 * `react-native-vector-icons` and a linked Material Community font, which this
 * app deliberately does not ship: `icons.tsx` draws Font Awesome paths through
 * `react-native-svg` precisely because a webfont does not exist on a phone and
 * an out-of-tree platform will not link one. It also means an `IconButton` and
 * a hand-rolled ghost control render the SAME shape from the SAME family, so
 * the two can sit in one row. And it is what keeps a Material glyph -- a
 * different drawing language entirely -- from appearing anywhere.
 *
 * Paper asks for icons by name. The names it uses internally are Material
 * Community names, so anything it asks for that ompctl has no glyph for renders
 * nothing rather than a wrong picture: icons in this app are decorative without
 * exception (see `icons.tsx`) and a missing decoration is a smaller lie than a
 * borrowed one.
 */

import type { JSX, ReactNode } from "react";
import { useColorScheme } from "react-native";
import { PaperProvider } from "react-native-paper";
import type { IconProps } from "react-native-paper/lib/typescript/components/MaterialCommunityIcon";
import { GLYPHS, Glyph, type GlyphName } from "./icons.tsx";
import { type OmpTheme, ompDarkTheme, ompLightTheme } from "./theme.ts";

/**
 * Paper's icon slot, answered from ompctl's own family.
 *
 * `IconProps` also carries `direction` and `testID`, and neither is honoured on
 * purpose: `Glyph` draws an SVG path with no RTL mirroring, and these icons are
 * decorative without exception (see `icons.tsx`), so a testID here would offer a
 * handle to something assistive technology is told to skip.
 */
function paperIcon({ name, color, size }: IconProps): JSX.Element | null {
  if (typeof name !== "string" || !(name in GLYPHS)) return null;
  return <Glyph name={name as GlyphName} size={size} color={color} />;
}

export interface OmpThemeProviderProps {
  children: ReactNode;
  /**
   * Force a scheme. Unset in production, where the device decides; a test or a
   * render harness passes one so a frame is not at the mercy of the host's
   * appearance setting.
   */
  scheme?: "light" | "dark";
}

export function OmpThemeProvider({ children, scheme }: OmpThemeProviderProps): JSX.Element {
  const device = useColorScheme();
  const resolved = scheme ?? (device === "light" ? "light" : "dark");
  const theme = resolved === "light" ? ompLightTheme : ompDarkTheme;
  return (
    <PaperProvider theme={theme} settings={{ icon: paperIcon }}>
      {children}
    </PaperProvider>
  );
}

/**
 * Re-exported so a surface that needs the provider and the hook has one import.
 * The hook lives in `useOmpTheme.ts`, which carries no JSX, so a pure module can
 * read the theme without pulling the provider in behind it.
 */
export { useOmpTheme } from "./useOmpTheme.ts";
export type { OmpTheme };
