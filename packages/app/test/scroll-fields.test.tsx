/**
 * A scroll container is a field, not a row.
 *
 * It runs flush against whatever bounds it, its bar sits at the edge of the
 * pane, and the air its first and last rows need is content padding that
 * scrolls under the edges with everything else. Nothing outside the container
 * pads, gaps, or margins it into a smaller box.
 *
 * Reported on 2026-09-06 against the transcript: "there is a hard space above
 * and below the message window", a fixed band of base colour the list could
 * never scroll into, because the session body stacked its instruments with a
 * `gap` and the list was one of them. The same shape sat under the directory
 * screens (a screen padding around the list) and the pair screen (a padded
 * shell around a full-height scroll).
 *
 * Read off the rendered sheet rather than the source, the same way
 * `transcript-pagination.test.tsx` reads its rhythm: a screen can name the
 * right token and still spend it on the wrong box.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleEvent, ConsoleState } from "../src/console/state.ts";

const { apply, emptyConsole, fleetClearances, sessionFor } = await import("../src/console/state.ts");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { BrowseScreen } = await import("../src/screens/BrowseScreen.tsx");
const { PairScreen } = await import("../src/screens/PairScreen.tsx");
const { rhythm } = await import("../src/design/rhythm.ts");
const { StyleSheet } = await import("react-native");

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

/** The inline style plus the sheet rules, so a dynamic value counts the same as a static one. */
function declarationsOf(element: Element): string {
  return `${element.getAttribute("style") ?? ""};${rulesOf(element)}`;
}

