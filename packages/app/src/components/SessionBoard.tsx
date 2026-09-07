/**
 * The session board: a kanban projection of visible sessions.
 *
 * Derives four operational columns from what the daemon reports:
 * - Needs you: live sessions whose agent is waiting or failed, or with pending clearance
 * - Working: turn in flight on an agent or live terminal session
 * - Idle: live, nothing in flight
 * - Parked: dormant sessions (not archived)
 *
 * Empty columns are omitted entirely. Horizontal-scrolling columns on phones,
 * row of columns on tablets.
 */

import type { Agent, AgentId } from "@ompd/core/contracts";
import type { JSX } from "react";
import { memo, useMemo } from "react";
import { Pressable, type PressableStateCallbackType, ScrollView, StyleSheet, View } from "react-native";
import { useIsTablet } from "../design/layout.ts";
import { Body, Data, Kicker, Label, Title } from "../design/text.tsx";
import { ground, ink, radius, signal, type SignalName, signalWash, space, stroke } from "../design/tokens.ts";
import type { BrowserSession } from "../session/browser.ts";
import { formatAge } from "../session/browser.ts";
import { formatCostReading } from "./SessionRow.tsx";

export type BoardColumnKey = "needs-you" | "working" | "idle" | "parked";

export interface BoardSessionCard {
  readonly session: BrowserSession;
  readonly columnKey: BoardColumnKey;
  readonly signalName: SignalName;
  readonly reason?: string;
}

export interface BoardColumn {
  readonly key: BoardColumnKey;
  readonly title: string;
  readonly cards: readonly BoardSessionCard[];
}

export function projectBasename(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  return parts.pop() ?? cwd;
}

/**
 * Derives operational columns from live sessions and daemon agent state.
 * Empty columns are omitted, never shown as 0.
 */
export function deriveBoardColumns(
  sessions: readonly BrowserSession[],
  agents?: readonly Agent[],
  pendingClearances?: (agentId: AgentId) => number,
  tuiSessions?: ReadonlyMap<string, { busy?: boolean; awaitingReply?: boolean; refusal?: unknown }>,
): BoardColumn[] {
  const needsYouCards: BoardSessionCard[] = [];
  const workingCards: BoardSessionCard[] = [];
  const idleCards: BoardSessionCard[] = [];
  const parkedCards: BoardSessionCard[] = [];

  for (const session of sessions) {
    // Archived sessions are never shown on the board.
    if (session.status === "archived") continue;

    if (session.status === "dormant") {
      parkedCards.push({
        session,
        columnKey: "parked",
        signalName: "cold",
      });
      continue;
    }

    // Live session (live-ompd or live-tui)
    const agent = agents?.find(a => a.acpSessionId === session.id || a.id === session.id);
    const clearances = agent ? (pendingClearances?.(agent.id) ?? 0) : 0;
    const tui = tuiSessions?.get(session.id);

    // 1. Needs you check
    if (clearances > 0) {
      needsYouCards.push({
        session,
        columnKey: "needs-you",
        signalName: "holding",
        reason: "Clearance pending",
      });
      continue;
    }

    if (agent?.state === "waiting") {
      needsYouCards.push({
        session,
        columnKey: "needs-you",
        signalName: "holding",
        reason: "Waiting for you",
      });
      continue;
    }

    if (agent?.state === "failed") {
      needsYouCards.push({
        session,
        columnKey: "needs-you",
        signalName: "failed",
        reason: agent.failure ?? "Session failed",
      });
      continue;
    }

    if (tui?.refusal !== null && tui?.refusal !== undefined) {
      needsYouCards.push({
        session,
        columnKey: "needs-you",
        signalName: "holding",
        reason: "Needs you",
      });
      continue;
    }

    // 2. Working check
    if (agent?.state === "busy") {
      workingCards.push({
        session,
        columnKey: "working",
        signalName: "working",
      });
      continue;
    }

    if (session.status === "live-tui" && (tui?.busy || tui?.awaitingReply)) {
      workingCards.push({
        session,
        columnKey: "working",
        signalName: "working",
      });
      continue;
    }

    // 3. Idle check (live, nothing in flight)
    idleCards.push({
      session,
      columnKey: "idle",
      signalName: "ready",
    });
  }

  const columns: BoardColumn[] = [];
  if (needsYouCards.length > 0) {
    columns.push({ key: "needs-you", title: "Needs you", cards: needsYouCards });
  }
  if (workingCards.length > 0) {
    columns.push({ key: "working", title: "Working", cards: workingCards });
  }
  if (idleCards.length > 0) {
    columns.push({ key: "idle", title: "Idle", cards: idleCards });
  }
  if (parkedCards.length > 0) {
    columns.push({ key: "parked", title: "Parked", cards: parkedCards });
  }

  return columns;
}

export interface SessionBoardProps {
  sessions: readonly BrowserSession[];
  onOpen: (session: BrowserSession) => void;
  agents?: readonly Agent[];
  pendingClearances?: (agentId: AgentId) => number;
  tuiSessions?: ReadonlyMap<string, { busy?: boolean; awaitingReply?: boolean; refusal?: unknown }>;
  now?: number;
  empty?: JSX.Element;
}

