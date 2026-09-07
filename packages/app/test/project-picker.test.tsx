/**
 * ProjectPicker, rendered.
 *
 * Verifies that projects are sorted by most recent activity descending,
 * that rows present basename, dimmed full path, and session count,
 * that search filters the project list, and that selected projects
 * render with brand.azure.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserSession } from "../src/session/browser.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { ProjectPicker, summarizeProjects } = await import("../src/components/ProjectPicker.tsx");

function makeTestSession(id: string, cwd: string, lastActiveAt: string): BrowserSession {
  return {
    id,
    title: `Session ${id}`,
    cwd,
    status: "dormant",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt,
    messageCount: 5,
    sizeBytes: 1024,
  };
}

describe("project summarization and activity sorting", () => {
  test("projects are sorted by most recent activity descending", () => {
    const sessions: BrowserSession[] = [
      makeTestSession("s1", "/Users/op/dev/repo-older", "2026-02-10T10:00:00.000Z"),
      makeTestSession("s2", "/Users/op/dev/repo-newest", "2026-02-28T12:00:00.000Z"),
      makeTestSession("s3", "/Users/op/dev/repo-older", "2026-02-15T08:00:00.000Z"),
      makeTestSession("s4", "/Users/op/dev/repo-middle", "2026-02-20T00:00:00.000Z"),
    ];

    const summaries = summarizeProjects(sessions);

    expect(summaries.length).toBe(3);
    // repo-newest has latest activity (Feb 28)
    expect(summaries[0]?.basename).toBe("repo-newest");
    expect(summaries[0]?.sessionCount).toBe(1);

    // repo-middle has middle activity (Feb 20)
    expect(summaries[1]?.basename).toBe("repo-middle");
    expect(summaries[1]?.sessionCount).toBe(1);

    // repo-older has max activity Feb 15, with 2 sessions
    expect(summaries[2]?.basename).toBe("repo-older");
    expect(summaries[2]?.sessionCount).toBe(2);
    expect(summaries[2]?.lastActiveAt).toBe("2026-02-15T08:00:00.000Z");
  });
});

describe("project picker rendered surface", () => {
  const sessions: BrowserSession[] = [
    makeTestSession("s1", "/Users/op/dev/src/alpha", "2026-02-20T00:00:00.000Z"),
    makeTestSession("s2", "/Users/op/dev/src/beta", "2026-02-25T00:00:00.000Z"),
  ];

  test("trigger renders 'All projects' when no project selected", () => {
    const html = renderToStaticMarkup(
      <ProjectPicker sessions={sessions} selectedProject={null} onSelectProject={() => {}} />,
    );
    expect(html).toContain('data-testid="project-picker-trigger"');
    expect(html).toContain("All projects");
  });

  test("trigger renders single removable chip with brand.azure when project selected", () => {
    const html = renderToStaticMarkup(
      <ProjectPicker sessions={sessions} selectedProject="/Users/op/dev/src/beta" onSelectProject={() => {}} />,
    );
    expect(html).toContain('data-testid="project-chip-selected"');
    expect(html).toContain("beta");
    expect(html).toContain('data-testid="project-chip-clear"');
    // Azure token is used for selection
    expect(html).toContain("rgba(91,157,255,1");
  });

  test("tapping trigger opens picker with basename, full path, and session count", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(<ProjectPicker sessions={sessions} selectedProject={null} onSelectProject={() => {}} />);
      });

      // Initially closed: modal portal not mounted
      expect(document.querySelector('[data-testid="project-picker-search"]')).toBeNull();

      // Tap trigger to open
      const trigger = host.querySelector('[data-testid="project-picker-trigger"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      act(() => {
        trigger.click();
      });

      // Now open in portal
      expect(document.querySelector('[data-testid="project-picker-search"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="project-picker-item-all"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="project-picker-item-beta"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="project-picker-item-alpha"]')).not.toBeNull();

      // Basename and full path are both present
      const betaItem = document.querySelector('[data-testid="project-picker-item-beta"]');
      expect(betaItem?.textContent).toContain("beta");
      expect(betaItem?.textContent).toContain("/Users/op/dev/src/beta");
      expect(betaItem?.textContent).toContain("1 session");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("search query filters the project list in client DOM", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <ProjectPicker sessions={sessions} selectedProject={null} onSelectProject={() => {}} initialQuery="alp" />,
        );
      });

      // Open picker
      const trigger = host.querySelector('[data-testid="project-picker-trigger"]') as HTMLElement;
      act(() => {
        trigger.click();
      });

      // Alpha matches 'alp'
      expect(document.querySelector('[data-testid="project-picker-item-alpha"]')).not.toBeNull();
      // Beta does not match 'alp'
      expect(document.querySelector('[data-testid="project-picker-item-beta"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
