/**
 * A tool call, as a card.
 *
 * A tool call is the only entry in the timeline that changes after it appears:
 * announced pending, amended in progress, settled completed or failed. So the
 * card is built around the one thing that moves, the status rail down its left
 * edge, and everything else holds still under it. Nothing here animates; a
 * colour changing under a stationary title is legible at a glance and a card
 * that slides is not.
 *
 * Output is clamped rather than scrollable. A nested scroll region inside a
 * scrolling transcript is a trap on a touch screen, and the operator who wants
 * the whole of a 4000-line build log wants it on the machine running the build.
 *
 * ## What Paper draws, and what this file stopped drawing
 *
 * The container is a Paper `Surface`, always `mode="flat"` with `elevation={0}`:
 * depth in this app is a step of graphite and a hairline, never a shadow.
 *
 * The status pill and each touched path are Paper `Chip`s. A path is a discrete
 * thing the call touched rather than a line of prose, and a wrapped band of them
 * replaced a stacked list of full-width single-line truncations held under the
 * title by a hand-computed 20 point inset.
 *
 * The rule above the output is a Paper `Divider`, and it is now the only thing
 * separating the output: that block used to carry a fill, a left hairline AND
 * its own pad, three devices all saying "this part is different". One rule says
 * it, the monospaced face says the rest, and the densest surface in the app
 * carries one box fewer.
 *
 * The disclosure is a Paper `TouchableRipple` at a full finger target, so it is
 * the same press surface as every other control rather than a second
 * hand-rolled `Pressable` with no minimum height.
 *
 * Measurement lives in the `StyleSheet` block below, written as `rhythm.<job>`:
 * structure a container is built from must stay readable to the source scrape in
 * `test/no-hidden-content.test.ts`. Only colour comes off the theme at render
 * time, because colour is what genuinely varies -- the two ink ramps invert
 * between the light and dark themes.
 */

import type { JSX } from "react";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { Chip, Divider, Surface, TouchableRipple } from "react-native-paper";
import { shortenPath } from "../design/format.ts";
import { Glyph, TOOL_GLYPHS } from "../design/icons.tsx";
import { rhythm } from "../design/rhythm.ts";
import { Code, Label, Title } from "../design/text.tsx";
import { radius, stroke, toolSignal, type as typeScale } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import type { ToolEntry } from "../session/model.ts";

/** Lines of output shown before the card asks to be opened. */
const CLAMP_LINES = 6;

/** Touched paths shown before the band collapses the rest into a count. */
const CLAMP_LOCATIONS = 4;

