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
import type { Agent, AgentId, SessionSummary } from "@ompd/core/contracts";
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
  scopes: ["read", "prompt", "approve", "manage"],
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
  readonly collabOpens: string[] = [];
  readonly collabLeaves: string[] = [];
  readonly attached: AgentId[] = [];
  readonly resumes: Array<{ sessionId: string; cwd: string }> = [];
  readonly agentPrompts: Array<{ agentId: AgentId; text: string }> = [];
  readonly histories: Array<{ agentId: AgentId; sessionId: string; before?: number }> = [];
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
  attach(agentId: AgentId): void {
    this.attached.push(agentId);
  }
  listSessions(): void {}
  /**
   * Recorded rather than ignored: opening a live row asks the daemon to join
   * it, so a double that lacked this method turned a navigation test into a
   * TypeError about the client instead of a failure about the stack.
   */
  openCollab(sessionId: string): void {
    this.collabOpens.push(sessionId);
  }
  leaveCollab(sessionId: string): void {
    this.collabLeaves.push(sessionId);
  }
  sessionHistory(agentId: AgentId, sessionId: string, before?: number): void {
    this.histories.push({ agentId, sessionId, ...(before === undefined ? {} : { before }) });
  }
  resumeSession(sessionId: string, cwd: string): void {
    this.resumes.push({ sessionId, cwd });
  }
  prompt(agentId: AgentId, text: string): void {
    this.agentPrompts.push({ agentId, text });
  }
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

/**
 * The roster row a daemon's collab guest presents: an ordinary agent whose
 * held session is the terminal this device asked to co-drive.
 */
