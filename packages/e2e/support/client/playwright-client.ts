/**
 * The web driver: the same React app, rendered by react-native-web, driven in a
 * real browser.
 *
 * `testID` arrives here as `data-testid` because react-native-web forwards it,
 * which is what lets one feature file address both platforms. Every locator is
 * built from that single attribute for the same reason.
 *
 * The viewport is a tablet by default. The app's layout switches on the
 * *shortest* side, so a phone-sized browser window would exercise only the
 * single-pane path and the two-pane console would never render.
 */
import { type Browser, type Page, chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ClientKind, E2EClient } from "./client.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export class PlaywrightClient implements E2EClient {
  readonly kind: ClientKind = "web";
  private browser: Browser | null = null;
  private page: Page | null = null;

  // Declared and assigned rather than written as constructor parameter
  // properties: those are a TypeScript-only construct, and Node's built-in
  // strip-only type removal refuses them outright.
  private readonly baseUrl: string;
  private readonly artifacts: string;

  private constructor(baseUrl: string, artifacts: string) {
    this.baseUrl = baseUrl;
    this.artifacts = artifacts;
  }

  static create(): PlaywrightClient {
    return new PlaywrightClient(
      process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
      process.env.E2E_ARTIFACTS ?? join(process.cwd(), "artifacts"),
    );
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({ headless: process.env.E2E_HEADED !== "true" });
    const context = await this.browser.newContext({
      viewport: { width: 1180, height: 820 },
      deviceScaleFactor: 2,
    });
    this.page = await context.newPage();
    await this.page.goto(this.baseUrl, { waitUntil: "domcontentloaded" });
  }

  async teardown(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  /** Fails loudly rather than returning a null page that reads as "not found". */
  private active(): Page {
    if (this.page === null) throw new Error("the browser is not open; launch() first");
    return this.page;
  }

  private locator(testId: string) {
    return this.active().locator(`[data-testid="${testId}"]`).first();
  }

  async waitFor(testId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    await this.locator(testId).waitFor({ state: "attached", timeout: timeoutMs });
  }

  async isVisible(testId: string): Promise<boolean> {
    return (await this.locator(testId).count()) > 0;
  }

  async tap(testId: string): Promise<void> {
    await this.locator(testId).click({ timeout: DEFAULT_TIMEOUT_MS });
  }

  async fill(testId: string, value: string): Promise<void> {
    const field = this.locator(testId);
    await field.waitFor({ state: "attached", timeout: DEFAULT_TIMEOUT_MS });
    await field.fill("");
    await field.fill(value);
    // react-native-web's TextInput commits through React state; without letting
    // that flush, a following assertion can read the previous value.
    await this.active().waitForTimeout(100);
  }

  async textOf(testId: string): Promise<string> {
    return (await this.locator(testId).innerText()).trim();
  }

  async scrollToEnd(testId: string): Promise<void> {
    const list = this.locator(testId);
    await list.waitFor({ state: "attached", timeout: DEFAULT_TIMEOUT_MS });
    await list.evaluate(node => {
      node.scrollTop = node.scrollHeight;
    });
    // react-native-web mounts virtualized rows a frame after the offset
    // moves, so reading immediately would describe the pre-scroll window.
    await this.active().waitForTimeout(150);
  }

  async scrollToStart(testId: string): Promise<void> {
    const list = this.locator(testId);
    await list.waitFor({ state: "attached", timeout: DEFAULT_TIMEOUT_MS });
    await list.evaluate(node => {
      node.scrollTop = 0;
    });
    // Same settle as scrollToEnd: the window mounts a frame after the offset.
    await this.active().waitForTimeout(150);
  }

  async labelsOf(testId: string): Promise<string[]> {
    // aria-label rather than text content: the app marks each transcript row
    // accessible with a speaker-prefixed label, which is the one string both
    // this driver and the native one can read back.
    return this.active()
      .locator(`[data-testid="${testId}"]`)
      .evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.textContent ?? ""));
  }

  async rowsOf(testId: string): Promise<Array<{ label: string; visible: boolean }>> {
    // The same aria-label read as labelsOf, plus the browser's own notion of
    // on-screen: a row whose box intersects the viewport. A virtualized list
    // keeps off-screen rows in the DOM exactly as the native one keeps them
    // mounted, so visibility, not existence, is the position signal.
    return this.active()
      .locator(`[data-testid="${testId}"]`)
      .evaluateAll(nodes =>
        nodes.map(node => ({
          label: node.getAttribute("aria-label") ?? node.textContent ?? "",
          // ownerDocument rather than window: this file typechecks against
          // Node's types while the body itself runs in the page.
          visible:
            node.getBoundingClientRect().bottom > 0 &&
            node.getBoundingClientRect().top < (node.ownerDocument.defaultView?.innerHeight ?? 0) &&
            node.getBoundingClientRect().height > 0,
        })),
      );
  }

  /** A browser has no on-screen keyboard, so this is honestly a no-op. */
  async dismissKeyboard(): Promise<void> {}

  async screenshot(name: string): Promise<string> {
    mkdirSync(this.artifacts, { recursive: true });
    const path = join(this.artifacts, `${name}-web.png`);
    await this.active().screenshot({ path, fullPage: false });
    return path;
  }
}

export default PlaywrightClient;
