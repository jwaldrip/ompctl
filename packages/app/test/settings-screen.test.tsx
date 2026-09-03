/**
 * `SettingsScreen` over the socket it owns: the frames it sends, the
 * confirmed values it renders, and the states it must not fake. The screen
 * rides the client's `readSettings`/`writeSettings`, so these tests drive a
 * real `OmpdClient` on a canned wire, the same harness the invite screen's
 * test uses -- the hub tunnels only a webhook fire and no tunnel is wired for
 * the settings route, so a screen that reached for it here would be reaching
 * for a road that is not there.
 *
 * The acceptance that matters most is here on purpose: a pairing without
 * `manage` still reads its daemon's settings, with the reason named, rather
 * than rendering a dead screen for the most common pairing there is.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, the same way every other screen test in this directory
// loads its screen: bun evaluates a file's whole static import graph before
// its body runs, so a static import here would pull the real `react-native`
// in before `./rnw.ts` could substitute it.
const { SettingsScreen } = await import("../src/screens/SettingsScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The transport a phone actually holds: a relay with no tunnel to the settings route behind it. */
const MANAGER_CONNECTION: Connection = {
  transport: "hub",
  hubUrl: "wss://hub.ompctl.ai/relay",
  daemonId: "dae_0123456789abcdef",
  token: "tok_owner",
  scopes: ["read", "manage"],
};

/** The most common pairing there is: watching, never driving. */
const WATCHER_CONNECTION: Connection = { ...MANAGER_CONNECTION, token: "tok_watch", scopes: ["read"] };

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];
  closedWith: SocketCloseInfo | null = null;

  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("send on a socket that is not open");
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The relay accepted the sealed channel. */
  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver a daemon frame to the client. */
  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  framesOfType(t: ClientFrame["t"]): ClientFrame[] {
    return this.sent.filter(frame => frame.t === t);
  }
}

/**
 * A real client on a canned wire. The scheduler never fires, so the ping
 * loop and any reconnect backoff hold no real timers, and the credential
 * probe answers "unknown" rather than reaching for the network.
 */
function cannedClient(): { client: OmpdClient; socket: FakeSocket } {
  const socket = new FakeSocket();
  const client = new OmpdClient({
    url: "wss://hub.ompctl.ai/relay",
    token: "tok_owner",
    createSocket: () => socket,
    schedule: () => () => {},
    isOnline: () => true,
    probeCredential: () => Promise.resolve("unknown"),
  });
  return { client, socket };
}

/** The read happens on mount once the socket says hello; a settle lets the state commit. */
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

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** Refuses any HTTP the screen might attempt: the settings ride the socket or not at all. */
function forbidFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error("SettingsScreen must not make HTTP requests");
  }) as unknown as typeof fetch;
}

/** Brings the socket up, says hello, and hands back the mounted harness. */
async function mounted(connection: Connection) {
  const { client, socket } = cannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<SettingsScreen connection={connection} onBack={() => {}} createClient={() => client} />);
  });
  expect(socket.framesOfType("settings_read")).toEqual([]);
  act(() => {
    socket.accept();
    socket.deliver({ t: "hello", deviceId: "dev_owner", agents: [] });
  });
  await settle();
  return { client, socket, host, root };
}

describe("SettingsScreen: daemon settings over the socket", () => {
  test("reads on connect and renders the daemon's confirmed values", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER_CONNECTION);

    expect(socket.framesOfType("settings_read")).toEqual([{ t: "settings_read" }]);

    act(() => {
      socket.deliver({ t: "settings", policyMode: "strict", keepAwake: false });
    });
    await settle();

    expect(el(host, "settings-policy-strict-current")).not.toBeNull();
    expect(el(host, "settings-policy-standard-current")).toBeNull();
    expect(el(host, "settings-keepawake-off")).not.toBeNull();
    expect(el(host, "settings-readonly-notice")).toBeNull();
    expect(host.textContent).toContain("Asks before every write and every command.");

    act(() => {
      root.unmount();
    });
    expect(socket.closedWith?.code).toBe(1000);
    host.remove();
  });

  test("a change sends one write carrying both settings, and only the confirmation flips the screen", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER_CONNECTION);

    act(() => {
      socket.deliver({ t: "settings", policyMode: "standard", keepAwake: true });
    });
    await settle();

    act(() => {
      el(host, "settings-policy-trusted")?.click();
    });
    await settle();

    // The write carries both settings, not just the changed one: the daemon's
    // contract is one frame that replaces the pair.
    expect(socket.framesOfType("settings_write")).toEqual([
      { t: "settings_write", policyMode: "trusted", keepAwake: true },
    ]);
    // Intent is not truth: until the daemon answers, the old posture stays.
    expect(el(host, "settings-policy-standard-current")).not.toBeNull();

    act(() => {
      socket.deliver({ t: "settings", policyMode: "trusted", keepAwake: true });
    });
    await settle();

    expect(el(host, "settings-policy-trusted-current")).not.toBeNull();
    expect(el(host, "settings-policy-standard-current")).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("a manage-less pairing reads its daemon read-only, with the reason named", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(WATCHER_CONNECTION);

    act(() => {
      socket.deliver({ t: "settings", policyMode: "standard", keepAwake: true });
    });
    await settle();

    const notice = el(host, "settings-readonly-notice");
    expect(notice).not.toBeNull();
    // The missing scope is named, because "manage" is the word the operator
    // must go and grant.
    expect(notice?.textContent).toContain("manage");
    expect(el(host, "settings-policy-standard-current")).not.toBeNull();

    act(() => {
      el(host, "settings-policy-trusted")?.click();
      el(host, "settings-keepawake")?.click();
    });
    await settle();

    expect(socket.framesOfType("settings_write")).toEqual([]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("an in-flight write blocks a second one, and a refusal is named and retryable", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER_CONNECTION);

    act(() => {
      socket.deliver({ t: "settings", policyMode: "standard", keepAwake: true });
    });
    await settle();

    // First tap leaves; the daemon has not answered. A second tap on the
    // other control must not stack a second write behind the first.
    act(() => {
      el(host, "settings-policy-trusted")?.click();
    });
    await settle();
    act(() => {
      el(host, "settings-keepawake")?.click();
    });
    await settle();
    expect(socket.framesOfType("settings_write").length).toBe(1);

    act(() => {
      socket.deliver({ t: "error", code: "unauthorized", message: "settings_write requires manage scope" });
    });
    await settle();

    const failure = el(host, "settings-write-error");
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain("settings_write requires manage scope");
    // The refused write left the confirmed truth on screen.
    expect(el(host, "settings-policy-standard-current")).not.toBeNull();

    act(() => {
      el(host, "settings-retry-write")?.click();
    });
    await settle();
    expect(socket.framesOfType("settings_write").length).toBe(2);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("a read the daemon refuses is named and retryable rather than a spinner forever", async () => {
    forbidFetch();
    const { socket, host, root } = await mounted(MANAGER_CONNECTION);

    act(() => {
      socket.deliver({ t: "error", code: "unauthorized", message: "settings requires read scope" });
    });
    await settle();

    const failure = el(host, "settings-read-error");
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain("settings requires read scope");

    act(() => {
      el(host, "settings-retry-read")?.click();
    });
    await settle();
    expect(socket.framesOfType("settings_read").length).toBe(2);

    act(() => {
      socket.deliver({ t: "settings", policyMode: "standard", keepAwake: true });
    });
    await settle();
    expect(el(host, "settings-policy-standard-current")).not.toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
