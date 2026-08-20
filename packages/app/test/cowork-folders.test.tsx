/**
 * The Cowork folder binding, driven end to end: the picker rides a real
 * `OmpdClient` over a fake socket (so the frames in `socket.sent` are the
 * frames a daemon would receive), and the container start rides a stubbed
 * `fetch` that records the exact body posted to `/v1/agents`.
 *
 * The mounts payload is asserted byte for byte against the shape
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

import type { Connection } from "../src/platform/connection.ts";
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

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_test",
  scopes: ["read", "prompt", "manage"],
};

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

function mount(withConnection: boolean = true): Harness {
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
        {...(withConnection ? { connection: CONNECTION, client } : {})}
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
// The fetch the container start rides, captured rather than dialed.
// ---------------------------------------------------------------------------

const realFetch = globalThis.fetch;
let posted: Array<{ url: string; init: RequestInit }> = [];
let answer: Response = new Response(JSON.stringify({ agent: { id: "agt_test" } }), { status: 201 });

beforeEach(() => {
  posted = [];
  answer = new Response(JSON.stringify({ agent: { id: "agt_test" } }), { status: 201 });
  // Contextually typed as `typeof fetch` by the annotation rather than cast
  // to it: the parameters then follow whatever fetch's real type is here
  // (Bun's, not lib.dom's), with no hand-restated signature to drift. Bun's
  // fetch carries a required `preconnect` member, so the fake is a whole
  // fetch-shaped object: the capturing function plus a no-op preconnect.
  const capture: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      posted.push({ url: String(input), init: init ?? {} });
      return answer;
    },
    { preconnect: () => {} },
  );
  globalThis.fetch = capture;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  resetWindowSize();
  openedSessions.length = 0;
});

/** Let the start's fetch chain settle before asserting on the named state. */
async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

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

  test("draws no binding section without a connection", () => {
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
  test("posts the exact mounts shape the provisioner validates and reports the agent", async () => {
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    await settle();

    expect(posted.length).toBe(1);
    expect(posted[0]?.url).toBe("http://127.0.0.1:7777/v1/agents");
    const headers = new Headers(posted[0]?.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok_test");
    // Exactly what container.ts validates: absolute hostPath, explicit mode,
    // every mount at its identical path inside, first bound folder as cwd.
    expect(JSON.parse(String(posted[0]?.init.body))).toEqual({
      name: "dev",
      cwd: DEV,
      host: { kind: "container", mounts: [{ hostPath: DEV, mode: "ro" }] },
    });

    h.press("cowork-container-open");
    expect(openedSessions).toEqual(["agt_test"]);

    h.unmount();
  });

  test("mounts every bound folder, in binding order, with the first as cwd", async () => {
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
    await settle();

    expect(JSON.parse(String(posted[0]?.init.body))).toEqual({
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

  test("a scope refusal is a named state, not a silent one", async () => {
    answer = new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    await settle();

    expect(h.text("cowork-container-refused")).toContain("manage scope");
    // Not retryable: the reason says so without promising another attempt.
    expect(h.text("cowork-container-refused")).not.toContain("Worth trying again");

    h.unmount();
  });

  test("a validation refusal carries the daemon's own reason", async () => {
    answer = new Response(JSON.stringify({ error: 'mount path must be absolute, got "etc"' }), { status: 500 });
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    await settle();

    expect(h.text("cowork-container-refused")).toContain("the daemon refused the mounts");
    expect(h.text("cowork-container-refused")).toContain("absolute");

    h.unmount();
  });

  test("a dead link is named and marked worth retrying", async () => {
    // Annotated like the capture stub above: the throw is the whole function,
    // and the no-op preconnect is what makes it a whole `typeof fetch`.
    const deadLink: typeof fetch = Object.assign(
      async () => {
        throw new Error("connection refused");
      },
      { preconnect: () => {} },
    );
    globalThis.fetch = deadLink;
    const h = mount();
    browseToDev(h);
    h.press("folder-picker-confirm");

    h.press("cowork-container-start");
    await settle();

    expect(h.text("cowork-container-refused")).toContain("could not reach the daemon");
    expect(h.text("cowork-container-refused")).toContain("Worth trying again");

    h.unmount();
  });

  test("answers a start with nothing bound by name rather than by silence", async () => {
    const h = mount();

    h.press("cowork-container-start");
    await settle();

    expect(h.text("cowork-container-refused")).toContain("Bind a folder first");
    expect(posted.length).toBe(0);

    h.unmount();
  });
});
