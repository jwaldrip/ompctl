/**
 * Platform registry for the community CLI.
 *
 * iOS and Android come from `react-native` itself and use the host projects in
 * `ios/` and `android/`. macOS and Windows are out-of-tree platforms, so their
 * explicit entries activate project discovery for the generated native hosts.
 *
 * `assets` links the vendored typefaces into native builds. Without it, Archivo
 * and IBM Plex Mono exist in the repository and nowhere on a device.
 * This file is CommonJS because the React Native CLI loads it that way, while
 * the app package declares `"type": "module"`.
 */
module.exports = {
  project: {
    ios: {},
    android: {},
    macos: {},
    windows: {},
  },
  dependencies: {
    // 4.24 is the last screens release RN 0.81's Android/iOS codegen
    // accepts. Its Windows project pulls a Windows App SDK that this
    // 0.81 tree cannot link. Main never autolinked screens on Windows
    // either: 4.27 shipped no project the generator picked up. Keep
    // that exclusion explicit so a pin change cannot silently add it.
    "react-native-screens": {
      platforms: {
        windows: null,
      },
    },
    // react-native-view-shot's Windows project (RNViewShot.csproj) is a
    // UWP C# XAML library for the old architecture: it references
    // Microsoft.ReactNative.Managed and Windows.UI.Xaml, neither of which a
    // RnwNewArch composition app can host, and no published version of the
    // package ships anything else for Windows (last checked 5.1.1 and the
    // gre/react-native-view-shot master branch). Autolinking it made the app's
    // build compile the Managed assembly, which WindowsAppSDK 1.8 refuses and
    // whose UWP XAML type forwarders then fail against WinUI 3; every run on
    // main was red for that reason alone. Left out, the C++ closure builds.
    // `webview_screenshot` answers with a stated error on Windows: see
    // `src/browser/WebViewDriver.tsx` and the Windows row in
    // `src/browser/capability.ts`.
    "react-native-view-shot": {
      platforms: {
        windows: null,
      },
    },
    // react-native-webview 15's Windows project is a C++ Fabric component,
    // but it calls IReactViewComponentBuilder.XamlSupport, which
    // react-native-windows added in 0.82 (absent from 0.81.35's
    // IReactViewComponentBuilder.idl, present in 0.82.8's). RNW 0.82 needs
    // react-native 0.82, and react-native-macos stops at 0.81.9, so on the
    // one React Native version every platform here can build, this component
    // cannot compile (error C2039 in RCTWebView2ComponentView.cpp). Until
    // react-native-macos reaches 0.82 and the whole app moves with it, the
    // Windows build carries no WebView and `src/browser/index.windows.ts`
    // says so as a type.
    "react-native-webview": {
      platforms: {
        windows: null,
      },
    },
  },
  assets: ["./src/design/fonts"],
};
