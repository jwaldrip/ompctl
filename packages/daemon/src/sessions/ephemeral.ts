/**
 * Ephemeral session detection for archiving suggestions.
 *
 * Identifies dormant, low-interaction, clutter sessions (e.g. 0-2 messages)
 * that have not been touched recently and produced no durable artifacts,
 * while strictly sparing live sessions, sessions with deliverables, and fresh
 * work in progress.
 *
 * Crucial invariant: this module only produces suggestions for the operator to
 * review. It never archives or mutates sessions by itself.
 */

import { readdir } from "node:fs/promises";
import type { SessionSummary } from "@ompd/core";
import { subagentDirFor } from "./subagents.ts";

export interface EphemeralCriteria {
  /** Maximum message count to consider ephemeral. Default: 2 (i.e. messageCount < 3). */
  maxMessages?: number;
  /** Minimum age in milliseconds to consider ephemeral (spares freshly started sessions). Default: 1 hour. */
  minAgeMs?: number;
  /** Maximum byte size to consider ephemeral. Default: 100 KB. */
  maxBytes?: number;
  /** Reference timestamp for age calculation. Default: Date.now(). */
  now?: number;
}

export const DEFAULT_EPHEMERAL_MAX_MESSAGES = 2;
export const DEFAULT_EPHEMERAL_MIN_AGE_MS = 60 * 60 * 1000; // 1 hour
export const DEFAULT_EPHEMERAL_MAX_BYTES = 100 * 1024; // 100 KB

/**
 * Check whether a session's artifact directory holds any subagent markdown report (<Name>.md).
 * A session that produced a subagent report delivered work and must not be considered clutter.
 */
export async function hasSubagentReport(sessionFilePath: string): Promise<boolean> {
  const dir = subagentDirFor(sessionFilePath);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.some(e => e.isFile() && e.name.endsWith(".md"));
  } catch {
    return false;
  }
}

/**
 * Candidate check based on SessionSummary properties and whether a report exists.
 *
 * Sparing rules:
 * - A live session (`live-tui` or `live-ompd`) is currently active and is never ephemeral.
 * - An already archived session is skipped.
 * - A session with 3 or more messages is not ephemeral.
 * - A session whose byte size exceeds maxBytes is not ephemeral.
 * - A session younger than minAgeMs is not ephemeral.
 * - A session that produced a subagent report (<Name>.md) is not ephemeral.
 */
export function isEphemeralCandidate(
  session: SessionSummary,
  hasReport: boolean,
  criteria?: EphemeralCriteria,
): boolean {
  if (session.status !== "dormant" || session.archived) return false;
  if (hasReport) return false;

  const maxMessages = criteria?.maxMessages ?? DEFAULT_EPHEMERAL_MAX_MESSAGES;
  if (session.messageCount === null || session.messageCount > maxMessages) return false;

  const maxBytes = criteria?.maxBytes ?? DEFAULT_EPHEMERAL_MAX_BYTES;
  if (session.byteSize > maxBytes) return false;

  const minAgeMs = criteria?.minAgeMs ?? DEFAULT_EPHEMERAL_MIN_AGE_MS;
  if (minAgeMs > 0) {
    const now = criteria?.now ?? Date.now();
    const lastActivity = new Date(session.lastActivityAt).getTime();
    const created = new Date(session.createdAt).getTime();
    const activityTime = Math.max(
      Number.isFinite(lastActivity) ? lastActivity : 0,
      Number.isFinite(created) ? created : 0,
    );
    if (activityTime > 0 && (now - activityTime < minAgeMs || activityTime > now)) {
      return false;
    }
  }

  return true;
}
