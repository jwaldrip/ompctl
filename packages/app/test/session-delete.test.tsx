/**
 * Deleting a session from the fleet, pressed rather than reasoned about.
 *
 * Three properties, and every one of them is a thing a person could lose work
 * to if it regressed:
 *
 * - one press deletes nothing. The first press only arms the row, and the
 *   frame that destroys a transcript leaves this device only after a second
 *   press on a control that was not there before;
 * - the confirmation names the session it is about to destroy, because a
 *   generic "are you sure" over a list of 534 rows is not a confirmation of
 *   anything in particular;
 * - a pairing without the manage scope still shows the control, disabled,
 *   with the missing grant named on screen. A control that vanished would
 *   leave an operator unable to tell "this build cannot delete" from "this
 *   device may not".
 *
 * The shell, the hook, and the row are real; only the socket is canned, so
 * what these tests observe is the frame the app would actually have sent.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { SessionSummary } from "@ompd/core/contracts";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "../src/platform/connection.ts";
import { resetSafeAreaInsets } from "./rnw.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Dynamic, for the reason every suite in this directory imports the shell
// dynamically: a static import would resolve "react-native" before `./rnw.ts`
// could substitute react-native-web for it.
const { Console } = await import("../src/console/Console.tsx");

afterEach(resetSafeAreaInsets);

const SESSION_ID = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
const TITLE = "Ship the delete path";

const SESSION: SessionSummary = {
  id: SESSION_ID,
  title: TITLE,
  cwd: "/Users/op/dev/src/github.com/op/alpha",
  cwdScope: "home",
  flattenedDir: "-Users-op-dev-src-github-com-op-alpha",
  status: "dormant",
  createdAt: "2026-02-01T00:00:00.000Z",
  lastActivityAt: "2026-02-28T00:00:00.000Z",
  messageCount: 12,
  byteSize: 4096,
  archived: false,
};

/** The client surface `useConsole` touches, with the deletes it was asked to send recorded. */
class CannedClient {
  readonly deleted: string[][] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  on(name: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter(entry => entry !== listener),
      );
    };
  }
  start(): void {}
  close(): void {}
  reconnectNow(): void {}
  attach(): void {}
  listSessions(): void {}
  sessionTail(): void {}
  sessionHistory(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  deleteSessions(sessionIds: readonly string[]): void {
    this.deleted.push([...sessionIds]);
  }
}

interface Bay {
  client: CannedClient;
  el: (testID: string) => HTMLElement | null;
  require: (testID: string) => HTMLElement;
  press: (testID: string) => void;
  text: () => string;
  frame: (name: string, event: unknown) => void;
  unmount: () => void;
}

function mountBay(scopes: string[]): Bay {
  const connection: Connection = {
    transport: "direct",
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_1",
    scopes,
  };
  const connections: ConnectionList = {
    activeId: "local",
    connections: [{ id: "local", label: "Studio Mac", connection }],
  };
  const client = new CannedClient();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  act(() => {
    root.render(
      <Console
        connection={connection}
        daemonLabel="Studio Mac"
        connections={connections}
        onAddConnection={() => {}}
        onSelectConnection={() => {}}
        onUnpair={() => {}}
        createClient={() => client as unknown as OmpdClient}
      />,
    );
  });

  act(() => {
    client.emit("status", { state: "connected", attempt: 0 });
    client.emit("sessions", { sessions: [SESSION] });
  });

  const el = (testID: string): HTMLElement | null => {
    const found = host.querySelector(`[data-testid="${testID}"]`);
    return found instanceof HTMLElement ? found : null;
  };

  return {
    client,
    el,
    require: testID => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      return target;
    },
    press: testID => {
      const target = el(testID);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        target.click();
      });
    },
    text: () => host.textContent ?? "",
    frame: (name, event) => {
      act(() => {
        client.emit(name, event);
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/**
 * How a disabled control reads in this environment: RNW writes `aria-disabled`
 * for a `Pressable`'s accessibility state and the DOM property for a real
 * button, and either one is a refusal.
 */
function readsDisabled(el: Element): boolean {
  if (el.getAttribute("aria-disabled") === "true") return true;
  return Reflect.get(el, "disabled") === true;
}

describe("one press deletes nothing", () => {
  test("pressing delete arms the row and sends no frame", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      // The premise: the row is on screen with its own delete control.
      expect(bay.el(`session-delete-${SESSION_ID}`)).not.toBeNull();
      expect(bay.el(`session-delete-confirm-${SESSION_ID}`)).toBeNull();

      bay.press(`session-delete-${SESSION_ID}`);

      expect(bay.client.deleted).toEqual([]);
      expect(bay.el(`session-delete-confirm-${SESSION_ID}`)).not.toBeNull();
    } finally {
      bay.unmount();
    }
  });

  test("the second press, on the confirmation's own control, is what sends the delete", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);
      bay.press(`session-delete-confirm-${SESSION_ID}`);

      expect(bay.client.deleted).toEqual([[SESSION_ID]]);
    } finally {
      bay.unmount();
    }
  });

  test("keeping the session disarms the row and sends nothing", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);
      bay.press(`session-delete-cancel-${SESSION_ID}`);

      expect(bay.client.deleted).toEqual([]);
      expect(bay.el(`session-delete-confirm-${SESSION_ID}`)).toBeNull();
      // Back to a normal row, with its everyday actions where they were.
      expect(bay.el(`session-archive-${SESSION_ID}`)).not.toBeNull();
      expect(bay.el(`session-delete-${SESSION_ID}`)).not.toBeNull();
    } finally {
      bay.unmount();
    }
  });

  test("the destructive control is not where archive was: arming removes archive and puts Keep in that corner", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);

      // Nothing destructive is left in the trailing corner a thumb reaching
      // for archive lands on; Keep is what is there now.
      expect(bay.el(`session-archive-${SESSION_ID}`)).toBeNull();
      expect(bay.el(`session-delete-${SESSION_ID}`)).toBeNull();
      expect(bay.el(`session-delete-cancel-${SESSION_ID}`)).not.toBeNull();

      // And the confirm sits before the prompt text, which sits before Keep:
      // the destructive control is at the leading edge, where the title was
      // and where no control was before.
      const markup = bay.require(`session-row-${SESSION_ID}`).innerHTML;
      expect(markup.indexOf(`session-delete-confirm-${SESSION_ID}`)).toBeLessThan(
        markup.indexOf(`session-delete-cancel-${SESSION_ID}`),
      );
    } finally {
      bay.unmount();
    }
  });
});

