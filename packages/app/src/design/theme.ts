/**
 * ompctl's design system, expressed as a react-native-paper theme.
 *
 * ## Why Paper, and why it is not a Provider bolted on the side
 *
 * The app needed real components -- a button, a chip, a divider, a surface, a
 * progress bar -- and it needed one theming mechanism that five platforms read.
 * It had neither: every surface hand-rolled a `Pressable` with a `StyleSheet`
 * block, and the grid in `tokens.ts` was spent differently by each of them.
 *
 * Paper 5.15.3 is the smallest library that supplies both. It has three
 * dependencies, all pure JavaScript (`color`, `use-latest-callback`,
 * `@callstack/react-theme-provider`), no native module, no Babel plugin and no
 * compiler step, and its peers are `react`, `react-native` and
 * `react-native-safe-area-context` -- all three already in this app. That is
 * what makes it work on iOS, Android, macOS, Windows and react-native-web at
 * once: there is nothing in it that has to be ported to an out-of-tree
 * platform. The rejection matrix is in `docs/design-system.md`.
 *
 * The theme below is where the adoption is real. Paper's own components read
 * `colors`, `fonts` and `roundness` from here, so a `Button`, a `Chip` and a
 * `Divider` come out in ompctl's palette and faces without a wrapper, and the
 * extended keys (`rhythm`, `ground`, `ink`, `signal`, `space`, `radius`,
 * `stroke`, `control`) mean a surface reads ONE object for both the library's
 * vocabulary and ours.
 *
 * ## Nothing Material survives contact with this file
 *
 * MD3's defaults are a specific look and it is not ompctl's. Three things are
 * overridden on purpose and each one is the difference:
 *
 *  - **No elevation.** Every `Surface` in this app is `mode="flat"`
 *    `elevation={0}` and carries a hairline instead. MD3 signals hierarchy with
 *    a shadow; ompctl signals it with a step of warm graphite, which is why
 *    `ground` has six of them. The `elevation` colour ramp below is therefore
 *    the flat `ground` steps rather than tinted overlays, so a Paper component
 *    that reaches for `elevation.level2` still lands on our material.
 *  - **No Material purple, no Material blue.** `primary` is signal sage,
 *    because in this app a filled control means "this is the action that
 *    completes the turn" and sage is what that means everywhere else on screen.
 *  - **Faces, not weights.** Archivo and IBM Plex Mono are named by PostScript
 *    name and every variant carries `fontWeight: "normal"`, because naming a
 *    face and a numeric weight together makes Android synthesise a bold on top
 *    of a face that already is one. `tokens.ts` documents this; the MD3 type
 *    requires a weight, so it gets the one that means "leave it alone".
 */

import { configureFonts, MD3DarkTheme, MD3LightTheme } from "react-native-paper";
import type { MD3Type, MD3TypescaleKey } from "react-native-paper/lib/typescript/types";
import { rhythm } from "./rhythm.ts";
import {
  face,
  ground,
  ink,
  radius,
  signal,
  signalWash,
  space,
  stroke,
  TOUCH_TARGET,
  type as typeScale,
} from "./tokens.ts";

/**
 * One entry of ompctl's type scale, as an MD3 variant.
 *
 * `fontWeight: "normal"` on every one of them, always. See the file header.
 */
function variant(entry: { fontFamily: string; fontSize: number; lineHeight: number; letterSpacing?: number }): MD3Type {
  return {
    fontFamily: entry.fontFamily,
    fontSize: entry.fontSize,
    lineHeight: entry.lineHeight,
    letterSpacing: entry.letterSpacing ?? 0,
    fontWeight: "normal",
  };
}

/**
 * ompctl's scale mapped onto MD3's variant names.
 *
 * The mapping is by JOB, not by size, which is why it is not one-to-one:
 * `bodyLarge` and `bodyMedium` are both our body, because Paper reaches for
 * whichever suits the component and both must land on the same reading size.
 * `labelSmall` is our kicker; the tracking it carries assumes upper case, and
 * every consumer of it upper-cases.
 */
const TYPESCALE: Partial<Record<MD3TypescaleKey, MD3Type>> = {
  displayLarge: variant(typeScale.display),
  displayMedium: variant(typeScale.display),
  displaySmall: variant(typeScale.display),
  headlineLarge: variant(typeScale.display),
  headlineMedium: variant(typeScale.title),
  headlineSmall: variant(typeScale.title),
  titleLarge: variant(typeScale.title),
  titleMedium: variant(typeScale.title),
  titleSmall: variant(typeScale.data),
  bodyLarge: variant(typeScale.body),
  bodyMedium: variant(typeScale.body),
  bodySmall: variant(typeScale.code),
  labelLarge: variant(typeScale.label),
  labelMedium: variant(typeScale.label),
  labelSmall: variant(typeScale.kicker),
};

const fonts = configureFonts({ config: TYPESCALE });

/**
 * Control geometry, named by the job rather than by the number.
 *
 * `ghost` in `design/controls.ts` is the style; this is the measurement both it
 * and Paper's own components have to agree on, so an `IconButton` sitting next
 * to a hand-rolled ghost is the same height.
 */
