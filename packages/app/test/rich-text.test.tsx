/**
 * The rich transcript renderer, tested at both halves of its contract.
 *
 * `parseRich` is tested as pure input/output because that is the deal in
 * `rich/blocks.ts`: structure decisions live in a module with no renderer, so
 * a wrong guess shows up as a failing string assertion rather than as a
 * misrendered component a screenshot has to catch.
 *
 * The seam test exists because the swap to rich rendering has one hard
 * invariant: the row's accessibility label still carries the full raw reply.
 * The round-trip gate reads that label for a sent token, the iOS UI tests
 * match rows by it, and a prettier reply that blinds both is a regression
 * dressed as a feature. The same render also proves the pixels changed: the
 * markdown markers the label keeps are gone from what is actually drawn.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Entry } from "../src/session/model.ts";

// Dynamic on purpose: `./rnw.ts` must mock react-native before the component
// modules load, so these cannot be static imports (see rnw.ts).
const { parseRich } = await import("../src/components/rich/parse.ts");
const { OmpEntryRow } = await import("../src/assistant/renderers.tsx");
const { highlight } = await import("../src/components/rich/highlight.ts");
const { KEYWORD_COLOR } = await import("../src/components/rich/highlight-theme.ts");
const { RichText } = await import("../src/components/rich/RichText.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("parseRich", () => {
  test("plain text stays one prose block with one text span", () => {
    expect(parseRich("just checking in")).toEqual([
      { kind: "prose", spans: [{ kind: "text", text: "just checking in" }] },
    ]);
    // Soft-wrapped lines keep their breaks: the raw renderer showed them.
    expect(parseRich("line one\nline two")).toEqual([
      { kind: "prose", spans: [{ kind: "text", text: "line one\nline two" }] },
    ]);
  });

  test("ATX headings carry their level and drop trailing hashes", () => {
    expect(parseRich("# Title")).toEqual([{ kind: "heading", level: 1, spans: [{ kind: "text", text: "Title" }] }]);
    expect(parseRich("### Deep **one**")).toEqual([
      {
        kind: "heading",
        level: 3,
        spans: [
          { kind: "text", text: "Deep " },
          { kind: "strong", text: "one" },
        ],
      },
    ]);
    expect(parseRich("## Trailing ##")).toEqual([
      { kind: "heading", level: 2, spans: [{ kind: "text", text: "Trailing" }] },
    ]);
  });

  test("consecutive marker lines become one list per kind", () => {
    expect(parseRich("- one\n- two")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [{ spans: [{ kind: "text", text: "one" }] }, { spans: [{ kind: "text", text: "two" }] }],
      },
    ]);
    // Both ordered terminators count, because agents mix them mid-list.
    expect(parseRich("1. a\n2) b")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [{ spans: [{ kind: "text", text: "a" }] }, { spans: [{ kind: "text", text: "b" }] }],
      },
    ]);
  });

  test("consecutive quote lines merge into one block, one level deep", () => {
    expect(parseRich("> a\n> **b**")).toEqual([
      {
        kind: "quote",
        spans: [
          { kind: "text", text: "a\n" },
          { kind: "strong", text: "b" },
        ],
      },
    ]);
    // The model has no nesting, so the inner marker stays as characters.
    expect(parseRich("> > inner")).toEqual([{ kind: "quote", spans: [{ kind: "text", text: "> inner" }] }]);
  });

  test("fenced code captures a language and keeps its body verbatim", () => {
    expect(parseRich("```ts\nconst x = **not**;\n```")).toEqual([
      { kind: "code", lang: "ts", text: "const x = **not**;" },
    ]);
    expect(parseRich("```\nplain\n```")).toEqual([{ kind: "code", lang: null, text: "plain" }]);
  });

  test("inline parsing never runs inside a fence", () => {
    expect(parseRich("```md\n**bold** and `code` and [link](https://x.dev)\n```")).toEqual([
      {
        kind: "code",
        lang: "md",
        text: "**bold** and `code` and [link](https://x.dev)",
      },
    ]);
  });

  test("a reply still streaming an open fence ends in a code block, not raw soup", () => {
    expect(parseRich("before\n```sh\necho hi")).toEqual([
      { kind: "prose", spans: [{ kind: "text", text: "before" }] },
      { kind: "code", lang: "sh", text: "echo hi" },
    ]);
  });

  test("thematic breaks become rules", () => {
    expect(parseRich("intro\n\n---\n\nafter")).toEqual([
      { kind: "prose", spans: [{ kind: "text", text: "intro" }] },
      { kind: "rule" },
      { kind: "prose", spans: [{ kind: "text", text: "after" }] },
    ]);
  });

  test("inline strong, em, code, and link each become their own span", () => {
    expect(parseRich("**auth** *retry* _quiet_ `backoff=2` [notes](https://hub.ompctl.ai/a?b=1)")).toEqual([
      {
        kind: "prose",
        spans: [
          { kind: "strong", text: "auth" },
          { kind: "text", text: " " },
          { kind: "em", text: "retry" },
          { kind: "text", text: " " },
          { kind: "em", text: "quiet" },
          { kind: "text", text: " " },
          { kind: "code", text: "backoff=2" },
          { kind: "text", text: " " },
          { kind: "link", text: "notes", href: "https://hub.ompctl.ai/a?b=1" },
        ],
      },
    ]);
  });

  test("ambiguous and unclosed markers stay literal", () => {
    const raw = "2 * 3 * 4 and snake_case_name and ** oops";
    expect(parseRich(raw)).toEqual([{ kind: "prose", spans: [{ kind: "text", text: raw }] }]);
  });

  test("a standalone image becomes an attachment filled from the markdown alone", () => {
    expect(parseRich("![shot](https://x.dev/path/shot.png)")).toEqual([
      {
        kind: "attachment",
        ref: { uri: "https://x.dev/path/shot.png", mime: null, name: "shot", bytes: null },
      },
    ]);
    // Empty alt falls back to the last path segment, query string aside.
    expect(parseRich("![](https://x.dev/d/shot.png?v=2)")).toEqual([
      {
        kind: "attachment",
        ref: { uri: "https://x.dev/d/shot.png?v=2", mime: null, name: "shot.png", bytes: null },
      },
    ]);
    // A data URI is the one source that states its own type and length.
    expect(parseRich("![tiny](data:image/png;base64,iVBORw0KGgo=)")).toEqual([
      {
        kind: "attachment",
        ref: { uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png", name: "tiny", bytes: 8 },
      },
    ]);
  });

  test("an image mid-sentence stays literal text rather than a mangled link", () => {
    const raw = "here ![inline](https://x.dev/i.png) mid";
    expect(parseRich(raw)).toEqual([{ kind: "prose", spans: [{ kind: "text", text: raw }] }]);
  });

  test("unrecognised shapes degrade to prose, byte for byte", () => {
    const raw = "| lonely pipe with no delimiter";
    expect(parseRich(raw)).toEqual([{ kind: "prose", spans: [{ kind: "text", text: raw }] }]);
    expect(parseRich("")).toEqual([]);
  });
});

describe("the transcript seam", () => {
  const REPLY = [
    "# Deploy notes",
    "",
    "Shipped **auth** and *retry* with `backoff=2`; see [run](https://hub.ompctl.ai/run/9).",
    "",
    "- patch the hub",
    "- bump the client",
    "",
    "1. verify the label",
    "2. watch the tokens",
    "",
    "> quoted from the log",
    "",
    "```bash",
    "bun run check",
    "```",
    "",
    "---",
  ].join("\n");

  function mount(entries: readonly Entry[]): { host: HTMLElement; dispose: () => void } {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(entries.map(entry => <OmpEntryRow key={entry.id} entry={entry} canApprove onDecide={() => {}} />));
    });
    return {
      host,
      dispose: () => {
        act(() => {
          root.unmount();
        });
        host.remove();
      },
    };
  }

  test("the assistant row's accessibility label is still the full raw reply", () => {
    const entries: readonly Entry[] = [
      { kind: "assistant", id: "thought-1", rowId: "thought-1", text: REPLY, streaming: true, thought: true },
      { kind: "assistant", id: "reply-1", rowId: "reply-1", text: REPLY, streaming: true, thought: false },
    ];
    const { host, dispose } = mount(entries);
    // Both rows carry the same id on purpose: the path scenario enumerates
    // them by it, so this pins the contract that step depends on.
    const rows = host.querySelectorAll('[data-testid="entry-assistant"]');
    expect(rows).toHaveLength(2);

    const labelOf = (row: Element): string =>
      row.getAttribute("aria-label") ?? row.getAttribute("accessibilityLabel") ?? row.textContent ?? "";

    expect(labelOf(rows[0] as Element)).toBe(`thinking: ${REPLY}`);
    expect(labelOf(rows[1] as Element)).toBe(`agent: ${REPLY}`);

    // The pixels, though, render structure: the fence markers the label keeps
    // are gone from what is drawn, and the heading text is. Label raw, screen
    // rich, both at once.
    const drawn = (rows[1] as Element).textContent ?? "";
    expect(drawn).toContain("Deploy notes");
    expect(drawn).toContain("bun run check");
    expect(drawn).not.toContain("```");

    dispose();
  });
});

describe("repeated blocks keep distinct keys", () => {
  /**
   * A real reply contained two single-item numbered lists and two rules, and
   * React reported `Encountered two children with the same key, list:1:true`
   * on the device. Content is not an identity here: two rules both key to
   * "rule", and two identical paragraphs or lists collide the same way, which
   * React resolves by remounting rows rather than updating them.
   *
   * The renderer's own complaint is the assertion, because that is exactly
   * what a person saw: React writes duplicate keys to `console.error`.
   */
  test("a reply with repeated rules and identical lists draws no duplicate-key complaint", () => {
    const repeated = ["1. only", "", "---", "", "1. only", "", "---", "", "same line", "", "same line"].join("\n");
    const entries: readonly Entry[] = [
      { kind: "assistant", id: "r1", rowId: "r1", text: repeated, streaming: false, thought: false },
    ];

    const complaints: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      complaints.push(args.map(String).join(" "));
    };

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(entries.map(entry => <OmpEntryRow key={entry.id} entry={entry} canApprove onDecide={() => {}} />));
      });
    } finally {
      console.error = original;
    }

    expect(complaints.filter(line => line.includes("same key"))).toEqual([]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

describe("code fence syntax highlighting", () => {
  test('highlight("const a = 1", "ts") yields a keyword token and a number token', () => {
    const lines = highlight("const a = 1", "ts");
    expect(lines).toHaveLength(1);
    const tokens = lines[0];
    const kinds = tokens?.map(t => t.kind);
    expect(kinds).toContain("keyword");
    expect(kinds).toContain("number");
    const keywordToken = tokens?.find(t => t.kind === "keyword");
    expect(keywordToken?.text).toBe("const");
    const numberToken = tokens?.find(t => t.kind === "number");
    expect(numberToken?.text).toBe("1");
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

  test("RichText renders a fenced ts block with at least one span coloured from the theme", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<RichText text={"```ts\nconst a = 1;\n```"} />);
    });

    const spans = Array.from(host.querySelectorAll("span, div"));
    const colouredSpan = spans.find(el => {
      const style = el.getAttribute("style") ?? "";
      return (
        style.includes(KEYWORD_COLOR.toLowerCase()) ||
        style.includes(KEYWORD_COLOR.toUpperCase()) ||
        style.includes("139, 123, 196") ||
        style.includes("91, 157, 255")
      );
    });

    try {
      expect(colouredSpan).toBeDefined();
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});
