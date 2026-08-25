/**
 * The one place ompctl reaches into `@assistant-ui/core`.
 *
 * Everything else in the app imports the runtime hook from here, never from
 * `@assistant-ui/core/react`, so the blast radius of upstream churn is this
 * file rather than every call site.
 *
 * WHY THE APP DEPENDS ON CORE AT ALL
 *
 * `@assistant-ui/react-native@0.1.38` exports exactly two runtime hooks,
 * `useLocalRuntime` and `useRemoteThreadListRuntime`, and both keep messages in
 * memory. The daemon owns session state, so a second in-memory message store is
 * the one thing this migration must not introduce. `useExternalStoreRuntime` is
 * the hook that owns no state, and it is exported ONLY from
 * `@assistant-ui/core/react`. Core's own README says most consumers should not
 * install it directly; we do, deliberately, and this module is the seam that
 * makes that decision reviewable in one place. Note the split: the hook lives
 * at `@assistant-ui/core/react`, while `ExternalStoreAdapter` and
 * `AssistantRuntime` are exported from the `@assistant-ui/core` root and from
 * nowhere else.
 *
 * The provider is not part of this seam. `AssistantRuntimeProvider` in
 * `@assistant-ui/react-native` is a bare re-export of core's, so the runtime
 * built here and the provider imported there are the same module.
 *
 * WHY THE VERSION ASSERTION IS NOT IN THIS FILE
 *
 * `ASSISTANT_UI_PINS` below records the exact versions this code was written
 * against, and the obvious next move is to read each installed package's
 * `version` at import time and throw when one has drifted. That cannot ship
 * here, and the reason was measured rather than assumed. Six of the seven
 * packages do not list `./package.json` in their `exports` map (only `zustand`
 * does), and the two bundlers disagree about what that means:
 *
 *  - Metro 0.83.7 resolves it anyway. It catches `PackagePathNotExportedError`
 *    and falls back to file-based resolution, so a probe entry requiring all
 *    seven bundled clean and carried every version string. It also printed one
 *    `WARN Attempted to import the module "..." which is not listed in the
 *    "exports" of ...` per package, on every bundle, and inlined each whole
 *    manifest (`devDependencies` included) into the shipped output.
 *  - Vite 7.3.6, which builds the web target, hard-fails:
 *    `[commonjs--resolver] Missing "./package.json" specifier in
 *    "@assistant-ui/core" package`. Same result for react-native, store, tap,
 *    assistant-stream and assistant-cloud; only zustand resolves.
 *
 * So the assertion would not be "runs on native, skipped on web". It would be
 * `bun run build:web` failing outright. It lives in
 * `scripts/check-assistant-deps.ts` instead, asserted by
 * `test/assistant-deps.test.ts`, where Node resolution reads the manifests off
 * disk with no bundler in the way. That gate also catches the two hazards a
 * version equality check never could: a duplicate copy of a package, and a
 * missing optional peer.
 */

import type { AssistantRuntime, ExternalStoreAdapter } from "@assistant-ui/core";
import { useExternalStoreRuntime } from "@assistant-ui/core/react";

/**
 * The transcript's runtime: assistant-ui drives list mechanics, message
 * identity and part dispatch, and holds no state of its own.
 *
 * A pass-through by design. The hook is re-exported through a function rather
 * than `export { useExternalStoreRuntime as useOmpRuntime }` so that a future
 * upstream signature change has somewhere to be absorbed rather than breaking
 * at every call site.
 *
 * The seam is the RUNTIME import, not every mention of the package. Type-only
 * imports from the `@assistant-ui/core` root (`ThreadMessageLike` and friends
 * in `adapter.ts`) are erased at build time and couple us to nothing at run
 * time. `@assistant-ui/core/react` is the value import, and this file is
 * meant to be its only one in `src/`.
 */
export function useOmpRuntime<T>(store: ExternalStoreAdapter<T>): AssistantRuntime {
  return useExternalStoreRuntime(store);
}

/**
 * The versions this code was written against, as literals.
 *
 * Literal pins rather than carets, everywhere, because `@assistant-ui/*` is
 * pre-1.0 alpha: a caret on `0.3.15` admits `0.3.x` and this library moves
 * breaking behaviour inside patch releases. The list is the transitive closure
 * that actually matters, not just our direct dependencies:
 *
 *  - `core`, `react-native` are declared by us.
 *  - `store`, `tap`, `assistant-stream`, `zustand` arrive through
 *    `@assistant-ui/react-native`'s own dependencies and through core's peers.
 *    `store` in particular holds the module-level React context that links the
 *    provider to the primitives, which is why a second copy breaks rendering
 *    with no error at all.
 *  - `assistant-cloud` is an OPTIONAL peer of core that core nonetheless
 *    imports unconditionally, so it has to be declared by us or both bundlers
 *    fail. bun and `tsc --noEmit` are both silent about its absence.
 *
 * Drift here is upstream churn arriving. `scripts/check-assistant-deps.ts`
 * compares this table against what is installed and names the package that
 * moved; when it fires, the change is reviewed against this file first.
 */
export const ASSISTANT_UI_PINS = {
  "@assistant-ui/react-native": "0.1.38",
  "@assistant-ui/core": "0.3.15",
  "@assistant-ui/store": "0.3.10",
  "@assistant-ui/tap": "0.9.14",
  "assistant-stream": "0.3.39",
  zustand: "5.0.15",
  "assistant-cloud": "0.1.41",
} as const;

/** A package name this app pins a literal assistant-ui-related version for. */
export type AssistantUiPin = keyof typeof ASSISTANT_UI_PINS;
