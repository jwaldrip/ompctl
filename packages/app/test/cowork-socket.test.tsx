/**
 * `useCowork` on the wire: a real `OmpdClient` over a fake socket, so the
 * frames asserted here are the frames a daemon would receive and the answers
 * are the frames a daemon would send.
 *
 * Three properties this file exists to hold. The catalogue asks and the task
 * mutations are frames, never fetches, because a hub-paired phone has no
 * address for the daemon's own routes. The roster is a poll, deliberately, and a poll
 * that stops polling is the failure mode a reader cannot see -- so the
 * interval is driven with fake timers rather than waited on. And a link that
 * drops and comes back re-asks by itself, because the client never replays
 * catalogue frames across a reconnect and a surface left holding the last
 * link's answers is a surface quietly showing stale work.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test, vi } from "bun:test";
import type { ClientFrame, ServerFrame, Task } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
// Type-only, so it is erased before it can pull `react-native` in early: the
// value side of this module is loaded dynamically below.
import type { CoworkActions, CoworkState } from "../src/cowork/useCowork.ts";

// Dynamic on purpose, the same reason `cowork-folders.test.tsx` is: a static
// import resolves `react-native` before `./rnw.ts` can substitute it with
// react-native-web, and the hook's module graph reaches react-native.
const { useCowork } = await import("../src/cowork/useCowork.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CWD = "/Users/op/dev/alpha";
const AGENT_ID = "agt_0000000000000001";

const TASK: Task = {
  id: "t_1",
  title: "Probe",
  prompt: "do the thing",
  agentId: AGENT_ID,
  state: "running",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  labels: {},
};

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];

  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "link lost", wasClean: false });
  }

  framesOfType<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    const matches: Extract<ClientFrame, { t: T }>[] = [];
    for (const frame of this.sent) {
      if (frame.t === t) matches.push(frame as Extract<ClientFrame, { t: T }>);
    }
    return matches;
  }
}

interface Probe {
  socket: FakeSocket;
  /** The newest state the hook returned, read after each act. */
  state: () => CoworkState;
  actions: () => CoworkActions;
  deliver: (frame: ServerFrame) => void;
  unmount: () => void;
}

