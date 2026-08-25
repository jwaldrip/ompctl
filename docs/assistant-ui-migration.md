# Adopting `@assistant-ui/react-native` in ompctl

Base: `origin/main` at `1efcdd4`. Package under evaluation: `@assistant-ui/react-native@0.1.38`.

All numbers below were measured in a real worktree (`ompctl.worktrees/aui-compat`, branch `probe/assistant-ui-compat`, off `1efcdd4`), not inferred from docs or registry metadata.

---

## 1. Decision

**Adopted.** Jason gave the go on 2026-08-24, with the alpha risk in this document read and accepted. The owned session's chat runtime becomes assistant-ui. What follows is the record of what that costs and how it is contained, not an argument for or against.

Adoption is technically viable and the architecture keeps the daemon authoritative. It is not a drop-in, and three facts define the risk being accepted:

1. A **packaging defect** means `assistant-cloud` must be declared as our own direct dependency or every bundler build fails, while bun and `tsc` both report green. §4.
2. The architecture **requires importing `@assistant-ui/core/react` directly**, and that package's own README says *"Most users do not install `@assistant-ui/core` directly"*, framing itself as a base for integration libraries rather than apps. §9.
3. Importing that entry point **reads `process.env` at module scope and can construct a network client**. §4a.

Containment, all three: one boundary module (`packages/app/src/assistant/runtime.ts`) is the only place the app reaches into core, literal pins with no carets, and a dependency integrity check in CI that fails on a missing `assistant-cloud`, a duplicated core or store, or a second React. §3, §4, §11.

---

## 2. Is the external-store architecture actually available?

Yes, but not from the React Native package.

| Symbol | Exported from | Notes |
| --- | --- | --- |
| `useExternalStoreRuntime` | **`@assistant-ui/core/react` only** | Not exported by `@assistant-ui/react-native` |
| `ExternalStoreAdapter`, `ExternalStoreThreadData` | **`@assistant-ui/core` root only** | Not from `/react` |
| `AssistantRuntimeProvider` | both | Same value: RN's is a bare re-export of core's |
| `ThreadPrimitive`, `ComposerPrimitive`, `MessagePrimitive`, `AttachmentPrimitive`, `AuiIf` | **`@assistant-ui/react-native` only** | |
| `getExternalStoreMessage` | **nowhere** | Absent from core, `/react`, `/internal`, `/store` and the RN package. Any design assuming it is wrong |

`@assistant-ui/react-native@0.1.38` exports exactly two runtime hooks, `useLocalRuntime` and `useRemoteThreadListRuntime`. Both keep messages in memory, which is the duplicate local store our contracts forbid. The RN `custom-backend` doc offers only those two options and never mentions the external store. The external store exists one package down and is DOM-free (`@assistant-ui/core` deps are `assistant-stream` + `nanoid`; no `react-dom`, no radix, no DOM references in `dist/react/runtimes`).

So one component needs three import lines across two packages. That is the whole trick, and it is why this looked unavailable at first read.

### The adapter contract we would implement

`useExternalStoreRuntime<T>(store: ExternalStoreAdapter<T>) => AssistantRuntime`

The parts that matter to us:

- `messages: readonly T[]` + `convertMessage: (message: T, idx) => ThreadMessageLike` — **our reducer stays authoritative**. assistant-ui converts, it does not own.
- Conversion is cached by object identity (`convertMessages<TIn extends WeakKey>`). Our reducer already shares unchanged entries by reference, so the cache hits for free and a streaming token re-converts exactly one entry.
- `isRunning`, `isLoading`, `isDisabled`, `isSendDisabled` — direct homes for our activity gate, load phase, and prompt-scope refusals.
- `onNew`, `onCancel`, `onEdit`, `onReload`, `onAddToolResult`, `onRespondToToolApproval` — dispatch back through `OmpdClient`.
- `adapters.attachments` / `dictation` / `speech` — homes for the image picker and voice.

No AI SDK, no HTTP chat endpoint, no thread store. Contract preserved.

---

## 3. Compatibility pin

Measured per `skill://react-native-multiplatform-version-pin`.

### The pin does not move

| Package | Pinned on main | Peers `react-native` | 0.81.6 satisfies |
| --- | --- | --- | --- |
| `react-native` | 0.81.6 | core | — |
| `react-native-macos` | 0.81.9 | exactly `0.81.6` | yes |
| `react-native-windows` | 0.81.30 | `^0.81.0` | yes |
| `react-native-web` | 0.21.2 | loose | yes |
| **`@assistant-ui/react-native` 0.1.38** | — | **`*`** | yes |

