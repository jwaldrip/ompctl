/**
 * Rich reply rendering for the transcript.
 *
 * The daemon speaks markdown: headings for sections, lists for steps, fences
 * for commands and diffs, `![name](uri)` for artifacts. Rendering that raw was
 * fine when replies were one line; on a phone a structured reply rendered as
 * punctuation is a reply the operator has to re-parse by eye on every read.
 *
 * Structure comes from `parseRich`, which is pure and tested against strings.
 * This component is deliberately thin: each block maps onto the existing type
 * ramp and colour tokens, so a rich reply keeps the same voice as a plain one
 * and the scale stays enforced in one place. Two blocks leave this file:
 * diffs and attachments are specialist surfaces owned elsewhere, reached only
 * through their committed signatures.
 *
 * Streaming sets the performance bar. An assistant row re-renders on every
 * token, so parsing stays a single linear pass and the component is memoised
 * on its prop: rows whose text did not change do not re-parse or re-render.
 * The row's accessibility label stays on the raw `entry.text` in
 * `Transcript.tsx`, which is what the round-trip gate reads; this component
 * owns pixels only.
 */

import type { JSX, ReactNode } from "react";
import { memo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { rhythm } from "../../design/rhythm.ts";
import { Body, Display, Kicker, Label, Title } from "../../design/text.tsx";
import { face, ground, ink, space, stroke, type } from "../../design/tokens.ts";
import { AttachmentBlock } from "./AttachmentBlock.tsx";
import type { RichSpan } from "./blocks.ts";
import { DiffBlock, isDiffText } from "./DiffBlock.tsx";
import { highlight } from "./highlight.ts";
import { tokenColor } from "./highlight-theme.ts";
import { parseRich, type RichBlock } from "./parse.ts";

/** Flat inline runs. Nesting a `Text` per span lets RN inherit the block's size and colour. */
function Spans({ spans }: { spans: readonly RichSpan[] }): JSX.Element {
  // Content-derived keys: the span's kind and text plus an occurrence count,
  // because inline runs genuinely repeat ("a *b* a *b*") and the raw text
  // alone would collide where the array index is banned for the usual reason.
  const seen = new Map<string, number>();
  const keyed = spans.map(span => {
    const base = `${span.kind}:${span.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return { span, key: `${n}:${base}` };
  });

  return (
    <>
      {keyed.map(({ span, key }) => {
        switch (span.kind) {
          case "text":
            return <Text key={key}>{span.text}</Text>;
          case "strong":
            return (
              <Text key={key} style={styles.strong}>
                {span.text}
              </Text>
            );
          case "em":
            return (
              <Text key={key} style={styles.em}>
                {span.text}
              </Text>
            );
          case "code":
            return (
              <Text key={key} style={styles.codeSpan}>
                {span.text}
              </Text>
            );
          case "link":
            // No new colour: the six signals each mean something else, and a
            // seventh "link blue" would be the first overlap. Underline is the
            // affordance; the transcript shows text, it does not navigate.
            return (
              <Text key={key} style={styles.link}>
                {span.text}
              </Text>
            );
          default:
            // Exhaustive today, so the narrow is `never`. A future span kind
            // renders nothing rather than vanishing the whole run: one
            // unknown span must not blank its siblings.
            return null;
        }
      })}
    </>
  );
}

/** One block kind, one primitive. The ramp decides size and weight, not this switch. */
function BlockView({ block, muted }: { block: RichBlock; muted: boolean }): ReactNode {
  switch (block.kind) {
    case "prose":
      return (
        <Body color={muted ? ink.plain : ink.bright}>
          <Spans spans={block.spans} />
        </Body>
      );

    case "heading": {
      // Three steps of ramp for six levels of heading, because a reply that
      // genuinely uses h4 is usually a table of contents, not a hierarchy an
      // operator is meant to feel. Levels below the ramp's floor render as
      // labels rather than shrinking into illegibility.
      const Heading = block.level === 1 ? Display : block.level <= 3 ? Title : Label;
      return (
        <Heading heading color={ink.bright}>
          <Spans spans={block.spans} />
        </Heading>
      );
    }

    case "list":
      return (
        <View style={styles.list}>
          {block.items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: list item position is the stable identity
            <View key={`li:${index}:${spansText(item.spans).slice(0, 48)}`} style={styles.listRow}>
              {/* Marker column so a wrapped item hangs past its number, not under it. */}
              <Label color={ink.muted} style={styles.listMarker}>
                {block.ordered ? `${index + 1}.` : "\u2022"}
              </Label>
              <View style={styles.listItem}>
                <Body color={muted ? ink.plain : ink.bright}>
                  <Spans spans={item.spans} />
                </Body>
                {item.children && item.children.length > 0 ? (
                  <View style={styles.listChildren}>
                    {item.children.map((child, childIdx) => {
                      if (child.kind === "list") {
                        return (
                          // biome-ignore lint/suspicious/noArrayIndexKey: child position is stable
                          <View key={`child-list:${childIdx}`} testID="nested-list" style={styles.nestedList}>
                            <BlockView block={child} muted={muted} />
                          </View>
                        );
                      }
                      return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: child position is stable
                        <View key={`child-block:${childIdx}`} style={styles.childBlock}>
                          <BlockView block={child} muted={muted} />
                        </View>
                      );
                    })}
                  </View>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      );

    case "quote":
      return (
        <View style={styles.quote}>
          <Body color={ink.plain}>
            <Spans spans={block.spans} />
          </Body>
        </View>
      );

    case "code": {
      // A fence is the one shape that may be something else: whether a fenced
      // block IS a diff is the diff renderer's judgement at render time, never
      // the parser's guess (see `blocks.ts`).
      if (isDiffText(block.text, block.lang)) {
        return <DiffBlock text={block.text} />;
      }
      const lines = highlight(block.text, block.lang);
      let lineSeq = 0;
      return (
        <View style={styles.code}>
          {block.lang === null ? null : <Kicker color={ink.muted}>{block.lang}</Kicker>}
          <View style={styles.codeLines}>
            {lines.map(lineTokens => {
              lineSeq += 1;
              const lineKey = `l:${lineSeq}:${lineTokens
                .map(t => t.text)
                .join("")
                .slice(0, 24)}`;
              let tokSeq = 0;
              return (
                <Text key={lineKey} selectable style={type.code}>
                  {lineTokens.map(token => {
                    tokSeq += 1;
                    return (
                      <Text key={`t:${tokSeq}:${token.kind}`} style={{ color: tokenColor(token.kind) }}>
                        {token.text || " "}
                      </Text>
                    );
                  })}
                </Text>
              );
            })}
          </View>
        </View>
      );
    }

    case "rule":
      return <View style={styles.rule} />;

    case "table": {
      return (
        <ScrollView
          horizontal
          nestedScrollEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          style={styles.tableScroll}
          contentContainerStyle={styles.tableContent}
        >
          <View style={styles.table}>
            <View style={[styles.tableRow, styles.tableHeaderRow]}>
              {block.header.cells.map((cell, colIdx) => {
                const align = block.alignments[colIdx] ?? null;
                const alignStyle =
                  align === "center" ? styles.alignCenter : align === "right" ? styles.alignRight : styles.alignLeft;
                const textStyle =
                  align === "center"
                    ? styles.textAlignPropsCenter
                    : align === "right"
                      ? styles.textAlignPropsRight
                      : styles.textAlignPropsLeft;
                return (
                  <View
                    // biome-ignore lint/suspicious/noArrayIndexKey: column position is the header cell identity
                    key={`th:${colIdx}`}
                    testID={`table-header-cell-${align ?? "left"}`}
                    accessibilityRole="header"
                    style={[styles.tableCell, styles.tableHeaderCell, alignStyle]}
                  >
                    <Label heading color={ink.bright} style={[styles.tableHeaderText, textStyle]}>
                      <Spans spans={cell} />
                    </Label>
                  </View>
                );
              })}
            </View>
            {block.rows.map((row, rowIdx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: row position is the row identity
              <View key={`tr:${rowIdx}`} style={[styles.tableRow, rowIdx % 2 === 1 && styles.tableRowAlt]}>
                {row.cells.map((cell, colIdx) => {
                  const align = block.alignments[colIdx] ?? null;
                  const alignStyle =
                    align === "center" ? styles.alignCenter : align === "right" ? styles.alignRight : styles.alignLeft;
                  const textStyle =
                    align === "center"
                      ? styles.textAlignPropsCenter
                      : align === "right"
                        ? styles.textAlignPropsRight
                        : styles.textAlignPropsLeft;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cell position in row is the identity
                    <View key={`td:${rowIdx}:${colIdx}`} testID="table-cell" style={[styles.tableCell, alignStyle]}>
                      <Body color={muted ? ink.plain : ink.bright} style={textStyle}>
                        <Spans spans={cell} />
                      </Body>
                    </View>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }

    case "attachment":
      return <AttachmentBlock ref={block.ref} />;
  }
}

function RichTextBase({ text, muted = false }: { text: string; muted?: boolean }): JSX.Element {
  const blocks = parseRich(text);
  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => (
        // Position, then content. Content alone is not an identity: two rules
        // in one message both key to "rule", and two identical lists or
        // paragraphs collide the same way, which React reports as duplicate
        // keys and then renders by remounting rows. Blocks are re-derived
        // from one string that is replaced wholesale and never reordered, so
        // the index is stable for stable input, and the content suffix keeps
        // the key readable when debugging a stream.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above, position is the identity here.
        <BlockView key={`${index}:${blockKeyOf(block)}`} block={block} muted={muted} />
      ))}
    </View>
  );
}

/** A block's readable suffix. Not unique on its own: see the call site. */
function blockKeyOf(block: RichBlock): string {
  if (block.kind === "rule") return "rule";
  if (block.kind === "attachment") return `att:${block.ref.uri}`;
  if (block.kind === "code") return `code:${block.text.slice(0, 64)}`;
  if (block.kind === "list") return `list:${block.items.length}:${block.ordered}`;
  if (block.kind === "heading") return `h${block.level}:${spansText(block.spans).slice(0, 64)}`;
  if (block.kind === "table") return `table:${block.rows.length}:${block.alignments.length}`;
  return spansText(block.spans).slice(0, 64);
}

/** Joins a span run to its plain text. Three key derivations share it. */
function spansText(spans: readonly RichSpan[]): string {
  return spans.map(span => span.text).join("");
}

/**
 * Memoised on `text` (and `muted`): a streaming turn repaints only the row
 * whose text actually changed, which is the difference between a reply that
 * lands and one that stutters on every token.
 */
export const RichText = memo(RichTextBase);

const styles = StyleSheet.create({
  // The gap between blocks. A heading and the paragraph under it, a paragraph
  // and its list: consecutive pieces of ONE reply, not siblings in a list, so
  // the tight step rather than the row rhythm.
  stack: { flex: 1, gap: rhythm.rowGapTight },
  strong: { fontFamily: face.semibold },
  em: { fontStyle: "italic" },
  codeSpan: { fontFamily: face.mono },
  link: { textDecorationLine: "underline" },
  list: { gap: space.tight },
  listRow: { flexDirection: "row", gap: space.snug },
  // A floor, not a fixed width, and one step of nesting rather than a number
  // measured against the markers it happened to hold. `100.` measures 25.00 in
  // this face (Archivo-Medium at the label's 12 points with its 0.3 tracking,
  // measured with CoreText), so no fixed width survives a long enough list; a
  // minimum aligns every short marker and still cannot cut one.
  // `test/no-hidden-content.test.ts` pins that this stays a `minWidth`.
  listMarker: { minWidth: rhythm.indent, textAlign: "right" },
  listItem: { flex: 1, gap: space.tight },
  listChildren: { gap: space.tight, marginTop: space.tight },
  nestedList: { width: "100%" },
  childBlock: { width: "100%" },
  tableScroll: { maxWidth: "100%" },
  tableContent: { minWidth: "100%" },
  table: {
    minWidth: "100%",
    backgroundColor: ground.surface,
    borderWidth: stroke.hair,
    borderColor: ground.line,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.line,
  },
  tableHeaderRow: {
    backgroundColor: ground.raised,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.edge,
  },
  tableRowAlt: {
    backgroundColor: ground.surface,
  },
  tableCell: {
    flex: 1,
    minWidth: rhythm.attribution,
    paddingHorizontal: space.snug,
    paddingVertical: space.snug,
    justifyContent: "center",
  },
  tableHeaderCell: {
    paddingVertical: space.snug,
  },
  tableHeaderText: {
    fontFamily: face.semibold,
  },
  alignLeft: {
    alignItems: "flex-start",
  },
  alignCenter: {
    alignItems: "center",
  },
  alignRight: {
    alignItems: "flex-end",
  },
  textAlignPropsLeft: {
    textAlign: "left",
  },
  textAlignPropsCenter: {
    textAlign: "center",
  },
  textAlignPropsRight: {
    textAlign: "right",
  },
  // A quoted block, edge to content: the same job and the same answer as a
  // card's own inset, which is what a clearance's command preview also pays.
  quote: {
    borderLeftWidth: stroke.heavy,
    borderLeftColor: ground.edge,
    backgroundColor: ground.surface,
    padding: rhythm.cardPad,
  },
  code: { backgroundColor: ground.surface, padding: rhythm.cardPad, gap: space.tight },
  codeLines: { flexDirection: "column" },
  rule: { height: stroke.hair, backgroundColor: ground.edge, marginVertical: space.tight },
});
