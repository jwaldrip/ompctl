/**
 * Stands in for `@assistant-ui/core`'s four cloud modules, in every bundle.
 *
 * Why this exists rather than a guard that merely detects the problem:
 * `dist/react/runtimes/cloud/useCloudThreadListAdapter.js` runs this at MODULE
 * scope, and `dist/react/index.js` imports it statically, so it executes the
 * moment anything reaches `useExternalStoreRuntime`:
 *
 *   const baseUrl = typeof process !== "undefined" && process?.env?.NEXT_PUBLIC_ASSISTANT_BASE_URL;
 *   const autoCloud = baseUrl ? new AssistantCloud({ baseUrl, anonymous: true }) : void 0;
 *
 * Nothing in ompctl imports a cloud symbol. The daemon owns sessions; there is
 * no cloud thread list, no cloud history, no cloud attachment store. So the
 * whole subtree is dead weight that ships a network client class and an
 * environment read into a signed app, and one build tool injecting a
 * `NEXT_PUBLIC_*` variable would turn it on with nothing in our code changing.
 *
 * Redirecting the modules removes the risk instead of watching for it. The four
 * names below are exactly what `core/react`'s barrel re-exports from them, so
 * the module graph still resolves; calling one throws, because a caller would
 * be asking for a capability this app deliberately does not have.
 *
 * Kept as plain JavaScript so Metro and Vite both take it with no transform,
 * and outside `src/` so it is infrastructure rather than app code.
 */

function refuse(name) {
  return () => {
    throw new Error(
      `${name} is not available: ompctl stubs @assistant-ui/core's cloud modules. ` +
        "The daemon owns sessions, so there is no cloud thread list, history or attachment store. " +
        "See packages/app/stubs/assistant-ui-cloud.js.",
    );
  };
}

export const useCloudThreadListAdapter = refuse("useCloudThreadListAdapter");
export const useCloudThreadListRuntime = refuse("useCloudThreadListRuntime");
export const useAssistantCloudThreadHistoryAdapter = refuse("useAssistantCloudThreadHistoryAdapter");

/**
 * A class rather than a function: `core/react` re-exports this as a value
 * consumers would `new`, and a thrown constructor is a clearer failure than a
 * call signature mismatch.
 */
export class CloudFileAttachmentAdapter {
  constructor() {
    refuse("CloudFileAttachmentAdapter")();
  }
}
