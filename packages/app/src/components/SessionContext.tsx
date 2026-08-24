/**
 * What is true about the open session, above its transcript.
 *
 * The log answers "what happened". Three questions it cannot answer sit
 * beside it and used to require leaving the screen or guessing: what the
 * session has left to do, who is doing it, and what it is running as. This
 * panel is those three and nothing else.
 *
 * It is a band, never a rail. Collapsed it is one row, so the transcript
 * keeps every point it had; the split's detail pane is not wide enough on any
 * iPad to give a third column real width without starving the log, and a
 * column that starves the log is the layout this deliberately is not. The
 * tablet opens it by default because it has the vertical room; a phone does
 * not, so the phone starts collapsed with the counts already on the header.
 *
 * Every section is absent when it has nothing. A "0 todos" row and a "no
 * subagents" card are the same defect: chrome that reads as a measurement.
 * The one exception is a claim the operator would otherwise misread, and it
 * names its cause rather than showing an empty list -- the rule the Agent Hub
 * already follows.
 */

import type { Agent } from "@ompd/core/contracts";
import { type JSX, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { shortenPath } from "../design/format.ts";
import { Glyph } from "../design/icons.tsx";
import { useIsTablet } from "../design/layout.ts";
import { Body, Data, Kicker, Label } from "../design/text.tsx";
import { ground, ink, type SignalName, signal, signalWash, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";
import type { PlanEntry, PlanStatus, SessionState } from "../session/model.ts";
import { AgentHubBranch, type AgentHubNode, subagentsOf } from "./AgentHub.tsx";

/**
 * How this device reaches the open session, when that is not simply "the
 * daemon owns it". Passed rather than derived: the console holds the join
 * record, and a component that guessed from an agent's labels would be
 * reading a second copy of the same fact.
 */
export type SessionOrigin = "owned" | "co-driven" | "watching";

/**
 * Everything the panel needs that the session screen cannot see on its own.
 * One object rather than three props, the same shape `SessionVoice` uses, so
 * a caller cannot wire two thirds of a panel and get a plausible render.
 */
export interface SessionContextSource {
  /** The whole roster, so a sub whose parent is itself a sub still resolves. */
  readonly agents: readonly Agent[];
  readonly origin: SessionOrigin;
  /** Open a subagent's transcript. Called only for a row that has one. */
  readonly onOpenSubagent: (agent: Agent) => void;
}

export interface SessionContextProps extends SessionContextSource {
  /** The open session's agent, for its identity and its subagents' parent id. */
  agent: Agent;
  /** The open session's own reduced state: its todos, its clearances, its tools. */
  session: SessionState;
  /** A fixed clock keeps subagent runtimes deterministic for tests. */
  now?: number;
  /** Force the open/closed default instead of taking it from the screen class. */
  defaultOpen?: boolean;
}

/** One phase of a todo list, or the single unnamed group of a flat one. */
export interface TodoPhase {
  /** The phase heading, or null when the producer sent an ungrouped list. */
  name: string | null;
  todos: readonly PlanEntry[];
}

/**
 * Groups todos under their phase headings, preserving the producer's order.
 *
 * Consecutive runs rather than a keyed bucket: the todo list is a document
 * the operator wrote top to bottom, and a phase that appears twice in it is
 * two places in that document, not one group to merge. Merging would reorder
 * their work to make a tidier list.
 */
export function todoPhases(plan: readonly PlanEntry[]): TodoPhase[] {
  const phases: Array<{ name: string | null; todos: PlanEntry[] }> = [];
  for (const todo of plan) {
    const name = todo.phase ?? null;
    const current = phases.at(-1);
    if (current !== undefined && current.name === name) current.todos.push(todo);
    else phases.push({ name, todos: [todo] });
  }
  return phases;
}

/**
 * How far the list has got. `abandoned` counts as settled but not as done:
 * dropping a task on purpose is progress an operator has to be able to see,
 * and calling it finished would make a half-abandoned list read as complete.
 */
export function todoProgress(plan: readonly PlanEntry[]): { done: number; settled: number; total: number } {
  let done = 0;
  let settled = 0;
  for (const todo of plan) {
    if (todo.status === "completed") done += 1;
    if (todo.status === "completed" || todo.status === "abandoned") settled += 1;
  }
  return { done, settled, total: plan.length };
}

const TODO_LABELS: Record<PlanStatus, string> = {
  pending: "pending",
  in_progress: "in progress",
  completed: "done",
  blocked: "blocked",
  abandoned: "dropped",
};

/**
 * A todo's colour is its state's meaning, from the one palette: amber is work
 * in flight, sage is work finished, ochre is held on something that is not an
 * error, and slate is cold -- not started, or stopped on purpose.
 */
const TODO_SIGNALS: Record<PlanStatus, SignalName> = {
  pending: "slate",
  in_progress: "amber",
  completed: "sage",
  blocked: "ochre",
  abandoned: "slate",
};

/**
 * Why a co-driven session lists no todos, in the one case where silence is a
 * claim rather than an absence.
 *
 * A session that has never used the todo tool has genuinely nothing to show
 * and shows nothing. But an owned session cannot be distinguished from that
 * by looking, and it is worth saying that its todos DO arrive, so an operator
 * who sees the section missing knows they are looking at a session with no
 * todo list rather than at a surface that cannot report one.
 */
export const TODO_ABSENT_WHILE_BUSY = "No todo list yet. One appears as soon as this session writes one.";

export function SessionContext(props: SessionContextProps): JSX.Element | null {
  const { agent, session } = props;
  const tablet = useIsTablet();
  const [open, setOpen] = useState(props.defaultOpen ?? tablet);

  const subagents = subagentsOf(props.agents, agent.id);
  const phases = todoPhases(session.plan);
  const progress = todoProgress(session.plan);
  const rows = contextRows(props);
  // A busy session with no list is the one absence worth naming; a quiet one
  // is not, and neither is a stopped one.
  const explainMissingTodos = session.plan.length === 0 && agent.state === "busy";

  if (session.plan.length === 0 && subagents.length === 0 && rows.length === 0 && !explainMissingTodos) return null;

  const summary = [
    session.plan.length === 0 ? null : `${progress.done}/${progress.total} todos`,
    subagents.length === 0 ? null : `${subagents.length} ${subagents.length === 1 ? "subagent" : "subagents"}`,
  ]
    .filter(part => part !== null)
    .join(" · ");

  return (
    <View style={styles.panel} testID="session-context">
      <Pressable
        accessibilityLabel={
          open ? "Hide this session's context" : `Show this session's context${summary === "" ? "" : `: ${summary}`}`
        }
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          setOpen(current => !current);
        }}
        style={({ pressed }) => [styles.head, pressed && { backgroundColor: ground.active }]}
        testID="session-context-toggle"
      >
        <Glyph name="tasks" size={13} color={ink.muted} />
        <Kicker color={ink.muted} style={styles.headTitle}>
          Session
        </Kicker>
        {summary === "" ? null : (
          <Data color={ink.plain} testID="session-context-summary">
            {summary}
          </Data>
        )}
        <View style={[styles.chevron, !open && styles.chevronClosed]}>
          <Glyph name="chevron" size={12} color={ink.faint} />
        </View>
      </Pressable>

      {!open ? null : (
        // Bounded and scrollable: a forty-item todo list under nine subagents
        // would otherwise push the transcript off a phone entirely, and this
        // panel is never allowed to become the screen.
        <ScrollView
          contentContainerStyle={styles.bodyContent}
          style={[styles.body, tablet ? styles.bodyTablet : styles.bodyPhone]}
          testID="session-context-body"
        >
          {session.plan.length === 0 ? (
            explainMissingTodos ? (
              <View style={styles.section}>
                <Kicker color={ink.muted}>Todos</Kicker>
                <Label color={ink.muted} testID="session-context-todos-absent">
                  {TODO_ABSENT_WHILE_BUSY}
                </Label>
              </View>
            ) : null
          ) : (
            <View style={styles.section} testID="session-context-todos">
              <View style={styles.sectionHead}>
                <Kicker color={ink.muted}>Todos</Kicker>
                <Data color={ink.plain} testID="session-context-todo-progress">
                  {`${progress.done}/${progress.total}`}
                </Data>
              </View>
              {phases.map((phase, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a phase has no id and the same heading may legitimately appear twice, so position is its only identity; the whole list is replaced on every change and never reordered in place.
                <View key={`${index}-${phase.name ?? ""}`} style={styles.phase}>
                  {phase.name === null ? null : (
                    <Label color={ink.plain} testID={`session-context-phase-${index}`}>
                      {phase.name}
                    </Label>
                  )}
                  {phase.todos.map((todo, position) => (
                    <TodoRow
                      // biome-ignore lint/suspicious/noArrayIndexKey: a todo carries no id; the list is replaced wholesale on every change, never reordered in place.
                      key={`${position}-${todo.content}`}
                      todo={todo}
                    />
                  ))}
                </View>
              ))}
            </View>
          )}

          {subagents.length === 0 ? null : (
            <View style={styles.section} testID="session-context-subagents">
              <View style={styles.sectionHead}>
                <Kicker color={ink.muted}>Subagents</Kicker>
                <Data color={ink.plain}>{String(subagents.length)}</Data>
              </View>
              {subagents.map((node: AgentHubNode) => (
                <AgentHubBranch
                  key={node.agent.id}
                  node={node}
                  depth={0}
                  now={props.now ?? Date.now()}
                  onOpen={props.onOpenSubagent}
                />
              ))}
            </View>
          )}

          {rows.length === 0 ? null : (
            <View style={styles.section} testID="session-context-state">
              <Kicker color={ink.muted}>State</Kicker>
              {rows.map(row => (
                <View key={row.label} style={styles.row}>
                  <Label color={ink.muted} style={styles.rowLabel}>
                    {row.label}
                  </Label>
                  <Label
                    color={row.tone === undefined ? ink.bright : signal[row.tone]}
                    numberOfLines={1}
                    style={styles.rowValue}
                    testID={`session-context-${row.testID}`}
                  >
                    {row.value}
                  </Label>
                </View>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </View>
  );
}

function TodoRow({ todo }: { todo: PlanEntry }): JSX.Element {
  const tone = TODO_SIGNALS[todo.status];
  const label = TODO_LABELS[todo.status];
  return (
    <View
      accessible
      accessibilityLabel={`${todo.content}: ${label}${todo.blocker === undefined ? "" : `, blocked on ${todo.blocker}`}`}
      style={styles.todo}
    >
      <View style={styles.todoHead}>
        <View style={[styles.todoState, { backgroundColor: signalWash[tone] }]}>
          <Kicker color={signal[tone]}>{label}</Kicker>
        </View>
        <Body
          color={todo.status === "completed" || todo.status === "abandoned" ? ink.muted : ink.bright}
          style={styles.todoText}
        >
          {todo.content}
        </Body>
      </View>
      {todo.blocker === undefined ? null : (
        <Label color={signal.ochre} style={styles.blocker}>
          {`Blocked on ${todo.blocker}`}
        </Label>
      )}
    </View>
  );
}

interface ContextRow {
  label: string;
  value: string;
  /** A colour only where the value is something to act on. */
  tone?: SignalName;
  testID: string;
}

/**
 * The rows the console can actually answer for this session, in the order an
 * operator asks them: what it is running as, where, how this device reaches
 * it, and what it is waiting on.
 *
 * A field this device was never told is left out, never rendered as a dash or
 * a zero: an owned session has no thinking level on the wire, and a session
 * with nothing pending is not a session with zero clearances outstanding.
 */
function contextRows(props: SessionContextProps): ContextRow[] {
  const { agent, session } = props;
  const rows: ContextRow[] = [];
  // The stream's own word first: a co-driven session reports the model the
  // terminal is actually running, while the agent row carries what the
  // registry last recorded.
  const model = session.info.model ?? agent.model;
  if (model !== undefined && model !== null) rows.push({ label: "Model", value: model, testID: "model" });
  if (session.info.thinkingLevel !== null) {
    rows.push({ label: "Thinking", value: session.info.thinkingLevel, testID: "thinking" });
  }
  const cwd = session.info.cwd ?? agent.cwd;
  if (cwd.length > 0) rows.push({ label: "Directory", value: shortenPath(cwd, 3), testID: "cwd" });
  rows.push({ label: "Link", value: ORIGIN_LABELS[props.origin], testID: "origin" });
  if (session.pendingApprovals.length > 0) {
    rows.push({
      label: "Awaiting you",
      value: `${session.pendingApprovals.length} ${session.pendingApprovals.length === 1 ? "clearance" : "clearances"}`,
      tone: "ochre",
      testID: "clearances",
    });
  }
  if (session.activity.running > 0) {
    rows.push({
      label: "Running",
      value: `${session.activity.running} ${session.activity.running === 1 ? "tool" : "tools"}`,
      tone: "amber",
      testID: "running",
    });
  }
  if (session.activity.failed > 0) {
    rows.push({
      label: "Failed",
      value: `${session.activity.failed} ${session.activity.failed === 1 ? "tool" : "tools"}`,
      tone: "oxide",
      testID: "failed",
    });
  }
  return rows;
}

const ORIGIN_LABELS: Record<SessionOrigin, string> = {
  owned: "this daemon owns it",
  "co-driven": "co-driving a shared terminal",
  watching: "watching a shared terminal",
};

const styles = StyleSheet.create({
  panel: {
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.hair,
    borderBottomColor: ground.edge,
  },
  head: {
    alignItems: "center",
    flexDirection: "row",
    gap: space.snug,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  headTitle: { flex: 1 },
  chevron: { paddingLeft: space.tight, transform: [{ rotate: "0deg" }] },
  chevronClosed: { transform: [{ rotate: "-90deg" }] },
  // A ceiling, not a height: a one-todo session takes one todo's worth of
  // space, and only a long list ever scrolls.
  body: { borderTopWidth: stroke.hair, borderTopColor: ground.line },
  bodyPhone: { maxHeight: 220 },
  bodyTablet: { maxHeight: 360 },
  bodyContent: { gap: space.step, padding: space.wide },
  section: { gap: space.snug },
  sectionHead: { alignItems: "baseline", flexDirection: "row", justifyContent: "space-between" },
  phase: { gap: space.tight },
  todo: { gap: space.hair },
  todoHead: { flexDirection: "row", gap: space.snug, alignItems: "flex-start" },
  todoState: { minWidth: 78, paddingHorizontal: space.tight, paddingVertical: space.hair, alignItems: "center" },
  todoText: { flex: 1 },
  blocker: { paddingLeft: 78 + space.snug },
  row: { flexDirection: "row", gap: space.snug },
  rowLabel: { width: 96 },
  rowValue: { flex: 1 },
});
