/**
 * `readSessionTail` against files in the exact shape a real OMP session takes:
 * a title header, a `session` line, and interleaved `message` / `custom` /
 * `model_change` lines, with assistant turns whose content is a block array of
 * `thinking`, `toolCall` and `text`, and user turns whose content is sometimes
 * a bare string. Both content shapes are real -- 46 of 3828 message lines in a
 * 21MB session on this machine are the string form -- and a reader that
 * assumed the array form for both would silently drop every typed user turn
 * and render an assistant talking to itself.
 *
 * The load-bearing property is cost: a tail must be paid for in the bytes it
 * needs, not in the size of the file. So the multi-megabyte fixture below
 * asserts `bytesRead` directly rather than trusting a wall clock, and a
 * separate test proves the read hands the event loop on while it runs, which
 * is what keeps a socket answering pings mid-tail.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COUNT_CHUNK_BYTES } from "../../src/sessions/scanner.ts";
import {
  readSessionTail,
  TAIL_MAX_MESSAGES,
  TAIL_MAX_TEXT_BYTES,
  TAIL_SOFT_MAX_BYTES,
  TAIL_TEXT_CUT_MARK,
  tailText,
} from "../../src/sessions/tail.ts";

const scratch: string[] = [];

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tail-"));
  scratch.push(dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** A session file's own preamble, exactly as a real one opens. */
