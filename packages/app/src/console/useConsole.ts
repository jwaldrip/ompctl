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
  WebViewActionResult,
} from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppState } from "react-native";
import type { Connection } from "../platform/connection.ts";
import { createHubSocketFactory } from "../platform/socket.ts";
import type { ConsoleState, SessionOpenTarget } from "./state.ts";
import { apply, emptyConsole } from "./state.ts";
import { NO_MOUNTED_WEBVIEW } from "./webview.ts";

export type { WebViewTarget } from "./webview.ts";

export interface ConsoleActions {
  select: (agentId: AgentId) => void;
  back: () => void;
  prompt: (agentId: AgentId, text: string) => void;
  cancel: (agentId: AgentId) => void;
  decide: (agentId: AgentId, requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  decidePlan: (agentId: AgentId, requestId: string, choice: PlanReviewChoice) => void;
  dismiss: () => void;
  /**
   * Open one browser row. A row whose session an agent already holds opens
   * that agent's log; a live terminal session opens its prompt surface; the
   * rest claim through the daemon.
   */
  openSession: (target: SessionOpenTarget) => void;
  /**
   * Send one prompt to a live terminal session. The daemon routes it to the
   * terminal that owns the session; progress arrives as `tui_activity`, and a
   * terminal with no bridge answers `tui_unreachable` instead.
   */
  promptTui: (sessionId: string, text: string) => void;
  /** Register this selected screen as the agent's live WebView target. */
  mountWebView: (agentId: AgentId) => void;
  /** Withdraw the selected screen's target. Safe to call after a failed mount. */
  unmountWebView: (agentId: AgentId) => void;
  /** Deliver one matching driver result and clear its pending action. */
  webViewResult: (agentId: AgentId, requestId: string, result: WebViewActionResult) => void;
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
   * Which agents this device has already asked for a full transcript.
   *
   * A ref rather than a read of the reducer's state: `attach` is called from
   * the action, which cannot see the state it is about to produce, and asking
   * for a full backfill twice replays a log that is already on screen. Per
   * hook instance, so unpairing and pairing again starts clean.
   */
  const backfilled = useRef(new Set<AgentId>());

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

  /**
   * Select and attach in one step, the way every open lands: a strip this
   * device has never seen asks for the whole transcript, because a console
   * opened mid-session should show the session. After that the client's own
   * watermark resumes, so revisiting a strip never replays a log that is
   * already on screen.
   */
  const selectAgent = useCallback(
    (agentId: AgentId): void => {
      dispatch({ t: "select", agentId });
      client.attach(agentId, backfilled.current.has(agentId) ? {} : { sinceSeq: 0 });
      backfilled.current.add(agentId);
    },
    [client],
  );

  useEffect(() => {
    const offs = [
      client.on("status", event => {
        dispatch({ t: "status", event });
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
        // The only answer a resume claim gets: the agent that now
        // holds the session, or the one that already did. Selecting it is
        // what makes the tap land, and selecting is also attaching, so this
        // socket starts receiving the roster pushes that carry the agent the
        // daemon just made -- no admission by hand, which the roster would
        // only have to reconcile anyway.
        selectAgent(event.agentId);
      }),
      client.on("sessions", event => {
        dispatch({ t: "sessions", event });
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
        dispatch({ t: "error", event });
      }),
      client.on("say", event => {
        dispatch({ t: "say", event });
      }),
      client.on("tui_activity", event => {
        dispatch({ t: "tui_activity", event });
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
      for (const off of offs) off();
      client.close();
    };
  }, [client, settleWebViewAction, selectAgent]);

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
        dispatch({ t: "select", agentId: null });
      },
      prompt(agentId, text) {
        client.prompt(agentId, text);
        dispatch({ t: "prompt", agentId, text });
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
      dismiss() {
        dispatch({ t: "dismiss" });
      },
      openSession(target) {
        // The resume claim rides the sealed socket rather than the daemon's
        // HTTP routes, because a hub relay carries one websocket and no HTTP.
        // The daemon answers `session_opened` with the agent that now holds
        // the session, and a session already held answers with the one
        // holding it, so a double tap cannot make a second holder. Selecting
        // waits for that answer; the reply, not this dispatch, is what opens
        // the screen.
        //
        // A live terminal session never claims anything: the terminal cannot
        // hand its renderer over, so the open is the local prompt surface and
        // nothing crosses the wire until the operator sends from it.
        switch (target.kind) {
          case "agent":
            selectAgent(target.agentId);
            return;
          case "live-tui":
            dispatch({ t: "tui_select", sessionId: target.sessionId });
            return;
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
      promptTui(sessionId, text) {
        client.sessionPrompt(sessionId, text);
        dispatch({ t: "tui_prompt", sessionId, text });
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
    [client, settleWebViewAction, selectAgent],
  );

  return [state, actions];
}
