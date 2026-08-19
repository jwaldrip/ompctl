/**
 * The shell, driven the way a thumb drives it.
 *
 * The real `Console` over a canned socket, so what is under test is the whole
 * composition rather than a re-statement of it: which route the navigator opens
 * first, what a tap on a live row pushes, where a back control lands, which
 * edges carry the system insets, and whether the menu reaches the two
 * destinations that used to be pinned to the bottom of a scrolling list.
 *
 * Every assertion goes through a `testID` a person can find in the source. None
 * goes through a screenshot: a rendered pixel cannot say which route is
 * mounted, and a route is the thing that broke on the operator's phone.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentId, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetSafeAreaInsets, setSafeAreaInsets } from "./rnw.ts";

// Dynamic on purpose, same reason as `smoke.test.tsx`: bun evaluates a file's
// whole static import graph before its body runs, so a static import of the
// console would pull the real `react-native` in before `./rnw.ts` could
// substitute it.
const { Console } = await import("../src/console/Console.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(resetSafeAreaInsets);

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "approve", "manage"],
};

const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [
    { id: "local", label: "Studio Mac", connection: CONNECTION },
    {
      id: "cloud",
      label: "Cloud",
      connection: { transport: "direct", url: "ws://10.0.0.4:7777/v1/socket", token: "tok_2", scopes: ["read"] },
    },
  ],
};

/**
 * The client surface `useConsole` touches, canned, in the same shape
 * `fleet-index.test.tsx` uses it: the hook and the shell are real, the socket
 * is not, because what is under test is what the shell does with a frame.
 */
class CannedClient {
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  readonly tails: Array<{ sessionId: string; limit?: number }> = [];
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
  /**
   * Recorded rather than ignored: opening a terminal route asks for the
   * session's transcript tail, so a double that lacked this method turned a
   * navigation test into a TypeError about the client instead of a failure
   * about the stack.
   */
  sessionTail(sessionId: string, limit?: number): void {
    this.tails.push({ sessionId, limit });
  }
  sessionPrompt(sessionId: string, text: string): void {
    this.prompts.push({ sessionId, text });
  }
  resumeSession(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: `session ${id}`,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    cwdScope: "home",
    flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
    status: "live-tui",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActivityAt: "2026-02-28T00:00:00.000Z",
    messageCount: 12,
    byteSize: 4_096,
    archived: false,
    pid: 4_242,
    ...overrides,
  };
}

interface Shell {
  host: HTMLElement;
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  unmount: () => void;
}

