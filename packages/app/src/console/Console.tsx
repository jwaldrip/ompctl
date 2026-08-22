/**
 * The position: the socket, the surfaces it feeds, and the navigator that
 * presents them.
 *
 * All of the decisions live in `state.ts`. This places them, and hands each
 * surface to `AppNavigator` as a function of the model instead of switching
 * screens by hand. That swap is the point of this file's shape: the hand-rolled
 * switch it replaces gave the app no header, no back gesture, and nowhere to
 * put a control that belongs to the shell rather than to a screen.
 *
 * The browser reducer is separate from the console reducer on purpose: the
 * console reducer answers to the socket and must stay byte-identical to what
 * a live daemon produces; the browser reducer answers to gestures (sort,
 * collapse, archive) that have nothing to do with the wire. `browserSessionsOf`
 * is the seam between them, and it is a temporary one -- see its doc comment.
 *
 * Every callback the list receives holds its identity across a socket frame,
 * `dispatchBrowser` by construction and `onOpen` through a ref. That is not
 * ceremony: the rows are memoised, and a handler rebuilt on each frame would
 * re-render the whole mounted window on every frame of every live turn, which
 * is the same cost as never having windowed the list.
 */

import type { Agent, AgentId } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { AgentHub } from "../components/AgentHub.tsx";
import { Toast } from "../components/Toast.tsx";
import { skillInvocation } from "../cowork/catalog.ts";
import type { NewTaskInput } from "../cowork/tasks.ts";
import { useCowork } from "../cowork/useCowork.ts";
import { useSplitBayWidth, useSplitLayout } from "../design/layout.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body } from "../design/text.tsx";
import { ground, ink, signal, space, stroke } from "../design/tokens.ts";
import type { ShellSelection, ShellSurfaces } from "../nav/AppNavigator.tsx";
import { AppNavigator } from "../nav/AppNavigator.tsx";
import type { Connection, ConnectionList } from "../platform/connection.ts";
import { AgentConfigScreen } from "../screens/AgentConfigScreen.tsx";
import { ConnectionSwitcherScreen } from "../screens/ConnectionSwitcherScreen.tsx";
import { CoworkScreen } from "../screens/CoworkScreen.tsx";
import { FleetScreen } from "../screens/FleetScreen.tsx";
import { InviteScreen } from "../screens/InviteScreen.tsx";
import { RemoteStartScreen } from "../screens/RemoteStartScreen.tsx";
import { RoutinesScreen } from "../screens/RoutinesScreen.tsx";
import { SessionScreen } from "../screens/SessionScreen.tsx";
import { SettingsScreen } from "../screens/SettingsScreen.tsx";
import { TerminalSessionScreen } from "../screens/TerminalSessionScreen.tsx";
import type { BrowserSession, SortField } from "../session/browser.ts";
import { browserReduce, EMPTY_BROWSER } from "../session/browser.ts";
import { deviceMemoVoice } from "../voice/memo.ts";
import type { ConsoleState } from "./state.ts";
import {
  agentFor,
  browserSessionsOf,
  canInvite,
  fleetClearances,
  manageScopeAccess,
  openSessionTarget,
  promptScopeAccess,
  sessionFor,
  tuiPromptAccess,
  tuiSessionFor,
} from "./state.ts";
import { createOmpdClient, useConsole } from "./useConsole.ts";

