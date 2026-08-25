/**
 * A scoped web build of the assistant surface only.
 *
 * `bun run build:web` is red on `main` for an unrelated reason:
 * `react-native-qrcode-svg` ships JSX in a `.js` file that rollup's commonjs
 * resolver rejects, and the baseline at `1efcdd4` fails identically. So a green
 * full web build is not available to claim either way.
 *
 * What this proves instead is the part the cutover is responsible for: the
 * assistant-ui surface, the external-store runtime and the cloud stub all
 * resolve and build for web through the app's own real config, merged rather
 * than reimplemented so the `react-native` to `react-native-web` alias under
 * test is the shipped one.
 */

import { mergeConfig } from "vite";
import base from "./vite.config.ts";

export default mergeConfig(base, {
  build: {
    outDir: "dist-aui",
    sourcemap: true,
    rollupOptions: { input: "./__aui-entry.js" },
  },
});
