/**
 * Throwaway render smoke for the @assistant-ui evaluation. Not part of the app.
 *
 * Resolution is not rendering. This mounts the probe through the repo's own
 * `rnw.ts` harness, so `react-native` really is `react-native-web`, and asserts
 * the runtime built by `useExternalStoreRuntime` (from `@assistant-ui/core/react`)
 * actually drives primitives imported from `@assistant-ui/react-native`.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// Dynamic on purpose: a static import would pull the real `react-native` in
// before `./rnw.ts` could substitute it. Same reason as smoke.test.tsx.
const { AuiProbe } = await import("../src/__aui-probe.tsx");

describe("@assistant-ui/react-native renders under react-native-web", () => {
  test("an empty thread mounts and produces markup", () => {
    const html = renderToStaticMarkup(<AuiProbe messages={[]} />);
    expect(html).toContain("<div");
    expect(html).toContain("send");
  });

  test("external-store messages reach the thread", () => {
    const html = renderToStaticMarkup(
      <AuiProbe
        messages={[
          { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
          { id: "m2", role: "assistant", content: [{ type: "text", text: "hi back" }] },
        ]}
      />,
    );
    expect(html).toContain("m1");
    expect(html).toContain("m2");
  });
});
