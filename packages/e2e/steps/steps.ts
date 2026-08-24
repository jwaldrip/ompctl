/**
 * The shared vocabulary. Every step here is expressed only through `E2EClient`,
 * which is what keeps one feature file honest on web, iOS, and Android.
 *
 * Steps address elements by `testID` and never by visible copy. Copy is
 * translated and reworded; a testID is a contract. The one exception is
 * `I can read "..." in "<testId>"`, where the text *is* the assertion.
 */
import { Given, Then, When } from "@cucumber/cucumber";
import { strict as assert } from "node:assert";
import { writeSync } from "node:fs";
import type { OmpctlWorld } from "../support/world.ts";

When("I select {string}", async function (this: OmpctlWorld, testId: string) {
  // Resolved like a field value: a row keyed by a per-run session id cannot be
  // written literally into a feature file, and select is how a row opens.
  await this.app.tap(this.resolve(testId));
});

When("I fill in {string} with {string}", async function (this: OmpctlWorld, testId: string, value: string) {
  await this.app.fill(testId, this.resolve(value));
});

When("I dismiss the keyboard", async function (this: OmpctlWorld) {
  await this.app.dismissKeyboard();
});

When("I scroll {string} to its top", async function (this: OmpctlWorld, testId: string) {
  await this.app.scrollToStart(testId);
});

When("I scroll {string} to its end", async function (this: OmpctlWorld, testId: string) {
  await this.app.scrollToEnd(testId);
});

Then("I can see {string}", async function (this: OmpctlWorld, testId: string) {
  await this.app.waitFor(this.resolve(testId));
});

Then("I cannot see {string}", async function (this: OmpctlWorld, testId: string) {
  // Deliberately not a negated `waitFor`: waiting for an absence would pass the
  // instant the app is slow, which is exactly when it is worth failing.
  assert.equal(await this.app.isVisible(this.resolve(testId)), false, `${testId} should not be present`);
});

Then("I can read {string} in {string}", async function (this: OmpctlWorld, expected: string, testId: string) {
  const actual = await this.app.textOf(testId);
  assert.equal(actual, expected, `${testId} read "${actual}"`);
});

/**
 * Case-insensitive on purpose. Casing here is a styling decision, not product
 * behaviour: the same `Kicker` renders "1 SESSION" in a browser, where CSS
 * `text-transform` has already been applied to the text a driver reads back,
 * and "1 session" natively, where the driver reads the untransformed string.
 * Asserting the casing would test which platform is running, not the app.
 */
Then("{string} contains {string}", async function (this: OmpctlWorld, testId: string, needle: string) {
  const actual = await this.app.textOf(testId);
  assert.ok(
    actual.toLowerCase().includes(needle.toLowerCase()),
    `${testId} read "${actual}", which does not contain "${needle}"`,
  );
});

/**
 * The one place a feature file talks to the world outside the app. The path
 * check owns every canonical line, so this prints a bracketed marker it can
 * regex out of suite output, never the canonical string itself: restating
 * `sessions listed: 3` as `sessions listed: 3` is the check script's job, not
 * this suite's. Parsing the count from the fleet's own readout keeps the
 * number honest: it is what the device showed, not what the daemon promised,
 * and a fleet that rendered nothing has no digits to parse and fails here
 * rather than reporting zero.
 */
Then("I report the sessions listed in {string}", async function (this: OmpctlWorld, testId: string) {
  const text = await this.app.textOf(testId);
  const count = Number.parseInt(text.replace(/[^0-9]/g, ""), 10);
  assert.ok(Number.isFinite(count) && count >= 1, `${testId} read "${text}", which reports no sessions`);
  this.attach(`sessions listed: ${count}`, "text/plain");
  // writeSync: cucumber's stdout is a pipe into check-path, so console.log is
  // block-buffered and can exit without flushing. The gate greps this exact
  // marker out of the captured bytes; if it is not on the wire the round trip
  // still happened and the check still fails.
  writeSync(1, `[path] sessions listed: ${count}\n`);
});

