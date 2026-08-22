/**
 * The Cowork route: reachable, pointed at this pairing, and working on the
 * transport Jason's phone actually holds.
 *
 * The hub case is the point of the file. Cowork used to read the daemon's own
 * HTTP routes, which a hub-paired phone has no address for (the hub tunnels
 * exactly one HTTP shape, the routine webhook POST, and Cowork adds no
 * second), so such a phone got a named limit where the surface should have
 * been. Every ask is a socket frame now, so the hub pairing gets the surface,
 * and the assertions below are on the frames the surface sent rather than on a
 * rendered row: "the surface received this pairing's client" is not observable
 * from the tree, and a screen aimed at the wrong socket would still render.
 *
 * Any HTTP at all from this route is a regression, so `fetch` throws here.
 */

import "./rnw.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent, ClientFrame } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, same reason as `nav-shell.test.tsx`: bun evaluates a
// file's whole static import graph before its body runs, so a static import of
// the console would pull the real `react-native` in before `./rnw.ts` could
// substitute it.
const { Console } = await import("../src/console/Console.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DIRECT: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_direct",
  scopes: ["read", "approve", "manage"],
};

/** The transport Jason's phone actually holds: a relay whose one tunnel fires a webhook, with no route to Cowork's. */
const HUB: Connection = {
  transport: "hub",
  hubUrl: "wss://hub.ompctl.ai/relay",
  daemonId: "dae_0123456789abcdef",
  token: "tok_hub",
  scopes: ["read", "approve", "manage"],
};

const CWD = "/Users/op/dev/src/github.com/op/alpha";

const AGENT: Agent = {
  id: "agt_0000000000000001",
  name: "alpha",
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: CWD,
  createdAt: "2026-02-01T00:00:00.000Z",
  lastActiveAt: "2026-02-01T00:00:00.000Z",
  labels: {},
};

const TASK = {
  id: "t_1",
  title: "Mount the cowork surface",
  prompt: "wire the route",
  agentId: AGENT.id,
  state: "running" as const,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  labels: {},
};

/**
 * The client surface both `useConsole` and the Cowork surface touch, canned,
 * in the shape `nav-shell.test.tsx` uses it. Every cowork ask is recorded as
 * the frame it would put on the wire, which is what makes "the surface is
 * driving this pairing's socket" checkable.
 */
class CannedClient {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  readonly sent: ClientFrame[] = [];
  /** What this canned socket claims about its link, read once at mount. */
  connectionState = "connected";

  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  on(name: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter(entry => entry !== listener),
      );
    };
  }
  framesOfType<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    const matches: Extract<ClientFrame, { t: T }>[] = [];
    for (const frame of this.sent) {
      if (frame.t === t) matches.push(frame as Extract<ClientFrame, { t: T }>);
    }
    return matches;
  }
  start(): void {}
  close(): void {}
  reconnectNow(): void {}
  attach(): void {}
  listSessions(): void {}
  sessionTail(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  listDirectory(path?: string): void {
    this.sent.push(path === undefined ? { t: "fs_list" } : { t: "fs_list", path });
  }
  createSession(cwd: string): void {
    this.sent.push({ t: "session_create", cwd });
  }
  cloneRepo(url: string, parent: string): void {
    this.sent.push({ t: "repo_clone", url, parent });
  }
  readSkills(cwd?: string): void {
    this.sent.push(cwd === undefined ? { t: "skills_read" } : { t: "skills_read", cwd });
  }
  readConnectors(cwd?: string): void {
    this.sent.push(cwd === undefined ? { t: "connectors_read" } : { t: "connectors_read", cwd });
  }
  readTasks(): void {
    this.sent.push({ t: "tasks_read" });
  }
  createTask(input: { title: string; prompt: string; agentId: string }): void {
    this.sent.push({ t: "task_create", ...input });
  }
  cancelTask(taskId: string): void {
    this.sent.push({ t: "task_cancel", taskId });
  }
  createAgent(request: { name: string; cwd: string }): void {
    this.sent.push({ t: "agent_create", ...request });
  }
}

const ORIGINAL_FETCH = globalThis.fetch;
const httpAttempts: string[] = [];

beforeEach(() => {
  httpAttempts.length = 0;
  const forbidden: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      httpAttempts.push(String(input));
      throw new Error(`the cowork route must not reach for HTTP: ${String(input)}`);
    },
    { preconnect: () => {} },
  );
  globalThis.fetch = forbidden;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

interface Shell {
  host: HTMLElement;
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  /** Deliver one server frame's event, the way the real client would emit it. */
  emit: (name: string, event: unknown) => void;
  unmount: () => void;
}

