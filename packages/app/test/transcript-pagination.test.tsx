/**
 * Transcript history pagination, driven through the props the component
 * actually hands its list.
 *
 * The suite this replaces asserted on a copy of the guard written inside the
 * test file. It could not fail: one of its cases was titled "blocks repeated
 * requests at same cursor" and asserted the call count was two. So every
 * assertion here goes through a real render, real React rerenders, and the
 * real callbacks `Transcript` passes down. The list is a recorder rather than
 * a `FlatList` because the thing under test is which props the component
 * supplies and how it responds when they are invoked, in what order -- which
 * is precisely where the defects were.
 */

import "./rnw.ts";

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, type ComponentType, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TranscriptProps } from "../src/components/Transcript.tsx";
import type { Entry } from "../src/session/model.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
// Without this `act` does not flush effects, and every ordering assertion
// below would be measuring the wrong moment.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** What the recorder last received. Read after each render. */
interface ListProps {
  /**
   * Either shape, deliberately. The implementation being replaced passed a ref
   * OBJECT; this one passes a callback so it can feed the follower too. The
   * harness attaches to whichever it is given, so a run against the old code
   * fails on behaviour rather than on a TypeError at mount, which would prove
   * nothing.
   */
  ref?: ((list: unknown) => void) | { current: unknown };
  onScroll?: (event: unknown) => void;
  onContentSizeChange?: (width: number, height: number) => void;
  scrollEventThrottle?: number;
  maintainVisibleContentPosition?: { minIndexForVisible?: number; autoscrollToTopThreshold?: number };
  ListHeaderComponent?: unknown;
  ListFooterComponent?: unknown;
  data?: readonly Entry[];
}

let listProps: ListProps | null = null;
let platformOS = "android";
/**
 * Whether the recorder is standing in for the list or merely watching it.
 *
 * `mock.module` is process-wide and permanent, so a recorder that always
 * returned null would blank every `FlatList` in every suite loaded after this
 * file -- which it did, taking out thirteen unrelated transcript and agent-hub
 * tests. Off, it renders the real list and records nothing.
 */
let capturing = false;

// Dynamic on purpose, and the one case the static-import rule exempts: the
// mock below has to be registered before the component binds `FlatList`, and
// a static import of `react-native` here would resolve first.
const actual = await import("react-native");

/**
 * The real list, pinned to a local before the mock below replaces the export.
 *
 * `actual` is a live module namespace, so reading `actual.FlatList` after the
 * mock is registered returns the recorder itself. Delegating to that is
 * infinite recursion: it segfaulted bun at a 52 GB peak rather than failing
 * as a test would.
 */
// Cast at the seam, not at the callsite: `FlatList`'s real props are generic
// over its item type and this recorder is a pass-through that never reads them,
// so `createElement(RealFlatList, props)` matched no overload and the branch
// did not typecheck as pushed.
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

// Same reason: imported after `mock.module`, so `Transcript` closes over the
// recorder rather than the real list.
const { Transcript } = await import("../src/components/Transcript.tsx");

/** Everything one mounted list recorded, and the handle it recorded through. */
interface ListRecorder {
  handle: {
    scrollToOffset: (options: { offset: number; animated?: boolean }) => void;
    scrollToEnd: (options?: { animated?: boolean }) => void;
  };
  scrollToOffset: Array<{ offset: number; animated?: boolean }>;
  scrollToEnd: Array<{ animated?: boolean } | undefined>;
}

/** A list handle of the shape `useFollowNewest` and the anchor both drive. */
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

function entry(id: string): Entry {
  return { kind: "user", id, text: `entry ${id}` } as Entry;
}

interface Harness {
  render: (overrides?: Partial<TranscriptProps>) => void;
  props: () => ListProps;
  loads: () => number;
  list: ListRecorder;
  scrollTo: (y: number, contentHeight?: number) => void;
  contentSize: (height: number) => void;
  pressLoadEarlier: () => void;
  unmount: () => void;
}

