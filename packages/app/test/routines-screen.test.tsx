import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame, RemoteRoutine, ServerFrame } from "@ompd/core/contracts";
import { ROUTINE_DELETE_REFUSAL_REASONS, webhookPath } from "@ompd/core/contracts";
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

/**
 * Type into a rendered `TextInput` by invoking the change handler React
 * actually attached to it, the same way every other app suite does: setting
 * `.value` and dispatching an input event never reaches React under
 * happy-dom, so a gate tested that way can only ever see the empty string and
 * cannot fail.
 */
function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input: the change path cannot be driven");
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

/** `aria-disabled` and a native `disabled` are both legitimate ways a control says it is off. */
function readsDisabled(node: Element): boolean {
  if (node.getAttribute("aria-disabled") === "true") return true;
  return Reflect.get(node, "disabled") === true;
}

function field(host: HTMLElement, testID: string): HTMLElement {
  const node = el(host, testID);
  if (node === null) throw new Error(`no element rendered for ${testID}`);
  return node;
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
    // A fresh action arrives with no working directory, and the save gate
    // refuses one: the cwd has to be filled before the routine can be written.
    act(() => {
      typeInto(field(host, "routine-action-2-cwd"), "/work");
    });
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

  test("creates a cron routine, previewing its next fire before it is saved", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => el(host, "routines-new")?.click());
    await settle();

    expect(el(host, "routine-schedule-editor")).not.toBeNull();
    // The default schedule is 09:00 UTC daily, so the preview must read 09:00
    // and move with the expression the operator types.
    expect(el(host, "routine-next-fire")?.textContent).toContain("09:00");

    act(() => {
      typeInto(field(host, "routine-cron-expression"), "30 8 * * *");
      typeInto(field(host, "routine-action-0-cwd"), "/work");
    });
    await settle();
    expect(el(host, "routine-next-fire")?.textContent).toContain("08:30");

    act(() => el(host, "routine-save")?.click());
    await settle();

    const writes = socket.framesOfType("routine_write");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (write?.t !== "routine_write") throw new Error("expected routine_write");
    expect(write.routine.trigger).toEqual({ kind: "cron", expression: "30 8 * * *", timezone: "UTC" });

    act(() => root.unmount());
    host.remove();
  });

  test("creates an interval routine in human units, stored as seconds", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => el(host, "routines-new")?.click());
    await settle();
    act(() => el(host, "routine-schedule-interval")?.click());
    await settle();

    expect(el(host, "routine-next-fire")).not.toBeNull();

    act(() => {
      typeInto(field(host, "routine-interval-value"), "30");
    });
    await settle();
    act(() => el(host, "routine-interval-unit-minutes")?.click());
    await settle();
    act(() => {
      typeInto(field(host, "routine-action-0-cwd"), "/work");
    });
    await settle();

    act(() => el(host, "routine-save")?.click());
    await settle();

    const writes = socket.framesOfType("routine_write");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (write?.t !== "routine_write") throw new Error("expected routine_write");
    expect(write.routine.trigger).toEqual({ kind: "interval", seconds: 1800 });

    act(() => root.unmount());
    host.remove();
  });

  test("an unparsable cron expression states its reason and blocks the save", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => el(host, "routines-new")?.click());
    await settle();

    act(() => {
      typeInto(field(host, "routine-cron-expression"), "* * * *");
    });
    await settle();

    expect(el(host, "routine-trigger-error")?.textContent).toContain("5 fields");
    expect(el(host, "routine-next-fire")).toBeNull();
    expect(readsDisabled(field(host, "routine-save"))).toBe(true);

    act(() => el(host, "routine-save")?.click());
    await settle();
    expect(socket.framesOfType("routine_write")).toEqual([]);

    act(() => root.unmount());
    host.remove();
  });

  test("a blank working directory states its reason and blocks the save until filled", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => el(host, "routines-new")?.click());
    await settle();

    expect(el(host, "routine-action-0-cwd-error")?.textContent).toContain("working directory");
    expect(readsDisabled(field(host, "routine-save"))).toBe(true);

    act(() => el(host, "routine-save")?.click());
    await settle();
    expect(socket.framesOfType("routine_write")).toEqual([]);

    act(() => {
      typeInto(field(host, "routine-action-0-cwd"), "/work");
    });
    await settle();
    expect(el(host, "routine-action-0-cwd-error")).toBeNull();
    expect(readsDisabled(field(host, "routine-save"))).toBe(false);

    act(() => el(host, "routine-save")?.click());
    await settle();
    expect(socket.framesOfType("routine_write")).toHaveLength(1);

    act(() => root.unmount());
    host.remove();
  });

  test("a webhook routine behind the hub shows the hub's own firable address", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    act(() => el(host, "routine-rtn_calls-edit")?.click());
    await settle();

    // The hub tunnels this exact shape: two segments, daemon then routine.
    // `packages/hub/test/tunnel.test.ts` proves the round trip end to end.
    expect(el(host, "routine-webhook-endpoint")?.textContent).toBe(
      "POST https://hub.ompctl.ai/v1/webhooks/dae_0123456789abcdef/rtn_calls",
    );

    // The notice has to tell the operator the address works and that the
    // secret is the gate, not that the endpoint is out of reach.
    const notice = el(host, "routine-webhook-hub-notice")?.textContent ?? "";
    expect(notice).toContain("it works");
    expect(notice).toContain("current secret");
    expect(notice).not.toContain("cannot reach");
    expect(notice).not.toContain("proxies no HTTP");

    act(() => root.unmount());
    host.remove();
  });

  test("editing an existing routine can change its trigger kind", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    act(() => el(host, "routine-rtn_calls-edit")?.click());
    await settle();
    act(() => el(host, "routine-trigger-schedule")?.click());
    await settle();

    expect(el(host, "routine-cron-expression")).not.toBeNull();
    // ROUTINE's actions already carry working directories, so save is open.
    act(() => el(host, "routine-save")?.click());
    await settle();

    const writes = socket.framesOfType("routine_write");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (write?.t !== "routine_write") throw new Error("expected routine_write");
    expect(write.routine.trigger).toEqual({ kind: "cron", expression: "0 9 * * *", timezone: "UTC" });

    act(() => root.unmount());
    host.remove();
  });

  test("a manual routine carries no schedule and saves as kind manual", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => el(host, "routines-new")?.click());
    await settle();
    act(() => el(host, "routine-trigger-manual")?.click());
    await settle();

    expect(el(host, "routine-manual-editor")).not.toBeNull();
    expect(el(host, "routine-next-fire")).toBeNull();
    expect(el(host, "routine-trigger-error")).toBeNull();

    act(() => {
      typeInto(field(host, "routine-action-0-cwd"), "/work");
    });
    await settle();
    act(() => el(host, "routine-save")?.click());
    await settle();

    const writes = socket.framesOfType("routine_write");
    expect(writes).toHaveLength(1);
    const write = writes[0];
    if (write?.t !== "routine_write") throw new Error("expected routine_write");
    expect(write.routine.trigger).toEqual({ kind: "manual" });

    act(() => root.unmount());
    host.remove();
  });
});

