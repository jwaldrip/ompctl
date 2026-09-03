/**
 * Cucumber wiring, shared by every driver.
 *
 * The step definitions are loaded straight from TypeScript rather than compiled
 * to a `dist/` first: they share types with the app, and a build step would let
 * the two drift without anything noticing.
 *
 * `tsx/cjs` does that transpiling, not `ts-node`. This repository pins
 * TypeScript 7 (`@typescript/native-preview`), and ts-node drives the 5.x
 * compiler API, so it fails while merely reading the tsconfig. tsx goes through
 * esbuild and does not touch that API.
 */
module.exports = {
  default: {
    require: ["support/**/*.ts", "steps/**/*.ts"],
    requireModule: ["tsx/cjs"],
    paths: ["features/**/*.feature"],
    format: ["summary", "progress"],
    formatOptions: { snippetInterface: "async-await" },
    // A scenario that fails for a flaky reason should say so loudly rather than
    // being retried into a false green, so retries stay off by default.
    retry: 0,
    // A tag filter from the environment rather than a parallel profile: the
    // path check runs exactly the @path scenario against a real device, and a
    // second profile would drift from this one the first time only one of
    // them learned a new default.
    ...(process.env.E2E_TAGS ? { tags: process.env.E2E_TAGS } : {}),
  },
};
