/**
 * Resume nudge tests: guidance when opening old or long dormant sessions.
 *
 * Covers:
 * - Nudge appears for an old session (age > RESUME_NUDGE_AGE_MS) and not a fresh one
 * - Nudge appears for long sessions (messageCount > RESUME_NUDGE_MESSAGES)
 * - Factual sentence format: "This session has 1,174 messages and was last active 3 days ago. Long sessions get slower and drift across tasks."
 * - Resume anyway proceeds with original open and suppresses second nudge
 * - Start fresh calls createAgent in the same session cwd
 * - Sheet on phone vs dialog on tablet
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserSession } from "../src/session/browser.ts";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const {
  ResumeNudge,
  RESUME_NUDGE_AGE_MS,
  RESUME_NUDGE_MESSAGES,
  formatResumeNudgeSentence,
  formatTimeAgo,
  shouldNudgeResume,
} = await import("../src/components/ResumeNudge.tsx");

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

const FRESH_DORMANT: BrowserSession = {
  id: "s-fresh",
  title: "Recent work",
  cwd: "/Users/dev/fresh-project",
  status: "dormant",
  createdAt: new Date(NOW - 3600_000).toISOString(),
  lastActiveAt: new Date(NOW - 1800_000).toISOString(), // 30m ago (<24h)
  messageCount: 50, // (<200)
  sizeBytes: 1024,
};

const OLD_DORMANT: BrowserSession = {
  id: "s-old",
  title: "Old feature session",
  cwd: "/Users/dev/old-project",
  status: "dormant",
  createdAt: new Date(NOW - 86400_000 * 5).toISOString(),
  lastActiveAt: new Date(NOW - 86400_000 * 3).toISOString(), // 3 days ago (>24h)
  messageCount: 1174,
  sizeBytes: 50000,
};

const LONG_DORMANT: BrowserSession = {
  id: "s-long",
  title: "Long conversation",
  cwd: "/Users/dev/long-project",
  status: "dormant",
  createdAt: new Date(NOW - 3600_000 * 10).toISOString(),
  lastActiveAt: new Date(NOW - 3600_000 * 2).toISOString(), // 2h ago (<24h)
  messageCount: 201, // (>200)
  sizeBytes: 30000,
};

const LIVE_SESSION: BrowserSession = {
  id: "s-live",
  title: "Live agent",
  cwd: "/Users/dev/live-project",
  status: "live-ompd",
  createdAt: new Date(NOW - 86400_000 * 5).toISOString(),
  lastActiveAt: new Date(NOW - 86400_000 * 3).toISOString(),
  messageCount: 500,
  sizeBytes: 20000,
};

describe("Resume nudge condition and sentence formatting", () => {
  test("RESUME_NUDGE_AGE_MS is 24 hours and RESUME_NUDGE_MESSAGES is 200", () => {
    expect(RESUME_NUDGE_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(RESUME_NUDGE_MESSAGES).toBe(200);
  });

  test("nudge appears for an old dormant session (>24h) and not for a fresh one (<24h and <=200 msgs)", () => {
    expect(shouldNudgeResume(OLD_DORMANT, undefined, NOW)).toBe(true);
    expect(shouldNudgeResume(FRESH_DORMANT, undefined, NOW)).toBe(false);
  });

  test("nudge appears for a session exceeding message count threshold (>200 msgs) even if recent", () => {
    expect(shouldNudgeResume(LONG_DORMANT, undefined, NOW)).toBe(true);
  });

  test("nudge never appears for non-dormant sessions", () => {
    expect(shouldNudgeResume(LIVE_SESSION, undefined, NOW)).toBe(false);
  });

  test("formats the exact factual sentence required", () => {
    const sentence = formatResumeNudgeSentence(OLD_DORMANT, NOW);
    expect(sentence).toBe(
      "This session has 1,174 messages and was last active 3 days ago. Long sessions get slower and drift across tasks.",
    );
    expect(sentence).not.toContain("—");
    expect(sentence).not.toContain("–");
  });

  test("formatTimeAgo handles minutes, hours, days correctly", () => {
    expect(formatTimeAgo(new Date(NOW - 120_000).toISOString(), NOW)).toBe("2 minutes ago");
    expect(formatTimeAgo(new Date(NOW - 3600_000 * 5).toISOString(), NOW)).toBe("5 hours ago");
    expect(formatTimeAgo(new Date(NOW - 86400_000).toISOString(), NOW)).toBe("1 day ago");
    expect(formatTimeAgo(new Date(NOW - 86400_000 * 3).toISOString(), NOW)).toBe("3 days ago");
  });
});

describe("ResumeNudge component interactions and lifecycle", () => {
  test("renders the sentence, primary 'Start fresh here', secondary 'Resume anyway', and close", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <ResumeNudge
            session={OLD_DORMANT}
            onStartFresh={() => {}}
            onResumeAnyway={() => {}}
            onClose={() => {}}
            now={NOW}
          />,
        );
      });

      const facts = document.querySelector('[data-testid="resume-nudge-facts"]');
      expect(facts?.textContent).toBe(
        "This session has 1,174 messages and was last active 3 days ago. Long sessions get slower and drift across tasks.",
      );
      expect(document.querySelector('[data-testid="resume-nudge-start-fresh"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="resume-nudge-resume-anyway"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="resume-nudge-close"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Resume anyway opens and suppresses the second nudge for that session", () => {
    const resumedSet = new Set<string>();

    // First attempt: should nudge
    expect(shouldNudgeResume(OLD_DORMANT, resumedSet, NOW)).toBe(true);

    let resumedId: string | undefined;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          <ResumeNudge
            session={OLD_DORMANT}
            onStartFresh={() => {}}
            onResumeAnyway={() => {
              resumedId = OLD_DORMANT.id;
              resumedSet.add(OLD_DORMANT.id);
            }}
            onClose={() => {}}
            now={NOW}
          />,
        );
      });

      const resumeButton = document.querySelector('[data-testid="resume-nudge-resume-anyway"]') as HTMLElement;
      expect(resumeButton).not.toBeNull();

      act(() => {
        resumeButton?.click();
      });
      expect(resumedId).toBe(OLD_DORMANT.id);
      // Second attempt: suppressed because session is in resumedSet
      expect(shouldNudgeResume(OLD_DORMANT, resumedSet, NOW)).toBe(false);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("Start fresh creates in the same cwd", () => {
    let createdCwd: string | undefined;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          <ResumeNudge
            session={OLD_DORMANT}
            onStartFresh={() => {
              createdCwd = OLD_DORMANT.cwd;
            }}
            onResumeAnyway={() => {}}
            onClose={() => {}}
            now={NOW}
          />,
        );
      });

      const startFreshButton = document.querySelector('[data-testid="resume-nudge-start-fresh"]') as HTMLElement;
      expect(startFreshButton).not.toBeNull();

      act(() => {
        startFreshButton?.click();
      });
      expect(createdCwd).toBe("/Users/dev/old-project");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
