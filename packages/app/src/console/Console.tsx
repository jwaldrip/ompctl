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

import type { AgentId } from "@ompd/core/contracts";
import { SCOPE_APPROVE } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import type { JSX } from "react";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { StyleSheet, View } from "react-native";
import { AgentHub } from "../components/AgentHub.tsx";
import { Toast } from "../components/Toast.tsx";
import { useSplitLayout } from "../design/layout.ts";
import { SafeScreen } from "../design/SafeScreen.tsx";
import { Body } from "../design/text.tsx";
import { ground, ink, space, stroke } from "../design/tokens.ts";
import type { ShellSelection, ShellSurfaces } from "../nav/AppNavigator.tsx";
import { AppNavigator } from "../nav/AppNavigator.tsx";
import type { Connection, ConnectionList } from "../platform/connection.ts";
import { ConnectionSwitcherScreen } from "../screens/ConnectionSwitcherScreen.tsx";
import { FleetScreen } from "../screens/FleetScreen.tsx";
import { InviteScreen } from "../screens/InviteScreen.tsx";
import { RemoteStartScreen } from "../screens/RemoteStartScreen.tsx";
import { SessionScreen } from "../screens/SessionScreen.tsx";
import { TerminalSessionScreen } from "../screens/TerminalSessionScreen.tsx";
import type { BrowserSession, SortField } from "../session/browser.ts";
import { browserReduce, EMPTY_BROWSER } from "../session/browser.ts";
import type { ConsoleState } from "./state.ts";
import { agentFor, browserSessionsOf, fleetClearances, openSessionTarget, sessionFor, tuiSessionFor } from "./state.ts";
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
  const [state, actions] = useConsole(connection, createClient);
  const split = useSplitLayout();
  const [browser, dispatchBrowser] = useReducer(browserReduce, EMPTY_BROWSER);

  useEffect(() => {
    if (state.unauthorized === null) return;
    onUnpair(`${state.unauthorized} Pair this device again to carry on.`);
  }, [state.unauthorized, onUnpair]);

  useEffect(() => {
    dispatchBrowser({ t: "load", sessions: browserSessionsOf(state) });
  }, [state]);

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
  // Rows are sessions, not agents: the pure resolver in state.ts decides what
  // the tap lands on, and the action owns the impure ways to reach it -- attach,
  // a claim the daemon verifies, or the terminal prompt surface.
  const onOpen = useCallback((session: BrowserSession) => {
    const current = latest.current;
    current.actions.openSession(openSessionTarget(current.state, session.id));
  }, []);

  const log = (agentId: AgentId, back: () => void): JSX.Element => {
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
        fleetClearances={clearances}
        onBack={back}
        onSubmit={text => {
          actions.prompt(agent.id, text);
        }}
        onCancel={() => {
          actions.cancel(agent.id);
        }}
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

  // A terminal session's prompt surface is not a variant of the log: there is
  // no transcript to attach to. Keyed like the log so switching rows builds a
  // fresh composer instead of carrying one row's draft into another's.
  const terminal = (sessionId: string, back: () => void): JSX.Element => {
    const row = state.sessionIndex.find(candidate => candidate.id === sessionId);
    return (
      <TerminalSessionScreen
        key={sessionId}
        title={row?.title ?? "Terminal session"}
        cwd={row?.cwd ?? row?.flattenedDir ?? ""}
        tui={tuiSessionFor(state, sessionId)}
        connection={state.connection}
        onBack={back}
        onSubmit={text => {
          actions.promptTui(sessionId, text);
        }}
      />
    );
  };

  const surfaces: ShellSurfaces = {
    daemonLabel,
    canInvite: connection.scopes.includes(SCOPE_APPROVE),
    fleet: () => (
      // One inset owner per route: the shell pads the screen's edges, so the
      // agent hub sits inside the safe area with the list rather than under the
      // status bar while the list pads itself in the middle of the screen.
      <SafeScreen testID="fleet-surface">
        <View style={split ? styles.splitLayout : styles.singleLayout}>
          <View style={split ? styles.splitBay : styles.bay}>
            <AgentHub agents={state.agents.filter(candidate => candidate.parentAgentId !== undefined)} />
            <FleetScreen
              browser={browser}
              onSort={onSort}
              onToggleGroup={onToggleGroup}
              onToggleGrouped={onToggleGrouped}
              onToggleArchived={onToggleArchived}
              onOpen={onOpen}
              onArchive={onArchive}
              onUnarchive={onUnarchive}
            />
          </View>
          {split ? <View style={styles.splitDetail}>{splitDetail(state, log, terminal, actions.back)}</View> : null}
        </View>
      </SafeScreen>
    ),
    session: log,
    terminal,
    connections: (back, invite) => (
      <ConnectionSwitcherScreen
        connections={connections}
        onAdd={onAddConnection}
        onBack={back}
        onInvite={invite}
        onSelect={onSelectConnection}
      />
    ),
    invite: done => <InviteScreen connection={connection} onDone={done} />,
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
  };

  // The stack presents an open session only where the list cannot hold it: on a
  // tablet the detail pane is beside the list, and pushing a route over the list
  // it is meant to sit next to would be the phone layout with extra steps.
  const selection = split ? null : selectionOf(state);

  return (
    <View style={styles.position} testID="console">
      <AppNavigator surfaces={surfaces} selection={selection} onLeaveSelection={actions.back} />
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
  log: (agentId: AgentId, back: () => void) => JSX.Element,
  terminal: (sessionId: string, back: () => void) => JSX.Element,
  back: () => void,
): JSX.Element | null {
  if (state.selected !== null) return log(state.selected, back);
  if (state.selectedTui !== null) return terminal(state.selectedTui, back);
  return null;
}

const styles = StyleSheet.create({
  position: { flex: 1, backgroundColor: ground.base },
  singleLayout: { flex: 1 },
  splitLayout: { flex: 1, flexDirection: "row" },
  bay: { flex: 1 },
  splitBay: { width: 340, borderRightWidth: stroke.heavy, borderRightColor: ground.edge },
  splitDetail: { flex: 1 },
  gone: { alignItems: "center", justifyContent: "center", padding: space.gulf },
});