const control = {
  /** Icon-only: a square target, so a row of them keeps an even rhythm. */
  icon: TOUCH_TARGET,
  /** Icon plus a word: as tall, only wider. */
  labelled: TOUCH_TARGET,
  /** The small round remove affordance on a chip, which is not a finger target. */
  chipRemove: 28,
  /** A thumbnail in an attachment chip. */
  thumb: 48,
} as const;

/** What every surface reads: Paper's own vocabulary plus ompctl's. */
const shared = {
  roundness: radius.control,
  fonts,
  rhythm,
  space,
  radius,
  stroke,
  control,
  signal,
  signalWash,
  face,
} as const;

/**
 * The dark theme, which is the app.
 *
 * ompctl is a tool an operator stares at for hours, and the ground is warm
 * graphite rather than the blue-black every component kit ships, for the reason
 * `tokens.ts` states: a cold ground under amber signals reads as a dashboard
 * warning light rather than as a working surface.
 */
export const ompDarkTheme = {
  ...MD3DarkTheme,
  ...shared,
  dark: true,
  ground,
  ink,
  colors: {
    ...MD3DarkTheme.colors,
    // The filled action. Sage means "ready, this is the one to press" on every
    // other surface in the app, so it means that here too.
    primary: signal.sage,
    onPrimary: ink.inverse,
    primaryContainer: signalWash.sage,
    onPrimaryContainer: signal.sage,
    // The quiet action beside it.
    secondary: ink.plain,
    onSecondary: ink.inverse,
    secondaryContainer: ground.active,
    onSecondaryContainer: ink.bright,
    // Reasoning, which is never the same weight as an answer.
    tertiary: signal.violet,
    onTertiary: ink.inverse,
    tertiaryContainer: signalWash.violet,
    onTertiaryContainer: signal.violet,
    background: ground.base,
    onBackground: ink.bright,
    surface: ground.surface,
    onSurface: ink.bright,
    surfaceVariant: ground.raised,
    onSurfaceVariant: ink.plain,
    surfaceDisabled: ground.active,
    onSurfaceDisabled: ink.faint,
    error: signal.oxide,
    onError: ink.inverse,
    errorContainer: signalWash.oxide,
    onErrorContainer: signal.oxide,
    outline: ground.edge,
    outlineVariant: ground.line,
    inverseSurface: ink.bright,
    inverseOnSurface: ground.base,
    inversePrimary: signal.sage,
    // Flat, on purpose. Paper reaches for these when a component wants depth;
    // in this app depth is a step of graphite, never a shadow.
    elevation: {
      level0: "transparent",
      level1: ground.surface,
      level2: ground.raised,
      level3: ground.raised,
      level4: ground.active,
      level5: ground.active,
    },
    shadow: "transparent",
    scrim: "#0A0908",
    backdrop: "rgba(10, 9, 8, 0.72)",
  },
} as const;

/**
 * The light theme.
 *
 * Warm paper rather than white, mirroring the dark ground's hue so the two are
 * the same material under different light. The signals do not change: amber
 * still means working, and an operator who learned the palette in the dark does
 * not relearn it in daylight. Only the two ramps invert.
 */
const lightGround = {
  base: "#F5F1E8",
  surface: "#EFEADE",
  raised: "#E7E1D2",
  active: "#DCD5C3",
  line: "#CFC7B2",
  edge: "#B8AE96",
} as const;

const lightInk = {
  bright: "#211E19",
  plain: "#4A443A",
  muted: "#6E6659",
  faint: "#928977",
  inverse: "#F5F1E8",
} as const;

export const ompLightTheme = {
  ...MD3LightTheme,
  ...shared,
  dark: false,
  ground: lightGround,
  ink: lightInk,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#5F7A4B",
    onPrimary: lightInk.inverse,
    primaryContainer: "#DDE5D0",
    onPrimaryContainer: "#3C5230",
    secondary: lightInk.plain,
    onSecondary: lightInk.inverse,
    secondaryContainer: lightGround.active,
    onSecondaryContainer: lightInk.bright,
    tertiary: "#5E4F94",
    onTertiary: lightInk.inverse,
    tertiaryContainer: "#E0DAF0",
    onTertiaryContainer: "#453A70",
    background: lightGround.base,
    onBackground: lightInk.bright,
    surface: lightGround.surface,
    onSurface: lightInk.bright,
    surfaceVariant: lightGround.raised,
    onSurfaceVariant: lightInk.plain,
    surfaceDisabled: lightGround.active,
    onSurfaceDisabled: lightInk.faint,
    error: "#8F3320",
    onError: lightInk.inverse,
    errorContainer: "#F2DCD6",
    onErrorContainer: "#8F3320",
    outline: lightGround.edge,
    outlineVariant: lightGround.line,
    inverseSurface: lightInk.bright,
    inverseOnSurface: lightGround.base,
    inversePrimary: "#8FA97B",
    elevation: {
      level0: "transparent",
      level1: lightGround.surface,
      level2: lightGround.raised,
      level3: lightGround.raised,
      level4: lightGround.active,
      level5: lightGround.active,
    },
    shadow: "transparent",
    scrim: "#211E19",
    backdrop: "rgba(33, 30, 25, 0.4)",
  },
} as const;

/**
 * The theme every surface sees.
 *
 * Typed off the dark theme rather than off Paper's `MD3Theme`, so the extended
 * keys are part of the type and a surface reading `theme.rhythm.gutter` is
 * checked rather than cast.
 */
export type OmpTheme = typeof ompDarkTheme;
