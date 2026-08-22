/**
 * The Cowork folder binding, driven end to end: the picker and the container
 * start both ride a real `OmpdClient` over a fake socket, so the frames in
 * `socket.sent` are the frames a daemon would receive and the answers are the
 * frames a daemon would send back. Nothing here touches HTTP, which is the
 * point: a hub-paired phone has no address for the daemon's own routes.
 *
 * The mounts payload is asserted field for field against the shape
 * `packages/daemon/src/provisioner/container.ts` validates, because a shape
 * that drifts silently is a container that starts without the folder the
 * operator just picked, which is the one failure this surface must not have.
 */

import "./rnw.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act, type JSX } from "react";
import { createRoot } from "react-dom/client";

import { resetWindowSize, setWindowWidth } from "./rnw.ts";

// Dynamic on purpose, the same reason `remote-start.test.tsx` is: a static
// import of a screen resolves `react-native` before `./rnw.ts` has had a
// chance to substitute it with react-native-web. The tasks module comes from
// the same graph, so it is loaded here too rather than statically above.
const { CoworkScreen } = await import("../src/screens/CoworkScreen.tsx");
const { EMPTY_TASKS } = await import("../src/cowork/tasks.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: ClientFrame[] = [];

  onopen: (() => void) | null = null;
  onclose: ((info: SocketCloseInfo) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientFrame);
  }

  close(): void {
    this.readyState = 3;
  }

  accept(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  deliver(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  framesOfType<T extends ClientFrame["t"]>(t: T): Extract<ClientFrame, { t: T }>[] {
    const matches: Extract<ClientFrame, { t: T }>[] = [];
    for (const frame of this.sent) {
      if (frame.t === t) matches.push(frame as Extract<ClientFrame, { t: T }>);
    }
    return matches;
  }
}

interface Harness {
  host: HTMLElement;
  socket: FakeSocket;
  deliver(frame: ServerFrame): void;
  press(testID: string): void;
  query(testID: string): HTMLElement | null;
  text(testID: string): string;
  unmount(): void;
}

const ROOT = "/Users/op";
const DEV = "/Users/op/dev";

/** The listing a daemon would answer with for `/Users/op/dev`. */
const DEV_LISTING: ServerFrame = {
  t: "fs_listing",
  path: DEV,
  parent: ROOT,
  roots: [ROOT],
  entries: [
    { name: "ompctl", kind: "dir", gitRepo: true },
    { name: "scratch", kind: "dir" },
    { name: "pointer", kind: "link" },
    { name: "notes.md", kind: "file" },
  ],
  bounded: false,
};

const ROOTS_LISTING: ServerFrame = {
  t: "fs_listing",
  path: "",
  parent: null,
  roots: [ROOT],
  entries: [{ name: ROOT, kind: "dir" }],
  bounded: false,
};

const openedSessions: string[] = [];

function mount(withClient: boolean = true): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  let socket: FakeSocket | undefined;
  const client = new OmpdClient({
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_test",
    schedule: () => () => {},
    isOnline: () => true,
    createSocket: url => {
      socket = new FakeSocket(url);
      return socket;
    },
    probeCredential: () => Promise.resolve("unknown"),
  });
  client.start();
  const live = socket;
  if (live === undefined) throw new Error("the client never built a socket");
  live.accept();
  live.deliver({ t: "hello", deviceId: "dev_test", agents: [] });

  function Screen(): JSX.Element {
    return (
      <CoworkScreen
        tasks={EMPTY_TASKS}
        skills={[]}
        connectors={[]}
        onStartTask={() => {}}
        onInvokeSkill={() => {}}
        onOpenSession={agentId => openedSessions.push(agentId)}
        {...(withClient ? { client } : {})}
      />
    );
  }

  act(() => {
    root.render(<Screen />);
  });

  const query = (testID: string): HTMLElement | null => {
    const element = host.querySelector(`[data-testid="${testID}"]`);
    return element instanceof HTMLElement ? element : null;
  };
  const require_ = (testID: string): HTMLElement => {
    const element = query(testID);
    if (element === null) throw new Error(`no ${testID} rendered`);
    return element;
  };

  return {
    host,
    socket: live,
    deliver: frame => {
      act(() => {
        live.deliver(frame);
      });
    },
    press: testID => {
      act(() => {
        require_(testID).click();
      });
    },
    query,
    text: testID => require_(testID).textContent ?? "",
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/** Open the picker and navigate it until `/Users/op/dev` is the directory on screen. */
function browseToDev(h: Harness): void {
  h.press("cowork-folder-add");
  h.deliver(ROOTS_LISTING);
  h.press(`folder-picker-entry-${ROOT}`);
  h.deliver(DEV_LISTING);
}

// ---------------------------------------------------------------------------
// The start rides the same socket the picker does: no fetch stub, because
// there is no fetch left to stub.
// ---------------------------------------------------------------------------

/** A fetch attempt from this surface is a regression, so any call throws rather than answering. */
const realFetch = globalThis.fetch;

beforeEach(() => {
  const forbidden: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      throw new Error(`the cowork surface must not reach for HTTP: ${String(input)}`);
    },
    { preconnect: () => {} },
  );
  globalThis.fetch = forbidden;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetWindowSize();
  openedSessions.length = 0;
});

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

