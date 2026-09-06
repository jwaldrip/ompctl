/**
 * The Windows build's answer to "drive a WebView": not on this React Native
 * version, and stated as a type rather than found at render time.
 *
 * `react-native-webview` 15 ships a C++ Fabric component for Windows, and it
 * calls `IReactViewComponentBuilder.XamlSupport`, an API react-native-windows
 * added in 0.82. RNW 0.82 requires react-native 0.82, and react-native-macos
 * stops at 0.81.9, so the one React Native version every platform of this app
 * can build against is 0.81, where that component does not compile (error
 * C2039 in `RCTWebView2ComponentView.cpp`). The library is therefore excluded
 * from Windows autolinking in `react-native.config.cjs`, and a `<WebView>`
 * rendered here would meet no native component at all.
 *
 * `webViewCapability` is the literal `null` for the same reason it is on the
 * web build (`index.web.ts`): `SessionScreen` neither registers a screen nor
 * offers the browser toggle when the capability is `null`, and a caller
 * cannot compile code on this target that reads `webViewCapability.Driver`.
 * Metro resolves `.windows.ts` for react-native-windows the way it resolves
 * `.ios.tsx`, so the absence is decided at build time.
 *
 * The condition that retires this file is react-native-macos reaching 0.82
 * and the whole app moving to react-native 0.82 with react-native-windows
 * 0.82; at that point the default `index.ts` serves Windows too.
 */

export const webViewCapability: null = null;

export { WEBVIEW_PLATFORM_STATUS } from "./capability.ts";
