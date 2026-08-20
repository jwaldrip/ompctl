/**
 * Markdown to rich blocks, pure, no React.
 *
 * Agent replies are markdown whether we like it or not: the models are trained
 * on it and no instruction has ever stopped one from emitting `**bold**`. The
 * transcript used to render that raw, which a desktop reader tolerates and a
 * phone does not. This module decides what a reply IS; `RichText.tsx` decides
 * how it looks, which keeps both testable in the way each needs.
 *
 * The floor is the contract: anything this parser does not recognise stays a
 * `prose` block with a single `text` span, byte for byte what the raw renderer
 * showed. A parser bug must never eat a reply, so every matcher here fails
 * towards "leave it as text" rather than towards "best guess structure".
 *
 * Streaming sets the cost model. This runs on every token of a live reply, so
 * it is one linear pass over the lines and one over each paragraph's
 * characters, with no regex backtracking and no allocation beyond the blocks
 * it returns.
 */

import type { AttachmentRef, ParseRich, RichBlock, RichSpan } from "./blocks.ts";

// -- line matchers -------------------------------------------------------------
//
// Everything is anchored to a single line on purpose: a block that can be
// decided per line can be decided in one pass, and a construct this file
// cannot decide per line (tables, nested lists) is a construct it declines.

/** Leading indentation markdown actually allows before a block marker. */
const INDENT = /^[ \t]{0,3}/;

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const QUOTE = /^[ \t]{0,3}>[ \t]?/;
const UNORDERED = /^[ \t]{0,3}[-+*][ \t]+(.*)$/;
const ORDERED = /^[ \t]{0,3}\d{1,9}[.)][ \t]+(.*)$/;
const IMAGE = /^[ \t]{0,3}!\[([^\]]*)\]\(([^()[\]\s]+)\)[ \t]*$/;

/**
 * A thematic break: three or more of one marker character, spaces allowed.
 * The backreference keeps `-*-` out, which is a list-shaped string a parser
 * has no business silently promoting to a rule.
 */
function isRule(line: string): boolean {
  const squeezed = line.replaceAll(" ", "").replaceAll("\t", "");
  return squeezed.length >= 3 && /^([-*_])\1{2,}$/.test(squeezed);
}

/**
 * Whether a line opens a block this scanner understands. Only the prose
 * collector asks: it needs to know where a paragraph stops being one.
 */
function opensBlock(line: string): boolean {
  const bare = line.replace(INDENT, "");
  return (
    FENCE.test(line) ||
    QUOTE.test(line) ||
    UNORDERED.test(line) ||
    ORDERED.test(line) ||
    IMAGE.test(line) ||
    HEADING.test(bare) ||
    isRule(line)
  );
}

// -- inline matcher ------------------------------------------------------------

/** A link whose destination has no spaces or parentheses: `[text](href)`. */
const LINK = /\[([^\]]*)\]\(([^()[\]\s]+)\)/y;

/**
 * Emphasis needs content that does not start or end with whitespace, so
 * `2 * 3 * 4` and `** oops` degrade to literal text instead of becoming
 * italic soup around stray asterisks.
 */
function fitsEmphasis(inner: string): boolean {
  return inner.length > 0 && !inner.startsWith(" ") && !inner.endsWith(" ");
}

/** Code spans drop one space from each edge when both edges have one. */
function stripCodeEdges(content: string): string {
  if (content.length >= 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim().length > 0) {
    return content.slice(1, -1);
  }
  return content;
}

/**
 * Inline runs: `**strong**`, `*em*`, `_em_`, `` `code` ``, `[text](href)`.
 *
 * Spans are deliberately flat (see `blocks.ts`), so a bold phrase containing
 * an asterisk pair keeps those asterisks as characters. That is the honest
 * degrade: a wrong guess about nesting shows up as visible punctuation, which
 * an operator can read past, never as silently dropped words.
 */
