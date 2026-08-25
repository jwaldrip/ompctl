/**
 * Typographic primitives.
 *
 * React Native has one `Text` and no notion of a heading, so a scale that lives
 * only in `StyleSheet` calls scattered across twenty components is a scale that
 * drifts within a week. These components are the scale: a surface says what a
 * line of text is for, and the ramp is applied once, here.
 *
 * Colour is a prop rather than a variant because the same role appears in
 * several signal colours: an agent's name is a title whether it is running or
 * has failed, and only its state colour changes.
 */

import type { JSX, ReactNode } from "react";
import type { StyleProp, TextStyle } from "react-native";
import { Text, useWindowDimensions } from "react-native";
import { ink, type } from "./tokens.ts";

interface LineProps {
  children: ReactNode;
  color?: string;
  style?: StyleProp<TextStyle>;
  /** RN Text's own prop, surfaced for values an operator must lift verbatim. */
  selectable?: boolean;
  numberOfLines?: number;
  /** Marks a line as a heading for assistive technology on every platform. */
  heading?: boolean;
  testID?: string;
}

/**
 * One entry of the ramp, with its line box and its tracking scaled to match the
 * glyphs.
 *
 * React Native scales `fontSize` for the operator's text-size setting and scales
 * NOTHING ELSE. `tokens.ts` pairs every size with an absolute `lineHeight` and an
 * absolute `letterSpacing`, so at any setting above the default the glyphs grew
 * inside a line box that did not: at extra-extra-extra-large -- the largest
 * ORDINARY size, not an accessibility one -- an 11 point kicker draws about 14.7
 * points of glyph in a 14 point box and loses its descenders, while its advance
 * grows and its tracking stays put so the word outruns its container.
 *
 * Measured on an iPhone 17 simulator at that setting, before this: IDLE rendered
 * as "IDLI", SESSION as "SESSIO", LINKED as "LINKE", context as "conte:", spend
 * as "spen". On an iPad Pro 13-inch at the same setting, with six hundred points
 * of pane to spare: STOPPED as "STOPPE", TODOS as "TODO", a 1/1 count chip as
 * "1..", and descenders sliced off two full sentences. Room was never the
 * problem, which is what makes it the line box rather than a flex bug.
 *
 * Scaling both here is the whole fix, and it belongs here for the reason this
 * file exists: the ramp is applied in exactly one place, so it is correctable in
 * exactly one place. At `fontScale` 1 every value is unchanged, so nothing at the
 * default size moves and no existing measurement shifts.
 */
function scaled(entry: TextStyle, fontScale: number): TextStyle {
  if (!Number.isFinite(fontScale) || fontScale === 1) return entry;
  const line = entry.lineHeight === undefined ? undefined : entry.lineHeight * fontScale;
  const tracking = entry.letterSpacing === undefined ? undefined : entry.letterSpacing * fontScale;
  return { ...entry, lineHeight: line, letterSpacing: tracking };
}

/**
 * The operator's text-size setting, as the multiplier the ramp needs. Read per
 * component rather than threaded through props, because every one of these is a
 * leaf and a prop would make the correction opt-in.
 */
function useTextScale(): number {
  return useWindowDimensions().fontScale;
}

/** Section kickers. Always upper case, because the tracking assumes it. */
export function Kicker({ children, color = ink.muted, style, testID }: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text testID={testID} style={[scaled(type.kicker, fontScale), { color, textTransform: "uppercase" }, style]}>
      {children}
    </Text>
  );
}

export function Label({ children, color = ink.plain, style, numberOfLines, testID }: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[scaled(type.label, fontScale), { color }, style]}>
      {children}
    </Text>
  );
}

export function Body({ children, color = ink.bright, style, numberOfLines, testID }: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[scaled(type.body, fontScale), { color }, style]}>
      {children}
    </Text>
  );
}

export function Title({ children, color = ink.bright, style, numberOfLines, heading, testID }: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text
      testID={testID}
      accessibilityRole={heading === true ? "header" : undefined}
      numberOfLines={numberOfLines}
      style={[scaled(type.title, fontScale), { color }, style]}
    >
      {children}
    </Text>
  );
}

export function Display({ children, color = ink.bright, style, heading, testID }: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text
      testID={testID}
      accessibilityRole={heading === true ? "header" : undefined}
      style={[scaled(type.display, fontScale), { color }, style]}
    >
      {children}
    </Text>
  );
}

/** A number a person compares against another number. Monospaced, always. */
export function Data({ children, color = ink.bright, style, numberOfLines, testID }: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text testID={testID} numberOfLines={numberOfLines} style={[scaled(type.data, fontScale), { color }, style]}>
      {children}
    </Text>
  );
}

/** Command output and paths, where column alignment carries meaning. */
export function Code({
  children,
  color = ink.plain,
  style,
  numberOfLines,
  selectable,
  testID,
}: LineProps): JSX.Element {
  const fontScale = useTextScale();
  return (
    <Text
      testID={testID}
      numberOfLines={numberOfLines}
      selectable={selectable}
      style={[scaled(type.code, fontScale), { color }, style]}
    >
      {children}
    </Text>
  );
}
