/**
 * The same top-history machine, on the other surface that has a log.
 *
 * `TerminalSessionScreen` is not a variant of `Transcript`: its own `LogRow`
 * union, its own `row.key` key space, its own cursor on `tui.historyCursor`,
 * and live hints interleaved with history that are not history. It had the
 * manual button and none of the automatic behaviour, so every rule the owned
 * transcript gained had to be re-proved here rather than assumed to transfer.
 *
 * Driven through the props the screen actually hands its list, for the reason
 * the transcript suite states: the defects were in which callbacks get passed
 * and what happens when they fire, in what order.
 */

import "./rnw.ts";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TranscriptTailMessage } from "@ompd/core/contracts";
import { act, type ComponentType, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TuiSessionState } from "../src/console/state.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface ListProps {
  ref?: ((list: unknown) => void) | { current: unknown };
  onScroll?: (event: unknown) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  scrollEventThrottle?: number;
  maintainVisibleContentPosition?: { minIndexForVisible?: number; autoscrollToTopThreshold?: number };
  ListHeaderComponent?: unknown;
  data?: readonly unknown[];
}

let listProps: ListProps | null = null;
let platformOS = "android";
/**
 * `mock.module` is process-wide and permanent, so a recorder that always
 * blanked the list would take out every other suite loaded after this file.
 * Off, it renders the real list and records nothing.
 */
let capturing = false;

const actual = await import("react-native");
/**
 * Cast at the seam: `FlatList`'s props are generic over its item type and this
 * pass-through never reads them.
 */
const RealFlatList = actual.FlatList as unknown as ComponentType<Record<string, unknown>>;

function RecordingList(props: ListProps): ReactElement | null {
  if (!capturing) return createElement(RealFlatList, props as Record<string, unknown>);
  listProps = props;
  return null;
}

mock.module("react-native", () => ({
  ...actual,
  Platform: {
    get OS() {
      return platformOS;
    },
    select: (options: Record<string, unknown>) => options[platformOS] ?? options.default,
  },
  FlatList: RecordingList,
}));

const { TerminalSessionScreen } = await import("../src/screens/TerminalSessionScreen.tsx");

interface ListRecorder {
  handle: {
    scrollToOffset: (options: { offset: number; animated?: boolean }) => void;
    scrollToEnd: (options?: { animated?: boolean }) => void;
  };
  scrollToOffset: Array<{ offset: number; animated?: boolean }>;
  scrollToEnd: Array<{ animated?: boolean } | undefined>;
}

function recorderList(): ListRecorder {
  const scrollToOffset: Array<{ offset: number; animated?: boolean }> = [];
  const scrollToEnd: Array<{ animated?: boolean } | undefined> = [];
  return {
    handle: {
      scrollToOffset: options => scrollToOffset.push(options),
      scrollToEnd: options => scrollToEnd.push(options),
    },
    scrollToOffset,
    scrollToEnd,
  };
}

/** One served turn. `at` is what the row's own key is built from. */
function turn(id: string, role: "user" | "assistant" = "assistant"): TranscriptTailMessage {
  return { role, text: `turn ${id}`, at: `2026-08-24T00:00:${id.padStart(2, "0")}.000Z` };
}

function tuiState(overrides: Partial<TuiSessionState> = {}): TuiSessionState {
  return {
    sent: null,
    busy: false,
    awaitingReply: false,
    reply: null,
    replyUnavailable: false,
    refusal: null,
    refusalKind: null,
    history: [turn("1"), turn("2")],
    historyCursor: 900,
    historyLoadingEarlier: false,
    ...overrides,
  };
}

interface Harness {
  render: (tui: Partial<TuiSessionState>) => void;
  props: () => ListProps;
  loads: () => number;
  list: ListRecorder;
  scrollTo: (y: number) => void;
  contentSize: (height: number) => void;
  pressLoadEarlier: () => void;
  unmount: () => void;
}

