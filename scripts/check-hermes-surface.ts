#!/usr/bin/env bun
/**
 * The phone does not have Bun's globals, and nothing else can see that.
 *
 * The defect class this gate exists for: client-reachable code that is green
 * under Bun and dies on Hermes because it reaches for a global the phone does
 * not have. A grep cannot catch it, because the reach can sit inside a
 * dependency (`bytesToUtf8` from `@noble/ciphers` is literally
 * `new TextDecoder().decode`), and the test suite cannot catch it, because Bun
 * supplies every global the code asks for. Four of these have shipped and each
 * was found the same way: on a device, after release.
 *
 * The incidents, all discovered on-device:
 *   - Hermes has no `crypto` at all, so the sealed channel had to move to
 *     `@noble` primitives plus a CSPRNG the app installs (dd59e18)
 *   - Hermes has no `Buffer` (enforced by `@ompd/tunnel`'s portability test)
 *   - React Native's `URL` lies: `host`/`hostname`/`origin`/`pathname` answer
 *     only for http and https, `toString()` appends the searchParams instead of
 *     replacing the query, there is no `search` setter and no `URL.parse`
 *     static, so URL-based parsing of `wss://` endpoints silently failed
 *   - Hermes has `TextEncoder` but no `TextDecoder`, which killed the
 *     sealed-channel handshake through a dependency (ecbd6b2): the phone
 *     showed an empty console reading `websocket error`, forever
 *
 * The surface below is empirical, not remembered. Presence comes from a probe
 * build run on a Pixel 7 (the run whose crypto half is recorded in
 * `packages/app/index.js`), which printed:
 *
 *   crypto: undefined, subtle: undefined, importKey: undefined,
 *   deriveBits: undefined, encrypt: undefined, getRandomValues: undefined,
 *   TextEncoder: function, TextDecoder: undefined, atob: function,
 *   btoa: function, WebSocket: function, URL: function,
 *   URLSearchParams: function, Buffer: undefined
 *
 * so `TextEncoder` IS present and is deliberately not deleted; only the
 * decoder is missing. The semantics of the two present-but-lying constructors
 * come from the pinned React Native itself, `Libraries/Blob/URL.js` and
 * `URLSearchParams.js`, which `Libraries/Core/setUpXHR.js` installs as the
 * globals; the regexes in `ReactNativeURL` below are theirs verbatim.
 * `URLSearchParams.delete` exists at this pin (the older "no delete" memory is
 * superseded by 0.81.6), but `URL.toString()` composing by append rather than
 * replace makes stripping a token through a URL just as broken as it ever was,
 * so the model carries that instead.
 *
 * `crypto` is modelled as the app leaves it, not as Hermes ships it: the first
 * import in `packages/app/index.js` is `react-native-get-random-values`, so by
 * the time any client code runs, `globalThis.crypto` exists and carries
 * exactly `getRandomValues`, backed here by Bun's real CSPRNG so key material
 * stays real. WebCrypto (`subtle`, `importKey`, `deriveBits`, `encrypt`) does
 * not exist at any point on the device, so the model refuses to let the client
 * paths lean on Bun's.
 *
 * What runs under the surface: the pairing parsers, the WebView URL policy
 * check, the sealed-channel handshake and one seal/open round trip,
 * `hubSocketUrl`, and one full relayed turn (OmpdClient framing through the
 * app's own hub socket factory over a scripted hub, which is the composition
 * the phone runs). The only things not real are the wire and the globals, and
 * only one of those is under test.
 *
 * A failure names the module, the missing or lying global, and the
 * operator-visible symptom, because the last one of these surfaced as
 * `websocket error` on a phone with no other clue.
 *
 * Usage:
 *   bun run scripts/check-hermes-surface.ts
 */

import type { ChannelKeys, SealedChannel } from "../packages/tunnel/src/channel.ts";
import type { ClientHello, DaemonHandshake } from "../packages/tunnel/src/handshake.ts";

// ---------------------------------------------------------------------------
// The phone's URL and URLSearchParams, ported from the pinned React Native
// ---------------------------------------------------------------------------

/**
 * `validateBaseUrl` from `Libraries/Blob/URL.js`, verbatim (the dperini regex).
 * Only the base-URL branch of the constructor consults it.
 */
