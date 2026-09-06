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
    support: "unverified",
    note: "react-native-webview 15's Windows project is a C++ Fabric module and is autolinked; @ompd/app/windows is scaffolded and CI builds it, but no Windows run of the WebView has been exercised. Screenshot is unavailable there: react-native-view-shot ships only a UWP C# module for the old architecture, which a RnwNewArch app cannot host, so it is excluded from Windows autolinking (react-native.config.cjs) and webview_screenshot answers with a stated error.",
  },
  {
    platform: "web",
    support: "unavailable",
    note: "Deliberate, not a gap: a browser tab cannot honestly host a driveable browser inside itself. See index.web.ts, which exports webViewCapability as the literal type null.",
  },
];
