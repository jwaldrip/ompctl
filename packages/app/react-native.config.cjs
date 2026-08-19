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
  },
  assets: ["./src/design/fonts"],
};
