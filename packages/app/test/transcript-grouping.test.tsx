/**
 * Transcript tool grouping and noise reduction.
 *
 * Consecutive read-only tools collapse into a single count ("Read 3 files", "Searched 4 times").
 * Bookkeeping tools (todo, memory updates) hide behind a muted summary row by default.
 * In-progress runs stay expanded so the operator sees the live card.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolGroupEntry } from "../src/assistant/grouping.ts";
import { groupEntries, worstToolStatus } from "../src/assistant/grouping.ts";
import { EMPTY_SESSION, type Entry, type ToolEntry, type ToolStatus } from "../src/session/model.ts";

const { WithOmpTheme } = await import("./theme.tsx");
const { ToolGroupCard } = await import("../src/components/ToolGroupCard.tsx");
const { OmpThreadList, OmpThreadProvider } = await import("../src/assistant/OmpThread.tsx");
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeTool(
  id: string,
  opts: {
    toolKind?: ToolEntry["toolKind"];
    title?: string;
    status?: ToolStatus;
    input?: unknown;
    output?: string | null;
  } = {},
): ToolEntry {
  return {
    kind: "tool",
    id,
    toolKind: opts.toolKind ?? "read",
    title: opts.title ?? `tool ${id}`,
    status: opts.status ?? "completed",
    input: opts.input ?? null,
    output: opts.output ?? null,
    locations: [],
    content: [],
  };
}

function byTestID(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} rendered`);
  return element;
}

function queryByTestID(host: HTMLElement, testID: string): HTMLElement | null {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  return element instanceof HTMLElement ? element : null;
}

function press(el: HTMLElement): void {
  const key = Object.keys(el).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered pressable");
  const props = Reflect.get(el, key) as { onClick?: unknown };
  if (typeof props.onClick !== "function") throw new Error("the rendered pressable has no click handler");
  act(() => {
    el.click();
  });
}

function mount(element: ReactElement): { host: HTMLElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<WithOmpTheme>{element}</WithOmpTheme>);
  });
  return {
    host,
    root,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

const AGENT: Agent = {
  id: "agt_test",
  name: "TestAgent",
  state: "idle",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/workspace",
  createdAt: "2026-09-07T00:00:00.000Z",
  lastActiveAt: "2026-09-07T00:00:00.000Z",
  labels: {},
};

describe("grouping logic: pure function over entry list", () => {
  test("collapses a run of two or more read tools into Read N files", () => {
    const entries: Entry[] = [
      makeTool("r1", { toolKind: "read", title: "read file A" }),
      makeTool("r2", { toolKind: "read", title: "read file B" }),
      makeTool("r3", { toolKind: "read", title: "read file C" }),
    ];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);

    const group = grouped[0] as ToolGroupEntry;
    expect(group.kind).toBe("tool_group");
    expect(group.groupKind).toBe("read");
    expect(group.title).toBe("Read 3 files");
    expect(group.entries.length).toBe(3);
    expect(group.status).toBe("completed");
    expect(group.expandedDefault).toBe(false);
  });

  test("a single read tool stays untouched as a single card", () => {
    const entries: Entry[] = [makeTool("r1", { toolKind: "read", title: "read file A" })];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);
    expect(grouped[0]!.kind).toBe("tool");
  });

  test("collapses a run of searches into Searched N times", () => {
    const entries: Entry[] = [
      makeTool("s1", { toolKind: "search", title: "glob *.ts" }),
      makeTool("s2", { toolKind: "search", title: "grep symbol" }),
      makeTool("s3", { toolKind: "search", title: "grep caller" }),
      makeTool("s4", { toolKind: "search", title: "grep export" }),
    ];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);

    const group = grouped[0] as ToolGroupEntry;
    expect(group.groupKind).toBe("search");
    expect(group.title).toBe("Searched 4 times");
    expect(group.entries.length).toBe(4);
  });

  test("hides a todo run by default as N bookkeeping calls", () => {
    const entries: Entry[] = [
      makeTool("t1", { toolKind: "other", title: "todo: read specs" }),
      makeTool("t2", { toolKind: "other", title: "todo: implement" }),
      makeTool("t3", { toolKind: "other", title: "todo: test" }),
    ];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);

    const group = grouped[0] as ToolGroupEntry;
    expect(group.kind).toBe("tool_group");
    expect(group.groupKind).toBe("bookkeeping");
    expect(group.title).toBe("3 bookkeeping calls");
    expect(group.expandedDefault).toBe(false);
  });

  test("groups mixed bookkeeping tools (todo, retain, recall) into one run", () => {
    const entries: Entry[] = [
      makeTool("t1", { toolKind: "other", title: "todo: step 1" }),
      makeTool("t2", { toolKind: "other", title: "retain: remember preference" }),
      makeTool("t3", { toolKind: "other", title: "recall: find prior pattern" }),
    ];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);

    const group = grouped[0] as ToolGroupEntry;
    expect(group.groupKind).toBe("bookkeeping");
    expect(group.title).toBe("3 bookkeeping calls");
  });

  test("a single bookkeeping call is hidden by default", () => {
    const entries: Entry[] = [makeTool("t1", { toolKind: "other", title: "todo: update" })];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);

    const group = grouped[0] as ToolGroupEntry;
    expect(group.kind).toBe("tool_group");
    expect(group.title).toBe("1 bookkeeping call");
    expect(group.expandedDefault).toBe(false);
  });

  test("streaming safety: an in-progress run stays expanded", () => {
    const entries: Entry[] = [
      makeTool("r1", { toolKind: "read", status: "completed" }),
      makeTool("r2", { toolKind: "read", status: "in_progress" }),
    ];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(1);

    const group = grouped[0] as ToolGroupEntry;
    expect(group.status).toBe("in_progress");
    expect(group.expandedDefault).toBe(true);
  });

  test("worstToolStatus escalates from failed > in_progress > pending > completed", () => {
    expect(worstToolStatus([makeTool("1", { status: "completed" }), makeTool("2", { status: "failed" })])).toBe(
      "failed",
    );
    expect(
      worstToolStatus([
        makeTool("1", { status: "completed" }),
        makeTool("2", { status: "in_progress" }),
        makeTool("3", { status: "pending" }),
      ]),
    ).toBe("in_progress");
    expect(worstToolStatus([makeTool("1", { status: "completed" }), makeTool("2", { status: "pending" })])).toBe(
      "pending",
    );
    expect(worstToolStatus([makeTool("1", { status: "completed" }), makeTool("2", { status: "completed" })])).toBe(
      "completed",
    );
  });

  test("leaves user, assistant, approval, and action tools untouched", () => {
    const entries: Entry[] = [
      { kind: "user", id: "u1", text: "check files" },
      makeTool("r1", { toolKind: "read", title: "read A" }),
      makeTool("r2", { toolKind: "read", title: "read B" }),
      makeTool("e1", { toolKind: "execute", title: "bun test" }),
      {
        kind: "assistant",
        id: "a1",
        rowId: "row_a1",
        text: "all passing",
        streaming: false,
        thought: false,
      },
    ];

    const grouped = groupEntries(entries);
    expect(grouped.length).toBe(4);
    expect(grouped[0]!.kind).toBe("user");
    expect(grouped[1]!.kind).toBe("tool_group");
    expect(grouped[2]!.kind).toBe("tool");
    expect(grouped[3]!.kind).toBe("assistant");
  });
});

describe("ToolGroupCard component", () => {
  test("renders collapsed row by default and expands on press", () => {
    const group: ToolGroupEntry = {
      kind: "tool_group",
      id: "group-read-1",
      groupKind: "read",
      title: "Read 3 files",
      entries: [
        makeTool("r1", { toolKind: "read", title: "read src/a.ts" }),
        makeTool("r2", { toolKind: "read", title: "read src/b.ts" }),
        makeTool("r3", { toolKind: "read", title: "read src/c.ts" }),
      ],
      status: "completed",
      expandedDefault: false,
    };

    const mounted = mount(<ToolGroupCard group={group} />);
    try {
      expect(byTestID(mounted.host, "tool-group-title-group-read-1").textContent).toBe("Read 3 files");
      expect(byTestID(mounted.host, "tool-group-status-group-read-1").textContent).toBe("completed");

      // Members are hidden while collapsed
      expect(queryByTestID(mounted.host, "tool-group-members-group-read-1")).toBeNull();
      expect(queryByTestID(mounted.host, "tool-r1")).toBeNull();

      // Tap to expand
      press(byTestID(mounted.host, "tool-group-toggle-group-read-1"));

      // Members are visible when expanded
      expect(queryByTestID(mounted.host, "tool-group-members-group-read-1")).not.toBeNull();
      expect(byTestID(mounted.host, "tool-r1")).not.toBeNull();
      expect(byTestID(mounted.host, "tool-r2")).not.toBeNull();
      expect(byTestID(mounted.host, "tool-r3")).not.toBeNull();

      // Tap to collapse again
      press(byTestID(mounted.host, "tool-group-toggle-group-read-1"));
      expect(queryByTestID(mounted.host, "tool-group-members-group-read-1")).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("in-progress group card renders expanded by default", () => {
    const group: ToolGroupEntry = {
      kind: "tool_group",
      id: "group-live",
      groupKind: "read",
      title: "Read 2 files",
      entries: [
        makeTool("r1", { toolKind: "read", title: "read src/a.ts", status: "completed" }),
        makeTool("r2", { toolKind: "read", title: "read src/b.ts", status: "in_progress" }),
      ],
      status: "in_progress",
      expandedDefault: true,
    };

    const mounted = mount(<ToolGroupCard group={group} />);
    try {
      expect(byTestID(mounted.host, "tool-group-status-group-live").textContent).toBe("in progress");
      expect(queryByTestID(mounted.host, "tool-group-members-group-live")).not.toBeNull();
      expect(byTestID(mounted.host, "tool-r2")).not.toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});

describe("OmpThreadList renders grouped transcript", () => {
  test("renders group rows in a fixture session", () => {
    const fixtureEntries: Entry[] = [
      { kind: "user", id: "u1", text: "audit codebase" },
      makeTool("r1", { toolKind: "read", title: "read config.json" }),
      makeTool("r2", { toolKind: "read", title: "read package.json" }),
      makeTool("t1", { toolKind: "other", title: "todo: check dependencies" }),
      makeTool("t2", { toolKind: "other", title: "todo: report findings" }),
    ];

    const mounted = mount(
      <OmpThreadProvider
        agent={AGENT}
        session={{ ...EMPTY_SESSION, entries: fixtureEntries }}
        connection="connected"
        load={{ phase: "ready", generation: 0, error: null }}
        promptAccess="granted"
        canApprove={false}
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
      >
        <OmpThreadList entries={fixtureEntries} canApprove={false} onDecide={() => {}} />
      </OmpThreadProvider>,
    );

    try {
      expect(byTestID(mounted.host, "aui-thread")).not.toBeNull();
      expect(byTestID(mounted.host, "entry-user")).not.toBeNull();

      // Read group row is rendered
      expect(byTestID(mounted.host, "tool-group-group-read-r1")).not.toBeNull();
      expect(byTestID(mounted.host, "tool-group-title-group-read-r1").textContent).toBe("Read 2 files");

      // Bookkeeping group row is rendered
      expect(byTestID(mounted.host, "tool-group-group-bookkeeping-t1")).not.toBeNull();
      expect(byTestID(mounted.host, "tool-group-title-group-bookkeeping-t1").textContent).toBe("2 bookkeeping calls");
    } finally {
      mounted.unmount();
    }
  });
});
