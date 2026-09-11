const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");
const { assertNoAssistantCloudEnv } = require("./scripts/assistant-cloud-env.cjs");

// Before anything else: a native bundle must not be produced in an environment
// that would have armed the cloud client, even though the redirect below makes
// it inert. See the guard's own header for why both exist.
assertNoAssistantCloudEnv(process.env, "metro.config.cjs");

/**
 * The app lives inside the ompd workspace and imports `@ompd/core` from a sibling
 * package. Metro must watch the workspace root and resolve its Bun-hoisted modules.
 *
 * This file is CommonJS (`.cjs`) because the React Native CLI loads config
 * through a CJS path, and the app package declares `"type": "module"`.
 *
 * `disableHierarchicalLookup` is load-bearing for native. Without it, Metro
 * walks up from a file under the workspace-root `node_modules/react-native` and
 * finds the workspace's React 19.2.7 before the app-local 19.1.4 that matches
 * RN 0.81.6's embedded renderer. Two React copies produce the redbox the
 * device hit: "Incompatible React versions: ... 19.2.7 ... renderer 19.1.4".
 * With hierarchical lookup off, only `nodeModulesPaths` is consulted, so the
 * app pin wins for every import including the ones inside react-native itself.
 */
const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..", "..");

/**
 * `@assistant-ui/core`'s cloud modules, redirected to a stub.
 *
 * `dist/react/runtimes/cloud/useCloudThreadListAdapter.js` reads
 * `process.env.NEXT_PUBLIC_ASSISTANT_BASE_URL` at MODULE scope and constructs
 * an anonymous `AssistantCloud` if it is set, and `dist/react/index.js` imports
 * it statically -- so it runs the moment anything reaches
 * `useExternalStoreRuntime`. Nothing in this app imports a cloud symbol,
 * because the daemon owns sessions. Redirecting removes the client class and
 * the environment read from the bundle rather than watching for them.
 */
const ASSISTANT_UI_CLOUD = /@assistant-ui[/\\]core[/\\]dist[/\\]react[/\\]runtimes[/\\]cloud[/\\]/;
const CLOUD_STUB = path.join(projectRoot, "stubs", "assistant-ui-cloud.js");
const REACT_NATIVE_PACKAGE = /^react-native(?=\/|$)/;
const NATIVE_STACK_VIEW_REQUEST = /(?:^|\/)views\/NativeStackView(?:\.[^/]+)?$/;
const NATIVE_STACK_ROOT = path.dirname(
  require.resolve("@react-navigation/native-stack/package.json", { paths: [projectRoot] }),
);
const NATIVE_STACK_SOURCE_VIEW = path.join(NATIVE_STACK_ROOT, "src", "views", "NativeStackView.tsx");
const NATIVE_STACK_MODULE_VIEW = path.join(NATIVE_STACK_ROOT, "lib", "module", "views", "NativeStackView.js");

const config = {
  projectRoot,
  watchFolders: [repoRoot],
  resolver: {
    disableHierarchicalLookup: true,
    nodeModulesPaths: [path.join(projectRoot, "node_modules"), path.join(repoRoot, "node_modules")],
    /**
     * One tree, several platforms. `web` is served by Vite rather than Metro,
     * but keeping it in the list means a `.web.tsx` sibling is never picked up
     * by a native bundle by accident.
     */
    platforms: ["ios", "android", "macos", "windows", "native"],
    /**
     * React Native macOS is a fork, not a platform extension inside the generic
     * package. Every `react-native` import in a macOS graph enters that fork.
     * Native Stack has a JavaScript view for unsupported platforms; macOS must
     * use it because react-native-screens ships no AppKit component views.
     */
    resolveRequest: (context, moduleName, platform) => {
      const nativeStackViewRequest =
        platform === "macos" &&
        NATIVE_STACK_VIEW_REQUEST.test(moduleName) &&
        context.originModulePath.startsWith(`${NATIVE_STACK_ROOT}${path.sep}`);
      if (nativeStackViewRequest) {
        const sourceBuild = context.originModulePath.startsWith(`${path.join(NATIVE_STACK_ROOT, "src")}${path.sep}`);
        return { type: "sourceFile", filePath: sourceBuild ? NATIVE_STACK_SOURCE_VIEW : NATIVE_STACK_MODULE_VIEW };
      }

      const platformModuleName =
        platform === "macos" ? moduleName.replace(REACT_NATIVE_PACKAGE, "react-native-macos") : moduleName;
      const resolved = context.resolveRequest(context, platformModuleName, platform);
      if (resolved.type === "sourceFile" && ASSISTANT_UI_CLOUD.test(resolved.filePath)) {
        return { type: "sourceFile", filePath: CLOUD_STUB };
      }
      return resolved;
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
