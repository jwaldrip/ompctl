import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  attributionWidthCompact,
  attributionWidthTablet,
  CHROME_BUDGET_COMPACT,
  CHROME_COMPOSER_HEIGHT_COMPACT,
  CHROME_HEADER_HEIGHT_COMPACT,
  CHROME_READOUT_HEIGHT_COMPACT,
  CHROME_STRIP_SUMMARY_HEIGHT,
} from "../src/design/rhythm.ts";
import type { Entry, SessionState } from "../src/session/model.ts";
import { EMPTY_SESSION } from "../src/session/model.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic on purpose: rnw.ts mocks must be installed before SessionScreen
// imports react-native.
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT: Agent = {
  id: "agt_compact_test",
  name: "compact companion",
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/Users/operator/work/repo",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  labels: {},
};

function sampleSession(): SessionState {
  const entries: Entry[] = [
    {
      id: "msg_u1",
      kind: "user",
      text: "hello compact world",
    },
    {
      id: "msg_a1",
      rowId: "row_a1",
      kind: "assistant",
      text: "analyzing options",
      thought: true,
      streaming: false,
    },
    {
      id: "msg_a2",
      rowId: "row_a2",
      kind: "assistant",
      text: "all set to proceed",
      thought: false,
      streaming: false,
    },
  ];
  return {
    ...EMPTY_SESSION,
    entries,
    usage: {
      used: 42000,
      size: 200000,
      costAmount: 0.12,
      costCurrency: "USD",
    },
    plan: [
      { content: "Build layout", priority: "high", status: "completed" },
      { content: "Run verification", priority: "medium", status: "in_progress" },
    ],
  };
}

