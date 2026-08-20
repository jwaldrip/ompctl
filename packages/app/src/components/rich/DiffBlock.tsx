/**
 * The diff renderer: one kind of code block, judged here rather than parsed.
 *
 * `blocks.ts` deliberately has no diff kind. A fenced block claims to be many
 * things and a parser that guessed would hand the renderers a block it cannot
 * back out of, so the judgement lives at render time: `isDiffText` decides
 * whether a code block is a diff, and when it says no the caller keeps the
 * ordinary code rendering. The worst a wrong guess can do is what the
 * transcript already did before this file existed, which is the only safe
 * direction to fail in.
 *
 * Encoding: every changed line carries its sign, `+` or `-`, in a fixed gutter
 * as well as a tone. Colour alone is decoration, not a signal: a reader with
 * any of the common colour vision deficiencies loses red-versus-green on the
 * first glance, while a glyph is legible to everyone, survives a greyscale
 * screenshot, and names its own meaning.
 *
 * Long lines wrap rather than scroll. A horizontal scroll region nested in
 * the vertically scrolling transcript is a trap on a touch screen, the same
 * reason `ToolCard` clamps its output instead of scrolling it, and a wrapped
 * line keeps every character reachable with no gesture at all.
 */

import type { JSX } from "react";
import { StyleSheet, View } from "react-native";
import { Code } from "../../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke } from "../../design/tokens.ts";

/**
 * Fenced-block tags that declare a diff by intent. Whoever wrote the fence
 * said what the block is; the row rendering degrades anything inside that is
 * not diff grammar to a plain context line, so honouring the tag cannot
 * mangle the block the way a structural guess on untagged text can.
 */
const DIFF_LANGS: Record<string, true> = { diff: true, patch: true, udiff: true };
/**
 * `@@ -10,4 +10,5 @@ optional section heading`. The three-at form merges
 * produce is included; nothing outside diff grammar starts a line like this.
 */
const HUNK = /^@+( -\d+(?:,\d+)?)+ \+\d+(?:,\d+)? @/;

/**
 * File headers. Content after the marker is required on purpose: a bare
 * `---` is a Markdown rule or a YAML fence, and pairing `--- ` with `+++ `
 * below is what makes the two impossible to mistake for one another.
 */
const OLD_FILE = /^--- \S/;
const NEW_FILE = /^\+\+\+ \S/;

/** `diff --git a/x b/x`, the boundary between files in a multi-file diff. */
const GIT_BOUNDARY = /^diff --git /;

/** Git patch furniture that is neither content nor a file identity. */
const GIT_META =
  /^(?:index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|\\ No newline at end of file)/;

/**
 * How much of a block must be diff grammar before untagged content earns the
 * diff rendering. Prose that quotes two marker lines out of ten must not
 * claim the block; a real diff, however small, is essentially all grammar.
 */
const STRUCTURE_FRACTION = 0.7;

export function isDiffText(text: string, lang: string | null): boolean {
  if (text.trim() === "") {
    return false;
  }

  if (DIFF_LANGS[(lang ?? "").trim().toLowerCase()] === true) {
    return true;
  }

  // Untagged content has to earn it. A hunk header is the strongest marker
  // because no prose starts a line with `@@ -12,3 +12,4 @@`; a paired
  // `--- ` and `+++ ` covers the headerless fragments agents paste after
  // trimming. Either way the body must actually carry changed lines and the
  // grammar must dominate the block, so flags lists, YAML front matter, and
  // shell `set -x` traces (where every line begins with `+`) stay ordinary
  // code blocks.
  let hunks = 0;
  let oldFiles = 0;
  let newFiles = 0;
  let structural = 0;
  let changes = 0;
  let context = 0;
  let other = 0;
  for (const line of text.split("\n")) {
    const s = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (s === "") {
      continue;
    }
    if (HUNK.test(s)) {
      hunks += 1;
      structural += 1;
    } else if (OLD_FILE.test(s)) {
      oldFiles += 1;
      structural += 1;
    } else if (NEW_FILE.test(s)) {
      newFiles += 1;
      structural += 1;
    } else if (GIT_BOUNDARY.test(s) || GIT_META.test(s)) {
      structural += 1;
    } else if (s.startsWith("+") || s.startsWith("-")) {
      changes += 1;
    } else if (s.startsWith(" ")) {
      context += 1;
    } else {
      // Prose and ordinary code count against the fraction by being counted.
      other += 1;
    }
  }

  const marked = (hunks > 0 || (oldFiles > 0 && newFiles > 0)) && changes > 0;
  const total = structural + changes + context + other;
  return marked && (structural + changes + context) / total >= STRUCTURE_FRACTION;
}

