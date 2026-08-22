/**
 * `scanSessionFiles` and `countMessages` are pure filesystem readers; the
 * fixture below writes fake `.jsonl` session files in the exact shape a real
 * OMP session takes (a title header line, a `session` line, and interleaved
 * `message`/`custom`/`model_change` lines) rather than a simplified stand-in,
 * so `countMessages`'s exclusion rules are exercised against the real event
 * vocabulary.
 *
 * The streaming rewrite of `countMessages` is the highest-risk change in
 * this package, so it is pinned against the whole-file implementation it
 * replaced (kept verbatim below as the oracle) across a fixture set that
 * attacks chunk boundaries from every side, plus a seeded fuzz pass.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COUNT_CHUNK_BYTES,
  countMessages,
  countMessagesAsync,
  findSessionFile,
  findSessionFileIter,
  scanSessionFiles,
  scanSessionFilesIter,
} from "../../src/sessions/scanner.ts";

const scratch: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function writeSessionFile(groupDir: string, filenameTimestamp: string, id: string, lines: unknown[]): string {
  mkdirSync(groupDir, { recursive: true });
  const filePath = join(groupDir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(filePath, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
  return filePath;
}

const SESSION_ID_A = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const SESSION_ID_B = "019feebf-6449-7000-9474-a2ae1f871930";

describe("scanSessionFiles", () => {
  test("finds sessions across multiple cwd-group directories", async () => {
    const root = tempRoot("scanner-multi-group-");
    writeSessionFile(join(root, "-Downloads"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "Manuscript" },
    ]);
    writeSessionFile(join(root, "--private-tmp--"), "2026-08-11T01-11-48-090Z", SESSION_ID_B, [
      { type: "title", v: 1, title: "Scratch" },
    ]);

    const files = await scanSessionFiles(root);
    expect(files).toHaveLength(2);
    const groups = new Set(files.map(f => f.flattenedDir));
    expect(groups).toEqual(new Set(["-Downloads", "--private-tmp--"]));
  });

  test("derives id and createdAt from the filename alone, not file contents", async () => {
    const root = tempRoot("scanner-filename-");
    writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "Build the thing" },
    ]);

    const [file] = await scanSessionFiles(root);
    expect(file).toBeDefined();
    expect(file!.id).toBe(SESSION_ID_A);
    expect(file!.createdAt).toBe("2026-08-11T01:11:48.090Z");
  });

  test("reads title and exact cwd from the bounded JSONL header", async () => {
    const root = tempRoot("scanner-title-");
    writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "Build the thing" },
      { type: "session", version: 3, id: SESSION_ID_A, timestamp: "t", cwd: "/exact/project" },
    ]);

    const [file] = await scanSessionFiles(root);
    expect(file!.title).toBe("Build the thing");
    expect(file!.cwd).toBe("/exact/project");
  });

  test("an empty title header degrades to an empty string, not a throw", async () => {
    const root = tempRoot("scanner-empty-title-");
    writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [{ type: "title", v: 1, title: "" }]);

    const files = await scanSessionFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.title).toBe("");
  });

  test("a malformed header line degrades to an empty title instead of failing the scan", async () => {
    const root = tempRoot("scanner-bad-header-");
    const groupDir = join(root, "-x");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(join(groupDir, `2026-08-11T01-11-48-090Z_${SESSION_ID_A}.jsonl`), "not json\nmore\n");

    const files = await scanSessionFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0]!.title).toBe("");
  });

  test("ignores non-jsonl entries and the per-session artifact subdirectories real OMP writes alongside a transcript", async () => {
    const root = tempRoot("scanner-non-jsonl-");
    const groupDir = join(root, "-x");
    writeSessionFile(groupDir, "2026-08-11T01-11-48-090Z", SESSION_ID_A, [{ type: "title", v: 1, title: "t" }]);
    mkdirSync(join(groupDir, "subdir"), { recursive: true });
    writeFileSync(join(groupDir, "not-a-session.txt"), "junk");

    const files = await scanSessionFiles(root);
    expect(files).toHaveLength(1);
  });

  test("byte size and mtime come from stat, matching the real file", async () => {
    const root = tempRoot("scanner-stat-");
    const path = writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "t" },
    ]);
    const mtime = new Date("2026-08-12T00:00:00.000Z");
    utimesSync(path, mtime, mtime);

    const [file] = await scanSessionFiles(root);
    expect(file!.sizeBytes).toBeGreaterThan(0);
    expect(Math.abs(file!.mtimeMs - mtime.getTime())).toBeLessThan(1000);
  });

  test("a missing sessions root returns an empty list rather than throwing", async () => {
    expect(await scanSessionFiles("/no/such/sessions/root/anywhere")).toEqual([]);
  });

  test("exposes only an async iterator so filesystem work cannot run synchronously", () => {
    const root = tempRoot("scanner-async-");
    const scan = scanSessionFilesIter(root);
    expect(Symbol.asyncIterator in scan).toBe(true);
    expect(Symbol.iterator in scan).toBe(false);
  });
});

describe("countMessages", () => {
  test("counts user and assistant turns, excluding tool results and bookkeeping events", () => {
    const root = tempRoot("scanner-count-");
    const path = writeSessionFile(join(root, "-x"), "2026-08-11T01-11-48-090Z", SESSION_ID_A, [
      { type: "title", v: 1, title: "t" },
      { type: "session", version: 3, id: SESSION_ID_A, timestamp: "t", cwd: "/x" },
      { type: "model_change", id: "a", model: "m" },
      { type: "thinking_level_change", id: "b", thinkingLevel: "off" },
      { type: "message", id: "c", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      { type: "title_change", id: "d", title: "t2" },
      { type: "message", id: "e", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } },
      { type: "custom", customType: "tool_execution_start", id: "f", data: {} },
      { type: "message", id: "g", message: { role: "toolResult", toolCallId: "x", content: [] } },
      { type: "credential_pin", id: "h", provider: "p", hash: "x" },
      { type: "message", id: "i", message: { role: "user", content: [{ type: "text", text: "again" }] } },
    ]);
    expect(countMessages(path)).toBe(3);
  });

  test("a missing file counts zero rather than throwing", () => {
    expect(countMessages("/no/such/file.jsonl")).toBe(0);
  });

  test("skips malformed lines without losing the rest of the count", () => {
    const root = tempRoot("scanner-count-malformed-");
    const groupDir = join(root, "-x");
    mkdirSync(groupDir, { recursive: true });
    const path = join(groupDir, `2026-08-11T01-11-48-090Z_${SESSION_ID_A}.jsonl`);
    const lines = [
      JSON.stringify({ type: "message", id: "a", message: { role: "user", content: [] } }),
      "not valid json at all",
      JSON.stringify({ type: "message", id: "b", message: { role: "assistant", content: [] } }),
    ];
    writeFileSync(path, `${lines.join("\n")}\n`);
    expect(countMessages(path)).toBe(2);
  });
});

/**
 * The oracle: the whole-file implementation `countMessages` shipped before
 * counting was streamed, verbatim. Agreement with it is the spec -- the same
 * lines counted, the same malformed-line tolerance, the same zero for an
 * unreadable file.
 */