const PREAMBLE = [
  { type: "title", v: 1, title: "the session" },
  { type: "session", version: 3, id: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2", timestamp: "t", cwd: "/x" },
];

function turn(role: "user" | "assistant", text: string, at = "2026-08-13T00:00:00.000Z"): unknown {
  return {
    type: "message",
    id: `m-${text}`,
    timestamp: at,
    message: { role, content: [{ type: "text", text }] },
  };
}

/** Writes `lines` as a session file, newline-terminated like the real writer. */
function sessionFile(lines: unknown[], name = "session.jsonl"): string {
  return tempFile(name, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
}

/**
 * `count` tool results of about 2KB each: the traffic that makes a real
 * session file large, and the reason a tail cannot assume words are near EOF.
 */
function toolNoise(count: number): unknown[] {
  const filler = "x".repeat(2048);
  const lines: unknown[] = [];
  for (let i = 0; i < count; i++) {
    lines.push({
      type: "message",
      id: `t${i}`,
      timestamp: "2026-08-13T00:00:00.000Z",
      message: { role: "toolResult", toolCallId: `x${i}`, toolName: "read", content: [{ type: "text", text: filler }] },
    });
  }
  return lines;
}

describe("readSessionTail", () => {
  test("returns the last N turns oldest first, and says older ones were dropped", async () => {
    const path = sessionFile([
      ...PREAMBLE,
      turn("user", "one"),
      turn("assistant", "two"),
      turn("user", "three"),
      turn("assistant", "four"),
      turn("user", "five"),
    ]);

    const tail = await readSessionTail(path, { limit: 3 });

    expect(tail.messages.map(m => m.text)).toEqual(["three", "four", "five"]);
    expect(tail.messages.map(m => m.role)).toEqual(["user", "assistant", "user"]);
    expect(tail.truncated).toBe(true);
  });

  test("a transcript that fits entirely is not reported as truncated", async () => {
    const path = sessionFile([...PREAMBLE, turn("user", "one"), turn("assistant", "two")]);

    const tail = await readSessionTail(path, { limit: 30 });

    expect(tail.messages.map(m => m.text)).toEqual(["one", "two"]);
    expect(tail.truncated).toBe(false);
  });

  test("a limit that exactly consumes the transcript is not truncated either", async () => {
    // The boundary the "one turn past the limit" walk exists for: stopping
    // with the file exhausted must not be reported as dropping older turns.
    const path = sessionFile([...PREAMBLE, turn("user", "one"), turn("assistant", "two")]);

    const tail = await readSessionTail(path, { limit: 2 });

    expect(tail.messages.map(m => m.text)).toEqual(["one", "two"]);
    expect(tail.truncated).toBe(false);
  });

  test("tool calls, thinking, and tool results never surface as words", async () => {
    const path = sessionFile([
      ...PREAMBLE,
      {
        type: "message",
        id: "a",
        timestamp: "2026-08-13T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "the operator probably wants the deploy status" },
            { type: "toolCall", toolName: "bash", input: { command: "git status" } },
            { type: "text", text: "checking now" },
          ],
        },
      },
      // An assistant turn that only reached for a tool said nothing at all.
      {
        type: "message",
        id: "b",
        timestamp: "2026-08-13T00:00:02.000Z",
        message: { role: "assistant", content: [{ type: "toolCall", toolName: "bash", input: {} }] },
      },
      // A tool result is not a speaker: it carries a text block, and a reader
      // keyed on block type alone would attribute it to the agent.
      {
        type: "message",
        id: "c",
        timestamp: "2026-08-13T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "x",
          toolName: "bash",
          content: [{ type: "text", text: "nothing to commit, working tree clean" }],
        },
      },
      { type: "custom", customType: "tool_execution_start", id: "d", data: {} },
    ]);

    const tail = await readSessionTail(path);

    expect(tail.messages).toEqual([{ role: "assistant", text: "checking now", at: "2026-08-13T00:00:01.000Z" }]);
  });

  test("a user turn whose content is a bare string is a turn, not a dropped row", async () => {
    // Role attribution comes from the line's own role, never from the content
    // shape: the two shapes appear side by side in real files, and dropping
    // the string form leaves an assistant talking to itself.
    const path = sessionFile([
      ...PREAMBLE,
      { type: "message", id: "a", timestamp: "2026-08-13T00:00:01.000Z", message: { role: "user", content: "yes" } },
      turn("assistant", "on it", "2026-08-13T00:00:02.000Z"),
      {
        type: "message",
        id: "c",
        timestamp: "2026-08-13T00:00:03.000Z",
        message: { role: "user", content: "and the other thing" },
      },
    ]);

    const tail = await readSessionTail(path);

    expect(tail.messages).toEqual([
      { role: "user", text: "yes", at: "2026-08-13T00:00:01.000Z" },
      { role: "assistant", text: "on it", at: "2026-08-13T00:00:02.000Z" },
      { role: "user", text: "and the other thing", at: "2026-08-13T00:00:03.000Z" },
    ]);
  });

  test("a multi-megabyte session costs its budget, not its size", async () => {
    const path = sessionFile([
      ...PREAMBLE,
      turn("user", "buried"),
      ...toolNoise(2000),
      turn("assistant", "the last word"),
    ]);
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(4 * 1024 * 1024);

    const started = performance.now();
    const tail = await readSessionTail(path, { limit: 1 });
    const took = performance.now() - started;

    expect(tail.messages).toEqual([{ role: "assistant", text: "the last word", at: "2026-08-13T00:00:00.000Z" }]);
    expect(tail.truncated).toBe(true);
    // The two-leg guarantee: one budget looking for words, one collecting
    // them, and never the file's size. A forward reader would have paid for
    // every byte to reach the same last line.
    expect(tail.bytesRead).toBeLessThanOrEqual(TAIL_SOFT_MAX_BYTES * 2);
    expect(tail.bytesRead).toBeLessThan(size / 2);
    // Generous by design: this asserts "not linear in a 4MB file", not a
    // benchmark, so it cannot flake on a loaded machine.
    expect(took).toBeLessThan(1000);

    // And the cost tracks the budget rather than the fixture: a budget of one
    // chunk reads two chunks of the same 4MB file, about three percent of it.
    const cheap = await readSessionTail(path, { limit: 1, softMaxBytes: COUNT_CHUNK_BYTES });
    expect(cheap.messages).toEqual(tail.messages);
    expect(cheap.bytesRead).toBeLessThanOrEqual(COUNT_CHUNK_BYTES * 2);
  });

  test("words behind megabytes of tool traffic are still found, not reported as an empty session", async () => {
    // The defect this rule exists for, measured on real files: two of the 17
    // sessions over 4MB on this machine end in a run of pure tool traffic with
    // their newest words 8.18MB and 11.68MB behind EOF, and a single
    // one-megabyte budget answered both with no turns at all. The operator
    // taps a session they plainly talked in and sees an empty pane.
    const path = sessionFile([...PREAMBLE, turn("user", "the last thing anybody said"), ...toolNoise(800)]);
    expect(statSync(path).size).toBeGreaterThan(TAIL_SOFT_MAX_BYTES);

    const tail = await readSessionTail(path);

    expect(tail.messages.map(m => m.text)).toEqual(["the last thing anybody said"]);
    // Past the soft budget by construction: the looking leg is what got there.
    expect(tail.bytesRead).toBeGreaterThan(TAIL_SOFT_MAX_BYTES);
  });

  test("the hard ceiling stops a walk that is finding nothing", async () => {
    // Same shape, but the words are further back than the ceiling allows. The
    // honest answer is no turns and `truncated`, not an unbounded read.
    const path = sessionFile([...PREAMBLE, turn("user", "long ago"), ...toolNoise(200)]);

    const tail = await readSessionTail(path, { softMaxBytes: 8192, hardMaxBytes: 64 * 1024 });

    expect(tail.messages).toEqual([]);
    expect(tail.truncated).toBe(true);
    expect(tail.bytesRead).toBeLessThanOrEqual(64 * 1024);
  });

  test("the collecting leg ends the read, and the answer says so", async () => {
    // Every line is a turn here, so the looking leg ends in the first chunk
    // and the collecting leg is what stops the walk.
    const noise: unknown[] = [];
    for (let i = 0; i < 200; i++) noise.push(turn("user", `filler-${String(i).padStart(3, "0")}`.padEnd(2000, "-")));
    const path = sessionFile([...PREAMBLE, ...noise]);
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(COUNT_CHUNK_BYTES * 2);

    const tail = await readSessionTail(path, { limit: TAIL_MAX_MESSAGES, softMaxBytes: COUNT_CHUNK_BYTES });

    // Two legs at most, and the budget is enforced at chunk granularity
    // because a chunk is the unit of real I/O.
    expect(tail.bytesRead).toBeLessThanOrEqual(COUNT_CHUNK_BYTES * 2);
    expect(tail.bytesRead).toBeLessThan(size);
    expect(tail.messages.length).toBeGreaterThan(0);
    expect(tail.messages.length).toBeLessThan(TAIL_MAX_MESSAGES);
    expect(tail.truncated).toBe(true);
    expect(tail.messages.at(-1)?.text.startsWith("filler-199")).toBe(true);
  });

  test("the read hands the event loop on while it runs", async () => {
    // No turn anywhere in the file, so the read walks a whole budget rather
    // than stopping early: the worst case for responsiveness.
    const path = sessionFile([...PREAMBLE, ...toolNoise(500)]);

    let ticks = 0;
    let pumping = true;
    const pump = (): void => {
      if (!pumping) return;
      ticks += 1;
      setImmediate(pump);
    };
    setImmediate(pump);

    await readSessionTail(path, { limit: 30 });
    pumping = false;

    // One chunk is 64KiB and the fixture is about a megabyte, so a
    // cooperative read gives the loop many turns. A read that blocked would
    // let the pump run once, at most.
    expect(ticks).toBeGreaterThan(5);
  });

  test("one enormous turn is cut with the cut mark rather than shipped whole", async () => {
    const huge = "z".repeat(TAIL_MAX_TEXT_BYTES * 2);
    const path = sessionFile([...PREAMBLE, turn("user", huge)]);

    const tail = await readSessionTail(path);
    const [message] = tail.messages;

    expect(message).toBeDefined();
    expect(message?.text.endsWith(TAIL_TEXT_CUT_MARK)).toBe(true);
    expect(Buffer.byteLength(message?.text ?? "", "utf8")).toBeLessThanOrEqual(
      TAIL_MAX_TEXT_BYTES + Buffer.byteLength(TAIL_TEXT_CUT_MARK, "utf8"),
    );
  });

  test("a cut never splits a multi-byte character", async () => {
    // Every character is three bytes, so a byte-blind cut lands mid-sequence
    // and decodes to a replacement char.
    const wide = "文".repeat(TAIL_MAX_TEXT_BYTES);
    const path = sessionFile([...PREAMBLE, turn("assistant", wide)]);

    const tail = await readSessionTail(path);

    expect(tail.messages[0]?.text.includes("\ufffd")).toBe(false);
  });

  test("a limit above the ceiling is clamped, and a nonsense limit still answers", async () => {
    const lines: unknown[] = [...PREAMBLE];
    for (let i = 0; i < TAIL_MAX_MESSAGES + 20; i++) lines.push(turn("user", `turn-${i}`));
    const path = sessionFile(lines);

    const clamped = await readSessionTail(path, { limit: 10_000 });
    expect(clamped.messages.length).toBe(TAIL_MAX_MESSAGES);

    const zero = await readSessionTail(path, { limit: 0 });
    expect(zero.messages.length).toBe(1);
    expect(zero.messages[0]?.text).toBe(`turn-${TAIL_MAX_MESSAGES + 19}`);
  });

  test("a missing file answers with an empty tail instead of throwing", async () => {
    const tail = await readSessionTail("/no/such/session.jsonl");

    expect(tail).toEqual({ messages: [], truncated: false, bytesRead: 0, nextCursor: null });
  });

  test("an empty file answers with an empty tail", async () => {
    const path = tempFile("empty.jsonl", "");

    const tail = await readSessionTail(path);

    expect(tail.messages).toEqual([]);
    expect(tail.truncated).toBe(false);
  });

  test("malformed lines are skipped without losing the turns around them", async () => {
    const path = tempFile(
      "malformed.jsonl",
      [
        JSON.stringify(turn("user", "before")),
        "not valid json at all",
        JSON.stringify(turn("assistant", "after")),
        "",
      ].join("\n"),
    );

    const tail = await readSessionTail(path);

    expect(tail.messages.map(m => m.text)).toEqual(["before", "after"]);
  });

  test("a file with no trailing newline still yields its last turn", async () => {
    // The writer normally terminates every line, but a session killed
    // mid-write does not, and the last turn is the one the operator most
    // wants to see.
    const path = tempFile(
      "unterminated.jsonl",
      [JSON.stringify(turn("user", "first")), JSON.stringify(turn("assistant", "last"))].join("\n"),
    );

    const tail = await readSessionTail(path);

    expect(tail.messages.map(m => m.text)).toEqual(["first", "last"]);
    expect(tail.truncated).toBe(false);
  });

  test("a turn spanning many chunks is reassembled, not split", async () => {
    // One line far larger than the 64KiB read chunk: the backward walk has to
    // carry its bytes across chunks and concatenate them in the right order.
    const long = "w".repeat(200_000);
    const path = sessionFile([...PREAMBLE, turn("user", long)]);

    const tail = await readSessionTail(path);

    expect(tail.messages.length).toBe(1);
    expect(tail.messages[0]?.role).toBe("user");
    // Cut to the text cap, but the visible prefix proves the reassembly
    // decoded one coherent line rather than a shuffled one.
    expect(tail.messages[0]?.text.startsWith("wwww")).toBe(true);
    expect(tail.messages[0]?.text.endsWith(TAIL_TEXT_CUT_MARK)).toBe(true);
  });

  test("a line-level timestamp is carried through, and its absence is empty rather than invented", async () => {
    const path = sessionFile([
      ...PREAMBLE,
      { type: "message", id: "a", message: { role: "user", content: "no stamp" } },
      turn("assistant", "stamped", "2026-08-13T12:34:56.789Z"),
    ]);

    const tail = await readSessionTail(path);

    expect(tail.messages).toEqual([
      { role: "user", text: "no stamp", at: "" },
      { role: "assistant", text: "stamped", at: "2026-08-13T12:34:56.789Z" },
    ]);
  });

  // -------------------------------------------------------------------------
  // Paging backwards through the file, from a cursor each page hands back.
  // A live terminal session's whole history is reachable only this way: the
  // tail is a window, and the cursor is what moves the window.
  // -------------------------------------------------------------------------
  describe("paging backwards through the file", () => {
    test("three pages walk a ten-turn file to its start, in order, with nothing repeated or lost", async () => {
      const lines: unknown[] = [...PREAMBLE];
      for (let i = 1; i <= 10; i++) lines.push(turn(i % 2 === 0 ? "assistant" : "user", `turn-${i}`));
      const path = sessionFile(lines);

      const seen: string[] = [];
      const costs: number[] = [];
      let cursor: number | undefined;
      let pages = 0;
      for (;;) {
        const page = await readSessionTail(path, { limit: 4, ...(cursor === undefined ? {} : { cursor }) });
        pages += 1;
        costs.push(page.bytesRead);
        seen.push(...page.messages.map(m => m.text));
        expect(page.messages.length).toBeLessThanOrEqual(4);
        // Each page is oldest first, and every page after the first is
        // entirely older than the one before it: the union arrives in
        // conversation order without any client-side sorting.
        if (page.nextCursor === null) break;
        expect(page.nextCursor).toBeGreaterThan(0);
        cursor = page.nextCursor;
      }

      expect(pages).toBe(3);
      expect(seen).toEqual([
        "turn-7",
        "turn-8",
        "turn-9",
        "turn-10",
        "turn-3",
        "turn-4",
        "turn-5",
        "turn-6",
        "turn-1",
        "turn-2",
      ]);
      // Every page cost real bytes and none cost more than one pair of legs.
      expect(costs.every(cost => cost > 0 && cost <= TAIL_SOFT_MAX_BYTES * 2)).toBe(true);
    });

    test("the turn read past the limit is never lost between pages", async () => {
      // The limit walk reads one turn past the cut to prove `truncated`, and
      // that turn's words are never sent. A cursor placed beneath it would
      // strand it: sent by no page, skipped by the next. The cursor must sit
      // above it, so the next page opens with exactly those words.
      const path = sessionFile([
        ...PREAMBLE,
        turn("user", "the oldest"),
        turn("assistant", "the middle"),
        turn("user", "the newest"),
      ]);

      const first = await readSessionTail(path, { limit: 1 });
      expect(first.messages.map(m => m.text)).toEqual(["the newest"]);
      expect(first.nextCursor).not.toBeNull();

      const second = await readSessionTail(path, { limit: 1, cursor: first.nextCursor! });
      expect(second.messages.map(m => m.text)).toEqual(["the middle"]);

      const third = await readSessionTail(path, { limit: 1, cursor: second.nextCursor! });
      expect(third.messages.map(m => m.text)).toEqual(["the oldest"]);
      expect(third.nextCursor).toBeNull();
    });

    test("a page can be empty with megabytes behind it, and the cursor still advances", async () => {
      // The interesting page: the budget ends mid-run-of-tool-traffic, so
      // the page carries no words while the file holds plenty behind it.
      // Stopping there would strand the operator mid-file; advancing the
      // cursor is what makes continuing possible.
      const path = sessionFile([
        ...PREAMBLE,
        turn("user", "words before the noise"),
        ...toolNoise(200),
        turn("assistant", "words after the noise"),
      ]);
      const size = statSync(path).size;

      const first = await readSessionTail(path, { limit: 1, softMaxBytes: 8192, hardMaxBytes: 64 * 1024 });
      expect(first.messages.map(m => m.text)).toEqual(["words after the noise"]);
      expect(first.nextCursor).not.toBeNull();

      const empty = await readSessionTail(path, {
        limit: 1,
        cursor: first.nextCursor!,
        softMaxBytes: 8192,
        hardMaxBytes: 64 * 1024,
      });
      expect(empty.messages).toEqual([]);
      expect(empty.truncated).toBe(true);
      // Advanced into the noise but not past the whole file: the cursor is
      // what lets the next ask start deeper rather than repeat this one.
      expect(empty.nextCursor).not.toBeNull();
      expect(empty.nextCursor!).toBeGreaterThan(0);
      expect(empty.nextCursor!).toBeLessThan(first.nextCursor!);
      expect(size).toBeGreaterThan(first.bytesRead);

      // Asking on from the empty page's cursor reaches the words behind the
      // noise: no page-after-page dead end.
      let cursor = empty.nextCursor;
      const texts: string[] = [];
      let asks = 0;
      while (cursor !== null && asks < 20) {
        asks += 1;
        const page = await readSessionTail(path, {
          limit: 1,
          cursor: cursor ?? undefined,
          softMaxBytes: 8192,
          hardMaxBytes: 64 * 1024,
        });
        texts.push(...page.messages.map(m => m.text));
        cursor = page.nextCursor;
      }
      expect(texts).toEqual(["words before the noise"]);
    });

    test("exhaustion answers the file's first turn and then a real, empty end", async () => {
      const path = sessionFile([...PREAMBLE, turn("user", "first ever"), turn("assistant", "last ever")]);

      const first = await readSessionTail(path, { limit: 1 });
      expect(first.messages.map(m => m.text)).toEqual(["last ever"]);
      const second = await readSessionTail(path, { limit: 1, cursor: first.nextCursor! });
      expect(second.messages.map(m => m.text)).toEqual(["first ever"]);
      expect(second.nextCursor).toBeNull();
      expect(second.truncated).toBe(false);

      // The file's start is an answer, not a spinner: asking past it costs
      // nothing and says so plainly.
      const past = await readSessionTail(path, { limit: 1, cursor: 0 });
      expect(past).toEqual({ messages: [], truncated: false, bytesRead: 0, nextCursor: null });
    });

    test("a cursor at or past the end of file answers exhausted rather than re-serving the newest turns", async () => {
      const path = sessionFile([...PREAMBLE, turn("user", "only turn")]);
      const size = statSync(path).size;

      expect(await readSessionTail(path, { cursor: size })).toEqual({
        messages: [],
        truncated: false,
        bytesRead: 0,
        nextCursor: null,
      });
      // Past the end can only mean the file shrank under a stale cursor.
      expect(await readSessionTail(path, { cursor: size * 10 })).toEqual({
        messages: [],
        truncated: false,
        bytesRead: 0,
        nextCursor: null,
      });
    });

    test("a cursor stays valid while the live session appends", async () => {
      // Session files grow at the end. A page taken before an append and a
      // page taken from its cursor after must agree, because the wire
      // protocol's whole paging scheme rests on those offsets not moving.
      const path = tempFile("growing.jsonl", "");
      const lines: unknown[] = [...PREAMBLE, turn("user", "old one"), turn("assistant", "old two")];
      writeFileSync(path, `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);

      const first = await readSessionTail(path, { limit: 1 });
      expect(first.messages.map(m => m.text)).toEqual(["old two"]);

      writeFileSync(
        path,
        `${[...lines.map(line => JSON.stringify(line)), JSON.stringify(turn("user", "appended live"))].join("\n")}\n`,
      );

      const second = await readSessionTail(path, { limit: 1, cursor: first.nextCursor! });
      expect(second.messages.map(m => m.text)).toEqual(["old one"]);
      expect(second.nextCursor).toBeNull();
    });
  });
});

describe("tailText", () => {
  test("joins only text blocks, in order, and says nothing for a turn that spoke none", () => {
    expect(
      tailText([
        { type: "thinking", text: "hmm" },
        { type: "text", text: "first" },
        { type: "toolCall", toolName: "bash" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
    expect(tailText([{ type: "toolCall", toolName: "bash" }])).toBe("");
    expect(tailText([{ type: "text", text: "" }])).toBe("");
  });

  test("a bare string is its own text, and a shape with no words is empty", () => {
    expect(tailText("typed by hand")).toBe("typed by hand");
    expect(tailText(null)).toBe("");
    expect(tailText(undefined)).toBe("");
    expect(tailText(42)).toBe("");
    expect(tailText([null, "loose", { type: "text" }])).toBe("");
  });
});

process.on("exit", () => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
