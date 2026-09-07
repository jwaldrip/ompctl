/**
 * WCAG 2.x contrast ratios for the app palette.
 *
 * Every foreground type token must have sufficient contrast against every ground
 * step it sits on. Signals and brand tokens used for text or icons must meet
 * WCAG AA contrast (>= 4.5:1) against ground.base and ground.raised.
 */

import { describe, expect, test } from "bun:test";
import { brand, ground, ink, signal } from "../src/design/tokens.ts";

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

export function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("WCAG 2.x contrast ratios for palette tokens", () => {
  const groundSurfaces = {
    base: ground.base,
    surface: ground.surface,
    raised: ground.raised,
  };

  test("ink tokens meet >= 4.5:1 on active reading surfaces", () => {
    // bright, plain, muted are primary reading text, secondary prose, and metadata
    for (const [inkName, inkHex] of Object.entries({
      bright: ink.bright,
      plain: ink.plain,
      muted: ink.muted,
    })) {
      for (const [groundName, groundHex] of Object.entries(groundSurfaces)) {
        const ratio = contrastRatio(inkHex, groundHex);
        expect(
          ratio,
          `ink.${inkName} (${inkHex}) on ground.${groundName} (${groundHex}) has ratio ${ratio.toFixed(2)}, expected >= 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }

    // faint is used on base and surface (and raised for secondary cues)
    for (const [groundName, groundHex] of Object.entries(groundSurfaces)) {
      const ratio = contrastRatio(ink.faint, groundHex);
      expect(
        ratio,
        `ink.faint (${ink.faint}) on ground.${groundName} (${groundHex}) has ratio ${ratio.toFixed(2)}, expected >= 4.5`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("signals meet >= 4.5:1 as text on ground.base and ground.raised", () => {
    for (const [sigName, sigHex] of Object.entries(signal)) {
      for (const [groundName, groundHex] of Object.entries({
        base: ground.base,
        raised: ground.raised,
      })) {
        const ratio = contrastRatio(sigHex, groundHex);
        expect(
          ratio,
          `signal.${sigName} (${sigHex}) on ground.${groundName} (${groundHex}) has ratio ${ratio.toFixed(2)}, expected >= 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("brand tokens meet >= 4.5:1 as text on ground.base and ground.raised", () => {
    expect(brand).toBeDefined();
    for (const [brandName, brandHex] of Object.entries(brand)) {
      for (const [groundName, groundHex] of Object.entries({
        base: ground.base,
        raised: ground.raised,
      })) {
        const ratio = contrastRatio(brandHex, groundHex);
        expect(
          ratio,
          `brand.${brandName} (${brandHex}) on ground.${groundName} (${groundHex}) has ratio ${ratio.toFixed(2)}, expected >= 4.5`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("ink.faint on ground.raised meets at least 3.0:1 for non-text UI components", () => {
    const ratio = contrastRatio(ink.faint, ground.raised);
    expect(
      ratio,
      `ink.faint (${ink.faint}) on ground.raised (${ground.raised}) has ratio ${ratio.toFixed(2)}, expected >= 3.0`,
    ).toBeGreaterThanOrEqual(3.0);
  });

  test("ink.inverse on primary button fills meets >= 4.5:1", () => {
    const fills = {
      "brand.azure": brand.azure,
      "brand.amber": brand.amber,
      "signal.ready": signal.ready,
    };
    for (const [fillName, fillHex] of Object.entries(fills)) {
      const ratio = contrastRatio(ink.inverse, fillHex);
      expect(
        ratio,
        `ink.inverse (${ink.inverse}) on ${fillName} (${fillHex}) has ratio ${ratio.toFixed(2)}, expected >= 4.5`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