describe("compact chrome on phone vs tablet", () => {
  test("compact render at 390x844 shows no narration band, closed strip, single readout row, no notice body text, and glyph-only gutter", () => {
    setWindowSize(390, 844);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <SessionScreen
            agent={AGENT}
            session={sampleSession()}
            load={{ phase: "ready", generation: 0, error: null }}
            context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
            connection="connected"
            attempt={0}
            voice={{
              access: "unknown",
              mic: { available: false, reason: "Voice input is unavailable on web: no module." },
              speech: { available: false, reason: "no playback in this test" },
              dictation: null,
              capturing: false,
              busyElsewhere: false,
              onToggle: () => {},
            }}
            canApprove
            spoken={null}
            fleetClearances={0}
            onBack={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            onDecide={() => {}}
            onDecidePlan={() => {}}
          />,
        );
      });

      // 1. No narration band
      expect(host.querySelector('[data-testid="session-narration"]')).toBeNull();

      // 2. Closed session strip by default (summary row present, body absent)
      expect(host.querySelector('[data-testid="session-context"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="session-context-summary"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="session-context-body"]')).toBeNull();

      // 3. Single readout row
      expect(host.querySelector('[data-testid="status-readout"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="status-link"]')?.textContent).toContain("linked");
      expect(host.querySelector('[data-testid="status-context"]')?.textContent).toBe("42k/200k");
      expect(host.querySelector('[data-testid="status-spend"]')?.textContent).toContain("$0.12");

      // 4. No capability notice body text in resting composer
      expect(host.querySelector('[data-testid="composer-attach-status"]')).toBeNull();
      expect(host.querySelector('[data-testid="composer-mic-status"]')).toBeNull();

      // The attach and mic glyphs carry the sentence as their accessibilityLabel
      const attachButton = host.querySelector('[data-testid="composer-attach"]') as HTMLButtonElement | null;
      expect(attachButton).not.toBeNull();
      expect(attachButton?.getAttribute("aria-label")).toContain("Image attachments are unavailable");

      const micButton = host.querySelector('[data-testid="composer-mic"]') as HTMLButtonElement | null;
      expect(micButton).not.toBeNull();
      expect(micButton?.getAttribute("aria-label")).toContain("Voice input is unavailable");

      // Pressing disabled attach toggles the transient inline notice row
      act(() => {
        const left = host.querySelector('[data-testid="composer-actions-left"]') as HTMLElement | null;
        left?.click();
      });
      const attachStatus = host.querySelector('[data-testid="composer-attach-status"]');
      expect(attachStatus).not.toBeNull();
      expect(attachStatus?.textContent).toContain("Image attachments are unavailable");

      // Dismissing notice closes it
      const dismissButton = host.querySelector('[data-testid="composer-notice-dismiss"]') as HTMLButtonElement | null;
      expect(dismissButton).not.toBeNull();
      act(() => {
        dismissButton?.click();
      });
      expect(host.querySelector('[data-testid="composer-attach-status"]')).toBeNull();

      // 5. Glyph-only gutter in transcript entries
      const userEntry = host.querySelector('[data-testid="entry-user"]');
      expect(userEntry).not.toBeNull();
      const userGutter = userEntry?.firstElementChild as HTMLElement | null;
      expect(userGutter).not.toBeNull();
      expect(userGutter?.getAttribute("aria-label")).toBe("you");
      // Does not contain kicker text node
      expect(userGutter?.textContent).toBe("");

      const assistantEntry = host.querySelectorAll('[data-testid="entry-assistant"]');
      expect(assistantEntry.length).toBe(2);
      const thoughtGutter = assistantEntry[0]?.firstElementChild as HTMLElement | null;
      expect(thoughtGutter?.getAttribute("aria-label")).toBe("thinking");
      expect(thoughtGutter?.textContent).toBe("");

      const replyGutter = assistantEntry[1]?.firstElementChild as HTMLElement | null;
      expect(replyGutter?.getAttribute("aria-label")).toBe("agent");
      expect(replyGutter?.textContent).toBe("");

      // 6. Header: single-line title and state, back, and path/elapsed muted line
      expect(host.querySelector('[data-testid="session-head"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="session-back"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="session-name"]')?.textContent).toBe("compact companion");
      expect(host.querySelector('[data-testid="session-state"]')?.textContent).toBe("idle");
    } finally {
      act(() => root.unmount());
      host.remove();
      resetWindowSize();
    }
  });

  test("tablet render at 820x1180 keeps narration band, open strip, labelled two-row readout, and word gutter", () => {
    setWindowSize(820, 1180);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <SessionScreen
            agent={AGENT}
            session={sampleSession()}
            load={{ phase: "ready", generation: 0, error: null }}
            context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
            connection="connected"
            attempt={0}
            voice={{
              access: "unknown",
              mic: { available: false, reason: "Voice input is unavailable on web: no module." },
              speech: { available: false, reason: "no playback in this test" },
              dictation: null,
              capturing: false,
              busyElsewhere: false,
              onToggle: () => {},
            }}
            canApprove
            spoken={null}
            fleetClearances={0}
            onBack={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            onDecide={() => {}}
            onDecidePlan={() => {}}
          />,
        );
      });

      // Tablet keeps the narration band
      expect(host.querySelector('[data-testid="session-narration"]')).not.toBeNull();

      // Tablet keeps the open session strip
      expect(host.querySelector('[data-testid="session-context-body"]')).not.toBeNull();

      // Tablet keeps labelled readout meters (e.g. labels for context and spend)
      const readout = host.querySelector('[data-testid="status-readout"]');
      expect(readout).not.toBeNull();
      expect(readout?.textContent).toContain("context");
      expect(readout?.textContent).toContain("spend");

      // Tablet keeps the word in attribution gutters
      const userEntry = host.querySelector('[data-testid="entry-user"]');
      const userGutter = userEntry?.firstElementChild as HTMLElement | null;
      expect(userGutter?.textContent).toContain("you");

      const assistantEntries = host.querySelectorAll('[data-testid="entry-assistant"]');
      expect(assistantEntries[0]?.firstElementChild?.textContent).toContain("thinking");
      expect(assistantEntries[1]?.firstElementChild?.textContent).toContain("agent");
    } finally {
      act(() => root.unmount());
      host.remove();
      resetWindowSize();
    }
  });

  test("chrome height budget constants total under 200 px at 390 px width", () => {
    expect(attributionWidthCompact).toBe(28);
    expect(attributionWidthTablet).toBe(72);

    expect(CHROME_HEADER_HEIGHT_COMPACT).toBe(48);
    expect(CHROME_STRIP_SUMMARY_HEIGHT).toBe(36);
    expect(CHROME_READOUT_HEIGHT_COMPACT).toBe(32);
    expect(CHROME_COMPOSER_HEIGHT_COMPACT).toBe(70);

    const sum =
      CHROME_HEADER_HEIGHT_COMPACT +
      CHROME_STRIP_SUMMARY_HEIGHT +
      CHROME_READOUT_HEIGHT_COMPACT +
      CHROME_COMPOSER_HEIGHT_COMPACT;
    expect(sum).toBe(186);
    expect(CHROME_BUDGET_COMPACT).toBe(186);
    expect(CHROME_BUDGET_COMPACT).toBeLessThan(200);

    // Transcript keeps at least 60% of an 844 px screen
    const screenHeight = 844;
    const remainingForTranscript = screenHeight - CHROME_BUDGET_COMPACT;
    const transcriptFraction = remainingForTranscript / screenHeight;
    expect(transcriptFraction).toBeGreaterThanOrEqual(0.6);
  });
});
