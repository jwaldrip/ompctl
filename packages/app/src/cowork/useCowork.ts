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
 * with no session of its own target" (this hook does not pick one itself,
 * because picking a session is app-shell integration, which agent is "the
 * current one" is Console's fleet state, not Cowork's). `startTask` rejects
 * up front when it is `null` rather than silently guessing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoworkClient } from "./client.ts";
import type { NewTaskInput, TaskListState } from "./tasks.ts";
import { EMPTY_TASKS, reduceTasks } from "./tasks.ts";
import type { ConnectorSummary, CoworkCatalog, CoworkSlice, SkillSummary, Task } from "./types.ts";

const POLL_INTERVAL_MS = 4000;

export interface CoworkState {
  tasks: TaskListState;
  skills: SkillSummary[];
  connectors: ConnectorSummary[];
  skillsSlice: CoworkSlice<SkillSummary[]>;
  connectorsSlice: CoworkSlice<ConnectorSummary[]>;
  tasksSlice: CoworkSlice<TaskListState>;
  loading: boolean;
  error: string | null;
}

const EMPTY_SKILLS_SLICE: CoworkSlice<SkillSummary[]> = { status: "loading", data: [], error: null };
const EMPTY_CONNECTORS_SLICE: CoworkSlice<ConnectorSummary[]> = { status: "loading", data: [], error: null };
const EMPTY_TASKS_SLICE: CoworkSlice<TaskListState> = { status: "loading", data: EMPTY_TASKS, error: null };

const EMPTY_STATE: CoworkState = {
  tasks: EMPTY_TASKS,
  skills: [],
  connectors: [],
  skillsSlice: EMPTY_SKILLS_SLICE,
  connectorsSlice: EMPTY_CONNECTORS_SLICE,
  tasksSlice: EMPTY_TASKS_SLICE,
  loading: true,
  error: null,
};

export interface CoworkActions {
  startTask: (input: NewTaskInput) => Promise<void>;
  retryTask: (task: Task) => Promise<void>;
  cancelTask: (id: string) => Promise<void>;
  refresh: () => void;
}

function classifyErrorCatalog(
  event: { catalog?: CoworkCatalog; code?: string; message?: string; requestId?: string },
  pending: { skills: string | null; connectors: string | null; tasks: string | null },
): CoworkCatalog | null {
  if (event.requestId !== undefined && event.requestId !== null) {
    if (event.requestId === pending.skills) return "skills";
    if (event.requestId === pending.connectors) return "connectors";
    if (event.requestId === pending.tasks) return "tasks";
  }
  if (event.catalog !== undefined && event.catalog !== null) {
    return event.catalog;
  }
  const code = event.code ?? "";
  const msg = event.message ?? "";
  if (code.startsWith("skills_") || msg.includes("skills_read") || msg.includes("skills catalogue")) {
    return "skills";
  }
  if (code.startsWith("connectors_") || msg.includes("connectors_read") || msg.includes("connector catalogue")) {
    return "connectors";
  }
  if (code.startsWith("tasks_") || msg.includes("tasks_read") || msg.includes("task lifecycle")) {
    return "tasks";
  }
  return null;
}

