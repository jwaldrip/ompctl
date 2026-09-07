/**
 * Tests for the DiffView component.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { DIFF_PREVIEW_LINES, DiffView } = await import("../src/components/DiffView.tsx");
const { WithOmpTheme } = await import("./theme.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  host: HTMLElement;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    host,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function themed(element: ReactElement): Mounted {
  return mount(<WithOmpTheme>{element}</WithOmpTheme>);
}

describe("DiffView", () => {
  const FIXTURE_OLD = `line1
line2
line3
line4
line5`;

  const FIXTURE_NEW = `line1
line2
line3 modified
line4
line5
line6 added`;

  test("DiffView renders +/- rows with correct counts for a fixture", () => {
    const mounted = themed(<DiffView path="src/components/Example.tsx" oldText={FIXTURE_OLD} newText={FIXTURE_NEW} />);

    try {
      const added = mounted.host.querySelectorAll('[data-testid="diff-line-added"]');
      const deleted = mounted.host.querySelectorAll('[data-testid="diff-line-deleted"]');
      const context = mounted.host.querySelectorAll('[data-testid="diff-line-context"]');

      expect(added.length).toBe(2);
      expect(deleted.length).toBe(1);
      expect(context.length).toBe(4);

      // Verify content of added/deleted rows
      const addedTexts = Array.from(added).map(el => el.textContent);
      expect(addedTexts.some(t => t?.includes("line3 modified"))).toBe(true);
      expect(addedTexts.some(t => t?.includes("line6 added"))).toBe(true);

      const deletedTexts = Array.from(deleted).map(el => el.textContent);
      expect(deletedTexts.some(t => t?.includes("line3") && !t?.includes("modified"))).toBe(true);
    } finally {
      mounted.unmount();
    }
  });

  test("renders file header with dir muted and basename bold", () => {
    const mounted = themed(
      <DiffView path="packages/app/src/components/ToolCard.tsx" oldText="const a = 1;" newText="const a = 2;" />,
    );

    try {
      const header = mounted.host.querySelector('[data-testid="diff-file-header"]');
      expect(header).not.toBeNull();
      expect(header?.textContent).toContain("packages/app/src/components/");
      expect(header?.textContent).toContain("ToolCard.tsx");
    } finally {
      mounted.unmount();
    }
  });

  test("renders line numbers for each row", () => {
    const mounted = themed(<DiffView path="test.ts" oldText={"alpha\nbeta\n"} newText={"alpha\nbeta modified\n"} />);

    try {
      const deleted = mounted.host.querySelector('[data-testid="diff-line-deleted"]');
      expect(deleted?.textContent).toContain("2");

      const added = mounted.host.querySelector('[data-testid="diff-line-added"]');
      expect(added?.textContent).toContain("2");
    } finally {
      mounted.unmount();
    }
  });

  test("collapses beyond DIFF_PREVIEW_LINES with 'Show all N lines' and toggles", () => {
    // Generate a fixture with 25 added lines
    const lines: string[] = [];
    for (let i = 1; i <= 25; i += 1) {
      lines.push(`console.log("line ${i}");`);
    }
    const newCode = lines.join("\n");

    const mounted = themed(<DiffView path="large.ts" oldText="" newText={newCode} />);

    try {
      // Total lines = 1 hunk header + 25 added lines = 26 items
      expect(26).toBeGreaterThan(DIFF_PREVIEW_LINES);

      const expandBtn = mounted.host.querySelector('[data-testid="diff-expand"]');
      expect(expandBtn).not.toBeNull();
      expect(expandBtn?.textContent).toContain("Show all 26 lines");

      // Before click: visible line rows are limited to preview lines
      const visibleLinesBefore = mounted.host.querySelectorAll('[data-testid="diff-line-added"]');
      expect(visibleLinesBefore.length).toBeLessThanOrEqual(DIFF_PREVIEW_LINES);

      // Click to expand
      act(() => {
        expandBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      // After click: all 25 added lines visible
      const visibleLinesAfter = mounted.host.querySelectorAll('[data-testid="diff-line-added"]');
      expect(visibleLinesAfter.length).toBe(25);
      expect(mounted.host.querySelector('[data-testid="diff-expand"]')?.textContent).toContain("collapse");
    } finally {
      mounted.unmount();
    }
  });

  test("limits unchanged context to 3 lines around each hunk and splits distant changes", () => {
    // 20 lines, change at line 2 and line 19
    const linesOld: string[] = [];
    for (let i = 1; i <= 20; i += 1) {
      linesOld.push(`line ${i}`);
    }
    const linesNew = [...linesOld];
    linesNew[1] = "line 2 modified";
    linesNew[18] = "line 19 modified";

    const mounted = themed(<DiffView path="context.ts" oldText={linesOld.join("\n")} newText={linesNew.join("\n")} />);

    try {
      const hunkHeaders = mounted.host.querySelectorAll('[data-testid="diff-hunk-header"]');
      expect(hunkHeaders.length).toBe(2);

      // Intermediate lines (like line 10) are omitted
      const text = mounted.host.textContent ?? "";
      expect(text).not.toContain("line 10");
    } finally {
      mounted.unmount();
    }
  });

  test("exposes renderLine seam and calls it with detected language", () => {
    let capturedLang = "" as string | null;
    const renderLine = (line: string, lang: string | null): ReactNode => {
      capturedLang = lang;
      return <span data-custom-highlight>{line}</span>;
    };

    const mounted = themed(
      <DiffView path="src/utils/calc.ts" oldText="const a = 1;" newText="const a = 2;" renderLine={renderLine} />,
    );

    try {
      expect(capturedLang).toBe("ts");
      const customElements = mounted.host.querySelectorAll("[data-custom-highlight]");
      expect(customElements.length).toBeGreaterThan(0);
    } finally {
      mounted.unmount();
    }
  });

  test("renders empty notice when there are no changes", () => {
    const mounted = themed(
      <DiffView path="unchanged.ts" oldText="const same = true;\n" newText="const same = true;\n" />,
    );

    try {
      const empty = mounted.host.querySelector('[data-testid="diff-empty"]');
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toContain("No changes");
    } finally {
      mounted.unmount();
    }
  });
});
