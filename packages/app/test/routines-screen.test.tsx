import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame, RemoteRoutine, Run, ServerFrame } from "@ompd/core/contracts";
import { hubWebhookPath, ROUTINE_DELETE_REFUSAL_REASONS, webhookPath } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic for the same RNW boundary as the screen import below: the provider
// pulls Paper, which pulls React Native, so a static import would run first.
const { WithOmpTheme } = await import("./theme.tsx");
const { RoutinesScreen } = await import("../src/screens/RoutinesScreen.tsx");
const { RUNS_PER_PAGE } = await import("../src/components/RunHistory.tsx");

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
/**
 * What `PairScreen` actually writes: a device paired by hand carries no scope
 * hint at all, because nothing in that flow knows what the operator approved.
 * Undeclared, never a refusal.
 */
const UNDECLARED: Connection = { ...MANAGER, token: "tok_hand_paired", scopes: [] };

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

/**
 * `hello` defaults to greeting with the pairing's own scopes, which is the
 * ordinary case. It is a separate argument because the stored scopes and the
 * daemon's answer are genuinely two different facts: a device paired by hand
 * stores none at all, and a grant can be widened or narrowed on the daemon
 * long after the pairing was written.
 */
async function mounted(connection: Connection, hello?: { scopes?: string[] }) {
  const { client, socket } = cannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  /**
   * Every session id this screen asked to open, in order. The screen is handed
   * the console's opener in the app, so this is the boundary the run links
   * cross: what matters here is which id crossed it, and the console suite is
   * where the transport that id resolves to is proved.
   */
  const opened: string[] = [];
  act(() => {
    root.render(
      <WithOmpTheme>
        <RoutinesScreen
          connection={connection}
          createClient={() => client}
          onBack={() => {}}
          onOpenSession={sessionId => {
            opened.push(sessionId);
          }}
        />
      </WithOmpTheme>,
    );
  });
  const greeted = hello === undefined ? connection.scopes : hello.scopes;
  act(() => {
    socket.accept();
    socket.deliver(
      greeted === undefined
        ? { t: "hello", deviceId: "dev_phone", agents: [] }
        : { t: "hello", deviceId: "dev_phone", agents: [], scopes: greeted },
    );
  });
  await settle();
  return { socket, host, root, opened };
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

  test("a hub-relayed device renders the hub's own firable address, not a placeholder", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    // The hub tunnels this shape and `packages/hub/test/tunnel.test.ts` proves
    // the round trip, so the card can name a real address rather than shrug.
    expect(el(host, "routine-rtn_calls-endpoint")?.textContent).toBe(
      `POST https://hub.ompctl.ai${hubWebhookPath(MANAGER.daemonId, ROUTINE.id)}`,
    );

    act(() => root.unmount());
    host.remove();
  });

  test("the copy control behind a hub lifts a URL that can actually be fired", async () => {
    forbidFetch();
    clipboardWrites().length = 0;
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    act(() => el(host, "routine-rtn_calls-rotate-secret")?.click());
    await settle();
    act(() => socket.deliver({ t: "routine_secret", routineId: ROUTINE.id, secret: "fresh-secret-value" }));
    await settle();

    // The sharpest cost of the old copy: this string carries a live secret to
    // wherever the operator pastes it, so a placeholder host made it both
    // unusable and a leak.
    const expectedUrl = `https://hub.ompctl.ai${hubWebhookPath(MANAGER.daemonId, ROUTINE.id)}?token=${encodeURIComponent("fresh-secret-value")}`;
    expect(el(host, "routine-rtn_calls-secret-url")?.textContent).toBe(expectedUrl);

    act(() => el(host, "routine-secret-copy")?.click());
    await settle();
    expect(clipboardWrites()).toEqual([expectedUrl]);
    expect(expectedUrl).not.toContain("{daemon address}");

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

describe("RoutinesScreen scope gate", () => {
  test("a pairing that declared no scopes manages routines the daemon says it may", async () => {
    forbidFetch();
    // The hand-paired case: nothing stored, and a daemon that grants manage.
    const { socket, host, root } = await mounted(UNDECLARED, { scopes: ["read", "manage", "prompt"] });
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    // No refusal is claimed, because none was made.
    expect(el(host, "routines-readonly-notice")).toBeNull();
    expect(el(host, "routines-run-disabled-notice")).toBeNull();

    // And the irreversible control actually reaches the daemon rather than
    // sitting disabled against a grant that would have allowed it.
    act(() => el(host, "routine-rtn_calls-delete")?.click());
    await settle();
    act(() => el(host, "routine-rtn_calls-confirm-yes")?.click());
    await settle();
    expect(socket.framesOfType("routine_delete")).toEqual([{ t: "routine_delete", routineIds: [ROUTINE.id] }]);

    act(() => root.unmount());
    host.remove();
  });

  test("a daemon that reports no manage scope takes the controls away, whatever the pairing stored", async () => {
    forbidFetch();
    // The stored hint says manage; the daemon's own record says otherwise, and
    // the daemon is the thing doing the enforcing.
    const { socket, host, root } = await mounted(MANAGER, { scopes: ["read"] });
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    expect(el(host, "routines-readonly-notice")?.textContent).toContain("manage");
    act(() => el(host, "routine-rtn_calls-delete")?.click());
    await settle();
    expect(el(host, "routine-rtn_calls-confirm-yes")).toBeNull();
    expect(socket.framesOfType("routine_delete")).toEqual([]);

    act(() => root.unmount());
    host.remove();
  });

  test("an older daemon that reports no scopes at all leaves an undeclared pairing able to act", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(UNDECLARED, {});
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    expect(el(host, "routines-readonly-notice")).toBeNull();
    act(() => el(host, "routine-rtn_calls-delete")?.click());
    await settle();
    act(() => el(host, "routine-rtn_calls-confirm-yes")?.click());
    await settle();
    expect(socket.framesOfType("routine_delete")).toEqual([{ t: "routine_delete", routineIds: [ROUTINE.id] }]);

    act(() => root.unmount());
    host.remove();
  });

  test("a routine list already on screen does not put the gate back to unknown", async () => {
    forbidFetch();
    // A reconnect re-greets, but a plain `agents` frame carries no scopes, and
    // that absence must not overwrite the answer the daemon already gave.
    const { socket, host, root } = await mounted(MANAGER, { scopes: ["read"] });
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    act(() => socket.deliver({ t: "agents", agents: [] }));
    await settle();

    expect(el(host, "routines-readonly-notice")?.textContent).toContain("manage");

    act(() => root.unmount());
    host.remove();
  });
});

describe("RoutinesScreen action refusals", () => {
  test("an error answering a delete reaches the operator instead of clearing the spinner", async () => {
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
        t: "error",
        code: "routine_delete_failed",
        message: "the routine store is read-only",
      }),
    );
    await settle();

    expect(el(host, "routines-action-error")?.textContent).toContain("the routine store is read-only");
    // The list it was showing survives: an action refusal is not a failed read.
    expect(el(host, "routine-rtn_calls")).not.toBeNull();
    expect(el(host, "routines-read-error")).toBeNull();

    // And the control is usable again rather than stuck behind a spinner that
    // never cleared.
    act(() => el(host, "routine-rtn_calls-confirm-yes")?.click());
    await settle();
    expect(socket.framesOfType("routine_delete")).toHaveLength(2);
    expect(el(host, "routines-action-error")).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a failed first read still owns the whole screen", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "error", code: "routines_unavailable", message: "no routine runner" }));
    await settle();

    expect(el(host, "routines-read-error")?.textContent).toContain("no routine runner");
    expect(el(host, "routines-action-error")).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});

