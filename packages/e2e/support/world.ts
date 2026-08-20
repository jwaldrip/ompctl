/**
 * One scenario's state: its driver, and the values a step is allowed to
 * substitute into a feature file.
 *
 * Pairing needs a live daemon endpoint and a real device token. Neither can sit
 * in a `.feature` file: the token is a bearer credential for a daemon that runs
 * code as the operator, and committing one would be committing a key. So
 * features refer to them by name (`<endpoint>`, `<token>`) and the World is the
 * only place that resolves those names, from the environment.
 */
import { World, setWorldConstructor, type IWorldOptions } from "@cucumber/cucumber";
import type { E2EClient } from "./client/client-factory.ts";

export class OmpctlWorld extends World {
  client: E2EClient | null = null;
  /**
   * The unique token this scenario asked the agent to echo. Generated once and
   * then pinned, so the prompt step and the reply assertion see the same
   * string. A committed constant would let a second run against the same
   * long-lived session satisfy itself with the previous run's reply, which is
   * exactly the false green the round-trip scenario exists to prevent.
   */
  private nonce: string | null = null;


  constructor(options: IWorldOptions) {
    super(options);
  }

  /** The driver, or a clear failure instead of a null dereference mid-step. */
  get app(): E2EClient {
    if (this.client === null) throw new Error("no client for this scenario; the Before hook did not run");
    return this.client;
  }

  /**
   * Resolves the placeholders a feature is allowed to use.
   *
   * Unknown placeholders are left untouched rather than replaced with an empty
   * string: typing nothing into a field looks like a UI bug, while an
   * unsubstituted `<endpoint>` in a failure message points straight at the cause.
   */
  resolve(value: string): string {
    return value.replace(/<(endpoint|token|nonce)>/g, (whole, name: string) => {
      if (name === "nonce") {
        this.nonce ??= `ompctl-path-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
        return this.nonce;
      }
      const env = name === "endpoint" ? process.env.OMPD_E2E_ENDPOINT : process.env.OMPD_E2E_TOKEN;
      if (env === undefined || env.trim().length === 0) {
        throw new Error(
          `this scenario needs <${name}>; set ${name === "endpoint" ? "OMPD_E2E_ENDPOINT" : "OMPD_E2E_TOKEN"} from a real pairing`,
        );
      }
      return env.trim();
    });
  }
}

setWorldConstructor(OmpctlWorld);