function mount(initial: {
  entries: readonly Entry[];
  historyCursor?: number | null;
  canLoadEarlier?: boolean;
  loadingEarlier?: boolean;
}): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const list = recorderList();
  let calls = 0;
  let current: TranscriptProps = {
    entries: initial.entries,
    canApprove: false,
    onDecide: () => {},
    canLoadEarlier: initial.canLoadEarlier ?? true,
    loadingEarlier: initial.loadingEarlier ?? false,
    onLoadEarlier: () => {
      calls++;
    },
    historyCursor: initial.historyCursor,
  };

  const render: Harness["render"] = overrides => {
    current = { ...current, ...(overrides ?? {}) };
    act(() => {
      root.render(<Transcript {...current} />);
    });
  };

  render();
  // React 19 hands `ref` to a function component as an ordinary prop, so the
  // attach is explicit here rather than something the renderer did for us.
  act(() => {
    const attach = listProps?.ref;
    if (typeof attach === "function") attach(list.handle);
    else if (attach !== undefined && attach !== null) attach.current = list.handle;
  });

  return {
    render,
    props: () => {
      if (listProps === null) throw new Error("the list was never rendered");
      return listProps;
    },
    loads: () => calls,
    list,
    scrollTo: (y, contentHeight = 4000) => {
      act(() => {
        listProps?.onScroll?.({
          nativeEvent: {
            contentOffset: { x: 0, y },
            contentSize: { width: 390, height: contentHeight },
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
      const header = listProps?.ListHeaderComponent;
      const press = findPress(header);
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

/** Walk a rendered element tree for the history button's own `onPress`. */
function findPress(node: unknown): (() => void) | null {
  if (node === null || typeof node !== "object") return null;
  const element = node as { props?: Record<string, unknown> };
  const props = element.props;
  if (props === undefined) return null;
  if (props.testID === "history-load-earlier" && typeof props.onPress === "function") {
    return props.onPress as () => void;
  }
  const children = props.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    const found = findPress(child);
    if (found !== null) return found;
  }
  return null;
}

beforeEach(() => {
  platformOS = "android";
  listProps = null;
  capturing = true;
});

// The mock outlives this file, so the recorder has to go back to delegating
// before anything else renders a list.
afterAll(() => {
  capturing = false;
  platformOS = "android";
});

describe("Transcript auto-load: request identity", () => {
  test("a scroll bounce at the top asks once, not once per event", () => {
    const h = mount({ entries: [entry("a"), entry("b")], historyCursor: 100 });

    h.scrollTo(10);
    h.scrollTo(12);
    h.scrollTo(8);

    expect(h.loads()).toBe(1);
    h.unmount();
  });

  test("a failed page stays locked at the same cursor across the loading round trip", () => {
    // The storm. The parent flips loading true then false and the cursor does
    // not move, because the request failed. On the old effect-driven guard
    // that false cleared the lock and the very next scroll frame re-fired the
    // same doomed page, for as long as the reader sat at the top.
    const h = mount({ entries: [entry("a")], historyCursor: 100 });

    h.scrollTo(10);
    expect(h.loads()).toBe(1);

    h.render({ loadingEarlier: true });
    h.render({ loadingEarlier: false });

    h.scrollTo(10);
    h.scrollTo(6);
    expect(h.loads()).toBe(1);
    h.unmount();
  });

  test("a cursor that moved releases the next automatic page", () => {
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    h.scrollTo(10);
    expect(h.loads()).toBe(1);

    h.render({ loadingEarlier: true });
    h.render({ entries: [entry("a"), entry("b")], historyCursor: 50, loadingEarlier: false });

    h.scrollTo(10);
    expect(h.loads()).toBe(2);
    h.unmount();
  });

  test("a pairing that reports no cursor gets one automatic page, never a storm", () => {
    // `undefined !== undefined` is false, but the old guard compared a ref
    // seeded with null against an undefined prop, which is never equal, so it
    // never locked. One page then the button is the honest degradation.
    const h = mount({ entries: [entry("a")], historyCursor: undefined });

    h.scrollTo(10);
    h.scrollTo(10);
    h.render({ loadingEarlier: true });
    h.render({ loadingEarlier: false });
    h.scrollTo(10);

    expect(h.loads()).toBe(1);
    h.unmount();
  });

  test("scrolling below the top asks for nothing", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });
    h.scrollTo(400);
    expect(h.loads()).toBe(0);
    h.unmount();
  });

  test("the true beginning is inert: no control, no request", () => {
    const h = mount({ entries: [entry("a")], historyCursor: null, canLoadEarlier: false });

    h.scrollTo(0);
    expect(h.loads()).toBe(0);
    expect(findPress(h.props().ListHeaderComponent)).toBeNull();
    h.unmount();
  });

  test("the button retries a page the automatic path has locked", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });

    h.scrollTo(10);
    h.render({ loadingEarlier: true });
    h.render({ loadingEarlier: false });
    h.scrollTo(10);
    expect(h.loads()).toBe(1);

    h.pressLoadEarlier();
    expect(h.loads()).toBe(2);
    h.unmount();
  });
});

