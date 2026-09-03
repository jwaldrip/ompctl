import { type Agent, type AgentState, COLLAB_GUEST_AGENT_SOURCE, TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import { type JSX, memo, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Surface } from "react-native-paper";
import { rhythm } from "../design/rhythm.ts";
import { Body, Kicker, Label } from "../design/text.tsx";
import { type SignalName, space, stroke } from "../design/tokens.ts";
import { useOmpTheme } from "../design/useOmpTheme.ts";

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
  const theme = useOmpTheme();
  /**
   * Keyed on the roster, which is the only thing the forest depends on.
   *
   * The same defect the session band had, in the component that band borrows
   * its rows from: on a tablet this hub sits beside the detail pane and
   * re-renders on every console frame, so a streaming turn rebuilt the whole
   * subagent forest here too. Fixing only the band would have left the more
   * expensive of the two rebuilds in place.
   */
  const { subs, tree } = useMemo(() => {
    const filtered = agents.filter(candidate => candidate.parentAgentId !== undefined);
    return { subs: filtered, tree: agentHubTree(filtered) };
  }, [agents]);
  const panel = [styles.hub, { backgroundColor: theme.ground.surface, borderBottomColor: theme.ground.edge }];
  if (tree.length === 0) {
    const reason = agentHubEmptyReason(agents);
    if (reason === null) return null;
    return (
      <Surface elevation={0} mode="flat" style={panel} testID={testID} accessibilityLabel="Agent hierarchy">
        <View style={styles.heading}>
          <Kicker color={theme.ink.muted}>AGENT HUB</Kicker>
        </View>
        <Label testID={`${testID}-empty`} color={theme.ink.muted}>
          {AGENT_HUB_EMPTY_COPY[reason]}
        </Label>
      </Surface>
    );
  }
  return (
    <Surface elevation={0} mode="flat" style={panel} testID={testID} accessibilityLabel="Agent hierarchy">
      <View style={styles.heading}>
        <Kicker color={theme.ink.muted}>AGENT HUB</Kicker>
        <Label color={theme.ink.plain}>{`${subs.length} ${subs.length === 1 ? "agent" : "agents"}`}</Label>
      </View>
      {tree.map(node => (
        <AgentHubBranch key={node.agent.id} node={node} depth={0} now={now} onOpen={onOpen} />
      ))}
    </Surface>
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
 *
 * Memoised, because the session detail renders this band directly above a
 * streaming transcript. Its caller hands it a forest whose node identity
 * holds while the roster does, so a turn's tokens re-render the band's own
 * shell and stop there instead of walking every subagent per frame.
 */
export const AgentHubBranch = memo(function AgentHubBranch({
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
  const theme = useOmpTheme();
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
  /**
   * One step of nesting per level, and nothing else.
   *
   * The offset is paid by the ROW, not by the branch box around it, and that
   * is what makes the depth readable: the boxes nest, so an inset on them
   * compounds and the step a row actually sits at becomes a sum nobody can
   * see. Here it is one multiplication -- three levels deep is three steps of
   * `rhythm.indent` -- which is exactly what replaced the `marginLeft` plus
   * `paddingLeft` plus rail that used to add up to one step by accident.
   */
  const indent = depth === 0 ? null : { paddingLeft: depth * rhythm.indent };
  const body = (
    <>
      <View style={[styles.status, { backgroundColor: theme.signalWash[status] }]}>
        <Label color={theme.signal[status]}>{agent.state}</Label>
      </View>
      <View style={styles.details}>
        <Body color={theme.ink.bright}>{agent.name}</Body>
        {agent.taskTitle === undefined ? null : <Label color={theme.ink.plain}>{agent.taskTitle}</Label>}
        <View style={styles.meta}>
          {agent.model === undefined ? null : <Kicker color={theme.ink.muted}>{agent.model}</Kicker>}
          <Kicker color={theme.ink.muted}>{metricsLabel}</Kicker>
          {costLabel === null ? null : <Kicker color={theme.ink.muted}>{costLabel}</Kicker>}
          {openable ? null : (
            <Kicker color={theme.ink.faint} testID={`agent-hub-unopenable-${agent.id}`}>
              {SUBAGENT_UNOPENABLE}
            </Kicker>
          )}
        </View>
      </View>
    </>
  );

  return (
    <View style={styles.branch} testID={`agent-hub-${agent.id}`}>
      {openable ? (
        <Pressable
          testID={`agent-hub-open-${agent.id}`}
          accessibilityRole="button"
          accessibilityLabel={`Open ${agent.name} session`}
          onPress={() => onOpen(agent)}
          style={({ pressed }) => [styles.row, indent, pressed && { backgroundColor: theme.ground.active }]}
        >
          {body}
        </Pressable>
      ) : (
        <View
          accessible
          accessibilityLabel={`${agent.name}, ${agent.state}. ${SUBAGENT_UNOPENABLE}`}
          style={[styles.row, indent]}
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
});

function statusSignal(state: AgentState): SignalName {
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
    gap: rhythm.rowGap,
    padding: rhythm.gutter,
    borderBottomWidth: stroke.heavy,
  },
  heading: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  branch: { gap: rhythm.rowGap },
  row: { minHeight: rhythm.minTarget, flexDirection: "row", gap: rhythm.rowGapTight, alignItems: "flex-start" },
  // 64 and the two pads inside it are the state swatch's own geometry, not a
  // rhythm job: `minWidth` keeps a column of them aligned without ever cutting
  // the longest state ("provisioning"), which a fixed width would.
  status: { minWidth: 64, paddingHorizontal: space.tight, paddingVertical: space.hair, alignItems: "center" },
  details: { flex: 1, gap: rhythm.pairGap },
  meta: { flexDirection: "row", flexWrap: "wrap", columnGap: rhythm.cardGap, rowGap: rhythm.pairGap },
});