describe("the confirmation names the session", () => {
  test("the armed row quotes the session's own title and says what deletion costs", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);

      const prompt = bay.require(`session-delete-prompt-${SESSION_ID}`).textContent ?? "";
      expect(prompt).toContain(TITLE);
      expect(prompt.toLowerCase()).toContain("for good");
    } finally {
      bay.unmount();
    }
  });

  test("a session with no title is named as untitled rather than as nothing at all", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.frame("sessions", { sessions: [{ ...SESSION, title: "" }] });
      bay.press(`session-delete-${SESSION_ID}`);

      expect(bay.require(`session-delete-prompt-${SESSION_ID}`).textContent).toContain("Untitled session");
    } finally {
      bay.unmount();
    }
  });
});

describe("a pairing without manage scope", () => {
  test("still shows the control, disabled, and names the missing scope on screen", () => {
    const bay = mountBay(["read"]);
    try {
      const control = bay.require(`session-delete-${SESSION_ID}`);
      expect(readsDisabled(control)).toBe(true);
      // Never hidden: the row's own control is there to be read.
      expect(control.getAttribute("aria-label")).toContain("manage scope");
      expect(bay.require("fleet-delete-scope-notice").textContent).toContain("manage scope");
    } finally {
      bay.unmount();
    }
  });

  test("pressing the disabled control arms nothing and sends nothing", () => {
    const bay = mountBay(["read"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);

      expect(bay.el(`session-delete-confirm-${SESSION_ID}`)).toBeNull();
      expect(bay.client.deleted).toEqual([]);
    } finally {
      bay.unmount();
    }
  });

  test("a daemon that narrows the grant after pairing takes the control away, not the row", () => {
    // The stored pairing claims manage; the daemon's own hello says otherwise,
    // and the daemon's answer is the authority.
    const bay = mountBay(["read", "manage"]);
    try {
      expect(readsDisabled(bay.require(`session-delete-${SESSION_ID}`))).toBe(false);

      bay.frame("agents", { agents: [], deviceId: "dev_phone", scopes: ["read"] });

      expect(readsDisabled(bay.require(`session-delete-${SESSION_ID}`))).toBe(true);
      expect(bay.el(`session-row-${SESSION_ID}`)).not.toBeNull();
    } finally {
      bay.unmount();
    }
  });
});

describe("what the daemon answers", () => {
  test("a refusal is said out loud, because nothing on screen changes when a delete is refused", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);
      bay.press(`session-delete-confirm-${SESSION_ID}`);
      bay.frame("sessions_deleted", {
        results: [{ sessionId: SESSION_ID, deleted: false, refusal: "live" }],
      });

      expect(bay.text()).toContain("was not deleted");
      expect(bay.text()).toContain("holding this session");
      // The row is still there, which is exactly why the notice matters.
      expect(bay.el(`session-row-${SESSION_ID}`)).not.toBeNull();
    } finally {
      bay.unmount();
    }
  });

  test("a success says nothing: the row leaving the fleet is the confirmation", () => {
    const bay = mountBay(["read", "manage"]);
    try {
      bay.press(`session-delete-${SESSION_ID}`);
      bay.press(`session-delete-confirm-${SESSION_ID}`);
      bay.frame("sessions_deleted", { results: [{ sessionId: SESSION_ID, deleted: true }] });
      expect(bay.text()).not.toContain("was not deleted");

      // The daemon's watcher pushes the new index; the row goes with it.
      bay.frame("sessions", { sessions: [] });
      expect(bay.el(`session-row-${SESSION_ID}`)).toBeNull();
    } finally {
      bay.unmount();
    }
  });
});
