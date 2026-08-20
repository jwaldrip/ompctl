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
import { StyleSheet, Text, View } from "react-native";
import { Body, Code, Display, Kicker, Label, Title } from "../../design/text.tsx";
import { face, ground, ink, space, stroke } from "../../design/tokens.ts";
import { AttachmentBlock } from "./AttachmentBlock.tsx";
import type { RichBlock, RichSpan } from "./blocks.ts";
import { DiffBlock, isDiffText } from "./DiffBlock.tsx";
import { parseRich } from "./parse.ts";

/** Flat inline runs. Nesting a `Text` per span lets RN inherit the block's size and colour. */
function Spans({ spans }: { spans: readonly RichSpan[] }): JSX.Element {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.kind) {
          case "text":
            return <Text key={index}>{span.text}</Text>;
          case "strong":
            return (
              <Text key={index} style={styles.strong}>
                {span.text}
              </Text>
            );
          case "em":
            return (
              <Text key={index} style={styles.em}>
                {span.text}
              </Text>
            );
          case "code":
            return (
              <Text key={index} style={styles.codeSpan}>
                {span.text}
              </Text>
            );
          case "link":
            // No new colour: the six signals each mean something else, and a
            // seventh "link blue" would be the first overlap. Underline is the
            // affordance; the transcript shows text, it does not navigate.
            return (
              <Text key={index} style={styles.link}>
                {span.text}
              </Text>
            );
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
            <View key={index} style={styles.listRow}>
              {/* Fixed marker column so a wrapped item hangs past its number, not under it. */}
              <Label color={ink.muted} style={styles.listMarker}>
                {block.ordered ? `${index + 1}.` : "\u2022"}
              </Label>
              <Body color={muted ? ink.plain : ink.bright} style={styles.listItem}>
                <Spans spans={item} />
              </Body>
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

    case "code":
      // A fence is the one shape that may be something else: whether a fenced
      // block IS a diff is the diff renderer's judgement at render time, never
      // the parser's guess (see `blocks.ts`).
      if (isDiffText(block.text, block.lang)) {
        return <DiffBlock text={block.text} />;
      }
      return (
        <View style={styles.code}>
          {block.lang === null ? null : <Kicker color={ink.muted}>{block.lang}</Kicker>}
          <Code>{block.text}</Code>
        </View>
      );

    case "rule":
      return <View style={styles.rule} />;

    case "attachment":
      return <AttachmentBlock ref={block.ref} />;
  }
}

function RichTextBase({ text, muted = false }: { text: string; muted?: boolean }): JSX.Element {
  const blocks = parseRich(text);
  return (
    <View style={styles.stack}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} muted={muted} />
      ))}
    </View>
  );
}

/**
 * Memoised on `text` (and `muted`): a streaming turn repaints only the row
 * whose text actually changed, which is the difference between a reply that
 * lands and one that stutters on every token.
 */
export const RichText = memo(RichTextBase);

const styles = StyleSheet.create({
  stack: { flex: 1, gap: space.snug },
  strong: { fontFamily: face.semibold },
  em: { fontStyle: "italic" },
  codeSpan: { fontFamily: face.mono },
  link: { textDecorationLine: "underline" },
  list: { gap: space.tight },
  listRow: { flexDirection: "row", gap: space.snug },
  listMarker: { width: 20, textAlign: "right" },
  listItem: { flex: 1 },
  quote: {
    borderLeftWidth: stroke.heavy,
    borderLeftColor: ground.edge,
    backgroundColor: ground.surface,
    padding: space.step,
  },
  code: { backgroundColor: ground.surface, padding: space.step, gap: space.tight },
  rule: { height: stroke.hair, backgroundColor: ground.edge, marginVertical: space.tight },
});
