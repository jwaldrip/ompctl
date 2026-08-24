/**
 * What one session open costs on the daemon side, measured rather than guessed.
 *
 * Reads only. Every real session file is opened read-only and never written,
 * so this is safe to run against a live machine's own corpus; the synthetic
 * fixtures exist so a before/after comparison has a data set that does not
 * change under it.
 *
 * Monotonic timings via `performance.now()`, several samples per case, and the
 * bytes each case moved, because a millisecond number with no byte count
 * beside it cannot tell an IO cost from a parse cost.
 *
 * Usage:
 *   bun scripts/bench-session-open.ts            # synthetic fixtures only
 *   bun scripts/bench-session-open.ts --real     # also sample the real corpus
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { HISTORY_DEFAULT_TURNS, readSessionHistory } from "../packages/daemon/src/sessions/history.ts";
import { readSessionTail } from "../packages/daemon/src/sessions/tail.ts";

const SAMPLES = 7;

interface Sample {
  case: string;
  fileBytes: number;
  msP50: number;
  msMin: number;
  msMax: number;
  bytesRead: number;
  entries: number;
  payloadBytes: number;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

async function timeHistory(label: string, path: string, fileBytes: number): Promise<Sample> {
  const times: number[] = [];
  let entries = 0;
  let bytesRead = 0;
  let payloadBytes = 0;
  // One warm pass first: the point is steady-state cost, not the OS page cache
  // filling for the first time, which no operator pays twice.
  await readSessionHistory(path);
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    const result = await readSessionHistory(path);
    times.push(performance.now() - started);
    entries = result.entries.length;
    bytesRead = result.bytesRead;
    payloadBytes = JSON.stringify(result.entries).length;
  }
  return {
    case: label,
    fileBytes,
    msP50: +percentile(times, 0.5).toFixed(2),
    msMin: +Math.min(...times).toFixed(2),
    msMax: +Math.max(...times).toFixed(2),
    bytesRead,
    entries,
    payloadBytes,
  };
}

async function timeTail(label: string, path: string, fileBytes: number): Promise<Sample> {
  const times: number[] = [];
  let entries = 0;
  let payloadBytes = 0;
  await readSessionTail(path);
  for (let i = 0; i < SAMPLES; i += 1) {
    const started = performance.now();
    const result = await readSessionTail(path);
    times.push(performance.now() - started);
    entries = result.messages.length;
    payloadBytes = JSON.stringify(result.messages).length;
  }
  return {
    case: label,
    fileBytes,
    msP50: +percentile(times, 0.5).toFixed(2),
    msMin: +Math.min(...times).toFixed(2),
    msMax: +Math.max(...times).toFixed(2),
    bytesRead: 0,
    entries,
    payloadBytes,
  };
}

/**
 * One synthetic session. `toolBytes` is what makes these realistic: a real
 * transcript is mostly tool output, not prose, and that ratio decides how many
 * turns fit in the reader's window.
 */
function writeFixture(dir: string, name: string, turns: number, toolBytes: number): { path: string; bytes: number } {
  const lines: string[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    lines.push(
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: `ask ${turn}` }] },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString(),
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: `answer ${turn}` },
            { type: "toolCall", id: `t${turn}`, name: "bash", arguments: { command: "ls" } },
          ],
        },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString(),
      }),
    );
    lines.push(
      JSON.stringify({
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: `t${turn}`,
          content: [{ type: "text", text: "x".repeat(toolBytes) }],
        },
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, turn)).toISOString(),
      }),
    );
  }
  const path = join(dir, name);
  const body = `${lines.join("\n")}\n`;
  writeFileSync(path, body);
  return { path, bytes: body.length };
}

async function realCorpusSamples(): Promise<Sample[]> {
  const root = join(homedir(), ".omp", "agent", "sessions");
  const found: Array<{ path: string; bytes: number }> = [];
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
  for (const dir of dirs) {
    let inner: string[];
    try {
      inner = await readdir(join(root, dir));
    } catch {
      continue;
    }
    for (const file of inner) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(root, dir, file);
      try {
        found.push({ path, bytes: (await stat(path)).size });
      } catch {
        // A file that vanished between listing and stat is not this bench's
        // problem: the daemon handles the same race by answering empty.
      }
    }
  }
  found.sort((a, b) => a.bytes - b.bytes);
  const pick = (p: number) => found[Math.min(found.length - 1, Math.floor(found.length * p))];
  const chosen: Array<[string, { path: string; bytes: number } | undefined]> = [
    ["real p50", pick(0.5)],
    ["real p90", pick(0.9)],
    ["real p99", pick(0.99)],
    ["real max", found.at(-1)],
  ];
  const out: Sample[] = [];
  for (const [label, entry] of chosen) {
    if (entry === undefined) continue;
    out.push(await timeHistory(`history ${label}`, entry.path, entry.bytes));
    out.push(await timeTail(`tail    ${label}`, entry.path, entry.bytes));
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), "ompd-bench-"));
try {
  const rows: Sample[] = [];
  // Prose-heavy: many small turns, so the reader's window holds far more than
  // one page and the limit is what stops it.
  const chatty = writeFixture(dir, "chatty.jsonl", 4_000, 200);
  // Tool-heavy: the realistic shape. Each turn carries a large tool result, so
  // few turns fit in the window.
  const heavy = writeFixture(dir, "heavy.jsonl", 2_000, 8_000);
  // One pathological turn, bigger than the whole read window.
  const whale = writeFixture(dir, "whale.jsonl", 30, 400_000);

  for (const [label, fixture] of [
    ["synthetic chatty", chatty],
    ["synthetic heavy ", heavy],
    ["synthetic whale ", whale],
  ] as const) {
    rows.push(await timeHistory(`history ${label}`, fixture.path, fixture.bytes));
    rows.push(await timeTail(`tail    ${label}`, fixture.path, fixture.bytes));
  }

  if (process.argv.includes("--real")) rows.push(...(await realCorpusSamples()));

  console.log(`default first page: ${HISTORY_DEFAULT_TURNS} turns\n`);
  console.log(
    ["case", "fileKiB", "p50ms", "min", "max", "readKiB", "entries", "payloadKiB"].map(h => h.padStart(10)).join(""),
  );
  for (const row of rows) {
    console.log(
      [
        row.case.padEnd(28),
        (row.fileBytes / 1024).toFixed(0),
        row.msP50.toFixed(2),
        row.msMin.toFixed(2),
        row.msMax.toFixed(2),
        (row.bytesRead / 1024).toFixed(0),
        String(row.entries),
        (row.payloadBytes / 1024).toFixed(0),
      ]
        .map((c, i) => (i === 0 ? c : c.padStart(10)))
        .join(""),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
