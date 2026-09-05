import { describe, expect, test } from "bun:test";
import { appendPrompt, EMPTY_SESSION, mergeSessionHistory } from "../src/session/model.ts";
import type { SessionHistoryEntry } from "@ompd/core/contracts";

describe("item 2: mergeSessionHistory must not trim the requested head page", () => {
  test("with 2,000 entries held, prepending older history keeps the prepended entries", () => {
    let session = EMPTY_SESSION;
    for (let i = 1; i <= 2000; i++) {
      session = appendPrompt(session, `prompt ${i}`);
    }
    expect(session.entries.length).toBe(2000);

    const olderHistory: SessionHistoryEntry[] = [
      { kind: "user", id: "older_1", text: "historical message 1", at: "2026-09-01T00:00:00.000Z" },
      { kind: "user", id: "older_2", text: "historical message 2", at: "2026-09-01T00:01:00.000Z" },
    ];

    const next = mergeSessionHistory(session, olderHistory);

    // Pre-fix failure: trimEntries sliced from the tail, removing older_1 and older_2!
    expect(next.entries[0]?.id).toBe("older_1");
    expect(next.entries[1]?.id).toBe("older_2");
  });
});