export interface ConsoleProps {
  connection: Connection;
  /** The shell header's subject: which daemon this device is attached to. */
  daemonLabel: string;
  /** The saved daemons, for the connections route the menu reaches. */
  connections: ConnectionList;
  onAddConnection: () => void;
  onSelectConnection: (id: string) => void;
  onUnpair: (notice?: string) => void;
  /**
   * The socket, so a canned one can drive the whole shell. The same seam
   * `useConsole` exposes, forwarded rather than reinvented: the shell's own
   * behaviour (which route the model opens, what the header carries, whether a
   * screen clears the insets) is only assertable against a client whose frames
   * a test chooses.
   */
  createClient?: (connection: Connection) => OmpdClient;
}
export function Console({
  connection,
  daemonLabel,
  connections,
  onAddConnection,
  onSelectConnection,
  onUnpair,
  createClient = createOmpdClient,
}: ConsoleProps): JSX.Element {
  const [state, actions] = useConsole(connection, createClient, deviceMemoVoice);
  const split = useSplitLayout();
  // The bay's share of the window, clamped between a floor that fits its own
  // sort bar and a ceiling that keeps the log pane fed. A fixed 340 on every
  // tablet whatever the screen is the defect this replaces; the numbers and
  // their reasons live with the other layout rules in design/layout.ts.
  const bayWidth = useSplitBayWidth();
  const [browser, dispatchBrowser] = useReducer(browserReduce, EMPTY_BROWSER);

  useEffect(() => {
    if (state.unauthorized === null) return;
    onUnpair(`${state.unauthorized} Pair this device again to carry on.`);
  }, [state.unauthorized, onUnpair]);

  // The index and the roster are the whole of a row -- `FleetRowSources` says
  // so in the type -- so keying on those two slices keeps the array's identity
  // across every console frame that touched neither: a selection, a terminal
  // reply, and, the case that made leaving a live session take seconds, every
  // chunk of every streaming turn. The reload below is keyed on the rows for
  // the same reason: without both, a live turn rebuilt every row object on the
  // machine per chunk, the browser's state changed identity, and the list
  // re-sorted, re-grouped, and re-rendered its whole mounted window behind a
  // screen nobody could see it through, on the thread the pop animation needs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` is passed whole and read narrowly; the parameter type admits only the two slices below, so this key is exhaustive and keying on `state` itself would rebuild every row on every frame.
  const rows = useMemo(() => browserSessionsOf(state), [state.sessionIndex, state.agents]);

  useEffect(() => {
    dispatchBrowser({ t: "load", sessions: rows });
  }, [rows]);

  const clearances = useMemo(() => fleetClearances(state), [state]);

  // Wide enough for both and nothing open is a hole rather than a choice, so
  // the top strip is taken once. Only once: an operator who backed out of a
  // session on a tablet is not asking the bay to immediately reopen the same
  // log. Phones never hit this path because `split` is false there.
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (!split || state.selected !== null || didAutoSelect.current) return;
    const top = state.agents.find(candidate => candidate.parentAgentId === undefined);
    if (top === undefined) return;
    didAutoSelect.current = true;
    actions.select(top.id);
  }, [split, state.selected, state.agents, actions]);

  // The config pane belongs to the session it was opened on: switching the
  // selection swaps the detail beside it on a tablet, and returning to a
  // session must not resurrect a config screen left over from the last one.
  const [configPane, setConfigPane] = useState<AgentId | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dependency is the signal, not a used value; the pane resets when the selection changes
  useEffect(() => {
    setConfigPane(null);
  }, [state.selected]);

  // Read rather than depended on, so the row handlers below keep one identity
  // for the life of the console.
  const latest = useRef({ state, actions });
  latest.current = { state, actions };

  const onSort = useCallback((field: SortField) => {
    dispatchBrowser({ t: "sort", field });
  }, []);
  const onToggleGroup = useCallback((cwd: string) => {
    dispatchBrowser({ t: "toggleGroup", cwd });
  }, []);
  const onToggleGrouped = useCallback(() => {
    dispatchBrowser({ t: "toggleGrouped" });
  }, []);
  const onToggleArchived = useCallback(() => {
    dispatchBrowser({ t: "toggleArchived" });
  }, []);
  const onArchive = useCallback((session: BrowserSession) => {
    dispatchBrowser({ t: "archive", id: session.id });
  }, []);
  const onUnarchive = useCallback((session: BrowserSession) => {
    dispatchBrowser({ t: "unarchive", id: session.id });
  }, []);
  // Deletion is the one row action that leaves the device: archive and
  // restore are browser-local gestures, while this destroys a transcript on
  // the operator's machine. The row has already taken them through its
  // confirmation by the time this runs, and the fleet updates from the
  // daemon's own pushed index rather than from a local guess about what is
  // now gone.
  const onDelete = useCallback((session: BrowserSession) => {
    latest.current.actions.deleteSession(session.id);
  }, []);
  // Rows are sessions, not agents: the pure resolver in state.ts decides what
  // the tap lands on, and the action owns the impure ways to reach it -- attach,
  // a claim the daemon verifies, or the terminal prompt surface.
  const onOpen = useCallback((session: BrowserSession) => {
    const current = latest.current;
    current.actions.openSession(openSessionTarget(current.state, session.id));
  }, []);
  const onOpenAgent = useCallback((agent: Agent) => {
    latest.current.actions.select(agent.id);
  }, []);

  const log = (agentId: AgentId, back: () => void, openConfig: () => void): JSX.Element => {
    // `agentFor`, not a raw roster lookup: a resumed session starts streaming
    // before any roster frame lists its agent, and the log it is streaming must
    // be on screen rather than waiting for an unrelated roster change. The
    // stand-in it builds is what keeps "That session closed." for genuinely
    // deleted agents instead of every interleaving the relay can produce.
    const agent = agentFor(state, agentId);
    // The route can outlive its agent by one frame: a roster refresh that drops
    // an agent clears the selection, and the pop happens in the same commit's
    // effect. Saying so is better than an empty log pretending to be a session.
    if (agent === null) {
      return (
        <SafeScreen style={styles.gone} testID="session-gone">
          <Body color={ink.muted}>That session closed.</Body>
        </SafeScreen>
      );
    }
    const resumeSummary =
      agent.acpSessionId === undefined ? undefined : state.sessionIndex.find(row => row.id === agent.acpSessionId);
    const resumeTarget =
      agent.acpSessionId === undefined || resumeSummary?.cwd == null
        ? undefined
        : { kind: "dormant" as const, sessionId: agent.acpSessionId, cwd: resumeSummary.cwd };
    return (
      // Keyed, so selecting a different agent builds a new screen rather than
      // re-rendering one with a different target. Registration follows that
      // screen, and its sandbox belongs to that one agent. Keeping a screen
      // alive across a selection could otherwise execute a new agent's action
      // in the prior agent's browser without anyone choosing it.
      <SessionScreen
        key={agent.id}
        agent={agent}
        session={sessionFor(state, agent.id)}
        connection={state.connection}
        attempt={state.attempt}
        delayMs={state.delayMs}
        canApprove={state.canApprove}
        refusal={state.refusal}
        spoken={state.spoken.get(agent.id)?.text ?? null}
        historyBefore={state.historyBefore.get(agent.id)}
        historyLoading={state.historyLoading.has(agent.id)}
        onLoadEarlier={() => actions.loadEarlier(agent.id)}
        fleetClearances={clearances}
        onBack={back}
        onOpenConfig={openConfig}
        voice={{
          access: promptScopeAccess(state, connection.scopes),
          mic: deviceMemoVoice.capture.availability,
          speech: deviceMemoVoice.playback.availability,
          dictation: state.dictation.get(agent.id) ?? null,
          capturing: state.capturing === agent.id,
          busyElsewhere: state.capturing !== null && state.capturing !== agent.id,
          onToggle: () => {
            if (state.capturing === agent.id) actions.stopVoice();
            else actions.startVoice(agent.id);
          },
        }}
        // Both parameters forward, because the screens widen before this
        // handler does: a one-parameter arrow here would still typecheck and
        // silently drop every image the operator attached.
        onSubmit={(text, images) => {
          actions.prompt(agent.id, text, images);
        }}
        onCancel={() => {
          actions.cancel(agent.id);
        }}
        onResume={
          resumeTarget === undefined
            ? undefined
            : () => {
                actions.openSession(resumeTarget);
              }
        }
        onDecide={(requestId, choice, scope) => {
          actions.decide(agent.id, requestId, choice, scope);
        }}
        onDecidePlan={(requestId, choice) => {
          actions.decidePlan(agent.id, requestId, choice);
        }}
        pendingWebViewAction={state.pendingWebViewActions.get(agent.id)}
        onMountWebView={() => {
          actions.mountWebView(agent.id);
        }}
        onUnmountWebView={() => {
          actions.unmountWebView(agent.id);
        }}
        onWebViewResult={(requestId, result) => {
          actions.webViewResult(agent.id, requestId, result);
        }}
      />
    );
  };

  // A terminal session has no agent stream to attach to. It gets a bounded
  // transcript tail plus live progress hints, and stays keyed like the agent
  // log so switching rows never carries one session's draft into another.
  const terminal = (sessionId: string, back: () => void): JSX.Element => {
    const row = state.sessionIndex.find(candidate => candidate.id === sessionId);
    return (
      <TerminalSessionScreen
        key={sessionId}
        title={row?.title ?? "Terminal session"}
        cwd={row?.cwd ?? row?.flattenedDir ?? ""}
        status={row?.status ?? null}
        promptAccess={tuiPromptAccess(state, connection.scopes)}
        tui={tuiSessionFor(state, sessionId)}
        connection={state.connection}
        onBack={back}
        onSubmit={(text, images) => {
          actions.promptTui(sessionId, text, images);
        }}
        onLoadEarlier={() => {
          actions.loadEarlierTui(sessionId);
        }}
      />
    );
  };

  // The config surface is stateless between visits: the daemon's config
  // routes answer each request whole, so nothing here joins the console
  // model. The scopes are the daemon's own last answer when it gives one,
  // the stored pairing's claim otherwise, and the screen treats an old
  // pairing's silence as optimistic until a refusal says otherwise.
  const agentConfig = (agentId: AgentId, back: () => void): JSX.Element => (
    <AgentConfigScreen
      agentId={agentId}
      agentName={agentFor(state, agentId)?.name}
      connection={connection}
      grantedScopes={state.grantedScopes}
      onBack={back}
    />
  );

  // The tablet's detail pane has no stack to push the config onto, so it
  // swaps in place beside the list: the same screen the navigator pushes on
  // a phone, with the pane's own back in place of the stack's.
  const splitPane = (): JSX.Element | null => {
    const selected = state.selected;
    if (selected !== null && configPane === selected) {
      return agentConfig(selected, () => setConfigPane(null));
    }
    return splitDetail(state, log, terminal, actions.back, setConfigPane);
  };

  const surfaces: ShellSurfaces = {
    daemonLabel,
    canInvite: canInvite(state, connection.scopes),
    fleet: () => (
      // One inset owner per route: the shell pads the screen's edges, so the
      // agent hub sits inside the safe area with the list rather than under the
      // status bar while the list pads itself in the middle of the screen.
      <SafeScreen testID="fleet-surface">
        <View style={split ? styles.splitLayout : styles.singleLayout}>
          <View style={split ? [styles.splitBay, { width: bayWidth }] : styles.bay}>
            <AgentHub
              agents={state.agents.filter(candidate => candidate.parentAgentId !== undefined)}
              onOpen={onOpenAgent}
            />
            <FleetScreen
              browser={browser}
              onSort={onSort}
              onToggleGroup={onToggleGroup}
              onToggleGrouped={onToggleGrouped}
              onToggleArchived={onToggleArchived}
              onOpen={onOpen}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
              onDelete={onDelete}
              deleteAccess={manageScopeAccess(state, connection.scopes)}
            />
          </View>
          {split ? <View style={styles.splitDetail}>{splitPane()}</View> : null}
        </View>
      </SafeScreen>
    ),
    session: log,
    terminal,
    agentConfig,
    connections: (back, invite, settings) => (
      <ConnectionSwitcherScreen
        canInvite={canInvite(state, connection.scopes)}
        connections={connections}
        onAdd={onAddConnection}
        onBack={back}
        onInvite={invite}
        onSelect={onSelectConnection}
        onSettings={settings}
      />
    ),
    invite: done => <InviteScreen connection={connection} onDone={done} />,
    // Owns its own socket for the same reason the invite screen does: the
    // settings ask is small and rare, and it must not compete with the list
    // for the console's connection. The screen decides from the pairing's
    // scopes whether it may change anything or only read.
    settings: back => <SettingsScreen connection={connection} onBack={back} />,
    routines: back => <RoutinesScreen connection={connection} onBack={back} />,
    // This screen owns its own socket rather than borrowing the console's, so
    // browsing and cloning cannot compete with the list for the connection the
    // operator is watching. The cost is that the console does not hear its
    // `session_opened`, which is exactly what `onOpened` is for: pop back to the
    // list and select the agent the daemon just made, so starting a session from
    // the menu lands on that session rather than back where it began.
    newSession: done => (
      <RemoteStartScreen
        connection={connection}
        onBack={done}
        onOpened={agentId => {
          done();
          actions.select(agentId);
        }}
      />
    ),
    // Mounted for every pairing, hub included: the whole surface rides socket
    // frames now, so there is no daemon route for a hub-paired phone to fail
    // to address and no limit left to name. The screen this replaced said
    // Cowork was unreachable from a hub pairing, which was true of the fetches
    // and is no longer true of anything.
    cowork: done => (
      <CoworkSurface
        connection={connection}
        // The same seam `useConsole` builds its socket through, so a test
        // drives this surface's socket the way it drives the console's.
        createClient={createClient}
        target={coworkTarget(state)}
        // The same pop-then-select `newSession` does: a task names the agent
        // running it, and opening it from here has to land on that session's
        // log rather than leaving the operator on the surface they tapped in.
        // A stale id lands on the log route's own "That session closed."
        onOpenSession={agentId => {
          done();
          actions.select(agentId);
        }}
      />
    ),
  };

  // The stack presents an open session only where the list cannot hold it: on a
  // tablet the detail pane is beside the list, and pushing a route over the list
  // it is meant to sit next to would be the phone layout with extra steps.
  const selection = split ? null : selectionOf(state);

  return (
    <View style={styles.position} testID="console">
      <View style={styles.shell}>
        <AppNavigator surfaces={surfaces} selection={selection} onLeaveSelection={actions.back} />
      </View>
      {state.notice === null ? null : (
        // A link notice is the connection's own claim, and it reports under
        // its own testID so a check can demand the screen carry no
        // connectivity notice once the link is demonstrably healthy.
        <Toast
          message={state.notice}
          onDismiss={actions.dismiss}
          testID={state.noticeAboutLink ? "toast-link" : "toast"}
        />
      )}
    </View>
  );
}

