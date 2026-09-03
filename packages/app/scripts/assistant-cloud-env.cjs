/**
 * Refuses to build or test with `NEXT_PUBLIC_ASSISTANT_BASE_URL` set.
 *
 * Belt and braces. The primary fix is the stub: `metro.config.cjs` and
 * `vite.config.ts` both redirect `@assistant-ui/core`'s cloud subtree to
 * `stubs/assistant-ui-cloud.js`, which removes the client class and the
 * environment read from every bundle -- measured at zero occurrences of both
 * `AssistantCloud` and `NEXT_PUBLIC_ASSISTANT_BASE_URL` in the ios, android,
 * macos, windows and web outputs.
 *
 * This exists because a redirect is configuration, and configuration can be
 * dropped by a future edit without anything failing. If that happens while the
 * variable is also set, `useCloudThreadListAdapter.js` constructs an anonymous
 * `AssistantCloud` at module scope before any of our code runs. So the two
 * guards fail in opposite directions: the stub makes the variable irrelevant,
 * and this makes a lost stub loud instead of silent.
 *
 * CommonJS on purpose. `metro.config.cjs` is CJS because the React Native CLI
 * loads config through a CJS path while this package is `"type": "module"`, so a
 * `.cjs` file is the one shape all three callers -- Metro config, Vite config
 * and the bun test preload -- can load without a transform.
 */

const VARIABLE = "NEXT_PUBLIC_ASSISTANT_BASE_URL";

/**
 * @param {Record<string, string | undefined>} [env]
 * @param {string} [where] What is refusing, so the message says which gate fired.
 */
function assertNoAssistantCloudEnv(env, where) {
  const source = env ?? process.env;
  const value = source[VARIABLE];
  if (value === undefined || value === "") return;
  throw new Error(
    [
      `${where ?? "ompctl"}: refusing to proceed because ${VARIABLE} is set to ${JSON.stringify(value)}.`,
      "",
      "@assistant-ui/core/dist/react/runtimes/cloud/useCloudThreadListAdapter.js reads that",
      "variable at module scope and constructs an anonymous AssistantCloud client if it is",
      "non-empty. react/index.js imports that module statically, so it would run the moment",
      "anything reaches useExternalStoreRuntime -- before any ompctl code.",
      "",
      "ompctl never talks to assistant-cloud: the daemon owns sessions. The cloud subtree is",
      "redirected to packages/app/stubs/assistant-ui-cloud.js in both metro.config.cjs and",
      "vite.config.ts. Unset the variable rather than removing that redirect.",
    ].join("\n"),
  );
}

module.exports = { VARIABLE, assertNoAssistantCloudEnv };
