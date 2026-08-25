/**
 * The entry `vite.aui.config.ts` and the platform bundle proofs use.
 *
 * It imports the whole assistant surface and nothing else, which is the point:
 * `bun run build:web` is red on `main` for an unrelated reason (react-native-qrcode-svg
 * ships JSX in a `.js` file that rollup's commonjs resolver rejects, and the
 * baseline at `1efcdd4` fails identically), so a green full web build cannot be
 * claimed either way. This isolates the part the cutover is responsible for.
 *
 * Run:
 *   bunx react-native bundle --platform ios --dev false --entry-file __aui-entry.js --bundle-output /tmp/aui-ios.jsbundle
 *   bunx vite build --config vite.aui.config.ts
 *
 * Then check the output contains neither `AssistantCloud` nor
 * `NEXT_PUBLIC_ASSISTANT_BASE_URL`, which is what the cloud stub buys.
 */

import { convertEntry, entryOf, ompStore } from "./src/assistant/adapter.ts";
import { OmpComposer } from "./src/assistant/OmpComposer.tsx";
import { OmpThreadList, OmpThreadProvider } from "./src/assistant/OmpThread.tsx";
import { OmpEntryRow } from "./src/assistant/renderers.tsx";
import { useOmpRuntime } from "./src/assistant/runtime.ts";

if (
  !OmpThreadProvider ||
  !OmpThreadList ||
  !OmpComposer ||
  !OmpEntryRow ||
  !useOmpRuntime ||
  !convertEntry ||
  !entryOf ||
  !ompStore
) {
  throw new Error("unresolved");
}
