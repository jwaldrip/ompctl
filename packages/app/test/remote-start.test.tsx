/**
 * The browse-and-start screen, driven by a real `OmpdClient` over a fake socket.
 *
 * The client is the real one on purpose. The three things this screen has to
 * get right are all about the wire -- ask for a directory, start a session at
 * the one on screen, clone into it -- so a test that stubbed the client would
 * be asserting that this file calls its own stub. With the socket faked
 * instead, the frames in `socket.sent` are the frames a daemon would receive.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { RemoteStartState } from "../src/remote/model.ts";
import type { RemoteStartActions } from "../src/remote/useRemoteStart.ts";

// Dynamic on purpose, the same reason `fleet-screen.test.tsx` is: a static
// import of a screen resolves `react-native` before `./rnw.ts` has had a
// chance to substitute it with react-native-web. The hook comes from the same
// graph, so it is loaded here too rather than statically above.
const { RemoteStartScreen } = await import("../src/screens/RemoteStartScreen.tsx");
const { useRemoteStart } = await import("../src/remote/useRemoteStart.ts");

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
  root: Root;
  socket: FakeSocket;
  /** Deliver a server frame inside `act`, so React has rendered before assertions. */
  deliver(frame: ServerFrame): void;
  press(testID: string): void;
  typeInto(testID: string, value: string): void;
  query(testID: string): HTMLElement | null;
  text(testID: string): string;
  unmount(): void;
}

const ROOT = "/Users/op";
const DEV = "/Users/op/dev";

