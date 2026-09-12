import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { OmpdClient, type SocketCloseInfo, type SocketLike } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

import { resetWindowSize } from "./rnw.ts";

// Dynamic on purpose: bun loads a file's whole static import graph before any module
// body runs, so a static import here would pull real react-native in before ./rnw.ts.
const { CoworkSurface } = await import("../src/console/Console.tsx");
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
  typeInto(testID: string, value: string): void;
  submit(testID: string): void;
  query(testID: string): HTMLElement | null;
  unmount(): void;
}

const ROOT = "/Users/op";
const DEV = "/Users/op/dev";

const DEV_LISTING: ServerFrame = {
  t: "fs_listing",
  path: DEV,
  parent: ROOT,
  roots: [ROOT],
  entries: [],
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

function mount(target = { cwd: DEV, agentId: "agt_prior_session" }): Harness {
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

  const connection: Connection = {
    transport: "direct",
    url: "ws://127.0.0.1:7777/v1/socket",
    token: "tok_test",
    scopes: [],
  };

  act(() => {
    root.render(
      <CoworkSurface connection={connection} target={target} onOpenSession={() => {}} createClient={() => client} />,
    );
  });

  const live = socket;
  if (live === undefined) throw new Error("the client never built a socket");
  live.accept();
  live.deliver({ t: "hello", deviceId: "dev_test", agents: [] });

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
          nativeEvent: {},
        });
      });
    },
    submit: testID => {
      const input = require_(testID);
      const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
      if (key === undefined) throw new Error("no React props on the rendered input");
      const props = Reflect.get(input, key) as { onKeyDown?: (event: unknown) => void };
      if (typeof props.onKeyDown !== "function") throw new Error("the rendered input has no onKeyDown");
      act(() => {
        props.onKeyDown?.({
          key: "Enter",
          shiftKey: false,
          target: input,
          currentTarget: input,
          nativeEvent: { isComposing: false },
          preventDefault: () => {},
          stopPropagation: () => {},
          isDefaultPrevented: () => false,
        });
      });
    },
    query,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function browseToDev(h: Harness): void {
  h.press("cowork-folder-add");
  h.deliver(ROOTS_LISTING);
  h.press(`folder-picker-entry-${ROOT}`);
  h.deliver(DEV_LISTING);
}

afterEach(() => {
  resetWindowSize();
});

describe("Cowork task destination targeting", () => {
  test("a task typed after starting a container runs in the new container, not the prior session", () => {
    const h = mount({ cwd: DEV, agentId: "agt_prior_session" });
    browseToDev(h);
    h.press("folder-picker-confirm");
    h.press("cowork-container-start");

    expect(h.socket.framesOfType("agent_create")).toHaveLength(1);

    h.deliver({
      t: "agent_created",
      requestId: "req_agent_create_1",
      agent: {
        id: "agt_new_container",
        name: "dev",
        state: "idle",
        host: { kind: "container", id: "ctr_1", spec: { kind: "container" } },
        cwd: DEV,
        createdAt: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-02-01T00:00:00.000Z",
        labels: {},
      },
    });

    h.typeInto("task-composer-input", "Run container diagnostic");
    h.submit("task-composer-input");

    const taskFrames = h.socket.framesOfType("task_create");
    expect(taskFrames).toHaveLength(1);
    expect(taskFrames[0]?.agentId).toBe("agt_new_container");
    expect(taskFrames[0]?.prompt).toBe("Run container diagnostic");

    h.unmount();
  });

  test("destination banner renders the target session and updates when container starts", () => {
    const h = mount({ cwd: DEV, agentId: "agt_prior_session" });

    const destination = h.query("cowork-task-destination");
    expect(destination).not.toBeNull();
    expect(destination?.textContent).toContain("agt_prior_session");

    browseToDev(h);
    h.press("folder-picker-confirm");
    h.press("cowork-container-start");

    h.deliver({
      t: "agent_created",
      requestId: "req_agent_create_1",
      agent: {
        id: "agt_new_container",
        name: "dev",
        state: "idle",
        host: { kind: "container", id: "ctr_1", spec: { kind: "container" } },
        cwd: DEV,
        createdAt: "2026-02-01T00:00:00.000Z",
        lastActiveAt: "2026-02-01T00:00:00.000Z",
        labels: {},
      },
    });

    expect(h.query("cowork-task-destination")?.textContent).toContain("agt_new_container");

    h.unmount();
  });
});