function validateBaseUrl(url: string): boolean {
  // Copied byte-for-byte from the pinned source rather than retyped by hand:
  // a regex this dense cannot be proofread, and a paraphrase that accepts or
  // rejects different URLs than the phone's would make every base-URL code
  // path in the gate answer for the wrong runtime.
  return /^(?:(?:(?:https?|ftp):)?\/\/)(?:(?:[1-9]\d?|1\d\d|2[01]\d|22[0-3])(?:\.(?:1?\d{1,2}|2[0-4]\d|25[0-5])){2}(?:\.(?:[1-9]\d?|1\d\d|2[0-4]\d|25[0-4]))|(?:(?:[a-z0-9\u00a1-\uffff][a-z0-9\u00a1-\uffff_-]{0,62})?[a-z0-9\u00a1-\uffff]\.)*(?:[a-z\u00a1-\uffff]{2,}\.?))(?::\d{2,5})?(?:[/?#]\S*)?$/.test(
    url,
  );
}

/**
 * React Native 0.81.6's `URL`, reduced to what any code in this repo can reach.
 *
 * The lying parts are the point: `host`/`hostname`/`origin`/`pathname`/
 * `username`/`password` match `https?://` only, so every other scheme (and
 * `ompd:` and `wss:` are the two this control plane lives on) reads as empty.
 * `toString()` appends the (possibly mutated) searchParams to the original
 * string instead of replacing the query, so a "delete the token then
 * stringify" dance leaves the token in the URL. `protocol` and `search` happen
 * to be scheme-generic there; the model keeps them that way rather than
 * assuming the stricter story, because the pinned source is the ground truth.
 *
 * Dropped as out of reach: the two Blob statics. Everything else is theirs,
 * including the constructor's trailing-slash and fragment rewrites, since
 * `toString()` answers depend on them.
 */
class ReactNativeURL {
  private readonly url: string;
  private searchParamsInstance: ReactNativeURLSearchParams | null = null;

  constructor(url: string, base?: string | ReactNativeURL) {
    if (base === undefined || validateBaseUrl(url)) {
      let normalized = url;
      if (normalized.includes("#")) {
        const split = normalized.split("#");
        const beforeHash = split[0] ?? "";
        const website = beforeHash.split("://")[1];
        if (website !== undefined && !website.includes("/")) {
          normalized = split.join("/#");
        }
      }
      if (!normalized.endsWith("/") && !(normalized.includes("?") || normalized.includes("#"))) {
        normalized += "/";
      }
      this.url = normalized;
      return;
    }
    let baseUrl = typeof base === "string" ? base : base.toString();
    if (!validateBaseUrl(baseUrl)) {
      throw new TypeError(`Invalid base URL: ${baseUrl}`);
    }
    if (baseUrl.endsWith("/")) {
      baseUrl = baseUrl.slice(0, -1);
    }
    let path = url.startsWith("/") ? url : `/${url}`;
    if (baseUrl.endsWith(path)) {
      path = "";
    }
    this.url = `${baseUrl}${path}`;
  }

  get hash(): string {
    const m = this.url.match(/#([^/]*)/);
    return m === null ? "" : `#${m[1] ?? ""}`;
  }

  get host(): string {
    const hostMatch = this.url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
    if (hostMatch === null) return "";
    const host = hostMatch[1] ?? "";
    const portMatch = this.url.match(/:(\d+)(?=[/?#]|$)/);
    return portMatch === null ? host : `${host}:${portMatch[1] ?? ""}`;
  }

  get hostname(): string {
    const m = this.url.match(/^https?:\/\/(?:[^@]+@)?([^:/?#]+)/);
    return m === null ? "" : (m[1] ?? "");
  }

  get href(): string {
    return this.toString();
  }

  get origin(): string {
    const m = this.url.match(/^(https?:\/\/[^/]+)/);
    return m === null ? "" : (m[1] ?? "");
  }

  get password(): string {
    const m = this.url.match(/https?:\/\/.*:(.*)@/);
    return m === null ? "" : (m[1] ?? "");
  }

  get pathname(): string {
    const m = this.url.match(/https?:\/\/[^/]+(\/[^?#]*)?/);
    return m === null ? "/" : (m[1] ?? "/");
  }

  get port(): string {
    const m = this.url.match(/:(\d+)(?=[/?#]|$)/);
    return m === null ? "" : (m[1] ?? "");
  }

  get protocol(): string {
    const m = this.url.match(/^([a-zA-Z][a-zA-Z\d+\-.]*):/);
    return m === null ? "" : `${m[1] ?? ""}:`;
  }

  get search(): string {
    const m = this.url.match(/\?([^#]*)/);
    return m === null ? "" : `?${m[1] ?? ""}`;
  }

  get searchParams(): ReactNativeURLSearchParams {
    if (this.searchParamsInstance === null) {
      this.searchParamsInstance = new ReactNativeURLSearchParams(this.search);
    }
    return this.searchParamsInstance;
  }

  toJSON(): string {
    return this.toString();
  }

  toString(): string {
    if (this.searchParamsInstance === null) {
      return this.url;
    }
    // The lie that broke token stripping: the original query is still in
    // `this.url`, and the mutated params are appended, not substituted.
    const instanceString = this.searchParamsInstance.toString();
    const separator = this.url.includes("?") ? "&" : "?";
    return this.url + separator + instanceString;
  }

  get username(): string {
    const m = this.url.match(/^https?:\/\/([^:@]+)(?::[^@]*)?@/);
    return m === null ? "" : (m[1] ?? "");
  }
}

/**
 * React Native 0.81.6's `URLSearchParams`, ported whole. `@ompd/core`'s
 * endpoint parsing reaches this class through the global on every `ompd://`
 * endpoint, so its encoding quirks (`+` for spaces, on both sides) are part of
 * the surface the gate must run against, not noise. A Map rather than a plain
 * record because the port keeps RN's insertion-order iteration and mutation.
 */
class ReactNativeURLSearchParams {
  private readonly params = new Map<string, string[]>();

  constructor(init?: Record<string, string> | string | [string, string][]) {
    if (init === null || init === undefined) {
      return;
    }
    if (typeof init === "string") {
      for (const pair of init.replace(/^\?/, "").split("&")) {
        if (pair.length === 0) continue;
        const [rawKey, rawValue] = pair.split("=");
        const key = decodeURIComponent((rawKey ?? "").replace(/\+/g, " "));
        const value = decodeURIComponent((rawValue ?? "").replace(/\+/g, " "));
        this.append(key, value);
      }
      return;
    }
    if (Array.isArray(init)) {
      for (const [key, value] of init) this.append(key, value);
      return;
    }
    for (const [key, value] of Object.entries(init)) this.append(key, value);
  }

  append(key: string, value: string): void {
    const existing = this.params.get(key);
    if (existing === undefined) {
      this.params.set(key, [value]);
    } else {
      existing.push(value);
    }
  }

  delete(name: string): void {
    this.params.delete(name);
  }

  get(name: string): string | null {
    const values = this.params.get(name);
    return values === undefined ? null : (values[0] ?? null);
  }

  getAll(name: string): string[] {
    return this.params.get(name) ?? [];
  }

  has(name: string): boolean {
    return this.params.has(name);
  }

  set(name: string, value: string): void {
    this.params.set(name, [value]);
  }

  keys(): IterableIterator<string> {
    return this.params.keys();
  }

  *values(): IterableIterator<string> {
    for (const valueArray of this.params.values()) {
      for (const value of valueArray) yield value;
    }
  }

  *entries(): IterableIterator<[string, string]> {
    for (const [key, values] of this.params) {
      for (const value of values) yield [key, value];
    }
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    const entries: [string, string][] = [];
    for (const entry of this.entries()) entries.push(entry);
    return entries[Symbol.iterator]();
  }

  forEach(callback: (value: string, key: string, searchParams: ReactNativeURLSearchParams) => void): void {
    for (const [key, value] of this.entries()) callback(value, key, this);
  }

  sort(): void {
    const sorted = [...this.params.entries()].sort(([a], [b]) => a.localeCompare(b));
    this.params.clear();
    for (const [key, values] of sorted) this.params.set(key, values);
  }

  toString(): string {
    const parts: string[] = [];
    for (const [key, values] of this.params) {
      for (const value of values) {
        parts.push(`${encodeSpaceAsPlus(key)}=${encodeSpaceAsPlus(value)}`);
      }
    }
    return parts.join("&");
  }
}

/** RN's encoding: `encodeURIComponent`, then literal spaces back to `+`. */
function encodeSpaceAsPlus(text: string): string {
  return encodeURIComponent(text).replace(/%20/g, "+");
}

// ---------------------------------------------------------------------------
// Installing and removing the surface
// ---------------------------------------------------------------------------

/**
 * Replace Bun's globals with the phone's, and return the function that puts
 * them back. Deleting rather than stubbing the absent ones is deliberate: a
 * stub returns `undefined` from a property access, while a deleted global
 * throws at the reference, which is the shape the device produces and the
 * shape `explainSurface` recognises.
 *
 * Modules under test are imported after this runs (see `main`), so even a
 * global read at module-evaluation time happens under the surface, exactly as
 * it would on the phone where the entrypoint installs the CSPRNG before any
 * other module loads.
 */
export function installHermesSurface(): () => void {
  const savedTextDecoder: unknown = (globalThis as { TextDecoder?: unknown }).TextDecoder;
  const savedBuffer: unknown = (globalThis as { Buffer?: unknown }).Buffer;
  const savedCrypto = globalThis.crypto;
  const savedURL = globalThis.URL;
  const savedURLSearchParams = globalThis.URLSearchParams;

  Reflect.deleteProperty(globalThis, "TextDecoder");
  Reflect.deleteProperty(globalThis, "Buffer");

  // `getRandomValues` only, bound to Bun's real CSPRNG: the phone's entropy
  // source is real too, and fake randomness here would make the handshake
  // "pass" for a reason the device can never offer.
  const platformCsprng = savedCrypto;
  const hermesCrypto = {
    getRandomValues<T extends ArrayBufferView | null>(view: T): T {
      return platformCsprng.getRandomValues(view);
    },
  };
  globalThis.crypto = hermesCrypto as unknown as Crypto;

  // @ts-expect-error deliberately substituting React Native's implementation
  globalThis.URL = ReactNativeURL;
  // @ts-expect-error same: the phone's class, not WHATWG's
  globalThis.URLSearchParams = ReactNativeURLSearchParams;

  return () => {
    Object.defineProperty(globalThis, "TextDecoder", { value: savedTextDecoder, configurable: true, writable: true });
    Object.defineProperty(globalThis, "Buffer", { value: savedBuffer, configurable: true, writable: true });
    globalThis.crypto = savedCrypto;
    globalThis.URL = savedURL;
    globalThis.URLSearchParams = savedURLSearchParams;
  };
}

/**
 * Translate a thrown error into the global it implicates, so a failure says
 * which part of the surface was reached rather than only what Hermes would
 * have printed. Unrecognised shapes are labelled as such: a novel failure
 * deserves a human looking at it, not a confident guess.
 */
export function explainSurface(cause: unknown): string {
  const text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  if (/TextDecoder/.test(text)) {
    return "TextDecoder is absent on Hermes (TextEncoder IS present; UTF-8 must be decoded by hand)";
  }
  if (/Buffer/.test(text)) {
    return "Buffer is absent on Hermes";
  }
  if (/getRandomValues|globalThis\.crypto|\bcrypto is not defined\b/.test(text)) {
    return "crypto.getRandomValues exists on the phone only because the app's first import installs it; nothing else of crypto does";
  }
  if (/subtle|importKey|deriveBits|deriveKey|WebCrypto/i.test(text)) {
    return "crypto.subtle (WebCrypto) does not exist on Hermes; HKDF, AES-GCM, and signatures must come from @noble";
  }
  if (/\.delete is not a function|URLSearchParams\.delete/.test(text)) {
    return "URLSearchParams is React Native's own, not WHATWG's; at this pin delete exists but toString() composes by append (see the header)";
  }
  if (/URL\.parse|parse is not a function/.test(text)) {
    return "URL.parse is a static React Native's URL does not implement";
  }
  if (/Cannot set propert/.test(text)) {
    return "URL on React Native has getters only; assigning search or host cannot work";
  }
  if (cause instanceof GateFailure) {
    return "no global was reached; the client path produced a wrong value (or nothing at all) under the phone's semantics";
  }
  return `unrecognised failure shape, inspect by hand: ${text}`;
}

// ---------------------------------------------------------------------------
// Scenario machinery
// ---------------------------------------------------------------------------

/** Thrown by the gate's own assertions, as distinct from a surface failure. */
class GateFailure extends Error {}

function requireEquals(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new GateFailure(`gate: ${what}: expected ${b}, got ${a}`);
  }
}

function requireTruth(value: boolean, what: string): void {
  if (!value) throw new GateFailure(`gate: ${what} did not hold`);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

interface Scenario {
  /** The ok/FAIL line. */
  readonly label: string;
  /** Package whose client-reachable path is under test. */
  readonly module: string;
  /** Where in this repo that path lives. */
  readonly files: string;
  /** What an operator would watch happen on the phone if this broke. */
  readonly consequence: string;
}

const failures: string[] = [];

async function runScenario(scenario: Scenario, exercise: () => Promise<void> | void): Promise<boolean> {
  try {
    await exercise();
    console.log(`  ok   ${scenario.label}`);
    return true;
  } catch (cause) {
    failures.push(scenario.label);
    console.log(`  FAIL ${scenario.label}`);
    console.log(`       module: ${scenario.module} (${scenario.files})`);
    console.log(`       surface: ${explainSurface(cause)}`);
    console.log(`       operator sees: ${scenario.consequence}`);
    console.log(`       error: ${describeCause(cause)}`);
    return false;
  }
}

/**
 * Poll until `condition` holds, or fail the scenario. The relayed turn is a
 * chain of promise-serialised seal/open steps, so the scenario cannot know how
 * many ticks its last frame needs; it can know that a healthy one settles in
 * well under a second and a hung one never does.
 */
async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new GateFailure(`gate: timed out waiting for ${what}`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 5);
    await promise;
  }
}

// ---------------------------------------------------------------------------
// A scripted hub: the relay and the daemon's half of the tunnel
// ---------------------------------------------------------------------------

/** The tunnel's handshake answer, as the daemon half of the script calls it. */
type AnswerClientHandshake = (input: {
  hello: ClientHello;
  sessionId: string;
  daemonId: string;
  privateKey: string;
}) => Promise<DaemonHandshake>;

type SealedChannelConstructor = new (keys: ChannelKeys, role: "client" | "daemon") => SealedChannel;

// The real implementations, bound in `main` once the surface is installed and
// the tunnel's modules are imported. Module-level rather than constructor
// parameters because the daemon half of the script is an implementation detail
// of the gate, not a collaborator any caller should have to thread through.
let answerClientHandshake: AnswerClientHandshake;
let makeSealedChannel: SealedChannelConstructor;

/**
 * The wire `TunnelSocket` dials, plus the daemon-side script that answers it.
 *
 * The hub is the one party this gate fakes, because the alternative is a real
 * relay and a real daemon, which turns a sub-second surface check into an
 * integration environment. Everything above the wire is the shipped code: the
 * client handshake, the key derivation, the sealed channel, the frame
 * parsers. The daemon half answers with the same functions the real daemon
 * calls, so a defect in any of them fails here for the same reason it fails
 * on a phone.
 */
class ScriptedHub {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: ((info: { code: number; reason: string }) => void) | null = null;
  onerror: ((info: { message: string }) => void) | null = null;
  onmessage: ((data: string) => void) | null = null;

  /** The scenario's hook into the daemon half, set before `begin()`. */
  onSession: ((frame: { t: string } & Record<string, unknown>) => void) | null = null;

  readonly #sessionId: string;
  readonly #daemonId: string;
  readonly #publicKey: string;
  readonly #privateKey: string;
  #channel: SealedChannel | null = null;
  #rseq = 0;
  closed = false;

  constructor(input: { sessionId: string; daemonId: string; publicKey: string; privateKey: string }) {
    this.#sessionId = input.sessionId;
    this.#daemonId = input.daemonId;
    this.#publicKey = input.publicKey;
    this.#privateKey = input.privateKey;
  }

  send(raw: string): void {
    let frame: { t?: string; payload?: string };
    try {
      frame = JSON.parse(raw) as { t?: string; payload?: string };
    } catch {
      return;
    }
    if (frame.t === "data" && typeof frame.payload === "string") {
      void this.#ingest(frame.payload).catch(cause => this.#crash(describeCause(cause)));
    }
  }

  close(code = 1000, reason = "hub closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The hub's first move, once the scenario has wired every handler. */
  begin(): void {
    this.onmessage?.(
      JSON.stringify({
        t: "linked",
        v: 1,
        sessionId: this.#sessionId,
        daemonId: this.#daemonId,
        publicKey: this.#publicKey,
      }),
    );
  }

  /** Seal a daemon-to-client session frame and hand it to the relay. */
  async respond(plaintext: string): Promise<void> {
    const channel = this.#channel;
    if (channel === null) throw new Error("hub script: no channel to respond on");
    this.#deliver(await channel.seal(plaintext));
  }

  #deliver(payload: string): void {
    this.onmessage?.(JSON.stringify({ t: "data", rseq: this.#rseq++, payload }));
  }

  async #ingest(payload: string): Promise<void> {
    if (this.#channel === null) {
      // The client's first data frame is the unsealed hello, by protocol.
      const hello = JSON.parse(payload) as ClientHello;
      const answer = await answerClientHandshake({
        hello,
        sessionId: this.#sessionId,
        daemonId: this.#daemonId,
        privateKey: this.#privateKey,
      });
      this.#channel = new makeSealedChannel(answer.keys, "daemon");
      this.#deliver(JSON.stringify(answer.auth));
      return;
    }
    const plaintext = await this.#channel.open(payload);
    this.onSession?.(JSON.parse(plaintext) as { t: string } & Record<string, unknown>);
  }

  #crash(message: string): void {
    this.onerror?.({ message });
    this.close(4500, `hub script failed: ${message}`);
  }
}

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

const HUB = "wss://hub.ompctl.ai";
const DAEMON_BODY = "a1".repeat(32);
const DAEMON_ID = `dmn_${DAEMON_BODY}`;
const TOKEN = "dev_t0ken_b0dy";
const AGENT = "agt_q7";

async function main(): Promise<void> {
  console.log("Hermes surface gate: client-reachable code must run on the phone's runtime, not Bun's\n");
  console.log("surface: TextDecoder, Buffer, and all of WebCrypto absent; crypto carries getRandomValues only;");
  console.log("         URL and URLSearchParams are React Native 0.81.6's, host and hostname http-only\n");

  // Dynamic on purpose, and only here: every module under test must be
  // evaluated AFTER the surface exists (the outer `installHermesSurface()`
  // has already run by the time this function is entered), so that a global
  // read at module-evaluation time fails exactly like it would on a phone. A
  // static import would hoist evaluation above the install and quietly
  // exclude that entire class of defect from the gate.
  const pairing = await import("../packages/core/src/pairing.ts");
  const policy = await import("../packages/core/src/policy.ts");
  const clientModule = await import("../packages/core/src/ompd-client.ts");
  const identityModule = await import("../packages/tunnel/src/identity.ts");
  const handshakeModule = await import("../packages/tunnel/src/handshake.ts");
  const channelModule = await import("../packages/tunnel/src/channel.ts");
  const tunnelModule = await import("../packages/tunnel/src/index.ts");
  const appSocket = await import("../packages/app/src/platform/socket.ts");

  answerClientHandshake = handshakeModule.answerClientHandshake;
  makeSealedChannel = channelModule.SealedChannel;

  let passed = 0;

  if (
    await runScenario(
      {
        label: "the surface model really is the phone's",
        module: "this gate",
        files: "scripts/check-hermes-surface.ts",
        consequence:
          "nothing: this guards the gate itself. A model that quietly stopped lying would turn every later ok into a vacuous pass",
      },
      () => {
        requireEquals(typeof TextDecoder, "undefined", "TextDecoder must be deleted");
        requireEquals(typeof Buffer, "undefined", "Buffer must be deleted");
        requireEquals(typeof globalThis.crypto.subtle, "undefined", "crypto.subtle must not exist");
        requireEquals(typeof globalThis.crypto.getRandomValues, "function", "crypto.getRandomValues must exist");
        requireEquals(typeof TextEncoder, "function", "TextEncoder must remain (the phone has it)");
        requireEquals(new TextEncoder().encode("ok").length, 2, "TextEncoder must work");
        const wss = new URL("wss://hub.ompctl.ai");
        requireEquals(wss.host, "", "RN URL.host must be empty for wss");
        requireEquals(wss.hostname, "", "RN URL.hostname must be empty for wss");
        requireEquals(wss.protocol, "wss:", "RN URL.protocol stays scheme-generic at this pin");
        const http = new URL("https://hub.ompctl.ai/path");
        requireEquals(http.host, "hub.ompctl.ai", "RN URL.host must answer for https");
        requireEquals(typeof (URL as unknown as { parse?: unknown }).parse, "undefined", "URL.parse must not exist");
        // The append lie: deleting from searchParams and stringifying must NOT
        // remove the token from the URL, because that is exactly the phone
        // behaviour a future "clean up this URL" change would trip over.
        const withToken = new URL("https://hub.ompctl.ai/link?token=secret&x=1");
        withToken.searchParams.delete("token");
        requireTruth(withToken.toString().includes("token=secret"), "RN URL.toString must still carry a deleted token");
      },
    )
  ) {
    passed += 1;
  }

  if (
    await runScenario(
      {
        label: "pairing input parses (target, credential, bundle, endpoint)",
        module: "@ompd/core",
        files: "packages/core/src/pairing.ts",
        consequence:
          "the pairing screen refuses everything typed or scanned into it; the phone cannot be paired at all",
      },
      () => {
        requireEquals(
          pairing.parsePairTarget(""),
          { transport: "hub", hubUrl: HUB },
          "empty target means the hosted hub",
        );
        requireEquals(
          pairing.parsePairTarget("hub.example.com"),
          { transport: "hub", hubUrl: "wss://hub.example.com" },
          "bare host",
        );
        requireEquals(
          pairing.parsePairTarget("wss://hub.example.com"),
          { transport: "hub", hubUrl: "wss://hub.example.com" },
          "hub url",
        );
        requireEquals(
          pairing.parsePairTarget("wss://10.0.0.5:7777/v1/socket"),
          { transport: "direct", url: "wss://10.0.0.5:7777/v1/socket" },
          "direct socket url",
        );
        // A bearer over cleartext to another machine is refused; the same
        // scheme on loopback is the daemon-served console's own address.
        requireEquals(pairing.parsePairTarget("ws://10.0.0.5:7777/v1/socket"), null, "refuse cleartext off-box");
        requireEquals(
          pairing.parsePairTarget("ws://127.0.0.1:7777/v1/socket"),
          { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket" },
          "loopback cleartext socket url",
        );
        requireEquals(pairing.parsePairTarget("not an address"), null, "refuse garbage");

        requireEquals(
          pairing.parseDeviceCredential(`${DAEMON_BODY}.${TOKEN}`),
          { daemonId: DAEMON_ID, token: TOKEN },
          "credential",
        );
        requireEquals(pairing.parseDeviceCredential("garbage"), null, "refuse a non-credential");

        // A scanned QR round trip, with the label chosen to make any decoder
        // shortcut visible: two-, three-, and four-byte code points.
        const bundle = {
          v: 1 as const,
          label: "Pixel 7 café 日本 🚀",
          connection: {
            transport: "hub" as const,
            hubUrl: HUB,
            daemonId: DAEMON_ID,
            token: TOKEN,
            scopes: ["sessions:read"],
          },
        };
        requireEquals(pairing.parsePairingBundle(pairing.encodePairingBundle(bundle)), bundle, "bundle round trip");
        requireEquals(pairing.parsePairingBundle("not-a-bundle"), null, "refuse a foreign string");

        // `ompd:` endpoints go through the global URLSearchParams both ways,
        // which on the phone is React Native's class, not WHATWG's.
        const endpoint = { transport: "hub" as const, hubUrl: HUB, daemonId: DAEMON_ID };
        requireEquals(pairing.parseEndpoint(pairing.encodeEndpoint(endpoint)), endpoint, "endpoint round trip");
        requireEquals(
          pairing.parseEndpoint(`ompd://elsewhere?url=${encodeURIComponent(HUB)}&daemon=${DAEMON_ID}`),
          null,
          "refuse a foreign authority",
        );
        requireEquals(pairing.isHubUrl(HUB), true, "hub url recognised");
        requireEquals(pairing.isSocketUrl("ws://10.0.0.5:7777/v1/socket"), true, "socket url recognised");
      },
    )
  ) {
    passed += 1;
  }

  if (
    await runScenario(
      {
        label: "the WebView URL policy decides under the lying URL",
        module: "@ompd/core",
        files: "packages/core/src/policy.ts",
        consequence:
          "every agent-supplied URL reads as undriveable (or everything reads as driveable); the in-app browser refuses to open anything",
      },
      () => {
        requireEquals(policy.undriveableUrlReason("about:blank"), null, "the sandbox's own blank page");
        requireEquals(policy.undriveableUrlReason("https://example.com/page"), null, "an https page is driveable");
        requireEquals(
          policy.undriveableUrlReason("file:///etc/passwd"),
          "scheme file: is not driveable",
          "a file url must be refused for its scheme",
        );
        requireEquals(
          policy.undriveableUrlReason("http:///etc/passwd"),
          "no host",
          "a hostless http url must be refused",
        );
      },
    )
  ) {
    passed += 1;
  }

  // The handshake needs a real daemon identity: the client verifies the
  // fingerprint of the offered key against the id it pinned at pairing, so a
  // made-up pair of strings would be refused exactly like a hostile hub.
  const identity = identityModule.generateIdentity();
  const pinnedDaemonId = identityModule.fingerprint(identity.publicKey);
  let handshakeKeys: ChannelKeys | null = null;

  if (
    await runScenario(
      {
        label: "the sealed-channel handshake completes",
        module: "@ompd/tunnel",
        files: "packages/tunnel/src/handshake.ts, identity.ts, bytes.ts",
        consequence:
          "the session never establishes: the phone reconnects forever and the console shows no agents, no sessions, and a websocket error",
      },
      async () => {
        const client = handshakeModule.beginClientHandshake(pinnedDaemonId);
        const daemon = await answerClientHandshake({
          hello: client.hello,
          sessionId: "sess_gate_1",
          daemonId: pinnedDaemonId,
          privateKey: identity.privateKey,
        });
        handshakeKeys = await client.accept(daemon.auth, { sessionId: "sess_gate_1", publicKey: identity.publicKey });
        requireTruth(handshakeKeys !== null, "the client accepted the daemon's proof");
        requireEquals(typeof handshakeKeys.c2d, "object", "client-to-daemon key derived");
        requireEquals(typeof handshakeKeys.d2c, "object", "daemon-to-client key derived");
      },
    )
  ) {
    passed += 1;
  }

  if (
    await runScenario(
      {
        label: "one seal/open round trip through the sealed channel",
        module: "@ompd/tunnel",
        files: "packages/tunnel/src/channel.ts, bytes.ts",
        consequence:
          "session confirmation did not authenticate: Property TextDecoder doesn't exist, the recorded on-device failure (ecbd6b2)",
      },
      async () => {
        const keys = handshakeKeys;
        if (keys === null) throw new GateFailure("gate: no handshake keys; the handshake scenario must pass first");
        const asClient = new channelModule.SealedChannel(keys, "client");
        const asDaemon = new channelModule.SealedChannel(keys, "daemon");
        // The message that makes any encoder shortcut visible, plus a body long
        // enough to cross the decoder's batching boundary.
        const message = `{"t":"ready","v":1,"note":"café 日本 🚀","long":"${"x".repeat(9000)}"}`;
        const opened = await asClient.open(await asDaemon.seal(message));
        requireEquals(opened, message, "the sealed frame opened byte-for-byte");
        requireEquals(asClient.received, 1, "the receiver counted it");
      },
    )
  ) {
    passed += 1;
  }

  if (
    await runScenario(
      {
        label: "hubSocketUrl strips the credential the client appended",
        module: "@ompd/tunnel",
        files: "packages/tunnel/src/socket.ts",
        consequence:
          "the device token is handed to the public relay, or the dial URL is malformed and no socket ever opens",
      },
      () => {
        const stripped = tunnelModule.hubSocketUrl(`${HUB}/v1/link/${DAEMON_ID}?token=${encodeURIComponent(TOKEN)}`);
        requireEquals(stripped.token, TOKEN, "token extracted");
        requireEquals(stripped.base, `${HUB}/v1/link/${DAEMON_ID}`, "base keeps the path");
        const kept = tunnelModule.hubSocketUrl(`${HUB}?token=t&x=1`);
        requireEquals(kept.token, "t", "token extracted among other params");
        requireEquals(kept.base, `${HUB}?x=1`, "other params preserved");
        const bare = tunnelModule.hubSocketUrl(HUB);
        requireEquals(bare.token, null, "no token, no claim of one");
        requireEquals(bare.base, HUB, "bare base unchanged");
      },
    )
  ) {
    passed += 1;
  }

  if (
    await runScenario(
      {
        label: "one relayed turn: OmpdClient framing over the tunnel",
        module: "@ompd/core + @ompd/tunnel",
        files: "packages/core/src/ompd-client.ts, packages/tunnel/src/socket.ts, packages/app/src/platform/socket.ts",
        consequence:
          "the phone pairs, then shows no agents and no sessions with only `websocket error` as the clue: the shipped shape of every incident above",
      },
      async () => {
        const hub = new ScriptedHub({
          sessionId: "sess_gate_2",
          daemonId: pinnedDaemonId,
          publicKey: identity.publicKey,
          privateKey: identity.privateKey,
        });

        // The daemon half's answers, using the same functions the real daemon
        // calls. The gateway hello is queued right behind the sealed ready: the
        // tunnel serialises inbound frames, so ordering is guaranteed without
        // the script guessing at the client's progress.
        const seen: string[] = [];
        hub.onSession = frame => {
          if (frame.t === "credential") {
            seen.push(`credential:${String(frame.token)}`);
            void hub.respond(JSON.stringify({ t: "ready", deviceId: "dev_gate" })).then(() =>
              hub.respond(
                JSON.stringify({
                  t: "hello",
                  deviceId: "dev_gate",
                  // The client re-emits these rows verbatim; one opaque row is
                  // enough to count, and inventing a full Agent here would
                  // test nothing the framing does not already test.
                  agents: [{ id: AGENT }],
                }),
              ),
            );
            return;
          }
          if (frame.t === "attach") {
            seen.push(`attach:${String(frame.agentId)}`);
            void hub.respond(
              JSON.stringify({
                t: "update",
                agentId: AGENT,
                seq: 1,
                update: { kind: "log", text: "attached café 日本 🚀" },
              }),
            );
            return;
          }
          if (frame.t === "prompt") {
            seen.push(`prompt:${String(frame.text)}`);
            void hub.respond(
              JSON.stringify({ t: "update", agentId: AGENT, seq: 2, update: { kind: "text", text: frame.text } }),
            );
          }
        };

        const errors: string[] = [];
        const updates: { seq: number; update: unknown }[] = [];
        const client = new clientModule.OmpdClient({
          url: HUB,
          token: TOKEN,
          createSocket: appSocket.createHubSocketFactory({ daemonId: pinnedDaemonId, transport: () => hub }),
          // The default probe dials the hub's HTTP origin, which this scripted
          // relay does not serve; a probe answer is not what is under test.
          probeCredential: async () => "unknown",
        });
        client.on("error", event => errors.push(event.message));
        client.on("update", event => updates.push({ seq: event.seq, update: event.update }));

        client.start();
        hub.begin();
        try {
          await until(() => client.connectionState === "connected", "the gateway hello through the sealed channel");
        } catch (cause) {
          // The adapter reduces every tunnel failure to "websocket error",
          // which on a phone is the entire clue an operator gets. The gate
          // can say what the tunnel actually said before it died.
          if (cause instanceof GateFailure && errors.length > 0) {
            throw new GateFailure(`${cause.message}; client error events so far: ${JSON.stringify(errors)}`);
          }
          throw cause;
        }
        client.attach(AGENT, { sinceSeq: 0 });
        await until(() => updates.some(u => u.seq === 1), "the first sealed update");
        client.prompt(AGENT, "sealed prompt café 日本 🚀");
        await until(() => client.watermark(AGENT) === 2, "the second sealed update advancing the watermark");

        requireEquals(seen[0], `credential:${TOKEN}`, "the token rode sealed, first session frame");
        requireEquals(seen[1], `attach:${AGENT}`, "the attach rode sealed");
        requireEquals(seen[2], "prompt:sealed prompt café 日本 🚀", "the prompt rode sealed, unicode intact");
        requireEquals(updates.length, 2, "both updates delivered");
        requireEquals(errors, [], "no error events during the turn");
        requireEquals(client.watermark(AGENT), 2, "the resume watermark advanced to 2");

        client.close();
      },
    )
  ) {
    passed += 1;
  }

  console.log("");
  if (failures.length > 0) {
    console.error(`${failures.length} of ${failures.length + passed} scenarios failed: ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log(
    `Hermes surface gate passed: ${passed} scenario groups ran with the phone's globals installed, ` +
      "pairing input, the handshake, the sealed channel, the hub URL strip, and one relayed turn all intact.",
  );
}

// Only as an entry point. The test file imports `installHermesSurface` and
// `explainSurface` from this module, and an unguarded run would execute the
// whole gate (and mutate globals) once per import on top of once per `bun run`.
if (import.meta.main) {
  const restore = installHermesSurface();
  try {
    await main();
  } finally {
    restore();
  }
}
