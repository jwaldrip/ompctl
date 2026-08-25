/**
 * The web target.
 *
 * Vite rather than Metro, because a browser wants an ES module graph and a
 * Metro bundle is neither that nor debuggable in devtools. The three settings
 * below are what turn a React Native source tree into one:
 *
 *  - `react-native` resolves to `react-native-web`, which is the whole trick.
 *  - `.web.*` wins over the bare extension, so a platform file is picked up the
 *    same way Metro picks up `.ios.tsx`.
 *  - `__DEV__` exists, because React Native's own modules read it and a browser
 *    has never heard of it.
 *
 * `optimizeDeps.esbuildOptions.loader` covers the dependencies that ship
 * untranspiled Flow-free JSX in `.js` files, which esbuild otherwise parses as
 * plain JavaScript and rejects at the first angle bracket.
 */

import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Resolved through Node's own lookup rather than a relative walk up to
// `node_modules`. A literal `../../../` encodes how deeply this package happens
// to sit today: it was correct when the app lived at `control-plane/packages/app`
// in the fork, and silently pointed one directory above the repository root once
// the tree was extracted to `packages/app`, which broke the web target outright.
// `require.resolve` cannot drift that way, and it also finds the file when a
// package manager hoists or nests differently.
const resolveFromHere = createRequire(import.meta.url).resolve;

// Same guard as `metro.config.cjs`, same reason, one implementation.
const { assertNoAssistantCloudEnv } = createRequire(import.meta.url)("./scripts/assistant-cloud-env.cjs") as {
  assertNoAssistantCloudEnv: (env?: Record<string, string | undefined>, where?: string) => void;
};
assertNoAssistantCloudEnv(process.env, "vite.config.ts");

const webNodeModules = ["react-native-web", "react-native-svg", "@fortawesome/react-native-fontawesome"];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^react-native$/, replacement: "react-native-web" },
      {
        // react-native-svg ships a browser build beside its native one but does
        // not declare it in `exports`, so the bundler has to be told.
        find: /^react-native-svg$/,
        replacement: resolveFromHere("react-native-svg/lib/module/ReactNativeSVG.web.js"),
      },
      {
        /**
         * `@assistant-ui/core`'s cloud subtree, stubbed. The same redirect
         * `metro.config.cjs` makes, for the same reason:
         * `runtimes/cloud/useCloudThreadListAdapter.js` reads
         * `process.env.NEXT_PUBLIC_ASSISTANT_BASE_URL` at MODULE scope and
         * constructs an anonymous `AssistantCloud` if it is set, and
         * `react/index.js` imports it statically. Nothing here imports a cloud
         * symbol, so redirecting removes the client and the env read rather
         * than watching for them.
         */
        find: /@assistant-ui[/\\]core[/\\]dist[/\\]react[/\\]runtimes[/\\]cloud[/\\].*$/,
        replacement: resolveFromHere("./stubs/assistant-ui-cloud.js"),
      },
    ],
    extensions: [".web.tsx", ".web.ts", ".web.jsx", ".web.js", ".tsx", ".ts", ".jsx", ".js", ".json"],
  },
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV !== "production"),
    global: "globalThis",
  },
  optimizeDeps: {
    include: webNodeModules,
    esbuildOptions: { loader: { ".js": "jsx" }, resolveExtensions: [".web.js", ".js", ".ts", ".tsx"] },
  },
  build: { outDir: "dist", sourcemap: true },
});