/**
 * The reply half of the round trip.
 *
 * This MUST be exact. The old substring match passed an agent row that began
 * with the nonce and then streamed 4,000 characters of `:0:0:0:` followed by
 * "Internal error during token generation". The screenshot proved the
 * product was broken while cucumber reported 18/18. The accessible row label
 * carries the speaker prefix, so equality also proves this is an agent reply,
 * not thinking text or the user's own prompt.
 */
Then("the agent replies in {string} echoing {string}", async function (
  this: OmpctlWorld,
  listId: string,
  needle: string,
) {
  const expected = this.resolve(needle);
  const expectedLabel = `agent: ${expected}`;
  const deadline = Date.now() + 90_000;
  let observed: string[] = [];
  while (Date.now() < deadline) {
    await this.app.scrollToEnd(listId);
    observed = await this.app.labelsOf("entry-assistant");
    if (observed.includes(expectedLabel)) return;
    const { promise: tick, resolve: ticked } = Promise.withResolvers<void>();
    setTimeout(ticked, 500);
    await tick;
  }
  const tail = observed.slice(-3).map(label => JSON.stringify(label)).join(", ");
  assert.fail(
    `no agent row in ${listId} equalled ${JSON.stringify(expectedLabel)} within 90s; last labels: ${tail || "none"}`,
  );
});

Given("I capture {string}", async function (this: OmpctlWorld, name: string) {
  const path = await this.app.screenshot(name);
  this.attach(`captured ${path}`, "text/plain");
});

/**
 * An on-screen row carrying the marker, without scrolling to find it.
 *
 * "The agent replies" scrolls to the end first because its reply is owed at
 * the tail. This step exists for assertions about where the viewport already
 * sits, and mounting is not enough there: a virtualized list keeps whole
 * viewports of rows mounted around the visible one, so a row's existence
 * says nothing about position. Visibility is the position signal, and
 * scrolling here would manufacture the position under test. Matching is
 * containment, not equality, because the row label carries a speaker prefix
 * around the marker.
 */
Then("{string} shows a row echoing {string}", async function (this: OmpctlWorld, listId: string, needle: string) {
  const expected = this.resolve(needle);
  const deadline = Date.now() + 30_000;
  let observed: Array<{ label: string; visible: boolean }> = [];
  while (Date.now() < deadline) {
    observed = await this.app.rowsOf("entry-assistant");
    if (observed.some(row => row.label.includes(expected) && row.visible)) return;
    const { promise: tick, resolve: ticked } = Promise.withResolvers<void>();
    setTimeout(ticked, 500);
    await tick;
  }
  const shown = observed.filter(row => row.visible).length;
  const mounted = observed.some(row => row.label.includes(expected));
  const tail = observed
    .slice(-3)
    .map(row => JSON.stringify(row.label))
    .join(", ");
  assert.fail(
    `no visible row in ${listId} carried ${JSON.stringify(expected)} within 30s; ` +
      `the row is ${mounted ? "mounted but off screen" : "not mounted at all"}, ` +
      `${shown} rows visible, last labels: ${tail || "none"}`,
  );
});

/**
 * The absence half, ordered deliberately after a positive wait.
 *
 * Reading absence immediately would pass on a list that has not laid out yet,
 * which is exactly the false green the ordering prevents: the scenario first
 * waits for a row the new window MUST contain, and only then reads. The
 * settle that follows gives a viewport jump (the defect under test) time to
 * land and show the row it would betray, so a clean read here means the view
 * genuinely stayed put, not that the read outran the failure. Mounted rows
 * do not count: only a row on screen says the view moved to it.
 */
Then("{string} shows no row echoing {string}", async function (this: OmpctlWorld, listId: string, needle: string) {
  const expected = this.resolve(needle);
  const { promise: settle, resolve: settled } = Promise.withResolvers<void>();
  setTimeout(settled, 1_500);
  await settle;
  const observed = await this.app.rowsOf("entry-assistant");
  assert.ok(
    !observed.some(row => row.label.includes(expected) && row.visible),
    `${listId} showed a row carrying ${JSON.stringify(expected)}; the viewport jumped to it`,
  );
});
