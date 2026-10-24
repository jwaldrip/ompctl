// Throwaway runtime-resolution probe. Not part of the app.
// Proves the ESM specifiers actually resolve (or do not) from packages/app.
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react-native";
import { useExternalStoreRuntime } from "@assistant-ui/core/react";

const report = {
  AssistantRuntimeProvider: typeof AssistantRuntimeProvider,
  ThreadPrimitive_keys: Object.keys(ThreadPrimitive).sort(),
  ComposerPrimitive_keys: Object.keys(ComposerPrimitive).sort(),
  useExternalStoreRuntime: typeof useExternalStoreRuntime,
};
console.log(JSON.stringify(report, null, 2));
