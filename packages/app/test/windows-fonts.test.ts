import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { PlatformFontSelector } from "../src/design/tokens.ts";

// Dynamic import is required so rnw.ts stubs react-native before tokens.ts evaluates.
const { font, resolveFontTokens } = await import("../src/design/tokens.ts");

describe("font tokens on non-Windows platforms", () => {
  test("every font face has a PostScript fontFamily and no fontWeight", () => {
    expect(font.regular).toEqual({ fontFamily: "Archivo-Regular" });
    expect(font.medium).toEqual({ fontFamily: "Archivo-Medium" });
    expect(font.semibold).toEqual({ fontFamily: "Archivo-SemiBold" });
    expect(font.mono).toEqual({ fontFamily: "IBMPlexMono-Regular" });
    expect(font.monoMedium).toEqual({ fontFamily: "IBMPlexMono-Medium" });
    expect(font.symbols).toEqual({ fontFamily: "SymbolsNF" });

    for (const [, faceStyle] of Object.entries(font)) {
      expect(faceStyle.fontFamily).toBeString();
      expect(faceStyle.fontWeight).toBeUndefined();
    }
  });
});

describe("font tokens on Windows platform", () => {
  test("with Platform.OS = windows, symbols is Symbols Nerd Font and faces carry DirectWrite WWS families and weights", () => {
    const windowsPlatform: PlatformFontSelector = {
      select: <T>(obj: { windows?: T; default: T }): T => obj.windows ?? obj.default,
    };
    const windowsFont = resolveFontTokens(windowsPlatform);

    expect(windowsFont.symbols).toEqual({ fontFamily: "Symbols Nerd Font" });
    expect(windowsFont.symbols.fontFamily).toBe("Symbols Nerd Font");
    expect(windowsFont.symbols.fontWeight).toBeUndefined();

    expect(windowsFont.regular).toEqual({ fontFamily: "Archivo", fontWeight: "400" });
    expect(windowsFont.medium).toEqual({ fontFamily: "Archivo", fontWeight: "500" });
    expect(windowsFont.semibold).toEqual({ fontFamily: "Archivo", fontWeight: "600" });
    expect(windowsFont.mono).toEqual({ fontFamily: "IBM Plex Mono", fontWeight: "400" });
    expect(windowsFont.monoMedium).toEqual({ fontFamily: "IBM Plex Mono Medium", fontWeight: "500" });
  });
});