describe("Transcript prepend anchor", () => {
  test("the anchor survives the parent clearing loading before the list reports its size", () => {
    // The ordering the old boolean effect lost. The parent delivers entries,
    // cursor and loading:false in one commit; the layout callback arrives
    // after. Tied to the head row instead, the wait is still armed when it
    // does.
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    h.scrollTo(20);
    h.contentSize(1000);
    h.render({ loadingEarlier: true });
    h.render({ entries: [entry("a"), entry("b")], historyCursor: 50, loadingEarlier: false });
    h.contentSize(1400);

    expect(h.list.scrollToOffset).toEqual([{ offset: 420, animated: false }]);
    h.unmount();
  });

  test("the anchor is consumed exactly once", () => {
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    h.scrollTo(20);
    h.contentSize(1000);
    h.render({ entries: [entry("a"), entry("b")], historyCursor: 50 });
    h.contentSize(1400);
    h.contentSize(1800);

    expect(h.list.scrollToOffset).toHaveLength(1);
    h.unmount();
  });

  test("streaming growth at the bottom never moves the reader", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });

    h.scrollTo(20);
    h.contentSize(1000);
    // No request, no prepend: just a turn arriving.
    h.render({ entries: [entry("a"), entry("b")] });
    h.contentSize(1600);
    h.render({ entries: [entry("a"), entry("b"), entry("c")] });
    h.contentSize(2200);

    expect(h.list.scrollToOffset).toEqual([]);
    h.unmount();
  });

  test("growth while a page is still in flight does not spend the anchor", () => {
    // A turn streams in while the history request is out. The head has not
    // moved, so this is not the prepend, and the anchor has to still be there
    // when the prepend lands.
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    h.scrollTo(20);
    h.contentSize(1000);
    h.render({ loadingEarlier: true });
    h.render({ entries: [entry("b"), entry("c")], loadingEarlier: true });
    h.contentSize(1200);
    expect(h.list.scrollToOffset).toEqual([]);

    h.render({ entries: [entry("a"), entry("b"), entry("c")], historyCursor: 50, loadingEarlier: false });
    h.contentSize(1700);
    expect(h.list.scrollToOffset).toEqual([{ offset: 520, animated: false }]);
    h.unmount();
  });

  test("the button arms the anchor exactly as the automatic path does", () => {
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    h.scrollTo(20);
    h.contentSize(1000);
    // Consume the automatic arm so the press is the only thing that could
    // have armed the one under test.
    h.render({ entries: [entry("a"), entry("b")], historyCursor: 50 });
    h.contentSize(1400);
    expect(h.list.scrollToOffset).toHaveLength(1);

    h.pressLoadEarlier();
    h.render({ entries: [entry("z"), entry("a"), entry("b")], historyCursor: 10 });
    h.contentSize(1900);

    expect(h.list.scrollToOffset).toHaveLength(2);
    expect(h.list.scrollToOffset[1]).toEqual({ offset: 520, animated: false });
    h.unmount();
  });

  test("iOS leaves the adjustment to the platform", () => {
    platformOS = "ios";
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    h.scrollTo(20);
    h.contentSize(1000);
    h.render({ entries: [entry("a"), entry("b")], historyCursor: 50 });
    h.contentSize(1400);

    // `maintainVisibleContentPosition` already held the row; a second
    // adjustment here would move the reader twice.
    expect(h.list.scrollToOffset).toEqual([]);
    h.unmount();
  });
});

describe("Transcript list configuration", () => {
  test("nothing tells the list to jump to a newly inserted top", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });
    const config = h.props().maintainVisibleContentPosition;

    expect(config?.minIndexForVisible).toBe(0);
    // The defect: at an offset inside this threshold, inserting above scrolls
    // to the new top, which is the opposite of holding the reader's place.
    expect(config?.autoscrollToTopThreshold).toBeUndefined();
    h.unmount();
  });

  test("the scroll throttle is the follower's, not a second opinion", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });
    expect(h.props().scrollEventThrottle).toBe(100);
    h.unmount();
  });
});

