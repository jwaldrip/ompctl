import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent, ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketLike } from "@ompd/core/ompd-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleState } from "../src/console/state.ts";
import { type ConsoleActions, useConsole } from "../src/console/useConsole.ts";
import type { Connection } from "../src/platform/connection.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  onopen: (() => void) | null = null;
  onclose: ((info: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((msg: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("defect 6: subject-bearing error routing", () => {
  test("error carrying sessionId for the pane being opened fails that load", () => {
    const sockets: FakeSocket[] = [];
    const client = new OmpdClient({
      url: "ws://127.0.0.1:7777/v1/socket",
      token: "tok_test",
      isOnline: () => true,
      createSocket: url => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s as unknown as SocketLike;
      },
    });

    let state!: ConsoleState;
    let actions!: ConsoleActions;
    function Probe() {
      const conn: Connection = {
        transport: "direct",
        url: "ws://127.0.0.1:7777/v1/socket",
        token: "tok_test",
        scopes: ["read", "prompt"],
      };
      [state, actions] = useConsole(conn, () => client);
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(Probe));
    });

    const sock1 = sockets[0];
    if (!sock1) throw new Error("sock1 missing");
    const agents: Agent[] = [
      {
        id: "a1",
        name: "Agent 1",
        state: "idle",
        acpSessionId: "sess_1",
        host: { kind: "local", id: "0", spec: { kind: "local" } },
        cwd: "",
        createdAt: "",
        lastActiveAt: "",
        labels: {},
      },
    ];
    act(() => {
      sock1.accept();
      sock1.deliver({ t: "hello", deviceId: "dev_1", agents });
    });

    // Open pane for a1
    act(() => {
      actions.select("a1");
    });
    expect(state.loads.get("a1")?.phase).toBe("loading");

    // Daemon emits error with sessionId
    act(() => {
      sock1.deliver({
        t: "error",
        sessionId: "sess_1",
        message: "Failed to resume session.",
      });
    });

    expect(state.loads.get("a1")?.phase).toBe("failed");
    expect(state.loads.get("a1")?.error).toBe("Failed to resume session.");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("agent_busy error becomes a notice and does not fail the load", () => {
    const sockets: FakeSocket[] = [];
    const client = new OmpdClient({
      url: "ws://127.0.0.1:7777/v1/socket",
      token: "tok_test",
      isOnline: () => true,
      createSocket: url => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s as unknown as SocketLike;
      },
    });

    let state!: ConsoleState;
    let actions!: ConsoleActions;
    function Probe() {
      const conn: Connection = {
        transport: "direct",
        url: "ws://127.0.0.1:7777/v1/socket",
        token: "tok_test",
        scopes: ["read", "prompt"],
      };
      [state, actions] = useConsole(conn, () => client);
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(Probe));
    });

    const sock1 = sockets[0];
    if (!sock1) throw new Error("sock1 missing");
    const agents: Agent[] = [
      {
        id: "a1",
        name: "Agent 1",
        state: "busy",
        acpSessionId: "sess_1",
        host: { kind: "local", id: "0", spec: { kind: "local" } },
        cwd: "",
        createdAt: "",
        lastActiveAt: "",
        labels: {},
      },
    ];
    act(() => {
      sock1.accept();
      sock1.deliver({ t: "hello", deviceId: "dev_1", agents });
    });

    act(() => {
      actions.select("a1");
    });

    // Daemon returns agent_busy error
    act(() => {
      sock1.deliver({
        t: "error",
        agentId: "a1",
        code: "agent_busy",
        message: "Agent is busy with an in-flight turn",
      });
    });

    // It surfaces as a notice
    expect(state.notice).toBe("Agent is busy with an in-flight turn");
    // And does NOT fail the load
    expect(state.loads.get("a1")?.phase).not.toBe("failed");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
