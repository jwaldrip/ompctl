import { describe, expect, test } from "bun:test";
import type { SessionHistoryEntry } from "@ompd/core/contracts";
import { appendPrompt, EMPTY_SESSION, mergeSessionHistory, reduce } from "../src/session/model.ts";

describe("item 13: user_message_chunk echo adoption and position preservation", () => {
  test("user chunk with messageId and matching text replaces newest echo in place", () => {
    let session = EMPTY_SESSION;
    session = appendPrompt(session, "hello from operator");
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]?.id).toBe("prompt-0");

    // Daemon accepts and emits user_message_chunk with a fresh messageId
    const next = reduce(session, {
      sessionUpdate: "user_message_chunk",
      channel: "user",
      messageId: "durable_user_msg_1",
      content: { type: "text", text: "hello from operator" },
    });

    expect(next.entries).toHaveLength(1);
    expect(next.entries[0]?.id).toBe("durable_user_msg_1");
    expect(next.entries[0]?.kind).toBe("user");
    expect((next.entries[0] as any)?.text).toBe("hello from operator");
  });

  test("user chunk whose text differs from newest echo appends as another device's prompt", () => {
    let session = EMPTY_SESSION;
    session = appendPrompt(session, "local device prompt");
    expect(session.entries).toHaveLength(1);
    expect(session.entries[0]?.id).toBe("prompt-0");

    // Another device prompts concurrently with different text
    const next = reduce(session, {
      sessionUpdate: "user_message_chunk",
      channel: "user",
      messageId: "other_device_msg_2",
      content: { type: "text", text: "prompt from another device" },
    });

    // Pre-fix failure: findChunkTarget matched index === entries.length - 1 without checking text!
    // So it overwrote prompt-0 instead of appending!
    const userEntries = next.entries.filter(e => e.kind === "user");
    expect(userEntries).toHaveLength(2);
    expect(userEntries[0]?.id).toBe("prompt-0");
    expect((userEntries[0] as any)?.text).toBe("local device prompt");
    expect(userEntries[1]?.id).toBe("other_device_msg_2");
    expect((userEntries[1] as any)?.text).toBe("prompt from another device");
  });

  test("echo, then daemon chunk, then session_history containing neither yields exactly one user row", () => {
    let session = EMPTY_SESSION;
    session = appendPrompt(session, "ship the feature");
    expect(session.entries).toHaveLength(1);

    // Daemon chunk arrives and adopts
    session = reduce(session, {
      sessionUpdate: "user_message_chunk",
      channel: "user",
      messageId: "durable_ship",
      content: { type: "text", text: "ship the feature" },
    });

    // Older history arrives containing neither
    const olderHistory: SessionHistoryEntry[] = [
      { kind: "user", id: "older_user_1", text: "earlier query", at: "2026-09-01T00:00:00.000Z" },
      { kind: "assistant", id: "older_ast_1", text: "earlier answer", thought: false, at: "2026-09-01T00:00:01.000Z" },
    ];

    const merged = mergeSessionHistory(session, olderHistory);
    const shipEntries = merged.entries.filter(e => e.kind === "user" && (e as any).text === "ship the feature");
    expect(shipEntries).toHaveLength(1);
    expect(shipEntries[0]?.id).toBe("durable_ship");
  });
});
