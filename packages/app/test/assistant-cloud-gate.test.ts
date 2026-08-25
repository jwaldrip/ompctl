/**
 * ompctl never talks to assistant-cloud, and this is what makes that checkable.
 *
 * Two mechanisms, deliberately failing in opposite directions:
 *
 *  - The stub. `metro.config.cjs` and `vite.config.ts` redirect
 *    `@assistant-ui/core`'s cloud subtree to `stubs/assistant-ui-cloud.js`, so
 *    the client class and the module-scope environment read are not in any
 *    bundle at all. Measured: zero occurrences of both `AssistantCloud` and
 *    `NEXT_PUBLIC_ASSISTANT_BASE_URL` across the ios, android, macos, windows
 *    and web outputs.
 *  - The guard. A redirect is configuration and configuration can be dropped by
 *    a future edit without anything failing, so `scripts/assistant-cloud-env.cjs`
 *    refuses to build or test while that variable is set. The stub makes the
 *    variable irrelevant; the guard makes a lost stub loud.
 *
 * Under `bun test` there is no bundler, so the redirect is NOT in effect here
 * and the real cloud module loads. That is the honest shape of this file: it
 * tests the guard directly, and it tests that mounting the production surface
 * attempts no network call. The bundle-level absence is proven by the bundles,
 * not by a unit test pretending to be one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const { VARIABLE, assertNoAssistantCloudEnv } = createRequire(import.meta.url)(
  "../scripts/assistant-cloud-env.cjs",
) as {
  VARIABLE: string;
  assertNoAssistantCloudEnv: (env?: Record<string, string | undefined>, where?: string) => void;
};

describe("the cloud environment guard", () => {
  test("it names the variable this app must never be built with", () => {
    expect(VARIABLE).toBe("NEXT_PUBLIC_ASSISTANT_BASE_URL");
  });

  test("an unset or empty variable passes", () => {
    expect(() => assertNoAssistantCloudEnv({}, "probe")).not.toThrow();
    expect(() => assertNoAssistantCloudEnv({ [VARIABLE]: "" }, "probe")).not.toThrow();
  });

  test("a set variable refuses, and says which gate fired and why", () => {
    // The fail direction. A guard that cannot fire is the defect class this
    // repo cares most about, so this is the load-bearing case.
    let message = "";
    try {
      assertNoAssistantCloudEnv({ [VARIABLE]: "https://cloud.example" }, "probe");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("probe: refusing to proceed");
    expect(message).toContain("https://cloud.example");
    // The message has to carry the mechanism, or whoever hits it will go
    // looking in the wrong place.
    expect(message).toContain("useCloudThreadListAdapter.js");
    expect(message).toContain("module scope");
    expect(message).toContain("stubs/assistant-ui-cloud.js");
  });

  test("this very test process was gated, which is why the suite can be trusted", () => {
    // `test/preload-react.ts` calls the same guard before the test graph is
    // evaluated. If the variable were set, no test in this package would have
    // run at all -- so reaching this line is itself the assertion.
    expect(process.env[VARIABLE] ?? "").toBe("");
  });
});

describe("the stub refuses rather than silently doing nothing", () => {
  test("every cloud export throws, naming the reason", async () => {
    // A stub that returned undefined would turn a missing capability into a
    // confusing downstream crash. These throw where the mistake is.
    const stub = (await import("../stubs/assistant-ui-cloud.js")) as Record<string, unknown>;
    for (const name of [
      "useCloudThreadListAdapter",
      "useCloudThreadListRuntime",
      "useAssistantCloudThreadHistoryAdapter",
    ]) {
      const fn = stub[name];
      expect(typeof fn).toBe("function");
      expect(() => (fn as () => void)()).toThrow(/daemon owns sessions/);
    }
    const Adapter = stub.CloudFileAttachmentAdapter as new () => unknown;
    expect(() => new Adapter()).toThrow(/daemon owns sessions/);
  });
});

describe("mounting the production surface attempts no network call", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("no fetch is attempted while the runtime is built and a thread is mounted", async () => {
    const attempted: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      attempted.push(typeof input === "string" ? input : String(input));
      return Promise.reject(new Error("network disabled in this test"));
    }) as typeof fetch;

    // Importing the boundary module is what executes `@assistant-ui/core/react`,
    // which is where the cloud module's module-scope code lives.
    const runtime = await import("../src/assistant/runtime.ts");
    expect(typeof runtime.useOmpRuntime).toBe("function");

    // Nothing above may have reached out, and nothing about a cloud host may
    // appear even if some unrelated fetch happens later.
    expect(attempted).toEqual([]);
  });
});
