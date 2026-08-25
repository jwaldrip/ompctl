/**
 * Does assistant-ui actually carry ompctl's transcript, losslessly?
 *
 * Two kinds of claim here and they need different proof:
 *
 *  - The mapping is a pure function, so it is asserted directly. No mounting.
 *  - "The library renders our rows" is a claim about the whole composition, and
 *    a component rendered from a hand-built prop cannot make it. So the render
 *    tests mount the real `AssistantRuntimeProvider`, the real
 *    `ThreadPrimitive.MessagesFlatList` and the real `ComposerPrimitive`, and
 *    assert on markup those libraries produced -- react-native-web's own
 *    `css-text-*` / `css-textinput-*` classes -- rather than on the presence of
 *    our own wrapper's test ids, which would pass against a stub.
 *
 * The load-bearing question is whether `metadata.custom` survives
 * `fromThreadMessageLike`. The whole design rests on it: if assistant-ui drops
 * it, every row loses its source entry and renders as foreign, and the
 * conversion is lossy after all. That is asserted first and hardest.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { resetWindowSize } from "./rnw.ts";

const { convertEntry, entryOf, ompStore } = await import("../src/assistant/adapter.ts");
const { OmpThread } = await import("../src/assistant/OmpThread.tsx");
const { EMPTY_SESSION, reduce } = await import("../src/session/model.ts");
const { READY_LOAD } = await import("../src/console/state.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetWindowSize();
});

const HOST = { kind: "local" as const, id: "42", spec: { kind: "local" as const } };

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agt_a",
    name: "Alpha",
    state: "idle",
    host: HOST,
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActiveAt: "2026-08-24T11:59:00.000Z",
    labels: {},
    ...overrides,
  };
}

function withUserTurn(text: string) {
  return reduce(EMPTY_SESSION, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    messageId: "u1",
  });
}

// ---------------------------------------------------------------------------
// The mapping
// ---------------------------------------------------------------------------

describe("every ompctl entry kind converts without losing its own state", () => {
  test("the source entry rides along by reference, which is what makes this lossless", () => {
    const session = withUserTurn("ship it");
    const entry = session.entries[0];
    if (entry === undefined) throw new Error("the reducer produced no entry");
    const message = convertEntry(entry);
    // Identity, not equality: a copy would mean the renderer is reading a
    // reconstruction and every field would have to be proven separately.
    expect(entryOf(message)).toBe(entry);
  });

  test("a user turn is a user message with its text", () => {
    const session = withUserTurn("ship it");
    const message = convertEntry(session.entries[0]!);
    expect(message.role).toBe("user");
    expect(message.content).toEqual([{ type: "text", text: "ship it" }]);
  });

  test("a streaming reply is running, and a tool call is what settles it", () => {
    let session = reduce(EMPTY_SESSION, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Because " },
      messageId: "m1",
    });
    const streaming = convertEntry(session.entries[0]!);
    expect(streaming.status).toMatchObject({ type: "running" });

    // What actually settles a row is a tool call, an approval, or the end of
    // the turn -- never a new message id. `findChunkTarget` documents why with
    // captured wire evidence: omp changes chunk ids mid-sentence, and keying
    // rows on that id once split a single reply into two half tokens on a real
    // device. So the open row owns the chunk whatever id it carries.
    session = reduce(session, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "next" },
      messageId: "m2",
    });
    expect(convertEntry(session.entries[0]!).status).toMatchObject({ type: "running" });
    expect(session.entries).toHaveLength(1);

    session = reduce(session, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      status: "in_progress",
    });
    expect(convertEntry(session.entries[0]!).status).toMatchObject({ type: "complete" });
  });

  test("a thought becomes a reasoning part, not prose with a flag", () => {
    const session = reduce(EMPTY_SESSION, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "weighing it" },
      messageId: "t1",
    });
    expect(convertEntry(session.entries[0]!).content).toEqual([{ type: "reasoning", text: "weighing it" }]);
  });

  test("a tool call keeps its kind, status and locations, and never its title", () => {
    // omp builds ACP's `title` from the call's own arguments, so this is the
    // shape a real frame has.
    const secret = "bash -c 'curl -H \"Authorization: Bearer sk-live-DEADBEEF\" https://x/y'";
    const session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      title: secret,
      status: "in_progress",
    });
    const message = convertEntry(session.entries[0]!);
    const part = message.content[0];
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "t1",
      toolName: "execute",
      artifact: { kind: "execute", status: "in_progress", locations: [] },
    });
    // The whole part, serialised, must not carry the command line. A renderer
    // or a screen reader that reached for `toolName` gets the kind.
    expect(JSON.stringify(part)).not.toContain("sk-live");
    expect(JSON.stringify(part)).not.toContain("curl");
    expect(message.status).toMatchObject({ type: "running" });
  });

  test("a failed tool is an error part and no longer running", () => {
    let session = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "execute",
      status: "in_progress",
    });
    session = reduce(session, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
    const part = convertEntry(session.entries[0]!).content[0];
    expect(part).toMatchObject({ type: "tool-call", isError: true });
  });

  test("a clearance folds onto the call it gates, and settles in place", () => {
    const pending = {
      kind: "approval" as const,
      id: "a1",
      requestId: "r1",
      tool: "bash",
      title: "git branch -D park/old",
      input: {},
      decision: null,
    };
    const open = convertEntry(pending);
    expect(open.content[0]).toMatchObject({ type: "tool-call", approval: { id: "r1", approved: undefined } });
    // Not a second message kind: assistant-ui models a clearance as a field on
    // the call, which is the same shape the transcript draws.
    expect(open.status).toMatchObject({ type: "requires-action" });

    const allowed = convertEntry({ ...pending, decision: "allow" });
    expect(allowed.content[0]).toMatchObject({ approval: { approved: true } });
    expect(allowed.status).toMatchObject({ type: "complete" });

    const denied = convertEntry({ ...pending, decision: "deny" });
    expect(denied.content[0]).toMatchObject({ approval: { approved: false } });
  });

  test("an unknown frame survives as itself rather than being dropped", () => {
    const session = reduce(EMPTY_SESSION, { sessionUpdate: "a_kind_from_the_future", weird: 1 });
    const message = convertEntry(session.entries[0]!);
    const part = message.content[0];
    // The `data-` escape hatch takes arbitrary JSON, so an operator still sees
    // that something happened.
    expect(part).toMatchObject({ type: "data-omp-unknown" });
    expect(JSON.stringify(part)).toContain("a_kind_from_the_future");
  });
});

describe("the store reports the session's own state, derived not remembered", () => {
  const base = {
    connection: "connected" as const,
    load: READY_LOAD,
    promptAccess: "granted" as const,
    onSubmit: () => {},
    onCancel: () => {},
  };

  test("running follows the roster, a streaming entry, or a live tool", () => {
    expect(ompStore({ ...base, agent: agent({ state: "busy" }), session: EMPTY_SESSION }).isRunning).toBe(true);

    const streaming = reduce(EMPTY_SESSION, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "x" },
      messageId: "m1",
    });
    expect(ompStore({ ...base, agent: agent(), session: streaming }).isRunning).toBe(true);

    const tooling = reduce(EMPTY_SESSION, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      status: "in_progress",
    });
    expect(ompStore({ ...base, agent: agent(), session: tooling }).isRunning).toBe(true);

    expect(ompStore({ ...base, agent: agent(), session: EMPTY_SESSION }).isRunning).toBe(false);
  });

  test("a dead link or a dead session takes the input away; a missing scope only refuses the send", () => {
    // Different gates for different facts: one removes the composer, the other
    // leaves the operator able to type while the refusal below says why it will
    // not go.
    expect(ompStore({ ...base, connection: "offline", agent: agent(), session: EMPTY_SESSION }).isDisabled).toBe(true);
    expect(ompStore({ ...base, agent: agent({ state: "stopped" }), session: EMPTY_SESSION }).isDisabled).toBe(true);

    const noScope = ompStore({ ...base, promptAccess: "missing", agent: agent(), session: EMPTY_SESSION });
    expect(noScope.isDisabled).toBe(false);
    expect(noScope.isSendDisabled).toBe(true);
  });

  test("an outstanding clearance refuses the send without disabling the pane", () => {
    const waiting = {
      ...EMPTY_SESSION,
      pendingApprovals: [{ requestId: "r1", tool: "bash", title: "bash", input: {} }],
    };
    const store = ompStore({ ...base, agent: agent(), session: waiting });
    expect(store.isSendDisabled).toBe(true);
    expect(store.isDisabled).toBe(false);
  });

  test("the composer's parts reach the daemon as prose, and an empty send is not dispatched", async () => {
    const sent: string[] = [];
    const store = ompStore({
      ...base,
      agent: agent(),
      session: EMPTY_SESSION,
      onSubmit: text => sent.push(text),
    });
    await store.onNew({ content: [{ type: "text", text: "hello" }] });
    await store.onNew({ content: [] });
    expect(sent).toEqual(["hello"]);
  });

  test("cancel reaches the client", async () => {
    let cancelled = 0;
    const store = ompStore({
      ...base,
      agent: agent(),
      session: EMPTY_SESSION,
      onCancel: () => {
        cancelled += 1;
      },
    });
    await store.onCancel();
    expect(cancelled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The real library, rendering
// ---------------------------------------------------------------------------

interface Mounted {
  host: HTMLElement;
  html: () => string;
  el: (testID: string) => HTMLElement | null;
  count: (testID: string) => number;
  render: (node: ReactNode) => void;
  unmount: () => void;
}

function mount(node: ReactNode): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(node);
  });
  return {
    host,
    html: () => host.innerHTML,
    el: testID => {
      const found = host.querySelector(`[data-testid="${testID}"]`);
      return found instanceof HTMLElement ? found : null;
    },
    count: testID => host.querySelectorAll(`[data-testid="${testID}"]`).length,
    render: next =>
      act(() => {
        root.render(next);
      }),
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function thread(session: ReturnType<typeof withUserTurn>, extra: Record<string, unknown> = {}) {
  return (
    <OmpThread
      agent={agent({ state: "busy" })}
      session={session}
      connection="connected"
      load={READY_LOAD}
      promptAccess="granted"
      onSubmit={() => {}}
      onCancel={() => {}}
      renderEntry={entry => <span data-testid={`rendered-${entry.kind}`}>{entry.id}</span>}
      {...extra}
    />
  );
}

describe("assistant-ui renders ompctl's rows, and it is really assistant-ui doing it", () => {
  test("the provider and the list mount, and the entry survives the round trip", () => {
    const session = withUserTurn("ship it");
    const view = mount(thread(session));
    try {
      expect(view.el("aui-thread")).not.toBeNull();
      expect(view.el("aui-messages")).not.toBeNull();
      // The claim that matters: the row rendered as OUR entry, which is only
      // possible if `metadata.custom` survived `fromThreadMessageLike`.
      expect(view.el("aui-row-user")).not.toBeNull();
      expect(view.el("rendered-user")).not.toBeNull();
      // Exactly one row for one entry. While `isRunning` is true the runtime
      // synthesizes its own placeholder assistant message; it carries no entry
      // and renders nothing, because `ActivityRow` in the footer already owns
      // that claim and keeps it for the whole turn. Two working indicators on
      // one turn is the defect this suppression prevents.
      expect(view.count("aui-row-user")).toBe(1);
      expect(view.el("aui-row-foreign")).toBeNull();
    } finally {
      view.unmount();
    }
  });

  test("the markup is the library's own, not our wrapper's", () => {
    const session = withUserTurn("ship it");
    const view = mount(thread(session));
    try {
      // react-native-web compiles the primitives' own View/TextInput into these
      // classes. Asserting on them is what distinguishes a real render from a
      // stub that happened to emit our test ids.
      expect(view.html()).toContain("css-view-");
      expect(view.html()).toContain("css-textinput-");
      // ComposerPrimitive.Input is a real TextInput, wired by the runtime.
      const input = view.el("aui-composer-input");
      expect(input).not.toBeNull();
      expect(input?.tagName.toLowerCase()).toBe("textarea");
    } finally {
      view.unmount();
    }
  });

  test("every entry kind reaches the list, in the order the reducer holds them", () => {
    let session = withUserTurn("look at the config");
    session = reduce(session, {
      sessionUpdate: "tool_call",
      toolCallId: "t1",
      kind: "read",
      status: "in_progress",
    });
    session = reduce(session, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "here" },
      messageId: "m1",
    });
    const view = mount(thread(session));
    try {
      expect(view.el("aui-row-user")).not.toBeNull();
      expect(view.el("aui-row-tool")).not.toBeNull();
      expect(view.el("aui-row-assistant")).not.toBeNull();

      const ids = [...view.host.querySelectorAll("[data-testid^='aui-row-']")].map(node =>
        node.getAttribute("data-testid"),
      );
      expect(ids).toEqual(["aui-row-user", "aui-row-tool", "aui-row-assistant"]);
    } finally {
      view.unmount();
    }
  });

  test("the header and footer ride the list, so pagination and the activity row survive", () => {
    const session = withUserTurn("ship it");
    const view = mount(
      thread(session, {
        header: <span data-testid="probe-header">earlier</span>,
        footer: <span data-testid="probe-footer">working</span>,
      }),
    );
    try {
      const list = view.el("aui-messages");
      const header = view.el("probe-header");
      const footer = view.el("probe-footer");
      expect(header).not.toBeNull();
      expect(footer).not.toBeNull();
      // Inside the list, which is what makes them content the follower can see
      // rather than chrome floating over the log.
      expect(list?.contains(header as Node)).toBe(true);
      expect(list?.contains(footer as Node)).toBe(true);
    } finally {
      view.unmount();
    }
  });

  test("a session switch shows the new session's rows and none of the old one's", () => {
    const alpha = withUserTurn("alpha only");
    const bravo = reduce(EMPTY_SESSION, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "bravo only" },
      messageId: "u9",
    });
    const view = mount(thread(alpha));
    try {
      expect(view.html()).toContain(alpha.entries[0]!.id);

      view.render(thread(bravo));
      expect(view.html()).toContain(bravo.entries[0]!.id);
      // The identity contract, at the adapter layer: A's row must be gone, not
      // merely below B's.
      expect(view.html()).not.toContain(alpha.entries[0]!.id);
      expect(view.count("aui-row-user")).toBe(1);
    } finally {
      view.unmount();
    }
  });

  test("an empty session renders the composer and no rows", () => {
    const view = mount(thread(EMPTY_SESSION));
    try {
      expect(view.count("aui-row-user")).toBe(0);
      expect(view.el("aui-composer-input")).not.toBeNull();
    } finally {
      view.unmount();
    }
  });
});
