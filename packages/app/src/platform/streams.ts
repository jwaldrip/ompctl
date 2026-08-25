/**
 * The WHATWG Streams globals, installed only where the engine lacks them.
 *
 * ## Why this exists
 *
 * Hermes has no Streams API. Not `TransformStream`, not `ReadableStream`, not
 * `WritableStream`, and React Native polyfills none of them: a sweep of
 * `react-native/Libraries` finds no `polyfillGlobal` registration for any
 * stream class, and a production Metro bundle of this app contains 51
 * occurrences of `TransformStream` and zero definitions of it.
 *
 * `assistant-stream`, which `@assistant-ui/react-native` depends on, does this
 * at module scope:
 *
 *     var AssistantMetaTransformStream = class extends TransformStream { ... }
 *
 * An `extends` clause is evaluated when the module is evaluated, so there is no
 * lazy path and no feature test to lose. On a real iOS simulator this took the
 * app down the moment a session opened, with the redbox
 * `Property 'TransformStream' doesn't exist` and a stack running through
 * `fromThreadMessageLike` -> `ThreadMessageConverter#convertMessages` ->
 * `ExternalStoreThreadRuntimeCore#__internal_setAdapter` ->
 * `useExternalStoreRuntime`. Measured on 2026-08-25, iPhone 17 simulator,
 * iOS 26.5, RN 0.81.6, Hermes.
 *
 * Nothing caught it earlier because nothing could: the web target has these
 * globals, `bun test` has them, and a Metro bundle only proves the module
 * graph resolves, never that it evaluates.
 *
 * ## Why it is shaped like this
 *
 * `index.js` already carries this exact pattern for `crypto.getRandomValues`
 * via `react-native-get-random-values`, for the same class of reason, and its
 * comment says why the import order is load-bearing. This is the second
 * member of that set, so it reads the same way.
 *
 * Every install is conditional. The web build never loads this file, but a
 * future engine that grows a real `TransformStream` should win over a
 * polyfill, and a conditional install is also how this stays correct if
 * React Native adds them.
 *
 * `TextEncoderStream` and `TextDecoderStream` are not part of the Streams
 * spec, so `web-streams-polyfill` does not carry them. `assistant-stream` uses
 * both, so they are built here on top of whichever `TransformStream` ended up
 * installed.
 */

import {
  ByteLengthQueuingStrategy,
  CountQueuingStrategy,
  ReadableStream,
  TransformStream,
  WritableStream,
} from "web-streams-polyfill";

type Globals = Record<string, unknown>;

/** Installs `value` under `name` only when the engine has nothing there. */
function installMissing(name: string, value: unknown): boolean {
  const globals = globalThis as unknown as Globals;
  if (typeof globals[name] !== "undefined") return false;
  globals[name] = value;
  return true;
}

/**
 * A `TextEncoderStream`, built on the `TransformStream` above.
 *
 * Encoding is per-chunk and stateless, which is what makes this short: UTF-8
 * has no cross-chunk encoder state in the direction string -> bytes. The
 * decoder below is the one that needs care.
 */
function textEncoderStream(): unknown {
  const Transform = (globalThis as unknown as Globals).TransformStream as typeof TransformStream;
  return class TextEncoderStreamPolyfill {
    readonly #transform: TransformStream<string, Uint8Array>;
    readonly encoding = "utf-8";

    constructor() {
      const encoder = new TextEncoder();
      this.#transform = new Transform<string, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(encoder.encode(String(chunk)));
        },
      });
    }

    get readable(): ReadableStream<Uint8Array> {
      return this.#transform.readable;
    }

    get writable(): WritableStream<string> {
      return this.#transform.writable;
    }
  };
}

/**
 * A `TextDecoderStream`.
 *
 * `{ stream: true }` on every chunk is the whole point: a multi-byte character
 * split across two chunks must not become two replacement characters, and a
 * decoder called without it would flush its partial sequence each time. The
 * final `decode()` with no argument flushes whatever is left, which is how a
 * truncated sequence at end-of-stream still surfaces as one replacement
 * character rather than being dropped.
 */
function textDecoderStream(): unknown {
  const Transform = (globalThis as unknown as Globals).TransformStream as typeof TransformStream;
  return class TextDecoderStreamPolyfill {
    readonly #transform: TransformStream<Uint8Array, string>;
    readonly encoding: string;

    constructor(encoding = "utf-8", options: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
      this.encoding = encoding;
      const decoder = new TextDecoder(encoding, options);
      this.#transform = new Transform<Uint8Array, string>({
        transform(chunk, controller) {
          const text = decoder.decode(chunk, { stream: true });
          if (text.length > 0) controller.enqueue(text);
        },
        flush(controller) {
          const tail = decoder.decode();
          if (tail.length > 0) controller.enqueue(tail);
        },
      });
    }

    get readable(): ReadableStream<string> {
      return this.#transform.readable;
    }

    get writable(): WritableStream<Uint8Array> {
      return this.#transform.writable;
    }
  };
}

/**
 * Installs every stream global the engine is missing, and returns the names it
 * actually had to add.
 *
 * Returning the list rather than nothing is deliberate: it is the only way a
 * test can assert this did something, and the only way a future engine change
 * shows up as a behaviour difference instead of silently.
 */
export function installStreamGlobals(): string[] {
  const added: string[] = [];
  for (const [name, value] of [
    ["ReadableStream", ReadableStream],
    ["WritableStream", WritableStream],
    ["TransformStream", TransformStream],
    ["ByteLengthQueuingStrategy", ByteLengthQueuingStrategy],
    ["CountQueuingStrategy", CountQueuingStrategy],
  ] as const) {
    if (installMissing(name, value)) added.push(name);
  }
  // After the three above, so these build on whatever `TransformStream` won.
  if (typeof (globalThis as unknown as Globals).TextEncoder !== "undefined") {
    if (installMissing("TextEncoderStream", textEncoderStream())) added.push("TextEncoderStream");
  }
  if (typeof (globalThis as unknown as Globals).TextDecoder !== "undefined") {
    if (installMissing("TextDecoderStream", textDecoderStream())) added.push("TextDecoderStream");
  }
  return added;
}

/**
 * Installed at module scope, because that is the only thing that works.
 *
 * A static `import` is hoisted, so a caller that imported this module and then
 * called the function would still have evaluated its own other imports --
 * including the ones that reach `assistant-stream` -- before the call ran. A
 * side-effect import placed above them is the whole mechanism, which is why
 * `index.js` writes `import "./src/platform/streams.ts";` rather than calling
 * anything.
 */
export const INSTALLED_STREAM_GLOBALS: readonly string[] = installStreamGlobals();