/** Mounts the hook against a real client, with the socket already up. */
function probe(defaultAgentId: string | null = AGENT_ID): Probe {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  let socket: FakeSocket | undefined;
  const client = new OmpdClient({
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_test",
    schedule: () => () => {},
    isOnline: () => true,
    createSocket: url => {
      socket = new FakeSocket(url);
      return socket;
    },
    probeCredential: () => Promise.resolve("unknown"),
  });
  client.start();
  const live = socket;
  if (live === undefined) throw new Error("the client never built a socket");
  live.accept();
  live.deliver({ t: "hello", deviceId: "dev_test", agents: [] });

  let latest: [CoworkState, CoworkActions] | null = null;
  function Host(): null {
    latest = useCowork(client, CWD, defaultAgentId);
    return null;
  }

  act(() => {
    root.render(<Host />);
  });

  const read = (): [CoworkState, CoworkActions] => {
    if (latest === null) throw new Error("the hook never rendered");
    return latest;
  };

  return {
    socket: live,
    state: () => read()[0],
    actions: () => read()[1],
    deliver: frame => {
      act(() => {
        live.deliver(frame);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the catalogue asks", () => {
  test("all three ride frames on mount, scoped to the cwd it was handed", () => {
    const p = probe();
    try {
      expect(p.socket.framesOfType("skills_read")).toEqual([{ t: "skills_read", cwd: CWD }]);
      expect(p.socket.framesOfType("connectors_read")).toEqual([{ t: "connectors_read", cwd: CWD }]);
      expect(p.socket.framesOfType("tasks_read")).toEqual([{ t: "tasks_read" }]);
    } finally {
      p.unmount();
    }
  });

  test("each answer lands on its own slice and retires the loading state", () => {
    const p = probe();
    try {
      expect(p.state().loading).toBe(true);

      p.deliver({ t: "skills", skills: [{ name: "debug", description: "d", kind: "skill", source: "native:native" }] });
      expect(p.state().skills).toHaveLength(1);
      expect(p.state().loading).toBe(false);
      // The other two slices are untouched by the first answer: one refused
      // catalogue must not blank the rest.
      expect(p.state().connectors).toEqual([]);
      expect(p.state().tasks.tasks.size).toBe(0);

      p.deliver({ t: "connectors", connectors: [{ name: "github", connected: true, status: "connected" }] });
      p.deliver({ t: "tasks", tasks: [TASK] });
      expect(p.state().connectors).toHaveLength(1);
      expect(p.state().tasks.tasks.get("t_1")?.title).toBe("Probe");
    } finally {
      p.unmount();
    }
  });

  test("a refusal is carried as the error the surface shows, and the next answer clears it", () => {
    const p = probe();
    try {
      p.deliver({ t: "error", code: "unauthorized", message: "skills_read requires read scope" });
      expect(p.state().error).toBe("skills_read requires read scope");
      expect(p.state().loading).toBe(false);

      p.deliver({ t: "tasks", tasks: [] });
      expect(p.state().error).toBeNull();
    } finally {
      p.unmount();
    }
  });
});

describe("the roster stays a poll", () => {
  test("the interval re-asks all three without any push subscription", () => {
    vi.useFakeTimers();
    const p = probe();
    try {
      expect(p.socket.framesOfType("tasks_read")).toHaveLength(1);

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(p.socket.framesOfType("tasks_read")).toHaveLength(2);
      expect(p.socket.framesOfType("skills_read")).toHaveLength(2);

      act(() => {
        vi.advanceTimersByTime(8000);
      });
      expect(p.socket.framesOfType("tasks_read")).toHaveLength(4);
    } finally {
      p.unmount();
    }
  });

  test("the interval stops when the surface leaves", () => {
    vi.useFakeTimers();
    const p = probe();
    p.unmount();

    const asked = p.socket.framesOfType("tasks_read").length;
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(p.socket.framesOfType("tasks_read")).toHaveLength(asked);
  });

  test("a link that drops and comes back re-asks by itself", () => {
    const p = probe();
    try {
      const before = p.socket.framesOfType("tasks_read").length;

      // The client never replays catalogue frames across a reconnect, so the
      // surface's own `connected` listener is what restores the answers a
      // drop took away.
      act(() => {
        p.socket.accept();
        p.socket.deliver({ t: "hello", deviceId: "dev_test", agents: [] });
      });

      expect(p.socket.framesOfType("tasks_read").length).toBeGreaterThan(before);
    } finally {
      p.unmount();
    }
  });
});

describe("the task mutations", () => {
  test("a start sends task_create against the session the caller named, and the answer folds in", async () => {
    const p = probe();
    try {
      await act(async () => {
        await p.actions().startTask({ title: "Probe", prompt: "do the thing" });
      });

      expect(p.socket.framesOfType("task_create")).toEqual([
        { t: "task_create", title: "Probe", prompt: "do the thing", agentId: AGENT_ID },
      ]);

      p.deliver({ t: "task", task: TASK });
      expect(p.state().tasks.tasks.get("t_1")?.state).toBe("running");
    } finally {
      p.unmount();
    }
  });

  test("a start with no session to target is refused here rather than guessed at", async () => {
    const p = probe(null);
    try {
      let refusal: unknown = null;
      await act(async () => {
        refusal = await p
          .actions()
          .startTask({ title: "Probe", prompt: "do the thing" })
          .then(() => null)
          .catch((cause: unknown) => cause);
      });

      expect(String(refusal)).toContain("no session to target");
      expect(p.socket.framesOfType("task_create")).toEqual([]);
    } finally {
      p.unmount();
    }
  });

  test("a cancel sends task_cancel and the answering task replaces the row", async () => {
    const p = probe();
    try {
      p.deliver({ t: "tasks", tasks: [TASK] });

      await act(async () => {
        await p.actions().cancelTask("t_1");
      });
      expect(p.socket.framesOfType("task_cancel")).toEqual([{ t: "task_cancel", taskId: "t_1" }]);

      p.deliver({ t: "task", task: { ...TASK, state: "canceled" } });
      expect(p.state().tasks.tasks.get("t_1")?.state).toBe("canceled");
    } finally {
      p.unmount();
    }
  });
});
