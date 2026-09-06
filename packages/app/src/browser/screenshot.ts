/**
 * The screenshot seam: `react-native-view-shot`, loaded the first time a
 * screenshot is asked for rather than when the driver is imported.
 *
 * The library resolves its native module at import with
 * `TurboModuleRegistry.getEnforcing("RNViewShot")`, which throws when the
 * module is not in the binary. Its podspec is iOS only and its Windows project
 * is a UWP C# module the new architecture cannot host (excluded from Windows
 * autolinking in `react-native.config.cjs`), so a macOS or Windows build has
 * no `RNViewShot` at all. Imported statically, that throw would land while
 * `SessionScreen` is being loaded and take the whole app down at launch on a
 * platform where every other WebView action works. Loaded here, on demand,
 * the same throw becomes the error result of the one action that needed it,
 * which is the contract `WebViewDriverHandle.act` already promises: an error
 * result, never a hang and never a crash.
 */

import type { View } from "react-native";

/** Capture one native view as base64 PNG, or explain why this build cannot. */
export async function captureViewAsPng(target: View): Promise<string> {
  let captureRef: (view: View, options: { format: "png"; result: "base64" }) => Promise<string>;
  // Dynamic on purpose: a static import evaluates `getEnforcing` at app load
  // and there is no RNViewShot to find on macOS or Windows (see the header).
  try {
    ({ captureRef } = await import("react-native-view-shot"));
  } catch (cause) {
    throw new Error(
      `this build has no RNViewShot native module, so screenshots are unavailable on this platform: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
  return await captureRef(target, { format: "png", result: "base64" });
}
