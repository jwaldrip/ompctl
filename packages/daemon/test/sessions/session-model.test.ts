/**
 * Regression test for session model and role derivation from transcripts:
 * covering one model_change, several (last wins), one with a model and no role,
 * and a file with none.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@ompd/core";
import { countMessagesAsync, getSessionModel, getSessionRole } from "../../src/sessions/scanner.ts";
import { SessionIndex } from "../../src/sessions/session-index.ts";

const scratch: string[] = [];

function tempRoot(prefix: string): string {
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

function writeSession(dir: string, filenameTimestamp: string, id: string, records: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${filenameTimestamp}_${id}.jsonl`);
  writeFileSync(file, `${records.map(r => JSON.stringify(r)).join("\n")}\n`);
  return file;
}

describe("Session model and role from transcripts", () => {
  test("derives model and role across single, multiple, no-role, and no-model sessions", async () => {
    const root = tempRoot("sess-model-test-");
    const groupDir = join(root, "-alpha");
    const store = new Store(join(root, "store.db"));

    const idSingle = "019fee60-0001-7000-9000-000000000001";
    const idMultiple = "019fee60-0002-7000-9000-000000000002";
    const idNoRole = "019fee60-0003-7000-9000-000000000003";
    const idNone = "019fee60-0004-7000-9000-000000000004";

    // 1. One model_change
    const fileSingle = writeSession(groupDir, "2026-08-11T01-11-48-090Z", idSingle, [
      { type: "title", title: "Single Model" },
      { type: "session", cwd: "/alpha" },
      { type: "model_change", model: "anthropic/claude-opus-5", role: "slow" },
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", content: "hello" } },
    ]);

    // 2. Several model_change records (last wins mid-run switch)
    const fileMultiple = writeSession(groupDir, "2026-08-11T01-11-49-090Z", idMultiple, [
      { type: "title", title: "Multiple Models" },
      { type: "session", cwd: "/alpha" },
      { type: "model_change", model: "anthropic/claude-opus-5", role: "slow" },
      { type: "message", message: { role: "user", content: "step 1" } },
      { type: "model_change", model: "google-antigravity/gemini-3.8-flash", role: "smol" },
      { type: "message", message: { role: "assistant", content: "step 2" } },
    ]);

    // 3. One model_change with a model and no role
    const fileNoRole = writeSession(groupDir, "2026-08-11T01-11-50-090Z", idNoRole, [
      { type: "title", title: "Model No Role" },
      { type: "session", cwd: "/alpha" },
      { type: "model_change", model: "openai/gpt-5.4" },
      { type: "message", message: { role: "user", content: "question" } },
    ]);

    // 4. A file with none
    const fileNone = writeSession(groupDir, "2026-08-11T01-11-51-090Z", idNone, [
      { type: "title", title: "No Model Change" },
      { type: "session", cwd: "/alpha" },
      { type: "message", message: { role: "user", content: "raw session" } },
    ]);

    await countMessagesAsync(fileSingle);
    await countMessagesAsync(fileMultiple);
    await countMessagesAsync(fileNoRole);
    await countMessagesAsync(fileNone);

    expect(getSessionModel(idSingle)).toBe("anthropic/claude-opus-5");
    expect(getSessionRole(idSingle)).toBe("slow");

    expect(getSessionModel(idMultiple)).toBe("google-antigravity/gemini-3.8-flash");
    expect(getSessionRole(idMultiple)).toBe("smol");

    expect(getSessionModel(idNoRole)).toBe("openai/gpt-5.4");
    expect(getSessionRole(idNoRole)).toBeNull();

    expect(getSessionModel(idNone)).toBeNull();
    expect(getSessionRole(idNone)).toBeNull();

    const emptyRun = tempRoot("empty-run-");
    const index = new SessionIndex({ store, sessionsRoot: root, runDaemonsRoot: emptyRun });
    const summaries = await index.build();

    const sSingle = summaries.find(s => s.id === idSingle);
    const sMultiple = summaries.find(s => s.id === idMultiple);
    const sNoRole = summaries.find(s => s.id === idNoRole);
    const sNone = summaries.find(s => s.id === idNone);

    expect(sSingle?.model).toBe("anthropic/claude-opus-5");
    expect(sSingle?.role).toBe("slow");

    expect(sMultiple?.model).toBe("google-antigravity/gemini-3.8-flash");
    expect(sMultiple?.role).toBe("smol");

    expect(sNoRole?.model).toBe("openai/gpt-5.4");
    expect(sNoRole?.role).toBeNull();

    expect(sNone?.model).toBeNull();
    expect(sNone?.role).toBeNull();
  });
});
