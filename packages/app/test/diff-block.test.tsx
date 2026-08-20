/**
 * The diff renderer's two promises.
 *
 * `isDiffText` is the guard that keeps a wrong guess cheap: when it says no,
 * the transcript keeps the ordinary code rendering, so the false cases below
 * are the ones that matter most. Every one of them is a block a phone
 * actually receives from an agent, a shell trace, a YAML fence, a checklist,
 * that merely happens to be full of leading `+` and `-` lines.
 *
 * `DiffBlock` must separate additions from removals by their leading sign,
 * not only by tone, because colour vision deficiencies take red-versus-green
 * with them and the sign glyph survives greyscale. And it must not lose or
 * clip a line: the contract in `rich/blocks.ts` is that this change can
 * improve a reply but never lose one.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// Dynamic on purpose, same reason as `terminal-session.test.tsx`: this module
// imports "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { DiffBlock, isDiffText } = await import("../src/components/rich/DiffBlock.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A real single-file git diff: one boundary, index, a ---/+++ pair, one hunk,
// two context lines, one removal, two additions, and a no-newline marker.
const GIT_DIFF = [
  "diff --git a/src/session/model.ts b/src/session/model.ts",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/session/model.ts",
  "+++ b/src/session/model.ts",
  "@@ -10,4 +10,5 @@ export function reduce(",
  " function reduce(state, action) {",
  "-  const next = { ...state };",
  "+  const next = structuredClone(state);",
  "+  next.touched = true;",
  "   return next;",
  "\\ No newline at end of file",
].join("\n");

// The headerless fragment an agent pastes after trimming: no hunk, no git
// furniture, just the ---/+++ pair and the change itself.
const FRAGMENT = [
  "--- a/pair-screen.test.tsx",
  "+++ b/pair-screen.test.tsx",
  "-expect(a).toBe(1);",
  "+expect(a).toBe(2);",
].join("\n");

function renderBlock(text: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<DiffBlock text={text} />);
  });
  return { host, root };
}

function count(host: HTMLElement, testID: string): number {
  return host.querySelectorAll(`[data-testid="${testID}"]`).length;
}

// ---------------------------------------------------------------------------
// Detection: what earns the diff rendering
// ---------------------------------------------------------------------------

describe("isDiffText accepts real diffs", () => {
  test("an explicit diff tag is honoured, in any case", () => {
    expect(isDiffText(GIT_DIFF, "diff")).toBe(true);
    expect(isDiffText(FRAGMENT, "Diff")).toBe(true);
    expect(isDiffText(GIT_DIFF, "patch")).toBe(true);
  });

  test("an untagged git diff is recognised by its grammar alone", () => {
    expect(isDiffText(GIT_DIFF, null)).toBe(true);
  });

  test("an untagged ---/+++ fragment with changed lines is recognised", () => {
    expect(isDiffText(FRAGMENT, null)).toBe(true);
  });

  test("diff structure earns the rendering even under an unrelated tag", () => {
    expect(isDiffText(GIT_DIFF, "ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detection: the refusals. A false positive mangles an ordinary code block,
// so these are the assertions this file exists to hold.
// ---------------------------------------------------------------------------

describe("isDiffText refuses blocks that merely look diff-ish", () => {
  test("a shell set -x trace, where every line starts with +", () => {
    const trace = ["+ mise exec bun install", "+ bun run check", "+ echo done"].join("\n");
    expect(isDiffText(trace, null)).toBe(false);
  });

  test("YAML front matter, whose --- fences are not file headers", () => {
    const yaml = ["---", "title: notes", "platform: ios", "---"].join("\n");
    expect(isDiffText(yaml, null)).toBe(false);
  });

  test("prose with a markdown rule and a bullet list", () => {
    const prose = ["What changed on the call:", "", "---", "", "- billing queue", "- porting queue"].join("\n");
    expect(isDiffText(prose, null)).toBe(false);
  });

  test("a flags list, all lines starting with --", () => {
    const flags = ["--verbose", "--help", "--version"].join("\n");
    expect(isDiffText(flags, null)).toBe(false);
  });

  test("a checklist of - and + items with a strong +/- majority and no markers", () => {
    const checklist = ["- buy milk", "+ call rick", "- ship the PR"].join("\n");
    expect(isDiffText(checklist, null)).toBe(false);
  });

  test("one hunk-shaped line quoted inside prose, with no change lines", () => {
    const quoted = ["The counter went", "@@ -1 +1 @@", "but nothing else changed"].join("\n");
    expect(isDiffText(quoted, null)).toBe(false);
  });

  test("empty content is not a diff even when the tag says so", () => {
    expect(isDiffText("", "diff")).toBe(false);
    expect(isDiffText("   ", "diff")).toBe(false);
  });

  test("ordinary TypeScript stays an ordinary code block", () => {
    const code = ["export function reduce(state: State): State {", "  return { ...state, touched: true };", "}"].join(
      "\n",
    );
    expect(isDiffText(code, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("DiffBlock renders a diff scannably", () => {
  test("every kind of line gets its own marker", () => {
    const { host, root } = renderBlock(GIT_DIFF);

    expect(count(host, "diff-block")).toBe(1);
    expect(count(host, "diff-boundary")).toBe(1);
    expect(count(host, "diff-file")).toBe(2);
    expect(count(host, "diff-meta")).toBe(2);
    expect(count(host, "diff-hunk")).toBe(1);
    expect(count(host, "diff-add")).toBe(2);
    expect(count(host, "diff-del")).toBe(1);
    expect(count(host, "diff-context")).toBe(2);

    act(() => root.unmount());
    host.remove();
  });

  test("an addition and a removal differ by their leading sign, not only by colour", () => {
    const { host, root } = renderBlock(GIT_DIFF);

    const adds = host.querySelectorAll('[data-testid="diff-add"]');
    const dels = host.querySelectorAll('[data-testid="diff-del"]');
    expect(adds.length).toBe(2);
    expect(dels.length).toBe(1);
    // The sign glyph is the first character of the row, which is exactly what
    // survives greyscale and colour vision deficiencies.
    for (const row of adds) {
      expect(row.textContent?.startsWith("+")).toBe(true);
    }
    for (const row of dels) {
      expect(row.textContent?.startsWith("-")).toBe(true);
    }

    act(() => root.unmount());
    host.remove();
  });

  test("hunk and file headers read as structure rather than content", () => {
    const { host, root } = renderBlock(GIT_DIFF);

    const hunk = host.querySelector('[data-testid="diff-hunk"]');
    expect(hunk?.textContent).toContain("@@ -10,4 +10,5 @@");
    expect(hunk?.textContent?.startsWith("+")).toBe(false);
    expect(hunk?.textContent?.startsWith("-")).toBe(false);

    const boundary = host.querySelector('[data-testid="diff-boundary"]');
    expect(boundary?.textContent).toContain("diff --git a/src/session/model.ts");

    act(() => root.unmount());
    host.remove();
  });

  test("no line of the diff is lost to the rendering", () => {
    const { host, root } = renderBlock(GIT_DIFF);

    const text = host.textContent ?? "";
    expect(text).toContain("const next = structuredClone(state);");
    expect(text).toContain("const next = { ...state };");
    expect(text).toContain("function reduce(state, action) {");
    expect(text).toContain("No newline at end of file");

    act(() => root.unmount());
    host.remove();
  });

  test("a long changed line wraps inside the block: every character survives", () => {
    const tail = "payload".repeat(60);
    const longDiff = ["--- a/long.log", "+++ b/long.log", "@@ -1 +1 @@", `-~${tail}`, `+~${tail}#end`].join("\n");

    const { host, root } = renderBlock(longDiff);

    const adds = host.querySelectorAll('[data-testid="diff-add"]');
    expect(adds.length).toBe(1);
    expect(adds[0]?.textContent).toContain(`~${tail}#end`);
    // Wrapped, not truncated or clipped: the full line is still the row's
    // text, and the sign still leads it.
    expect(adds[0]?.textContent?.startsWith("+")).toBe(true);
    expect(count(host, "diff-del")).toBe(1);

    act(() => root.unmount());
    host.remove();
  });

  test("a block tagged diff whose content is not a diff degrades to plain rows", () => {
    const { host, root } = renderBlock("just some words\nand more words\n");

    // The trailing fence newline is not a row, and every real line renders.
    expect(count(host, "diff-context")).toBe(2);
    expect(count(host, "diff-add")).toBe(0);
    expect(count(host, "diff-del")).toBe(0);
    expect(host.textContent).toContain("just some words");
    expect(host.textContent).toContain("and more words");

    act(() => root.unmount());
    host.remove();
  });
});
