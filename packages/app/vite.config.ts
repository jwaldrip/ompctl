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
 * plain JavaScript and rejects at the first angle bracket. That setting governs
 * dependency PRE-BUNDLING only, which is a dev-server concern, so the
 * production build went through rollup instead and died on the first angle
 * bracket it met. `untranspiledJsxDeps` below is the build-side half.
 */

import { createRequire } from "node:module";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, transformWithEsbuild } from "vite";

/**
 * Packages that ship JSX inside `.js`, transformed so rollup can parse them.
 *
 * `react-native-qrcode-svg@6.3.21` publishes only `src/`: no `lib/`, no
 * `dist/`, no `module` field, and its `index.js` is one line re-exporting
 * `./src/index.js`, whose first component returns `<Svg>`. So the
 * alias-to-a-browser-build trick used for `react-native-svg` below has nothing
 * to point at.
 *
 * Scoped to named packages on purpose. A blanket `.js` -> jsx loader across
 * `node_modules` would quietly reinterpret every dependency, and that fails as
 * a wrong parse somewhere unrelated rather than as an error here.
 *
 * The alternatives were worse. `build.rollupOptions.external` leaves a bare
 * import in the output, and `optimizeDeps.exclude` moves the same parse
 * failure rather than fixing it. The QR code is how a device pairs, so it has
 * to render.
 */
const UNTRANSPILED_JSX_DEPS = /node_modules[/\\]react-native-qrcode-svg[/\\].*\.js$/;

export function untranspiledJsxDeps(): Plugin {
  return {
    name: "ompctl:untranspiled-jsx-deps",
    // Ahead of `@rollup/plugin-commonjs`, which is what threw:
    // `[commonjs--resolver] Expression expected`. It has to see JavaScript.
    enforce: "pre",
    async transform(code, id) {
      if (!UNTRANSPILED_JSX_DEPS.test(id)) return null;
      // Classic runtime: these files carry their own `import React from "react"`.
      const out = await transformWithEsbuild(code, id, { loader: "jsx", jsx: "transform" });
      // Only the two fields rollup wants, and the map as JSON text. esbuild's
      // result also carries `warnings` and friends, which do not fit
      // `TransformResult`, and its `SourceMap` object types its `version` as a
      // plain number where rollup insists on the literal 3. A string is the
      // shape both agree on.
      return { code: out.code, map: JSON.stringify(out.map) };
    },
  };
}

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
  plugins: [untranspiledJsxDeps(), react()],
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
  // No source maps in the build: the deploy image copies all of `dist`, and a
  // map carries every source file's contents to anyone who asks for it. The
  // config stays a plain object because `scripts/check-web-build-jsx-deps.ts`
  // spreads it; a function form would hand that gate no plugins at all.
  build: { outDir: "dist", sourcemap: false },
});