A `*` peer admits everything, so the intersection is unchanged and the existing literal pins stay correct. **Adopting this does not force a React Native upgrade.**

### Literal pins to add

```json
"@assistant-ui/react-native": "0.1.38",
"@assistant-ui/core": "0.3.15",
"assistant-cloud": "0.1.41"
```

No carets, per the skill.

- `@assistant-ui/core` must be declared because we import it directly. Today it resolves only because bun hoists the RN package's own dependency — a phantom dependency.
- `assistant-cloud` must be declared for the reason in §4.

### Cost

10 added packages, 0 removed, 0 version-changed (measured as a same-commit `bun pm ls --all` set diff: 1196 vs 1186).

`@assistant-ui/core@0.3.15`, `@assistant-ui/react-native@0.1.38`, `@assistant-ui/store@0.3.10`, `@assistant-ui/tap@0.9.14`, `assistant-cloud@0.1.41`, `assistant-stream@0.3.39`, `zustand@5.0.15`, `nanoid@6.0.1`, `@standard-schema/spec@1.1.0`, `secure-json-parse@4.1.0`.

- **iOS Metro release bundle: +752 KiB** (982,186 → 1,752,583 bytes). Metro does not tree-shake, so all 16 `assistant-cloud` modules ship even though nothing calls them.
- Web: rollup **does** tree-shake `assistant-cloud` out. 520 kB / 158.7 kB gzip for the probe alone.

### No duplicate React

| | baseline | after |
| --- | --- | --- |
| `react` | `19.1.4` hoisted + pre-existing nested `19.2.7` under `@oh-my-pi/omp-stats` | unchanged |
| `react-native` | one, `0.81.6` | unchanged |
| `zustand` | absent | one, `5.0.15`, newly hoisted |

Verified in the built artifacts, not just on disk: the iOS Metro sourcemap contains exactly one `node_modules/react/` root; the Vite sourcemap exactly one react and one react-dom.

The skill's `catalog:`-defeats-Biome trap is **already closed** in this repo: `biome.json` sets `linter.domains.react = "recommended"`.

---

## 4. Blocking prerequisite: the `assistant-cloud` trap

`assistant-cloud` is an **optional** peer of `@assistant-ui/core` that core **imports unconditionally** from a non-optional entry point.

`node_modules/@assistant-ui/core/dist/react/runtimes/cloud/AssistantCloudThreadHistoryAdapter.js:4`:
```js
import { CloudMessagePersistence, createFormattedPersistence } from "assistant-cloud";
```

Reachable from `@assistant-ui/core/dist/react/index.js` and from `@assistant-ui/react-native/dist/index.js`.

| Layer | Without `assistant-cloud` |
| --- | --- |
| `bun install` | **silent**, zero warnings (bun skips optional peers by design) |
| `bun run check` | **clean** — masked by `skipLibCheck: true`; with it off, exactly 5 × TS2307 |
| Metro | **hard fail**: `Unable to resolve module assistant-cloud` |
| Vite | **hard fail**: `"CloudMessagePersistence" is not exported by __vite-optional-peer-dep:assistant-cloud` |
| bun runtime import | **hard fail**: `Cannot find package 'assistant-cloud'` |

This is **not** a cost of routing the runtime through `core/react`: an entry importing only `@assistant-ui/react-native` fails identically. It is a packaging defect. Contrast `assistant-stream`, which correctly gates its optional `redis`/`ioredis` peers behind dedicated `./resumable/*` subpaths and is fine.

Fix: declare `assistant-cloud` ourselves. One line. But note what it means — three layers of our toolchain report green on a tree that cannot build.

---

## 4a. `assistant-cloud` is more than a packaging defect

An earlier draft of this document called it only a packaging defect. That undersells it, and the correction came out of the adversarial review.

`@assistant-ui/core/dist/react/runtimes/cloud/useCloudThreadListAdapter.js`, lines 11-14, at **module scope**:

```js
const baseUrl = typeof process !== "undefined" && process?.env?.NEXT_PUBLIC_ASSISTANT_BASE_URL;
const autoCloud = baseUrl ? new AssistantCloud({ baseUrl, anonymous: true }) : void 0;
```

