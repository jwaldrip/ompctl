/**
 * Local observability dashboard and per-session usage aggregation.
 *
 * Imports the stats aggregator from `@oh-my-pi/omp-stats`, synchronizing
 * session transcripts into SQLite under the shared sync file lock.
 */

import { existsSync } from "node:fs";
import {
  getDashboardStats as ompGetDashboardStats,
  syncAllSessions,
  withStatsSyncLock,
} from "@oh-my-pi/omp-stats/aggregator";
import { getSessionsDir, getStatsDbPath } from "@oh-my-pi/pi-utils";
import type { DashboardStats, SessionStats } from "@ompd/core/contracts";
import { findSessionFile, setSessionCost } from "../sessions/scanner.ts";

export { syncAllSessions, withStatsSyncLock };

/**
 * Cadence for periodic stats database reconciliation.
 * Five minutes balances fresh aggregate metrics with disk and SQLite I/O,
 * ensuring background/TUI activity appears without flooding writes.
 */
export const STATS_SYNC_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compute per-session stats from JSONL transcript lines according to the batch contract:
 * sums usage across assistant lines, calculates cache rate as cacheRead / (input + cacheRead),
 * and counts calls and errors.
 */
export function computeSessionStatsFromTranscript(lines: string[]): SessionStats {
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let calls = 0;
  let errors = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: {
      type?: unknown;
      message?: {
        role?: unknown;
        stopReason?: unknown;
        errorMessage?: unknown;
        usage?: {
          input?: unknown;
          output?: unknown;
          cacheRead?: unknown;
          cacheWrite?: unknown;
          cost?: {
            total?: unknown;
            input?: unknown;
            output?: unknown;
            cacheRead?: unknown;
            cacheWrite?: unknown;
          };
        };
      };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "message") continue;
    const msg = parsed.message;
    if (msg?.role !== "assistant") continue;

    calls++;
    if (msg.stopReason === "error" || (typeof msg.errorMessage === "string" && msg.errorMessage.length > 0)) {
      errors++;
    }

    const usage = msg.usage;
    if (usage && typeof usage === "object") {
      if (typeof usage.input === "number" && !Number.isNaN(usage.input)) input += usage.input;
      if (typeof usage.output === "number" && !Number.isNaN(usage.output)) output += usage.output;
      if (typeof usage.cacheRead === "number" && !Number.isNaN(usage.cacheRead)) cacheRead += usage.cacheRead;
      if (typeof usage.cacheWrite === "number" && !Number.isNaN(usage.cacheWrite)) cacheWrite += usage.cacheWrite;

      if (typeof usage.cost?.total === "number" && !Number.isNaN(usage.cost.total)) {
        cost += usage.cost.total;
      } else if (usage.cost && typeof usage.cost === "object") {
        const c = usage.cost;
        const sum =
          (typeof c.input === "number" ? c.input : 0) +
          (typeof c.output === "number" ? c.output : 0) +
          (typeof c.cacheRead === "number" ? c.cacheRead : 0) +
          (typeof c.cacheWrite === "number" ? c.cacheWrite : 0);
        if (sum > 0) cost += sum;
      }
    }
  }

  const denominator = input + cacheRead;
  const cacheRate = denominator > 0 ? cacheRead / denominator : 0;

  return {
    cost: Math.round(cost * 1_000_000) / 1_000_000,
    tokens: {
      input,
      output,
      cacheRead,
      cacheWrite,
    },
    cacheRate,
    calls,
    errors,
  };
}
export async function computeSessionStatsFromFile(filePath: string): Promise<SessionStats> {
  const file = Bun.file(filePath);
  const text = await file.text();
  return computeSessionStatsFromTranscript(text.split("\n"));
}

export interface StatsSubsystemOptions {
  sessionsRoot?: string;
  statsDbPath?: string;
}

export class StatsSubsystem {
  #sessionsRoot?: string;
  #statsDbPath: string;
  #syncInFlight: Promise<void> | null = null;
  #timer: Timer | null = null;

  constructor(opts: StatsSubsystemOptions = {}) {
    this.#sessionsRoot = opts.sessionsRoot ?? getSessionsDir();
    this.#statsDbPath = opts.statsDbPath ?? getStatsDbPath();
  }

  start(): void {
    void this.sync().catch(() => {});
    this.#timer = setInterval(() => {
      void this.sync().catch(() => {});
    }, STATS_SYNC_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async sync(): Promise<void> {
    if (this.#syncInFlight) return this.#syncInFlight;
    const task = withStatsSyncLock(this.#statsDbPath, async () => {
      await syncAllSessions();
    })
      .catch(() => {})
      .finally(() => {
        if (this.#syncInFlight === task) this.#syncInFlight = null;
      });
    this.#syncInFlight = task;
    return task;
  }

  async getDashboardStats(range?: string | null): Promise<DashboardStats> {
    return (await ompGetDashboardStats(range)) as DashboardStats;
  }

  async getSessionStats(sessionId: string): Promise<SessionStats | null> {
    const filePath = findSessionFile(sessionId, this.#sessionsRoot);
    if (!filePath || !existsSync(filePath)) return null;
    const stats = await computeSessionStatsFromFile(filePath);
    setSessionCost(sessionId, stats.cost);
    return stats;
  }
}
