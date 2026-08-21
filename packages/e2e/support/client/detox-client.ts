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
import { execSync } from "node:child_process";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ClientKind, E2EClient } from "./client.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

/** The slice of Detox's globals this driver uses, named so the client stays typed. */
interface DetoxGlobals {
  device: {
    clearKeychain(): Promise<void>;
    launchApp(options: {
      newInstance: boolean;
      delete?: boolean;
      permissions?: Record<string, string>;
      launchArgs?: Record<string, string>;
    }): Promise<void>;
    takeScreenshot(name: string): Promise<string>;
  };
  element(matcher: unknown): {
    tap(point?: { x: number; y: number }): Promise<void>;
    clearText(): Promise<void>;
    replaceText(text: string): Promise<void>;
    typeText(text: string): Promise<void>;
    getAttributes(): Promise<{ text?: string; label?: string }>;
    scroll(pixels: number, direction: "up" | "down" | "left" | "right"): Promise<void>;
    atIndex(index: number): { getAttributes(): Promise<{ text?: string; label?: string }> };
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

  /**
   * A genuinely fresh app per scenario, state included.
   *
   * `newInstance` restarts the process but leaves persisted storage alone, and
   * this app deliberately keeps its device token in the platform keystore. So
   * once any scenario completes a pairing, every later scenario launches ALREADY
   * paired and never sees the pair screen: the whole suite passed up to the
   * pairing scenario and then failed from there down, purely on ordering.
   *
   * The web driver gets a clean browser context per scenario, so wiping here is
   * what keeps one feature file meaning the same thing on both platforms. That
   * equivalence is the entire point of this layer, and it is worth an extra
   * second per scenario.
   */
  private resetPersistedState(): void {
    const serial = process.env.DETOX_ADB_NAME;
    if (this.kind !== "android" || serial === undefined) return;
    const adb = `${process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? ""}/platform-tools/adb`;
    // `pm clear` drops the keystore entry and AsyncStorage together, which is
    // both faster and more thorough than reinstalling the APK via `delete: true`.
    execSync(`${adb} -s ${serial} shell pm clear ai.ompctl.app`, { encoding: "utf8", stdio: "pipe" });
  }

  async launch(): Promise<void> {
    this.resetPersistedState();
    // A pairing lives in both AsyncStorage and the keychain. Android's pm clear
    // drops both; an iOS Simulator uninstall does not clear the keychain, so
    // Detox must clear it explicitly before reinstalling the app. Without both
    // halves, a prior pairing bypasses the form and the next run measures old
    // state instead of the scenario.
    if (this.kind === "ios") await globals().device.clearKeychain();
    await globals().device.launchApp({
      newInstance: true,
      delete: this.kind === "ios",
      permissions: { camera: "NO" },
      // Only the iOS simulator needs this. The password-manager sheet lives
      // outside the app and Detox cannot reach it on iOS 26; the launch flag
      // prevents creating that sheet without weakening human launches.
      launchArgs: this.kind === "ios" ? { OMPCTL_E2E_PLAINTEXT_TOKEN: "YES" } : undefined,
    });
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
    try {
      await g.element(g.by.id(testId)).tap();
    } catch (cause) {
      // Dismissing the keyboard moves the composer while it animates, and a
      // tap landing mid-animation fails Detox's visibility probe on a control
      // a person could plainly press. One settle and one retry: a control that
      // is genuinely unreachable still fails, with its original reason.
      if (this.kind !== "ios") throw cause;
      await new Promise(resolve => setTimeout(resolve, 750));
      await g.element(g.by.id(testId)).tap();
    }
  }

  async fill(testId: string, value: string): Promise<void> {
    await this.waitFor(testId);
    const g = globals();
    const field = g.element(g.by.id(testId));
    // replaceText writes the value through the native view without driving the
    // IME. typeText was the Android path until a Pixel run proved it opens
    // Gboard, whose toolbar then sits over the next field; the following tap
    // hits Gboard's settings gear, Espresso reports no activity in RESUMED,
    // and the suite is looking at a keyboard preferences screen. iOS already
    // used replaceText to keep the system password sheet from appearing; the
    // same call is what keeps Android inside the app.
    //
    // Detox's default activation point sits at the field's top-left corner
    // and fails the visibility probe against a hairline border, so an
    // explicit interior point is the same gesture without the corner.
    await field.tap({ x: 40, y: 20 });
    await field.replaceText(value);
  }

  async textOf(testId: string): Promise<string> {
    await this.waitFor(testId);
    const g = globals();
    const attrs = await g.element(g.by.id(testId)).getAttributes();
    return (attrs.text ?? attrs.label ?? "").trim();
  }

  async scrollToEnd(testId: string): Promise<void> {
    await this.waitFor(testId);
    const g = globals();
    // One deliberately oversized distance rather than a measured one: both
    // platforms clamp a scroll at the content edge, so this is how a driver
    // says "the end" without learning the content height, which neither
    // platform exposes portably.
    //
    // A list whose content is shorter than its viewport cannot scroll at all,
    // and iOS reports that refusal as an error. Being already at the end is
    // exactly what this method wanted, so it is not a failure: a young session
    // with three entries is the normal case, not a broken one.
    try {
      await g.element(g.by.id(testId)).scroll(100_000, "down");
    } catch (cause) {
      if (!/Unable to scroll/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
    }
  }

  async labelsOf(testId: string): Promise<string[]> {
    const g = globals();
    const labels: string[] = [];
    // Detox has no way to enumerate or count matches. Probing successive
    // indexes is the honest equivalent: the first index that fails to resolve
    // is the end of the matches, and only mounted rows resolve at all, which
    // is why a caller hunting the end of a long list scrolls there first.
    for (let index = 0; index < 1000; index += 1) {
      try {
        const attrs = await g.element(g.by.id(testId)).atIndex(index).getAttributes();
        labels.push(attrs.text ?? attrs.label ?? "");
      } catch {
        return labels;
      }
    }
    return labels;
  }

  /**
   * Put the keyboard away by tapping the screen's scroll surface, which is what
   * a person does: React Native's lists dismiss the keyboard on a tap that is
   * not on an input. This was a no-op while the phone's keyboard left the send
   * control reachable; an iPad's keyboard covers it, so the scenario stalled on
   * a control the operator can see and press.
   *
   * Android needs nothing here: its own back gesture is not in play and the
   * composer stays reachable. A screen with no scroll surface is not an error;
   * there is simply nothing to tap.
   */
  async dismissKeyboard(): Promise<void> {
    if (this.kind !== "ios") return;
    const g = globals();
    for (const surface of ["transcript", "fleet-list", "fleet"]) {
      try {
        await g.element(g.by.id(surface)).tap({ x: 20, y: 20 });
        return;
      } catch {
        // Try the next surface: which one exists depends on the screen.
      }
    }
  }

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