/**
 * A run whose two prompt actions each opened their own session, which is what
 * the scheduler produces: one agent per prompt action, one ACP session per
 * agent.
 */
const LINKED_RUN: Run = {
  id: "run_linked",
  routineId: ROUTINE.id,
  state: "succeeded",
  startedAt: "2026-08-19T09:00:00.000Z",
  finishedAt: "2026-08-19T09:00:04.000Z",
  actions: [
    {
      actionId: "text-back",
      actionName: "Text back",
      index: 0,
      state: "succeeded",
      summary: "texted the caller",
      startedAt: "2026-08-19T09:00:00.000Z",
      finishedAt: "2026-08-19T09:00:02.000Z",
      agentId: "agt_text",
      sessionId: "sess_text",
    },
    {
      actionId: "webhook",
      actionName: "Webhook",
      index: 1,
      state: "succeeded",
      summary: "delivered",
      startedAt: "2026-08-19T09:00:02.000Z",
      finishedAt: "2026-08-19T09:00:04.000Z",
      agentId: "agt_hook",
      sessionId: "sess_hook",
    },
  ],
};

/** What a run recorded before `ActionRun.sessionId` existed looks like. */
const UNLINKED_RUN: Run = {
  id: "run_old",
  routineId: ROUTINE.id,
  state: "succeeded",
  startedAt: "2026-08-18T09:00:00.000Z",
  finishedAt: "2026-08-18T09:00:02.000Z",
  actions: [
    {
      actionId: "text-back",
      actionName: "Text back",
      index: 0,
      state: "succeeded",
      summary: "texted the caller",
      startedAt: "2026-08-18T09:00:00.000Z",
      finishedAt: "2026-08-18T09:00:02.000Z",
    },
  ],
};

/** Every run row currently mounted, in document order. */
function runRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid^="run-"][data-testid$="-toggle"]')];
}

