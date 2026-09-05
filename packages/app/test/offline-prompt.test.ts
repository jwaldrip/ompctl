import "./rnw.ts";

import { describe, expect, test } from "bun:test";
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

describe("defect 4: offline prompt", () => {
  test("actions.prompt while connection !== 'connected' dispatches no prompt entry and raises notice", () => {
    const client = new OmpdClient({
      url: "ws://127.0.0.1:7777/v1/socket",
      token: "tok_test",
      isOnline: () => false,
      createSocket: () => {
        return {
          readyState: 0,
          send() {},
          close() {},
        } as unknown as SocketLike;
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

    expect(state.connection).not.toBe("connected");

    // Send prompt while offline
    act(() => {
      actions.prompt("a1", "offline message");
    });

    // Pre-fix failure: state.sessions.get("a1") contains prompt entry!
    const entries = state.sessions.get("a1")?.entries ?? [];
    expect(entries.filter(e => e.kind === "user")).toHaveLength(0);

    // Pre-fix failure: notice is null instead of "Not connected; the message was not sent"
    expect(state.notice).toBe("Not connected; the message was not sent");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
