/**
 * The cutover, asserted rather than assumed.
 *
 * The risk this file exists for is staged dead code: modules that import
 * assistant-ui, tests that mount them, and a production screen that quietly
 * goes on rendering the hand-rolled surface. Every other suite in this package
 * proves the new components work; only this one proves the SCREEN uses them and
 * that the old owned path is gone.
 *
 * Two of these assert an absence, which is the kind of test most likely to be
 * vacuous, so each one is paired with a presence in the same run: the absence of
 * the old surface only means something alongside the presence of the new one.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agent, SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

const { Console } = await import("../src/console/Console.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetWindowSize();
});

const APP = join(import.meta.dir, "..");

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_1",
  scopes: ["read", "prompt", "approve", "manage"],
};
const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [{ id: "local", label: "Studio Mac", connection: CONNECTION }],
};

class CannedClient {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  on(name: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(name, list);
    return () => {};
  }
  start(): void {}
  close(): void {}
  reconnectNow(): void {}
  attach(): void {}
  listSessions(): void {}
  openCollab(): void {}
  leaveCollab(): void {}
  sessionTail(): void {}
  sessionHistory(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  deleteSessions(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  startVoice(): void {}
  stopVoice(): void {}
  sendAudio(): void {}
}

const AGENT: Agent = {
  id: "agt_a",
  name: "Alpha",
  state: "idle",
  acpSessionId: "sess_a",
  host: { kind: "local", id: "42", spec: { kind: "local" } },
  cwd: "/Users/op/dev/src/github.com/op/alpha",
  createdAt: "2026-08-24T11:00:00.000Z",
  lastActiveAt: "2026-08-24T11:59:00.000Z",
  labels: {},
};

function tuiRow(id: string, title: string): SessionSummary {
  return {
    id,
    title,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    cwdScope: "home",
    flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
    status: "live-tui",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActivityAt: "2026-08-24T11:59:00.000Z",
    messageCount: 3,
    byteSize: 2_048,
    archived: false,
    pid: 4_242,
  };
}

interface Shell {
  client: CannedClient;
  host: HTMLElement;
  el: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  emit: (name: string, event: unknown) => void;
  unmount: () => void;
}

function mountShell(): Shell {
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
  });
  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };
  return {
    client,
    host,
    el,
    press: testID => {
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

function openOwned(shell: Shell): void {
  shell.emit("agents", { agents: [AGENT] });
  shell.emit("session_history", { agentId: "agt_a", sessionId: "sess_a", entries: [], nextBefore: null });
  shell.emit("update", {
    agentId: "agt_a",
    seq: 1,
    update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "ship it" }, messageId: "u1" },
  });
}

describe("the owned session really renders assistant-ui, and the old surface is gone", () => {
  test("the screen mounts the provider, the primitive list and the primitive composer", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);

      // The list and the composer are the primitives' own roots.
      expect(shell.el("aui-thread")).not.toBeNull();
      expect(shell.el("aui-messages")).not.toBeNull();
      expect(shell.el("composer-surface")).not.toBeNull();

      // And the row inside it is ours, rendered from the entry the message
      // carried, which is only possible through the external store.
      expect(shell.el("entry-user")?.getAttribute("aria-label")).toBe("you: ship it");

      // The composer's input is the runtime-controlled one: react-native-web
      // renders a multiline TextInput as a textarea.
      expect(shell.el("composer-input")?.tagName.toLowerCase()).toBe("textarea");
    } finally {
      shell.unmount();
    }
  });

  test("no hand-rolled owned transcript remains, anywhere in src", () => {
    // The absence half. Paired with the presence above in the same file so a
    // future change cannot satisfy one and quietly break the other.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
      });

    const sources = walk(join(APP, "src"));
    const offenders = sources.filter(path => {
      const text = readFileSync(path, "utf8");
      // The deleted component and its import specifier. A doc comment naming it
      // is fine; an import or an element is not.
      return /from ["'][^"']*components\/Transcript(\.tsx)?["']/.test(text) || /<Transcript[\s/>]/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  test("the owned screen does not render the terminal's custom composer", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      openOwned(shell);
      // `Composer.tsx` survives for the live-terminal surface, which is a
      // deliberately distinct pane. It must not appear on the owned one: two
      // composers would be the dual path this cutover exists to avoid.
      expect(shell.el("terminal-composer-surface")).toBeNull();
      expect(shell.el("composer-surface")).not.toBeNull();
    } finally {
      shell.unmount();
    }
  });

  test("the terminal surface still renders its own composer, and no assistant-ui thread", () => {
    setWindowSize(1024, 1366);
    const shell = mountShell();
    try {
      shell.emit("sessions", { sessions: [tuiRow("sess_tui", "terminal work")] });
      shell.press("session-open-sess_tui");
      shell.emit("error", {
        code: "collab_unavailable",
        sessionId: "sess_tui",
        message: "this omp build cannot host a collab room",
      });
      shell.emit("session_tail", { sessionId: "sess_tui", messages: [], truncated: false });

      // Documented as a distinct live-terminal surface, not a hidden second
      // implementation of the owned thread: its positional row keys renumber on
      // every append, which assistant-ui's message identity cannot take.
      expect(shell.el("terminal-session")).not.toBeNull();
      expect(shell.el("aui-thread")).toBeNull();
      expect(shell.el("aui-messages")).toBeNull();
    } finally {
      shell.unmount();
    }
  });
});