/** A real client on a fake socket, already accepted and greeted. */
function connectedClient(): { client: OmpdClient; socket: FakeSocket } {
  let socket: FakeSocket | undefined;
  const client = new OmpdClient({
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_test",
    // No scheduler work is exercised here; the socket is brought up by hand.
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
  return { client, socket: live };
}

function mount(options: { onOpened?: (agentId: string) => void } = {}): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const { client, socket: live } = connectedClient();

  act(() => {
    root.render(
      <RemoteStartScreen
        client={client}
        onBack={() => {}}
        {...(options.onOpened ? { onOpened: options.onOpened } : {})}
      />,
    );
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
    root,
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
    // The same shape every other app suite uses to drive a `TextInput`: React
    // Native's `onChangeText` arrives through RNW's `onChange`.
    typeInto: (testID, value) => {
      const input = require_(testID);
      const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
      if (key === undefined) throw new Error("no React props on the rendered input");
      const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
      if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
      act(() => {
        (input as HTMLInputElement).value = value;
        props.onChange?.({
          target: input,
          currentTarget: input,
          nativeEvent: { text: value },
          preventDefault: () => {},
          stopPropagation: () => {},
        });
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

interface Probe {
  socket: FakeSocket;
  state: () => RemoteStartState;
  /** Run one gesture against the live actions, inside `act`. */
  act: (run: (actions: RemoteStartActions) => void) => void;
  deliver: (frame: ServerFrame) => void;
  unmount: () => void;
}

/**
 * The hook with no screen in front of it.
 *
 * Renders nothing and holds the latest `[state, actions]` pair, so a test can
 * call an action the screen draws disabled. That is not a way around the
 * screen's own guard: it is the only way to see the hook's, which is what
 * protects a caller that has no disabled control in front of it.
 */
function mountProbe(): Probe {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const { client, socket } = connectedClient();
  let latest: [RemoteStartState, RemoteStartActions] | null = null;

  function Held(): null {
    latest = useRemoteStart(client);
    return null;
  }

  act(() => {
    root.render(<Held />);
  });

  const held = (): [RemoteStartState, RemoteStartActions] => {
    if (latest === null) throw new Error("the probe never rendered");
    return latest;
  };

  return {
    socket,
    state: () => held()[0],
    act: run => {
      act(() => {
        run(held()[1]);
      });
    },
    deliver: frame => {
      act(() => {
        socket.deliver(frame);
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

describe("the browse screen", () => {
  test("asks for the roots on mount and opens one by its absolute path", () => {
    const h = mount();

    expect(h.socket.framesOfType("fs_list")).toEqual([{ t: "fs_list" }]);

    h.deliver({
      t: "fs_listing",
      path: "",
      parent: null,
      roots: [ROOT],
      entries: [{ name: ROOT, kind: "dir" }],
      bounded: false,
    });
    h.press(`browse-entry-${ROOT}`);

    expect(h.socket.framesOfType("fs_list")).toEqual([{ t: "fs_list" }, { t: "fs_list", path: ROOT }]);
    h.unmount();
  });

  test("renders a directory's entries and marks the git working trees", () => {
    const h = mount();
    h.deliver(DEV_LISTING);

    expect(h.text("browse-title")).toBe("dev");
    expect(h.text("browse-path")).toBe(DEV);
    expect(h.query("browse-entry-ompctl")).not.toBeNull();
    expect(h.query("browse-entry-notes.md")).not.toBeNull();
    // The marking is the point of the screen: a repo row says so, and a plain
    // directory next to it does not.
    expect(h.query("browse-repo-ompctl")).not.toBeNull();
    expect(h.query("browse-repo-scratch")).toBeNull();

    h.unmount();
  });

  test("drills into a directory by name and walks back up to the parent", () => {
    const h = mount();
    h.deliver(DEV_LISTING);

    h.press("browse-entry-ompctl");
    expect(h.socket.framesOfType("fs_list").at(-1)).toEqual({ t: "fs_list", path: `${DEV}/ompctl` });

    h.deliver({ t: "fs_listing", path: `${DEV}/ompctl`, parent: DEV, roots: [ROOT], entries: [], bounded: false });
    h.press("browse-up");
    expect(h.socket.framesOfType("fs_list").at(-1)).toEqual({ t: "fs_list", path: DEV });

    h.unmount();
  });

  test("says a listing was bounded rather than showing a page as a whole directory", () => {
    const h = mount();
    h.deliver({
      t: "fs_listing",
      path: DEV,
      parent: ROOT,
      roots: [ROOT],
      entries: [{ name: "one", kind: "file" }],
      bounded: true,
    });

    expect(h.text("browse-bounded")).toContain("holds more than one screenful");

    h.unmount();
  });

  test("shows a refusal the daemon sent, and clears it on the next request", () => {
    const h = mount();
    h.deliver({ t: "error", code: "out_of_roots", message: "/etc resolves outside this daemon's directories" });

    expect(h.text("browse-notice")).toContain("outside this daemon's directories");

    h.press("browse-refresh");
    expect(h.query("browse-notice")).toBeNull();

    h.unmount();
  });
});

describe("starting a session from the browser", () => {
  test("sends session_create for the directory on screen and reports the agent the daemon made", () => {
    const opened: string[] = [];
    const h = mount({ onOpened: agentId => opened.push(agentId) });
    h.deliver(DEV_LISTING);

    h.press("browse-start-here");

    expect(h.socket.framesOfType("session_create")).toEqual([{ t: "session_create", cwd: DEV }]);

    h.deliver({
      t: "session_opened",
      sessionId: "019fee60-2c7a-7000-9fd5-7439c7bf3dd2",
      agentId: "agt_0123456789abcdef",
    });
    expect(opened).toEqual(["agt_0123456789abcdef"]);

    h.unmount();
  });

  test("draws the start control disabled at the roots view, where there is no directory to start in", () => {
    const h = mount();
    h.deliver({
      t: "fs_listing",
      path: "",
      parent: null,
      roots: [ROOT],
      entries: [{ name: ROOT, kind: "dir" }],
      bounded: false,
    });

    h.press("browse-start-here");

    expect(h.query("browse-start-here")?.hasAttribute("disabled")).toBe(true);
    expect(h.socket.framesOfType("session_create")).toEqual([]);
    h.unmount();
  });
});

describe("cloning from the browser", () => {
  test("sends repo_clone with the directory on screen as the parent, then follows the clone", () => {
    const h = mount();
    h.deliver(DEV_LISTING);

    h.typeInto("browse-clone-url", "  git@github.com:jwaldrip/ompctl.git  ");
    h.press("browse-clone-here");

    expect(h.socket.framesOfType("repo_clone")).toEqual([
      { t: "repo_clone", url: "git@github.com:jwaldrip/ompctl.git", parent: DEV },
    ]);
    // The panel appears on the request, not on the first frame back: a tap that
    // showed nothing until the daemon answered would read as a tap that missed.
    expect(h.text("clone-url")).toBe("git@github.com:jwaldrip/ompctl.git");

    h.deliver({ t: "clone_progress", cloneId: "cln_0123456789abcdef", line: "Receiving objects:  61%" });
    expect(h.text("clone-lines")).toContain("Receiving objects:  61%");

    h.deliver({ t: "clone_done", cloneId: "cln_0123456789abcdef", path: `${DEV}/ompctl` });
    expect(h.text("clone-destination")).toBe(`${DEV}/ompctl`);

    // The obvious next move: open what was just cloned.
    h.press("clone-open");
    expect(h.socket.framesOfType("fs_list").at(-1)).toEqual({ t: "fs_list", path: `${DEV}/ompctl` });

    h.unmount();
  });

  test("shows a refused clone inside the panel that started it", () => {
    const h = mount();
    h.deliver(DEV_LISTING);
    h.typeInto("browse-clone-url", "https://token@github.com/jwaldrip/ompctl.git");
    h.press("browse-clone-here");

    h.deliver({ t: "error", code: "credential_in_url", message: "that clone url carries a credential" });

    expect(h.text("clone-failure")).toContain("carries a credential");
    // Not in the list's own notice: a clone that failed belongs to the clone.
    expect(h.query("browse-notice")).toBeNull();

    h.unmount();
  });

  test("sends nothing when the url field is empty", () => {
    const h = mount();
    h.deliver(DEV_LISTING);

    expect(h.query("browse-clone-here")?.hasAttribute("disabled")).toBe(true);
    h.press("browse-clone-here");

    expect(h.socket.framesOfType("repo_clone")).toEqual([]);
    h.unmount();
  });
});

// ---------------------------------------------------------------------------
// The hook's own guards
//
// The screen draws both actions disabled with no directory chosen, which is
// what an operator meets -- and which also means a test that clicks them
// cannot observe the hook's own refusal behind that control. These drive the
// hook directly, because the guard is what protects every other caller: a
// navigator's menu item, or any future surface that reaches for these actions
// without a disabled button in front of them.
// ---------------------------------------------------------------------------

describe("the remote-start actions", () => {
  test("refuse to start or clone with no directory chosen, and say why", () => {
    const probe = mountProbe();

    probe.act(actions => actions.startHere());
    probe.act(actions => actions.cloneHere("https://github.com/jwaldrip/ompctl.git"));

    expect(probe.socket.framesOfType("session_create")).toEqual([]);
    expect(probe.socket.framesOfType("repo_clone")).toEqual([]);
    expect(probe.state().notice).toContain("Open a directory first");

    probe.unmount();
  });

  test("refuse a clone with no url, with a directory open", () => {
    const probe = mountProbe();
    probe.deliver(DEV_LISTING);

    probe.act(actions => actions.cloneHere("   "));

    expect(probe.socket.framesOfType("repo_clone")).toEqual([]);
    expect(probe.state().notice).toContain("needs a repository url");
    expect(probe.state().clone).toBeNull();

    probe.unmount();
  });

  test("send a session name when one is given", () => {
    const probe = mountProbe();
    probe.deliver(DEV_LISTING);

    probe.act(actions => actions.startHere("deploy checks"));

    expect(probe.socket.framesOfType("session_create")).toEqual([
      { t: "session_create", cwd: DEV, name: "deploy checks" },
    ]);

    probe.unmount();
  });
});