function mount(initial: Partial<TuiSessionState> = {}): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const list = recorderList();
  let calls = 0;
  let tui = tuiState(initial);

  const draw = (): void => {
    act(() => {
      root.render(
        <TerminalSessionScreen
          title="terminal work"
          cwd="/Users/op/dev/src/github.com/op/alpha"
          status="live-tui"
          promptAccess="granted"
          load={{ phase: "ready", generation: 0, error: null }}
          tui={tui}
          connection="connected"
          onBack={() => {}}
          onLoadEarlier={() => {
            calls += 1;
          }}
          onSubmit={() => {}}
        />,
      );
    });
  };

  draw();
  act(() => {
    const attach = listProps?.ref;
    if (typeof attach === "function") attach(list.handle);
    else if (attach !== undefined && attach !== null) attach.current = list.handle;
  });

  return {
    render: next => {
      tui = { ...tui, ...next };
      draw();
    },
    props: () => {
      if (listProps === null) throw new Error("the terminal log was never rendered");
      return listProps;
    },
    loads: () => calls,
    list,
    scrollTo: y => {
      act(() => {
        listProps?.onScroll?.({
          nativeEvent: {
            contentOffset: { x: 0, y },
            contentSize: { width: 390, height: 4000 },
            layoutMeasurement: { width: 390, height: 800 },
          },
        });
      });
    },
    contentSize: height => {
      act(() => {
        listProps?.onContentSizeChange?.(390, height);
      });
    },
    pressLoadEarlier: () => {
      const press = findPress(listProps?.ListHeaderComponent);
      if (press === null) throw new Error("no Load earlier control was rendered");
      act(() => {
        press();
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

function findPress(node: unknown): (() => void) | null {
  if (node === null || typeof node !== "object") return null;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props === undefined) return null;
  if (props.testID === "history-load-earlier" && typeof props.onPress === "function") {
    return props.onPress as () => void;
  }
  const children = props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findPress(child);
    if (found !== null) return found;
  }
  return null;
}

beforeEach(() => {
  listProps = null;
  platformOS = "android";
  capturing = true;
});

afterAll(() => {
  capturing = false;
});

describe("the terminal log asks for older turns when the reader reaches the top", () => {
  test("the screen hands its list the pagination callbacks at all", () => {
    // The failure this pins: before the shared hook, this list received only
    // the follower's handlers and a manual header, so no scroll near the top
    // could ever ask for anything.
    const h = mount();
    try {
      const props = h.props();
      expect(typeof props.onScroll).toBe("function");
      expect(typeof props.onContentSizeChange).toBe("function");
      expect(typeof props.ref).toBe("function");
      expect(props.scrollEventThrottle).toBeGreaterThan(0);
      // The prepend option, and only its safe half.
      expect(props.maintainVisibleContentPosition?.minIndexForVisible).toBe(0);
      expect(props.maintainVisibleContentPosition?.autoscrollToTopThreshold).toBeUndefined();
    } finally {
      h.unmount();
    }
  });

  test("reaching the top asks once, and staying there does not ask again", () => {
    const h = mount();
    try {
      h.scrollTo(4);
      expect(h.loads()).toBe(1);
      // Same cursor, more scroll frames: the lock is the cursor, not a boolean.
      h.scrollTo(2);
      h.scrollTo(0);
      expect(h.loads()).toBe(1);
    } finally {
      h.unmount();
    }
  });

  test("a page that failed without moving the cursor stays locked until the button", () => {
    const h = mount();
    try {
      h.scrollTo(0);
      expect(h.loads()).toBe(1);

      // The request settled and the cursor did not move: the daemon refused,
      // or answered an empty page. Scrolling must not re-fire.
      h.render({ historyLoadingEarlier: false, historyCursor: 900 });
      h.scrollTo(0);
      h.scrollTo(6);
      expect(h.loads()).toBe(1);

      // The button is the deliberate retry.
      h.pressLoadEarlier();
      expect(h.loads()).toBe(2);
    } finally {
      h.unmount();
    }
  });

  test("a cursor that moved unlocks the next automatic page", () => {
    const h = mount();
    try {
      h.scrollTo(0);
      expect(h.loads()).toBe(1);
      h.render({ history: [turn("0"), turn("1"), turn("2")], historyCursor: 400 });
      h.scrollTo(0);
      expect(h.loads()).toBe(2);
    } finally {
      h.unmount();
    }
  });

  test("a null cursor means the file has no more, so nothing is asked and the button is gone", () => {
    const h = mount({ historyCursor: null });
    try {
      h.scrollTo(0);
      expect(h.loads()).toBe(0);
      expect(findPress(h.props().ListHeaderComponent)).toBeNull();
    } finally {
      h.unmount();
    }
  });

  test("a page already in flight is not asked for again", () => {
    const h = mount({ historyLoadingEarlier: true });
    try {
      h.scrollTo(0);
      expect(h.loads()).toBe(0);
      // And the button is inert while one is outstanding.
      h.pressLoadEarlier();
      expect(h.loads()).toBe(0);
    } finally {
      h.unmount();
    }
  });
});

describe("the terminal log keeps the reader's place across a prepend", () => {
  test("a prepend restores the offset by the height it gained, once", () => {
    const h = mount();
    try {
      h.contentSize(4000);
      h.scrollTo(0);
      expect(h.loads()).toBe(1);

      // The older page lands: row zero is a different row now.
      h.render({ history: [turn("0"), turn("1"), turn("2")], historyCursor: 400 });
      h.contentSize(5200);
      expect(h.list.scrollToOffset).toEqual([{ offset: 1200, animated: false }]);

      // Consumed. Later growth does not move the reader again.
      h.contentSize(5600);
      expect(h.list.scrollToOffset).toHaveLength(1);
    } finally {
      h.unmount();
    }
  });

  test("an arriving live hint grows the log without consuming the anchor", () => {
    // This is the terminal's own version of the streaming case, and the reason
    // the anchor keys on the head row rather than on a loading flag: a `sent`
    // or `reply` hint appends a row and changes content height while the older
    // page is still in flight.
    const h = mount();
    try {
      h.contentSize(4000);
      h.scrollTo(0);
      expect(h.loads()).toBe(1);

      h.render({ sent: "hello there" });
      h.contentSize(4300);
      expect(h.list.scrollToOffset).toHaveLength(0);

      h.render({ busy: true, reply: "working on it" });
      h.contentSize(4600);
      expect(h.list.scrollToOffset).toHaveLength(0);

      // The real prepend still gets its anchor, measured from the growth that
      // actually moved the head.
      h.render({ history: [turn("0"), turn("1"), turn("2")], historyCursor: 400 });
      h.contentSize(5800);
      expect(h.list.scrollToOffset).toEqual([{ offset: 1200, animated: false }]);
    } finally {
      h.unmount();
    }
  });

  test("the manual button arms the anchor exactly as a scroll does", () => {
    const h = mount();
    try {
      h.contentSize(4000);
      h.pressLoadEarlier();
      expect(h.loads()).toBe(1);
      h.render({ history: [turn("0"), turn("1"), turn("2")], historyCursor: 400 });
      h.contentSize(4900);
      // Wired straight to `onLoadEarlier` this would be empty, and the reader
      // would be wherever the prepend left them.
      expect(h.list.scrollToOffset).toEqual([{ offset: 900, animated: false }]);
    } finally {
      h.unmount();
    }
  });

  test("iOS leaves the offset to the platform rather than moving the reader twice", () => {
    platformOS = "ios";
    const h = mount();
    try {
      h.contentSize(4000);
      h.scrollTo(0);
      h.render({ history: [turn("0"), turn("1"), turn("2")], historyCursor: 400 });
      h.contentSize(5200);
      expect(h.list.scrollToOffset).toHaveLength(0);
    } finally {
      h.unmount();
    }
  });
});

describe("the terminal log still follows its newest turn", () => {
  test("the first paint pins to the newest turn", () => {
    const h = mount();
    try {
      h.contentSize(4000);
      expect(h.list.scrollToEnd).toHaveLength(1);
      expect(h.list.scrollToEnd[0]).toEqual({ animated: false });
    } finally {
      h.unmount();
    }
  });

  test("a reader who scrolled up to ask for history is not dragged back down", () => {
    // The regression this pins is the one that made the terminal log unusable
    // before `useFollowNewest`: an unconditional `scrollToEnd` on every
    // content-size change, which a prepend also triggers.
    const h = mount();
    try {
      h.contentSize(4000);
      expect(h.list.scrollToEnd).toHaveLength(1);

      h.scrollTo(0);
      h.render({ history: [turn("0"), turn("1"), turn("2")], historyCursor: 400 });
      h.contentSize(5200);
      expect(h.list.scrollToEnd).toHaveLength(1);
    } finally {
      h.unmount();
    }
  });

  test("a reader at the bottom still gets the arriving turn", () => {
    const h = mount();
    try {
      h.contentSize(4000);
      // Near the bottom: 4000 content, 800 viewport, so 3200 is the floor.
      h.scrollTo(3200);
      h.render({ history: [turn("1"), turn("2"), turn("3")] });
      h.contentSize(4400);
      expect(h.list.scrollToEnd).toHaveLength(2);
    } finally {
      h.unmount();
    }
  });
});