export function useCowork(
  client: CoworkClient,
  cwd: string,
  defaultAgentId: string | null,
): [CoworkState, CoworkActions] {
  const [state, setState] = useState<CoworkState>(EMPTY_STATE);
  const pendingRequests = useRef<{
    skills: string | null;
    connectors: string | null;
    tasks: string | null;
  }>({ skills: null, connectors: null, tasks: null });
  const reqCounter = useRef(0);

  const ask = useCallback((): void => {
    // The cwd is passed through exactly, empty string included, the same way
    // the REST poll this replaced always sent `?cwd=`: the daemon resolves
    // what an empty workspace means, not this device.
    const skillsReq = `req_skills_${++reqCounter.current}`;
    const connectorsReq = `req_connectors_${++reqCounter.current}`;
    const tasksReq = `req_tasks_${++reqCounter.current}`;
    pendingRequests.current = {
      skills: skillsReq,
      connectors: connectorsReq,
      tasks: tasksReq,
    };
    client.readSkills(cwd, undefined, skillsReq);
    client.readConnectors(cwd, undefined, connectorsReq);
    client.readTasks(undefined, tasksReq);
  }, [client, cwd]);

  useEffect(() => {
    const offs = [
      // Each answer is its own slice of truth: one refused catalogue does not
      // blank the other two, and each slice retires its own loading and error
      // state without erasing another slice's refusal.
      client.on("skills", event =>
        setState(previous => {
          const nextSkillsSlice: CoworkSlice<SkillSummary[]> = {
            status: "loaded",
            data: event.skills,
            error: null,
          };
          const nextError = previous.connectorsSlice.error ?? previous.tasksSlice.error;
          return {
            ...previous,
            skills: event.skills,
            skillsSlice: nextSkillsSlice,
            loading: false,
            error: nextError,
          };
        }),
      ),
      client.on("connectors", event =>
        setState(previous => {
          const nextConnectorsSlice: CoworkSlice<ConnectorSummary[]> = {
            status: "loaded",
            data: event.connectors,
            error: null,
          };
          const nextError = previous.skillsSlice.error ?? previous.tasksSlice.error;
          return {
            ...previous,
            connectors: event.connectors,
            connectorsSlice: nextConnectorsSlice,
            loading: false,
            error: nextError,
          };
        }),
      ),
      client.on("tasks", event =>
        setState(previous => {
          const nextTasks = reduceTasks(EMPTY_TASKS, { t: "load", tasks: event.tasks });
          const nextTasksSlice: CoworkSlice<TaskListState> = {
            status: "loaded",
            data: nextTasks,
            error: null,
          };
          const nextError = previous.skillsSlice.error ?? previous.connectorsSlice.error;
          return {
            ...previous,
            tasks: nextTasks,
            tasksSlice: nextTasksSlice,
            loading: false,
            error: nextError,
          };
        }),
      ),
      // One task as the daemon holds it now: the answer to a start or a
      // cancel, folded in rather than awaited so the roster never depends on
      // this device matching replies to asks.
      client.on("task", event =>
        setState(previous => {
          const nextTasks = reduceTasks(previous.tasks, { t: "upsert", task: event.task });
          return {
            ...previous,
            tasks: nextTasks,
            tasksSlice: {
              ...previous.tasksSlice,
              data: nextTasks,
            },
          };
        }),
      ),
      client.on("error", event =>
        setState(previous => {
          const target = classifyErrorCatalog(event, pendingRequests.current);
          if (target === "skills") {
            const nextSkillsSlice: CoworkSlice<SkillSummary[]> = {
              status: "refused",
              data: [],
              error: event.message,
            };
            return {
              ...previous,
              skills: [],
              skillsSlice: nextSkillsSlice,
              loading: false,
              error: event.message,
            };
          }
          if (target === "connectors") {
            const nextConnectorsSlice: CoworkSlice<ConnectorSummary[]> = {
              status: "refused",
              data: [],
              error: event.message,
            };
            return {
              ...previous,
              connectors: [],
              connectorsSlice: nextConnectorsSlice,
              loading: false,
              error: event.message,
            };
          }
          if (target === "tasks") {
            const nextTasksSlice: CoworkSlice<TaskListState> = {
              status: "refused",
              data: EMPTY_TASKS,
              error: event.message,
            };
            return {
              ...previous,
              tasks: EMPTY_TASKS,
              tasksSlice: nextTasksSlice,
              loading: false,
              error: event.message,
            };
          }
          const nextSkillsSlice: CoworkSlice<SkillSummary[]> =
            previous.skillsSlice.status === "loading"
              ? { status: "refused", data: [], error: event.message }
              : previous.skillsSlice;
          const nextConnectorsSlice: CoworkSlice<ConnectorSummary[]> =
            previous.connectorsSlice.status === "loading"
              ? { status: "refused", data: [], error: event.message }
              : previous.connectorsSlice;
          const nextTasksSlice: CoworkSlice<TaskListState> =
            previous.tasksSlice.status === "loading"
              ? { status: "refused", data: EMPTY_TASKS, error: event.message }
              : previous.tasksSlice;
          return {
            ...previous,
            skillsSlice: nextSkillsSlice,
            connectorsSlice: nextConnectorsSlice,
            tasksSlice: nextTasksSlice,
            loading: false,
            error: event.message,
          };
        }),
      ),
      client.on("status", event => {
        // Every `connected` is a link that has just become usable, and the
        // client never replays catalogue frames across one: the first ask for
        // a socket that was still opening when this hook mounted, and the
        // restoration of what a drop took away, both ride this branch.
        if (event.state === "connected") ask();
      }),
    ];
    // Asked for here only when the link is already up: a socket still
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
      const targetAgentId = input.agentId ?? defaultAgentId;
      if (!targetAgentId) {
        throw new Error("no session to target: pick or create an agent before starting a task");
      }
      // Fire-and-ask: the created task arrives as the `task` event and a
      // refusal arrives as `error`, both folded into the state above, so
      // there is no promise here that could resolve before the daemon has
      // said anything.
      client.createTask({ ...input, agentId: targetAgentId });
    },
    [client, defaultAgentId],
  );

  const retryTask = useCallback(
    async (task: Task) => {
      // Retrying a task runs it where the task ran: task.agentId is the
      // target and never falls back to defaultAgentId.
      client.createTask({
        title: task.title,
        prompt: task.prompt,
        skillName: task.skillName,
        agentId: task.agentId,
      });
    },
    [client],
  );

  const cancelTask = useCallback(
    async (id: string) => {
      client.cancelTask(id);
    },
    [client],
  );

  return [state, { startTask, retryTask, cancelTask, refresh: ask }];
}
