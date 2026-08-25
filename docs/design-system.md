# ompctl's design system

## The report this answers

"Spacing looks off." That is the whole brief, and it was right.

The app already had a good vocabulary. `design/tokens.ts` holds a warm-graphite
palette where every hue means something, a seven-step type scale named by job,
and a four-point spacing grid. None of that was the problem.

The problem was that the grid had no **mapping from job to step**. Each surface
picked its own step for the same job, so the app shipped several different
screen gutters that nearly lined up, several vertical rhythms, and a transcript
attribution column 76 points wide with a 12 point gap beside it — 88 of a
390 point phone, 22% of the width, spent on the word "agent" before any of the
conversation. A grid is not a system until each job on it has exactly one
answer.

Secondly, there were no components. Every button, chip, card and divider in the
app was a hand-rolled `Pressable` plus a local `StyleSheet` block, which is why
the same control had a different height on three screens.

## The library: react-native-paper 5.15.3

Chosen for being the **smallest maintained option that ships real production
components AND a theme all five targets can read**.

| | version | published | weekly downloads | runtime deps | peers | toolchain |
|---|---|---|---|---|---|---|
| **react-native-paper** | **5.15.3** | 2026-05-26 | 437,722 | **3**, all pure JS (`color`, `use-latest-callback`, `@callstack/react-theme-provider`) | `react`, `react-native`, `react-native-safe-area-context` — all three already here | none |
| tamagui | 2.7.7 | 2026-08-15 | 238,670 | 63 | `react >=19` | Babel/Vite optimizing compiler, own `createTamagui` config |
| @gluestack-ui/core | 5.0.15 | 2026-06-25 | 96,371 | 30 (`@react-aria/*`, `@react-stately/*`) | requires **`react-native-svg >=12`** and `react-native-web >=0.19` | nativewind + tailwind + Babel plugin + CSS interop |
| @shopify/restyle | 2.4.5 | 2025-03-19 | 105,801 | 0 | `react`, `react-native` | none |

### Why each of the other three lost

**@shopify/restyle** is the closest call and it loses on the brief, not on
quality. It is 92 KB with zero dependencies and it would have supplied the
spacing and typography system beautifully. But it ships `createBox`,
`createText`, `createTheme` and `createRestyleComponent` — **primitives, not
components**. There is no button, no chip, no divider, no card, no progress bar.
Adopting it would have left every one of this app's hand-rolled controls exactly
where it was, which is half the defect. It is also 17 months since its last
release.

**tamagui** is a larger system than the problem. 63 runtime packages, and its
value proposition is an optimizing compiler that needs a Babel or Vite plugin in
a build that already runs Metro for four platforms and Vite for the fifth. Its
peer range (`react >=19`) says nothing about `react-native`, and the out-of-tree
platforms are where that silence costs: macOS 0.81.9 and Windows 0.81.30 are not
targets it tests. Adopting it means betting the two laggiest platforms on a
compiler.

**@gluestack-ui** fails on a hard requirement rather than on taste. Its peers
**require `react-native-svg`**, which is a native module, and the v2/v3 line is
nativewind-based, which adds tailwind, a Babel plugin and a CSS interop layer.
This app does depend on `react-native-svg` already (for `Glyph`), but making a
whole component library's correctness depend on native SVG plus a CSS
transpiler, on macOS and Windows, is a materially larger bet than Paper's three
pure-JavaScript packages. The v1 line (`@gluestack-ui/themed` 1.1.73) last
published 2025-04-08 and is effectively parked.

### Why Paper survives all five targets

There is nothing in it to port. Three pure-JavaScript dependencies, no native
module, no Babel plugin, no compiler, no font to link. Its peers are `react`,
`react-native` and `react-native-safe-area-context`, and this app already
depends on all three — so adopting it added **one** line to
`packages/app/package.json`, pinned literally at `5.15.3` with no caret because
its peer on `react` is `*` and a caret buys nothing but drift.

No second React copy: Paper declares `react` as a peer and has no `react`
dependency of its own, so it resolves to the app's single pinned 19.1.4 (which
`scripts/check-assistant-deps.ts` already enforces).

## The theme, which is where adoption is real

