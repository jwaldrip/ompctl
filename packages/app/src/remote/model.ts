/**
 * What the browse-and-start screen knows, and nothing about how it draws.
 *
 * The split is the same one `console/state.ts` draws and for the same reason: a
 * reducer over frames can be driven by canned input and asserted exactly, while
 * a component that folded the socket into itself could only be tested by
 * pretending to be a daemon. Every decision this surface makes -- what is on
 * screen, whether a clone is running, what the operator is being told -- is in
 * this file and is pure.
 *
 * One deliberate absence: there is no cache of visited directories. A listing
 * is the answer to a tap, the daemon is the only thing that knows what is on
 * that disk now, and a remembered listing is a screenful of directories that
 * may have been renamed since. Going back re-asks.
 */

import type { AgentId, CloneId, FsEntry, FsListing } from "@ompd/core/contracts";

/**
 * The slice of `OmpdClient` this surface drives.
 *
 * Structural rather than the class itself, so a test can drive the screen with
 * a client of its own and so nothing here can quietly reach for a method that
 * is not part of this feature. `OmpdClient` satisfies it as-is.
 */
export interface RemoteStartPort {
  listDirectory(path?: string): void;
  createSession(cwd: string, name?: string): void;
  cloneRepo(url: string, parent: string, name?: string): void;
}

/**
 * One progress line, with the position it arrived at.
 *
 * The sequence exists because the text does not identify a line: git rewrites
 * the same "Receiving objects: 47%" over and over, so two lines can be equal
 * and still be different events. A view keying on text would reorder or drop
 * them.
 */
export interface CloneLine {
  seq: number;
  text: string;
}

/** A clone the operator started from this screen, as it runs. */
export interface CloneState {
  cloneId: CloneId | null;
  /** Where it is going, as far as this device knows before `clone_done` says. */
  parent: string;
  url: string;
  /** Progress lines, newest last, bounded so a long clone cannot grow forever. */
  lines: CloneLine[];
  /** How many lines have arrived in total, which is what numbers the next one. */
  received: number;
  /** Set once the daemon answers `clone_done`. */
  path: string | null;
  failure: string | null;
}

/**
 * Progress lines kept on screen.
 *
 * The daemon already caps what it sends; this caps what a phone holds, because
 * the two are different budgets and a view that grew unboundedly on a long
 * clone would be the one thing here that gets slower the longer it works.
 */
export const MAX_CLONE_LINES_SHOWN = 40;

export interface RemoteStartState {
  /** The directory on screen, or "" for the roots view. */
  path: string;
  parent: string | null;
  roots: string[];
  entries: FsEntry[];
  /** True when the daemon returned a page rather than the whole directory. */
  bounded: boolean;
  /** A request is out and the answer has not arrived. */
  loading: boolean;
  /** The last refusal or failure, for the operator to read. */
  notice: string | null;
  clone: CloneState | null;
  /** Sessions started from this screen, newest first. */
  started: AgentId[];
}

export const EMPTY_REMOTE_START: RemoteStartState = {
  path: "",
  parent: null,
  roots: [],
  entries: [],
  bounded: false,
  loading: false,
  notice: null,
  clone: null,
  started: [],
};

export type RemoteStartEvent =
  /** A listing was asked for. Carries the path so a stale answer can be told apart. */
  | { t: "asked"; path: string }
  | { t: "listing"; listing: FsListing }
  /** A clone was asked for, before the daemon has given it an id. */
  | { t: "clone_asked"; parent: string; url: string }
  | { t: "clone_progress"; cloneId: CloneId; line: string }
  | { t: "clone_done"; cloneId: CloneId; path: string }
  | { t: "session_started"; agentId: AgentId }
  /** Any refusal or failure the daemon sent, or one this screen decided itself. */
  | { t: "notice"; message: string }
  | { t: "dismiss_notice" }
  | { t: "clone_dismissed" };

export function remoteStartReduce(state: RemoteStartState, event: RemoteStartEvent): RemoteStartState {
  switch (event.t) {
    case "asked":
      // The notice is cleared here rather than on the answer: a refusal is
      // about the request that produced it, so the next request is what makes
      // it stale, and clearing it later would leave a message from the last
      // tap sitting over the result of this one.
      return { ...state, loading: true, notice: null };
    case "listing":
      return {
        ...state,
        path: event.listing.path,
        parent: event.listing.parent,
        roots: event.listing.roots,
        entries: event.listing.entries,
        bounded: event.listing.bounded,
        loading: false,
      };
    case "clone_asked":
      return {
        ...state,
        clone: {
          cloneId: null,
          parent: event.parent,
          url: event.url,
          lines: [],
          received: 0,
          path: null,
          failure: null,
        },
      };
    case "clone_progress": {
      const clone = state.clone;
      if (clone === null) return state;
      const seq = clone.received + 1;
      const lines = [...clone.lines, { seq, text: event.line }].slice(-MAX_CLONE_LINES_SHOWN);
      // The id arrives with the first progress frame, not with the request:
      // the daemon mints it, and adopting it here is what lets a later frame
      // for a different clone be ignored.
      return { ...state, clone: { ...clone, cloneId: clone.cloneId ?? event.cloneId, lines, received: seq } };
    }
    case "clone_done": {
      const clone = state.clone;
      if (clone === null) return state;
      if (clone.cloneId !== null && clone.cloneId !== event.cloneId) return state;
      return { ...state, clone: { ...clone, cloneId: event.cloneId, path: event.path } };
    }
    case "session_started":
      return { ...state, started: [event.agentId, ...state.started] };
    case "notice": {
      // A refusal while a clone is running belongs to the clone: it is the one
      // thing on this screen that can fail after the tap that started it, and
      // a message in the panel is where someone watching it will look.
      const clone = state.clone;
      if (clone !== null && clone.path === null) {
        return { ...state, loading: false, clone: { ...clone, failure: event.message } };
      }
      return { ...state, loading: false, notice: event.message };
    }
    case "dismiss_notice":
      return { ...state, notice: null };
    case "clone_dismissed":
      return { ...state, clone: null };
  }
}

/**
 * The path an entry opens.
 *
 * The roots view has no directory of its own, so its entries are already
 * absolute; anywhere else an entry is a name inside `path`. Joined by hand
 * rather than with `node:path`, which React Native does not have.
 */
export function childPath(path: string, name: string): string {
  if (path === "") return name;
  return path.endsWith("/") ? `${path}${name}` : `${path}/${name}`;
}

/**
 * What to call the directory on screen.
 *
 * The last segment, because a phone header is narrow and the full path is
 * already shown underneath it. The roots view names itself.
 */
export function directoryLabel(path: string): string {
  if (path === "") return "Roots";
  const segments = path.split("/").filter(segment => segment.length > 0);
  return segments.at(-1) ?? path;
}

/** The repository name a clone url implies, for the destination the operator is about to get. */
export function repoNameFromUrl(url: string): string {
  const withoutQuery = url.split("?")[0] ?? url;
  const tail = withoutQuery.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return tail.endsWith(".git") ? tail.slice(0, -4) : tail;
}
