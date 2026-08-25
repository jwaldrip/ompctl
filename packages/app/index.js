/**
 * Native entry. iOS, Android, macOS, and Windows all boot through this file:
 * the platform's host view looks up the component registered under the name in
 * `app.json`, and there is exactly one for all four.
 *
 * Web does not come through here. Vite serves `index.html`, which loads
 * `src/index.web.tsx`, because a Metro bundle is not what a browser wants and
 * `AppRegistry.runApplication` needs a DOM node to be handed.
 *
 * ## The first import is load-bearing
 *
 * Hermes has no `crypto` global: not `subtle`, not `getRandomValues`. A probe
 * build on a Pixel 7 reported `crypto: undefined`, and the tunnel's sealed
 * channel needs a CSPRNG for its handshake nonce and its X25519 secret, so a
 * hub session failed on device with `undefined is not a function` from inside
 * the socket factory.
 *
 * `react-native-get-random-values` installs `crypto.getRandomValues` backed by
 * the platform's own CSPRNG, and `@noble` reads it from the global. It must be
 * imported before anything that generates a key, which is why it is first and
 * why nothing else may be placed above it. There is no JS fallback on purpose:
 * seeding key material from `Math.random` would be worse than failing.
 *
 * ## So is the second, for the same class of reason
 *
 * Hermes has no Streams API either. `assistant-stream`, underneath
 * `@assistant-ui/react-native`, evaluates `class extends TransformStream` at
 * module scope, so this app died with `Property 'TransformStream' doesn't
 * exist` the moment a session opened on a real simulator. See
 * `src/platform/streams.ts` for the measurement and for what it installs.
 *
 * Both are side-effect imports above `App` on purpose. `import` is hoisted, so
 * a function call placed between these lines and the `App` import would run
 * after `App`'s own graph had already been evaluated, which is exactly too
 * late.
 */

import "react-native-get-random-values";
import "./src/platform/streams.ts";
import { AppRegistry } from "react-native";
import { App } from "./src/App.tsx";
import { name } from "./app.json";

AppRegistry.registerComponent(name, () => App);
