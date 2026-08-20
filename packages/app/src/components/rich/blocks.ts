/**
 * The block model every rich transcript renderer agrees on.
 *
 * Agent replies arrive as one string. Today the transcript renders that string
 * raw, so a reply full of markdown, a diff, or an image reference reads as
 * punctuation soup on a phone. Three renderers fix that, and this file is the
 * contract between them so none of them has to guess what the others emit.
 *
 * The split is deliberate. `parseRich` is pure and owns structure only: it
 * decides what a run of text IS, never how it looks. Presentation lives in the
 * components, which is what lets the parser be tested against strings with no
 * renderer mounted, the same discipline `session/model.ts` already follows.
 *
 * A parser that cannot express something must not invent a shape for it. Text
 * it does not recognise stays a `prose` block with a single `text` span, which
 * renders exactly as today. That is the floor: this change can improve a reply
 * but must never lose one.
 */

/** Inline runs inside a block. Deliberately flat: no span nests another. */
export type RichSpan =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

/**
 * One attachment the agent referenced. `uri` is whatever the daemon gave us
 * and may be remote, a data URI, or a blob ref the app resolves later; the
 * renderer decides what it can display and says so honestly when it cannot.
 */
export interface AttachmentRef {
  uri: string;
  /** Best-known MIME type, or null when the daemon did not say. */
  mime: string | null;
  /** Display name, falling back to the last path segment. */
  name: string;
  /** Bytes when known, for a size hint before a large fetch. */
  bytes: number | null;
}

export type RichBlock =
  | { kind: "prose"; spans: RichSpan[] }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; spans: RichSpan[] }
  | { kind: "list"; ordered: boolean; items: RichSpan[][] }
  | { kind: "quote"; spans: RichSpan[] }
  | { kind: "code"; lang: string | null; text: string }
  | { kind: "rule" }
  | { kind: "attachment"; ref: AttachmentRef };

/**
 * Structure only, no styling decisions.
 *
 * Note there is no `diff` block. A diff arrives as a fenced code block, and
 * whether one IS a diff is the diff renderer's judgement, not the parser's:
 * `isDiffText` in `./DiffBlock.tsx` makes that call at render time. Keeping it
 * out of the parser means a wrong guess degrades to a normal code block rather
 * than to a mangled one.
 */
export type ParseRich = (text: string) => RichBlock[];