function legacyCountMessages(path: string): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    let parsed: { type?: unknown; message?: { role?: unknown } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type === "message") {
      const role = parsed.message?.role;
      if (role === "user" || role === "assistant") count++;
    }
  }
  return count;
}

/** A `type:"message"` line whose UTF-8 byte length is exactly `totalBytes` (ASCII padding, so bytes and chars agree). */
function paddedMessageLine(totalBytes: number, role: "user" | "assistant" = "user"): string {
  const head = `{"type":"message","id":"m","message":{"role":"${role}","content":[{"type":"text","text":"`;
  const tail = `"}]}}`;
  return head + "x".repeat(Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail))) + tail;
}

/** A message line whose text contains `char` placed so its UTF-8 bytes straddle byte offset `splitAt` within the line. */
function lineWithCharStraddling(splitAt: number, char: string): string {
  const head = `{"type":"message","id":"m","message":{"role":"user","content":[{"type":"text","text":"`;
  const prefix = "a".repeat(Math.max(0, splitAt - Buffer.byteLength(head) - (Buffer.byteLength(char) - 1)));
  return `${head}${prefix}${char}${"b".repeat(8)}"}]}}`;
}

function writeRaw(name: string, content: string): string {
  const dir = tempRoot("scanner-equiv-");
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("countMessages streaming equivalence", () => {
  const C = COUNT_CHUNK_BYTES;

  test("table: every fixture agrees with the whole-file oracle", async () => {
    const title = JSON.stringify({ type: "title", v: 1, title: "t", updatedAt: "t" });
    const userLine = JSON.stringify({ type: "message", id: "a", message: { role: "user", content: [] } });
    const noiseLine = JSON.stringify({ type: "model_change", id: "n", model: "m" });

    const cases: Array<{ name: string; content: string; expected: number }> = [
      { name: "empty file", content: "", expected: 0 },
      { name: "only newlines", content: "\n\n\n", expected: 0 },
      { name: "one message line with trailing newline", content: `${userLine}\n`, expected: 1 },
      { name: "trailing message line with no final newline", content: userLine, expected: 1 },
      {
        name: "trailing non-message line with no final newline",
        content: `${userLine}\n${noiseLine}`,
        expected: 1,
      },
      {
        name: "malformed lines interleaved with good ones",
        content: `${title}\n{broken\n${userLine}\n{"type":"message" \n${userLine}\n`,
        expected: 2,
      },
      {
        name: "empty and whitespace-only lines interleaved",
        content: `\n${userLine}\n   \n\t\n${userLine}\n\n`,
        expected: 2,
      },
      {
        name: "CRLF line endings",
        content: `${title}\r\n${userLine}\r\n${userLine}\r\n`,
        expected: 2,
      },
      {
        name: "multi-byte characters (CJK and emoji) inside message text",
        content:
          `${JSON.stringify({ type: "message", id: "a", message: { role: "user", content: [{ type: "text", text: "你好世界".repeat(50) }] } })}\n` +
          `${noiseLine}\n` +
          `${JSON.stringify({ type: "message", id: "b", message: { role: "assistant", content: [{ type: "text", text: "🛠️🔧 完了".repeat(40) }] } })}\n`,
        expected: 2,
      },
      {
        // The line occupies [0, C-1) and its newline sits AT C-1, so the
        // next line begins exactly on the chunk boundary.
        name: "newline landing exactly on a chunk boundary",
        content: `${paddedMessageLine(C - 1)}\n${userLine}\n`,
        expected: 2,
      },
      {
        // The line occupies [0, C) and its newline sits AT C, so the line
        // itself straddles the boundary by one byte.
        name: "line straddling a chunk boundary by exactly one byte",
        content: `${paddedMessageLine(C)}\n${userLine}\n`,
        expected: 2,
      },
      {
        name: "line straddling by two bytes",
        content: `${paddedMessageLine(C + 1)}\n${userLine}\n`,
        expected: 2,
      },
      {
        name: "a single line spanning three chunks",
        content: `${paddedMessageLine(3 * C + 17)}\n${userLine}\n`,
        expected: 2,
      },
      {
        // A 3-byte UTF-8 character with 2 bytes before the boundary and 1
        // after: a decoder that resets per chunk would corrupt it.
        name: "3-byte character split 2/1 across the boundary",
        content: `${lineWithCharStraddling(C, "中")}\n${userLine}\n`,
        expected: 2,
      },
      {
        name: "3-byte character split 1/2 across the boundary",
        content: `${lineWithCharStraddling(C + 1, "中")}\n${userLine}\n`,
        expected: 2,
      },
      {
        // A title line first pushes every later boundary landing off the
        // chunk grid, which is the unaligned case real files always hit.
        name: "boundary-straddling line behind an offsetting title line",
        content: `${title}\n${paddedMessageLine(C - Buffer.byteLength(title) - 1 + 5)}\n${userLine}\n`,
        expected: 2,
      },
    ];

    for (const { name, content, expected } of cases) {
      const path = writeRaw(`${name.replace(/[^a-z0-9]+/gi, "-")}.jsonl`, content);
      expect(countMessages(path), name).toBe(expected);
      expect(countMessages(path), name).toBe(legacyCountMessages(path));
      expect(await countMessagesAsync(path), `${name} async`).toBe(expected);
    }
  });

  test("a multi-megabyte file of realistic lines agrees with the oracle", () => {
    // ~6MB: title + a few thousand padded message lines interleaved with
    // noise, malformed lines, and blanks, so thousands of chunk boundaries
    // and every line shape occur naturally.
    const parts: string[] = [JSON.stringify({ type: "title", v: 1, title: "big", updatedAt: "t" })];
    let expected = 0;
    for (let i = 0; i < 2600; i++) {
      const kind = i % 11;
      if (kind === 0) {
        parts.push(JSON.stringify({ type: "model_change", id: `n${i}`, model: "m" }));
      } else if (kind === 3) {
        parts.push(`{broken-${i}`);
      } else if (kind === 7) {
        parts.push("");
      } else {
        parts.push(paddedMessageLine(1800 + (i % 900), i % 2 ? "user" : "assistant"));
        expected += 1;
      }
    }
    const path = writeRaw("multi-megabyte.jsonl", `${parts.join("\n")}\n`);
    expect(countMessages(path)).toBe(expected);
    expect(countMessages(path)).toBe(legacyCountMessages(path));
  });

  test("seeded fuzz: random line mixes, lengths around chunk multiples, random trailing newline", () => {
    // Deterministic LCG so a failure names a reproducible corpus, never a
    // reroll. Lengths cluster around multiples of the chunk size so lines
    // straddle boundaries in both directions on every file.
    let seed = 0x2f6e2b1;
    const rand = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let file = 0; file < 25; file++) {
      const lines: string[] = [];
      for (let i = 0, n = 1 + Math.floor(rand() * 400); i < n; i++) {
        const roll = rand();
        if (roll < 0.45) {
          const multiple = Math.floor(rand() * 4) * C;
          const jitter = Math.floor(rand() * 5) - 2;
          lines.push(paddedMessageLine(Math.max(60, multiple + jitter), rand() < 0.5 ? "user" : "assistant"));
        } else if (roll < 0.55) {
          lines.push(
            JSON.stringify({ type: "message", id: "t", message: { role: "toolResult", toolCallId: "x", content: [] } }),
          );
        } else if (roll < 0.7) {
          lines.push(JSON.stringify({ type: "title_change", id: "c", title: "t" }));
        } else if (roll < 0.8) {
          lines.push(`garbage {${Math.floor(rand() * 1e9)}`);
        } else if (roll < 0.9) {
          lines.push("");
        } else {
          lines.push(
            JSON.stringify({
              type: "message",
              id: "u",
              message: { role: "user", content: [{ type: "text", text: "你好".repeat(1 + Math.floor(rand() * 400)) }] },
            }),
          );
        }
      }
      const content = lines.join("\n") + (rand() < 0.5 ? "\n" : "");
      const path = writeRaw(`fuzz-${file}.jsonl`, content);
      expect(countMessages(path), `fuzz file ${file}`).toBe(legacyCountMessages(path));
    }
  });

  test("a 40MB file is counted without materialising it", () => {
    // The streamed counter's whole reason to exist: one fixed chunk buffer
    // and one line at a time, never the decoded file (a 40MB file is a
    // 40MB+ string in JS) and never an array of every line. Measured by
    // RSS, not heapUsed: the whole-file implementation's string and line
    // array did not register in post-return heapUsed on this runtime, but
    // measured +84.5MB RSS here, so RSS is the honest instrument. The
    // bound leaves the streamed implementation an order of magnitude of
    // headroom (its transient churn is kilobytes).
    const parts: string[] = [];
    let expected = 0;
    let totalBytes = 0;
    for (let i = 0; totalBytes < 40 * 1024 * 1024; i++) {
      const line = paddedMessageLine(2048, i % 2 ? "user" : "assistant");
      parts.push(line);
      totalBytes += line.length + 1;
      expected += 1;
      if (i % 9 === 0) parts.push(JSON.stringify({ type: "model_change", id: `n${i}`, model: "m" }));
    }
    const path = writeRaw("forty-megabytes.jsonl", `${parts.join("\n")}\n`);
    parts.length = 0; // Do not let the fixture itself hold the 40MB.

    Bun.gc(true);
    const before = process.memoryUsage.rss();
    const count = countMessages(path);
    const growth = process.memoryUsage.rss() - before;

    expect(count).toBe(expected);
    expect(growth).toBeLessThan(30 * 1024 * 1024);
  });
});

