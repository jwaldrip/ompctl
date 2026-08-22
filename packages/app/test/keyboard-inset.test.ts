/**
 * The keyboard must never be the reason a control is unreachable.
 *
 * This is a class gate rather than a screen test. `KeyboardAvoidingView` was
 * used on both composer screens and is inert on an iPad: the send control's
 * frame is identical with the keyboard up and down, so the control sits behind
 * the keyboard and neither a person nor an automated run can press it. That was
 * found on real hardware, fixed on one screen, and still present on the other,
 * which is exactly the shape of defect that comes back one screen at a time.
 *
 * So two things are pinned here: the rule for what to pay below a bottom
 * anchored control, and the absence of the construct that does not work.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// Dynamic on purpose, the same reason the screen tests do it: this module
// imports "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { bottomInsetFor } = await import("../src/design/useKeyboardInset.ts");

describe("what sits below a bottom-anchored control", () => {
  test("a raised keyboard is paid instead of the home indicator, never both", () => {
    // Paying both would leave a gap the height of the indicator, because a
    // raised keyboard already covers that inset.
    expect(bottomInsetFor(346, 24)).toBe(346);
  });

  test("with no keyboard the home indicator is paid", () => {
    expect(bottomInsetFor(0, 24)).toBe(24);
  });

  test("a device with neither pays nothing", () => {
    expect(bottomInsetFor(0, 0)).toBe(0);
  });
});

describe("the construct that does not work is gone", () => {
  test("no app source reaches for KeyboardAvoidingView", async () => {
    const offenders: string[] = [];
    // Usage, not mentions: a comment explaining why the construct is gone is
    // worth keeping, and would otherwise trip its own gate.
    const used = /<KeyboardAvoidingView|KeyboardAvoidingView[^"']*\}\s*from\s*["']react-native["']/;
    for await (const file of new Glob("src/**/*.{ts,tsx}").scan({ cwd: `${import.meta.dir}/..` })) {
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
      if (used.test(source)) offenders.push(file);
    }
    // Use `useKeyboardInset` and `bottomInsetFor` instead: they measure what the
    // platform reports and pay it as padding, which is what actually moves a
    // control out from under the keyboard.
    expect(offenders).toEqual([]);
  });
});

describe("the inset below a composer is owned, not borrowed from the screen", () => {
  test("every payer of a bottom inset asks the shell mechanism, not the raw screen insets", async () => {
    // A screen nested in a shell that already paid reads the same raw
    // insets as the shell did, so paying them again is the double count
    // that floated the tablet's composer an inset above the list beside
    // it. `useOwnedBottomInset` is the one read that knows what an
    // ancestor already paid, so it is the only value a payer may pass.
    const offenders: string[] = [];
    for await (const file of new Glob("src/**/*.{ts,tsx}").scan({ cwd: `${import.meta.dir}/..` })) {
      // The definition file names the function, it does not call it.
      if (file === "src/design/useKeyboardInset.ts") continue;
      const source = await Bun.file(`${import.meta.dir}/../${file}`).text();
      if (!source.includes("bottomInsetFor(")) continue;
      if (source.includes("useSafeAreaInsets") || !source.includes("useOwnedBottomInset")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