/** Mounts the real shell over a canned socket, connected, with one agent on the roster. */
function mountShell(connection: Connection): Shell {
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <Console
        connection={connection}
        daemonLabel="Studio Mac"
        connections={{ activeId: "local", connections: [{ id: "local", label: "Studio Mac", connection }] }}
        onAddConnection={() => {}}
        onSelectConnection={() => {}}
        onUnpair={() => {}}
        createClient={() => client as unknown as OmpdClient}
      />,
    );
  });

  act(() => {
    client.emit("status", { state: "connected", attempt: 0 });
    client.emit("agents", { agents: [AGENT], deviceId: "dev_phone", scopes: ["read", "approve", "manage"] });
  });

  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  return {
    host,
    client,
    el,
    press: (testID: string) => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    emit: (name, event) => {
      act(() => {
        client.emit(name, event);
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

describe("the shell menu reaches the cowork surface", () => {
  test("the entry is in the menu and pushes the route", () => {
    const shell = mountShell(DIRECT);
    try {
      // Unreachable is the bug this closes: the surface existed and nothing
      // routed to it, so its absence before the menu opens is the baseline.
      expect(shell.el("cowork-surface")).toBeNull();
      expect(shell.el("open-cowork")).toBeNull();

      shell.press("open-menu");
      expect(shell.el("open-cowork")).not.toBeNull();

      shell.press("open-cowork");
      expect(shell.el("cowork-surface")).not.toBeNull();
      expect(shell.el("cowork-screen")).not.toBeNull();
      // The menu is a modal: the destination must not be stacked under a sheet.
      expect(shell.el("shell-menu")).toBeNull();
      // The surface's own navigation is present, so what landed is the whole
      // screen rather than a header with nothing under it.
      expect(shell.el("cowork-nav")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });
});

describe("the surface asks over this pairing's socket", () => {
  test("it sends the three catalogue frames, scoped to the open session's cwd", () => {
    const shell = mountShell(DIRECT);
    try {
      // Route-scoped rather than console-wide: nothing asks for Cowork's
      // frames until the operator is actually on the surface.
      expect(shell.client.framesOfType("tasks_read")).toEqual([]);

      shell.press("open-menu");
      shell.press("open-cowork");

      expect(shell.client.framesOfType("skills_read")).toEqual([{ t: "skills_read", cwd: CWD }]);
      expect(shell.client.framesOfType("connectors_read")).toEqual([{ t: "connectors_read", cwd: CWD }]);
      expect(shell.client.framesOfType("tasks_read")).toEqual([{ t: "tasks_read" }]);
      // Not one byte of HTTP: the whole surface is frames now.
      expect(httpAttempts).toEqual([]);

      // What the daemon answers is on screen, so the socket carried data and
      // not just an ask.
      shell.emit("tasks", { tasks: [TASK] });
      expect(shell.el("task-t_1")).not.toBeNull();
      expect(shell.el("cowork-notice")).toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("a refused ask is named on screen rather than left as four empty catalogues", () => {
    const shell = mountShell(DIRECT);
    try {
      shell.press("open-menu");
      shell.press("open-cowork");

      shell.emit("error", { message: "skills_read requires read scope", code: "unauthorized" });

      expect(shell.el("cowork-notice")?.textContent).toContain("read scope");
    } finally {
      shell.unmount();
    }
  });
});

describe("a hub pairing reaches the same surface", () => {
  test("the route mounts and asks the same frames a direct pairing does", () => {
    const shell = mountShell(HUB);
    try {
      shell.press("open-menu");
      shell.press("open-cowork");

      // The whole point: no limit screen, the real surface.
      expect(shell.el("cowork-unreachable")).toBeNull();
      expect(shell.el("cowork-surface")).not.toBeNull();
      expect(shell.el("cowork-screen")).not.toBeNull();

      expect(shell.client.framesOfType("skills_read")).toEqual([{ t: "skills_read", cwd: CWD }]);
      expect(shell.client.framesOfType("connectors_read")).toEqual([{ t: "connectors_read", cwd: CWD }]);
      expect(shell.client.framesOfType("tasks_read")).toEqual([{ t: "tasks_read" }]);
      expect(httpAttempts).toEqual([]);

      shell.emit("tasks", { tasks: [TASK] });
      expect(shell.el("task-t_1")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("the folder binding and its picker are live on a hub pairing too", () => {
    const shell = mountShell(HUB);
    try {
      shell.press("open-menu");
      shell.press("open-cowork");

      // The binding is drawn because the surface has a socket, not because
      // the pairing happens to be direct.
      expect(shell.el("cowork-folders")).not.toBeNull();
      shell.press("cowork-folder-add");
      expect(shell.client.framesOfType("fs_list")).toEqual([{ t: "fs_list" }]);
    } finally {
      shell.unmount();
    }
  });
});