export function ToolCard({ entry }: { entry: ToolEntry }): JSX.Element {
  const [open, setOpen] = useState(false);
  const theme = useOmpTheme();
  const { ground, ink } = theme;
  const signalName = toolSignal(entry.status);
  const tone = theme.signal[signalName];
  const glyph = TOOL_GLYPHS[entry.toolKind] ?? "other";
  const output = entry.output;
  const lines = output === null ? 0 : output.split("\n").length;
  const clamped = !open && lines > CLAMP_LINES;
  const overflow = entry.locations.length - CLAMP_LOCATIONS;

  return (
    <Surface
      mode="flat"
      elevation={0}
      style={[styles.card, { backgroundColor: ground.raised, borderColor: ground.line }]}
      testID={`tool-${entry.id}`}
    >
      <View style={[styles.rail, { backgroundColor: tone }]} />
      <View style={styles.body}>
        <View style={styles.head}>
          <Glyph name={glyph} size={13} color={tone} />
          <Title numberOfLines={2} style={styles.title} color={ink.bright} testID={`tool-title-${entry.id}`}>
            {entry.title}
          </Title>
          <Chip
            compact
            // A status is a reading, not a control, and a chip announces itself
            // as a button unless told what it is.
            accessibilityRole="text"
            style={[styles.pill, { backgroundColor: theme.signalWash[signalName], borderColor: tone }]}
            textStyle={[styles.statusText, { color: tone }]}
            testID={`tool-status-${entry.id}`}
          >
            {entry.status.replace("_", " ")}
          </Chip>
        </View>

        {entry.locations.length > 0 ? (
          <View style={styles.locations}>
            {entry.locations.slice(0, CLAMP_LOCATIONS).map(path => (
              <Chip
                key={path}
                compact
                accessibilityRole="text"
                style={[styles.pill, styles.location, { backgroundColor: ground.base, borderColor: ground.line }]}
                textStyle={[styles.pathText, { color: ink.muted }]}
              >
                {shortenPath(path, 2)}
              </Chip>
            ))}
            {overflow > 0 ? (
              <Chip
                compact
                accessibilityRole="text"
                style={[styles.pill, styles.location, { backgroundColor: ground.base, borderColor: ground.line }]}
                textStyle={[styles.pathText, { color: ink.faint }]}
              >
                {`+${overflow} more`}
              </Chip>
            ) : null}
          </View>
        ) : null}

        {output !== null && output.length > 0 ? (
          <View style={styles.output}>
            <Divider />
            <Code numberOfLines={clamped ? CLAMP_LINES : undefined} testID={`tool-output-${entry.id}`}>
              {output}
            </Code>
            {lines > CLAMP_LINES ? (
              <TouchableRipple
                accessibilityRole="button"
                accessibilityLabel={open ? "Collapse output" : `Show all ${lines} lines`}
                onPress={() => {
                  setOpen(!open);
                }}
                style={styles.more}
              >
                <View style={styles.moreRow}>
                  <Glyph name="chevron" size={10} color={ink.muted} />
                  <Label color={ink.muted}>{open ? "collapse" : `${lines} lines`}</Label>
                </View>
              </TouchableRipple>
            ) : null}
          </View>
        ) : null}
      </View>
    </Surface>
  );
}

const styles = StyleSheet.create({
  // Clipped on purpose: the rail's square left edge would otherwise cross the
  // card's rounded corner.
  card: {
    flexDirection: "row",
    borderWidth: stroke.hair,
    borderRadius: radius.control,
    overflow: "hidden",
  },
  // The one measurement in this file the token tables do not name. It is a
  // stroke weight rather than a spacing step, and it is deliberately heavier
  // than `stroke.heavy`: a division separates two things, this one carries the
  // call's state and has to read as a signal from arm's length.
  rail: { width: 3 },
  body: { flex: 1, padding: rhythm.cardPad, gap: rhythm.cardGap },
  // `flex-start`, so a title wrapping to two lines leaves the glyph and the
  // status where they were rather than dragging them down the row.
  head: { flexDirection: "row", alignItems: "flex-start", gap: rhythm.cardGap },
  title: { flex: 1 },
  // Every chip in this card is a hairline outline over an ompctl wash, never
  // Material's filled container.
  pill: { borderWidth: stroke.hair },
  // A path can be long; a band of them wraps rather than pushing the card wide.
  location: { flexShrink: 1 },
  // Paper sizes a chip's label with a 6 point vertical margin, which is a 32
  // point pill in a row of 22 point type. These two put the pill back on the
  // line it belongs to and keep the app's own voice inside the library's box.
  statusText: { ...typeScale.kicker, textTransform: "uppercase", marginVertical: rhythm.pairGap },
  pathText: { ...typeScale.label, marginVertical: rhythm.pairGap },
  locations: { flexDirection: "row", flexWrap: "wrap", gap: rhythm.cardGap },
  // The `Divider`, the output and its disclosure: three things belonging to one
  // another, so the tight step rather than the card's own.
  output: { gap: rhythm.rowGapTight },
  // A finger target the full width of the card. A disclosure a person misses
  // reads as a card that will not open.
  more: { minHeight: rhythm.minTarget, justifyContent: "center" },
  moreRow: { flexDirection: "row", alignItems: "center", gap: rhythm.glyphGap },
});
