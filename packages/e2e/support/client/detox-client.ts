/**
 * The native driver: the real app on a simulator or emulator, through Detox.
 *
 * Detox rather than OS-level keyboard and pointer automation because
 * synthesising keystrokes at the OS level does not reliably reach a simulator's
 * text field. In practice characters arrive mangled or repeated, which reads as
 * a product bug and is not one. `typeText` goes through the app's own view
 * hierarchy, so the field receives exactly what the step asked for.
 *
 * The API is read off globalThis rather than imported. When Detox is driven
 * programmatically, `detox/internals`' `installWorker()` is what publishes
 * `device`, `element`, `by`, and `waitFor`; importing the `detox` package
 * instead yields a module that was never bound to the allocated device.
 * `support/detox-lifecycle.ts` owns that call.
 */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ClientKind, E2EClient } from "./client.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

/** The slice of Detox's globals this driver uses, named so the client stays typed. */
interface DetoxGlobals {
  device: {
    launchApp(options: { newInstance: boolean; permissions?: Record<string, string> }): Promise<void>;
    takeScreenshot(name: string): Promise<string>;
  };
  element(matcher: unknown): {
    tap(): Promise<void>;
    clearText(): Promise<void>;
    typeText(text: string): Promise<void>;
    getAttributes(): Promise<{ text?: string; label?: string }>;
  };
  by: { id(id: string): unknown };
  waitFor(element: unknown): { toExist(): { withTimeout(ms: number): Promise<void> } };
}

/**
 * Reads the globals, failing with the reason rather than a bare undefined.
 *
 * A missing `device` here means `installWorker()` did not run, which is a setup
 * fault worth naming: without it every step would fail with an unrelated
 * TypeError.
 */
function globals(): DetoxGlobals {
  const g = globalThis as unknown as Partial<DetoxGlobals>;
  if (g.device === undefined || g.element === undefined || g.by === undefined || g.waitFor === undefined) {
    throw new Error(
      "Detox globals are missing; detox/internals installWorker() must run before any scenario (see support/detox-lifecycle.ts)",
    );
  }
  return g as DetoxGlobals;
}

export class DetoxClient implements E2EClient {
  readonly kind: ClientKind;

  // Explicit fields rather than constructor parameter properties: those are a
  // TypeScript-only construct that Node's strip-only type removal rejects.
  private readonly artifacts: string;

  private constructor(kind: ClientKind, artifacts: string) {
    this.kind = kind;
    this.artifacts = artifacts;
  }

  static async create(kind: ClientKind): Promise<DetoxClient> {
    return new DetoxClient(kind, process.env.E2E_ARTIFACTS ?? join(process.cwd(), "artifacts"));
  }

  async launch(): Promise<void> {
    // A fresh instance per scenario. Reusing one carries the previous scenario's
    // saved pairing into the next, so a scenario asserting the unpaired first
    // screen would pass only when it happened to run first.
    await globals().device.launchApp({ newInstance: true, permissions: { camera: "NO" } });
  }

  /**
   * Nothing to release per scenario: the device is allocated once for the run and
   * torn down by `uninstallWorker`/`cleanup` in the AfterAll hook. Releasing it
   * here would leave later scenarios without a device.
   */
  async teardown(): Promise<void> {}

  async waitFor(testId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const g = globals();
    await g.waitFor(g.element(g.by.id(testId))).toExist().withTimeout(timeoutMs);
  }

  async isVisible(testId: string): Promise<boolean> {
    const g = globals();
    try {
      await g.element(g.by.id(testId)).getAttributes();
      return true;
    } catch {
      return false;
    }
  }

  async tap(testId: string): Promise<void> {
    await this.waitFor(testId);
    const g = globals();
    await g.element(g.by.id(testId)).tap();
  }

  async fill(testId: string, value: string): Promise<void> {
    await this.waitFor(testId);
    const g = globals();
    const field = g.element(g.by.id(testId));
    await field.tap();
    await field.clearText();
    await field.typeText(value);
  }

  async textOf(testId: string): Promise<string> {
    await this.waitFor(testId);
    const g = globals();
    const attrs = await g.element(g.by.id(testId)).getAttributes();
    return (attrs.text ?? attrs.label ?? "").trim();
  }

  /**
   * Typing a newline is what the platform treats as "done editing"; Detox has no
   * keyboard-dismiss primitive. The app's fields commit on change rather than on
   * blur, so nothing here needs to happen for a value to be read back.
   */
  async dismissKeyboard(): Promise<void> {}

  async screenshot(name: string): Promise<string> {
    mkdirSync(this.artifacts, { recursive: true });
    // Detox writes into its own artifact directory and returns the path; moving
    // it keeps every driver's output in one place for the site build.
    const taken = await globals().device.takeScreenshot(name);
    const path = join(this.artifacts, `${name}-${this.kind}.png`);
    try {
      renameSync(taken, path);
      return path;
    } catch {
      return taken;
    }
  }
}

export default DetoxClient;