export const SessionBoard = memo(function SessionBoard({
  sessions,
  onOpen,
  agents,
  pendingClearances,
  tuiSessions,
  now,
  empty,
}: SessionBoardProps): JSX.Element {
  const isTablet = useIsTablet();
  const columns = useMemo(
    () => deriveBoardColumns(sessions, agents, pendingClearances, tuiSessions),
    [sessions, agents, pendingClearances, tuiSessions],
  );

  if (columns.length === 0) {
    return (
      <View style={styles.emptyContainer} testID="board-empty">
        {empty ?? (
          <View style={styles.defaultEmpty}>
            <Body color={ink.muted}>No sessions on the board.</Body>
          </View>
        )}
      </View>
    );
  }

  const boardContent = columns.map(col => (
    <View
      key={col.key}
      testID={`board-column-${col.key}`}
      style={[styles.column, isTablet ? styles.tabletColumn : styles.phoneColumn]}
    >
      <View style={styles.columnHeader}>
        <Title color={ink.bright} style={styles.columnTitle} testID={`board-column-title-${col.key}`}>
          {col.title}
        </Title>
        <View style={styles.columnCountBadge}>
          <Label color={ink.muted} testID={`board-column-count-${col.key}`}>
            {col.cards.length}
          </Label>
        </View>
      </View>
      <ScrollView
        style={styles.cardList}
        contentContainerStyle={styles.cardListContent}
        showsVerticalScrollIndicator={false}
      >
        {col.cards.map(card => (
          <SessionCard key={card.session.id} card={card} onOpen={onOpen} now={now} />
        ))}
      </ScrollView>
    </View>
  ));

  return (
    <View style={styles.container} testID="session-board">
      {isTablet ? (
        <View style={styles.tabletRow}>{boardContent}</View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.phoneScrollContent}
        >
          {boardContent}
        </ScrollView>
      )}
    </View>
  );
});

const cardStyle = ({ pressed }: PressableStateCallbackType) => [
  styles.card,
  pressed && styles.cardPressed,
];

interface SessionCardProps {
  card: BoardSessionCard;
  onOpen: (session: BrowserSession) => void;
  now?: number;
}

const SessionCard = memo(function SessionCard({ card, onOpen, now }: SessionCardProps): JSX.Element {
  const { session, signalName, reason } = card;
  const project = projectBasename(session.cwd);
  const tone = signal[signalName];
  const wash = signalWash[signalName];
  const title = session.title || "Untitled session";
  const elapsed = formatAge(session.lastActiveAt, now);
  const msgText = `${session.messageCount} msg${session.messageCount === 1 ? "" : "s"}`;
  const costText = session.cost != null ? formatCostReading(session.cost) : null;

  return (
    <Pressable
      testID={`session-card-${session.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${title}`}
      onPress={() => onOpen(session)}
      style={cardStyle}
    >
      <View style={styles.cardHead}>
        <View style={styles.cardHeadLead}>
          <View
            testID={`session-card-signal-${session.id}`}
            style={[styles.signalDot, { backgroundColor: tone }]}
          />
          <Kicker color={ink.muted} numberOfLines={1} testID={`session-card-project-${session.id}`}>
            {project}
          </Kicker>
        </View>
      </View>

      <Title
        color={ink.bright}
        numberOfLines={2}
        style={styles.cardTitle}
        testID={`session-card-title-${session.id}`}
      >
        {title}
      </Title>

      {reason ? (
        <View
          testID={`session-card-reason-${session.id}`}
          style={[styles.reasonChip, { backgroundColor: wash }]}
        >
          <Label color={tone} style={styles.reasonText}>
            {reason}
          </Label>
        </View>
      ) : null}

      <View style={styles.cardMeta}>
        <Data color={ink.muted} style={styles.metaData} testID={`session-card-elapsed-${session.id}`}>
          {elapsed}
        </Data>
        <Data color={ink.muted} style={styles.metaData} testID={`session-card-messages-${session.id}`}>
          {msgText}
        </Data>
        {costText !== null ? (
          <Data color={ink.muted} style={styles.metaData} testID={`session-card-spend-${session.id}`}>
            {costText}
          </Data>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: ground.surface,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.step,
  },
  defaultEmpty: {
    alignItems: "center",
    justifyContent: "center",
    padding: space.loose,
  },
  tabletRow: {
    flex: 1,
    flexDirection: "row",
    gap: space.step,
    padding: space.step,
  },
  phoneScrollContent: {
    padding: space.step,
    gap: space.step,
  },
  column: {
    backgroundColor: ground.base,
    borderRadius: radius.control,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    padding: space.snug,
    gap: space.snug,
  },
  tabletColumn: {
    flex: 1,
    minWidth: 180,
  },
  phoneColumn: {
    width: 280,
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.tight,
    paddingVertical: space.tight,
  },
  columnTitle: {
    fontSize: 14,
    lineHeight: 18,
  },
  columnCountBadge: {
    backgroundColor: ground.raised,
    paddingHorizontal: space.snug,
    paddingVertical: space.hair,
    borderRadius: radius.pill,
  },
  cardList: {
    flex: 1,
  },
  cardListContent: {
    gap: space.snug,
    paddingBottom: space.step,
  },
  card: {
    backgroundColor: ground.raised,
    borderRadius: radius.control,
    borderWidth: stroke.hair,
    borderColor: ground.line,
    padding: space.step,
    gap: space.snug,
  },
  cardPressed: {
    backgroundColor: ground.active,
    borderColor: ground.edge,
  },
  cardHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardHeadLead: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.snug,
    flex: 1,
  },
  signalDot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  cardTitle: {
    fontSize: 15,
    lineHeight: 20,
  },
  reasonChip: {
    alignSelf: "flex-start",
    paddingHorizontal: space.snug,
    paddingVertical: space.tight,
    borderRadius: radius.control,
  },
  reasonText: {
    fontSize: 12,
  },
  cardMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.step,
    marginTop: space.tight,
  },
  metaData: {
    fontSize: 12,
  },
});