describe("the folder picker", () => {
  test("asks for the roots on open and renders a directory's entries with their kinds", () => {
    const h = mount();
    h.press("cowork-folder-add");

    expect(h.socket.framesOfType("fs_list")).toEqual([{ t: "fs_list" }]);

    h.deliver(ROOTS_LISTING);
    h.press(`folder-picker-entry-${ROOT}`);
    expect(h.socket.framesOfType("fs_list").at(-1)).toEqual({ t: "fs_list", path: ROOT });

    h.deliver(DEV_LISTING);
    expect(h.text("folder-picker-title")).toBe("dev");
    expect(h.text("folder-picker-path")).toBe(DEV);
    expect(h.query("folder-picker-entry-ompctl")).not.toBeNull();
    expect(h.query("folder-picker-entry-scratch")).not.toBeNull();
    expect(h.query("folder-picker-entry-pointer")).not.toBeNull();
    expect(h.query("folder-picker-entry-notes.md")).not.toBeNull();

    h.unmount();
  });

  test("never offers a symlink or a file, so a browse cannot die mid-path", () => {
    // A tap that is refused must be refused by the row (disabled), not by an
    // error two taps later: this is the "refuse to offer what you cannot
    // list" rule, proven by the absence of the frame a daemon would refuse.
    const h = mount();
    browseToDev(h);
    const before = h.socket.framesOfType("fs_list").length;
    h.press("folder-picker-entry-pointer");
    h.press("folder-picker-entry-notes.md");
    expect(h.socket.framesOfType("fs_list").length).toBe(before);
    expect(h.text("folder-picker-entry-pointer")).toContain("not followed");

    h.unmount();
  });

  test("walks up one level to the parent", () => {
    const h = mount();
    browseToDev(h);

    h.press("folder-picker-up");
    expect(h.socket.framesOfType("fs_list").at(-1)).toEqual({ t: "fs_list", path: ROOT });

    h.unmount();
  });

  test("names an empty directory rather than showing a blank list", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-entry-scratch");
    h.deliver({ t: "fs_listing", path: `${DEV}/scratch`, parent: DEV, roots: [ROOT], entries: [], bounded: false });

    expect(h.text("folder-picker-empty")).toContain("Nothing in here.");

    h.unmount();
  });

  test("shows a listing refusal by name and clears it on the next request", () => {
    const h = mount();
    browseToDev(h);

    h.deliver({ t: "error", code: "out_of_roots", message: "/etc resolves outside this daemon's directories" });
    expect(h.text("folder-picker-notice")).toContain("outside this daemon's directories");

    h.press("folder-picker-refresh");
    expect(h.query("folder-picker-notice")).toBeNull();

    h.unmount();
  });

  test("does not offer a binding at the roots view and says why", () => {
    const h = mount();
    h.press("cowork-folder-add");
    h.deliver(ROOTS_LISTING);

    h.press("folder-picker-confirm");

    // Still in the picker, nothing bound: the roots view is a menu, and the
    // control answered the tap with its reason rather than a path.
    expect(h.query("folder-picker-screen")).not.toBeNull();
    expect(h.query(`cowork-folder-${ROOT}`)).toBeNull();
    expect(h.text("folder-picker-confirm-hint")).toContain("Open a directory first");

    h.unmount();
  });

  test("leaves without binding when back is pressed", () => {
    const h = mount();
    browseToDev(h);

    h.press("folder-picker-back");
    expect(h.query("folder-picker-screen")).toBeNull();
    expect(h.query(`cowork-folder-${DEV}`)).toBeNull();

    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Binding on the cowork screen
// ---------------------------------------------------------------------------

describe("binding on the cowork screen", () => {
  test("a selection lands on the bound list and closes the picker", () => {
    const h = mount();
    browseToDev(h);

    h.press("folder-picker-confirm");

    expect(h.query("folder-picker-screen")).toBeNull();
    expect(h.text(`cowork-folder-${DEV}`)).toContain(DEV);
    // The mode the daemon will mount is on the row, not buried in a payload.
    expect(h.text(`cowork-folder-${DEV}`)).toContain("ro");

    h.unmount();
  });

  test("an unbind removes the folder and the empty state returns", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press(`cowork-folder-unbind-${DEV}`);

    expect(h.query(`cowork-folder-${DEV}`)).toBeNull();
    expect(h.text("cowork-folders-empty")).toContain("Nothing bound");

    h.unmount();
  });

  test("binding the same folder twice mounts it once", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");
    browseToDev(h);
    h.press("folder-picker-confirm");

    expect(h.host.querySelectorAll(`[data-testid="cowork-folder-${DEV}"]`).length).toBe(1);

    h.unmount();
  });

  test("draws no binding section without a client", () => {
    const h = mount(false);

    expect(h.query("cowork-folders")).toBeNull();

    h.unmount();
  });

  test("renders the binding on the phone layout too", () => {
    setWindowWidth(390);
    const h = mount();

    expect(h.query("cowork-folders")).not.toBeNull();
    expect(h.query("cowork-folder-add")).not.toBeNull();

    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// Starting the container
// ---------------------------------------------------------------------------

describe("starting the container", () => {
  test("sends the exact mounts shape the provisioner validates and reports the agent", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");

    // Exactly what container.ts validates: absolute hostPath, explicit mode,
    // every mount at its identical path inside, first bound folder as cwd --
    // carried on the socket, so a hub pairing reaches it too.
    expect(h.socket.framesOfType("agent_create")).toEqual([
      {
        t: "agent_create",
        name: "dev",
        cwd: DEV,
        host: { kind: "container", mounts: [{ hostPath: DEV, mode: "ro" }] },
      },
    ]);

    h.deliver({
      t: "agent_created",
      agent: {
        id: "agt_test",
        name: "dev",
        state: "idle",
        host: { kind: "container", id: "ctr_1" },
        cwd: DEV,
        createdAt: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-02-01T00:00:00.000Z",
        labels: {},
      },
    });

    h.press("cowork-container-open");
    expect(openedSessions).toEqual(["agt_test"]);

    h.unmount();
  });

  test("mounts every bound folder, in binding order, with the first as cwd", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");
    // A second binding, made by browsing back up to the root and confirming it.
    h.press("cowork-folder-add");
    h.deliver(ROOTS_LISTING);
    h.press(`folder-picker-entry-${ROOT}`);
    h.deliver({ t: "fs_listing", path: ROOT, parent: null, roots: [ROOT], entries: [], bounded: false });
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");

    expect(h.socket.framesOfType("agent_create").at(-1)).toEqual({
      t: "agent_create",
      name: "dev",
      cwd: DEV,
      host: {
        kind: "container",
        mounts: [
          { hostPath: DEV, mode: "ro" },
          { hostPath: ROOT, mode: "ro" },
        ],
      },
    });

    h.unmount();
  });

  test("a scope refusal is a named state, not a silent one", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    h.deliver({ t: "error", code: "unauthorized", message: "agent_create requires manage scope" });

    expect(h.text("cowork-container-refused")).toContain("manage scope");
    // Not retryable: the reason says so without promising another attempt.
    expect(h.text("cowork-container-refused")).not.toContain("Worth trying again");

    h.unmount();
  });

  test("a validation refusal carries the daemon's own reason", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    h.deliver({
      t: "error",
      code: "agent_create_failed",
      message: 'mount path must be absolute, got "etc"',
    });

    expect(h.text("cowork-container-refused")).toContain("the daemon refused the mounts");
    expect(h.text("cowork-container-refused")).toContain("absolute");

    h.unmount();
  });

  test("a dead link is named and marked worth retrying", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    // What the client itself reports when a frame cannot leave: `agent_create`
    // is one of the losses it makes visible, so the surface hears it as an
    // error rather than waiting forever on an answer that will never come.
    h.socket.close();
    h.press("cowork-container-start");

    expect(h.text("cowork-container-refused")).toContain("could not reach the daemon");
    expect(h.text("cowork-container-refused")).toContain("Worth trying again");

    h.unmount();
  });

  test("a replica names its own limit rather than pretending to start", () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    h.deliver({
      t: "error",
      code: "replica",
      message: "this daemon is a replica; create the agent where its directories live",
    });

    expect(h.text("cowork-container-refused")).toContain("replica");

    h.unmount();
  });

  test("answers a start with nothing bound by name rather than by silence", () => {
    const h = mount();

    h.press("cowork-container-start");

    expect(h.text("cowork-container-refused")).toContain("Bind a folder first");
    expect(h.socket.framesOfType("agent_create")).toEqual([]);

    h.unmount();
  });
});