/** Any outside air at all: padding, margin, or a flex gap on the element that holds the field. */
const OUTSIDE_AIR =
  /(?:^|[;{\s])(?:padding(?:-top|-bottom)?|margin(?:-top|-bottom)?|(?:row-|column-)?gap):\s*(?!0(?:px)?\b)/;

function document_(html: string): Document {
  const doc = document.implementation.createHTMLDocument("render");
  doc.body.innerHTML = html;
  return doc;
}

/**
 * react-native-web renders every ScrollView, FlatList and SectionList as a box
 * whose own rules carry `overflow-y:auto` (or `overflow-x` for a horizontal
 * one). That is the field.
 */
function scrollFields(doc: Document): Element[] {
  return [...doc.body.querySelectorAll("*")].filter(el => /overflow-y:\s*auto/.test(rulesOf(el)));
}

const NOW = Date.parse("2026-01-01T00:05:00.000Z");

const AGENT: Agent = {
  id: "agt_0000000000000001",
  name: "cartographer",
  state: "busy",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/Users/someone/dev/src/github.com/jwaldrip/oh-my-pi",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:04:00.000Z",
  labels: {},
};

function board(): ConsoleState {
  const events: ConsoleEvent[] = [
    { t: "agents", event: { agents: [AGENT], deviceId: "dev_1" } },
    { t: "select", agentId: AGENT.id },
    { t: "prompt", agentId: AGENT.id, text: "check the tunnel and report" },
    { t: "status", event: { state: "connected", attempt: 0 } },
  ];
  let state = emptyConsole([]);
  for (const event of events) state = apply(state, event);
  return state;
}

function renderSession(): string {
  const state = board();
  return renderToStaticMarkup(
    <SessionScreen
      agent={AGENT}
      session={sessionFor(state, AGENT.id)}
      load={{ phase: "ready", generation: 0, error: null }}
      context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
      connection={state.connection}
      attempt={state.attempt}
      canApprove
      voice={{
        access: "unknown",
        mic: { available: false, reason: "no microphone in this test" },
        speech: { available: false, reason: "no playback in this test" },
        dictation: null,
        capturing: false,
        busyElsewhere: false,
        onToggle: () => {},
      }}
      spoken={null}
      fleetClearances={fleetClearances(state)}
      onBack={() => {}}
      onSubmit={() => {}}
      onCancel={() => {}}
      onDecide={() => {}}
      onDecidePlan={() => {}}
      now={NOW}
    />,
  );
}

describe("the transcript is a flush field", () => {
  const doc = document_(renderSession());
  const list = doc.querySelector('[data-testid="aui-messages"]');

  test("the list renders as a scroll field", () => {
    expect(list).not.toBeNull();
    expect(rulesOf(list)).toMatch(/overflow-y:\s*auto/);
  });

  test("nothing between the list and its bands pads, gaps, or margins it", () => {
    // Walk up from the list to the screen body: every box on the way is a
    // holder of the field and may carry no air of its own.
    let walk: Element | null = list;
    const offenders: string[] = [];
    while (walk !== null && walk.getAttribute("data-testid") !== "session-body") {
      const own = declarationsOf(walk);
      if (OUTSIDE_AIR.test(own)) offenders.push(`${walk.getAttribute("data-testid") ?? walk.className}: ${own}`);
      walk = walk.parentElement;
    }
    expect(walk?.getAttribute("data-testid")).toBe("session-body");
    if (walk !== null && OUTSIDE_AIR.test(declarationsOf(walk)))
      offenders.push(`session-body: ${declarationsOf(walk)}`);
    expect(offenders).toEqual([]);
  });

  test("the air the rows need is content padding, one row step top and bottom", () => {
    const content = list?.firstElementChild ?? null;
    expect(content).not.toBeNull();
    const rules = rulesOf(content);
    expect(rules).toContain(`padding-top:${rhythm.rowGap}px`);
    expect(rules).toContain(`padding-bottom:${rhythm.rowGap}px`);
  });

  test("the readout under the list draws its own boundary rather than relying on a gap", () => {
    const readout = doc.querySelector('[data-testid="status-readout"]');
    expect(rulesOf(readout)).toMatch(/border-top-width:\s*1px/);
  });
});

describe("every scroll field in the rendered screens is flush", () => {
  const screens: Array<[string, string]> = [
    ["session", renderSession()],
    [
      "browse",
      renderToStaticMarkup(
        <BrowseScreen
          state={{
            path: "/work",
            parent: "/",
            roots: ["/work"],
            entries: [
              { name: "a", kind: "dir" },
              { name: "b", kind: "dir", gitRepo: true },
            ],
            loading: false,
            bounded: false,
            notice: "a notice, so that band renders too",
            clone: null,
            started: [],
          }}
          onOpenPath={() => {}}
          onOpenChild={() => {}}
          onUp={() => {}}
          onRefresh={() => {}}
          onStartHere={() => {}}
          onCloneHere={() => {}}
          onDismissNotice={() => {}}
          onDismissClone={() => {}}
        />,
      ),
    ],
    ["pair", renderToStaticMarkup(<PairScreen onPair={() => {}} onScan={() => {}} />)],
  ];

  for (const [name, html] of screens) {
    test(`${name}: each field's holder chain carries no outside air`, () => {
      const doc = document_(html);
      const fields = scrollFields(doc);
      expect(fields.length).toBeGreaterThan(0);
      const offenders: string[] = [];
      for (const field of fields) {
        // A horizontal strip inside a band (the sort bar, a chip row) is a
        // control, not a field; it is bounded by the band it lives in.
        if (/overflow-x:\s*auto/.test(rulesOf(field)) && !/overflow-y:\s*auto/.test(rulesOf(field))) continue;
        // The field's own box: no margin. Its parent: no padding around it
        // and no gap between it and its siblings.
        const own = declarationsOf(field);
        if (/(?:^|[;{\s])margin(?:-top|-bottom)?:\s*(?!0(?:px)?\b)/.test(own))
          offenders.push(`${name} field margin: ${own}`);
        const parent = field.parentElement;
        if (parent !== null && OUTSIDE_AIR.test(declarationsOf(parent))) {
          offenders.push(
            `${name} ${parent.getAttribute("data-testid") ?? parent.className}: ${declarationsOf(parent)}`,
          );
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
