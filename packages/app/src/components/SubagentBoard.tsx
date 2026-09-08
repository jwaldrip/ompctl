import type { Agent, AgentState, SubagentTranscript } from "@ompd/core/contracts";
import { type JSX, memo, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { elapsed } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
import { rhythm } from "../design/rhythm.ts";
import { Body, Data, Kicker, Label } from "../design/text.tsx";
import { agentSignal, radius, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";
import { formatBytes } from "../session/browser.ts";
import { SUBAGENT_UNOPENABLE, subagentOpenable } from "./AgentHub.tsx";

export type SubagentBoardColumnId = "needsYou" | "working" | "idle" | "done";

export interface SubagentColumnDef {
  readonly id: SubagentBoardColumnId;
  readonly title: string;
}

export const SUBAGENT_BOARD_COLUMNS: readonly SubagentColumnDef[] = [
  { id: "needsYou", title: "Needs you" },
  { id: "working", title: "Working" },
  { id: "idle", title: "Idle" },
  { id: "done", title: "Done" },
] as const;

/**
 * Maps every AgentState to its subagent board column.
 *
 * Explicitly covers all 7 states in contracts.ts:
 * - waiting: Needs you (blocked on an approval decision)
 * - failed: Needs you (crashed or provisioning failed)
 * - busy: Working (turn streaming)
 * - provisioning: Working (host being acquired)
 * - starting: Working (host up, session not yet created)
 * - idle: Idle (ready, no turn in flight)
 * - stopped: Done (clean exit, transcript retained)
 */
export const AGENT_STATE_TO_COLUMN: Readonly<Record<AgentState, SubagentBoardColumnId>> = {
  waiting: "needsYou",
  failed: "needsYou",
  busy: "working",
  provisioning: "working",
  starting: "working",
  idle: "idle",
  stopped: "done",
};

/**
 * Resolves which board column an agent belongs to.
 *
 * Checks for operator clearance requirement first: an agent waiting on
 * clearance belongs in Needs you even if its underlying state is not waiting.
 * Falls back to the exhaustive AGENT_STATE_TO_COLUMN table.
 */
export function columnForAgent(agent: Agent, hasClearance?: (agent: Agent) => boolean): SubagentBoardColumnId {
  if (hasClearance?.(agent)) return "needsYou";
  return AGENT_STATE_TO_COLUMN[agent.state] ?? "idle";
}

export interface SubagentCardProps {
  readonly agent: Agent;
  readonly onOpen?: (agent: Agent) => void;
  readonly now?: number;
  readonly testIDPrefix?: string;
  readonly depth?: number;
}

/**
 * One subagent card rendered on the subagent board and in the agent hub.
 *
 * Displays the assignment (taskTitle if set, else name), state signal chip,
 * elapsed duration since lastActiveAt, model when known, failure diagnosis
 * when failed, and cost when metrics carry costAmount.
 */
export const SubagentCard = memo(function SubagentCard({
  agent,
  onOpen,
  now = Date.now(),
  testIDPrefix = "subagent-card",
  depth = 0,
}: SubagentCardProps): JSX.Element {
  const theme = useOmpTheme();
  const status = agentSignal(agent.state);
  const openable = subagentOpenable(agent);
  const assignment =
    agent.taskTitle !== undefined && agent.taskTitle.trim().length > 0 ? agent.taskTitle.trim() : agent.name;
  const hasSeparateName =
    agent.taskTitle !== undefined && agent.taskTitle.trim().length > 0 && agent.taskTitle.trim() !== agent.name;

  const costLabel =
    agent.metrics?.costAmount !== undefined && agent.metrics.costAmount !== null
      ? `cost ${agent.metrics.costAmount.toFixed(4)}`
      : null;

  const indent = depth > 0 ? { marginLeft: depth * rhythm.indent } : null;

  const cardContent = (
    <>
      <View style={styles.topRow}>
        <View style={[styles.statusBadge, { backgroundColor: theme.signalWash[status] }]}>
          <Label color={theme.signal[status]}>{agent.state}</Label>
        </View>
        <Data color={theme.ink.faint}>{elapsed(agent.lastActiveAt, now)}</Data>
      </View>

      <View style={styles.assignmentBlock}>
        <Body color={theme.ink.bright} numberOfLines={2} testID={`${testIDPrefix}-assignment-${agent.id}`}>
          {assignment}
        </Body>
        {hasSeparateName ? (
          <Label color={theme.ink.muted} numberOfLines={1}>
            {agent.name}
          </Label>
        ) : null}
      </View>

      {agent.state === "failed" && agent.failure ? (
        <Label
          color={theme.signal.failed}
          style={styles.failureSentence}
          testID={`${testIDPrefix}-failure-${agent.id}`}
        >
          {agent.failure}
        </Label>
      ) : null}

      <View style={styles.metaRow}>
        {agent.model !== undefined && agent.model.length > 0 ? (
          <Kicker color={theme.ink.muted}>{agent.model}</Kicker>
        ) : null}
        {costLabel !== null ? <Kicker color={theme.ink.muted}>{costLabel}</Kicker> : null}
        {openable ? null : (
          <Kicker color={theme.ink.faint} testID={`${testIDPrefix}-unopenable-${agent.id}`}>
            {SUBAGENT_UNOPENABLE}
          </Kicker>
        )}
      </View>
    </>
  );

  const cardStyle = [
    styles.card,
    {
      backgroundColor: theme.ground.raised,
      borderColor: theme.ground.line,
    },
  ];

  return (
    <View style={[styles.cardContainer, indent]} testID={`${testIDPrefix}-${agent.id}`}>
      {openable ? (
        <Pressable
          accessibilityLabel={`Open ${agent.name} session`}
          accessibilityRole="button"
          onPress={() => onOpen?.(agent)}
          style={({ pressed }) => [cardStyle, pressed && { backgroundColor: theme.ground.active }]}
          testID={`${testIDPrefix}-open-${agent.id}`}
        >
          {cardContent}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={`${agent.name}, ${agent.state}. ${SUBAGENT_UNOPENABLE}`}
          style={cardStyle}
          testID={`${testIDPrefix}-row-${agent.id}`}
        >
          {cardContent}
        </View>
      )}
    </View>
  );
});

export interface SubagentBoardProps {
  readonly agents: readonly Agent[];
  readonly onOpenSubagent: (agent: Agent) => void;
  readonly now?: number;
  readonly hasClearance?: (agent: Agent) => boolean;
  readonly testID?: string;
}

/**
 * Board of subagents organized into state columns.
 *
 * Renders as a horizontal scroll on phones to preserve card width, and as a
 * side-by-side row of columns on tablets. Empty columns are completely omitted
 * to avoid reporting zero states.
 */
export function SubagentBoard(props: SubagentBoardProps): JSX.Element | null {
  const { agents, onOpenSubagent, now, hasClearance, testID = "subagent-board" } = props;
  const theme = useOmpTheme();
  const tablet = useIsTablet();

  const byColumn = useMemo(() => {
    const buckets: Record<SubagentBoardColumnId, Agent[]> = {
      needsYou: [],
      working: [],
      idle: [],
      done: [],
    };
    for (const agent of agents) {
      const colId = columnForAgent(agent, hasClearance);
      buckets[colId].push(agent);
    }
    return buckets;
  }, [agents, hasClearance]);

  const visibleColumns = useMemo(() => {
    return SUBAGENT_BOARD_COLUMNS.filter(col => byColumn[col.id].length > 0);
  }, [byColumn]);

  if (visibleColumns.length === 0) return null;

  const renderColumn = (col: SubagentColumnDef, isPhone: boolean) => {
    const items = byColumn[col.id];
    return (
      <View
        key={col.id}
        style={isPhone ? styles.columnPhone : styles.columnTablet}
        testID={`subagent-board-column-${col.id}`}
      >
        <View style={styles.columnHead}>
          <Kicker color={col.id === "needsYou" ? theme.signal.holding : theme.ink.muted}>{col.title}</Kicker>
          <Data color={theme.ink.plain} testID={`subagent-board-count-${col.id}`}>
            {String(items.length)}
          </Data>
        </View>
        <View style={styles.columnCards}>
          {items.map(agent => (
            <SubagentCard agent={agent} key={agent.id} now={now} onOpen={onOpenSubagent} testIDPrefix="subagent-card" />
          ))}
        </View>
      </View>
    );
  };

  if (tablet) {
    return (
      <View style={styles.columnsTablet} testID={`${testID}-tablet`}>
        {visibleColumns.map(col => renderColumn(col, false))}
      </View>
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.columnsScroll}
      horizontal
      showsHorizontalScrollIndicator={false}
      testID={`${testID}-phone`}
    >
      {visibleColumns.map(col => renderColumn(col, true))}
    </ScrollView>
  );
}

/**
 * UX constants named with rationale:
 * - PHONE_COLUMN_WIDTH (260): Wide enough on a 390px mobile viewport to read
 *   assignment titles without aggressive truncation while allowing the next
 *   column header to peek in to hint horizontal scrollability.
 * - TABLET_COLUMN_MIN_WIDTH (140): Guarantees cards in side-by-side columns
 *   remain legible on tablets before overflowing.
 */
const PHONE_COLUMN_WIDTH = 260;
const TABLET_COLUMN_MIN_WIDTH = 140;

export interface SubagentTranscriptRowProps {
  readonly transcript: SubagentTranscript;
  readonly now?: number;
  readonly onOpen: (transcript: SubagentTranscript) => void;
}

export function SubagentTranscriptRow({
  transcript,
  now = Date.now(),
  onOpen,
}: SubagentTranscriptRowProps): JSX.Element {
  const theme = useOmpTheme();
  return (
    <Pressable
      accessibilityLabel={`${transcript.name}, ${elapsed(transcript.updatedAt, now)}, ${formatBytes(transcript.byteSize)}${transcript.hasReport ? ", has report" : ""}`}
      accessibilityRole="button"
      onPress={() => onOpen(transcript)}
      style={({ pressed }) => [styles.transcriptRow, pressed && { backgroundColor: theme.ground.active }]}
      testID={`subagent-transcript-${transcript.name}`}
    >
      <View style={styles.transcriptMain}>
        <Label color={theme.ink.bright} numberOfLines={1} style={styles.transcriptName}>
          {transcript.name}
        </Label>
        {transcript.hasReport ? (
          <View style={styles.transcriptReport} testID={`subagent-transcript-report-${transcript.name}`}>
            <Glyph name="report" size={12} color={theme.ink.muted} />
          </View>
        ) : null}
      </View>
      <View style={styles.transcriptMeta}>
        <Data color={theme.ink.muted}>{elapsed(transcript.updatedAt, now)}</Data>
        <Data color={theme.ink.muted}>{formatBytes(transcript.byteSize)}</Data>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  columnsScroll: {
    flexDirection: "row",
    gap: space.snug,
    paddingVertical: space.tight,
  },
  columnsTablet: {
    flexDirection: "row",
    gap: space.snug,
    paddingVertical: space.tight,
  },
  columnPhone: {
    width: PHONE_COLUMN_WIDTH,
    gap: space.snug,
  },
  columnTablet: {
    flex: 1,
    minWidth: TABLET_COLUMN_MIN_WIDTH,
    gap: space.snug,
  },
  columnHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: space.tight,
  },
  columnCards: {
    gap: space.snug,
  },
  cardContainer: {
    width: "100%",
  },
  card: {
    minHeight: TOUCH_TARGET,
    borderWidth: stroke.hair,
    borderRadius: radius.control,
    padding: space.snug,
    gap: space.tight,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: space.snug,
  },
  statusBadge: {
    paddingHorizontal: space.tight,
    paddingVertical: space.hair,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.control,
  },
  assignmentBlock: {
    gap: space.hair,
  },
  failureSentence: {
    paddingTop: space.hair,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    columnGap: space.snug,
    rowGap: space.hair,
    alignItems: "center",
  },
  transcriptRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: rhythm.minTarget,
    paddingHorizontal: space.snug,
    paddingVertical: space.snug,
    borderRadius: radius.control,
    gap: space.snug,
  },
  transcriptMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.glyphGap,
    flexShrink: 1,
  },
  transcriptName: {
    flexShrink: 1,
  },
  transcriptReport: {
    alignItems: "center",
    justifyContent: "center",
  },
  transcriptMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: rhythm.pairGap,
  },
});
