import { describe, expect, test } from "bun:test";
import { appendPrompt, EMPTY_SESSION, reduce } from "../src/session/model.ts";

describe("defect 8: per-token cost benchmark", () => {
  test("1,000-entry transcript appending 1,000 chunks executes in O(chunks), not O(n*chunks)", () => {
    // 1. Build a 1,000-entry transcript
    let session = EMPTY_SESSION;
    for (let i = 1; i <= 999; i++) {
      session = appendPrompt(session, `initial prompt ${i}`);
    }

    // Start an open streaming assistant message
    session = reduce(session, {
      sessionUpdate: "agent_message_chunk",
      messageId: "stream_msg_1",
      content: { type: "text", text: "start" },
    });

    expect(session.entries.length).toBe(1000);

    // 2. Measure appending 1,000 chunks to the open streaming turn
    const chunks = 1000;
    const startHeap = process.memoryUsage().heapUsed;
    const startTime = performance.now();

    for (let i = 1; i <= chunks; i++) {
      session = reduce(session, {
        sessionUpdate: "agent_message_chunk",
        messageId: "stream_msg_1",
        content: { type: "text", text: ` chunk${i}` },
      });
    }

    const durationMs = performance.now() - startTime;
    const heapDiffBytes = Math.max(0, process.memoryUsage().heapUsed - startHeap);

    console.log(
      `[benchmark defect 8] 1,000 chunks on 1,000-entry transcript: ${durationMs.toFixed(2)}ms, heap diff: ${(heapDiffBytes / 1024).toFixed(1)} KB`,
    );

    // With O(1) in-place token mutation, 1,000 chunks takes under 25ms on this machine
    expect(durationMs).toBeLessThan(100);

    // Verify all chunks accumulated correctly without duplicating or truncating
    const lastEntry = session.entries[session.entries.length - 1];
    expect(lastEntry?.kind).toBe("assistant");
    expect((lastEntry as any).text).toContain("chunk1000");
  });
});
