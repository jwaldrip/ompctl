/**
 * The Cowork surface: the task sidebar as primary navigation, with skills,
 * connectors, and plugins one tap away.
 *
 * Two layouts, one component tree — the same split the console already draws
 * at `SPLIT_WIDTH`, applied to a different shape of screen.
 *
 * Wide (>= SPLIT_WIDTH): a fixed nav rail, the task sidebar, and a content
 * pane sit side by side, because there is room for the primary surface and
 * whatever it opens onto at once — the same reasoning `Console` already
 * applies to the bay and the log.
 *
 * Narrow (down to 390px): a permanent side rail has nowhere to go — at 390px
 * a 240px sidebar plus a 64px rail leaves under 90px for content, which is
 * not a screen, it's a sliver. So the rail becomes a bottom tab bar (four
 * destinations, each a full screen), the sidebar's task list becomes the
 * Tasks tab's own full-screen content, and selecting a task pushes its detail
 * over the list with a back button — the same push-not-split pattern
 * `SessionScreen` already uses for the fleet vs. one agent's log. A bottom
 * tab bar beats a hamburger drawer here because these are four permanent
 * peer destinations an operator returns to constantly, not settings visited
 * once — the cost of always-visible icons is worth it at that frequency.
 *
 * The tasks tab also carries the folder binding: cowork work is scoped to
 * directories on the daemon's own disk, mounted into the container it starts
 * there. The binding rides the tasks tab rather than sitting behind a fifth
 * destination because it is the scope for the work that tab lists, not a peer
 * place an operator returns to; and the picker takes the whole screen for the
 * one-handed moment of choosing, then hands the absolute path back.
 */

import type { JSX } from "react";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { ConnectorsView, PluginsView, SkillsView } from "../components/CoworkCatalogueViews.tsx";
import { TaskDetail } from "../components/TaskDetail.tsx";
import type { NewTaskInput } from "../components/TaskSidebar.tsx";
import { TaskSidebar } from "../components/TaskSidebar.tsx";
import type { TaskListState } from "../cowork/tasks.ts";
import { taskListView } from "../cowork/tasks.ts";
import type { ConnectorSummary, SkillSummary, Task } from "../cowork/types.ts";
import type { BoundFolder, ContainerStart } from "../cowork/useCoworkFolders.ts";
import { useCoworkFolders } from "../cowork/useCoworkFolders.ts";
import type { GlyphName } from "../design/icons.tsx";
import { Glyph } from "../design/icons.tsx";
import { useSplitLayout } from "../design/layout.ts";
import { Code, Kicker, Label } from "../design/text.tsx";
import { ground, ink, signal, space, stroke, TOUCH_TARGET, type } from "../design/tokens.ts";
import type { Connection } from "../platform/connection.ts";
import type { RemoteStartClient } from "../remote/useRemoteStart.ts";
import { FolderPickerScreen } from "./FolderPickerScreen.tsx";

export type CoworkView = "tasks" | "skills" | "connectors" | "plugins";

interface Destination {
  id: CoworkView;
  label: string;
  glyph: GlyphName;
}

const DESTINATIONS: readonly Destination[] = [
  { id: "tasks", label: "Tasks", glyph: "tasks" },
  { id: "skills", label: "Skills", glyph: "skill" },
  { id: "connectors", label: "Connectors", glyph: "connector" },
  { id: "plugins", label: "Plugins", glyph: "plugin" },
];

export interface CoworkScreenProps {
  tasks: TaskListState;
  skills: readonly SkillSummary[];
  connectors: readonly ConnectorSummary[];
  onStartTask: (input: NewTaskInput) => void;
  onInvokeSkill: (skill: SkillSummary) => void;
  onOpenSession: (agentId: string) => void;
  now?: number;
  /**
   * The daemon this device is driving. Present, the tasks tab gains the
   * folder binding and its picker: both need the daemon's own routes, its
   * listing to browse by and its agent route to start the container. Absent,
   * the section is not drawn rather than drawn dead.
   */
  connection?: Connection;
  /**
   * An already-started client the picker may share, so choosing a folder does
   * not open a second socket beside the console's. Absent, the picker builds
   * and closes its own for exactly as long as it is on screen.
   */
  client?: RemoteStartClient;
}

