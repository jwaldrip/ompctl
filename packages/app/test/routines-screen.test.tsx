import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame, RemoteRoutine, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

const { RoutinesScreen } = await import("../src/screens/RoutinesScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MANAGER: Connection = {
  transport: "hub",
  hubUrl: "wss://hub.ompctl.ai/relay",
  daemonId: "dae_0123456789abcdef",
  token: "tok_owner",
  scopes: ["read", "manage", "prompt"],
};
const WATCHER: Connection = { ...MANAGER, token: "tok_watch", scopes: ["read"] };

const ROUTINE: RemoteRoutine = {
  id: "rtn_calls",
  name: "Incoming call",
  enabled: true,
  trigger: { kind: "webhook", secretRef: "whsec_calls" },
  actions: [
    { id: "text-back", name: "Text back", prompt: "send text", cwd: "/work", labels: {} },
    { id: "webhook", name: "Webhook", prompt: "call webhook", cwd: "/work", labels: {} },
  ],
  singleton: false,
  labels: {},
  createdAt: "2026-08-19T00:00:00.000Z",
};

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  closedWith: SocketCloseInfo | null = null;
  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
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

  framesOfType(t: ClientFrame["t"]): ClientFrame[] {
    return this.sent.filter(frame => frame.t === t);
  }
}

function cannedClient(): { client: OmpdClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  return {
    socket,
    client: new OmpdClient({
      url: "wss://hub.ompctl.ai/relay",
      token: "tok_owner",
      createSocket: () => socket,
      schedule: () => () => {},
      isOnline: () => true,
      probeCredential: () => Promise.resolve("unknown"),
    }),
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

function el(host: HTMLElement, testID: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testID}"]`);
}

async function mounted(connection: Connection) {
  const { client, socket } = cannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<RoutinesScreen connection={connection} onBack={() => {}} createClient={() => client} />);
  });
  act(() => {
    socket.accept();
    socket.deliver({ t: "hello", deviceId: "dev_phone", agents: [], scopes: connection.scopes });
  });
  await settle();
  return { socket, host, root };
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function forbidFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error("RoutinesScreen must not make HTTP requests");
  }) as unknown as typeof fetch;
}

describe("RoutinesScreen", () => {
  test("reads through the socket and renders each action outcome independently", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    expect(socket.framesOfType("routines_read")).toEqual([{ t: "routines_read" }]);

    act(() => {
      socket.deliver({
        t: "routines",
        routines: [ROUTINE],
        runs: [
          {
            id: "run_1",
            routineId: ROUTINE.id,
            state: "failed",
            startedAt: "2026-08-19T00:00:00.000Z",
            finishedAt: "2026-08-19T00:00:02.000Z",
            actions: [
              {
                actionId: "text-back",
                actionName: "Text back",
                index: 0,
                state: "failed",
                error: "text provider refused",
                startedAt: "2026-08-19T00:00:00.000Z",
                finishedAt: "2026-08-19T00:00:01.000Z",
              },
              {
                actionId: "webhook",
                actionName: "Webhook",
                index: 1,
                state: "succeeded",
                summary: "delivered",
                startedAt: "2026-08-19T00:00:01.000Z",
                finishedAt: "2026-08-19T00:00:02.000Z",
              },
            ],
          },
        ],
      });
    });
    await settle();

    expect(el(host, "routine-rtn_calls-action-text-back")?.textContent).toContain("text provider refused");
    expect(el(host, "routine-rtn_calls-action-webhook")?.textContent).toContain("succeeded");

    act(() => root.unmount());
    host.remove();
  });

  test("adds another ordered action and saves the complete routine through one frame", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    act(() => el(host, "routine-rtn_calls-edit")?.click());
    await settle();
    act(() => el(host, "routine-add-action")?.click());
    await settle();
    act(() => el(host, "routine-save")?.click());
    await settle();

    const writes = socket.framesOfType("routine_write");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (write?.t !== "routine_write") throw new Error("expected routine_write");
    expect(write.routine.actions.map(action => action.id).slice(0, 2)).toEqual(["text-back", "webhook"]);
    expect(write.routine.actions).toHaveLength(3);

    act(() => root.unmount());
    host.remove();
  });

  test("a read-only pairing keeps controls visible and names the missing scope", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(WATCHER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    expect(el(host, "routines-readonly-notice")?.textContent).toContain("manage");
    expect(el(host, "routines-new")).not.toBeNull();
    expect(el(host, "routine-rtn_calls-edit")).not.toBeNull();
    act(() => {
      el(host, "routines-new")?.click();
      el(host, "routine-rtn_calls-edit")?.click();
      el(host, "routine-rtn_calls-run")?.click();
    });
    await settle();
    expect(socket.framesOfType("routine_write")).toEqual([]);
    expect(socket.framesOfType("routine_run")).toEqual([]);

    act(() => root.unmount());
    host.remove();
  });
});
