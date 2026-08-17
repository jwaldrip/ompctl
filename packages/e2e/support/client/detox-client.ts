/**
 * The native driver: the real app on a simulator or emulator, through Detox.
 *
 * Detox is used here rather than raw keyboard and pointer automation because
 * synthesising keystrokes at the OS level does not reliably reach a simulator's
 * text field - characters arrive mangled or repeated, which reads as a product
 * bug and is not one. `typeText` goes through the app's own view hierarchy, so
 * what the field receives is what the test asked for.
 *
 * Detox is imported lazily. It attaches to a device as a side effect of being
 * required, so importing it in a web run would try to start a simulator on a
 * machine that may not have one.
 */
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { ClientKind, E2EClient } from "./client.ts";

const DEFAULT_TIMEOUT_MS = 20_000;

/** The slice of Detox this layer uses, named so the client stays typed. */
interface DetoxRuntime {
  init(): Promise<void>;
  cleanup(): Promise<void>;
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
  waitFor(element: unknown): {
    toExist(): { withTimeout(ms: number): Promise<void> };
  };
}

export class DetoxClient implements E2EClient {
  readonly kind: ClientKind;

  // Explicit fields rather than constructor parameter properties: those are a
  // TypeScript-only construct that Node's strip-only type removal rejects.
  private readonly detox: DetoxRuntime;
  private readonly artifacts: string;

  private constructor(detox: DetoxRuntime, kind: ClientKind, artifacts: string) {
    this.detox = detox;
    this.kind = kind;
    this.artifacts = artifacts;
  }

  static async create(kind: ClientKind): Promise<DetoxClient> {
    const detox = (await import("detox")) as unknown as DetoxRuntime;
    await detox.init();
    return new DetoxClient(
      detox,
      kind,
      process.env.E2E_ARTIFACTS ?? join(process.cwd(), "artifacts"),
    );
  }

  async launch(): Promise<void> {
    // A fresh instance per scenario. Reusing one carries the previous
    // scenario's pairing into the next, so a test that assumes an unpaired app
    // would pass only when it ran first.
    await this.detox.device.launchApp({ newInstance: true, permissions: { camera: "NO" } });
  }

  async teardown(): Promise<void> {
    await this.detox.cleanup();
  }

  async waitFor(testId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    await this.detox.waitFor(this.detox.element(this.detox.by.id(testId))).toExist().withTimeout(timeoutMs);
  }

  async isVisible(testId: string): Promise<boolean> {
    try {
      await this.detox.element(this.detox.by.id(testId)).getAttributes();
      return true;
    } catch {
      return false;
    }
  }

  async tap(testId: string): Promise<void> {
    await this.waitFor(testId);
    await this.detox.element(this.detox.by.id(testId)).tap();
  }

  async fill(testId: string, value: string): Promise<void> {
    await this.waitFor(testId);
    const field = this.detox.element(this.detox.by.id(testId));
    await field.tap();
    await field.clearText();
    await field.typeText(value);
  }

  async textOf(testId: string): Promise<string> {
    await this.waitFor(testId);
    const attrs = await this.detox.element(this.detox.by.id(testId)).getAttributes();
    return (attrs.text ?? attrs.label ?? "").trim();
  }

  /**
   * Detox has no keyboard-dismiss primitive. Typing a newline is what the
   * platform itself treats as "done editing", and it is what the app's own
   * fields already handle.
   */
  async dismissKeyboard(): Promise<void> {}

  async screenshot(name: string): Promise<string> {
    mkdirSync(this.artifacts, { recursive: true });
    // Detox writes into its own artifact directory and hands back the path;
    // moving it keeps every driver's output in one place for the site build.
    const taken = await this.detox.device.takeScreenshot(name);
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