describe("findSessionFile", () => {
  test("finds one id's file across many group directories, and misses honestly", () => {
    const root = tempRoot("scanner-find-");
    writeSessionFile(join(root, "-a"), "2026-08-10T00-00-00-000Z", SESSION_ID_A, [{ type: "title", v: 1, title: "a" }]);
    const wanted = writeSessionFile(join(root, "-b"), "2026-08-11T00-00-00-000Z", SESSION_ID_B, [
      { type: "title", v: 1, title: "b" },
    ]);

    expect(findSessionFile(SESSION_ID_B, root)).toBe(wanted);
    expect(findSessionFile("019ff8ca-b4ca-7000-a133-beedf9dfab06", root)).toBeUndefined();
    // The id must be the whole one: a fragment that happens to end a real
    // filename must not resolve, or a client could reach a session it was
    // never shown.
    expect(findSessionFile(SESSION_ID_B.slice(6), root)).toBeUndefined();
  });

  test("a filename outside the naming scheme is not a session, and a missing root is not a throw", () => {
    const root = tempRoot("scanner-find-shape-");
    const groupDir = join(root, "-a");
    mkdirSync(groupDir, { recursive: true });
    // Ends with the id, but the scan would skip it rather than guess at an id,
    // so the lookup must skip it too: one convention, one answer.
    writeFileSync(join(groupDir, `copy_${SESSION_ID_A}.jsonl`), "{}\n");
    writeFileSync(join(groupDir, `2026-08-10T00-00-00-000Z_${SESSION_ID_A}.txt`), "{}\n");

    expect(findSessionFile(SESSION_ID_A, root)).toBeUndefined();
    expect(findSessionFile(SESSION_ID_A, join(root, "not-a-directory"))).toBeUndefined();
  });

  test("the walk steps once per group directory, so a large tree stays interruptible", () => {
    const root = tempRoot("scanner-find-steps-");
    for (let i = 0; i < 12; i++) {
      writeSessionFile(join(root, `-g${i}`), "2026-08-10T00-00-00-000Z", SESSION_ID_A.replace(/dd2$/, `d${i}0`), [
        { type: "title", v: 1, title: `g${i}` },
      ]);
    }

    // A miss walks every group, which is the worst case and the one worth
    // bounding: one step per directory, never one long synchronous burst.
    const steps = findSessionFileIter("019ff8ca-b4ca-7000-a133-beedf9dfab06", root);
    let taken = 0;
    let step = steps.next();
    while (!step.done) {
      taken += 1;
      step = steps.next();
    }
    expect(step.value).toBeUndefined();
    expect(taken).toBe(12);
  });
});

process.on("exit", () => {
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
});
