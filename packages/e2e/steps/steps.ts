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
  await this.app.tap(testId);
});

When("I fill in {string} with {string}", async function (this: OmpctlWorld, testId: string, value: string) {
  await this.app.fill(testId, this.resolve(value));
});

When("I dismiss the keyboard", async function (this: OmpctlWorld) {
  await this.app.dismissKeyboard();
});

Then("I can see {string}", async function (this: OmpctlWorld, testId: string) {
  await this.app.waitFor(testId);
});

Then("I cannot see {string}", async function (this: OmpctlWorld, testId: string) {
  // Deliberately not a negated `waitFor`: waiting for an absence would pass the
  // instant the app is slow, which is exactly when it is worth failing.
  assert.equal(await this.app.isVisible(testId), false, `${testId} should not be present`);
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
 * The reply half of the round trip. A fixed sleep would pass on a dead socket
 * that merely outlasts it, and a bare existence check would pass on a reply
 * left over from before the prompt. So this waits for the one thing neither
 * can fake: the agent echoing the per-scenario nonce that no earlier turn
 * contains. The speaker's row id `entry-assistant` is fixed here on purpose:
 * the step is about the agent, and which rows speak for the agent is the
 * app's contract, not the scenario's to choose. Each poll scrolls the list to
 * its end first, because a virtualized list leaves the newest rows unmounted
 * until something scrolls to them, and the echo is always the newest row.
 */
Then("the agent replies in {string} echoing {string}", async function (
  this: OmpctlWorld,
  listId: string,
  needle: string,
) {
  const expected = this.resolve(needle);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await this.app.scrollToEnd(listId);
    const labels = await this.app.labelsOf("entry-assistant");
    if (labels.some(label => label.toLowerCase().includes(expected.toLowerCase()))) {
      return;
    }
    const { promise: tick, resolve: ticked } = Promise.withResolvers<void>();
    setTimeout(ticked, 500);
    await tick;
  }
  assert.fail(`no agent row in ${listId} echoed "${expected}" within 90s`);
});

Given("I capture {string}", async function (this: OmpctlWorld, name: string) {
  const path = await this.app.screenshot(name);
  this.attach(`captured ${path}`, "text/plain");
});
