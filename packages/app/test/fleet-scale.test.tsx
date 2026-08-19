/**
 * The list at the size a real machine produces.
 *
 * The operator's own phone showed 534 sessions grouped across 93 directories,
 * and the screen was slow to reach and slow to move. The cause was not the
 * data: `FleetScreen` asked its virtualizer to render the entire visible set
 * on the first pass, on the reasoning that a directory listing should never
 * hide a row from a search or a screen reader sweep. That reasoning cost a
 * phone every one of those rows on every render, so this file pins the
 * opposite invariant: a bounded number of rows mount, whatever the corpus
 * size.
 *
 * The mount count is the assertion, because it is deterministic. Wall time is
 * printed rather than asserted: it is the number a human compares before and
 * after, and a machine-dependent threshold in a test suite is a flake with a
 * plan.
 *
 * There is no layout in happy-dom, so no scroll or layout event ever grows the
 * window past the first batch. That is exactly the static-render case the old
 * comment worried about, which makes this the cheapest place to observe the
 * defect: an eager list mounts all 534 rows here, a windowed one mounts its
 * first batch.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserSession, BrowserState, SessionStatus } from "../src/session/browser.ts";
import { EMPTY_BROWSER } from "../src/session/browser.ts";

// Dynamic on purpose, same reason as `fleet-screen.test.tsx`: a static import
// of a screen would pull the real `react-native` in before `./rnw.ts` could
// substitute it.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");

/** The shape his device reported: 534 sessions spread unevenly over 93 directories. */
const SESSION_COUNT = 534;
const DIR_COUNT = 93;
const STATUSES: readonly SessionStatus[] = ["live-tui", "live-ompd", "dormant"];

function makeScaleCorpus(): BrowserSession[] {
  const rows: BrowserSession[] = [];
  for (let i = 0; i < SESSION_COUNT; i += 1) {
    const dir = i % DIR_COUNT;
    rows.push({
      id: `sess_scale_${i}`,
      title: `repo-${dir} turn ${Math.floor(i / DIR_COUNT) + 1}`,
      cwd: `/Users/op/dev/src/github.com/op/repo-${dir}`,
      status: STATUSES[i % STATUSES.length] as SessionStatus,
      createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28), i % 24)).toISOString(),
      lastActiveAt: new Date(Date.UTC(2026, 1, 1 + (i % 27), i % 23)).toISOString(),
      messageCount: (i * 7) % 400,
      sizeBytes: (i * 4099) % 900_000,
    });
  }
  return rows;
}

const CORPUS = makeScaleCorpus();
const NOW = Date.parse("2026-03-01T00:00:00.000Z");

const NOOP_SESSION = (_session: BrowserSession) => {};
const NOOP = () => {};

function state(overrides: Partial<BrowserState> = {}): BrowserState {
  return { ...EMPTY_BROWSER, sessions: CORPUS, ...overrides };
}

function render(browser: BrowserState): string {
  return renderToStaticMarkup(
    <FleetScreen
      browser={browser}
      now={NOW}
      onSort={NOOP}
      onToggleGroup={NOOP}
      onToggleGrouped={NOOP}
      onToggleArchived={NOOP}
      onOpen={NOOP_SESSION}
      onArchive={NOOP_SESSION}
      onUnarchive={NOOP_SESSION}
    />,
  );
}

function countRows(markup: string): number {
  return (markup.match(/data-testid="session-row-/g) ?? []).length;
}

/** Median of a handful of renders: one sample of a JIT-warmed render is noise. */
function timeRender(browser: BrowserState, samples = 5): number {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const started = performance.now();
    render(browser);
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)] as number;
}

/**
 * A phone's first paint is one screenful plus a small look-ahead. Twelve rows
 * fill a 390x844 screen with room to spare, and the batch the virtualizer adds
 * on top of that is bounded by the same constant, so anything past a few dozen
 * mounted rows means the window is not being respected.
 */
const BOUND = 64;

describe("534 sessions do not all mount", () => {
  test("grouped: the first pass mounts a bounded window, not the corpus", () => {
    const markup = render(state({ grouped: true }));
    const mounted = countRows(markup);

    console.log(
      `[fleet-scale] grouped 534 rows / 93 groups: ${mounted} rows mounted, ${timeRender(state({ grouped: true })).toFixed(1)}ms median render`,
    );

    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(BOUND);
  });

  test("flat: the first pass mounts a bounded window, not the corpus", () => {
    const markup = render(state({ grouped: false }));
    const mounted = countRows(markup);

    console.log(
      `[fleet-scale] flat 534 rows: ${mounted} rows mounted, ${timeRender(state({ grouped: false })).toFixed(1)}ms median render`,
    );

    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThanOrEqual(BOUND);
  });

  test("the count in the header still reports every session, mounted or not", () => {
    // Windowing must not turn into lying about the corpus: the header count is
    // how an operator knows the list is complete.
    const markup = render(state({ grouped: true }));
    expect(markup).toContain(`${SESSION_COUNT} sessions`);
  });
});