export function CoworkScreen(props: CoworkScreenProps): JSX.Element {
  const { tasks, skills, connectors, onStartTask, onInvokeSkill, onOpenSession, now } = props;
  const split = useSplitLayout();
  const [view, setView] = useState<CoworkView>("tasks");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [folderState, folderActions] = useCoworkFolders(props.connection);
  const [picking, setPicking] = useState(false);

  const listView = useMemo(() => taskListView(tasks), [tasks]);
  const selectedTask = selectedTaskId === null ? null : (tasks.tasks.get(selectedTaskId) ?? null);

  const selectTask = (task: Task): void => {
    setSelectedTaskId(task.id);
    setView("tasks");
  };

  const startTask = (input: NewTaskInput): void => {
    setSelectedTaskId(null);
    onStartTask(input);
  };

  // Choosing a directory takes the whole screen, on the BrowseScreen brief:
  // standing up, one-handed, with the confirm pinned where a thumb reaches.
  // A half-height sheet over a task list would serve neither the picker nor
  // the list it covers. Rendered after every hook above so the early return
  // cannot change how many of them run.
  if (props.connection !== undefined && picking) {
    // Rendered per branch rather than built as one spread object: the
    // picker's props are a discriminated union (own a socket via a
    // connection, or share the caller's client), and each branch names its
    // member directly instead of assembling a shape the union then rejects.
    const pick = (path: string): void => {
      folderActions.bind(path);
      setPicking(false);
    };
    const back = (): void => setPicking(false);
    return props.client === undefined ? (
      <FolderPickerScreen connection={props.connection} onPick={pick} onBack={back} />
    ) : (
      <FolderPickerScreen client={props.client} onPick={pick} onBack={back} />
    );
  }

  // The binding rides the tasks tab in both layouts, above whatever else the
  // tab is showing: it stays reachable beside a task's detail because it is
  // the scope that detail runs under, not a screen of its own.
  const folderBinding =
    props.connection === undefined ? null : (
      <FolderBinding
        folders={folderState.folders}
        start={folderState.start}
        onAdd={() => setPicking(true)}
        onUnbind={folderActions.unbind}
        onStart={folderActions.start}
        onOpenSession={onOpenSession}
      />
    );

  const sidebar = (
    <TaskSidebar
      tasks={listView}
      skills={skills}
      selectedTaskId={selectedTaskId}
      onSelectTask={selectTask}
      onStartTask={startTask}
      now={now}
    />
  );

  const content = (() => {
    if (view === "skills") return <SkillsView skills={skills} onInvoke={onInvokeSkill} />;
    if (view === "connectors") return <ConnectorsView connectors={connectors} />;
    if (view === "plugins") return <PluginsView skills={skills} connectors={connectors} />;
    if (selectedTask !== null) return <TaskDetail task={selectedTask} onOpenSession={onOpenSession} now={now} />;
    return <TasksEmpty />;
  })();

  if (split) {
    return (
      <View style={styles.wide} testID="cowork-screen">
        <Nav orientation="side" active={view} onSelect={setView} />
        <View style={styles.sidebarColumn}>{sidebar}</View>
        <View style={styles.contentColumn}>
          {view === "tasks" ? folderBinding : null}
          {content}
        </View>
      </View>
    );
  }

  // Narrow: the active tab owns the whole screen. The tasks tab shows the
  // sidebar's own list (not the split layout's "select a task" placeholder)
  // until a task is selected, then pushes its detail over the list rather
  // than splitting the width between them.
  const showingTaskList = view === "tasks" && selectedTask === null;
  const narrowContent = showingTaskList ? sidebar : content;

  return (
    <View style={styles.narrow} testID="cowork-screen">
      {view === "tasks" && selectedTask !== null ? (
        <Pressable
          testID="task-detail-back"
          accessibilityRole="button"
          accessibilityLabel="Back to tasks"
          onPress={() => setSelectedTaskId(null)}
          style={styles.back}
        >
          <Glyph name="back" size={14} color={ink.plain} />
          <Label color={ink.plain}>Tasks</Label>
        </Pressable>
      ) : null}
      {view === "tasks" ? folderBinding : null}
      <View style={styles.narrowContent}>{narrowContent}</View>
      <Nav orientation="bottom" active={view} onSelect={setView} />
    </View>
  );
}

function TasksEmpty(): JSX.Element {
  return (
    <View style={styles.empty} testID="task-detail-empty">
      <Glyph name="tasks" size={22} color={ground.edge} />
      <Label color={ink.muted}>Select a task to see its detail.</Label>
    </View>
  );
}

/**
 * The bound set, as the operator scopes it before any container exists.
 *
 * Every state the start can end in is drawn here by name, because a surface
 * that silently shows nothing on a refusal is the defect this exists to stop:
 * idle, starting, started (with the way into the session), and refused (with
 * its reason, and whether another attempt is worth it).
 */
