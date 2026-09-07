/**
 * Unit tests for syntax highlighting and theme mapping.
 */

import { describe, expect, test } from "bun:test";
import { highlight } from "../src/components/rich/highlight.ts";
import {
  COMMENT_COLOR,
  DEFAULT_COLOR,
  KEYWORD_COLOR,
  NUMBER_COLOR,
  PUNCTUATION_COLOR,
  STRING_COLOR,
  tokenColor,
} from "../src/components/rich/highlight-theme.ts";

describe("highlight tokenizer", () => {
  test('highlight("const a = 1", "ts") yields a keyword token and a number token', () => {
    const lines = highlight("const a = 1", "ts");
    expect(lines).toHaveLength(1);
    const tokens = lines[0] ?? [];
    const kinds = tokens.map(t => t.kind);
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("number");

    const kw = tokens.find(t => t.kind === "keyword");
    expect(kw?.text).toBe("const");
    const num = tokens.find(t => t.kind === "number");
    expect(num?.text).toBe("1");
  });

  test("an unknown language yields one plain token per line", () => {
    const lines = highlight("alpha\nbeta\ngamma", "unsupported-lang-404");
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line).toHaveLength(1);
      expect(line[0]?.kind).toBe("plain");
    }
    expect(lines[0]?.[0]?.text).toBe("alpha");
    expect(lines[1]?.[0]?.text).toBe("beta");
    expect(lines[2]?.[0]?.text).toBe("gamma");
  });

  test("null language yields one plain token per line", () => {
    const lines = highlight("plain line 1\nplain line 2", null);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.[0]).toEqual({ text: "plain line 1", kind: "plain" });
    expect(lines[1]?.[0]).toEqual({ text: "plain line 2", kind: "plain" });
  });

  test("all 15 required languages tokenize without error", () => {
    const samples: Record<string, string> = {
      typescript: "const n: number = 1;",
      javascript: "const n = 1;",
      jsx: 'const el = <div className="box">text</div>;',
      tsx: "const el: JSX.Element = <div>{n}</div>;",
      json: '{"status": "ok", "count": 10}',
      bash: 'echo "hello world" > /tmp/out',
      diff: "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new",
      markdown: "# Title\n**bold text**",
      python: "def greet(name):\n    return f'hi {name}'",
      go: "package main\nfunc main() {}",
      rust: "fn main() { let x = 42; }",
      css: ".card { color: #fff; padding: 8px; }",
      markup: "<section><p>hello</p></section>",
      yaml: "name: ompctl\nversion: 1.0\nitems:\n  - a",
      toml: '[server]\nport = 8080\nhost = "localhost"',
    };

    for (const [lang, code] of Object.entries(samples)) {
      const lines = highlight(code, lang);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const totalTokens = lines.reduce((acc, line) => acc + line.length, 0);
      expect(totalTokens).toBeGreaterThan(0);
    }
  });

  test("language aliases resolve to their canonical grammars", () => {
    const tsLines = highlight("const x = 1;", "ts");
    expect(tsLines[0]?.some(t => t.kind === "keyword")).toBe(true);

    const jsLines = highlight("const x = 1;", "js");
    expect(jsLines[0]?.some(t => t.kind === "keyword")).toBe(true);

    const pyLines = highlight("def foo(): pass", "py");
    expect(pyLines[0]?.some(t => t.kind === "keyword")).toBe(true);

    const shLines = highlight("echo hello", "sh");
    expect(shLines[0]?.some(t => t.kind === "builtin")).toBe(true);

    const ymlLines = highlight("key: val", "yml");
    expect(ymlLines[0]?.some(t => t.kind === "key")).toBe(true);

    const rsLines = highlight("fn main() {}", "rs");
    expect(rsLines[0]?.some(t => t.kind === "keyword")).toBe(true);
  });

  test("empty lines in highlighted code are preserved with an empty token", () => {
    const code = "const a = 1;\n\nconst b = 2;";
    const lines = highlight(code, "typescript");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.length).toBeGreaterThan(0);
    expect(lines[1]).toEqual([{ text: "", kind: "plain" }]);
    expect(lines[2]?.length).toBeGreaterThan(0);
  });

  test("tokens spanning newlines are split across line arrays", () => {
    const code = "/* multi\n   line\n   comment */\nconst x = 1;";
    const lines = highlight(code, "javascript");
    expect(lines).toHaveLength(4);
    expect(lines[0]?.[0]?.kind).toBe("comment");
    expect(lines[1]?.[0]?.kind).toBe("comment");
    expect(lines[2]?.[0]?.kind).toBe("comment");
    expect(lines[3]?.some(t => t.kind === "keyword")).toBe(true);
  });
});

describe("highlight theme mappings", () => {
  test("maps standard token kinds to design token colours", () => {
    expect(tokenColor("keyword")).toBe(KEYWORD_COLOR);
    expect(tokenColor("string")).toBe(STRING_COLOR);
    expect(tokenColor("number")).toBe(NUMBER_COLOR);
    expect(tokenColor("comment")).toBe(COMMENT_COLOR);
    expect(tokenColor("punctuation")).toBe(PUNCTUATION_COLOR);
    expect(tokenColor("plain")).toBe(DEFAULT_COLOR);
  });

  test("unmapped token kinds fall back to default colour", () => {
    expect(tokenColor("nonexistent-token-kind")).toBe(DEFAULT_COLOR);
  });
});
