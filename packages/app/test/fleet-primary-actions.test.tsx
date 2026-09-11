/**
 * FleetScreen primary actions: starting sessions and archiving ephemeral rows.
 *
 * Covers:
 * 1. Starting a session is a primary action on FleetScreen, gated on manage scope.
 * 2. When manage scope is missing, the control remains visible but disabled with an explanation.
 * 3. Choosing a project triggers createAgent with that project's working directory.
 * 4. Ephemeral review highlights short dormant sessions and archives only on confirm.
 * 5. Per-row archive arms an inline confirmation before sending an archive command.
 * 6. Archived sessions leave the default listing and are reachable under the archive filter.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetSafeAreaInsets } from "./rnw.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Dynamic import is required here because rnw.ts mocks react-native before Console is loaded.
const { Console } = await import("../src/console/Console.tsx");

afterEach(resetSafeAreaInsets);

const SESSION_ALPHA_1: SessionSummary = {
  id: "session-alpha-1",
  title: "Feature alpha main",
  cwd: "/Users/op/dev/src/github.com/op/alpha",
  cwdScope: "home",
  flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
  status: "dormant",
  createdAt: "2026-02-01T00:00:00.000Z",
  lastActivityAt: "2026-02-28T00:00:00.000Z",
  messageCount: 15,
  byteSize: 8192,
  archived: false,
};

const SESSION_ALPHA_SHORT: SessionSummary = {
  id: "session-alpha-short",
  title: "Spike alpha test",
  cwd: "/Users/op/dev/src/github.com/op/alpha",
  cwdScope: "home",
  flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
  status: "dormant",
  createdAt: "2026-02-05T00:00:00.000Z",
  lastActivityAt: "2026-02-06T00:00:00.000Z",
  messageCount: 1, // ephemeral candidate (< 3 msgs)
  byteSize: 512,
  archived: false,
};

const SESSION_BETA_SHORT: SessionSummary = {
  id: "session-beta-short",
  title: "Test beta spike",
  cwd: "/Users/op/dev/src/github.com/op/beta",
  cwdScope: "home",
  flattenedDir: "-Users-op-dev-src-github-com-op-beta",
  status: "dormant",
  createdAt: "2026-02-10T00:00:00.000Z",
  lastActivityAt: "2026-02-10T00:00:00.000Z",
  messageCount: 0, // ephemeral candidate (< 3 msgs)
  byteSize: 256,
  archived: false,
};

const TEST_SESSIONS: SessionSummary[] = [SESSION_ALPHA_1, SESSION_ALPHA_SHORT, SESSION_BETA_SHORT];
const STALE_TERMINAL_AGENTS: Agent[] = [
  {
    id: "agt_stopped",
    name: "stopped without session file",
    state: "stopped",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/Users/op/dev/src/github.com/op/stale",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    labels: {},
    acpSessionId: "session-missing-stopped",
  },
  {
    id: "agt_failed",
    name: "failed without session file",
    state: "failed",
    host: { kind: "local", id: "2", spec: { kind: "local" } },
    cwd: "/Users/op/dev/src/github.com/op/stale",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    labels: {},
    acpSessionId: "session-missing-failed",
  },
];

class CannedClient {
  readonly createdAgents: Array<{ name: string; cwd: string }> = [];
  readonly archived: Array<{ sessionIds: string[]; unarchive?: boolean }> = [];
  readonly deleted: string[][] = [];
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
  sessionHistory(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  sessionStats(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  deleteSessions(sessionIds: readonly string[]): void {
    this.deleted.push([...sessionIds]);
  }
  createAgent(req: { name: string; cwd: string }): void {
    this.createdAgents.push(req);
  }
  archiveSessions(sessionIds: readonly string[], unarchive?: boolean): void {
    this.archived.push({ sessionIds: [...sessionIds], unarchive });
  }
}

interface Bay {
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  require: (testID: string) => HTMLElement;
  press: (testID: string) => void;
  text: () => string;
  frame: (name: string, event: unknown) => void;
  unmount: () => void;
}

function mountBay(scopes: string[], sessions: SessionSummary[] = TEST_SESSIONS): Bay {
  const connection: Connection = {
    transport: "direct",
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_1",
    scopes,
  };
  const connections: ConnectionList = {
    activeId: "local",
    connections: [{ id: "local", label: "Studio Mac", connection }],
  };
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <Console
        connection={connection}
        daemonLabel="Studio Mac"
        connections={connections}
        onAddConnection={() => {}}
        onSelectConnection={() => {}}
        onUnpair={() => {}}
        createClient={() => client as unknown as OmpdClient}
      />,
    );
  });

  act(() => {
    client.emit("status", { state: "connected", attempt: 0 });
    client.emit("sessions", { sessions });
  });

  const el = (testID: string): HTMLElement | null => {
    const found = document.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  return {
    client,
    el,
    require: testID => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      return target;
    },
    press: testID => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    text: () => host.textContent ?? "",
    frame: (name, event) => {
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

function readsDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true") return true;
  return Reflect.get(el, "disabled") === true;
}

describe("new session primary affordance", () => {
  test("new-session control appears with manage scope and is enabled", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      const control = bay.require("sessions-new");
      expect(control).not.toBeNull();
      expect(readsDisabled(control)).toBe(false);
      expect(control.textContent).toContain("New session");
    } finally {
      bay.unmount();
    }
  });

  test("new-session control appears without manage scope and is disabled with reason", () => {
    const bay = mountBay(["read", "prompt"]);
    try {
      const control = bay.require("sessions-new");
      expect(control).not.toBeNull();
      expect(readsDisabled(control)).toBe(true);
      expect(control.getAttribute("aria-label")).toContain("manage scope");
    } finally {
      bay.unmount();
    }
  });

  test("choosing a project calls createAgent with that cwd", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press("sessions-new");
      // Project picker modal is open with project choices
      const alphaItem = bay.require("project-picker-item-alpha");
      expect(alphaItem).not.toBeNull();
      bay.press("project-picker-item-alpha");

      expect(bay.client.createdAgents.length).toBe(1);
      expect(bay.client.createdAgents[0]?.cwd).toBe("/Users/op/dev/src/github.com/op/alpha");
    } finally {
      bay.unmount();
    }
  });
});

describe("ephemeral review and bulk archive", () => {
  test("cleanup excludes terminal roster rows that have no session file", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.frame("agents", { agents: STALE_TERMINAL_AGENTS });
      // Only the 2 indexed short sessions are cleanup candidates.
      const banner = bay.require("ephemeral-suggest-banner");
      expect(banner.textContent).toContain("2 short sessions");

      // Open review
      bay.press("ephemeral-review-trigger");
      expect(bay.el("ephemeral-review-sheet")).not.toBeNull();
      expect(bay.require("ephemeral-selected-count").textContent).toContain("2 of 2 selected");

      // Tapping archive action shows confirmation prompt
      bay.press("ephemeral-archive-action");
      expect(bay.client.archived.length).toBe(0); // Nothing archived yet!
      const confirmDialog = bay.require("ephemeral-confirm-dialog");
      expect(confirmDialog.textContent).toContain("Archive 2 sessions");
      expect(confirmDialog.textContent).toContain("leave the default list");

      // Confirming executes the bulk archive
      bay.press("ephemeral-confirm-yes");
      expect(bay.client.archived.length).toBe(1);
      expect(bay.client.archived[0]?.sessionIds.sort()).toEqual(["session-alpha-short", "session-beta-short"].sort());
      expect(bay.client.archived[0]?.unarchive).toBe(false);
    } finally {
      bay.unmount();
    }
  });
});

describe("per-row archive and reaching archived sessions", () => {
  test("a per-row archive arms confirmation before archiving", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press("session-more-session-alpha-1");
      expect(bay.el("session-archive-session-alpha-1")).not.toBeNull();

      // First tap arms confirmation band
      bay.press("session-archive-session-alpha-1");
      expect(bay.client.archived.length).toBe(0);
      const prompt = bay.require("session-archive-prompt-session-alpha-1");
      expect(prompt.textContent).toContain("Archive 1 session");
      expect(prompt.textContent).toContain("leaves the default list");

      // Second tap confirms
      bay.press("session-archive-confirm-session-alpha-1");
      expect(bay.client.archived.length).toBe(1);
      expect(bay.client.archived[0]?.sessionIds).toEqual(["session-alpha-1"]);
    } finally {
      bay.unmount();
    }
  });

  test("archived rows leave default list and are reachable under archive filter", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      // Archive session-alpha-1 per-row
      bay.press("session-more-session-alpha-1");
      bay.press("session-archive-session-alpha-1");
      bay.press("session-archive-confirm-session-alpha-1");

      // In default list, archived row is excluded
      expect(bay.el("session-row-session-alpha-1")).toBeNull();

      // Archived toggle indicates hidden archived count
      const toggle = bay.require("archived-toggle");
      expect(toggle).not.toBeNull();

      // Toggle to show archived sessions
      bay.press("archived-toggle");
      expect(bay.el("session-row-session-alpha-1")).not.toBeNull();
      expect(bay.require("session-status-session-alpha-1").textContent).toContain("Archived");

      // Opening more menu on archived session offers Restore
      bay.press("session-more-session-alpha-1");
      expect(bay.el("session-unarchive-session-alpha-1")).not.toBeNull();
    } finally {
      bay.unmount();
    }
  });
});
