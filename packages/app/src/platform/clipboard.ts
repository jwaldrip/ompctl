/**
 * The one door a "copy this" control goes through.
 *
 * React Native 0.81 ships no clipboard at all; the community package does, on
 * every target this app builds for (iOS, macOS, Android, Windows, and a web
 * implementation of its own). `clipboard.web.ts` is this file's counterpart
 * for the vite build, which needs no native module to write the pasteboard.
 */

import Clipboard from "@react-native-clipboard/clipboard";

export function copyText(value: string): void {
  Clipboard.setString(value);
}