That module is **statically imported** by `@assistant-ui/core/dist/react/index.js`. So importing `useExternalStoreRuntime` — the one symbol this whole architecture needs — executes an environment read and, if that variable is set, constructs an anonymous cloud client before any of our code runs.

What is actually true in our app, measured on the shipped iOS bundle:

| | |
| --- | --- |
| `NEXT_PUBLIC_ASSISTANT_BASE_URL` occurrences in `/tmp/aui-real-ios.jsbundle` | **1** — the env read ships |
| `AssistantCloud` occurrences | 15 — the client class ships |
| Is a client constructed? | **No.** The variable is unset, nothing in `metro.config.cjs` defines `NEXT_PUBLIC_*`, so `autoCloud` is `undefined` |

So there is no live cloud client in the app today, and no evidence of a call being made. The exposure is narrower and worth stating exactly: **a signed app ships a cloud client class and an import-time env read that would construct it, from a dependency we wanted one hook from.** One build tool that injects `NEXT_PUBLIC_*` variables would flip it on with nothing in our code changing.

Accepted, with the boundary module as containment and this recorded so nobody has to rediscover it. If it ever needs closing, the fix is a Metro `resolver.blockList` or an alias stubbing that module, not a patch to core.

---

## 5. Second hazard: Metro silently serves the wrong core

`metro.config.cjs` sets `disableHierarchicalLookup: true` with `nodeModulesPaths` limited to two roots. Metro therefore cannot see **any** nested `node_modules`, so every nested resolution flattens to the hoisted copy.