function FolderBinding({
  folders,
  start,
  onAdd,
  onUnbind,
  onStart,
  onOpenSession,
}: {
  folders: readonly BoundFolder[];
  start: ContainerStart;
  onAdd: () => void;
  onUnbind: (hostPath: string) => void;
  onStart: () => void;
  onOpenSession: (agentId: string) => void;
}): JSX.Element {
  return (
    <View style={styles.folders} testID="cowork-folders">
      <View style={styles.foldersHead}>
        <Kicker color={ink.muted}>Bound folders</Kicker>
        <Pressable accessibilityRole="button" onPress={onAdd} style={styles.add} testID="cowork-folder-add">
          <Glyph name="newTask" color={ink.bright} size={12} />
          <Label color={ink.bright}>Add folder</Label>
        </Pressable>
      </View>
      {folders.length === 0 ? (
        <Label color={ink.muted} testID="cowork-folders-empty">
          Nothing bound. The container will see only its own workspace.
        </Label>
      ) : (
        folders.map(folder => (
          <View key={folder.hostPath} style={styles.folderRow} testID={`cowork-folder-${folder.hostPath}`}>
            <Glyph name="folder" size={13} color={ink.plain} />
            <Code numberOfLines={1} style={styles.folderPath}>
              {folder.hostPath}
            </Code>
            {/* The mode travels with the row because the daemon mounts each
                path at this same absolute path inside: what the operator
                reads here is exactly what the container gets. */}
            <Label color={ink.faint}>{folder.mode}</Label>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Unbind ${folder.hostPath}`}
              onPress={() => onUnbind(folder.hostPath)}
              style={styles.unbind}
              testID={`cowork-folder-unbind-${folder.hostPath}`}
            >
              <Glyph name="deny" size={12} color={ink.muted} />
            </Pressable>
          </View>
        ))
      )}
      {start.status === "refused" ? (
        <View style={styles.refused} testID="cowork-container-refused">
          <Glyph name="warning" color={signal.ochre} size={13} />
          <Label color={signal.ochre} style={styles.refusedText}>
            {start.reason}
            {start.retryable ? " Worth trying again." : ""}
          </Label>
        </View>
      ) : null}
      {start.status === "started" ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onOpenSession(start.agentId)}
          style={styles.started}
          testID="cowork-container-open"
        >
          <Glyph name="attach" color={signal.sage} size={13} />
          <Label color={signal.sage}>Container running. Open the session.</Label>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: start.status === "starting" }}
          disabled={start.status === "starting"}
          onPress={onStart}
          style={[styles.containerStart, start.status === "starting" && styles.disabled]}
          testID="cowork-container-start"
        >
          <Glyph name="resume" color={ink.inverse} size={13} />
          <Text style={styles.containerStartText}>
            {start.status === "starting" ? "Starting the container..." : "Start the container"}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function Nav({
  orientation,
  active,
  onSelect,
}: {
  orientation: "side" | "bottom";
  active: CoworkView;
  onSelect: (view: CoworkView) => void;
}): JSX.Element {
  return (
    <View style={orientation === "side" ? styles.navSide : styles.navBottom} testID="cowork-nav">
      {DESTINATIONS.map(destination => {
        const isActive = destination.id === active;
        return (
          <Pressable
            key={destination.id}
            testID={`cowork-nav-${destination.id}`}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={destination.label}
            onPress={() => onSelect(destination.id)}
            style={({ pressed }) => [
              orientation === "side" ? styles.navItemSide : styles.navItemBottom,
              pressed && { backgroundColor: ground.active },
            ]}
          >
            <Glyph name={destination.glyph} size={16} color={isActive ? signal.amber : ink.muted} />
            <Kicker color={isActive ? signal.amber : ink.muted}>{destination.label}</Kicker>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wide: { flex: 1, flexDirection: "row", backgroundColor: ground.base },
  narrow: { flex: 1, backgroundColor: ground.base },
  narrowContent: { flex: 1 },
  sidebarColumn: { width: 300, borderRightWidth: stroke.hair, borderRightColor: ground.line },
  contentColumn: { flex: 1 },
  navSide: {
    width: 64,
    borderRightWidth: stroke.hair,
    borderRightColor: ground.line,
    paddingVertical: space.step,
    gap: space.snug,
  },
  navItemSide: { alignItems: "center", gap: space.tight, paddingVertical: space.snug },
  navBottom: {
    flexDirection: "row",
    borderTopWidth: stroke.hair,
    borderTopColor: ground.line,
    backgroundColor: ground.surface,
  },
  navItemBottom: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.tight,
    minHeight: TOUCH_TARGET * 1.1,
  },
  back: { flexDirection: "row", alignItems: "center", gap: space.tight, padding: space.step },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.step },
  folders: {
    borderColor: ground.line,
    borderBottomWidth: stroke.hair,
    gap: space.snug,
    padding: space.step,
  },
  foldersHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  add: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.tight,
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.snug,
  },
  folderRow: { flexDirection: "row", alignItems: "center", gap: space.snug, minHeight: TOUCH_TARGET },
  folderPath: { flex: 1 },
  unbind: { alignItems: "center", justifyContent: "center", minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET },
  refused: {
    alignItems: "center",
    backgroundColor: ground.surface,
    borderColor: signal.ochre,
    borderWidth: stroke.hair,
    flexDirection: "row",
    gap: space.snug,
    padding: space.snug,
  },
  refusedText: { flex: 1 },
  started: { flexDirection: "row", alignItems: "center", gap: space.snug, minHeight: TOUCH_TARGET },
  containerStart: {
    alignItems: "center",
    backgroundColor: signal.sage,
    flexDirection: "row",
    gap: space.snug,
    justifyContent: "center",
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.wide,
  },
  containerStartText: { ...type.title, color: ink.inverse },
  disabled: { opacity: 0.45 },
});
