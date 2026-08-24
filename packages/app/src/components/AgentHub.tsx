import { type Agent, type AgentState, COLLAB_GUEST_AGENT_SOURCE, TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Body, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, signalWash, space, stroke, TOUCH_TARGET } from "../design/tokens.ts";

export interface AgentHubNode {
  agent: Agent;
  children: AgentHubNode[];
}

/**
 * Turns the daemon's flat agent registry into a stable forest. A malformed
 * parent reference never hides a worker: it remains a root until the daemon
 * sends the next coherent snapshot.
 */
export function agentHubTree(agents: readonly Agent[]): AgentHubNode[] {
  const byId = new Map(agents.map(agent => [agent.id, { agent, children: [] as AgentHubNode[] }]));
  const roots: AgentHubNode[] = [];
  const attached = new Set<string>();

  for (const node of byId.values()) {
    const parent = node.agent.parentAgentId === undefined ? undefined : byId.get(node.agent.parentAgentId);
    if (parent === undefined || parent === node || createsCycle(node, parent, byId)) continue;
    parent.children.push(node);
    attached.add(node.agent.id);
  }
  for (const node of byId.values()) {
    if (!attached.has(node.agent.id)) roots.push(node);
  }
  const compare = (left: AgentHubNode, right: AgentHubNode) =>
    left.agent.createdAt.localeCompare(right.agent.createdAt) || left.agent.name.localeCompare(right.agent.name);
  const sort = (nodes: AgentHubNode[]): void => {
    nodes.sort(compare);
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

/**
 * The subagents working under one session, at any depth, in the same shape
 * the hub renders.
 *
 * Built from the whole roster rather than a pre-filtered slice: a sub's
 * parent may itself be a sub, so the links only resolve when every row is
 * present, and `agentHubTree` is the one place that resolution lives. An
 * unknown id and a session with no subs are the same answer, an empty
 * forest, because a caller cannot act differently on the two.
 */
export function subagentsOf(agents: readonly Agent[], parentId: string): AgentHubNode[] {
  const found = findNode(agentHubTree(agents), parentId);
  return found?.children ?? [];
}

function findNode(nodes: readonly AgentHubNode[], id: string): AgentHubNode | undefined {
  for (const node of nodes) {
    if (node.agent.id === id) return node;
    const nested = findNode(node.children, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/**
 * Whether opening this subagent lands on a transcript.
 *
 * `acpSessionId` is the whole answer: it is what an attach addresses, and the
 * two mirrors that create subagent rows differ on exactly this field. The
 * supervisor's ACP mirror sets it when the host's registry reports a session
 * id, so that row opens. The collab guest leg cannot: the room streams the
 * mirrored session's transcript and nothing else, so a sub it mirrored has no
 * transcript to reach and opening it would land on an empty log that looks
 * like a session that lost its history. Those rows stay informational, which
 * is a smaller lie than a blank transcript.
 */
export function subagentOpenable(agent: Agent): boolean {
  return agent.acpSessionId !== undefined;
}

export interface AgentHubProps {
  /**
   * The full roster, not a pre-filtered subagent list. The hub drops main
   * agents itself (OMP's own Agent Hub convention: the main conversation is
   * the ambient session view, already on screen as the top-level Fleet row),
   * and it needs the roster to say WHY it is empty when it is.
   */
  agents: readonly Agent[];
  /** Open this exact root or nested agent's durable transcript. */
  onOpen: (agent: Agent) => void;
  /** A fixed clock makes runtime output deterministic for callers and tests. */
  now?: number;
  testID?: string;
}

/**
 * Why the hub has nothing to list. The only feed a real omp host speaks is
 * the collab room's registry broadcast, so the roster divides into sessions
 * the daemon co-drives (shared, reporting) and everything else (no feed
 * exists for them at all). An empty hub that cannot tell those apart reads
 * as "no subagents" when the truth is "nothing shared", which is the defect
 * this state exists to kill.
 */
export type AgentHubEmpty = "unshared" | "sharedQuiet" | "sharedQuietWithOwned";

/**
 * Classify an empty hub from the roster. Live rows only: a stopped guest's
 * room is gone, and a roster with nothing live has no session to explain
 * about, so both render nothing at all.
 */
export function agentHubEmptyReason(agents: readonly Agent[]): AgentHubEmpty | null {
  const live = agents.filter(agent => !TERMINAL_AGENT_STATES.includes(agent.state));
  if (live.length === 0) return null;
  const shared = live.some(agent => agent.labels.source === COLLAB_GUEST_AGENT_SOURCE);
  const owned = live.some(agent => agent.labels.source !== COLLAB_GUEST_AGENT_SOURCE);
  if (shared && owned) return "sharedQuietWithOwned";
  if (shared) return "sharedQuiet";
  return "unshared";
}

/** What each empty reason says, in words the operator can act on. */
const AGENT_HUB_EMPTY_COPY: Record<AgentHubEmpty, string> = {
  unshared:
    "Subagents appear for a session whose operator has shared it with this daemon; nothing appears for one nobody has.",
  sharedQuiet: "Shared sessions report no subagents.",
  sharedQuietWithOwned: "Shared sessions report no subagents; sessions this daemon owns have no subagent feed.",
};

/**
 * Why a listed subagent is not a control. Stated on the row rather than
 * discovered by tapping it: the transcript was never shared, which is a fact
 * about the link and not about the subagent.
 */
export const SUBAGENT_UNOPENABLE = "transcript not shared";

function createsCycle(node: AgentHubNode, parent: AgentHubNode, byId: ReadonlyMap<string, AgentHubNode>): boolean {
  const lineage = new Set([node.agent.id]);
  let ancestor: AgentHubNode | undefined = parent;
  while (ancestor !== undefined) {
    if (lineage.has(ancestor.agent.id)) return true;
    lineage.add(ancestor.agent.id);
    ancestor = ancestor.agent.parentAgentId === undefined ? undefined : byId.get(ancestor.agent.parentAgentId);
  }
  return false;
}

/**
 * Renders the subagent forest, or one line saying why there is none.
 *
 * Absence is still the render for a roster with nothing live: no session
 * exists to wonder about, and a standing block above the sessions list that
 * only says nothing is happening is chrome, not information. But a live
 * roster with an empty hub is a claim, and the claim has to name its cause:
 * an unshared session and a subagent-free one are indistinguishable without
 * it. The block is a heading and one line, never the padded empty card this
 * component once refused to be.
 */
export function AgentHub({
  agents,
  onOpen,
  now = Date.now(),
  testID = "agent-hub",
}: AgentHubProps): JSX.Element | null {
  const subs = agents.filter(candidate => candidate.parentAgentId !== undefined);
  const tree = agentHubTree(subs);
  if (tree.length === 0) {
    const reason = agentHubEmptyReason(agents);
    if (reason === null) return null;
    return (
      <View style={styles.hub} testID={testID} accessibilityLabel="Agent hierarchy">
        <View style={styles.heading}>
          <Kicker color={ink.muted}>AGENT HUB</Kicker>
        </View>
        <Label testID={`${testID}-empty`} color={ink.muted}>
          {AGENT_HUB_EMPTY_COPY[reason]}
        </Label>
      </View>
    );
  }
  return (
    <View style={styles.hub} testID={testID} accessibilityLabel="Agent hierarchy">
      <View style={styles.heading}>
        <Kicker color={ink.muted}>AGENT HUB</Kicker>
        <Label color={ink.plain}>{`${subs.length} ${subs.length === 1 ? "agent" : "agents"}`}</Label>
      </View>
      {tree.map(node => (
        <AgentHubBranch key={node.agent.id} node={node} depth={0} now={now} onOpen={onOpen} />
      ))}
    </View>
  );
}

/**
 * One subagent and its own subs, as a row plus whatever nests under it.
 *
 * Exported because the session detail renders the same forest scoped to one
 * session: two drawings of a subagent would drift the moment either grew a
 * field, and the operator would be reading two different claims about the
 * same row.
 *
 * The row is a control only when it leads somewhere. When it does not, it
 * renders as text with the reason beside it: a pressable that opens an empty
 * transcript teaches an operator that a subagent lost its history, which is
 * a worse lie than saying the transcript was never shared.
 */
export function AgentHubBranch({
  node,
  depth,
  now,
  onOpen,
}: {
  node: AgentHubNode;
  depth: number;
  now: number;
  onOpen: (agent: Agent) => void;
}): JSX.Element {
  const { agent } = node;
  const metrics = agent.metrics;
  const runtimeMs = metrics?.durationMs ?? Math.max(0, now - Date.parse(agent.createdAt));
  const status = statusSignal(agent.state);
  const metricsLabel =
    metrics === undefined
      ? `runtime ${formatRuntime(runtimeMs)}`
      : `${metrics.usedTokens.toLocaleString()} tokens · ${formatRuntime(runtimeMs)}`;
  const costLabel = metrics?.costAmount === undefined ? null : `cost ${metrics.costAmount.toFixed(4)}`;
  const openable = subagentOpenable(agent);
  const body = (
    <>
      <View style={[styles.status, { backgroundColor: signalWash[status] }]}>
        <Label color={signal[status]}>{agent.state}</Label>
      </View>
      <View style={styles.details}>
        <Body color={ink.bright}>{agent.name}</Body>
        {agent.taskTitle === undefined ? null : <Label color={ink.plain}>{agent.taskTitle}</Label>}
        <View style={styles.meta}>
          {agent.model === undefined ? null : <Kicker color={ink.muted}>{agent.model}</Kicker>}
          <Kicker color={ink.muted}>{metricsLabel}</Kicker>
          {costLabel === null ? null : <Kicker color={ink.muted}>{costLabel}</Kicker>}
          {openable ? null : (
            <Kicker color={ink.faint} testID={`agent-hub-unopenable-${agent.id}`}>
              {SUBAGENT_UNOPENABLE}
            </Kicker>
          )}
        </View>
      </View>
    </>
  );

  return (
    <View style={[styles.branch, depth > 0 && styles.nested]} testID={`agent-hub-${agent.id}`}>
      {openable ? (
        <Pressable
          testID={`agent-hub-open-${agent.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${agent.name} session`}
          onPress={() => onOpen(agent)}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: ground.active }]}
        >
          {body}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={`${agent.name}, ${agent.state}. ${SUBAGENT_UNOPENABLE}`}
          style={styles.row}
          testID={`agent-hub-row-${agent.id}`}
        >
          {body}
        </View>
      )}
      {node.children.map(child => (
        <AgentHubBranch key={child.agent.id} node={child} depth={depth + 1} now={now} onOpen={onOpen} />
      ))}
    </View>
  );
}

function statusSignal(state: AgentState): keyof typeof signal {
  if (state === "busy") return "amber";
  if (state === "idle") return "sage";
  if (state === "waiting" || state === "provisioning" || state === "starting") return "ochre";
  if (state === "failed") return "oxide";
  return "slate";
}

function formatRuntime(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

const styles = StyleSheet.create({
  hub: {
    gap: space.snug,
    padding: space.wide,
    backgroundColor: ground.surface,
    borderBottomWidth: stroke.heavy,
    borderBottomColor: ground.edge,
  },
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  branch: { gap: space.tight },
  nested: {
    marginLeft: space.wide,
    paddingLeft: space.snug,
    borderLeftWidth: stroke.hair,
    borderLeftColor: ground.edge,
  },
  row: { minHeight: TOUCH_TARGET, flexDirection: "row", gap: space.snug, alignItems: "flex-start" },
  status: { minWidth: 64, paddingHorizontal: space.tight, paddingVertical: space.hair, alignItems: "center" },
  details: { flex: 1, gap: space.hair },
  meta: { flexDirection: "row", flexWrap: "wrap", columnGap: space.snug, rowGap: space.hair },
});
