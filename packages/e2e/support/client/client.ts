/**
 * The one surface every driver implements, so a `.feature` file never learns
 * which platform is running it.
 *
 * The vocabulary is deliberately narrow and testID-shaped. Anything richer -
 * CSS selectors, XPath, coordinates, native predicates - would only be
 * expressible by one driver and would quietly split the feature files into a
 * web dialect and a native dialect, which is the whole thing this layer exists
 * to prevent. `testID` is the one addressing scheme both platforms already
 * share: React Native puts it on the native view, and react-native-web emits it
 * as `data-testid`, so the same string reaches the same element in a simulator
 * and in a browser.
 *
 * Methods are all async even where a driver could answer synchronously. Detox is
 * asynchronous to its core, and a synchronous facade over it would force the
 * step definitions to know which driver they had.
 */

/** Which driver a run uses, and therefore what "the app" means. */
export type ClientKind = "web" | "ios" | "android";

export interface E2EClient {
  readonly kind: ClientKind;

  /** Bring the app up to a known first screen. */
  launch(): Promise<void>;

  /** Release the browser or device. Safe to call twice. */
  teardown(): Promise<void>;

  /** Wait until an element exists, failing the step if it never appears. */
  waitFor(testId: string, timeoutMs?: number): Promise<void>;

  /** True when the element is present right now, without waiting for it. */
  isVisible(testId: string): Promise<boolean>;

  /** Tap or click. */
  tap(testId: string): Promise<void>;

  /**
   * Replace a field's contents. Implementations clear first: appending to a
   * value left by an earlier scenario is the kind of order dependence that
   * makes a suite pass alone and fail in a run.
   */
  fill(testId: string, value: string): Promise<void>;

  /** The element's rendered text, for assertions about content. */
  textOf(testId: string): Promise<string>;

  /** Put the on-screen keyboard away so it stops covering the next target. */
  dismissKeyboard(): Promise<void>;

  /**
   * Write a full-screen image and return its path. This is the artifact the
   * marketing site consumes, so it is a first-class capability rather than a
   * debugging afterthought.
   */
  screenshot(name: string): Promise<string>;
}
