import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { OmpdClient } from "@ompd/core/ompd-client";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleActions } from "../src/console/useConsole.ts";
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

describe("item 6: selectedTerminalSession must be cleared at navigation boundaries", () => {
  test("pressing back clears selectedTerminalSession so it is not re-tailed on reconnect", async () => {
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

    let actions!: ConsoleActions;
    function Probe() {
      const conn: Connection = {
        transport: "direct",
        url: "ws://127.0.0.1:7777/v1/socket",
        token: "tok_test",
        scopes: ["read", "prompt"],
      };
      [, actions] = useConsole(conn, () => client);
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(createElement(Probe));
    });

    // Open terminal session and fall back to tail
    const sessionId = "term_abandoned";
    act(() => {
      actions.openSession({ kind: "live-tui", sessionId });
    });
    act(() => {
      mockSocket.deliver({
        t: "error",
        code: "collab_unavailable",
        message: "collab unavailable",
        sessionId,
      });
    });

    // In ompd-client, sessionTail sets selectedTerminalSession
    // @ts-expect-error accessing property to verify
    expect(client.selectedTerminalSession).toBe(sessionId);

    // Operator navigates Back to fleet list
    act(() => {
      actions.back();
    });

    // Pre-fix failure: selectedTerminalSession remains "term_abandoned"!
    // @ts-expect-error accessing property to verify
    expect(client.selectedTerminalSession).toBeNull();

    // Reconnect occurs (hello received)
    mockSocket.sent.length = 0;
    act(() => {
      mockSocket.deliver({ t: "hello", deviceId: "dev_1", agents: [] });
    });

    // Pre-fix failure: client re-issued session_tail for the abandoned terminal session!
    const tails = mockSocket.sent.filter(f => f.t === "session_tail");
    expect(tails).toHaveLength(0);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
