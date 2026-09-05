import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { OmpdClient } from "@ompd/core/ompd-client";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleState } from "../src/console/state.ts";
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

describe("item 5: terminal retry button must rearm load and repeat open instead of no-op", () => {
  test("retryTui rearms failed terminal load and re-requests tail", async () => {
    // Dynamic import on purpose: bun evaluates static imports before ./rnw.ts can substitute react-native-web
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

    // Simulate selecting live-tui session
    const sessionId = "term_session_1";
    act(() => {
      actions.openSession({ kind: "live-tui", sessionId });
    });

    // Simulate collab_unavailable -> falls back to steer / tail
    act(() => {
      mockSocket.deliver({
        t: "error",
        code: "collab_unavailable",
        message: "collab unavailable",
        sessionId,
      });
    });

    // Now tail fails or times out to "failed"
    act(() => {
      mockSocket.deliver({
        t: "error",
        code: "tail_failed",
        message: "tail failed",
        sessionId,
      });
    });

    expect(state.loads.get(sessionId)?.phase).toBe("failed");
    expect(state.selectedTui).toBe(sessionId);

    mockSocket.sent.length = 0;

    // In pre-fix code, onLoadEarlier called loadEarlierTui which does nothing when historyCursor === null
    // Now call retryTui (or simulate Retry)
    act(() => {
      actions.retryTui(sessionId);
    });

    // Pre-fix failure: phase is still "failed" and sentFrames is empty!
    expect(state.loads.get(sessionId)?.phase).toBe("loading");
    expect(mockSocket.sent.some(f => f.t === "session_tail" || f.t === "collab_open")).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
