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

Then("{string} contains {string}", async function (this: OmpctlWorld, testId: string, needle: string) {
  const actual = await this.app.textOf(testId);
  assert.ok(actual.includes(needle), `${testId} read "${actual}", which does not contain "${needle}"`);
});

Given("I capture {string}", async function (this: OmpctlWorld, name: string) {
  const path = await this.app.screenshot(name);
  this.attach(`captured ${path}`, "text/plain");
});
