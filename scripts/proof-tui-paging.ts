/**
 * Paging proof against a real session file on this machine, read only.
 *
 * Not a test and not a fixture: the acceptance for terminal session history
 * is that a tool-heavy real file pages backwards, so this walks one with the
 * same reader the daemon serves `session_tail` from and prints each page's
 * turns and byte cost. Nothing is written to the operator's session files.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { readSessionTail } from "../packages/daemon/src/sessions/tail.ts";

const path = process.argv[2];
if (path === undefined) throw new Error("usage: bun scripts/proof-tui-paging.ts <session.jsonl> [pages] [limit]");
const wantPages = Number(process.argv[3] ?? 5);
const limit = Number(process.argv[4] ?? 30);

/** Whole-file block profile, so "tool heavy" is a measured claim about this file rather than a label. */
function profile(file: string): { toolCall: number; thinking: number; text: number; other: number; lines: number } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const chunk = Buffer.allocUnsafe(1 << 16);
    let pos = 0;
    let pending = "";
    const counts = { toolCall: 0, thinking: 0, text: 0, other: 0, lines: 0 };
    while (pos < size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      if (n === 0) break;
      pos += n;
      pending += chunk.toString("utf8", 0, n);
      let cut = pending.indexOf("\n");
      while (cut >= 0) {
        const line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        cut = pending.indexOf("\n");
        counts.lines += 1;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const row = parsed as { type?: string; message?: { content?: unknown } };
        if (row.type !== "message") continue;
        const content = row.message?.content;
        if (typeof content === "string") {
          counts.text += 1;
          continue;
        }
        if (!Array.isArray(content)) {
          counts.other += 1;
          continue;
        }
        let tool = false;
        let think = false;
        let words = false;
        for (const block of content as Array<{ type?: string; text?: string }>) {
          if (block?.type === "toolCall") tool = true;
          else if (block?.type === "thinking") think = true;
          else if (block?.type === "text" && block.text) words = true;
        }
        if (tool) counts.toolCall += 1;
        else if (think) counts.thinking += 1;
        else if (words) counts.text += 1;
        else counts.other += 1;
      }
    }
    return counts;
  } finally {
    closeSync(fd);
  }
}

const size = statSync(path).size;
const shape = profile(path);
console.log(`file    ${path}`);
console.log(`size    ${(size / 1048576).toFixed(2)}MB, ${shape.lines} lines`);
console.log(`turns   ${shape.toolCall} toolCall, ${shape.thinking} thinking, ${shape.text} text, ${shape.other} other`);
console.log(`ask     limit ${limit}, default budgets\n`);

let cursor: number | undefined;
let totalBytes = 0;
let totalTurns = 0;
for (let page = 1; page <= wantPages; page++) {
  const started = performance.now();
  const answer = await readSessionTail(path, { limit, ...(cursor === undefined ? {} : { cursor }) });
  const took = performance.now() - started;
  totalBytes += answer.bytesRead;
  totalTurns += answer.messages.length;
  const first = answer.messages[0];
  const last = answer.messages.at(-1);
  console.log(
    `page ${page}: ${String(answer.messages.length).padStart(2)} turns, ` +
      `${(answer.bytesRead / 1048576).toFixed(2)}MB read in ${took.toFixed(0)}ms, ` +
      `from ${cursor ?? "EOF"} -> nextCursor ${answer.nextCursor ?? "start of file"}`,
  );
  for (const message of answer.messages) {
    const words = message.text.replace(/\s+/g, " ").slice(0, 96);
    console.log(`         ${message.at || "(no stamp)"} ${message.role.padEnd(9)} ${words}`);
  }
  if (first !== undefined && last !== undefined && first.at !== "" && last.at !== "") {
    console.log(`         oldest ${first.at} .. newest ${last.at}`);
  }
  console.log();
  if (answer.nextCursor === null) {
    console.log("reached the start of the file");
    break;
  }
  cursor = answer.nextCursor;
}
console.log(
  `total   ${totalTurns} turns over ${(totalBytes / 1048576).toFixed(2)}MB read, ` +
    `${((totalBytes / size) * 100).toFixed(1)}% of the file`,
);
