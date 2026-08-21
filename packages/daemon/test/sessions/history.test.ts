import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionHistory } from "../../src/sessions/history.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(lines: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "ompd-history-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

function message(id: string, role: string, content: unknown, extra: Record<string, unknown> = {}) {
  return {
    type: "message",
    id,
    timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
    message: { role, content, ...extra },
  };
}

describe("readSessionHistory", () => {
  test("preserves user, thinking, text, tool input and full result", async () => {
    const path = fixture([
      message("u1", "user", "Inspect policy."),
      message("a1", "assistant", [
        { type: "thinking", thinking: "Need the gate." },
        { type: "toolCall", id: "tc1", name: "read", arguments: { path: "policy.ts" } },
      ]),
      message("r1", "toolResult", [{ type: "text", text: "policy body\nsecond line" }], {
        toolCallId: "tc1",
        toolName: "read",
        isError: false,
      }),
      message("a2", "assistant", [{ type: "text", text: "The gate is correct." }]),
    ]);

    const page = await readSessionHistory(path, { limit: 10 });
    expect(page.nextBefore).toBeNull();
    expect(page.entries).toEqual([
      { kind: "user", id: "u1", text: "Inspect policy.", at: "2026-01-01T00:00:02.000Z" },
      { kind: "assistant", id: "a1", text: "Need the gate.", thought: true, at: "2026-01-01T00:00:02.000Z" },
      {
        kind: "tool",
        id: "tc1",
        toolKind: "read",
        title: "read",
        status: "completed",
        input: { path: "policy.ts" },
        output: "policy body\nsecond line",
        locations: ["policy.ts"],
        at: "2026-01-01T00:00:02.000Z",
      },
      { kind: "assistant", id: "a2", text: "The gate is correct.", thought: false, at: "2026-01-01T00:00:02.000Z" },
    ]);
  });

  test("byte cursor pages all message turns exactly once", async () => {
    const path = fixture(
      Array.from({ length: 7 }, (_, index) => message(`m${index}`, index % 2 ? "assistant" : "user", `turn-${index}`)),
    );
    const seen: string[] = [];
    let before: number | undefined;
    do {
      const page = await readSessionHistory(path, { before, limit: 2 });
      seen.unshift(...page.entries.flatMap(entry => (entry.kind === "tool" ? [] : [entry.text])));
      before = page.nextBefore ?? undefined;
      if (page.nextBefore === null) break;
    } while (true);
    expect(seen).toEqual(Array.from({ length: 7 }, (_, index) => `turn-${index}`));
  });

  test("a read is bounded even when older history remains", async () => {
    const path = fixture(
      Array.from({ length: 200 }, (_, index) => message(`m${index}`, "user", `turn-${index}-${"x".repeat(200)}`)),
    );
    const page = await readSessionHistory(path, { limit: 100, maxBytes: 2_048 });
    expect(page.bytesRead).toBeLessThanOrEqual(2_048);
    expect(page.nextBefore).not.toBeNull();
    expect(page.entries.length).toBeGreaterThan(0);
  });
});
