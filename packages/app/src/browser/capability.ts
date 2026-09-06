/**
 * The capability matrix `docs/browser.md` documents in prose, as data.
 *
 * Every row is `unverified` or `unavailable`, never `verified`, as of this
 * pass -- no simulator, emulator, or device run exercised the injected-script
 * DOM walk or the native `injectJavaScript`/`onMessage` bridge against a live
 * page. `docs/browser.md` has the evidence behind each note (podspec
 * platforms, which `WebView.<platform>.tsx` files exist, whether this app's
 * native project for that platform is even scaffolded). This file exists so
 * that evidence is also a value a client screen can render, not only prose an
 * operator has to go find.
 */

import type { WebViewPlatformStatus } from "@ompd/core/contracts";

export const WEBVIEW_PLATFORM_STATUS: readonly WebViewPlatformStatus[] = [
  {
    platform: "ios",
    support: "unverified",
    note: "react-native-webview's primary target (podspec: ios 11.0); WebView.ios.tsx implements injectJavaScript/onMessage. @ompd/app/ios is scaffolded. No simulator run was exercised in this pass.",
  },
  {
    platform: "android",
    support: "unverified",
    note: "Same bridge surface as iOS (WebView.android.tsx). @ompd/app/android is scaffolded. No emulator run was exercised in this pass.",
  },
  {
    platform: "macos",
    support: "unverified",
    note: "react-native-webview genuinely supports it (podspec declares osx 10.13; WebView.macos.tsx and a dedicated macos/RNCWebView.xcodeproj ship in 14.0.1) and @ompd/app/macos is scaffolded, but no macOS run of the WebView has been exercised. Screenshot is narrower still: react-native-view-shot's podspec is ios-only, so webview_screenshot answers with a stated error on macOS; the library is loaded on demand (browser/screenshot.ts) so its absence cannot take the app down at launch.",
  },
  {
    platform: "windows",
    support: "unavailable",
    note: "A version intersection, not a scaffolding gap: react-native-webview 15's Windows Fabric component calls IReactViewComponentBuilder.XamlSupport, which react-native-windows added in 0.82; RNW 0.82 needs react-native 0.82, and react-native-macos stops at 0.81.9, so on the 0.81 line every platform here shares the component does not compile. It is excluded from Windows autolinking (react-native.config.cjs) and index.windows.ts exports webViewCapability as the literal null. react-native-view-shot is excluded there too: its Windows project is a UWP C# module for the old architecture. Both return the day react-native-macos reaches 0.82 and the app moves with it.",
  },
  {
    platform: "web",
    support: "unavailable",
    note: "Deliberate, not a gap: a browser tab cannot honestly host a driveable browser inside itself. See index.web.ts, which exports webViewCapability as the literal type null.",
  },
];
