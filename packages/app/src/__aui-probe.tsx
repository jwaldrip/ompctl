/**
 * Throwaway resolution probe for the @assistant-ui evaluation. Not part of the app.
 *
 * Proves the split the migration depends on: primitives + provider come from
 * `@assistant-ui/react-native`, but the external-store runtime hook only exists
 * in `@assistant-ui/core/react`, and its adapter type only in `@assistant-ui/core`.
 */

import type { ExternalStoreAdapter, ThreadMessageLike } from "@assistant-ui/core";
import { useExternalStoreRuntime } from "@assistant-ui/core/react";
import { AssistantRuntimeProvider, ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react-native";
import { Text, View } from "react-native";

export function AuiProbe({ messages }: { messages: readonly ThreadMessageLike[] }) {
  const adapter: ExternalStoreAdapter<ThreadMessageLike> = {
    messages: messages as ThreadMessageLike[],
    isRunning: false,
    onNew: async () => {},
    convertMessage: message => message,
  };
  const runtime = useExternalStoreRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.MessagesFlatList>
          {({ message }) => <Text>{message.id}</Text>}
        </ThreadPrimitive.MessagesFlatList>
        <View>
          <ComposerPrimitive.Root>
            <ComposerPrimitive.Input />
            <ComposerPrimitive.Send>
              <Text>send</Text>
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        </View>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
