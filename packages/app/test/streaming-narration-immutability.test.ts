import { describe, expect, test } from "bun:test";
import { EMPTY_SESSION, reduce } from "../src/session/model.ts";

describe("item 8: streaming chunks must keep entries immutable per chunk for narration", () => {
  test("streaming chunk produces a new entries array reference and does not mutate prior entry in-place", () => {
    const s1 = reduce(EMPTY_SESSION, {
      sessionUpdate: "agent_message_chunk",
      content: { text: "First sentence." },
    });
    const s1Entries = s1.entries;
    const s1Entry = s1.entries[0];
    expect(s1Entry?.kind === "assistant" ? s1Entry.text : null).toBe("First sentence.");

    const s2 = reduce(s1, {
      sessionUpdate: "agent_message_chunk",
      content: { text: " Second sentence." },
    });

    // Pre-fix failure: s2.entries === s1Entries because streaming fast path mutated in place
    // and returned the same entries array, preventing useNarration's useEffect from seeing the update!
    expect(s2.entries).not.toBe(s1Entries);
    expect(s2.entries[0]).not.toBe(s1Entry);
    expect(s2.entries[0]?.kind === "assistant" ? s2.entries[0].text : null).toBe("First sentence. Second sentence.");
  });
});