/** Mounts the real shell over a canned socket, already connected and indexed. */
function mountShell(rows: readonly SessionSummary[] = [summary("sess_live")]): Shell {
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <Console
        connection={CONNECTION}
        daemonLabel="Studio Mac"
        connections={CONNECTIONS}
        onAddConnection={() => {}}
        onSelectConnection={() => {}}
        onUnpair={() => {}}
        createClient={() => client as unknown as OmpdClient}
      />,
    );
  });

  act(() => {
    client.emit("status", { state: "connected", attempt: 0 });
    client.emit("sessions", { t: "sessions", sessions: rows });
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
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/** The padding react-native-web writes as inline style on a host node. */
function padding(element: HTMLElement | null): { top: string; bottom: string; left: string; right: string } {
  if (element === null) throw new Error("expected an element to read padding from");
  return {
    top: element.style.paddingTop || element.style.getPropertyValue("padding-top"),
    bottom: element.style.paddingBottom || element.style.getPropertyValue("padding-bottom"),
    left: element.style.paddingLeft || element.style.getPropertyValue("padding-left"),
    right: element.style.paddingRight || element.style.getPropertyValue("padding-right"),
  };
}

describe("the stack opens on the fleet and comes back to it", () => {
  test("the initial route is the sessions list, not a detail surface", () => {
    const shell = mountShell();
    try {
      expect(shell.el("fleet-surface")).not.toBeNull();
      expect(shell.el("fleet")).not.toBeNull();
      expect(shell.el("fleet-list")).not.toBeNull();
      expect(shell.el("terminal-session")).toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("opening a live row pushes the terminal route, and its back control returns to the list", () => {
    const shell = mountShell();
    try {
      shell.press("session-open-sess_live");
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.el("terminal-title")?.textContent).toBe("session sess_live");

      shell.press("terminal-back");
      expect(shell.el("terminal-session")).toBeNull();
      expect(shell.el("fleet-list")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("leaving the terminal route clears the console's own selection, so it does not bounce back", () => {
    const shell = mountShell();
    try {
      shell.press("session-open-sess_live");
      shell.press("terminal-back");
      // The model, not just the stack: a selection left set would be re-pushed
      // by the sync effect on the very next render, which is the shape of bug a
      // two-way sync produces when only one direction is wired.
      expect(shell.el("terminal-session")).toBeNull();

      // A second open still works, which a stale selection would have blocked
      // (the effect would see no change and never push).
      shell.press("session-open-sess_live");
      expect(shell.el("terminal-session")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });
});

describe("the system insets are honoured at both edges", () => {
  const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };

  test("the fleet route clears the status bar with its header and the home indicator with its own shell", () => {
    setSafeAreaInsets(NOTCH);
    const shell = mountShell();
    try {
      const surface = shell.el("fleet-surface");
      // The bottom edge belongs to the screen: the list must not scroll under
      // the home indicator, which is where "Connections" sat on his phone.
      expect(padding(surface).bottom).toBe(`${NOTCH.bottom}px`);
      // The top edge belongs to the header, which is drawn inside the inset. The
      // screen must NOT add it again, or the list starts 47pt below a header
      // that already cleared the notch: that gap is the dead band he reported.
      expect(padding(surface).top).toBe("0px");

      // What the header spends the inset on: a status bar spacer exactly its
      // height, above the bar's own content. Asserting the header height itself
      // would be asserting React Navigation's default bar height; asserting the
      // spacer is asserting that this device's notch reached the header at all.
      const heights = [...shell.host.querySelectorAll<HTMLElement>("*")].map(node => node.style.height);
      expect(heights).toContain(`${NOTCH.top}px`);
    } finally {
      shell.unmount();
    }
  });

  test("the terminal route draws its own bar, so it takes the top inset itself", () => {
    setSafeAreaInsets(NOTCH);
    const shell = mountShell();
    try {
      shell.press("session-open-sess_live");
      const terminal = shell.el("terminal-session");
      expect(padding(terminal).top).toBe(`${NOTCH.top}px`);
      // Its composer carries the bottom inset instead of the shell, so the send
      // button clears the home indicator without the screen padding twice.
      expect(padding(terminal).bottom).toBe("0px");
      const composer = shell.el("terminal-composer-safe");
      expect(padding(composer).bottom).toBe(`${NOTCH.bottom}px`);
    } finally {
      shell.unmount();
    }
  });
});

describe("the agent hub does not reserve space it has nothing to say in", () => {
  test("with no subagents the sessions header is the first thing under the header", () => {
    const shell = mountShell();
    try {
      expect(shell.el("agent-hub")).toBeNull();
      const fleet = shell.el("fleet");
      const surfaceContent = fleet?.parentElement ?? null;
      expect(surfaceContent).not.toBeNull();
      // Nothing between the shell's content node and the list: the block that
      // used to say "No subagents." above it is gone, not merely shorter.
      expect(surfaceContent?.firstElementChild).toBe(fleet);
      expect(shell.el("fleet-title")?.textContent).toBe("Sessions");
    } finally {
      shell.unmount();
    }
  });

  test("a subagent brings the block back", () => {
    const shell = mountShell();
    try {
      act(() => {
        shell.client.emit("agents", {
          t: "agents",
          agents: [
            {
              id: "agt_main" as AgentId,
              name: "Primary",
              state: "busy",
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              cwd: "/Users/op/dev/src/github.com/op/alpha",
              createdAt: "2026-02-01T00:00:00.000Z",
              lastActiveAt: "2026-02-01T00:00:00.000Z",
              labels: {},
            },
            {
              id: "agt_scout" as AgentId,
              name: "Scout",
              state: "idle",
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              cwd: "/Users/op/dev/src/github.com/op/alpha",
              createdAt: "2026-02-01T00:01:00.000Z",
              lastActiveAt: "2026-02-01T00:01:00.000Z",
              parentAgentId: "agt_main" as AgentId,
              labels: {},
            },
          ],
        });
      });
      expect(shell.el("agent-hub")).not.toBeNull();
      expect(shell.el("agent-hub-agt_scout")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });
});

describe("the menu carries what is not a session", () => {
  test("it exposes connections and invite, and each one navigates", () => {
    const shell = mountShell();
    try {
      expect(shell.el("shell-menu")).toBeNull();
      shell.press("open-menu");
      expect(shell.el("shell-menu")).not.toBeNull();
      expect(shell.el("menu-connections")).not.toBeNull();
      expect(shell.el("menu-invite")).not.toBeNull();

      shell.press("menu-connections");
      expect(shell.el("connection-switcher")).not.toBeNull();
      expect(shell.el("shell-menu")).toBeNull();

      shell.press("close-connection-switcher");
      expect(shell.el("fleet-list")).not.toBeNull();

      shell.press("open-menu");
      shell.press("menu-invite");
      expect(shell.el("invite")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("the invite entry is absent when this pairing cannot mint a credential", () => {
    const client = new CannedClient();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <Console
          connection={{ ...CONNECTION, scopes: ["read"] }}
          daemonLabel="Studio Mac"
          connections={CONNECTIONS}
          onAddConnection={() => {}}
          onSelectConnection={() => {}}
          onUnpair={() => {}}
          createClient={() => client as unknown as OmpdClient}
        />,
      );
    });
    const el = (testID: string) => host.querySelector(`[data-testid="${testID}"]`);
    act(() => {
      (el("open-menu") as HTMLElement).click();
    });
    expect(el("menu-connections")).not.toBeNull();
    expect(el("menu-invite")).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("the header names the daemon this device is attached to", () => {
    const shell = mountShell();
    try {
      expect(shell.host.textContent).toContain("Studio Mac");
    } finally {
      shell.unmount();
    }
  });
});