describe("RoutinesScreen run history", () => {
  test("a run with two prompt actions links two distinct sessions and counts them", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [LINKED_RUN] }));
    await settle();

    expect(el(host, "run-run_linked-state")?.textContent).toBe("Succeeded");
    expect(el(host, "run-run_linked-sessions")?.textContent).toBe("2 linked sessions");
    // Both readings, because a finished run has an end and a running one does
    // not, and the card must never invent the one it does not have.
    expect(el(host, "run-run_linked-timing")?.textContent).toContain("started");
    expect(el(host, "run-run_linked-timing")?.textContent).toContain("ended");

    act(() => el(host, "run-run_linked-toggle")?.click());
    await settle();
    expect(readsDisabled(field(host, "run-run_linked-action-text-back-open"))).toBe(false);
    expect(readsDisabled(field(host, "run-run_linked-action-webhook-open"))).toBe(false);
    expect(el(host, "run-run_linked-action-webhook")?.textContent).toContain("delivered");

    act(() => root.unmount());
    host.remove();
  });

  test("a still-running run says so instead of naming an end it never reached", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    const running: Run = {
      ...LINKED_RUN,
      id: "run_now",
      state: "running",
      finishedAt: undefined,
      actions: [{ ...LINKED_RUN.actions[0]!, state: "running", finishedAt: undefined, summary: undefined }],
    };
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [running] }));
    await settle();

    expect(el(host, "run-run_now-state")?.textContent).toBe("Running");
    expect(el(host, "run-run_now-timing")?.textContent).toContain("still running");
    expect(el(host, "run-run_now-timing")?.textContent).not.toContain("ended");

    act(() => root.unmount());
    host.remove();
  });

  test("each link opens the session its own action ran in, never the other one", async () => {
    forbidFetch();
    const { socket, host, root, opened } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [LINKED_RUN] }));
    await settle();
    act(() => el(host, "run-run_linked-toggle")?.click());
    await settle();

    act(() => field(host, "run-run_linked-action-webhook-open").click());
    await settle();
    act(() => field(host, "run-run_linked-action-text-back-open").click());
    await settle();

    // The id each control carries, in the order they were pressed. Two links on
    // one run that both opened the first action's session is the defect this
    // pins, and it would pass a check that only counted the calls.
    expect(opened).toEqual(["sess_hook", "sess_text"]);

    act(() => root.unmount());
    host.remove();
  });

  test("a run recorded before sessions were linked offers a disabled control that says why", async () => {
    forbidFetch();
    const { socket, host, root, opened } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [UNLINKED_RUN] }));
    await settle();

    expect(el(host, "run-run_old-sessions")?.textContent).toBe("0 linked sessions");
    act(() => el(host, "run-run_old-toggle")?.click());
    await settle();

    const control = field(host, "run-run_old-action-text-back-open");
    expect(readsDisabled(control)).toBe(true);
    // The label has to carry the reason: a disabled control that only reads
    // "Open session" tells a screen reader nothing about why it is off.
    expect(control.getAttribute("aria-label")).toContain("this run recorded none for it");
    act(() => control.click());
    await settle();
    expect(opened).toEqual([]);
    // Present rather than hidden: an omitted row would make an old run look
    // like a run with fewer actions.
    expect(el(host, "run-run_old-action-text-back")).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a long history renders one page, and the control reveals the next", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    const many: Run[] = Array.from({ length: 500 }, (_unused, index) => ({
      ...LINKED_RUN,
      id: `run_${index}`,
      startedAt: new Date(Date.parse(LINKED_RUN.startedAt) - index * 60_000).toISOString(),
    }));
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: many }));
    await settle();

    expect(runRows(host)).toHaveLength(RUNS_PER_PAGE);
    expect(el(host, "routine-rtn_calls-runs-more")?.textContent).toContain("of 500");

    act(() => el(host, "routine-rtn_calls-runs-more")?.click());
    await settle();
    expect(runRows(host)).toHaveLength(RUNS_PER_PAGE * 2);
    // Still bounded after the reveal: the control adds a page, it does not
    // drop the cap.
    expect(el(host, "routine-rtn_calls-runs-more")).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a routine that has never run says so rather than showing an empty block", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [] }));
    await settle();

    expect(el(host, "routine-rtn_calls-runs-empty")?.textContent).toContain("has not run yet");
    expect(runRows(host)).toEqual([]);

    act(() => root.unmount());
    host.remove();
  });

  test("a run that ended before any action started says so when opened", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER);
    const skipped: Run = {
      id: "run_skipped",
      routineId: ROUTINE.id,
      state: "skipped",
      startedAt: "2026-08-19T09:00:00.000Z",
      finishedAt: "2026-08-19T09:00:00.000Z",
      error: "the previous run was still going, and this routine is a singleton",
      actions: [],
    };
    act(() => socket.deliver({ t: "routines", routines: [ROUTINE], runs: [skipped] }));
    await settle();

    expect(el(host, "run-run_skipped-error")?.textContent).toContain("singleton");
    act(() => el(host, "run-run_skipped-toggle")?.click());
    await settle();
    // Opened, and not silently empty: a toggle that reveals nothing reads as a
    // control that does not work.
    expect(el(host, "run-run_skipped-no-actions")?.textContent).toContain("before any action started");

    act(() => root.unmount());
    host.remove();
  });
});
