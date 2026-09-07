/**
 * Theme colour mappings for code fence token kinds.
 *
 * Maps Prism token kinds to design tokens so syntax-highlighted code
 * matches the app's visual hierarchy and palette.
 */

import * as tokens from "../../design/tokens.ts";
import { ink, signal } from "../../design/tokens.ts";

function extractBrandAzure(): string | undefined {
  if (typeof tokens === "object" && tokens !== null && "brand" in tokens) {
    const brandObj = tokens.brand;
    if (typeof brandObj === "object" && brandObj !== null && "azure" in brandObj) {
      const val = brandObj.azure;
      if (typeof val === "string") return val;
    }
  }
  return undefined;
}

function extractBrandAmber(): string | undefined {
  if (typeof tokens === "object" && tokens !== null && "brand" in tokens) {
    const brandObj = tokens.brand;
    if (typeof brandObj === "object" && brandObj !== null && "amber" in brandObj) {
      const val = brandObj.amber;
      if (typeof val === "string") return val;
    }
  }
  return undefined;
}

function extractInkPrimary(): string {
  if (typeof ink === "object" && ink !== null && "primary" in ink) {
    const inkObj = ink as Record<string, unknown>;
    const val = inkObj.primary;
    if (typeof val === "string") return val;
  }
  return ink.plain;
}

// Brand tokens (azure, amber) will be added by the theme slice.
// At this base, brand is not yet exported, so we fall back to signal tokens:
// keywords fall back to signal.violet (or brand.azure when available),
// numbers fall back to signal.amber (or brand.amber when available),
// and default text falls back to ink.plain (or ink.primary when available).
export const KEYWORD_COLOR = extractBrandAzure() ?? signal.violet;
export const STRING_COLOR = signal.sage;
export const NUMBER_COLOR = extractBrandAmber() ?? signal.amber;
export const COMMENT_COLOR = ink.faint;
export const PUNCTUATION_COLOR = ink.muted;
export const DEFAULT_COLOR = extractInkPrimary();

export const TOKEN_COLORS: Record<string, string> = {
  // Keywords and declarations
  keyword: KEYWORD_COLOR,
  boolean: KEYWORD_COLOR,
  builtin: KEYWORD_COLOR,
  tag: KEYWORD_COLOR,
  selector: KEYWORD_COLOR,
  "class-name": KEYWORD_COLOR,
  function: KEYWORD_COLOR,
  title: KEYWORD_COLOR,

  // Strings and values
  string: STRING_COLOR,
  char: STRING_COLOR,
  "attr-value": STRING_COLOR,
  regex: STRING_COLOR,
  url: STRING_COLOR,
  "inserted-sign": STRING_COLOR,
  inserted: STRING_COLOR,

  // Numbers and constants
  number: NUMBER_COLOR,
  constant: NUMBER_COLOR,

  // Comments
  comment: COMMENT_COLOR,
  prolog: COMMENT_COLOR,
  doctype: COMMENT_COLOR,
  cdata: COMMENT_COLOR,

  // Punctuation and operators
  punctuation: PUNCTUATION_COLOR,
  operator: PUNCTUATION_COLOR,

  // Diff deletions
  "deleted-sign": signal.oxide,
  deleted: signal.oxide,

  // Default
  plain: DEFAULT_COLOR,
};

/**
 * Returns the theme colour for a token kind.
 * Unknown or unmapped kinds fall back to the default ink colour.
 */
export function tokenColor(kind: string): string {
  return TOKEN_COLORS[kind] ?? DEFAULT_COLOR;
}
