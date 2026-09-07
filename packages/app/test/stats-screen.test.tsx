import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { DashboardStats } from "@ompd/core/contracts";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

const { StatsScreen } = await import("../src/screens/StatsScreen.tsx");
const { StatusReadout } = await import("../src/components/StatusReadout.tsx");

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

function byTestID(host: Element, testID: string): Element {
  const found = host.querySelector(`[data-testid="${testID}"]`);
  if (!found) throw new Error(`no element with data-testid="${testID}"`);
  return found;
}

const fixtureStats: DashboardStats = {
  overall: {
    totalRequests: 42,
    successfulRequests: 40,
    failedRequests: 2,
    errorRate: 0.0476,
    totalInputTokens: 100_000,
    totalOutputTokens: 25_000,
    totalCacheReadTokens: 50_000,
    totalCacheWriteTokens: 5_000,
    cacheRate: 0.3333,
    totalCost: 1.42,
    totalPremiumRequests: 0,
    avgDuration: 1200,
    avgTtft: 450,
    avgTokensPerSecond: 25,
    firstTimestamp: 1700000000000,
    lastTimestamp: 1700086400000,
  },
  byModel: [
    {
      model: "claude-3-7-sonnet",
      provider: "anthropic",
      totalRequests: 30,
      successfulRequests: 29,
      failedRequests: 1,
      errorRate: 0.033,
      totalInputTokens: 80_000,
      totalOutputTokens: 20_000,
      totalCacheReadTokens: 40_000,
      totalCacheWriteTokens: 4_000,
      cacheRate: 0.333,
      totalCost: 1.2,
      totalPremiumRequests: 0,
      avgDuration: 1100,
      avgTtft: 400,
      avgTokensPerSecond: 28,
      firstTimestamp: 1700000000000,
      lastTimestamp: 1700086400000,
    },
  ],
  byFolder: [],
  byAgentType: [],
  timeSeries: [],
  modelSeries: [],
  modelPerformanceSeries: [],
  costSeries: [
    {
      timestamp: Date.parse("2026-08-11T12:00:00.000Z"),
      model: "claude-3-7-sonnet",
      provider: "anthropic",
      cost: 0.85,
      costInput: 0.5,
      costOutput: 0.35,
      costCacheRead: 0,
      costCacheWrite: 0,
    },
    {
      timestamp: Date.parse("2026-08-12T12:00:00.000Z"),
      model: "claude-3-7-sonnet",
      provider: "anthropic",
      cost: 0.57,
      costInput: 0.3,
      costOutput: 0.27,
      costCacheRead: 0,
      costCacheWrite: 0,
    },
  ],
};

describe("StatsScreen", () => {
  test("renders overview from fixture DashboardStats", () => {
    let backed = false;
    const mounted = mount(
      <StatsScreen
        stats={fixtureStats}
        onBack={() => {
          backed = true;
        }}
      />,
    );
    try {
      expect(byTestID(mounted.host, "stats-screen")).toBeDefined();

      // Overview values
      const tokens = byTestID(mounted.host, "stats-overview-tokens");
      expect(tokens.textContent).toContain("125k"); // 100k in + 25k out

      const cost = byTestID(mounted.host, "stats-overview-cost");
      expect(cost.textContent).toContain("$1.42");

      const cache = byTestID(mounted.host, "stats-overview-cache");
      expect(cache.textContent).toContain("33.3%");

      const errors = byTestID(mounted.host, "stats-overview-errors");
      expect(errors.textContent).toContain("4.8%");

      const latency = byTestID(mounted.host, "stats-overview-latency");
      expect(latency.textContent).toContain("1.2s");

      const ttft = byTestID(mounted.host, "stats-overview-ttft");
      expect(ttft.textContent).toContain("450ms");

      // Models table
      const models = byTestID(mounted.host, "stats-models");
      expect(models.textContent).toContain("claude-3-7-sonnet");
      expect(models.textContent).toContain("anthropic");
      expect(models.textContent).toContain("$1.20");

      // Cost by day
      const costByDay = byTestID(mounted.host, "stats-cost-by-day");
      expect(costByDay.textContent).toContain("2026-08-12");
      expect(costByDay.textContent).toContain("$0.57");
      expect(costByDay.textContent).toContain("2026-08-11");
      expect(costByDay.textContent).toContain("$0.85");

      // Back button
      const back = byTestID(mounted.host, "stats-back");
      act(() => {
        (back as HTMLElement).click();
      });
      expect(backed).toBe(true);
    } finally {
      mounted.unmount();
    }
  });

  test("StatusReadout shows one cost reading and 'not reported' when null", () => {
    // When usage is present with cost
    const withCost = mount(
      <StatusReadout
        state="connected"
        attempt={0}
        usage={{ used: 10_000, size: 200_000, costAmount: 0.42, costCurrency: "USD" }}
        clearances={0}
      />,
    );
    try {
      const spend = byTestID(withCost.host, "status-spend");
      expect(spend.textContent).toContain("$0.42");
    } finally {
      withCost.unmount();
    }

    // When usage is null
    const noCost = mount(<StatusReadout state="connected" attempt={0} usage={null} clearances={0} />);
    try {
      const spend = byTestID(noCost.host, "status-spend");
      expect(spend.textContent).toContain("not reported");
    } finally {
      noCost.unmount();
    }
  });
});
