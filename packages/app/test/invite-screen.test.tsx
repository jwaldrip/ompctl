/**
 * `InviteScreen`'s socket mint: the frame it sends, the QR it renders from
 * the answer, and the refusal it surfaces. The connection under test is a
 * hub one on purpose -- that is the transport which used to fail closed
 * with "no reachable HTTP endpoint", and the reason the mint moved onto the
 * sealed socket in the first place.
 *
 * The screen is driven through a real `OmpdClient` over a canned socket, the
 * same division the console tests use: only the wire is fake, so the frame
 * construction, the event dispatch, and the one-shot semantics are all the
 * production client's.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { parsePairingBundle } from "@ompd/core/pairing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, the same way every other screen test in this directory
// loads its screen: bun evaluates a file's whole static import graph before
// its body runs, so a static import here would pull the real `react-native`
// in before `./rnw.ts` could substitute it.
const { InviteScreen, bundleForInvite } = await import("../src/screens/InviteScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The transport that used to fail closed: a relay with no daemon HTTP behind it. */
const HUB_CONNECTION: Connection = {
  transport: "hub",
  hubUrl: "wss://hub.ompctl.ai/relay",
  daemonId: "dae_0123456789abcdef",
  token: "tok_owner",
  scopes: ["read", "approve"],
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

/** The mint happens on mount once the socket says hello; a second settle lets the ready state commit. */
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

/** Refuses any HTTP the screen might attempt: the mint has no business on the wire-less path. */
function forbidFetch(): void {
  globalThis.fetch = (async () => {
    throw new Error("InviteScreen must not make HTTP requests");
  }) as unknown as typeof fetch;
}

describe("InviteScreen: minting a second device's credential over the socket", () => {
  test("a hub connection mints on connect, asks for this device's own scopes, and renders the QR", async () => {
    forbidFetch();
    const { client, socket } = cannedClient();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<InviteScreen connection={HUB_CONNECTION} onDone={() => {}} createClient={() => client} />);
    });

    // The screen cannot mint before the socket is up: the relay accepts the
    // sealed channel, the daemon says hello, and only then does the ask leave.
    expect(socket.framesOfType("device_invite")).toEqual([]);
    act(() => {
      socket.accept();
      socket.deliver({ t: "hello", deviceId: "dev_owner", agents: [] });
    });
    await settle();

    expect(socket.framesOfType("device_invite")).toEqual([
      { t: "device_invite", name: "New device", scopes: ["read", "approve"] },
    ]);

    act(() => {
      socket.deliver({ t: "device_invited", token: "tok_new", name: "Kitchen iPad", scopes: ["read"] });
    });
    await settle();

    expect(el(host, "invite-qr")).not.toBeNull();
    expect(el(host, "invite-error")).toBeNull();
    expect(host.textContent).toContain("Kitchen iPad");

    // The screen tore its own socket down when it went away, the same
    // lifecycle rule the Console's connection follows.
    act(() => {
      root.unmount();
    });
    expect(socket.closedWith?.code).toBe(1000);
    host.remove();
  });

  test("the QR payload is the hub connection carrying the returned token", () => {
    const encoded = bundleForInvite(HUB_CONNECTION, "tok_new", ["read"], "Kitchen iPad");
    const bundle = parsePairingBundle(encoded);
    expect(bundle).not.toBeNull();
    expect(bundle?.label).toBe("Kitchen iPad");
    expect(bundle?.connection).toEqual({
      transport: "hub",
      hubUrl: "wss://hub.ompctl.ai/relay",
      daemonId: "dae_0123456789abcdef",
      token: "tok_new",
      scopes: ["read"],
    });

    const direct = bundleForInvite(
      { transport: "direct", url: "ws://192.168.1.10:7777/v1/socket", token: "tok_owner", scopes: ["approve"] },
      "tok_lan",
      ["read", "prompt"],
      "Desk tablet",
    );
    expect(parsePairingBundle(direct)?.connection).toEqual({
      transport: "direct",
      url: "ws://192.168.1.10:7777/v1/socket",
      token: "tok_lan",
      scopes: ["read", "prompt"],
    });
  });

  test("a widened scope selection the daemon refuses surfaces as a readable message", async () => {
    forbidFetch();
    const { client, socket } = cannedClient();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(<InviteScreen connection={HUB_CONNECTION} onDone={() => {}} createClient={() => client} />);
    });
    act(() => {
      socket.accept();
      socket.deliver({ t: "hello", deviceId: "dev_owner", agents: [] });
    });
    await settle();

    // The first mint succeeds, so a QR is on screen before the operator asks
    // again. That is what makes the refusal below the interesting case: a
    // screen that stopped listening to errors once it had a code would leave
    // the second ask spinning forever.
    act(() => {
      socket.deliver({ t: "device_invited", token: "tok_first", name: "New device", scopes: ["read", "approve"] });
    });
    await settle();
    expect(el(host, "invite-qr")).not.toBeNull();

    // Widen past this device's own scopes -- `manage` is not in HUB_CONNECTION.scopes.
    act(() => {
      el(host, "invite-scope-manage")?.click();
    });
    act(() => {
      el(host, "invite-generate")?.click();
    });
    await settle();

    const invites = socket.framesOfType("device_invite");
    expect(invites).toHaveLength(2);
    expect(invites[1]).toEqual({ t: "device_invite", name: "New device", scopes: ["read", "approve", "manage"] });

    act(() => {
      socket.deliver({
        t: "error",
        code: "unauthorized",
        message: "this device cannot grant manage: it does not hold that scope itself",
      });
    });
    await settle();

    const error = el(host, "invite-error");
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("manage");
    // Refused, not crashed: the screen is still mounted and interactive.
    expect(el(host, "invite-generate")).not.toBeNull();
    expect(el(host, "invite-qr")).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
