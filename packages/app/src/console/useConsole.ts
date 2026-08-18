/**
 * The one impure edge between the client and the screens.
 *
 * Everything that decides what is on screen is in `state.ts` and is pure. This
 * file owns the socket, subscribes it to that reducer, and hands back the
 * actions a view can take. Keeping the split sharp is what lets a canned frame
 * stream produce byte-identical state to a live daemon.
 */

import type {
  Agent,
  AgentId,
  ApprovalChoice,
  ApprovalScope,
  PlanReviewChoice,
  WebViewActionResult,
} from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { AppState } from "react-native";
import { restRoot } from "../cowork/useCowork.ts";
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
   * that agent the way `select` does; a row the daemon reported `live-tui`
   * asks the daemon to adopt the TUI first, then opens the agent the
   * adoption produced.
   */
  openSession: (target: SessionOpenTarget) => void;
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

/** What `POST /v1/sessions/:id/takeover` answers: the agent the adoption created. */
interface TakeoverResponse {
  agent: Agent;
}

/** Just the slice of `fetch` the takeover needs, so a test can stand in for it. */
type TakeoverFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Asks the daemon to adopt the live TUI holding `sessionId`.
 *
 * This is the supervisor's takeover path: the TUI process keeps its session
 * and the daemon wraps it in an agent row this device can then attach to,
 * which is why the returned agent is the caller's next `select`. The request
 * rides HTTP because that is the only shape the daemon offers for it; a
 * hub-relayed connection has no HTTP surface and the socket protocol has no
 * takeover frame, so relayed devices fail closed here rather than guessing
 * at a route that does not exist.
 */
export async function takeOverLiveTui(
  sessionId: string,
  deps: { root: string | null; token: string; fetch?: TakeoverFetch },
): Promise<Agent> {
  if (deps.root === null) {
    throw new Error("taking over a live TUI needs the daemon's HTTP route, which this relayed connection cannot reach");
  }
  const request = deps.fetch ?? fetch;
  const response = await request(`${deps.root}/v1/sessions/${encodeURIComponent(sessionId)}/takeover`, {
    method: "POST",
    headers: { Authorization: `Bearer ${deps.token}` },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `the daemon refused the takeover (${response.status})`);
  }
  return ((await response.json()) as TakeoverResponse).agent;
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

  // Takeover is the one request in this hook that rides HTTP rather than the
  // socket, because the daemon offers it no frame. A hub relay has no HTTP
  // surface behind it, so it resolves to no root and the takeover fails
  // closed, the same rule `useCowork`'s fetches already follow.
  const takeoverRoot = connection.transport === "direct" ? restRoot(connection.url) : null;

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
  }, [client, settleWebViewAction]);

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
        if (target.agentId !== undefined) {
          selectAgent(target.agentId);
          return;
        }
        if (!target.liveTui) {
          // Honesty over silence: the row is on screen, so the tap has to
          // answer. A dormant resume needs a create-with-session request the
          // daemon does not offer yet, and pretending otherwise would strand
          // the operator on a dead control.
          dispatch({ t: "error", event: { message: "That session is dormant; this build cannot resume it yet." } });
          return;
        }
        void takeOverLiveTui(target.sessionId, { root: takeoverRoot, token: connection.token })
          .then(agent => {
            // The adoption created an agent this socket only hears about on
            // the next roster push, and pushes only reach sockets already
            // attached to something. Admit the agent the response named so
            // the open lands instead of tapping a row that does nothing.
            dispatch({ t: "agent_admitted", agent });
            selectAgent(agent.id);
          })
          .catch(cause => {
            dispatch({
              t: "error",
              event: { message: cause instanceof Error ? cause.message : "the takeover failed" },
            });
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
    [client, settleWebViewAction, takeoverRoot, connection.token, selectAgent],
  );

  return [state, actions];
}
