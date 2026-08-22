/**
 * The folder-binding edge of Cowork: which directories on the daemon's own
 * disk the next container mounts, and the one REST call that starts it.
 *
 * `useCowork.ts` is the pattern this follows: the screen stays a fold over
 * props, this file owns the fetch. The folders themselves come from the
 * daemon's own listing (never the phone's disk: the daemon is the machine
 * whose folders get mounted), and starting posts `POST /v1/agents` with a
 * `container` host whose `mounts` are exactly the shape
 * `packages/daemon/src/provisioner/container.ts` validates -- an absolute
 * `hostPath` and an explicit `mode` -- so neither side invents a field.
 *
 * Every exit of the start is named rather than collapsed into "failed": a
 * scope refusal, a validation refusal, and a dead link are different facts an
 * operator acts on differently, and a surface that shows nothing on refusal is
 * the defect class this whole effort exists to stop.
 */

import type { AgentId, HostMount, HostSpec } from "@ompd/core/contracts";
import { useCallback, useState } from "react";
import type { Connection } from "../platform/connection.ts";
import { directoryLabel } from "../remote/model.ts";
import { restRoot } from "./useCowork.ts";

/** One directory the next cowork container will mount, as the daemon will see it. */
export interface BoundFolder {
  /** Absolute path on the daemon's machine, as its own `fs_listing` resolved it. */
  hostPath: string;
  /**
   * Sent explicitly rather than left to the daemon's `?? "ro"` default: the
   * row on screen should say exactly what the container gets, and a writable
   * mount stays a deliberate future act an operator opts into per path.
   */
  mode: "ro" | "rw";
}

/** The named states of the last start. `refused` carries its reason; nothing is silent. */
export type ContainerStart =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "started"; agentId: AgentId }
  | { status: "refused"; reason: string; retryable: boolean };

export interface CoworkFoldersState {
  /** False when the caller mounted Cowork with no connection: nothing to browse or start. */
  active: boolean;
  folders: BoundFolder[];
  start: ContainerStart;
}

export interface CoworkFoldersActions {
  /** Bind one absolute path. Binding the same path twice is a no-op: the daemon mounts it once either way. */
  bind: (hostPath: string) => void;
  unbind: (hostPath: string) => void;
  /** Start the container. The outcome lands in `state.start`, named, never thrown. */
  start: () => void;
}

/** The `host` slice of `POST /v1/agents`, in the exact shape the provisioner validates. */
export function coworkHostSpec(folders: readonly BoundFolder[]): HostSpec {
  const mounts: HostMount[] = folders.map(folder => ({ hostPath: folder.hostPath, mode: folder.mode }));
  return { kind: "container", mounts };
}

/**
 * The full request for a cowork container, or null when nothing is bound.
 *
 * `cwd` is the first bound folder rather than a daemon path this device cannot
 * know: every mount lands at its identical absolute path inside, which is the
 * property that makes the workspace mount work, so the first bound folder is
 * both a real directory on the far side and the honest anchor for the work.
 */
export function coworkContainerRequest(
  folders: readonly BoundFolder[],
): { name: string; cwd: string; host: HostSpec } | null {
  const first = folders[0];
  if (first === undefined) return null;
  return { name: directoryLabel(first.hostPath), cwd: first.hostPath, host: coworkHostSpec(folders) };
}

export function useCoworkFolders(connection: Connection | undefined): [CoworkFoldersState, CoworkFoldersActions] {
  const [folders, setFolders] = useState<BoundFolder[]>([]);
  const [start, setStart] = useState<ContainerStart>({ status: "idle" });

  // Cowork's routes are plain REST and the hub has no tunnel wired for them:
  // a webhook fire is the one request shape it carries. So a hub connection
  // has no root and the start below fails closed with its reason, the same
  // rule `useCowork` already draws.
  const root = connection?.transport === "direct" ? restRoot(connection.url) : null;

  const bind = useCallback((hostPath: string) => {
    // The daemon refuses a relative mount path outright
    // (`refuseIfDangerous` in container.ts), and the picker only ever hands
    // back paths its own listing resolved, so this guard mirrors the far
    // side's rule for a caller that somehow bypasses the picker.
    if (!hostPath.startsWith("/")) return;
    setFolders(previous =>
      previous.some(folder => folder.hostPath === hostPath) ? previous : [...previous, { hostPath, mode: "ro" }],
    );
  }, []);

  const unbind = useCallback((hostPath: string) => {
    setFolders(previous => previous.filter(folder => folder.hostPath !== hostPath));
  }, []);

  const startContainer = useCallback(() => {
    if (connection === undefined) return;
    const request = coworkContainerRequest(folders);
    if (request === null || root === null) {
      setStart({
        status: "refused",
        reason:
          root === null
            ? "The hub carries no route for starting a container; that needs a direct daemon connection."
            : "Bind a folder first: a container with nothing bound has nothing to scope.",
        retryable: false,
      });
      return;
    }

    setStart({ status: "starting" });
    const headers = new Headers({ "Content-Type": "application/json" });
    headers.set("Authorization", `Bearer ${connection.token}`);
    // Fire-and-forget on purpose: the state machine is the outcome surface, so
    // the screen never awaits this and a second tap cannot double-start.
    void fetch(`${root}/v1/agents`, { method: "POST", headers, body: JSON.stringify(request) })
      .then(async response => {
        if (response.ok) {
          const created = (await response.json()) as { agent: { id: AgentId } };
          setStart({ status: "started", agentId: created.agent.id });
          return;
        }
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setStart(refusalFor(response.status, body?.error));
      })
      .catch((cause: unknown) => {
        setStart({
          status: "refused",
          reason: `could not reach the daemon: ${cause instanceof Error ? cause.message : String(cause)}`,
          // The link failed, not the daemon's answer: another attempt is not
          // doomed the way a scope refusal is.
          retryable: true,
        });
      });
  }, [connection, folders, root]);

  return [
    { active: connection !== undefined, folders, start },
    { bind, unbind, start: startContainer },
  ];
}

/** Map a refused HTTP answer onto the named state an operator can act on. */
function refusalFor(status: number, error: string | undefined): ContainerStart {
  if (status === 403) {
    return {
      status: "refused",
      reason: "the daemon refused: this pairing lacks the manage scope a container needs",
      retryable: false,
    };
  }
  if (status === 400) {
    return {
      status: "refused",
      reason: `the daemon refused the request: ${error ?? "bad request"}`,
      retryable: false,
    };
  }
  if (status === 500) {
    // `ProvisionError` text lands here: a dangerous mount path, no container
    // runtime, an image that will not pull. None of those change on retry,
    // which is why this one is not marked retryable.
    return {
      status: "refused",
      reason: `the daemon refused the mounts: ${error ?? "internal error"}`,
      retryable: false,
    };
  }
  return {
    status: "refused",
    reason: `the daemon returned ${status}${error === undefined ? "" : `: ${error}`}`,
    retryable: true,
  };
}
