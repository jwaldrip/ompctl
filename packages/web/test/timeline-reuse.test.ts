/// <reference lib="dom" />

/**
 * Test timeline reuse bug: when a cached timeline is rendered with a
 * completely different state, the old entries should be cleared.
 */

import { describe, expect, test } from "bun:test";
import { appendPrompt, EMPTY_SESSION } from "../src/session/model.ts";
import { createTimeline } from "../src/session/render.ts";

describe("timeline reuse edge case", () => {
  test("rendering empty state on a cached timeline removes previous entries", () => {
    const timeline = createTimeline({});

    // First: render with 3 entries
    let state1 = appendPrompt(EMPTY_SESSION, "Entry 1");
    state1 = appendPrompt(state1, "Entry 2");
    state1 = appendPrompt(state1, "Entry 3");
    timeline.render(state1);
    expect(timeline.element.querySelectorAll(".entry").length).toBe(3);

    // Second: render with 0 entries (simulating switch to empty state)
    const state2 = EMPTY_SESSION;
    timeline.render(state2);

    // THE BUG: if entries are not properly cleared, they'll still be visible
    expect(timeline.element.querySelectorAll(".entry").length).toBe(0);
  });

  test("rendering completely different entries of same length removes old ones", () => {
    // This is the exact bug: if we render the same number of entries but
    // they're completely different (different IDs/content), the old ones
    // should still be removed even though next.length === rendered.length
    const timeline = createTimeline({});

    // First visit: 3 entries
    let state1 = appendPrompt(EMPTY_SESSION, "Old alpha");
    state1 = appendPrompt(state1, "Old beta");
    state1 = appendPrompt(state1, "Old gamma");
    timeline.render(state1);
    expect(timeline.element.querySelectorAll(".entry").length).toBe(3);
    expect(timeline.element.textContent).toContain("Old alpha");

    // Second visit (different agent): 3 completely different entries
    let state2 = appendPrompt(EMPTY_SESSION, "New X");
    state2 = appendPrompt(state2, "New Y");
    state2 = appendPrompt(state2, "New Z");
    timeline.render(state2);

    // Should show 3 entries, not 6 (not 3+3)
    const entries = timeline.element.querySelectorAll(".entry");
    expect(entries.length).toBe(3);
    // Should show new content
    expect(timeline.element.textContent).toContain("New X");
    expect(timeline.element.textContent).toContain("New Y");
    expect(timeline.element.textContent).toContain("New Z");
    // Should NOT show old content
    expect(timeline.element.textContent).not.toContain("Old alpha");
    expect(timeline.element.textContent).not.toContain("Old beta");
    expect(timeline.element.textContent).not.toContain("Old gamma");
  });

  test("rendering fewer entries removes the extras", () => {
    const timeline = createTimeline({});

    // First: 5 entries with distinct content
    let state1 = appendPrompt(EMPTY_SESSION, "Purple rabbit");
    state1 = appendPrompt(state1, "Silver horse");
    state1 = appendPrompt(state1, "Golden dragon");
    state1 = appendPrompt(state1, "Blue elephant");
    state1 = appendPrompt(state1, "Red phoenix");
    timeline.render(state1);
    expect(timeline.element.querySelectorAll(".entry").length).toBe(5);

    // Second: 2 different entries (fewer than before)
    let state2 = appendPrompt(EMPTY_SESSION, "Green turtle");
    state2 = appendPrompt(state2, "Yellow tiger");
    timeline.render(state2);

    // Should show 2 entries, not 7
    expect(timeline.element.querySelectorAll(".entry").length).toBe(2);
    expect(timeline.element.textContent).toContain("Green turtle");
    expect(timeline.element.textContent).toContain("Yellow tiger");
    // Old entries should not be visible
    expect(timeline.element.textContent).not.toContain("Purple rabbit");
    expect(timeline.element.textContent).not.toContain("Red phoenix");
  });
});
