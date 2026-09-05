import { describe, expect, test } from "bun:test";
import type { SessionHistoryEntry } from "@ompd/core/contracts";
import { appendPrompt, EMPTY_SESSION, mergeSessionHistory, reduce } from "../src/session/model.ts";

describe("item 3: echo reconciliation must correlate by position/turn, not global text search", () => {
  test("sending 'status' twice then paging older does not delete the live echo at the tail", () => {
    let session = EMPTY_SESSION;
    // Initial transcript already has a historical status message and its response
    session = mergeSessionHistory(session, [
      { kind: "user", id: "hist_1", text: "status", at: "2026-09-01T00:00:00.000Z" },
      { kind: "assistant", id: "hist_2", text: "All systems nominal", thought: false, at: "2026-09-01T00:00:01.000Z" },
    ]);

    // User now sends 'status' again at the live tail
    session = appendPrompt(session, "status");
    expect(session.entries.some(e => e.id.startsWith("prompt-"))).toBe(true);

    // Operator clicks "Load earlier" and older history (which also happens to mention status or older queries) is prepended
    const olderHistory: SessionHistoryEntry[] = [
      { kind: "user", id: "old_0", text: "status", at: "2026-08-30T00:00:00.000Z" },
    ];

    const next = mergeSessionHistory(session, olderHistory);

    // Pre-fix failure: remaining.findIndex found the live echo at the tail and deleted it!
    const liveEcho = next.entries.find(e => e.id.startsWith("prompt-"));
    expect(liveEcho).toBeDefined();
    expect(liveEcho?.kind === "user" ? liveEcho.text : undefined).toBe("status");
  });

  test("durable user row replaces the trailing echo without leaving both prompt-0 and durable row", () => {
    let session = EMPTY_SESSION;
    session = appendPrompt(session, "hello");
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]?.id).toBe("prompt-0");

    // Daemon streams durable user row for this turn
    const next = reduce(session, {
      sessionUpdate: "user_message_chunk",
      channel: "user",
      messageId: "durable-hello",
      content: { text: "hello" },
    });

    // Pre-fix failure: reduce appends durable-hello without replacing prompt-0
    const userEntries = next.entries.filter(e => e.kind === "user");
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.id).toBe("durable-hello");
  });
});