function guestAgent(id: AgentId, sessionId: string): Agent {
  return {
    id,
    name: `guest ${id}`,
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-28T00:00:00.000Z",
    labels: {},
    acpSessionId: sessionId,
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

function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
  (input as HTMLInputElement).value = value;
  props.onChange({
    target: input,
    currentTarget: input,
    nativeEvent: { text: value },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
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

  test("opening a live row joins it, and the session route's back returns to the list", () => {
    const shell = mountShell();
    try {
      shell.press("session-open-sess_live");
      // The join is on the wire and nothing is pushed yet: the screen that
      // renders a co-driven terminal is an agent's, and its agent exists
      // only once the daemon's answer names one.
      expect(shell.client.collabOpens).toEqual(["sess_live"]);
      expect(shell.el("session")).toBeNull();

      act(() => {
        shell.client.emit("agents", { agents: [guestAgent("agt_guest", "sess_live")] });
        shell.client.emit("collab_opened", { sessionId: "sess_live", agentId: "agt_guest", readOnly: false });
      });
      expect(shell.el("session")).not.toBeNull();

      shell.press("session-back");
      expect(shell.el("session")).toBeNull();
      expect(shell.el("fleet-list")).not.toBeNull();
      // Leaving the co-driven session tells the daemon to leave the room,
      // so the guest does not outlive the screen that asked for it.
      expect(shell.client.collabLeaves).toEqual(["sess_live"]);
    } finally {
      shell.unmount();
    }
  });

  test("leaving the session route clears the console's own selection, so it does not bounce back", () => {
    const shell = mountShell();
    try {
      shell.press("session-open-sess_live");
      act(() => {
        shell.client.emit("agents", { agents: [guestAgent("agt_guest", "sess_live")] });
        shell.client.emit("collab_opened", { sessionId: "sess_live", agentId: "agt_guest", readOnly: false });
      });
      shell.press("session-back");
      // The model, not just the stack: a selection left set would be re-pushed
      // by the sync effect on the very next render, which is the shape of bug a
      // two-way sync produces when only one direction is wired.
      expect(shell.el("session")).toBeNull();

      // A second open still works, which a stale selection would have blocked
      // (the effect would see no change and never push).
      shell.press("session-open-sess_live");
      act(() => {
        shell.client.emit("collab_opened", { sessionId: "sess_live", agentId: "agt_guest", readOnly: false });
      });
      expect(shell.el("session")).not.toBeNull();
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

  test("the session route draws its own bar, so it takes the top inset itself", () => {
    setSafeAreaInsets(NOTCH);
    const shell = mountShell();
    try {
      shell.press("session-open-sess_live");
      act(() => {
        shell.client.emit("agents", { agents: [guestAgent("agt_guest", "sess_live")] });
        shell.client.emit("collab_opened", { sessionId: "sess_live", agentId: "agt_guest", readOnly: false });
      });
      const session = shell.el("session");
      expect(padding(session).top).toBe(`${NOTCH.top}px`);
      // Its composer carries the bottom inset instead of the shell, so the send
      // button clears the home indicator without the screen padding twice.
      expect(padding(session).bottom).toBe("0px");
      const composer = shell.el("session-composer-safe");
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

  test("a subagent row opens its complete transcript surface", () => {
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
              cwd: "/workspace",
              createdAt: "2026-02-01T00:00:00.000Z",
              lastActiveAt: "2026-02-01T00:00:00.000Z",
              labels: {},
            },
            {
              id: "agt_scout" as AgentId,
              name: "Policy Scout",
              state: "idle",
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              cwd: "/workspace",
              createdAt: "2026-02-01T00:01:00.000Z",
              lastActiveAt: "2026-02-01T00:01:00.000Z",
              parentAgentId: "agt_main" as AgentId,
              acpSessionId: "sub-session",
              labels: {},
            },
          ],
        });
      });

      shell.press("agent-hub-open-agt_scout");
      expect(shell.client.attached).toContain("agt_scout");
      expect(shell.el("session-name")?.textContent).toBe("Policy Scout");

      act(() => {
        shell.client.emit("update", {
          t: "update",
          agentId: "agt_scout",
          seq: 1,
          update: {
            sessionUpdate: "agent_thought_chunk",
            messageId: "m1",
            content: { type: "text", text: "Inspecting authorization." },
          },
        });
        shell.client.emit("update", {
          t: "update",
          agentId: "agt_scout",
          seq: 2,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc1",
            title: "Read policy",
            kind: "read",
            status: "completed",
            rawInput: { path: "policy.ts" },
            rawOutput: { content: [{ type: "text", text: "policy body" }] },
          },
        });
        shell.client.emit("update", {
          t: "update",
          agentId: "agt_scout",
          seq: 3,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m1",
            content: { type: "text", text: "Authorization is correct." },
          },
        });
      });

      const assistantLabels = [...shell.host.querySelectorAll('[data-testid="entry-assistant"]')].map(row =>
        row.getAttribute("aria-label"),
      );
      expect(assistantLabels).toContain("thinking: Inspecting authorization.");
      expect(assistantLabels).toContain("agent: Authorization is correct.");
      expect(shell.el("tool-title-tc1")?.textContent).toBe("Read policy");
      expect(shell.el("tool-output-tc1")?.textContent).toContain("policy body");

      const composer = shell.el("composer-input");
      if (composer === null) throw new Error("subagent composer did not render");
      act(() => typeInto(composer, "Continue the subagent."));
      shell.press("composer-send");
      expect(shell.client.agentPrompts).toEqual([{ agentId: "agt_scout", text: "Continue the subagent." }]);
    } finally {
      shell.unmount();
    }
  });

  test("a stopped subagent keeps its transcript and can resume the same session", () => {
    const shell = mountShell([summary("sub-session-done", { status: "dormant", cwd: "/canonical" })]);
    try {
      act(() => {
        shell.client.emit("agents", {
          t: "agents",
          agents: [
            {
              id: "agt_main" as AgentId,
              name: "Primary",
              state: "idle",
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              cwd: "/workspace",
              createdAt: "2026-02-01T00:00:00.000Z",
              lastActiveAt: "2026-02-01T00:00:00.000Z",
              labels: {},
            },
            {
              id: "agt_done" as AgentId,
              name: "Finished Scout",
              state: "stopped",
              host: { kind: "local", id: "dead", spec: { kind: "local" } },
              cwd: "/workspace",
              createdAt: "2026-02-01T00:01:00.000Z",
              lastActiveAt: "2026-02-01T00:02:00.000Z",
              parentAgentId: "agt_main" as AgentId,
              acpSessionId: "sub-session-done",
              labels: {},
            },
          ],
        });
        shell.client.emit("update", {
          t: "update",
          agentId: "agt_done",
          seq: 1,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "done-message",
            content: { type: "text", text: "Durable finding." },
          },
        });
      });

      shell.press("agent-hub-open-agt_done");
      expect(shell.el("session-name")?.textContent).toBe("Finished Scout");
      expect(shell.el("entry-assistant")?.getAttribute("aria-label")).toBe("agent: Durable finding.");
      expect(shell.el("composer-input")).toBeNull();
      shell.press("session-resume");
      expect(shell.client.resumes).toEqual([{ sessionId: "sub-session-done", cwd: "/canonical" }]);
    } finally {
      shell.unmount();
    }
  });

  test("Load earlier requests the daemon's opaque history cursor", () => {
    const shell = mountShell();
    try {
      act(() => {
        shell.client.emit("agents", {
          t: "agents",
          agents: [
            {
              id: "agt_root" as AgentId,
              name: "Root",
              state: "idle",
              acpSessionId: "sess-root",
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              cwd: "/workspace",
              createdAt: "2026-02-01T00:00:00.000Z",
              lastActiveAt: "2026-02-01T00:00:00.000Z",
              labels: {},
            },
            {
              id: "agt_history" as AgentId,
              name: "History Scout",
              state: "idle",
              acpSessionId: "sess-history",
              parentAgentId: "agt_root" as AgentId,
              host: { kind: "local", id: "1", spec: { kind: "local" } },
              cwd: "/workspace",
              createdAt: "2026-02-01T00:01:00.000Z",
              lastActiveAt: "2026-02-01T00:01:00.000Z",
              labels: {},
            },
          ],
        });
      });
      shell.press("agent-hub-open-agt_history");
      expect(shell.client.histories).toEqual([{ agentId: "agt_history", sessionId: "sess-history" }]);

      act(() => {
        shell.client.emit("session_history", {
          agentId: "agt_history",
          sessionId: "sess-history",
          entries: [{ kind: "assistant", id: "old", text: "Older.", thought: false, at: "" }],
          nextBefore: 4242,
        });
      });
      expect(shell.el("entry-assistant")?.getAttribute("aria-label")).toBe("agent: Older.");
      shell.press("history-load-earlier");
      expect(shell.client.histories).toEqual([
        { agentId: "agt_history", sessionId: "sess-history" },
        { agentId: "agt_history", sessionId: "sess-history", before: 4242 },
      ]);
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

  test("the daemon's hello answer, not the stored hint, decides the invite entry", () => {
    const mount = (
      connection: Connection,
    ): { client: CannedClient; el: (testID: string) => HTMLElement | null; unmount: () => void } => {
      const client = new CannedClient();
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      act(() => {
        root.render(
          <Console
            connection={connection}
            daemonLabel="Studio Mac"
            connections={CONNECTIONS}
            onAddConnection={() => {}}
            onSelectConnection={() => {}}
            onUnpair={() => {}}
            createClient={() => client as unknown as OmpdClient}
          />,
        );
      });
      return {
        client,
        el: (testID: string) => host.querySelector(`[data-testid="${testID}"]`),
        unmount: () => {
          act(() => {
            root.unmount();
          });
          host.remove();
        },
      };
    };

    // A narrowed grant: the stored connection still claims approve, and the
    // menu must believe the daemon instead.
    const narrowed = mount(CONNECTION);
    act(() => {
      narrowed.client.emit("agents", { agents: [], deviceId: "dev_phone", scopes: ["read", "prompt"] });
    });
    act(() => {
      (narrowed.el("open-menu") as HTMLElement).click();
    });
    expect(narrowed.el("menu-connections")).not.toBeNull();
    expect(narrowed.el("menu-invite")).toBeNull();
    narrowed.unmount();

    // A widened grant: the stored connection claims nothing, and the hello
    // that reports approve surfaces the entry.
    const widened = mount({ ...CONNECTION, scopes: ["read"] });
    act(() => {
      widened.client.emit("agents", { agents: [], deviceId: "dev_phone", scopes: ["read", "approve", "manage"] });
    });
    act(() => {
      (widened.el("open-menu") as HTMLElement).click();
    });
    expect(widened.el("menu-invite")).not.toBeNull();
    widened.unmount();
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