function selectionOf(state: ConsoleState): ShellSelection | null {
  if (state.selected !== null) return { kind: "session", agentId: state.selected };
  if (state.selectedTui !== null) return { kind: "terminal", sessionId: state.selectedTui };
  return null;
}

/**
 * The detail pane on a tablet, where there is no pushed route to pop: the model
 * is the way back, because the list it would return to never left the screen.
 */
function splitDetail(
  state: ConsoleState,
  log: (agentId: AgentId, back: () => void, openConfig: () => void) => JSX.Element,
  terminal: (sessionId: string, back: () => void) => JSX.Element,
  back: () => void,
  openConfig: (agentId: AgentId) => void,
): JSX.Element | null {
  const selected = state.selected;
  if (selected !== null) return log(selected, back, () => openConfig(selected));
  if (state.selectedTui !== null) return terminal(state.selectedTui, back);
  return null;
}

/**
 * Which session a task with no session of its own targets, and the directory
 * the skill and connector catalogues are read for.
 *
 * `useCowork` refuses to pick either itself, and is right to: `POST /v1/tasks`
 * needs an existing `agentId`, and which agent is "the current one" is the
 * console's own fleet state rather than anything Cowork knows. So the console
 * answers from what it already holds: the open session first, because that is
 * the one the operator is looking at, else the first top-level agent.
 *
 * Neither existing is an answer as well. An empty cwd asks the daemon for the
 * catalogue with no workspace to scope it to, which is the truth about a device
 * holding no session, and `startTask` refuses in words rather than posting work
 * against an agent nobody chose.
 */
