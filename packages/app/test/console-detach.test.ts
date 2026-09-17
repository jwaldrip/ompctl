import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent, ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketLike } from "@ompd/core/ompd-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConsoleActions } from "../src/console/useConsole.ts";

// Dynamic import on purpose: bun evaluates static imports before ./rnw.ts can substitute react-native-web
const { useConsole } = await import("../src/console/useConsole.ts");

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

  drop(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "drop" });
  }

  framesOfType<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    return this.sent.filter((f): f is Extract<ClientFrame, { t: T }> => f.t === t);
  }
}

describe("defect 2: detach on switch", () => {
  test("switching A -> B sends detach A; reconnect after that sends attach B only", () => {
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

    const sock1 = sockets[0];
    if (!sock1) throw new Error("sock1 missing");
    const agents: Agent[] = [
      {
        id: "a1",
        name: "Agent 1",
        state: "idle",
        host: { kind: "local", id: "0", spec: { kind: "local" } },
        cwd: "",
        createdAt: "",
        lastActiveAt: "",
        labels: {},
      },
      {
        id: "a2",
        name: "Agent 2",
        state: "idle",
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
    // Select Agent A
    act(() => {
      actions.select("a1");
    });
    expect(sock1.framesOfType("attach")).toEqual([{ t: "attach", agentId: "a1", sinceSeq: 0 }]);

    // Switch Agent A -> B
    act(() => {
      actions.select("a2");
    });
    // Pre-fix: detach A is never sent!
    const detaches = sock1.framesOfType("detach");
    expect(detaches).toEqual([{ t: "detach", agentId: "a1" }]);

    // Drop and reconnect
    act(() => {
      sock1.drop();
      client.reconnectNow();
      const sock2 = sockets[1];
      if (!sock2) throw new Error("sock2 missing");
      sock2.accept();
      sock2.deliver({ t: "hello", deviceId: "dev_1", agents });
    });
    const sock2 = sockets[1];
    if (!sock2) throw new Error("sock2 missing");
    const attaches2 = sock2.framesOfType("attach");
    expect(attaches2.map(f => f.agentId)).toEqual(["a2"]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

describe("decide preserves scope", () => {
  test("deciding with scope always sends scope on wire and dispatches scope", () => {
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

    let actions!: ConsoleActions;
    function Probe() {
      const conn: Connection = {
        transport: "direct",
        url: "ws://127.0.0.1:7777/v1/socket",
        token: "tok_test",
        scopes: ["read", "prompt", "approve"],
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

    const sock = sockets[0];
    if (!sock) throw new Error("sock missing");
    act(() => {
      sock.accept();
      sock.deliver({
        t: "hello",
        deviceId: "dev_1",
        agents: [
          {
            id: "a1",
            name: "Agent 1",
            state: "waiting",
            host: { kind: "local", id: "0", spec: { kind: "local" } },
            cwd: "",
            createdAt: "",
            lastActiveAt: "",
            labels: {},
          },
        ],
      });
      sock.deliver({
        t: "approval",
        agentId: "a1",
        requestId: "r_always",
        tool: "shell",
        title: "npm install",
        input: {},
        deadlineAt: "2026-01-01T00:02:00.000Z",
      });
    });

    act(() => {
      actions.decide("a1", "r_always", "allow", "always");
    });

    const frames = sock.framesOfType("decide");
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual({
      t: "decide",
      agentId: "a1",
      requestId: "r_always",
      choice: "allow",
      scope: "always",
    });

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
