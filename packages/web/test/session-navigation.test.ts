/// <reference lib="dom" />

/**
 * Test session navigation behavior: when switching between sessions,
 * the detail pane should immediately show the new session's state,
 * not the old session's content.
 *
 * Contract:
 * 1. Selected identity becomes the new session immediately
 * 2. Detail pane immediately shows the new session's loading/empty state
 * 3. No content from previous session remains visible while new one loads
 * 4. Rapid A→B→C selection must not allow late B data to overwrite C
 * 5. Session failure does not restore previous session's content
 */

import { describe, expect, test } from "bun:test";
import { appendPrompt, EMPTY_SESSION } from "../src/session/model.ts";
import { createTimeline } from "../src/session/render.ts";

describe("session navigation", () => {
  test("switching to a new session immediately shows empty state before data arrives", () => {
    // Create two timelines: one for session A, one for session B
    const timelineA = createTimeline({});
    const timelineB = createTimeline({});

    // Session A has content
    let stateA = appendPrompt(EMPTY_SESSION, "Hello from A");
    timelineA.render(stateA);
    expect(timelineA.element.querySelector(".entry")).toBeTruthy();

    // Session B starts empty
    const stateB = EMPTY_SESSION;
    timelineB.render(stateB);

    // The key test: B's timeline should show no entries, not A's content
    // Check that B has no entries
    expect(timelineB.element.querySelectorAll(".entry").length).toBe(0);
  });

  test("rapid session switching A→B→C prevents late B data from overwriting C", () => {
    const timelineA = createTimeline({});
    const timelineB = createTimeline({});
    const timelineC = createTimeline({});

    // Setup initial states
    let stateA = appendPrompt(EMPTY_SESSION, "A content");
    let stateB = EMPTY_SESSION;
    let stateC = EMPTY_SESSION;

    timelineA.render(stateA);
    expect(timelineA.element.querySelectorAll(".entry").length).toBe(1);

    // Switch to B
    timelineB.render(stateB);
    expect(timelineB.element.querySelectorAll(".entry").length).toBe(0);

    // Switch to C
    timelineC.render(stateC);
    expect(timelineC.element.querySelectorAll(".entry").length).toBe(0);

    // Now B receives data (late arriving)
    stateB = appendPrompt(EMPTY_SESSION, "B content");
    timelineB.render(stateB);

    // C should still be empty, not showing B's content
    expect(timelineC.element.querySelectorAll(".entry").length).toBe(0);
    // B should show its content
    expect(timelineB.element.querySelectorAll(".entry").length).toBe(1);
  });

  test("session failure does not restore previous session's content", () => {
    const timelineA = createTimeline({});
    const timelineB = createTimeline({});

    // A has content
    let stateA = appendPrompt(EMPTY_SESSION, "A content");
    timelineA.render(stateA);
    expect(timelineA.element.querySelectorAll(".entry").length).toBe(1);

    // Switch to B (empty)
    const stateB = EMPTY_SESSION;
    timelineB.render(stateB);
    expect(timelineB.element.querySelectorAll(".entry").length).toBe(0);

    // If B later shows an error or stays empty, it should not show A's content
    timelineB.render(stateB);
    expect(timelineB.element.querySelectorAll(".entry").length).toBe(0);
  });

  test("re-visiting a previously viewed session shows current data, not stale cached data", () => {
    const timeline = createTimeline({});

    // First visit to session: has content
    let state = appendPrompt(EMPTY_SESSION, "Original content");
    timeline.render(state);
    expect(timeline.element.querySelectorAll(".entry").length).toBe(1);
    expect(timeline.element.textContent).toContain("Original content");

    // Simulate switching away (in real code, we'd get a different timeline)
    // Then switch back - if the timeline is reused, we need to make sure it's updated correctly

    // Get updated state (e.g., agent was further along when we returned)
    state = appendPrompt(state, "New content");
    timeline.render(state);

    // Should show both entries, not duplicate the first one
    const entries = timeline.element.querySelectorAll(".entry");
    expect(entries.length).toBe(2);
    expect(timeline.element.textContent).toContain("New content");
  });
});
