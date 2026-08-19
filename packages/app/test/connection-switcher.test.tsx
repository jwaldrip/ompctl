/** The saved-daemon chooser exposes selection and a reversible add path. */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectionList } from "../src/platform/connection.ts";

const { ConnectionSwitcherScreen } = await import("../src/screens/ConnectionSwitcherScreen.tsx");
const { PairScreen } = await import("../src/screens/PairScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const connections: ConnectionList = {
  activeId: "local",
  connections: [
    {
      id: "local",
      label: "Local",
      connection: { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket", token: "tok_local", scopes: [] },
    },
    {
      id: "cloud",
      label: "Cloud",
      connection: {
        transport: "hub",
        hubUrl: "wss://hub.example.com",
        daemonId: "dmn_cloud",
        token: "tok_cloud",
        scopes: [],
      },
    },
  ],
};

function button(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} control rendered`);
  return element;
}

describe("ConnectionSwitcherScreen", () => {
  test("selects a saved daemon, opens add, and lets pairing return to the chooser", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const selected: string[] = [];
    let adding = false;
    let cancelled = false;

    act(() => {
      root.render(
        <ConnectionSwitcherScreen
          connections={connections}
          onAdd={() => {
            adding = true;
          }}
          onBack={() => {}}
          onInvite={() => {}}
          onSelect={id => selected.push(id)}
        />,
      );
    });
    act(() => {
      button(host, "connection-cloud").click();
      button(host, "add-connection").click();
    });
    expect(selected).toEqual(["cloud"]);
    expect(adding).toBe(true);

    act(() => {
      root.render(
        <PairScreen
          onCancel={() => {
            cancelled = true;
          }}
          onPair={() => {}}
          onScan={() => {}}
        />,
      );
    });
    act(() => {
      button(host, "pair-cancel").click();
    });
    expect(cancelled).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("the invite entry point is absent when the active connection's scopes exclude approve", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <ConnectionSwitcherScreen
          connections={connections}
          onAdd={() => {}}
          onBack={() => {}}
          onInvite={() => {}}
          onSelect={() => {}}
        />,
      );
    });
    expect(host.querySelector('[data-testid="invite-device"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("holding approve on the active connection surfaces an invite entry point that asks for the invite route", () => {
    const approving: ConnectionList = {
      activeId: "local",
      connections: [
        {
          id: "local",
          label: "Local",
          connection: {
            transport: "direct",
            url: "ws://127.0.0.1:7777/v1/socket",
            token: "tok_local",
            scopes: ["read", "approve"],
          },
        },
      ],
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let invited = 0;

    act(() => {
      root.render(
        <ConnectionSwitcherScreen
          connections={approving}
          onAdd={() => {}}
          onBack={() => {}}
          onInvite={() => {
            invited += 1;
          }}
          onSelect={() => {}}
        />,
      );
    });
    expect(button(host, "invite-device")).not.toBeNull();

    // The entry point asks for a route rather than swapping this screen for the
    // invite screen itself: the shell's menu reaches the same destination, and
    // one destination with two ways of being presented is two navigation
    // models. `nav-shell.test.tsx` proves the route it asks for renders.
    act(() => {
      button(host, "invite-device").click();
    });
    expect(invited).toBe(1);
    expect(host.querySelector('[data-testid="invite"]')).toBeNull();

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