type DiffLineKind = "boundary" | "file" | "meta" | "hunk" | "add" | "del" | "context";

interface DiffLine {
  kind: DiffLineKind;
  /** The line minus its leading sign on body rows, verbatim on structure. */
  text: string;
}

function classifyLine(raw: string): DiffLine {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (GIT_BOUNDARY.test(line)) {
    return { kind: "boundary", text: line };
  }
  if (OLD_FILE.test(line)) {
    return { kind: "file", text: line };
  }
  if (NEW_FILE.test(line)) {
    return { kind: "file", text: line };
  }
  if (HUNK.test(line)) {
    return { kind: "hunk", text: line };
  }
  if (GIT_META.test(line)) {
    return { kind: "meta", text: line };
  }
  if (line.startsWith("+")) {
    return { kind: "add", text: line.slice(1) };
  }
  if (line.startsWith("-")) {
    return { kind: "del", text: line.slice(1) };
  }
  if (line.startsWith(" ")) {
    return { kind: "context", text: line.slice(1) };
  }
  // A line that fits no diff grammar: the block only claimed to be a diff
  // via its tag. Plain context is the least wrong reading and loses nothing.
  return { kind: "context", text: line };
}

/** Content tone by row kind. Structure fades; changes are what is being read. */
const CONTENT_INK: Record<DiffLineKind, string> = {
  boundary: ink.plain,
  file: ink.plain,
  meta: ink.faint,
  hunk: ink.muted,
  add: ink.bright,
  del: ink.bright,
  context: ink.plain,
};

export function DiffBlock({ text }: { text: string }): JSX.Element {
  const lines = text.split("\n");
  // A trailing newline closes the fence; it is not a row to render.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return (
    <View style={styles.block} testID="diff-block">
      {lines.map((raw, at) => (
        <Row key={at} line={classifyLine(raw)} first={at === 0} />
      ))}
    </View>
  );
}

function Row({ line, first }: { line: DiffLine; first: boolean }): JSX.Element {
  // The sign is the colour-blind channel; the tone below is the second
  // channel, never the only one.
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
  const signTone = line.kind === "add" ? signal.sage : line.kind === "del" ? signal.oxide : ink.faint;

  return (
    <View
      style={[
        styles.row,
        line.kind === "boundary" && !first && styles.boundary,
        line.kind === "hunk" && styles.hunk,
        line.kind === "add" && styles.add,
        line.kind === "del" && styles.del,
      ]}
      testID={`diff-${line.kind}`}
    >
      <Code style={styles.sign} color={signTone}>
        {sign}
      </Code>
      <Code style={styles.content} color={CONTENT_INK[line.kind]}>
        {line.text === "" ? " " : line.text}
      </Code>
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: ground.raised,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    paddingVertical: space.tight,
    marginVertical: space.tight,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: space.tight,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
  },
  // Only `diff --git` is a file boundary; `---`/`+++` follow it inside the
  // same file and must not draw a rule between themselves and their hunk.
  boundary: {
    marginTop: space.tight,
    borderTopWidth: stroke.hair,
    borderTopColor: ground.edge,
  },
  hunk: { backgroundColor: ground.active },
  add: { backgroundColor: signalWash.sage },
  del: { backgroundColor: signalWash.oxide },
  sign: { width: space.step, textAlign: "center" },
  // Shrink, do not push: without this a long line widens its row instead of
  // wrapping inside the content column.
  content: { flexShrink: 1 },
});