A Provider alone would not be adoption. `design/theme.ts` builds a full MD3
theme so Paper's own `Button`, `Chip`, `Divider`, `Surface` and `ProgressBar`
come out in ompctl's palette, faces and radii **with nothing passed at the call
site**, and extends it with ompctl's own vocabulary (`rhythm`, `space`,
`radius`, `stroke`, `control`, `signal`, `ground`, `ink`) so a surface reads one
object for both. `useOmpTheme()` types those extended keys, which is why
`theme.rhythm.gutter` is a checked read rather than a cast.

### Nothing Material survives it

Three overrides, and each one is the difference between this app and a Material
app:

- **Elevation is off everywhere.** Every `Surface` is `mode="flat"`
  `elevation={0}` with a hairline. MD3 signals hierarchy with a shadow; ompctl
  signals it with a step of warm graphite, which is why `ground` has six steps.
  The theme's `elevation` ramp is therefore the flat `ground` steps and `shadow`
  is `transparent`, so a Paper component reaching for `elevation.level2` still
  lands on our material.
- **`primary` is signal sage, not Material purple.** A filled control in this
  app means "this is the action that completes the turn", and sage means that
  everywhere else on screen.
- **The icon slot is ompctl's `Glyph`.** `PaperProvider`'s `settings.icon`
  renders Font Awesome paths through `react-native-svg`, so no Material glyph
  and no linked icon font can appear, and an `IconButton` sits in a row beside a
  hand-rolled control drawing from the same family. A name Paper asks for that
  ompctl has no glyph for renders nothing rather than a borrowed picture; icons
  here are decorative without exception, so a missing decoration is a smaller
  lie than a wrong one.
- **Faces, not weights.** Every MD3 variant carries `fontWeight: "normal"`,
  because naming a face and a numeric weight together makes Android synthesise
  a bold on top of a face that already is one.

Light and dark are both defined. Dark is the app; light is warm paper mirroring
the dark ground's hue, and the signals do not change between them — an operator
who learned that amber means working does not relearn it in daylight.

## `design/rhythm.ts`: the spacing fix

The grid stays in `tokens.ts`. `rhythm` names **jobs**, and every value is a
member of that grid:

| token | value | job |
|---|---|---|
| `gutter` | 16 | screen edge to content. One value, every screen, every platform |
| `rowGap` | 12 | between consecutive rows of the same kind |
| `rowGapTight` | 8 | between a row and something belonging to it |
| `sectionGap` | 24 | between genuinely different sections |
| `cardPad` | 12 | inside a card, edge to content |
| `cardGap` | 8 | between stacked elements in one card |
| `cardStack` | 8 | between two cards in a run |
| `attribution` | 64 | the transcript's speaker column (was 76) |
| `indent` | 24 | one step of nesting |
| `paneGutter` | 16 | between split panes |
| `minTarget` | 44 | smallest finger target |
| `dockPad` | 8 | composer surface to safe-area edge |

`cardPad` is deliberately a step tighter than `gutter`: a card already sits
inside a gutter, and paying it twice is what made the tool cards look padded
out rather than dense.

`attribution` at 64 clears the widest word the column holds ("thinking" at
`type.kicker`, about 56 points) and hands 24 points back to every line of prose
on a phone.

`rhythm` is a different concern from `design/layout.ts`, which answers how many
panes fit on a screen. This one is the air between things once they are on it.

## Rules that outlive this change

1. A surface asks for a **job** (`rhythm.gutter`), never a step (`space.wide`).
   A number that maps to no job is a defect to name, not a token to invent.
2. `Surface` is always `mode="flat"` `elevation={0}`.
3. A wrapper that only renames a Paper component is forbidden. Use the component
   at the call site.
4. Icons are `Glyph`. Never an emoji, anywhere, for anything.
5. Nothing pressable is under 44 points, and no container whose content is text
   carries a fixed `height` — `minHeight` only, so dynamic type does not clip.
6. Tests assert the rendered style against a `rhythm` token, never a source
   string. A test that greps a file for a number cannot see a rule that is
   written and never applied.

## What Paper did not take over

assistant-ui remains the conversation runtime. `ThreadPrimitive`,
`ComposerPrimitive`, the external-store runtime and `messageRowId` are
untouched: Paper supplies pixels, assistant-ui supplies the conversation. The
one emphasis control stays `ComposerPrimitive.Send` / `.Cancel` because the
runtime drives which of the two exists, and that is load-bearing and tested.

The terminal viewer stays a custom surface for the reason `assistant-ui-migration.md`
§8 gives, but it now reads this same theme and the same `rhythm`, so the two
surfaces cannot drift into two conventions.
