/**
 * Per-scenario driver lifecycle, and a screenshot when something fails.
 *
 * The driver is created per scenario rather than once per run. Detox's own
 * guidance is a fresh app instance per test, and on web a shared browser would
 * carry one scenario's saved pairing into the next, so a scenario asserting the
 * unpaired first screen would pass only when it happened to run first.
 */
import { After, Before, Status, setDefaultTimeout } from "@cucumber/cucumber";
import { createClient } from "./client/client-factory.ts";
import type { OmpctlWorld } from "./world.ts";

// Native launches and first paints are slower than Cucumber's 5s default; a
// timeout here reads as a product failure when it is only an impatient runner.
setDefaultTimeout(120_000);

Before(async function (this: OmpctlWorld) {
  this.client = await createClient();
  await this.app.launch();
});

After(async function (this: OmpctlWorld, scenario) {
  // Capture before teardown: a closed browser or a cleaned-up device cannot be
  // photographed, and the failing screen is the only thing worth having.
  if (scenario.result?.status === Status.FAILED && this.client !== null) {
    const name = `failure-${scenario.pickle.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    try {
      const path = await this.app.screenshot(name);
      this.attach(`failure screenshot: ${path}`, "text/plain");
    } catch {
      // A screenshot failure must not replace the real failure in the report.
    }
  }
  await this.client?.teardown();
  this.client = null;
});
