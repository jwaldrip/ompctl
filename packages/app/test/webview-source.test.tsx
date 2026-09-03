import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// The React Native WebView must load after rnw.ts installs its Flow-free mock.
const { WebViewDriver } = await import("../src/browser/WebViewDriver.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("the native sandbox's initial document", () => {
  test("uses an HTML document rather than sending about:blank to loadFileURL", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(<WebViewDriver />);
      });

      const webview = host.querySelector('[data-testid="mock-webview"]');
      expect(webview).not.toBeNull();
      expect(webview?.getAttribute("data-source-html")).toBe("");
      expect(webview?.hasAttribute("data-source-uri")).toBe(false);
    } finally {
      act(() => {
        root.unmount();
      });
      host.remove();
    }
  });
});
