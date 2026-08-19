/**
 * The impure edge between the socket and the browse-and-start screen.
 *
 * Everything that decides what is on screen lives in `model.ts` and is pure.
 * This subscribes a client to that reducer and hands back the gestures the
 * screen can make. It deliberately does not own the client's lifecycle: one
 * socket serves the whole app, and a screen calling `start()` on it would be
 * reconnecting a link that is already up.
 */

import type { AgentId } from "@ompd/core/contracts";
import type {
  ClientErrorEvent,
  CloneDoneEvent,
  CloneProgressEvent,
  ConnectionState,
  FsListingEvent,
  SessionOpenedEvent,
  StatusEvent,
} from "@ompd/core/ompd-client";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  childPath,
  EMPTY_REMOTE_START,
  type RemoteStartPort,
  type RemoteStartState,
  remoteStartReduce,
} from "./model.ts";

export interface RemoteStartActions {
  /** Open one absolute path, or the roots view with `""`. */
  open: (path: string) => void;
  /** Open the entry `name` inside the directory on screen. */
  openChild: (name: string) => void;
  /** Walk up, or back to the roots when there is nothing above this. */
  up: () => void;
  /** Ask for the listing on screen again. */
  refresh: () => void;
  /** Start a session at the directory on screen. */
  startHere: (name?: string) => void;
  /** Clone into the directory on screen. */
  cloneHere: (url: string, name?: string) => void;
  dismissNotice: () => void;
  dismissClone: () => void;
}

/**
 * The client events this surface listens to.
 *
 * Structural rather than `OmpdClient` itself, so a test can drive the screen
 * with a stand-in and so nothing here can quietly reach for a method that is
 * not part of this feature. The event payloads are the client's own types, so
 * a real `OmpdClient` satisfies this without a cast.
 */
export interface RemoteStartClient extends RemoteStartPort {
  /** Read once at mount to decide whether the first listing can be asked for now. */
  readonly connectionState: ConnectionState;
  on(name: "fs_listing", listener: (event: FsListingEvent) => void): () => void;
  on(name: "clone_progress", listener: (event: CloneProgressEvent) => void): () => void;
  on(name: "clone_done", listener: (event: CloneDoneEvent) => void): () => void;
  on(name: "error", listener: (event: ClientErrorEvent) => void): () => void;
  on(name: "session_opened", listener: (event: SessionOpenedEvent) => void): () => void;
  on(name: "status", listener: (event: StatusEvent) => void): () => void;
}

export function useRemoteStart(
  client: RemoteStartClient,
  onOpened?: (agentId: AgentId) => void,
): [RemoteStartState, RemoteStartActions] {
  const [state, dispatch] = useReducer(remoteStartReduce, EMPTY_REMOTE_START);

  /**
   * The directory this screen is actually showing: the one the daemon answered
   * with, never the one that was asked for.
   *
   * The two differ exactly when resolution mattered -- a symlink, or a `..`
   * segment -- and the resolved form is the only one worth acting on: a
   * session started "here" has to start in the directory on screen. It also
   * means a refused navigation leaves "here" as the last directory that
   * really listed, rather than a path this device only hoped for.
   *
   * A ref rather than a read of state, because the listeners below are
   * registered once and would otherwise close over the first render's value.
   */
  const showing = useRef<string>("");
  /**
   * The latest `onOpened`, held behind a ref on purpose.
   *
   * The console hands this screen a brand-new closure on every one of its own
   * re-renders, and a re-render is not a reason to resubscribe or re-ask: an
   * effect that keyed on the callback's identity would re-fire on every daemon
   * event the console hears, resetting the view to the roots each time. The
   * ref keeps the subscription keyed on the client alone while the listener
   * still calls whichever callback is current.
   */
  const opened = useRef(onOpened);
  useEffect(() => {
    opened.current = onOpened;
  });
  /**
   * Whether a session started from this screen is still awaiting its answer.
   *
   * The console subscribes to `session_opened` too, and it must: that is what
   * opens what an operator just started. This flag is only about whether
   * *this* screen asked, so a takeover elsewhere cannot make this screen claim
   * it started something.
   */
  const awaitingSession = useRef(false);

  const ask = useCallback(
    (path: string): void => {
      // Deliberately does not touch `showing`: only a listing that came back
      // moves where this screen is.
      dispatch({ t: "asked", path });
      // The roots view is the empty path, and the frame says so by carrying no
      // path at all rather than the empty string the daemon would refuse.
      if (path === "") client.listDirectory();
      else client.listDirectory(path);
    },
    [client],
  );

  useEffect(() => {
    const offs = [
      client.on("fs_listing", listing => {
        showing.current = listing.path;
        dispatch({ t: "listing", listing });
      }),
      client.on("clone_progress", event => dispatch({ t: "clone_progress", cloneId: event.cloneId, line: event.line })),
      client.on("clone_done", event => dispatch({ t: "clone_done", cloneId: event.cloneId, path: event.path })),
      client.on("error", event => dispatch({ t: "notice", message: event.message })),
      client.on("session_opened", event => {
        if (!awaitingSession.current) return;
        awaitingSession.current = false;
        dispatch({ t: "session_started", agentId: event.agentId });
        opened.current?.(event.agentId);
      }),
      client.on("status", event => {
        // Every `connected` is a link that has just become usable, and the
        // client deliberately never replays `fs` frames across one: the first
        // answers for a socket that was still opening when this screen mounted,
        // and the rest restore what a drop took away. Anything short of
        // `connected` is waited out, not recorded, because only a link that
        // came back can be asked to answer.
        if (event.state === "connected") ask(showing.current);
      }),
    ];
    // The roots are where a screen with nothing chosen starts. Asked for here
    // only when the link is already up -- a socket that is still connecting
    // would drop the frame and report the loss, so on that link the first
    // `connected` above carries the ask instead. Exactly one of the two fires.
    if (client.connectionState === "connected") ask("");
    return () => {
      for (const off of offs) off();
    };
  }, [client, ask]);

  const actions = useMemo<RemoteStartActions>(
    () => ({
      open(path) {
        ask(path);
      },
      openChild(name) {
        ask(childPath(showing.current, name));
      },
      up() {
        // `parent` is null at a root, and the honest destination from there is
        // the roots view rather than nowhere.
        ask(state.parent ?? "");
      },
      refresh() {
        ask(showing.current);
      },
      startHere(name) {
        const cwd = showing.current;
        if (cwd === "") {
          dispatch({ t: "notice", message: "Open a directory first: a session has to start somewhere." });
          return;
        }
        awaitingSession.current = true;
        client.createSession(cwd, name);
      },
      cloneHere(url, name) {
        const parent = showing.current;
        if (parent === "") {
          dispatch({ t: "notice", message: "Open a directory first: a clone has to land somewhere." });
          return;
        }
        const trimmed = url.trim();
        if (trimmed.length === 0) {
          dispatch({ t: "notice", message: "A clone needs a repository url." });
          return;
        }
        dispatch({ t: "clone_asked", parent, url: trimmed });
        client.cloneRepo(trimmed, parent, name);
      },
      dismissNotice() {
        dispatch({ t: "dismiss_notice" });
      },
      dismissClone() {
        dispatch({ t: "clone_dismissed" });
      },
    }),
    [client, ask, state.parent],
  );

  return [state, actions];
}