Proven, not theorised: pinning `@assistant-ui/core` to `0.3.14` (outside the RN package's `^0.3.15`) made bun materialise two copies — hoisted `0.3.14` plus nested `0.3.15` under the RN package. The Metro iOS bundle then **succeeded, green, no warning**, with exactly one core root in the sourcemap: the `0.3.14` we pinned. The library ran against a core it did not ask for and nothing said a word.

`@assistant-ui/core` is a **direct dependency** (`^0.3.15`) of the RN package, not a peer. So our own literal pin creates a standing obligation: the first RN-package bump wanting a core our pin does not satisfy will silently skew.

Mitigating detail worth knowing: the React context linking `AssistantRuntimeProvider` to the primitives is a module-level `createContext` in `@assistant-ui/store`, not in core. So **`@assistant-ui/store` is the package that must stay single-copy** for provider/primitive linkage. A duplicated *core* is an implementation skew rather than an instant broken-context redbox — harder to notice, not easier.

**Guard:** a CI check asserting exactly one copy each of `@assistant-ui/store` and `@assistant-ui/core`, and that our declared core pin satisfies the RN package's range.

---

## 6. Adapter mapping table

Our `Entry` union → `ThreadMessageLike`. `ThreadMessageLike` is richer than expected and covers almost everything.

| ompctl | assistant-ui representation | Fidelity |
| --- | --- | --- |
| `UserEntry` | `{ role: "user", content: [{ type: "text" }], id }` | exact |
| `AssistantEntry` (prose) | `{ role: "assistant", content: [{ type: "text" }], status }` | exact |
| `AssistantEntry` `thought: true` | `{ type: "reasoning" }` part | exact; `ReasoningMessagePartComponent` renders it |
| `AssistantEntry` `streaming: true` | `status: { type: "running" }` | exact |
| `ToolEntry` | `{ type: "tool-call", toolCallId, toolName, args, argsText, result, isError, artifact }` | exact. `artifact` is `any`, so `ToolKind`/`locations` ride there |
| `ApprovalEntry` | **folds into the tool-call part's `approval` field** (`{ id, approved, reason, options, optionId, resolution }`) | good, but see gap G1 |
| `PlanEntry[]` / todos | `data-${string}` part or `metadata.custom` | representable, not message-native. See G2 |
| `spoken` summary | `data-` part or stays outside the thread | representable |
| `UnknownEntry` | `data-` part carrying the raw payload | exact — the escape hatch is real |
| Attachments | `attachments[]` with `ThreadUserMessagePart` content | exact; needs an `AttachmentAdapter` for `react-native-image-picker` |


### Two findings from actually building it

Both were measured in `ompctl.worktrees/aui-proof` (branch `feat/assistant-ui-proof`), not reasoned about.

**1. `metadata.custom` survives the conversion.** This was the load-bearing risk: if `fromThreadMessageLike` dropped it, every row would lose its source entry and the conversion would be lossy after all. It does not. `expect(entryOf(convertEntry(entry))).toBe(entry)` passes on identity, not equality, so a renderer reads the original object back rather than a reconstruction. The design stands.

**2. `isRunning: true` synthesizes a placeholder assistant message, and it collides with `ActivityRow`.** The same session renders `["aui-row-user", "aui-row-foreign"]` with `state: "busy"` and `["aui-row-user"]` with `state: "idle"`. While the thread is running and the newest message is the operator's, the external-store runtime appends an assistant message of its own that carries no `metadata.custom`.

That placeholder answers the same question `ActivityRow` answers, and the two disagree on the part that matters: the placeholder is **replaced** when assistant text starts streaming, whereas omp's own TUI keeps its loader running for the whole turn (`#handleMessageUpdate` → `#ensureWorkingLoaderWhileStreaming`, stopped only in `#finishAgentEnd`). #133 shipped the TUI's semantics after reading that source. So the resolution is to keep reporting `isRunning` — `ComposerPrimitive.Cancel` needs it — and render the placeholder as `null`, leaving the footer row as the single indicator. Rendering both would put two working indicators on one turn.

Add to the gap table: **assistant-ui has an opinion about the working indicator, and it is not ours.**

**Also worth recording**, found while writing the converter: an assistant row does not settle on a new message id. `findChunkTarget` documents why with captured wire evidence — omp changes chunk ids mid-sentence, and keying rows on that id once split a single reply into two half tokens on a real device. A row ends at a tool call, an approval, or the end of a turn. The converter must not assume id changes are message boundaries, and the test now pins that.

Custom rendering escape hatch: `MessagePrimitive.Parts` with a children render function, plus `ToolCallMessagePartComponent` / `DataMessagePartComponent`. So `RichText`, `ToolCard`, `ApprovalCard` survive as custom renderers — we keep our components and let assistant-ui own list mechanics.

Secret safety is preserved: we already never put `title` in generic labels, and the converter is ours, so `args`/`argsText` population stays our decision.

---

## 7. Feature-gap table

| Contract | Status under assistant-ui | Notes |
| --- | --- | --- |
| Daemon is thread source of truth | **kept** | external store; no local message store |
| No AI SDK / HTTP backend | **kept** | `useExternalStoreRuntime` needs neither |
| Structured entries incl. tools/approvals | **kept** | §6 |
| #133 inline `ActivityRow` after user turn | **kept** | `MessagesFlatList` accepts `ListFooterComponent` |
| #129 shared top-history pagination | **kept, with care** | accepts `ListHeaderComponent`, `maintainVisibleContentPosition`, `onScroll`, `onContentSizeChange`, `scrollEventThrottle`, and forwards a real `FlatList` ref |
| follow-newest / anchor semantics | **conflict, resolvable** | its `autoScroll` / `scrollToBottomOn{RunStart,Initialize,ThreadSwitch}` default **true** and overlap `useFollowNewest`. Set all four `false` and keep our tested hook |
| #131 one-surface composer | **kept** | `ComposerPrimitive.{Root,Input,Send,Cancel,Attachments,AddAttachment}`; picker is consumer-supplied, which suits `react-native-image-picker` |
| Voice / dictation | **kept** | `adapters.dictation` / `speech` |
| #126/#128 loading / stalled / refusal identity | **ours, unchanged** | `isLoading` + `isDisabled`/`isSendDisabled` are hints; the identity machine stays in `console/state.ts` |
| Session context / subagents / todos | **outside the thread** | unchanged, alongside as today |
| Terminal / co-driven pane | **see §8** | |
| iPad split, safe area, keyboard, a11y | **ours** | primitives are unstyled `View`/`Pressable`/`TextInput` |

Not portable from web: RN `ThreadPrimitive` has **no** `Viewport`, `ViewportFooter` or `ScrollToBottom`; RN `ComposerPrimitive` has no `Dictate`, `AttachmentDropzone` or the `Unstable_TriggerPopover` family. Web examples cannot be copied verbatim.

---

## 8. The terminal pane: stays custom, and here is the actual reason

Jason asked for this to be proven rather than inferred, and proving it overturned two things an earlier draft of this document asserted.

**The false-affordance objection does not hold.** An earlier draft claimed assistant-ui attaches edit/reload/branch actions to every message, so feeding hint rows in would ship controls that cannot work. Measured with an adapter carrying `onNew` and nothing else, `thread.capabilities` reads:

```json
{"switchToBranch":false,"switchBranchDuringRun":false,"edit":false,"delete":false,"reload":false,
 "refetchThread":false,"cancel":false,"speech":false,"dictation":false,"voice":false,
 "unstable_copy":true,"attachments":false,"feedback":false,"queue":false}
```

Every capability is false except `unstable_copy`. **Omitting a callback really does remove the affordance.** That objection is withdrawn.

**A sibling agent's claimed blocker also does not hold.** It reported that terminal keys renumber when an older history page prepends. They do not. `logRows()` derives `key: turn:${newest - index}` with `newest = history.length - 1`, so a prepend of *k* shifts `newest` and `index` by the same *k* and every existing key is unchanged. Verified:

| | keys |
| --- | --- |
| base `[A,B,C]` | `A=turn:2  B=turn:1  C=turn:0` |
| after prepend `[Y,Z,A,B,C]` | `A=turn:2  B=turn:1  C=turn:0` — **no drift** |
| after append `[A,B,C,D]` | `A=turn:3  B=turn:2  C=turn:1` — **all three drifted** |

**The real blocker is append.** Those keys count backward from the newest, so the newest turn is always `turn:0` and **every existing row is renumbered every time a turn arrives** — which is the common case, not the rare one. Fed into assistant-ui, whose repository keys on message id, that remounts every row on every turn and strands a sibling branch per row per turn. It is the same leak §11 describes for the owned surface's rotating wire id, multiplied by the number of rows on screen.

So the one-sentence limitation, and note what it is NOT about:

> The terminal's row keys are positional and count backward from the newest turn, so every append renumbers every row; assistant-ui keys messages on that id, so the terminal cannot be represented until its keys are derived from row identity instead of position.

That is **our** key scheme, not a library limitation. The terminal is therefore migratable, behind one separable prerequisite: give `LogRow` an identity-derived key. Doing that inside this cutover would mean changing the terminal's model and its pagination anchor (`useTopHistoryPagination` compares `rows[0].key` to detect a prepend) in the same change that moves the owned surface to a new runtime. Two risky changes at once, for no user-visible gain.

**Decision: `TerminalSessionScreen` stays on its own components for this cutover.** It is a distinct live-terminal surface, not a hidden dual implementation of the owned thread: it renders a different thing (a terminal someone else owns, steered without taking ownership), and it keeps sharing `useTopHistoryPagination` and `ActivityRow` with the owned surface so there is one pagination machine and one activity row in the app, not two.

### Design note: the prerequisite for migrating the terminal

Recorded here rather than left as folklore, because the next person to look at
this will otherwise re-derive it.

**Prerequisite.** `LogRow.key` must be derived from row identity instead of
position. Today `logRows()` builds `turn:${newest - index}` where
`newest = tui.history.length - 1`, which is stable under prepend and unstable
under append.

**What a stable key would have to come from.** The served tail's own fields. A
`TranscriptTailMessage` carries `role`, `text` and `at`, so `${at}:${role}` is a
candidate, but `at` is `""` for some rows (`TerminalSessionScreen` already
special-cases that when rendering the timestamp) and two identical lines in the
same second would collide. The honest answer is that the daemon does not
currently send a per-turn id on this path, so the prerequisite is a **producer
change**: `session_tail` would need to carry one.

**What else moves when it does.** `useTopHistoryPagination` detects a prepend by
comparing `rows[0].key` against the key recorded when the request went out. That
comparison is why the current scheme's prepend-stability matters, so changing the
key space means re-proving the anchor on the terminal surface as well as the
owned one. `terminal-pagination.test.tsx` is the suite that would have to fail
first.

**Sequence, if it is ever wanted.** One: daemon sends a per-turn id on
`session_tail`. Two: `LogRow.key` uses it, with `terminal-pagination.test.tsx`
proving the anchor still holds. Three: only then a terminal external store, with
its hint rows as ordinary snapshot members, which is safe because omitting
`onEdit`/`onReload`/`onDelete` really does remove those affordances (measured:
every capability false except `unstable_copy`).

Until step one exists, `TerminalSessionScreen` staying custom is the truthful
option, and it is not a hidden dual implementation: it renders a terminal
someone else owns, steered without taking ownership, and it shares
`useTopHistoryPagination` and `ActivityRow` with the owned surface so there is
one pagination machine and one activity row in the app.

## 9. Alpha assessment

Treat as alpha. Every measurable signal says so:

- `0.1.38`; the package has **never left `0.1.x`**. 37 versions in 181 days, one release every ~5 days.
- Single `latest` dist-tag; no `next`/`beta` channel.
- **29 of 219** public exports carry `unstable_`/`Unstable_` (13%). Core: 25 of 230 (11%).
- **6 `@deprecated` tags in the RN package**, and they are not peripheral: `ThreadPrimitive.Empty`, `ThreadPrimitive.If`, `MessagePrimitive.If`, `ThreadPrimitive.Messages`, `ThreadMessagesProps`, and the `components` prop. The conditional-rendering primitives and the message list have **already been replaced once inside the 0.1 line**. Core carries 91 `@deprecated` tags.
- **No CHANGELOG, no versioning policy, no stability statement** in either tarball.
- Sharpest signal: core's README says *"Most users do not install `@assistant-ui/core` directly"* and frames the package as existing for integration libraries. Our architecture requires exactly that import.

macOS/Windows: **not unsupported, and no native surface at all.** The package ships no podspec, no `android/`, `ios/`, `windows/`, `macos/`, no `react-native.config.js`, and no platform-suffixed files. The only platform branch is `Platform.OS` in `ComposerInput.js` (4 uses, web-vs-native textarea sizing and Enter-to-submit). Metro bundles succeeded for **ios, android, macos and windows**. What that does not prove is that the out-of-tree host projects build; the Windows autolinking probe shells out to `dotnet.exe`, absent on this macOS host.

**Consequence for adoption:** wrap the consumed surface behind one thin module of ours (`packages/app/src/assistant/`) so a rename lands in one file, and read the diff on every bump.

---

## 10. Rollout

**Phase 1 — adapter + owned thread, behind a branch.**
`packages/app/src/assistant/`: `OmpAssistantRuntimeAdapter` (SessionState → `ThreadMessageLike`), `useOmpAssistantRuntime`, and custom renderers delegating to existing `RichText`/`ToolCard`/`ApprovalCard`. Owned `SessionScreen` renders `AssistantRuntimeProvider` + `MessagesFlatList` (auto-scroll off) + our `ListHeaderComponent`/`ListFooterComponent`. Terminal untouched.

**Phase 2 — composer.** Owned composer moves to `ComposerPrimitive`, keeping the #131 visual contract exactly: ghost paperclip/mic/model, one filled emphasis control, one rounded surface.

**Phase 3 — parity gate.** Every current session-activity, composer, pagination, context and loading test adapted and still behavioural. Real iPhone/iPad simulator frames.

**Phase 4 — cutover or revert.** If phases 1-3 hold, delete the obsolete plumbing (`Transcript`'s own list wiring) and migrate every caller. Visual components survive as renderers. If they do not hold, revert the dependency; nothing else depends on it.

No dual production paths at any point: phase 1-2 live on a branch, not behind a runtime flag.

**Deletion list at cutover:** `Transcript`'s `FlatList` wiring and `renderItem` (its `EntryRow` becomes a part renderer). `useTopHistoryPagination` and `useFollowNewest` **stay** — they are passed to the primitive. `ActivityRow` stays. `Composer.tsx` shrinks to a `ComposerPrimitive` composition.

---

## 11. Tests

Adapter, mutation-proven (each must fail before the fix):
- identity: session A's entries never convert into session B's thread; a late frame for A cannot land on B.
- streaming: a token updates exactly one message, `status.type === "running"`, and referential caching means untouched entries do not re-convert.
- tools: kind/status/args/result/isError round-trip; **no tool `title` in any generic label**; secret-bearing args never in an announcement.
- approvals: pending → answered folds onto the tool-call part; `allow`/`deny`/`always` reach `OmpdClient.decide`.
- attachments: picker → `PendingAttachment` → `CompleteAttachment` → sent part.
- abort: `onCancel` reaches `OmpdClient.cancel`; the trailing user message survives per our contract.
- pagination: prepend keeps the anchor; cursor dedup; manual retry.

Composition, asserting the real library renders (not wrapper source text):
- the mounted tree contains assistant-ui's own rendered output — RNW `css-text-*` / `css-textinput-*` nodes for supplied message ids, and a control id never supplied is absent. The compat probe already demonstrated this shape passes.

Dependency guards:
- exactly one copy each of `@assistant-ui/store` and `@assistant-ui/core`.
- our core pin satisfies the RN package's declared range.
- `assistant-cloud` present (a check that fails if someone removes it, since bun and tsc will not).

## 11a. Cutover status

Branch `feat/assistant-ui-proof`, off `1efcdd4`. **The owned session is cut over.** `SessionScreen` renders `OmpThreadProvider` + `OmpThreadList` + `OmpComposer`; `components/Transcript.tsx` is **deleted**; `components/Composer.tsx` survives only for the live-terminal surface.

**Proven**

- **896 app tests, 1584 root tests** (14 skipped), types clean, `biome check .` clean across 456 files, dependency gate clean.
- Every previously existing suite now drives the production path, not a dead component. `transcript-pagination.test.tsx` (the #129 proof, 21 tests) was retargeted from `Transcript` to `OmpThreadProvider` + `OmpThreadList` and still asserts request identity, the prepend anchor, list configuration and follow-newest composition. `rich-text`, `composer-submit` and `no-hidden-content` now target `OmpEntryRow`.
- `assistant-cutover.test.tsx` asserts the screen mounts the provider, the primitive list and the primitive composer; that **no** `components/Transcript` import or `<Transcript>` element survives anywhere in `src`; that the owned screen does not render the terminal's composer; and that the terminal surface renders no assistant-ui thread. Each absence is paired with a presence in the same file.
- The composition tests discriminate, re-measured at review. Swapping the primitives for plain `FlatList`/`View`/`TextInput`/`Pressable` with identical testIDs, every testID kept, fails **8** tests across the app suite: two in `assistant-adapter.test.tsx` (the runtime-driven gating of send and the interrupt, and a real dispatch round trip), five in `assistant-composer.test.tsx`, and one agent-hub case that opens a session. What a lookalike cannot fake is the runtime holding and dispatching through those controls, so the failures cluster there.
- Metro bundles the real entry (`index.js`) for **ios, android, macos, windows**: 4,518,588 / 4,520,931 / 4,483,130 / 4,475,807 bytes.
- `bun run build:web` is **green**: 1,155 modules, `dist/assets/index-*.js` 1,240.10 kB / 379.55 kB gzip. It was red before #139, which landed on `main` and fixed the `react-native-qrcode-svg` untranspiled-JSX resolution; the scoped `vite.aui.config.ts` build that existed only to work around that red is deleted, because the full build now covers strictly more.

**Two defects the cutover itself surfaced**

- **A thought and a reply sharing a wire message id collided.** `transcriptRowKey` discriminates the channel; my converter keyed on `rowId` alone, so one silently won and a thought row vanished. Caught by an existing `nav-shell` assertion. Fixed with `messageRowId(entry)`, which is `transcriptRowKey`'s derivation whole — kind prefix included — with `rowId` in place of the rotating wire id, so two entries of different kinds sharing an id cannot collide either.
- **A subagent could not be steered mid-turn.** Under #131's one-emphasis contract the interrupt replaces send while a turn is in flight, and the old composer showed send regardless because it read only the roster. The store derives `isRunning` from roster, streaming entry and running tools, which is more truthful; the test now settles the turn through the roster transition that `applyAgents` uses to call `endTurn`.

**The cloud hazard is removed, not merely detected**

- `metro.config.cjs` and `vite.config.ts` redirect `@assistant-ui/core`'s cloud subtree to `stubs/assistant-ui-cloud.js`. Measured on the real entry: **zero** occurrences of `NEXT_PUBLIC_ASSISTANT_BASE_URL` and zero of `new AssistantCloud` in the ios, android, macos, windows and web outputs. The only residue is the re-export *name* `useAssistantCloudThreadHistoryAdapter`, five string occurrences per native bundle, all of them the stub's own export and its refusal message.
- `scripts/assistant-cloud-env.cjs` is a second, opposite-direction guard, called from Metro config, Vite config and the bun test preload. All three refuse with the real message, verified by setting the variable in a child process.
- The stub throws rather than no-ops, so a caller asking for a cloud capability fails where the mistake is.

**Rendered proof**

Nine frames through `packages/app/test/render-frames.tsx`, which drives the real `Console` over a canned socket, so the props reaching `SessionScreen` are built by production code rather than by the harness. Three frames are new here: `iphone-owned-approval`, `ipad-owned-approval` and `iphone-owned-loading`.

Measured in the browser, every frame: **`scrollHeight - height === 0`**, so nothing clips, and **exactly one emphasis control** — `composer-cancel` in all seven busy frames, `composer-send` in the idle one, and none at all while loading. That is #131's contract holding on the production surface, measured rather than asserted from source.

| frame | list | composer | notable |
| --- | --- | --- | --- |
| iphone-owned-working | 156–583 | 642–836 | tool card + activity row at 256 |
| iphone-owned-approval | 156–581 | 642–836 | clearance card 182–362, activity row 366 |
| iphone-owned-idle | 156–583 | 642–836 | no activity row, send not interrupt |
| iphone-owned-loading | — | — | load state owns 111–751; no list, no composer |
| ipad-owned-working | 385–1137 (w 614) | 1196–1358 | bay 0–410, detail 410–1024 |
| ipad-owned-approval | 385–1135 (w 614) | 1196–1358 | clearance card 411–591 |

Looked at, not just measured: the approval card renders CLEARANCE / `bash` / the command payload / Allow, Reject, Always, with the activity row below it and `holding 1` in the readout. The loading frame carries the agent's identity in the header and nothing else, so a late frame from a previous session has no pane to land in. The iPad frame shows the session-context panel expanded with todos, model, directory and clearance count, beside the same clearance card.

One harness artifact worth stating: the standalone HTML loads no webfont, so the frames render in the browser's serif fallback. The app ships its own stack; the geometry is real, the typeface in these pictures is not.

**Found at review, and fixed here**

- **The empty transcript state was dropped.** `Transcript` carried `ListEmptyComponent={<Empty />}`; the cutover shipped no empty slot, so a session with no rows was a blank pane. Nothing caught it: every row assertion passes when no row is expected. Restored on `OmpThreadList`, with a test that pairs its presence on an idle empty session against its absence once a row exists.
- **The composer displayed the approve-scope refusal as a send refusal.** `OmpComposer` gained a `refusal` prop the old `Composer` never had, and `SessionScreen` filled it from `ConsoleState.refusal`, which is the daemon's approve verdict. A device holding prompt scope and not approve scope read "Sign this from a device holding the approve scope" under a send control that worked. The composer now receives only the refusals that actually hold its send — a missing prompt scope, a clearance still waiting — which are exactly the two `isSendDisabled` derives from; the approve verdict stays with `PlanCard` and `ApprovalCard`.
- **Half the settlement fix had no coverage.** Reverting the `applyAgents` relaxation on its own failed **zero** of 890 tests, because the existing regression case delivers the roster before the replayed updates and the update-frame path settles it. The path only that half covers is a dropped roster snapshot between `busy` and `idle`: `rosterMisses` tolerates one miss, and a snapshot omitting the agent clears the remembered `busy`. That case is now a test, and it fails when the relaxation is reverted.
- **An unknown prompt scope silently retired the send.** The store held it on `promptAccess !== "granted"`, and `PromptScopeAccess` is three-way precisely so that it does not: a pairing that predates scopes reports `unknown`, and only `missing` is a refusal. The shipped `Composer` gated on `connection === "connected"` alone, so such a device could send until this branch; after it, send was dead with nothing on screen saying why, while the microphone beside it — which already reads `missing` — stayed pressable. Now `promptAccess === "missing"`, with a test that types into the runtime-controlled field and fails against the old gate.

**Not done**

- No **hardware** pass for attachment pick through the real photo picker, or top pagination against a session with a paged cursor. Both are covered by suites; neither has a device observation. The iPhone 17 / iOS 26.5 simulator pass covers open, transcript, tool cards, session context, send, cancel mid-stream and session switch, plus an iPad Pro 13-inch split-layout frame.
- Terminal migration, deliberately, per §8 and its design note.

---

## 12. Smallest prerequisite decision

If the answer to §1 is no, nothing here is wasted: the compatibility proof stands on its own and the probe worktree can be deleted.

If yes, the one prerequisite before any UI work is **declaring `assistant-cloud` and `@assistant-ui/core` as literal direct dependencies**, plus the single-copy CI guard. Without those, the tree builds green in bun and `tsc` and fails in both bundlers.
