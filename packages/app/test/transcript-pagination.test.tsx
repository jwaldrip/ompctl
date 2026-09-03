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
import type { Agent } from "@ompd/core/contracts";
import { act, type ComponentType, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { OmpThreadListProps } from "../src/assistant/OmpThread.tsx";
import { rhythm } from "../src/design/rhythm.ts";
import { ink, radius } from "../src/design/tokens.ts";
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

// Same reason: imported after `mock.module`, so the primitive closes over the
// recorder rather than the real list.
//
// The subject moved from `Transcript` to the production surface: the provider
// plus `OmpThreadList`. What is under test did not change -- which props the
// component hands its list and how it responds when they are invoked -- and the
// reason the recorder still works is measured: with all four of assistant-ui's
// scroll flags false, the library adds only `data`, `keyExtractor`, `renderItem`
// and its own ref plumbing, so every scroll and anchor prop reaching the list is
// still ours.
const { OmpThreadList, OmpThreadProvider } = await import("../src/assistant/OmpThread.tsx");
const { EMPTY_SESSION } = await import("../src/session/model.ts");
// Dynamic for the same reason as the two above, which is the one exception this
// file's static-import rule names: this module imports `react-native`, so a
// static import here would resolve it before `mock.module` had replaced
// `FlatList` and the recorder would never be installed. Imported at all so the
// anchor assertion compares the component's prop against the exact object it is
// supposed to pass, rather than against a restatement of its numbers.
const { MAINTAIN_VISIBLE_CONTENT_POSITION } = await import("../src/components/useTopHistoryPagination.ts");
// Dynamic for the same reason again, one step further out: the provider reaches
// `react-native` through `useColorScheme` and pulls react-native-paper in
// behind it, and a static import of either resolves the real, untranspiled
// package before `./rnw.ts` has substituted the web build for it.
const { WithOmpTheme } = await import("./theme.tsx");
// The real react-native-web StyleSheet, reached through the pinned namespace
// for the same reason `RealFlatList` is: `actual` was captured before the mock.
const { StyleSheet } = actual;

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
  render: (overrides?: Partial<OmpThreadListProps>) => void;
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
  let current: OmpThreadListProps = {
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

  const agent: Agent = {
    id: "agt_a",
    name: "Alpha",
    state: "idle",
    host: { kind: "local", id: "1", spec: { kind: "local" } },
    cwd: "/w",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActiveAt: "2026-08-24T11:00:00.000Z",
    labels: {},
  };

  const render: Harness["render"] = overrides => {
    current = { ...current, ...(overrides ?? {}) };
    act(() => {
      root.render(
        // The rows reach the list through the runtime, which is the production
        // path: the provider holds the session and the list reads the thread.
        <OmpThreadProvider
          agent={agent}
          session={{ ...EMPTY_SESSION, entries: current.entries }}
          connection="connected"
          load={{ phase: "ready", generation: 0, error: null }}
          promptAccess="granted"
          canApprove={false}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
        >
          <OmpThreadList {...current} />
        </OmpThreadProvider>,
      );
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

describe("owned thread auto-load: request identity", () => {
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

describe("owned thread prepend anchor", () => {
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

describe("owned thread list configuration", () => {
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

describe("owned thread follow-newest composition", () => {
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
  /** Whether a rendered element tree contains a node carrying `testID`. */
  function contains(node: unknown, testID: string): boolean {
    if (node === null || node === undefined || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(child => contains(child, testID));
    const element = node as { props?: Record<string, unknown> };
    const props = element.props;
    if (props === undefined) return false;
    // Either spelling: a react-native element carries `testID`, a DOM probe
    // carries `data-testid`, and the footer slot legitimately holds both kinds.
    if (props.testID === testID || props["data-testid"] === testID) return true;
    return contains(props.children, testID);
  }

  test("the row is inside the footer the list is handed, not beside the list", () => {
    const h = mount({ entries: [entry("a")] });

    // Nothing in flight: the slot exists for the spoken summary, but no
    // activity row is in it.
    expect(contains(h.props().ListFooterComponent, "probe-activity")).toBe(false);

    h.render({ footer: <span data-testid="probe-activity">working</span> });
    expect(contains(h.props().ListFooterComponent, "probe-activity")).toBe(true);

    // And it leaves again, rather than being a row that arrives once and stays
    // for the rest of the session.
    h.render({ footer: null });
    expect(contains(h.props().ListFooterComponent, "probe-activity")).toBe(false);
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
    h.render({ footer: <span data-testid="probe-activity">working</span> });
    h.contentSize(4040);

    expect(h.list.scrollToEnd).toHaveLength(before);
    h.unmount();
  });

  test("the row leaving does not scroll anything either", () => {
    const h = mount({ entries: [entry("a")] });
    h.contentSize(1000);
    h.scrollTo(10, 4000);
    h.render({ footer: <span data-testid="probe-activity">working</span> });
    h.contentSize(1040);
    const before = h.list.scrollToEnd.length;

    // Turn end removes the row and the content shrinks. A follower that
    // treated a shrink as new content would yank a reader to the bottom at
    // exactly the moment the agent stopped talking.
    h.render({ footer: null });
    h.contentSize(1000);

    expect(h.list.scrollToEnd).toHaveLength(before);
    h.unmount();
  });
});

/**
 * The styling pass must not have touched the anchor's wiring.
 *
 * The block above proves the machine behaves; this proves the wiring the
 * behaviour rides on is still the component's own after Paper moved in. The
 * discriminator is `onLayout`: assistant-ui only installs handlers of its own
 * when at least one of its four scroll flags is on, and that is exactly the
 * state that would fight `useFollowNewest`. So a flag flipped back to its
 * default -- by an edit, or by an upgrade changing what "unset" means -- shows
 * up here as a library `onLayout` arriving, and as the four flags no longer
 * being consumed before the list sees them.
 */
describe("the list assistant-ui is handed is still the pagination machine's", () => {
  test("every scroll and anchor prop is the component's, and the library adds none", () => {
    const h = mount({ entries: [entry("a")], historyCursor: 100 });
    const raw = h.props() as unknown as Record<string, unknown>;

    // Consumed by the primitive because all four are false, so they never
    // reach the list. One of them true and the primitive forwards its own
    // tracking instead.
    for (const flag of [
      "autoScroll",
      "scrollToBottomOnRunStart",
      "scrollToBottomOnInitialize",
      "scrollToBottomOnThreadSwitch",
    ]) {
      expect(raw[flag]).toBeUndefined();
    }
    expect(raw.onLayout).toBeUndefined();

    // And ours, all five, unchanged.
    expect(typeof raw.ref === "function" || typeof raw.ref === "object").toBe(true);
    expect(typeof raw.onScroll).toBe("function");
    expect(typeof raw.onContentSizeChange).toBe("function");
    expect(raw.scrollEventThrottle).toBe(100);
    expect(raw.maintainVisibleContentPosition).toBe(MAINTAIN_VISIBLE_CONTENT_POSITION);
    h.unmount();
  });
});

/**
 * The spacing an operator actually sees, read off the rendered sheet.
 *
 * "spacing looks off" was the report, so the assertion has to be the rendered
 * geometry rather than the token the source names: a surface can import
 * `rhythm` and still spend it on the wrong job. Every expectation below is
 * written against `rhythm.x` so a change to the scale moves the test with it,
 * and against the declaration the browser would ship so a rule that never made
 * it into the sheet fails.
 *
 * The list renders for real here, which is why `capturing` goes off: the
 * recorder stands in for the list everywhere else in this file, and a null list
 * has no geometry to read. The rows are deliberately empty so this measures the
 * shell -- the gutter, the row rhythm, the header control, the spoken band and
 * the empty state -- and not `renderers.tsx`, which has its own suite.
 */
describe("the log's rhythm, as rendered", () => {
  /**
   * `getSheet` is a react-native-web extension its TypeScript surface does not
   * publish: static StyleSheet values compile to atomic classes whose
   * declarations live in one injected sheet rather than in the markup. Same cast
   * `terminal-session.test.tsx` and `composer-actions.test.tsx` make.
   */
  const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

  /** Every emitted declaration addressing one element's own classes. */
  function rulesOf(element: Element | null): string {
    const classes = [...(element?.classList ?? [])];
    if (classes.length === 0) return "";
    return rnwStyleSheet
      .getSheet()
      .textContent.split("\n")
      .filter(rule => classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule)))
      .join("\n");
  }

  /**
   * A token hex as react-native-web spells it. Same helper
   * `composer-actions.test.tsx` carries, for the same reason: RNW normalises
   * every colour to `rgba(r,g,b,a.aa)`, so a hex compared against the sheet
   * never matches and an assertion written that way passes on any colour.
   */
  const rgba = (hex: string): string => {
    const n = Number.parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1.00)`;
  };

  /** The nearest element at or under `root` whose own rules match. */
  function withRule(root: Element | null, pattern: RegExp): Element | null {
    if (root === null) return null;
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (pattern.test(rulesOf(element))) return element;
    }
    return null;
  }

  /** The nearest ancestor of `node` whose own rules match. */
  function ancestorWithRule(node: Element | null, pattern: RegExp): Element | null {
    let walk = node?.parentElement ?? null;
    while (walk !== null) {
      if (pattern.test(rulesOf(walk))) return walk;
      walk = walk.parentElement;
    }
    return null;
  }

  /** The real list, painted under the real theme provider unless told otherwise. */
  function paint(options?: { themed?: boolean }): { host: HTMLElement; root: Root; unmount: () => void } {
    capturing = false;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const agent: Agent = {
      id: "agt_r",
      name: "Rhythm",
      state: "idle",
      host: { kind: "local", id: "1", spec: { kind: "local" } },
      cwd: "/w",
      createdAt: "2026-08-24T11:00:00.000Z",
      lastActiveAt: "2026-08-24T11:00:00.000Z",
      labels: {},
    };
    const tree = (
      <OmpThreadProvider
        agent={agent}
        session={EMPTY_SESSION}
        connection="connected"
        load={{ phase: "ready", generation: 0, error: null }}
        promptAccess="granted"
        canApprove={false}
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
      >
        <OmpThreadList
          entries={[]}
          canApprove={false}
          onDecide={() => {}}
          canLoadEarlier
          loadingEarlier={false}
          onLoadEarlier={() => {}}
          historyCursor={100}
          spoken="the deploy is green"
        />
      </OmpThreadProvider>
    );
    act(() => {
      // `themed: false` takes the surface BARE, with no provider above it. That
      // is not a convenience: it is the only state in which a Paper icon passed
      // by name silently stops drawing, so the glyph gate below has to refuse
      // the wrapper to mean anything.
      root.render(options?.themed === false ? tree : <WithOmpTheme>{tree}</WithOmpTheme>);
    });
    return {
      host,
      root,
      unmount: () => {
        act(() => {
          root.unmount();
        });
        host.remove();
        capturing = true;
      },
    };
  }

  test("the screen gutter and the row rhythm are paid once, by the content container", () => {
    const p = paint();
    try {
      const list = p.host.querySelector('[data-testid="aui-messages"]');
      expect(list).not.toBeNull();
      // RNW's ScrollView renders exactly one content container child, and it is
      // where contentContainerStyle lands.
      const rules = rulesOf(list?.children[0] ?? null);
      expect(rules).toContain(`padding-left:${rhythm.gutter}px`);
      expect(rules).toContain(`padding-right:${rhythm.gutter}px`);
      expect(rules).toMatch(new RegExp(`(?:row-)?gap:\\s*${rhythm.rowGap}px`));
    } finally {
      p.unmount();
    }
  });

  test("nothing inside the log pays the screen gutter a second time", () => {
    const p = paint();
    try {
      // The defect the rhythm scale exists to kill: the transcript read as
      // padded out because a card inside a gutter paid the gutter again. So no
      // element under the content container may declare it horizontally.
      //
      // Both spellings, because they are the same defect: RNW compiles an
      // all-sides `padding` to the shorthand and a `paddingHorizontal` to the
      // two long-hands, and a check that read only the long-hands passed on a
      // card paying `padding: rhythm.gutter` -- which is exactly the shape this
      // test exists to catch.
      const content = p.host.querySelector('[data-testid="aui-messages"]')?.children[0] ?? null;
      expect(content).not.toBeNull();
      const gutter = new RegExp(`(?:^|[;{\\s])padding(?:-left|-right)?:\\s*${rhythm.gutter}px`);
      // Named, not the nodes themselves: a failing `toEqual` on a happy-dom
      // element tries to serialise the whole node for its diff, which does not
      // terminate. A test that hangs on the defect it is meant to report is not
      // a check.
      const doubled = [...(content?.querySelectorAll("*") ?? [])]
        .filter(element => gutter.test(rulesOf(element)))
        .map(element => element.getAttribute("data-testid") ?? element.className);
      expect(doubled).toEqual([]);
    } finally {
      p.unmount();
    }
  });

  test("the history control is a finger target on the grid, in a container that belongs to it", () => {
    const p = paint();
    try {
      const control = p.host.querySelector('[data-testid="history-load-earlier"]');
      expect(control).not.toBeNull();
      // Paper's own button is shorter than a finger; the content row carries
      // the target and the control's own horizontal padding.
      const content = withRule(control, new RegExp(`min-height:${rhythm.minTarget}px`));
      expect(content).not.toBeNull();
      const geometry = rulesOf(content);
      expect(geometry).toContain(`padding-left:${rhythm.controlPad}px`);
      expect(geometry).toContain(`padding-right:${rhythm.controlPad}px`);
      // Paper's off-grid 10pt label margin is gone, and the glyph sits
      // `glyphGap` from its word once Paper's negative icon margin is paid back.
      const label = withRule(control, /margin-top:0px/);
      expect(label).not.toBeNull();
      expect(rulesOf(label)).toContain("margin-left:12px");

      // The control belongs to the history above it, so its container pays the
      // tight step rather than a section's air.
      const band = ancestorWithRule(control, new RegExp(`padding-top:${rhythm.rowGapTight}px`));
      expect(band).not.toBeNull();
      expect(rulesOf(band)).toContain(`padding-bottom:${rhythm.rowGapTight}px`);
    } finally {
      p.unmount();
    }
  });

  /**
   * The glyph draws with no provider above the surface.
   *
   * Paper's `Icon` routes a STRING source through `settings.icon`, which only
   * `OmpThemeProvider` supplies; bare, the string form falls through to Paper's
   * bundled Material renderer, which has no font in this app and draws a literal
   * box character. A FUNCTION source is called directly, so it draws either way.
   *
   * Taken BARE on purpose. Wrapped in `WithOmpTheme` this passes on both forms,
   * which is exactly what would make it worthless: the provider is what hides
   * the defect. `Glyph` renders Font Awesome path data through the `./rnw.ts`
   * svg stub, so a real drawing means a `<path` inside the control.
   */
  test("the control's glyph is a real drawing even with no theme provider above it", () => {
    const p = paint({ themed: false });
    try {
      const control = p.host.querySelector('[data-testid="history-load-earlier"]');
      expect(control).not.toBeNull();
      expect(control?.querySelectorAll("path").length).toBeGreaterThan(0);
      // And no Material fallback beside it: the box character Paper draws when
      // it cannot find a font.
      expect(control?.textContent ?? "").not.toContain("\u25A1");
    } finally {
      p.unmount();
    }
  });

  test("the control is neither the emphasis colour nor the emphasis shape", () => {
    const p = paint();
    try {
      const control = p.host.querySelector('[data-testid="history-load-earlier"]');
      if (control === null) throw new Error("no history-load-earlier control was rendered");

      // A way back through history is a quiet control. Two claims below, and
      // they fail for different reasons, which is why both are here.
      //
      // The haystack is the control's subtree AND the Surface Paper wraps it in.
      // That ancestor is not optional: Paper puts the testID on the inner
      // TouchableRipple and the FILL on the Surface above it, so a haystack
      // starting at the testID cannot see a filled button at all. Measured with
      // `mode="contained"`, the one-word edit that gives this control the
      // emphasis fill: with the ancestor excluded the colour check PASSED while
      // sage sat on the parent. One level up is Paper's own button root; two
      // would reach the log and let unrelated colour fail this.
      //
      // Whitespace is stripped at the read because happy-dom returns the style
      // attribute as `rgba(132, 124, 109, 1.00)` while the atomic sheet writes
      // it closed up, so a needle spelled one way is never found in a haystack
      // spelled the other. Newlines survive so a failure is still readable.
      const painted = [control.parentElement, control, ...control.querySelectorAll("*")].filter(
        (element): element is Element => element !== null,
      );
      const inline = painted.map(element => element.getAttribute("style") ?? "").join("\n");
      const style = `${inline}\n${painted.map(element => rulesOf(element)).join("\n")}`.replace(/[^\S\n]+/g, "");

      // CLAIM ONE: the control paints nothing. `mode="text"` is an unfilled
      // control by definition, and asserting the ABSENCE of any fill catches a
      // filled control in ANY colour rather than only the sage I happened to
      // think of -- a negative naming one colour is a list of remembered
      // violations, not a check. Transparent fills are dropped because
      // react-native-web's base view class declares one on everything.
      //
      // Both halves measured. `mode="contained"` reports
      // ["rgba(143,169,123,1.00)"], the sage fill. `buttonColor` set to signal
      // violet reports ["rgba(139,123,196,1.00)"] -- a colour this assertion
      // never mentions, which the sage-only negative below passes clean. The
      // failure names the offending colour rather than saying a needle was
      // found.
      const fills = [...style.matchAll(/background-color:([^;\n}]+)/g)]
        .map(match => match[1] ?? "")
        .filter(value => value !== "" && value !== "transparent" && !value.endsWith(",0.00)"));
      expect(fills).toEqual([]);

      // CLAIM TWO: the label and glyph are muted rather than the emphasis
      // colour. Distinct from claim one, which only sees fills: removing
      // `textColor` makes Paper paint the TEXT `colors.primary` while nothing
      // gains a background, so "paints nothing" still passes and only this
      // catches it. Measured: this line then fails with sage where muted should
      // be.
      //
      // There was a `not.toContain(rgba(signal.sage))` here and I deleted it,
      // because it could not be made to fail while this line passed. Every state
      // I could reach either loses muted entirely (textColor removed, so this
      // line fails first) or gains a background (a filled mode, so claim one
      // fails first), and the one upstream change that would split them --
      // Paper ceasing to pass textColor to the icon -- falls back to
      // `colors.onSurface`, which is ink.bright, not sage. An assertion that
      // cannot fail while its neighbour passes is decoration, so the claim it
      // was making lives here instead.
      expect(style).toContain(rgba(ink.muted));

      // And Paper's `roundness * 5` pill is overridden back to a control's own
      // radius. The one pill in this app is the send disc, for the same reason
      // sage is: that shape means "completes the action".
      //
      // Paper computes this one and hands it to the container AND the touchable
      // as an inline `border-radius` shorthand rather than a class, which is why
      // the whitespace-stripped inline half is what carries it. A reader that
      // only consulted the sheet would find nothing and pass on a pill.
      //
      // Unlike the colour pair above, the POSITIVE is what discriminates here
      // and the negative is a cheap guard I could not make earn its place. Both
      // states I reached flip the two nodes together: with the override off both
      // read 40px, and with it applied to `contentStyle` instead of `style`
      // Paper's own 40 survives while the 8 lands as sheet long-hands, so the
      // positive fails first either way. Kept because it costs nothing and would
      // catch an upstream change that split the two, but recorded as unproven
      // rather than left looking load-bearing.
      expect(style).toContain(`border-radius:${radius.control}px`);
      expect(style).not.toContain(`border-radius:${radius.control * 5}px`);
    } finally {
      p.unmount();
    }
  });

  test("the spoken band is a card with a section's air above it", () => {
    const p = paint();
    try {
      const said = p.host.querySelector('[data-testid="transcript-say"]');
      expect(said).not.toBeNull();
      const rules = rulesOf(said);
      // A card's inner pad, not the screen gutter: the content container above
      // it already paid that. RNW emits an all-sides `padding` as the shorthand
      // and a `paddingHorizontal` as the two long-hands, so the declaration
      // asserted here is the one this rule actually compiles to.
      expect(rules).toContain(`padding:${rhythm.cardPad}px`);
      // What the daemon said out loud is a different section from the turns.
      expect(rules).toContain(`margin-top:${rhythm.sectionGap}px`);
      // Its glyph and its prose are siblings inside the card.
      expect(rules).toMatch(new RegExp(`(?:column-)?gap:\\s*${rhythm.cardGap}px`));
      // Still a rule down its left edge, which is what marks it as spoken.
      expect(rules).toContain("border-left-width:2px");
    } finally {
      p.unmount();
    }
  });

  test("the empty state is a section, and still says the sentence it always said", () => {
    const p = paint();
    try {
      const empty = p.host.querySelector('[data-testid="transcript-empty"]');
      expect(empty).not.toBeNull();
      expect(empty?.textContent).toContain("Nothing on this strip yet.");
      const rules = rulesOf(empty);
      expect(rules).toContain(`padding-top:${rhythm.sectionGap}px`);
      expect(rules).toContain(`padding-bottom:${rhythm.sectionGap}px`);
      expect(rules).toMatch(new RegExp(`(?:row-)?gap:\\s*${rhythm.rowGap}px`));
    } finally {
      p.unmount();
    }
  });
});