describe("RoutinesScreen delete and webhook surface", () => {
  /** The endpoint a directly-paired device can reach, so the rendered root is real, not a placeholder. */
  const DIRECT: Connection = {
    transport: "direct",
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_direct",
    scopes: ["read", "manage", "prompt"],
  };

  function clipboardWrites(): string[] {
    return (globalThis as { __clipboardWrites?: string[] }).__clipboardWrites ?? [];
  }

  test("a directly-paired device renders exactly the path the daemon serves", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(DIRECT);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    // The daemon-side suite POSTs to `webhookPath(id)` and its route answers;
    // this asserts the app renders that same helper's output under a real
    // derived root, so the two surfaces cannot drift apart silently.
    expect(el(host, "routine-rtn_calls-endpoint")?.textContent).toBe(
      `POST http://127.0.0.1:7777${webhookPath(ROUTINE.id)}`,
    );

    act(() => root.unmount());
    host.remove();
  });

  test("a hub-relayed device names the daemon address as the root it cannot read", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    expect(el(host, "routine-rtn_calls-endpoint")?.textContent).toBe(`POST {daemon address}${webhookPath(ROUTINE.id)}`);

    act(() => root.unmount());
    host.remove();
  });

  test("delete arms behind a confirm that names the routine, then sends one frame and drops the card", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    // First tap only arms: nothing is sent and the confirm names what dies.
    act(() => el(host, "routine-rtn_calls-delete")?.click());
    await settle();
    expect(socket.framesOfType("routine_delete")).toEqual([]);
    expect(el(host, "routine-rtn_calls-confirm-delete")?.textContent).toContain(ROUTINE.name);
    expect(el(host, "routine-rtn_calls-confirm-delete")?.textContent).toContain("webhook secret");

    // Keep it disarms with nothing sent.
    act(() => el(host, "routine-rtn_calls-confirm-cancel")?.click());
    await settle();
    expect(el(host, "routine-rtn_calls-confirm-delete")).toBeNull();
    expect(socket.framesOfType("routine_delete")).toEqual([]);

    act(() => el(host, "routine-rtn_calls-delete")?.click());
    await settle();
    act(() => el(host, "routine-rtn_calls-confirm-yes")?.click());
    await settle();
    expect(socket.framesOfType("routine_delete")).toEqual([{ t: "routine_delete", routineIds: [ROUTINE.id] }]);

    act(() => socket.deliver({ t: "routines_deleted", results: [{ routineId: ROUTINE.id, deleted: true }] }));
    await settle();
    expect(el(host, "routine-rtn_calls")).toBeNull();
    expect(el(host, "routines-empty")).not.toBeNull();
    // The daemon is authoritative, so the screen re-reads rather than only
    // trusting its local filter.
    expect(socket.framesOfType("routines_read").length).toBeGreaterThan(1);

    act(() => root.unmount());
    host.remove();
  });

  test("a refused delete names its reason on the card it named, and the card stays", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    act(() => el(host, "routine-rtn_calls-delete")?.click());
    await settle();
    act(() => el(host, "routine-rtn_calls-confirm-yes")?.click());
    await settle();
    act(() =>
      socket.deliver({
        t: "routines_deleted",
        results: [{ routineId: ROUTINE.id, deleted: false, refusal: "running" }],
      }),
    );
    await settle();

    expect(el(host, "routine-rtn_calls-delete-refused")?.textContent).toBe(ROUTINE_DELETE_REFUSAL_REASONS.running);
    expect(el(host, "routine-rtn_calls")).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("rotating shows the secret exactly once and the copy control lifts the bare URL with its token", async () => {
    forbidFetch();
    clipboardWrites().length = 0;
    const { socket, host, root } = await mounted(DIRECT);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    act(() => el(host, "routine-rtn_calls-rotate-secret")?.click());
    await settle();
    expect(socket.framesOfType("routine_secret_rotate")).toEqual([
      { t: "routine_secret_rotate", routineId: ROUTINE.id },
    ]);

    act(() => socket.deliver({ t: "routine_secret", routineId: ROUTINE.id, secret: "fresh-secret-value" }));
    await settle();

    const expectedUrl = `http://127.0.0.1:7777${webhookPath(ROUTINE.id)}?token=${encodeURIComponent("fresh-secret-value")}`;
    expect(el(host, "routine-secret-value")?.textContent).toBe("fresh-secret-value");
    expect(el(host, "routine-rtn_calls-secret-url")?.textContent).toBe(expectedUrl);

    act(() => el(host, "routine-secret-copy")?.click());
    await settle();
    // The pasteboard receives the URL only: no method prefix, so it pastes
    // clean into a shell.
    expect(clipboardWrites()).toEqual([expectedUrl]);
    expect(el(host, "routine-secret-copy")?.textContent).toContain("Copied");

    act(() => root.unmount());
    host.remove();
  });
});
