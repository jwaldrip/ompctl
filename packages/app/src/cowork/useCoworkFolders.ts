/**
 * The folder-binding edge of Cowork: which directories on the daemon's own
 * disk the next container mounts, and the one socket frame that starts it.
 *
 * `useCowork.ts` is the pattern this follows: the screen stays a fold over
 * props, this file owns the ask. The folders themselves come from the
 * daemon's own listing (never the phone's disk: the daemon is the machine
 * whose folders get mounted), and starting sends `agent_create` with a
 * `container` host whose `mounts` are exactly the shape
 * `packages/daemon/src/provisioner/container.ts` validates -- an absolute
 * `hostPath` and an explicit `mode` -- so neither side invents a field.
 *
 * Every exit of the start is named rather than collapsed into "failed": a
 * scope refusal, a validation refusal, a replica's honest limit, and a dead
 * link are different facts an operator acts on differently, and a surface
 * that shows nothing on refusal is the defect class this whole effort exists
 * to stop. The outcomes arrive as frames on the client the caller handed
 * over, which is also why a hub pairing works here at all: the ask rides the
 * one sealed socket the relay carries.
 */

import type { AgentId, HostMount, WireHostSpec } from "@ompd/core/contracts";
import type { AgentCreatedEvent, ClientErrorEvent } from "@ompd/core/ompd-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { directoryLabel } from "../remote/model.ts";
import type { AgentCreateRequest, CoworkClient } from "./client.ts";

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
  /** False when the caller mounted Cowork with no client: nothing to browse or start. */
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

/**
 * The `host` slice of an `agent_create`, in the exact shape the provisioner
 * validates.
 *
 * `WireHostSpec`, so this cannot name an `image`: the daemon refuses that
 * field from a paired device, and the image a container host runs is the
 * daemon's own `containerImage` config. A phone is authenticated, not trusted
 * with the daemon's supply chain.
 */
export function coworkHostSpec(folders: readonly BoundFolder[]): WireHostSpec {
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
export function coworkContainerRequest(folders: readonly BoundFolder[]): AgentCreateRequest | null {
  const first = folders[0];
  if (first === undefined) return null;
  return { name: directoryLabel(first.hostPath), cwd: first.hostPath, host: coworkHostSpec(folders) };
}

export function useCoworkFolders(client: CoworkClient | undefined): [CoworkFoldersState, CoworkFoldersActions] {
  const [folders, setFolders] = useState<BoundFolder[]>([]);
  const [start, setStart] = useState<ContainerStart>({ status: "idle" });

  /**
   * Whether a start is awaiting its answer. The daemon's `agent_created` and
   * `error` frames are the only outcomes, and both arrive on a client this
   * hook does not own, so a ref -- not the state -- decides which frames are
   * this start's business and which belong to whoever else shares the socket.
   */
  const awaiting = useRef(false);

  useEffect(() => {
    if (client === undefined) return;
    const offs = [
      client.on("agent_created", (event: AgentCreatedEvent) => {
        if (!awaiting.current) return;
        awaiting.current = false;
        setStart({ status: "started", agentId: event.agent.id });
      }),
      client.on("error", (event: ClientErrorEvent) => {
        if (!awaiting.current) return;
        awaiting.current = false;
        setStart(refusalFor(event.code, event.message));
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client]);

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
    if (client === undefined) return;
    const request = coworkContainerRequest(folders);
    if (request === null) {
      setStart({
        status: "refused",
        reason: "Bind a folder first: a container with nothing bound has nothing to scope.",
        retryable: false,
      });
      return;
    }

    setStart({ status: "starting" });
    awaiting.current = true;
    // Fire-and-forget on purpose: the state machine is the outcome surface, so
    // the screen never awaits this and a second tap cannot double-start. A
    // link too dead to carry the frame reports itself as an `error` event
    // with code `offline`, the same named exit a refusal takes.
    client.createAgent(request);
  }, [client, folders]);

  return [
    { active: client !== undefined, folders, start },
    { bind, unbind, start: startContainer },
  ];
}

/**
 * Map the daemon's answer onto the named state an operator can act on. The
 * frames carry codes where the REST door carried statuses; the mapping is one
 * table so a new code is a decision here rather than a silent fall-through.
 */
function refusalFor(code: string | undefined, message: string): ContainerStart {
  if (code === "unauthorized") {
    return {
      status: "refused",
      reason: "the daemon refused: this pairing lacks the manage scope a container needs",
      retryable: false,
    };
  }
  if (code === "bad_frame") {
    return {
      status: "refused",
      reason: `the daemon refused the request: ${message}`,
      retryable: false,
    };
  }
  if (code === "agent_create_failed") {
    // `ProvisionError` text lands here: a dangerous mount path, no container
    // runtime, an image that will not pull. None of those change on retry,
    // which is why this one is not marked retryable.
    return {
      status: "refused",
      reason: `the daemon refused the mounts: ${message}`,
      retryable: false,
    };
  }
  if (code === "replica") {
    // The daemon answered honestly that it is a replica: the mounts were
    // browsed on its own disk and the agent would run somewhere they mean
    // nothing. That is a fact about this pairing's daemon, not a fault.
    return {
      status: "refused",
      reason: `${message}`,
      retryable: false,
    };
  }
  if (code === "offline" || code === "send") {
    return {
      status: "refused",
      reason: `could not reach the daemon: ${message}`,
      // The link failed, not the daemon's answer: another attempt is not
      // doomed the way a scope refusal is.
      retryable: true,
    };
  }
  return {
    status: "refused",
    reason: `the daemon refused: ${message}`,
    retryable: true,
  };
}