describe("Transcript follow-newest composition", () => {
  test("the list handle reaches the follower, so a streaming turn still lands on newest", () => {
    // The regression this suite exists to stop: overriding `ref` and
    // `onContentSizeChange` left `useFollowNewest` holding no list and never
    // being called, so the transcript quietly stopped following a live turn.
    const h = mount({ entries: [entry("a")], historyCursor: 100 });

    h.contentSize(1000);

    expect(h.list.scrollToEnd).toHaveLength(1);
    expect(h.list.scrollToEnd[0]).toEqual({ animated: false });
    h.unmount();
  });

  test("a reader who has scrolled up is left alone while history arrives", () => {
    const h = mount({ entries: [entry("b")], historyCursor: 100 });

    // First paint pins to newest.
    h.contentSize(1000);
    expect(h.list.scrollToEnd).toHaveLength(1);

    // Now the reader is at the top, far from the bottom of a tall list.
    h.scrollTo(10, 4000);
    h.render({ entries: [entry("a"), entry("b")], historyCursor: 50 });
    h.contentSize(1500);

    // The prepend moved them back to their row, and nothing dragged them to
    // the end.
    expect(h.list.scrollToEnd).toHaveLength(1);
    expect(h.list.scrollToOffset).toHaveLength(1);
    h.unmount();
  });

  test("a reader at the bottom still follows a streaming turn", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });
    h.contentSize(1000);

    // Bottom of a 1000pt list in an 800pt viewport.
    h.scrollTo(200, 1000);
    h.render({ entries: [entry("a"), entry("b")] });
    h.contentSize(1300);

    expect(h.list.scrollToEnd.length).toBeGreaterThan(1);
    h.unmount();
  });
});

/**
 * The activity row is content of the log, not chrome over it.
 *
 * That distinction is the whole reason it moved out of the header, and it is
 * only true if the row goes through the list: the follower watches content
 * size, so a row rendered outside the list would grow nothing, pin nothing,
 * and sit over the transcript while the transcript scrolled underneath it.
 *
 * The first version of this block asserted `ListFooterComponent` was defined,
 * which `main` already satisfies because the same slot carries the spoken
 * summary. It passed on the unfixed build, so it was measuring nothing. What
 * discriminates is the footer's CONTENT, so these walk it.
 */
describe("the turn underway rides the list like any other row", () => {
  const WORKING = {
    kind: "working",
    label: "Working",
    announcement: "Working",
    live: true,
    actionable: false,
  } as const;

  /** Whether a rendered element tree contains a node carrying `testID`. */
  function contains(node: unknown, testID: string): boolean {
    if (node === null || node === undefined || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(child => contains(child, testID));
    const element = node as { props?: Record<string, unknown> };
    const props = element.props;
    if (props === undefined) return false;
    if (props.testID === testID) return true;
    return contains(props.children, testID);
  }

  test("the row is inside the footer the list is handed, not beside the list", () => {
    const h = mount({ entries: [entry("a")] });

    // Nothing in flight: the slot may exist for the spoken summary, but the
    // row must not be in it.
    expect(contains(h.props().ListFooterComponent, "session-activity")).toBe(false);

    h.render({ activity: WORKING });
    expect(contains(h.props().ListFooterComponent, "session-activity")).toBe(true);

    // And it leaves again, rather than being a row that arrives once and stays
    // for the rest of the session.
    h.render({ activity: null });
    expect(contains(h.props().ListFooterComponent, "session-activity")).toBe(false);
    h.unmount();
  });

  /*
    The two below are guards rather than discriminators: they describe the
    follower's existing behaviour, which this change must not alter, and they
    pass on `main` for that reason. Kept because the row is new content in the
    one slot that grows the list on every turn, which is exactly where a
    follower regression would show up first.
  */
  test("a reader scrolled up to read is not dragged down when the row arrives", () => {
    const h = mount({ entries: [entry("a"), entry("b")] });
    h.contentSize(4000);
    const before = h.list.scrollToEnd.length;

    h.scrollTo(10, 4000);
    h.render({ activity: WORKING });
    h.contentSize(4040);

    expect(h.list.scrollToEnd).toHaveLength(before);
    h.unmount();
  });

  test("the row leaving does not scroll anything either", () => {
    const h = mount({ entries: [entry("a")] });
    h.contentSize(1000);
    h.scrollTo(10, 4000);
    h.render({ activity: WORKING });
    h.contentSize(1040);
    const before = h.list.scrollToEnd.length;

    // Turn end removes the row and the content shrinks. A follower that
    // treated a shrink as new content would yank a reader to the bottom at
    // exactly the moment the agent stopped talking.
    h.render({ activity: null });
    h.contentSize(1000);

    expect(h.list.scrollToEnd).toHaveLength(before);
    h.unmount();
  });
});