function parseSpans(text: string): RichSpan[] {
  const spans: RichSpan[] = [];
  let literal = "";
  let at = 0;

  // One flush per span boundary rather than a pending-text buffer per branch:
  // every matcher below either emits or appends, never both.
  const flush = (): void => {
    if (literal.length > 0) {
      spans.push({ kind: "text", text: literal });
      literal = "";
    }
  };

  while (at < text.length) {
    const ch = text[at] as string;

    if (ch === "`") {
      const close = text.indexOf("`", at + 1);
      if (close === -1) {
        literal += ch;
        at += 1;
        continue;
      }
      flush();
      spans.push({ kind: "code", text: stripCodeEdges(text.slice(at + 1, close)) });
      at = close + 1;
      continue;
    }

    if (ch === "*") {
      if (text.startsWith("**", at)) {
        const close = text.indexOf("**", at + 2);
        const inner = close === -1 ? "" : text.slice(at + 2, close);
        if (close !== -1 && fitsEmphasis(inner)) {
          flush();
          spans.push({ kind: "strong", text: inner });
          at = close + 2;
          continue;
        }
        literal += "**";
        at += 2;
        continue;
      }
      const close = text.indexOf("*", at + 1);
      const inner = close === -1 ? "" : text.slice(at + 1, close);
      if (close !== -1 && fitsEmphasis(inner)) {
        flush();
        spans.push({ kind: "em", text: inner });
        at = close + 1;
        continue;
      }
      literal += "*";
      at += 1;
      continue;
    }

    if (ch === "_") {
      // Underscore emphasis only opens at a word boundary and closes away
      // from one, so `snake_case_name` stays literal on screen instead of
      // italicising half an identifier.
      const boundary = at === 0 || /[\s(]/.test(text[at - 1] as string);
      const close = text.indexOf("_", at + 1);
      const inner = close === -1 ? "" : text.slice(at + 1, close);
      if (boundary && close !== -1 && fitsEmphasis(inner) && !/[A-Za-z0-9]/.test(text[close + 1] ?? "")) {
        flush();
        spans.push({ kind: "em", text: inner });
        at = close + 1;
        continue;
      }
      literal += ch;
      at += 1;
      continue;
    }

    if (ch === "[") {
      LINK.lastIndex = at;
      const match = LINK.exec(text);
      // `![alt](uri)` is an image, not a link with a stray bang, so a bracket
      // preceded by `!` stays literal and the image survives verbatim for the
      // attachment renderer to find when it is on a line of its own.
      if (match !== null && text[at - 1] !== "!") {
        flush();
        spans.push({ kind: "link", text: match[1] as string, href: match[2] as string });
        at = LINK.lastIndex;
        continue;
      }
      literal += ch;
      at += 1;
      continue;
    }

    literal += ch;
    at += 1;
  }

  flush();
  return spans;
}

// -- attachments ----------------------------------------------------------------

/** A data URI states its own type and length, the only place markdown does. */
const DATA_URI = /^data:([^;,]*)(;base64)?,([^\s]*)$/i;

function attachmentFrom(alt: string, uri: string): AttachmentRef {
  let mime: string | null = null;
  let bytes: number | null = null;
  if (uri.startsWith("data:")) {
    const match = DATA_URI.exec(uri);
    if (match !== null) {
      mime = (match[1] as string) === "" ? null : (match[1] as string);
      if (match[2] !== undefined) {
        const payload = match[3] as string;
        // Base64 length maps to 6 bits per character, so decoded size is three
        // quarters of the payload after discounting `=` padding.
        const unpadded = payload.length - (payload.match(/=+$/)?.[0]?.length ?? 0);
        bytes = Math.floor((unpadded * 3) / 4);
      }
    }
  }

  let name = alt;
  if (name.length === 0) {
    const segment = uri
      .replace(/[?#].*$/, "")
      .split("/")
      .pop();
    name = segment === undefined || segment.length === 0 ? "attachment" : segment;
  }

  return { uri, mime, name, bytes };
}

// -- the scan --------------------------------------------------------------------

export const parseRich: ParseRich = text => {
  const lines = text.split("\n");
  const blocks: RichBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Fenced code first: everything between the fences is literal, including
    // what would otherwise look like markers. Inline parsing never runs inside.
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = (fence[1] as string)[0] as string;
      const length = (fence[1] as string).length;
      const info = (fence[2] ?? "").trim().split(/\s+/)[0] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length) {
        const close = FENCE.exec(lines[i] as string);
        // A closer carries no info string (```` ```ts ```` inside a fence is
        // body, not the end), which is what keeps nested-markdown replies
        // intact when the agent quotes one fence inside another.
        if (
          close !== null &&
          (close[1] as string)[0] === marker &&
          (close[1] as string).length >= length &&
          (close[2] ?? "").trim().length === 0
        ) {
          i += 1;
          break;
        }
        body.push(lines[i] as string);
        i += 1;
      }
      // A reply still streaming an open fence ends here without a closer; the
      // block is honest about what has arrived rather than flashing raw.
      blocks.push({ kind: "code", lang: info.length === 0 ? null : info, text: body.join("\n") });
      continue;
    }

    if (isRule(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line.replace(INDENT, ""));
    if (heading !== null) {
      const level = (heading[1] as string).length as 1 | 2 | 3 | 4 | 5 | 6;
      // Trailing hash closes (`## Title ##`) carry no meaning; drop them.
      const content = ((heading[2] ?? "") as string).replace(/[ \t]+#+[ \t]*$/, "");
      blocks.push({ kind: "heading", level, spans: parseSpans(content) });
      i += 1;
      continue;
    }

    const image = IMAGE.exec(line);
    if (image !== null) {
      blocks.push({ kind: "attachment", ref: attachmentFrom(image[1] as string, image[2] as string) });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        quoted.push((lines[i] as string).replace(INDENT, "").replace(/^>[ \t]?/, ""));
        i += 1;
      }
      // One level only: the model has no nesting, so a quoted quote keeps its
      // inner marker as characters rather than inventing a shape for it.
      blocks.push({ kind: "quote", spans: parseSpans(quoted.join("\n")) });
      continue;
    }

    // One block per kind: the contract has a single `ordered` flag, so a
    // switch between `-` and `1.` starts a second list beside the first.
    const listOrdered = ORDERED.exec(line) !== null;
    const listItem = listOrdered ? ORDERED : UNORDERED;
    if (listOrdered || UNORDERED.exec(line) !== null) {
      const items: RichSpan[][] = [];
      while (i < lines.length) {
        const item = listItem.exec(lines[i] as string);
        if (item === null) {
          break;
        }
        items.push(parseSpans(item[1] as string));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: listOrdered, items });
      continue;
    }

    // Prose: consecutive lines that open nothing else, one paragraph. The
    // newlines survive inside text spans so a soft-wrapped reply keeps the
    // line breaks it had under the raw renderer.
    const prose: string[] = [];
    while (i < lines.length && (lines[i] as string).trim().length > 0 && !opensBlock(lines[i] as string)) {
      prose.push(lines[i] as string);
      i += 1;
    }
    blocks.push({ kind: "prose", spans: parseSpans(prose.join("\n")) });
  }

  return blocks;
};
