import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { OmpdClient } from "@ompd/core/ompd-client";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleState } from "../src/console/state.ts";
import type { Connection } from "../src/platform/connection.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class MockSocket {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  sent: ClientFrame[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("item 10: daemon error carrying both agentId and sessionId must prioritize agentId", () => {
  test("error with both agentId and sessionId clears agent load deadline and sets phase to failed", async () => {
    const { useConsole } = await import("../src/console/useConsole.ts");

    let mockSocket!: MockSocket;
    const client = new OmpdClient({
      url: "ws://127.0.0.1:7777/v1/socket",
      token: "tok_test",
      isOnline: () => true,
      createSocket: () => {
        mockSocket = new MockSocket();
        queueMicrotask(() => {
          mockSocket.deliver({ t: "hello", deviceId: "dev_1", agents: [] });
        });
        return mockSocket;
      },
    });

    let state!: ConsoleState;
    function Probe() {
      const conn: Connection = {
        transport: "direct",
        url: "ws://127.0.0.1:7777/v1/socket",
        token: "tok_test",
        scopes: ["read", "prompt"],
      };
      [state] = useConsole(conn, () => client);
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(Probe));
    });

    const agentId = "agt_unrostered";
    const sessionId = "sess_target";

    // 1. Session is opened (e.g. from route or dormant resume)
    act(() => {
      mockSocket.deliver({
        t: "session_opened",
        agentId,
        sessionId,
      });
    });

    expect(state.loads.get(agentId)?.phase).toBe("loading");

    // 2. Daemon sends error frame with BOTH agentId and sessionId before any roster frame arrives
    act(() => {
      mockSocket.deliver({
        t: "error",
        code: "history_failed",
        message: "Failed to read session file",
        agentId,
        sessionId,
      });
    });

    // Pre-fix failure: state.loads.get(agentId)?.phase is still "loading" because error routed to sessionId!
    expect(state.loads.get(agentId)?.phase).toBe("failed");
    expect(state.loads.get(agentId)?.error).toBe("Failed to read session file");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