function coworkTarget(state: ConsoleState): { cwd: string; agentId: AgentId | null } {
  const open = state.selected === null ? null : agentFor(state, state.selected);
  const agent = open ?? state.agents.find(candidate => candidate.parentAgentId === undefined) ?? null;
  if (agent === null) return { cwd: "", agentId: null };
  return { cwd: agent.cwd, agentId: agent.id };
}

/**
 * The Cowork route's own data edge.
 *
 * A component rather than one of the closures above, because `useCowork` is a
 * hook and a surface is a plain function: the poll needs something React can
 * mount and unmount with the route.
 *
 * It owns one socket for as long as it is on screen, the same call
 * `RemoteStartScreen`, `SettingsScreen`, and `RoutinesScreen` make and for
 * the same two reasons: the catalogue poll must not compete with the list the
 * operator is watching, and every refusal arriving on this socket is this
 * surface's own -- an `error` frame here answered one of Cowork's asks, so
 * the notice below never reports somebody else's failed prompt. The client is
 * built once per mount, never per render: a socket per render is a reconnect
 * loop that looks like a flaky daemon.
 *
 * `CoworkScreen` takes data and gives back intent: it holds no ask, no error
 * state, and no inset of its own. So this owns all three. The notice matters
 * most: a refused or failed read with nothing said would leave four empty
 * catalogues on screen, which reads as a daemon with no skills installed rather
 * than as a question that never got an answer.
 */
