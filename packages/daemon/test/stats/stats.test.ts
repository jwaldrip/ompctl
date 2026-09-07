import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import { countMessagesAsync, getSessionCost } from "../../src/sessions/scanner.ts";
import { SessionIndex } from "../../src/sessions/session-index.ts";
import { computeSessionStatsFromFile, computeSessionStatsFromTranscript } from "../../src/stats/index.ts";

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  scratch.length = 0;
});

describe("daemon stats: per-session computation", () => {
  test("computes per-session stats from fixture JSONL lines", () => {
    const lines = [
      JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-08-11T01:00:00.000Z", cwd: "/test" }),
      JSON.stringify({
        type: "message",
        id: "msg-1",
        timestamp: "2026-08-11T01:01:00.000Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-2",
        timestamp: "2026-08-11T01:02:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          stopReason: "end_turn",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 200,
            cacheWrite: 20,
            totalTokens: 370,
            cost: { input: 0.01, output: 0.02, cacheRead: 0.005, cacheWrite: 0.002, total: 0.037 },
          },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-3",
        timestamp: "2026-08-11T01:03:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "something went wrong" }],
          stopReason: "error",
          errorMessage: "model failure",
          usage: {
            input: 50,
            output: 10,
            cacheRead: 50,
            cacheWrite: 0,
            totalTokens: 110,
            cost: { input: 0.005, output: 0.004, cacheRead: 0.001, cacheWrite: 0, total: 0.01 },
          },
        },
      }),
    ];

    const stats = computeSessionStatsFromTranscript(lines);

    // Sum of cost: 0.037 + 0.01 = 0.047
    expect(stats.cost).toBe(0.047);
    // Tokens
    expect(stats.tokens.input).toBe(150);
    expect(stats.tokens.output).toBe(60);
    expect(stats.tokens.cacheRead).toBe(250);
    expect(stats.tokens.cacheWrite).toBe(20);
    // cacheRate = cacheRead / (input + cacheRead) = 250 / (150 + 250) = 250 / 400 = 0.625
    expect(stats.cacheRate).toBe(0.625);
    // Calls and errors
    expect(stats.calls).toBe(2);
    expect(stats.errors).toBe(1);
  });

  test("computes per-session stats from a fixture file", async () => {
    const dir = tempDir("stats-file-test-");
    const filePath = join(dir, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 80,
            output: 20,
            cacheRead: 320,
            cacheWrite: 10,
            cost: { total: 0.042 },
          },
        },
      }),
    ];
    writeFileSync(filePath, `${lines.join("\n")}\n`);

    const stats = await computeSessionStatsFromFile(filePath);
    expect(stats.cost).toBe(0.042);
    expect(stats.tokens.input).toBe(80);
    expect(stats.tokens.output).toBe(20);
    expect(stats.tokens.cacheRead).toBe(320);
    expect(stats.tokens.cacheWrite).toBe(10);
    expect(stats.cacheRate).toBe(0.8); // 320 / (80 + 320) = 320 / 400 = 0.8
    expect(stats.calls).toBe(1);
    expect(stats.errors).toBe(0);
  });
});

describe("SessionSummary carries cost from fixture", () => {
  test("SessionSummary carries cost when usage lines exist and null when absent", async () => {
    const root = tempDir("sessions-cost-root-");
    const dbDir = tempDir("sessions-cost-db-");
    const store = new Store(join(dbDir, "ompd.db"));

    const sessionIdWithCost = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
    const sessionIdNoCost = "019feebf-6449-7000-9474-a2ae1f871930";

    const groupDir = join(root, "-alpha");
    mkdirSync(groupDir, { recursive: true });

    // File 1: carries usage lines with cost
    const fileWithCost = join(groupDir, `2026-08-11T01-11-48-090Z_${sessionIdWithCost}.jsonl`);
    writeFileSync(
      fileWithCost,
      `${[
        JSON.stringify({ type: "session", title: "Costed Session", cwd: "/alpha" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            usage: {
              input: 100,
              output: 50,
              cacheRead: 100,
              cacheWrite: 0,
              cost: { total: 0.42 },
            },
          },
        }),
      ].join("\n")}\n`,
    );

    // File 2: carries messages but no usage lines
    const fileNoCost = join(groupDir, `2026-08-12T01-11-48-090Z_${sessionIdNoCost}.jsonl`);
    writeFileSync(
      fileNoCost,
      `${[
        JSON.stringify({ type: "session", title: "Free Session", cwd: "/alpha" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: "hello without usage",
          },
        }),
      ].join("\n")}\n`,
    );

    // Run counting/scanning to accumulate costs
    await countMessagesAsync(fileWithCost);
    await countMessagesAsync(fileNoCost);

    expect(getSessionCost(sessionIdWithCost)).toBe(0.42);
    expect(getSessionCost(sessionIdNoCost)).toBeNull();

    const emptyRun = tempDir("empty-run-");
    const index = new SessionIndex({ store, sessionsRoot: root, runDaemonsRoot: emptyRun });
    const summaries = await index.build();

    const summaryCost = summaries.find(s => s.id === sessionIdWithCost);
    const summaryNoCost = summaries.find(s => s.id === sessionIdNoCost);

    expect(summaryCost).toBeDefined();
    expect(summaryCost?.cost).toBe(0.42);

    expect(summaryNoCost).toBeDefined();
    expect(summaryNoCost?.cost).toBeNull();
  });
});
