/**
 * The one impure edge between the client and the screens.
 *
 * Everything that decides what is on screen is in `state.ts` and is pure. This
 * file owns the socket, subscribes it to that reducer, and hands back the
 * actions a view can take. Keeping the split sharp is what lets a canned frame
 * stream produce byte-identical state to a live daemon.
 */

import type {
  AgentId,
  ApprovalChoice,
  ApprovalScope,
  PlanReviewChoice,
  PromptImage,
  WebViewActionResult,
} from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppState } from "react-native";
import type { Connection } from "../platform/connection.ts";
import { createHubSocketFactory } from "../platform/socket.ts";
import type { MemoVoice } from "../voice/memo.ts";
import { deviceMemoVoice } from "../voice/memo.ts";
import type { ConsoleState, SessionOpenTarget } from "./state.ts";
import {
  apply,
  emptyConsole,
  manageScopeAccess,
  promptScopeAccess,
  readScopeAccess,
  sessionDeleteNotice,
  tuiPageToAskFor,
  tuiSessionFor,
} from "./state.ts";
import { NO_MOUNTED_WEBVIEW } from "./webview.ts";

export type { WebViewTarget } from "./webview.ts";

export interface ConsoleActions {
  select: (agentId: AgentId) => void;
  back: () => void;
  prompt: (agentId: AgentId, text: string, images?: PromptImage[]) => void;
  cancel: (agentId: AgentId) => void;
  decide: (agentId: AgentId, requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  decidePlan: (agentId: AgentId, requestId: string, choice: PlanReviewChoice) => void;
  dismiss: () => void;
  loadEarlier: (agentId: AgentId) => void;
  /**
   * Open one browser row. A row whose session an agent already holds opens
   * that agent's log; a live terminal session is asked for as a collab guest
   * first and falls back to the steer surface when the terminal's omp cannot
   * host; the rest claim through the daemon.
   */
  openSession: (target: SessionOpenTarget) => void;
  /**
   * Send one prompt to a live terminal session. The daemon routes it to the
   * terminal that owns the session; progress arrives as `tui_activity`, and a
   * terminal with no bridge answers `tui_unreachable` instead.
   */
  promptTui: (sessionId: string, text: string, images?: PromptImage[]) => void;
  /**
   * Ask a live terminal session for the page of turns older than the one on
   * screen. Ignored when the file's start is already reached or a page is
   * already in flight, so a double tap cannot ask twice.
   */
  loadEarlierTui: (sessionId: string) => void;
  /**
   * Delete one session for good: its transcript leaves the machine. The
   * fleet's own refresh arrives as the daemon's pushed index rather than
   * from here, and a refusal arrives as a notice, because nothing on screen
   * changes when a delete is refused.
   *
   * Whoever calls this has already taken the operator through a
   * confirmation: this sends the frame, it does not ask.
   */
  deleteSession: (sessionId: string) => void;
  /** Register this selected screen as the agent's live WebView target. */
  mountWebView: (agentId: AgentId) => void;
  /** Withdraw the selected screen's target. Safe to call after a failed mount. */
  unmountWebView: (agentId: AgentId) => void;
  /** Deliver one matching driver result and clear its pending action. */
  webViewResult: (agentId: AgentId, requestId: string, result: WebViewActionResult) => void;
  /**
   * Open this device's microphone for one agent and stream it to the daemon
   * as `audio` frames. Refused without frames when the pairing holds no
   * prompt scope or the platform cannot capture, because a control that
   * records nothing must never look like one that recorded.
   */
  startVoice: (agentId: AgentId) => void;
  /**
   * Close the microphone and end the utterance. The daemon answers with a
   * `transcript` frame of what it heard.
   */
  stopVoice: () => void;
}

/**
 * A direct connection dials the socket the device was handed. A hub
 * connection has no socket of its own: it goes through the pinned daemon's
 * relay instead, which is why it needs its own `createSocket`.
 */
export function createOmpdClient(connection: Connection): OmpdClient {
  if (connection.transport === "direct") {
    return new OmpdClient({ url: connection.url, token: connection.token });
  }
  return new OmpdClient({
    url: connection.hubUrl,
    token: connection.token,
    createSocket: createHubSocketFactory({ daemonId: connection.daemonId }),
  });
}

export function useConsole(
  connection: Connection,
  createClient: (connection: Connection) => OmpdClient = createOmpdClient,
  voice: MemoVoice = deviceMemoVoice,
): [ConsoleState, ConsoleActions] {
  const [state, dispatch] = useReducer(apply, connection.scopes, emptyConsole);

  // The client outlives every render and must never be rebuilt by one: a new
  // socket per render is a reconnect loop that looks like a flaky daemon.
  const clientRef = useRef<OmpdClient | null>(null);
  if (clientRef.current === null) {
    clientRef.current = createClient(connection);
  }
  const client = clientRef.current;

  /**
   * The latest reducer state, read by actions that must decide against what
   * is on screen now rather than what they are about to produce. Kept in a
   * ref and assigned during render so an event handler between commits still
   * sees the newest state.
   */
  const stateRef = useRef(state);
  stateRef.current = state;

  /**
   * Speech playback is a queue, not a fire-and-forget: the daemon
   * synthesises a reply segment by segment and sends each as it renders,
   * so chaining the plays is what keeps the speaker saying the segments in
   * the order the agent wrote them.
   */
  const speechChain = useRef(Promise.resolve());

  /**
   * Whether this pairing has already asked for the machine's session index.
   *
   * Asked for once, on the first established connection, and never again:
   * the client replays the request itself after every reconnect, the same
   * guarantee attachments rely on, so asking again here would only duplicate
   * the frame.
   */
  const askedForSessionIndex = useRef(false);

  /**
   * Screen registration is separate from driver mounting. A registered screen
   * can receive an action, open its pane, and then mount the driver that will
   * execute it.
   */
  const mountedWebViews = useRef(new Set<AgentId>());
  /**
   * Lifecycle bookkeeping only. The action itself lives in the reducer; this
   * map lets a late driver completion lose to an unmount or replacement.
   */
  const pendingWebViewRequests = useRef(new Map<AgentId, string>());

  const settleWebViewAction = useCallback(
    (agentId: AgentId, requestId: string, result: WebViewActionResult) => {
      if (pendingWebViewRequests.current.get(agentId) !== requestId) return;
      pendingWebViewRequests.current.delete(agentId);
      client.webViewResult(agentId, requestId, result);
      dispatch({ t: "webview_result", agentId, requestId });
    },
    [client],
  );

  const requestHistory = useCallback(
    (agentId: AgentId, sessionId: string, before?: number): void => {
      if (stateRef.current.historyLoading.has(agentId)) return;
      dispatch({ t: "history_request", agentId });
      client.sessionHistory(agentId, sessionId, before);
    },
    [client],
  );
  /**
   * Tell the daemon to leave the room when the operator walks away from a
   * co-driven session, whether the way out is back or the opening of another
   * session. The daemon's guest outlives this socket by design, so a leave
   * nobody sends keeps the daemon co-driving a session nobody here is
   * watching. Re-selecting the session already on screen is not a leave.
   */
  const leaveCollab = useCallback(
    (leaving: AgentId | null, next?: AgentId): void => {
      if (leaving === null || leaving === next) return;
      const join = stateRef.current.collabAgents.get(leaving);
      if (join !== undefined) client.leaveCollab(join.sessionId);
    },
    [client],
  );

  /**
   * Ask one terminal session for the page older than `cursor`.
   *
   * Takes the cursor rather than reading it back out of state, because the
   * caller that matters most is the answer handler continuing past an empty
   * page: it holds the fresh cursor from the frame it just folded in, while
   * a state read between commits could still see the one before it.
   */
  const askOlderTui = useCallback(
    (sessionId: string, cursor: number): void => {
      dispatch({ t: "tui_history_request", sessionId });
      client.sessionTail(sessionId, undefined, cursor);
    },
    [client],
  );

  /**
   * Select and attach in one step, the way every open lands. The attach shape
   * is derived from state, not from a memo of past attaches: a session this
   * device holds no watermark for asks for the whole history with
   * `sinceSeq: 0`, because a console opened mid-session should show the
   * session, while a watermark in state means the log is already on screen
   * and the client resumes from its own watermark. Deriving it is the repair
   * for the session the roster once tore down: the watermark went with it, so
   * the next open replays the full transcript instead of silently tailing
   * only the replies that arrive after it.
   */
  const selectAgent = useCallback(
    (agentId: AgentId): void => {
      const current = stateRef.current;
      leaveCollab(current.selected, agentId);
      const agent = current.agents.find(candidate => candidate.id === agentId);
      // What this open actually asks the daemon for, decided before the
      // dispatch because the reducer cannot know it.
      //
      // A wait is armed only when BOTH are true: this device holds nothing of
      // this session yet (no watermark, so the attach asks for a full
      // replay), and a history page was asked for. The second is what makes
      // the wait provably end -- a page always comes back, empty or not,
      // while a replay of an empty transcript sends no frame at all. The
      // first is what keeps a session already streaming into this console
      // from flashing a spinner over the log the operator can already read:
      // its cache is live, not a leftover from a previous run.
      const replaying = !current.watermarks.has(agentId);
      const fetchingHistory = agent?.acpSessionId !== undefined && !current.historyBefore.has(agentId);
      dispatch({ t: "select", agentId, awaiting: replaying && fetchingHistory });
      client.attach(agentId, replaying ? { sinceSeq: 0 } : {});
      if (agent?.acpSessionId !== undefined && fetchingHistory) {
        requestHistory(agentId, agent.acpSessionId);
      }
    },
    [client, leaveCollab, requestHistory],
  );
  useEffect(() => {
    // The mic outlives this effect only when the link is alive; the cleanup
    // releases it for a full unmount the same way a dropped link does below.
    const releaseMic = (): void => {
      if (stateRef.current.capturing === null) return;
      voice.capture.cancel();
      dispatch({ t: "voice_capture", agentId: null });
    };
    const offs = [
      client.on("status", event => {
        dispatch({ t: "status", event });
        // An utterance cannot survive its socket: the daemon drops the
        // audio it buffered with the connection, so a microphone left open
        // would stream chunks into a client that silently discards them.
        // Closing here without `audio_end` is the honest shape, and the
        // notice says what happened because an operator who keeps talking
        // into a dead link believes they were heard.
        if (event.state !== "connected" && stateRef.current.capturing !== null) {
          voice.capture.cancel();
          dispatch({ t: "voice_capture", agentId: null });
          dispatch({
            t: "error",
            event: { message: "The link dropped while recording; that message was not delivered." },
          });
        }
        if (event.state !== "connected" || askedForSessionIndex.current) return;
        askedForSessionIndex.current = true;
        // Archived rows ride along and the browser owns their visibility, so
        // its archived toggle still counts what it hides rather than the wire
        // having silently filtered it out.
        client.listSessions({ includeArchived: true });
      }),
      client.on("agents", event => {
        dispatch({ t: "agents", event });
      }),
      client.on("session_opened", event => {
        // The resume answer may arrive before the roster's new agent row. The
        // frame already carries both identities needed for attach + history,
        // so do both once rather than calling selectAgent and racing a second
        // initial history request before React commits `history_request`.
        //
        // Always awaiting: the history page below is asked for unconditionally
        // here, so there is always an answer coming, and a resume means this
        // device holds nothing of the session yet by definition.
        dispatch({ t: "select", agentId: event.agentId, awaiting: true });
        client.attach(event.agentId, stateRef.current.watermarks.has(event.agentId) ? {} : { sinceSeq: 0 });
        requestHistory(event.agentId, event.sessionId);
      }),
      client.on("collab_opened", event => {
        // The join's answer lands exactly like a resume's: it may arrive
        // before the roster lists the guest agent, and it carries both
        // identities attach and history need. A re-open of a session the
        // daemon already co-drives answers with the same agentId, which the
        // reducer folds to no change; the attach below then resumes from the
        // watermark rather than replaying, and the history guard keeps the
        // first page from being asked for twice.
        const current = stateRef.current;
        leaveCollab(current.selected, event.agentId);
        // The same rule the ordinary open follows: wait only when this device
        // holds nothing of the joined session yet and a page that always
        // answers was asked for.
        const fetchingHistory = !current.historyBefore.has(event.agentId);
        const replaying = !current.watermarks.has(event.agentId);
        dispatch({ t: "collab_opened", event, awaiting: replaying && fetchingHistory });
        client.attach(event.agentId, current.watermarks.has(event.agentId) ? {} : { sinceSeq: 0 });
        if (fetchingHistory) {
          requestHistory(event.agentId, event.sessionId);
        }
      }),
      client.on("sessions", event => {
        dispatch({ t: "sessions", event });
      }),
      client.on("sessions_deleted", event => {
        // Only refusals reach the operator; the deleted rows leaving the
        // fleet are their own confirmation. `sessionDeleteNotice` owns that
        // decision and the wording.
        const notice = sessionDeleteNotice(event.results);
        if (notice === null) return;
        dispatch({ t: "error", event: { message: notice } });
      }),
      client.on("session_history", event => {
        dispatch({ t: "session_history", event });
      }),
      client.on("update", event => {
        dispatch({ t: "update", event });
      }),
      client.on("approval", event => {
        dispatch({ t: "approval", event });
      }),
      client.on("plan_review", event => {
        dispatch({ t: "plan_review", event });
      }),
      client.on("error", event => {
        // The steer-surface fallback. `collab_unavailable` is the daemon
        // saying this terminal's omp has no collab API to answer with, which
        // is every omp build before `pi.startCollab` ships. That is not a
        // refusal the operator must act on: the steer surface drives the
        // same terminal today, so the open lands there instead of dying as
        // a toast, and the tail ask is repeated because the join never
        // started streaming. A `collab_refused` answer is the opposite case:
        // a decision only the operator can make, so it states itself through
        // the reducer and never silently falls back.
        //
        // This branch dies when `pi.startCollab` ships and the daemon stops
        // answering `collab_unavailable`: with every terminal able to host,
        // the fallback is dead code and can be deleted with evidence.
        if (event.code === "collab_unavailable" && event.sessionId !== undefined) {
          // Landing on the terminal surface is walking away from whatever
          // co-driven session was on screen, exactly as a join's answer is,
          // so the leave reaches the daemon through the same call.
          leaveCollab(stateRef.current.selected);
          // The press already committed this session and armed its wait; the
          // tail below is what ends it. Re-selecting the same subject folds
          // to no change, so the wait survives the fallback rather than
          // restarting under it.
          dispatch({ t: "tui_select", sessionId: event.sessionId, awaiting: true });
          client.sessionTail(event.sessionId);
          return;
        }
        // A refusal that names a session or an agent belongs to that
        // subject's pane, not to whichever pane is open when it lands. This
        // is the case a refused co-drive made necessary: the operator pressed
        // a row, the pane committed to it, and a toast over the previous
        // session's log is not an answer about the row they pressed. The
        // notice still goes out, because a refusal about a pane nobody is
        // watching must still reach the operator.
        const subject = event.sessionId ?? event.agentId;
        if (subject !== undefined) dispatch({ t: "open_failed", subject, message: event.message });
        dispatch({ t: "error", event });
      }),
      client.on("say", event => {
        dispatch({ t: "say", event });
      }),
      client.on("transcript", event => {
        dispatch({ t: "transcript", event });
      }),
      client.on("speech", event => {
        // The daemon speaks only to a device that spoke first, so a frame
        // here was asked for. An unavailable playback seam never receives
        // one it can act on, and the composer has already named the gap.
        if (!voice.playback.availability.available) return;
        speechChain.current = speechChain.current
          .then(() => voice.playback.play(event.pcm))
          .catch(() => {
            // One failed chunk must not drop the queue behind it: the next
            // segment still deserves the speaker, and the operator's remedy
            // is the same for any chunk.
          });
      }),
      client.on("tui_activity", event => {
        dispatch({ t: "tui_activity", event });
      }),
      client.on("session_tail", event => {
        dispatch({ t: "session_tail", event });
        // A page of pure tool traffic carries no turns while the file still
        // holds plenty behind it, and the operator tapped for earlier words
        // rather than earlier bytes. Asking on from the page's own cursor is
        // what keeps that tap from ending on an unchanged screen.
        const next = tuiPageToAskFor(event);
        if (next !== null) askOlderTui(event.sessionId, next);
      }),
      client.on("unauthorized", event => {
        dispatch({ t: "unauthorized", event });
      }),
      client.on("webview_action", event => {
        if (!mountedWebViews.current.has(event.agentId)) {
          client.webViewResult(event.agentId, event.requestId, {
            kind: "error",
            message: NO_MOUNTED_WEBVIEW,
          });
          return;
        }
        const priorRequestId = pendingWebViewRequests.current.get(event.agentId);
        if (priorRequestId !== undefined && priorRequestId !== event.requestId) {
          settleWebViewAction(event.agentId, priorRequestId, {
            kind: "error",
            message: "a newer WebView action arrived before this request completed",
          });
        }
        pendingWebViewRequests.current.set(event.agentId, event.requestId);
        dispatch({ t: "webview_action", agentId: event.agentId, requestId: event.requestId, action: event.action });
      }),
    ];
    client.start();
    return () => {
      releaseMic();
      for (const off of offs) off();
      client.close();
    };
  }, [askOlderTui, client, leaveCollab, requestHistory, settleWebViewAction, voice]);

  // Phones suspend timers in the background, so a pending backoff may be hours
  // stale by the time the app is looked at again.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", status => {
      if (status !== "active") return;
      client.reconnectNow();
    });
    return () => {
      subscription.remove();
    };
  }, [client]);

  const actions = useMemo<ConsoleActions>(
    () => ({
      select(agentId) {
        selectAgent(agentId);
      },
      back() {
        leaveCollab(stateRef.current.selected);
        dispatch({ t: "select", agentId: null });
      },
      prompt(agentId, text, images) {
        // The three-way rule, the same one the microphone follows: a pairing
        // that provably holds no prompt scope gets the reason stated rather
        // than a frame the daemon must refuse, and an unknown one sends
        // optimistically so an older daemon never loses a working control.
        // Steering a co-driven terminal spends this scope exactly as
        // prompting an owned agent does, so one gate covers both.
        if (promptScopeAccess(stateRef.current, connection.scopes) === "missing") {
          dispatch({
            t: "error",
            event: {
              message:
                "This device does not hold the prompt scope. Pair it again with prompt access to steer this session.",
            },
          });
          return;
        }
        client.prompt(agentId, text, images);
        dispatch({ t: "prompt", agentId, text, imageCount: images?.length ?? 0 });
      },
      cancel(agentId) {
        client.cancel(agentId);
      },
      decide(agentId, requestId, choice, scope) {
        client.decide(agentId, requestId, choice, scope);
        dispatch({ t: "decide", agentId, requestId, choice });
      },
      decidePlan(agentId, requestId, choice) {
        client.decidePlan(agentId, requestId, choice);
        dispatch({ t: "plan_decide", agentId, requestId, choice });
      },
      loadEarlier(agentId) {
        const current = stateRef.current;
        const before = current.historyBefore.get(agentId);
        if (before === undefined || before === null) return;
        const agent = current.agents.find(candidate => candidate.id === agentId);
        if (agent?.acpSessionId === undefined) return;
        requestHistory(agentId, agent.acpSessionId, before);
      },
      dismiss() {
        dispatch({ t: "dismiss" });
      },
      openSession(target) {
        // The resume claim rides the sealed socket rather than the daemon's
        // HTTP routes, because the hub tunnels only a webhook fire and has no
        // tunnel wired for `POST /v1/sessions/:id/resume`, so a relayed phone
        // has no road to it.
        // The daemon answers `session_opened` with the agent that now holds
        // the session, and a session already held answers with the one
        // holding it, so a double tap cannot make a second holder. Selecting
        // waits for that answer; the reply, not this dispatch, is what opens
        // the screen.
        //
        // A live terminal session is joined before it is steered: the daemon
        // co-drives it as a collab guest and answers `collab_opened` with an
        // ordinary agent to select, which is the richer surface whenever the
        // terminal's omp can host. When it cannot, the daemon's
        // `collab_unavailable` answer falls back to the local prompt surface
        // (see the error handler), so no omp build is left without a way in.
        switch (target.kind) {
          case "agent":
            selectAgent(target.agentId);
            return;
          case "live-tui": {
            // A live terminal is joined, never taken over: nothing here
            // claims the renderer, and the transcript arrives through the
            // same frames an owned agent uses. Watching spends the read
            // scope, so a pairing that provably lacks it gets the reason
            // stated rather than a frame the daemon must refuse; an unknown
            // one asks optimistically, and the daemon's refusal arrives
            // named.
            if (readScopeAccess(stateRef.current, connection.scopes) === "missing") {
              dispatch({
                t: "error",
                event: {
                  // Addressed, so the refusal lands on the pane the operator
                  // just committed to rather than only as a toast.
                  sessionId: target.sessionId,
                  message:
                    "This device does not hold the read scope. Pair it again with read access to watch this terminal.",
                },
              });
              return;
            }
            // The press commits the session before the ask goes out, so the
            // pane belongs to this row from the moment it is touched rather
            // than from the moment the daemon answers. Every answer that can
            // come back -- a join, the steer-surface fallback, or a refusal
            // -- then lands on a pane that is already this session's.
            dispatch({ t: "tui_select", sessionId: target.sessionId, awaiting: true });
            client.openCollab(target.sessionId);
            return;
          }
          case "dormant":
            client.resumeSession(target.sessionId, target.cwd);
            return;
          case "unopenable":
            // Honesty over silence: the row is on screen, so the tap has to
            // answer. No index row means no cwd to echo, and the daemon
            // refuses a claim it cannot verify, so say why here rather than
            // send a frame that cannot land.
            dispatch({
              t: "error",
              event: { message: "That session has no record the daemon can verify, so it cannot be opened from here." },
            });
        }
      },
      promptTui(sessionId, text, images) {
        client.sessionPrompt(sessionId, text, undefined, images);
        dispatch({ t: "tui_prompt", sessionId, text, imageCount: images?.length ?? 0 });
      },
      loadEarlierTui(sessionId) {
        const tui = tuiSessionFor(stateRef.current, sessionId);
        // Nothing older to reach, or an ask already out: the control renders
        // both states, but a tap that arrives anyway must not put a second
        // request on the wire for the same page.
        if (tui.historyCursor === null || tui.historyLoadingEarlier) return;
        askOlderTui(sessionId, tui.historyCursor);
      },
      deleteSession(sessionId) {
        // The row renders the missing scope and offers no confirmation, but
        // this checks it again rather than trusting the surface: the frame is
        // irreversible where it lands, and a client that sends one it knows
        // will be refused teaches an operator to ignore refusals.
        if (manageScopeAccess(stateRef.current, connection.scopes) === "missing") {
          dispatch({
            t: "error",
            event: {
              message: "This device does not hold the manage scope. Pair it again with manage access to delete.",
            },
          });
          return;
        }
        client.deleteSessions([sessionId]);
      },
      startVoice(agentId) {
        const current = stateRef.current;
        // The composer renders the unavailable and scope states and never
        // offers the press, but the daemon enforces the scope and the seam
        // enforces the capability regardless: a recording that could never
        // produce frames must not begin.
        if (!voice.capture.availability.available) return;
        if (current.capturing !== null) return;
        if (promptScopeAccess(current, connection.scopes) === "missing") {
          dispatch({
            t: "error",
            event: {
              message: "This device does not hold the prompt scope. Pair it again with prompt access to speak.",
            },
          });
          return;
        }
        dispatch({ t: "voice_capture", agentId });
        voice.capture
          .start(chunk => {
            client.sendAudio(agentId, chunk);
          })
          .catch(() => {
            // A start that failed never opened the mic; release anything
            // native code did grab and say so, because a control showing
            // Recording with no frames flowing is a lie with a timer.
            voice.capture.cancel();
            dispatch({ t: "voice_capture", agentId: null });
            dispatch({
              t: "error",
              event: { message: "The microphone did not open. Nothing was recorded." },
            });
          });
      },
      stopVoice() {
        const agentId = stateRef.current.capturing;
        if (agentId === null) return;
        dispatch({ t: "voice_capture", agentId: null });
        // `stop` resolves after the final chunk, so `audio_end` follows the
        // last audio frame rather than racing it. A stop that fails still
        // ends the utterance: the daemon flushes whatever it holds, and its
        // empty-buffer error is more honest than a recording that never ends.
        voice.capture
          .stop()
          .catch(() => {})
          .then(() => {
            client.endAudio(agentId);
          });
      },
      mountWebView(agentId) {
        if (mountedWebViews.current.has(agentId)) return;
        mountedWebViews.current.add(agentId);
        client.registerWebView(agentId);
      },
      unmountWebView(agentId) {
        if (!mountedWebViews.current.delete(agentId)) return;
        const requestId = pendingWebViewRequests.current.get(agentId);
        if (requestId !== undefined) {
          settleWebViewAction(agentId, requestId, { kind: "error", message: NO_MOUNTED_WEBVIEW });
        }
        client.unregisterWebView(agentId);
      },
      webViewResult(agentId, requestId, result) {
        settleWebViewAction(agentId, requestId, result);
      },
    }),
    [askOlderTui, client, connection.scopes, leaveCollab, requestHistory, settleWebViewAction, selectAgent, voice],
  );

  return [state, actions];
}
