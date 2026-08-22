/**
 * The Cowork route: reachable, pointed at this pairing, and honest about the hub.
 *
 * The real `Console` over a canned socket and a canned `fetch`, the same
 * division `nav-shell.test.tsx` drives the shell with, because what is under
 * test is the mount rather than the screen. The screen itself is already
 * covered by `cowork-smoke.test.tsx` against data handed straight to it; what
 * only this composition can prove is the part that was missing: that the
 * surface is reachable at all, that its data edge is aimed at the daemon and
 * credential this device is paired with, and that a hub pairing is told the
 * limit instead of being left in front of catalogues that can never fill.
 *
 * Every assertion goes through a `testID` a person can find in the source, or
 * through the request the surface actually made. None goes through a
 * screenshot: a pixel cannot say which route is mounted or which host was
 * asked, and those are the two things that were broken.
 */

import "./rnw.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
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

/** The client surface `useConsole` touches, canned, in the shape `nav-shell.test.tsx` uses it. */
class CannedClient {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

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
}

/** One HTTP ask the surface made. Named for the daemon side, so it cannot be mistaken for the DOM `Request`. */
interface DaemonAsk {
  url: string;
  /** The credential the surface presented, as the daemon would read it. */
  authorization: string | null;
}

const requests: DaemonAsk[] = [];
const ORIGINAL_FETCH = globalThis.fetch;

/**
 * The daemon's three Cowork routes, canned, and a record of who asked.
 *
 * Recording the request is the point: "the surface received the connection" is
 * not observable from the tree, and asserting a rendered row alone would pass
 * against a surface aimed at the wrong host with the wrong token.
 */
function cannedDaemon(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    const body = url.includes("/v1/skills")
      ? { skills: [{ name: "debug", description: "diagnose without fixing", kind: "skill", source: "native:native" }] }
      : url.includes("/v1/connectors")
        ? { connectors: [{ name: "github", connected: true, status: "connected" }] }
        : {
            tasks: [
              {
                id: "t_1",
                title: "Mount the cowork surface",
                prompt: "wire the route",
                agentId: AGENT.id,
                state: "running",
                createdAt: "2026-02-01T00:00:00.000Z",
                updatedAt: "2026-02-01T00:00:00.000Z",
                labels: {},
              },
            ],
          };
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
    );
  }) as unknown as typeof fetch;
}

/** Refuses any HTTP at all: the hub path must not reach for a route the hub has no tunnel for. */
function forbidFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    requests.push({ url: String(input), authorization: null });
    return Promise.reject(new Error("the cowork route must not attempt HTTP on a hub pairing"));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests.length = 0;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

interface Shell {
  host: HTMLElement;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  /** Let the polled fetches land and their state commit. */
  settle: () => Promise<void>;
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
    el,
    press: (testID: string) => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    settle: async () => {
      await act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
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
  test("the entry is in the menu and pushes the route", async () => {
    cannedDaemon();
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

      // The route's first poll lands inside the test rather than after it, so
      // nothing commits state into an unmounted tree.
      await shell.settle();
    } finally {
      shell.unmount();
    }
  });
});

describe("the surface is handed this pairing's connection", () => {
  test("it asks the daemon the connection names, with the connection's own credential", async () => {
    cannedDaemon();
    const shell = mountShell(DIRECT);
    try {
      // Route-scoped rather than console-wide: nothing polls Cowork's routes
      // until the operator is actually on the surface.
      expect(requests).toHaveLength(0);

      shell.press("open-menu");
      shell.press("open-cowork");

      const urls = requests.map(request => request.url);
      expect(urls).toContain(`http://127.0.0.1:7777/v1/skills?cwd=${encodeURIComponent(CWD)}`);
      expect(urls).toContain(`http://127.0.0.1:7777/v1/connectors?cwd=${encodeURIComponent(CWD)}`);
      expect(urls).toContain("http://127.0.0.1:7777/v1/tasks");
      // One credential, this pairing's, on every route. A surface built from a
      // stale or empty token would still render, which is why this is asserted
      // on the request rather than inferred from the tree.
      expect(requests.filter(request => request.authorization !== "Bearer tok_direct")).toEqual([]);

      await shell.settle();
      // What the daemon answered is on screen, so the connection carried data
      // and not just a request.
      expect(shell.el("task-t_1")).not.toBeNull();
      expect(shell.el("cowork-notice")).toBeNull();
    } finally {
      shell.unmount();
    }
  });
});

describe("a hub pairing is told the limit rather than left waiting", () => {
  test("the route names the hub's HTTP limit and never reaches for a route the relay lacks", async () => {
    forbidFetch();
    const shell = mountShell(HUB);
    try {
      shell.press("open-menu");
      // Present on a hub too: an operator who cannot use the surface still has
      // to be able to find out why, which is the whole point of naming it.
      expect(shell.el("open-cowork")).not.toBeNull();
      shell.press("open-cowork");

      expect(shell.el("cowork-unreachable")).not.toBeNull();
      // Not the surface: four empty catalogues would read as a daemon with
      // nothing installed on it, which is a lie about a working machine.
      expect(shell.el("cowork-screen")).toBeNull();
      expect(shell.el("cowork-surface")).toBeNull();
      expect(shell.host.textContent).toContain("hub");

      await shell.settle();
      // Fail closed by construction, not by a request that failed: the state is
      // decided from the pairing, so nothing is ever in flight to wait on.
      expect(requests).toHaveLength(0);
      expect(shell.el("cowork-unreachable")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });
});
