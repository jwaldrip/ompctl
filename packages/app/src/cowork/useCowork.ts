/**
 * The one impure edge between the client and the Cowork screen.
 *
 * Everything that decides what is on screen lives in `tasks.ts` and
 * `catalog.ts` and is pure. This file owns the socket asks and the poll
 * interval, mirroring the split `remote/useRemoteStart.ts` already draws
 * between a client and the reducer it feeds. Every ask rides the sealed
 * socket rather than a daemon HTTP route: the transport the console's own
 * socket already survives on is the transport Cowork asks on too, and a
 * hub-paired phone has no address for those routes. The hub does tunnel one
 * HTTP shape (the routine webhook POST); Cowork adds no second one, because a
 * general tunnel would carry this device's token through the hub.
 *
 * Lifecycle stays a poll rather than becoming a push, deliberately: the
 * roster frame answers "what is running right now", the daemon holds no
 * task-scoped subscription to join, and inventing one to save a frame nobody
 * asked for would add a push surface that must then be kept correct. A
 * dropped link costs one stale interval, never a silent roster.
 *
 * `task_create` requires an existing `agentId`: creating a task never
 * provisions a host (that is a separate manage-scope act, `agent_create`).
 * `defaultAgentId` is the caller's answer to "which session does a new task
 * with no session of its own target" — this hook does not pick one itself,
 * because picking a session is app-shell integration (which agent is "the
 * current one" is Console's fleet state, not Cowork's). `startTask` rejects
 * up front when it is `null` rather than silently guessing.
 */

import { useCallback, useEffect, useState } from "react";
import type { CoworkClient } from "./client.ts";
import type { NewTaskInput, TaskListState } from "./tasks.ts";
import { EMPTY_TASKS, reduceTasks } from "./tasks.ts";
import type { ConnectorSummary, SkillSummary } from "./types.ts";

const POLL_INTERVAL_MS = 4000;

export interface CoworkState {
  tasks: TaskListState;
  skills: SkillSummary[];
  connectors: ConnectorSummary[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: CoworkState = { tasks: EMPTY_TASKS, skills: [], connectors: [], loading: true, error: null };

export interface CoworkActions {
  startTask: (input: NewTaskInput) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  refresh: () => void;
}

export function useCowork(
  client: CoworkClient,
  cwd: string,
  defaultAgentId: string | null,
): [CoworkState, CoworkActions] {
  const [state, setState] = useState<CoworkState>(EMPTY_STATE);

  const ask = useCallback((): void => {
    // The cwd is passed through exactly, empty string included, the same way
    // the REST poll this replaced always sent `?cwd=`: the daemon resolves
    // what an empty workspace means, not this device.
    client.readSkills(cwd);
    client.readConnectors(cwd);
    client.readTasks();
  }, [client, cwd]);

  useEffect(() => {
    const offs = [
      // Each answer is its own slice of truth: one refused catalogue does not
      // blank the other two, and any answer at all retires the loading state
      // and the error the previous ask left.
      client.on("skills", event =>
        setState(previous => ({ ...previous, skills: event.skills, loading: false, error: null })),
      ),
      client.on("connectors", event =>
        setState(previous => ({ ...previous, connectors: event.connectors, loading: false, error: null })),
      ),
      client.on("tasks", event =>
        setState(previous => ({
          ...previous,
          tasks: reduceTasks(EMPTY_TASKS, { t: "load", tasks: event.tasks }),
          loading: false,
          error: null,
        })),
      ),
      // One task as the daemon holds it now: the answer to a start or a
      // cancel, folded in rather than awaited so the roster never depends on
      // this device matching replies to asks.
      client.on("task", event =>
        setState(previous => ({ ...previous, tasks: reduceTasks(previous.tasks, { t: "upsert", task: event.task }) })),
      ),
      client.on("error", event => setState(previous => ({ ...previous, loading: false, error: event.message }))),
      client.on("status", event => {
        // Every `connected` is a link that has just become usable, and the
        // client never replays catalogue frames across one: the first ask for
        // a socket that was still opening when this hook mounted, and the
        // restoration of what a drop took away, both ride this branch.
        if (event.state === "connected") ask();
      }),
    ];
    // Asked for here only when the link is already up -- a socket still
    // connecting would drop the frames and report the loss, so on that link
    // the first `connected` above carries the ask instead. Exactly one of
    // the two fires.
    if (client.connectionState === "connected") ask();
    const interval = setInterval(ask, POLL_INTERVAL_MS);
    return () => {
      for (const off of offs) off();
      clearInterval(interval);
    };
  }, [client, ask]);

  const startTask = useCallback(
    async (input: NewTaskInput) => {
      if (defaultAgentId === null) {
        throw new Error("no session to target — pick or create an agent before starting a task");
      }
      // Fire-and-ask: the created task arrives as the `task` event and a
      // refusal arrives as `error`, both folded into the state above, so
      // there is no promise here that could resolve before the daemon has
      // said anything.
      client.createTask({ ...input, agentId: defaultAgentId });
    },
    [client, defaultAgentId],
  );

  const cancelTask = useCallback(
    async (id: string) => {
      client.cancelTask(id);
    },
    [client],
  );

  return [state, { startTask, cancelTask, refresh: ask }];
}