function CoworkSurface({
  connection,
  target,
  onOpenSession,
  createClient = createOmpdClient,
}: {
  connection: Connection;
  target: { cwd: string; agentId: AgentId | null };
  onOpenSession: (agentId: AgentId) => void;
  /** Seam for tests: builds the socket client this surface rides. */
  createClient?: (connection: Connection) => OmpdClient;
}): JSX.Element {
  const clientRef = useRef<OmpdClient | null>(null);
  if (clientRef.current === null) clientRef.current = createClient(connection);
  const client = clientRef.current;

  useEffect(() => {
    client.start();
    return () => client.close();
  }, [client]);

  const [state, actions] = useCowork(client, target.cwd, target.agentId);
  // Held here rather than in the hook: a start refused before any frame left
  // this device (no session to target) is this screen's to report, while
  // `useCowork`'s own `error` carries what the daemon said.
  const [refusal, setRefusal] = useState<string | null>(null);

  const start = (input: NewTaskInput): void => {
    setRefusal(null);
    void actions.startTask(input).catch((cause: unknown) => {
      setRefusal(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const notice = refusal ?? state.error;

  return (
    // One inset owner per route, the same rule the fleet surface follows: the
    // header takes the top edge and this takes the bottom, so the bottom tab
    // bar sits above the home indicator rather than under it.
    <SafeScreen testID="cowork-surface">
      {notice === null ? null : (
        <View style={styles.coworkNotice} testID="cowork-notice">
          <Body color={signal.ochre}>{notice}</Body>
        </View>
      )}
      <CoworkScreen
        tasks={state.tasks}
        skills={state.skills}
        connectors={state.connectors}
        // The same client the catalogues ride: the folder picker browses with
        // its `fs_list` frames and the binding starts a container with its
        // `agent_create`, so choosing a folder opens no second link.
        client={client}
        onStartTask={start}
        // Invoking a skill is starting a task that runs it: the same act the
        // composer performs, with the invocation text `catalog.ts` already
        // defines rather than a second spelling of it here.
        onInvokeSkill={skill => {
          start({ title: skill.name, prompt: skillInvocation(skill), skillName: skill.name });
        }}
        onOpenSession={onOpenSession}
      />
    </SafeScreen>
  );
}

const styles = StyleSheet.create({
  position: { flex: 1, backgroundColor: ground.base },
  // The notice is a band in the column, not a layer over it. Floating it once
  // put a connectivity complaint physically on top of the reply it was
  // complaining about not receiving; a notice that hides the thing it reports
  // on is worse than no notice.
  shell: { flex: 1 },
  singleLayout: { flex: 1 },
  splitLayout: { flex: 1, flexDirection: "row" },
  bay: { flex: 1 },
  // No width here by design: the bay's width is computed from the window at
  // render (`useSplitBayWidth`), and a literal in the sheet is exactly how
  // the fixed 340 happened. `test/no-hidden-content.test.ts` holds the rule.
  splitBay: { borderRightWidth: stroke.heavy, borderRightColor: ground.edge },
  splitDetail: { flex: 1 },
  gone: { alignItems: "center", justifyContent: "center", padding: space.gulf },
  limit: { gap: space.step, justifyContent: "center", padding: space.gulf },
  coworkNotice: { padding: space.step, backgroundColor: ground.surface },
});
