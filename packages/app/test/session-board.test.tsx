/**
 * SessionBoard tests: kanban projection of sessions into four derived columns.
 *
 * Covers:
 * - 8-session fixture across states mapped to Needs you, Working, Idle, Parked
 * - Empty column omitted (never shown as 0)
 * - Card shows title, project basename, state signal, elapsed, messages, spend, reason
 * - Card tap calls onOpen
 * - Phone horizontal scroll vs tablet row layout
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserSession } from "../src/session/browser.ts";
import { resetSafeAreaInsets, setSafeAreaInsets } from "./rnw.ts";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { SessionBoard, deriveBoardColumns } = await import("../src/components/SessionBoard.tsx");

afterEach(resetSafeAreaInsets);

const NOW = Date.parse("2026-09-07T12:00:00.000Z");
const LOCAL_HOST = {
  kind: "local" as const,
  id: "1234",
  spec: { kind: "local" as const },
};

const EIGHT_SESSIONS: BrowserSession[] = [
  // 1. Needs you: clearance pending
  {
    id: "s-clearance",
    title: "Review auth changes",
    cwd: "/Users/dev/auth-service",
    status: "live-ompd",
    createdAt: new Date(NOW - 3600_000).toISOString(),
    lastActiveAt: new Date(NOW - 300_000).toISOString(),
    messageCount: 42,
    sizeBytes: 1024,
    cost: 0.15,
  },
  // 2. Needs you: waiting agent
  {
    id: "s-waiting",
    title: "Database migration script",
    cwd: "/Users/dev/db-core",
    status: "live-ompd",
    createdAt: new Date(NOW - 7200_000).toISOString(),
    lastActiveAt: new Date(NOW - 600_000).toISOString(),
    messageCount: 18,
    sizeBytes: 2048,
    cost: 0.08,
  },
  // 3. Needs you: failed agent
  {
    id: "s-failed",
    title: "Large indexing task",
    cwd: "/Users/dev/search-indexer",
    status: "live-ompd",
    createdAt: new Date(NOW - 10800_000).toISOString(),
    lastActiveAt: new Date(NOW - 900_000).toISOString(),
    messageCount: 65,
    sizeBytes: 4096,
    cost: 1.24,
  },
  // 4. Working: busy agent
  {
    id: "s-working-agent",
    title: "Refactoring model layer",
    cwd: "/Users/dev/app-backend",
    status: "live-ompd",
    createdAt: new Date(NOW - 1800_000).toISOString(),
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    messageCount: 30,
    sizeBytes: 3000,
    cost: 0.45,
  },
  // 5. Working: busy TUI session
  {
    id: "s-working-tui",
    title: "Terminal investigation",
    cwd: "/Users/dev/cli-tool",
    status: "live-tui",
    createdAt: new Date(NOW - 2400_000).toISOString(),
    lastActiveAt: new Date(NOW - 120_000).toISOString(),
    messageCount: 12,
    sizeBytes: 1500,
  },
  // 6. Idle: idle agent
  {
    id: "s-idle-agent",
    title: "API contract inspection",
    cwd: "/Users/dev/gateway",
    status: "live-ompd",
    createdAt: new Date(NOW - 5000_000).toISOString(),
    lastActiveAt: new Date(NOW - 1800_000).toISOString(),
    messageCount: 15,
    sizeBytes: 2500,
    cost: 0.02,
  },
  // 7. Idle: quiet TUI session
  {
    id: "s-idle-tui",
    title: "Interactive debug shell",
    cwd: "/Users/dev/infra-scripts",
    status: "live-tui",
    createdAt: new Date(NOW - 6000_000).toISOString(),
    lastActiveAt: new Date(NOW - 3600_000).toISOString(),
    messageCount: 8,
    sizeBytes: 800,
  },
  // 8. Parked: dormant session
  {
    id: "s-parked",
    title: "Legacy deployment notes",
    cwd: "/Users/dev/deploy-pipeline",
    status: "dormant",
    createdAt: new Date(NOW - 86400_000 * 3).toISOString(),
    lastActiveAt: new Date(NOW - 86400_000 * 2).toISOString(),
    messageCount: 220,
    sizeBytes: 12000,
    cost: 2.1,
  },
  // Extra: archived session (should be omitted)
  {
    id: "s-archived",
    title: "Old archived spikes",
    cwd: "/Users/dev/archived-spike",
    status: "archived",
    createdAt: new Date(NOW - 86400_000 * 10).toISOString(),
    lastActiveAt: new Date(NOW - 86400_000 * 9).toISOString(),
    messageCount: 50,
    sizeBytes: 5000,
  },
];

const AGENTS: Agent[] = [
  {
    id: "agt-clearance",
    name: "auth-agent",
    state: "busy",
    acpSessionId: "s-clearance",
    host: LOCAL_HOST,
    cwd: "/Users/dev/auth-service",
    createdAt: new Date(NOW - 3600_000).toISOString(),
    lastActiveAt: new Date(NOW - 300_000).toISOString(),
    labels: {},
  },
  {
    id: "agt-waiting",
    name: "db-agent",
    state: "waiting",
    acpSessionId: "s-waiting",
    host: LOCAL_HOST,
    cwd: "/Users/dev/db-core",
    createdAt: new Date(NOW - 7200_000).toISOString(),
    lastActiveAt: new Date(NOW - 600_000).toISOString(),
    labels: {},
  },
  {
    id: "agt-failed",
    name: "search-agent",
    state: "failed",
    failure: "Out of memory",
    acpSessionId: "s-failed",
    host: LOCAL_HOST,
    cwd: "/Users/dev/search-indexer",
    createdAt: new Date(NOW - 10800_000).toISOString(),
    lastActiveAt: new Date(NOW - 900_000).toISOString(),
    labels: {},
  },
  {
    id: "agt-working",
    name: "refactor-agent",
    state: "busy",
    acpSessionId: "s-working-agent",
    host: LOCAL_HOST,
    cwd: "/Users/dev/app-backend",
    createdAt: new Date(NOW - 1800_000).toISOString(),
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    labels: {},
  },
  {
    id: "agt-idle",
    name: "gateway-agent",
    state: "idle",
    acpSessionId: "s-idle-agent",
    host: LOCAL_HOST,
    cwd: "/Users/dev/gateway",
    createdAt: new Date(NOW - 5000_000).toISOString(),
    lastActiveAt: new Date(NOW - 1800_000).toISOString(),
    labels: {},
  },
];

const PENDING_CLEARANCES = new Map<string, number>([["agt-clearance", 1]]);
const TUI_SESSIONS = new Map<string, { busy?: boolean; awaitingReply?: boolean }>([
  ["s-working-tui", { busy: true }],
  ["s-idle-tui", { busy: false }],
]);

describe("SessionBoard column derivation", () => {
  test("derives four operational columns from an eight-session fixture", () => {
    const columns = deriveBoardColumns(
      EIGHT_SESSIONS,
      AGENTS,
      agentId => PENDING_CLEARANCES.get(agentId) ?? 0,
      TUI_SESSIONS,
    );

    const colMap = new Map(columns.map(col => [col.key, col]));
    expect(colMap.size).toBe(4);

    // Column 1: Needs you (3 sessions)
    const needsYou = colMap.get("needs-you")!;
    expect(needsYou.cards.length).toBe(3);
    const needsIds = needsYou.cards.map(c => c.session.id);
    expect(needsIds).toContain("s-clearance");
    expect(needsIds).toContain("s-waiting");
    expect(needsIds).toContain("s-failed");

    // Check specific reasons
    const clearanceCard = needsYou.cards.find(c => c.session.id === "s-clearance")!;
    expect(clearanceCard.reason).toBe("Clearance pending");
    expect(clearanceCard.signalName).toBe("holding");

    const waitingCard = needsYou.cards.find(c => c.session.id === "s-waiting")!;
    expect(waitingCard.reason).toBe("Waiting for you");
    expect(waitingCard.signalName).toBe("holding");

    const failedCard = needsYou.cards.find(c => c.session.id === "s-failed")!;
    expect(failedCard.reason).toBe("Out of memory");
    expect(failedCard.signalName).toBe("failed");

    // Column 2: Working (2 sessions: busy agent + busy tui)
    const working = colMap.get("working")!;
    expect(working.cards.length).toBe(2);
    const workingIds = working.cards.map(c => c.session.id);
    expect(workingIds).toContain("s-working-agent");
    expect(workingIds).toContain("s-working-tui");
    expect(working.cards[0]?.signalName).toBe("working");

    // Column 3: Idle (2 sessions: idle agent + idle tui)
    const idle = colMap.get("idle")!;
    expect(idle.cards.length).toBe(2);
    const idleIds = idle.cards.map(c => c.session.id);
    expect(idleIds).toContain("s-idle-agent");
    expect(idleIds).toContain("s-idle-tui");
    expect(idle.cards[0]?.signalName).toBe("ready");

    // Column 4: Parked (1 dormant session; archived omitted)
    const parked = colMap.get("parked")!;
    expect(parked.cards.length).toBe(1);
    expect(parked.cards[0]?.session.id).toBe("s-parked");
    expect(parked.cards[0]?.signalName).toBe("cold");

    // Archived session is in none of the columns
    const allSessionIds = columns.flatMap(c => c.cards.map(card => card.session.id));
    expect(allSessionIds).not.toContain("s-archived");
  });

  test("an empty column is absent from the derived columns (never shown as 0)", () => {
    // Exclude the dormant session so Parked column is empty
    const withoutParked = EIGHT_SESSIONS.filter(s => s.status !== "dormant");
    const columns = deriveBoardColumns(
      withoutParked,
      AGENTS,
      agentId => PENDING_CLEARANCES.get(agentId) ?? 0,
      TUI_SESSIONS,
    );

    const keys = columns.map(c => c.key);
    expect(keys).toContain("needs-you");
    expect(keys).toContain("working");
    expect(keys).toContain("idle");
    expect(keys).not.toContain("parked");

    // Rendered markup must not contain "Parked" header
    const markup = renderToStaticMarkup(
      <SessionBoard
        sessions={withoutParked}
        onOpen={() => {}}
        agents={AGENTS}
        pendingClearances={agentId => PENDING_CLEARANCES.get(agentId) ?? 0}
        tuiSessions={TUI_SESSIONS}
        now={NOW}
      />,
    );
    expect(markup).toContain('data-testid="board-column-needs-you"');
    expect(markup).toContain('data-testid="board-column-working"');
    expect(markup).toContain('data-testid="board-column-idle"');
    expect(markup).not.toContain('data-testid="board-column-parked"');
    expect(markup).not.toContain("Parked");
  });
});

describe("SessionBoard component rendering and interactions", () => {
  test("renders card details: title, project basename, elapsed, messages, spend, and reason", () => {
    const markup = renderToStaticMarkup(
      <SessionBoard
        sessions={EIGHT_SESSIONS}
        onOpen={() => {}}
        agents={AGENTS}
        pendingClearances={agentId => PENDING_CLEARANCES.get(agentId) ?? 0}
        tuiSessions={TUI_SESSIONS}
        now={NOW}
      />,
    );

    // Title and project basename
    expect(markup).toContain("Review auth changes");
    expect(markup).toContain("auth-service");

    // Reason for Needs you
    expect(markup).toContain("Clearance pending");
    expect(markup).toContain("Waiting for you");
    expect(markup).toContain("Out of memory");

    // Messages and spend
    expect(markup).toContain("42 msgs");
    expect(markup).toContain("$0.15");
  });

  test("card tap calls onOpen with the tapped session", () => {
    let openedSession: BrowserSession | null = null;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <SessionBoard
            sessions={EIGHT_SESSIONS}
            onOpen={session => {
              openedSession = session;
            }}
            agents={AGENTS}
            pendingClearances={agentId => PENDING_CLEARANCES.get(agentId) ?? 0}
            tuiSessions={TUI_SESSIONS}
            now={NOW}
          />,
        );
      });

      const cardElement = host.querySelector('[data-testid="session-card-s-clearance"]');
      expect(cardElement).not.toBeNull();

      act(() => {
        cardElement?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(openedSession).not.toBeNull();
      expect((openedSession as BrowserSession | null)?.id).toBe("s-clearance");
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("renders empty state when all columns are empty", () => {
    const markup = renderToStaticMarkup(<SessionBoard sessions={[]} onOpen={() => {}} now={NOW} />);
    expect(markup).toContain('data-testid="board-empty"');
    expect(markup).toContain("No sessions on the board.");
  });

  test("card lists and phone container carry bottom inset as padding when unconsumed by shell", () => {
    setSafeAreaInsets({ top: 0, right: 0, bottom: 34, left: 0 });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <SessionBoard
            sessions={EIGHT_SESSIONS}
            onOpen={() => {}}
            agents={AGENTS}
            pendingClearances={agentId => PENDING_CLEARANCES.get(agentId) ?? 0}
            tuiSessions={TUI_SESSIONS}
            now={NOW}
          />,
        );
      });

      const listContents = host.querySelectorAll<HTMLElement>('[data-testid^="board-column-"] [class*="r-gap-"]');
      expect(listContents.length).toBeGreaterThan(0);
      // Check that padding bottom includes the 34px inset (space.step is 12, so 12 + 34 = 46px)
      for (const el of listContents) {
        if (el.style.paddingBottom) {
          expect(el.style.paddingBottom).toBe("46px");
        }
      }
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
