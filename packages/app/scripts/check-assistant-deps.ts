#!/usr/bin/env bun
/**
 * The dependency gate for assistant-ui.
 *
 * `@assistant-ui/*` is pre-1.0 and the app depends on `@assistant-ui/core`
 * directly, which its own README advises against. That is a considered choice
 * (see `src/assistant/runtime.ts`), and this script is the price of it: four
 * hazards that this repo's normal gates are all blind to, checked before they
 * reach a device.
 *
 * Each hazard below has been reproduced, not imagined.
 *
 * 1. `assistant-cloud` goes missing from `packages/app/package.json`.
 *    It is an OPTIONAL peer of `@assistant-ui/core`, and core imports it
 *    unconditionally anyway. `bun install` says nothing, because an optional
 *    peer is allowed to be absent. `tsc --noEmit` says nothing, because
 *    `skipLibCheck` is on. Metro and Vite both hard-fail at bundle time, which
 *    is the first moment anyone finds out.
 *
 * 2. A second copy of `@assistant-ui/core` or `@assistant-ui/store` lands on
 *    disk. `store` holds the module-level React context that links
 *    `AssistantRuntimeProvider` to every primitive underneath it; two copies
 *    means the provider writes to one context and the primitives read the
 *    other, and the failure is a silently empty thread rather than an error.
 *    `metro.config.cjs` sets `disableHierarchicalLookup: true`, so Metro never
 *    even walks up to a nested copy: it serves the hoisted one, the nested one
 *    is dead weight nobody sees, and the two builds disagree about which
 *    version shipped.
 *
 * 3. React doubles up, or `react-native` does. The app is deliberately pinned
 *    to React 19.1.4 to match RN 0.81.6's embedded renderer while the workspace
 *    catalog is on the same pin; one known nested copy already exists under
 *    `@oh-my-pi/omp-stats` and is tolerated by name. Anything beyond it is the
 *    "Incompatible React versions" redbox waiting to happen.
 *
 * 4. Our declared `@assistant-ui/core` pin drifts out of the range
 *    `@assistant-ui/react-native` declares for it. Because we pin core
 *    literally and the library declares a caret, bumping one without the other
 *    resolves cleanly and produces a runtime built by one version of core
 *    driving primitives compiled against another.
 *
 * A fifth check compares what is installed against `ASSISTANT_UI_PINS`. That
 * assertion belongs here rather than in `runtime.ts` because six of the seven
 * packages omit `./package.json` from their `exports` map: Metro resolves it
 * anyway with a warning per package, but Vite refuses outright with
 * `Missing "./package.json" specifier`, so shipping the read would break the
 * web build. Node has no such objection, and neither does this script.
 *
 * Copies are enumerated by walking `node_modules` rather than by parsing
 * `bun pm ls`, because that output is a rendered tree: it dedupes, it elides,
 * and it is not a contract. The filesystem is.
 */

import { type Dirent, existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ASSISTANT_UI_PINS } from "../src/assistant/runtime.ts";

/** One installed package directory, as found on disk. */
export interface PackageCopy {
  /** The package name, scope included. */
  name: string;
  /** Its declared version, or `null` when the manifest has none. */
  version: string | null;
  /** Repo-relative, POSIX-separated, e.g. `node_modules/@assistant-ui/core`. */
  path: string;
}

/** Everything the checks read, as plain data so they can be driven by a test. */
export interface DependencyFacts {
  /** `dependencies` from `packages/app/package.json`. */
  appDependencies: Readonly<Record<string, string>>;
  /** `dependencies` from the installed `@assistant-ui/react-native` manifest. */
  libraryDependencies: Readonly<Record<string, string>>;
  /** Every package directory found under every `node_modules` in the repo. */
  copies: readonly PackageCopy[];
}

/**
 * The one nested React that predates this work and is not ours to remove.
 * `@oh-my-pi/omp-stats` vendors its own React 19.2.7; nothing in the app graph
 * reaches it, and Metro's `disableHierarchicalLookup` guarantees that stays
 * true. Named rather than counted so a SECOND nested copy still fails.
 */
export const TOLERATED_NESTED_REACT = "node_modules/@oh-my-pi/omp-stats/node_modules/react";

/**
 * Packages that must exist exactly once. Not the full pin list: `zustand` and
 * `assistant-stream` are plain data and a duplicate is merely wasteful, while
 * these two carry module-level identity that a duplicate silently severs.
 */
export const ASSISTANT_UI_SINGLETONS = ["@assistant-ui/core", "@assistant-ui/store"] as const;

/** `readdirSync` with entry types, treating an unreadable directory as empty. */
function entriesOf(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * A manifest's `version`, narrowed rather than asserted. A package.json is
 * outside-controlled data: nothing guarantees the field exists or is a string.
 */
function versionOf(manifest: unknown): string | null {
  if (manifest === null || typeof manifest !== "object" || !("version" in manifest)) return null;
  return typeof manifest.version === "string" ? manifest.version : null;
}

/** A manifest's `dependencies`, keeping only the entries that are real ranges. */
function dependenciesOf(manifest: unknown): Record<string, string> {
  if (manifest === null || typeof manifest !== "object" || !("dependencies" in manifest)) return {};
  const declared = manifest.dependencies;
  if (declared === null || typeof declared !== "object") return {};
  const ranges: Record<string, string> = {};
  for (const [name, range] of Object.entries(declared)) {
    if (typeof range === "string") ranges[name] = range;
  }
  return ranges;
}

/** Parse a manifest off disk, or `null` when it is absent or malformed. */
function readManifest(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Every package directory reachable from a set of `node_modules` roots.
 *
 * Both sets are keyed by REAL path, and that is what makes the walk honest in
 * a bun workspace. bun links `node_modules/@ompd/app` at `packages/app`, so
 * `packages/app/node_modules/typescript` is reachable by two routes. Keying
 * `directories` by real path stops the walk recursing forever through that
 * link; keying `physical` by real path stops one copy on disk being counted as
 * two because two routes reached it, which would fail the singleton checks on
 * a healthy tree.
 */
interface WalkState {
  /** `node_modules` directories already descended into. */
  directories: Set<string>;
  /** Package directories already recorded. */
  physical: Set<string>;
}

function scanNodeModules(dir: string, repoRoot: string, state: WalkState, out: PackageCopy[]): void {
  const real = realPathOr(dir);
  if (real === null || state.directories.has(real)) return;
  state.directories.add(real);

  for (const entry of entriesOf(dir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith(".")) continue;
    const child = join(dir, entry.name);
    if (!entry.name.startsWith("@")) {
      recordPackage(entry.name, child, repoRoot, state, out);
      continue;
    }
    // A scope directory holds packages, not a package.
    for (const inner of entriesOf(child)) {
      if (!inner.isDirectory() && !inner.isSymbolicLink()) continue;
      recordPackage(`${entry.name}/${inner.name}`, join(child, inner.name), repoRoot, state, out);
    }
  }
}

function recordPackage(name: string, dir: string, repoRoot: string, state: WalkState, out: PackageCopy[]): void {
  // The canonical location, not the route taken to it. A copy reported as
  // `node_modules/@ompd/app/node_modules/typescript` reads as a nested
  // dependency of a published package; the same copy reported as
  // `packages/app/node_modules/typescript` reads as what it is. Path-based
  // tolerance (see TOLERATED_NESTED_REACT) also has to be route-independent,
  // or the same physical copy is excused down one path and not the other.
  const real = realPathOr(dir);
  const manifestPath = join(dir, "package.json");
  if (real !== null && !state.physical.has(real) && existsSync(manifestPath)) {
    state.physical.add(real);
    out.push({
      name,
      version: versionOf(readManifest(manifestPath)),
      path: relative(repoRoot, real).split("\\").join("/"),
    });
  }
  const nested = join(dir, "node_modules");
  if (existsSync(nested)) scanNodeModules(nested, repoRoot, state, out);
}

function realPathOr(dir: string): string | null {
  try {
    return realpathSync(dir);
  } catch {
    return null;
  }
}

/** Read the manifests and walk the tree. The only part that touches disk. */
export function collectFacts(repoRoot: string): DependencyFacts {
  // Both sides of every `relative()` below have to be physical. Package
  // directories are canonicalised on the way in, so if the root stayed logical
  // the two spellings would disagree and every reported path would climb out
  // of the repo: on macOS a checkout under `/tmp` or `/var` is a symlink to
  // `/private/...`, and paths came back as
  // `../../../../private/var/.../node_modules/react`. That is not cosmetic.
  // `TOLERATED_NESTED_REACT` is matched by path, so the known-good nested React
  // stops being recognised and the gate fails on a healthy tree. Agent
  // worktrees live under `/tmp` routinely; `scripts/check-types.test.ts`
  // records the same defect eating a whole type gate.
  const root = realPathOr(repoRoot) ?? repoRoot;

  const appDependencies = dependenciesOf(readManifest(join(root, "packages/app/package.json")));
  const libraryDependencies = dependenciesOf(
    readManifest(join(root, "node_modules/@assistant-ui/react-native/package.json")),
  );

  // Workspace package roots before the hoisted root, so a package-local copy
  // is reached by its own path rather than through the workspace symlink that
  // bun installs in `node_modules`.
  const roots: string[] = [];
  for (const entry of entriesOf(join(root, "packages"))) {
    if (!entry.isDirectory()) continue;
    roots.push(join(root, "packages", entry.name, "node_modules"));
  }
  roots.push(join(root, "node_modules"));

  const copies: PackageCopy[] = [];
  const state: WalkState = { directories: new Set(), physical: new Set() };
  for (const nodeModules of roots) {
    if (existsSync(nodeModules)) scanNodeModules(nodeModules, root, state, copies);
  }

  return { appDependencies, libraryDependencies, copies };
}

// ---------------------------------------------------------------------------
// The checks. Each takes plain facts and returns the failures it found, so a
// test can drive it with a tree that does not exist.
// ---------------------------------------------------------------------------

/** Hazard 1: core's unconditional import of its own optional peer. */
export function checkCloudPeerDeclared(facts: DependencyFacts): string[] {
  if (Object.hasOwn(facts.appDependencies, "assistant-cloud")) return [];
  return [
    "assistant-cloud is not in packages/app/package.json dependencies. " +
      "@assistant-ui/core declares it an OPTIONAL peer and then imports it unconditionally, so bun install and " +
      "tsc --noEmit both stay silent while Metro and Vite fail at bundle time. " +
      `Add it back at a literal pin: "assistant-cloud": "${ASSISTANT_UI_PINS["assistant-cloud"]}".`,
  ];
}

/** Hazard 2: a duplicate of a package whose React context must be a singleton. */
export function checkAssistantUiSingletons(facts: DependencyFacts): string[] {
  const failures: string[] = [];
  for (const name of ASSISTANT_UI_SINGLETONS) {
    const found = facts.copies.filter(copy => copy.name === name);
    if (found.length <= 1) continue;
    failures.push(
      `${name} is installed ${found.length} times: ${describe(found)}. ` +
        "It holds module-level React context, so a second copy severs the link between AssistantRuntimeProvider " +
        "and the primitives and renders an empty thread with no error. metro.config.cjs sets " +
        "disableHierarchicalLookup: true, so Metro serves the hoisted copy and never warns about the nested one. " +
        "Dedupe to a single hoisted copy.",
    );
  }
  return failures;
}

/** Hazard 3: two renderers, or two React Natives. */
export function checkReactSingletons(facts: DependencyFacts): string[] {
  const failures: string[] = [];

  const reacts = facts.copies.filter(copy => copy.name === "react");
  const unexpected = reacts.filter(copy => copy.path !== TOLERATED_NESTED_REACT);
  if (unexpected.length !== 1) {
    failures.push(
      `Expected exactly one react copy outside ${TOLERATED_NESTED_REACT}, found ${unexpected.length}: ` +
        `${describe(unexpected)}. The app is pinned to React 19.1.4 to match React Native 0.81.6's embedded ` +
        'renderer; a second copy in the app graph is the "Incompatible React versions" redbox.',
    );
  }

  const natives = facts.copies.filter(copy => copy.name === "react-native");
  if (natives.length !== 1) {
    failures.push(
      `Expected exactly one react-native copy, found ${natives.length}: ${describe(natives)}. ` +
        "Two copies means two TurboModule registries and two renderers.",
    );
  }

  return failures;
}

/** Hazard 4: our literal core pin drifting out of the library's caret. */
export function checkCoreRangeAgreement(facts: DependencyFacts): string[] {
  const declared = facts.appDependencies["@assistant-ui/core"];
  const range = facts.libraryDependencies["@assistant-ui/core"];
  if (declared === undefined) {
    return [
      "@assistant-ui/core is not in packages/app/package.json dependencies, but src/assistant/runtime.ts imports " +
        "useExternalStoreRuntime from it. Declare it at a literal pin.",
    ];
  }
  if (range === undefined) {
    return [
      "@assistant-ui/react-native does not declare a dependency on @assistant-ui/core. That is a shape change in " +
        "the library; re-derive the boundary in src/assistant/runtime.ts before trusting this gate.",
    ];
  }
  if (Bun.semver.satisfies(declared, range)) return [];
  return [
    `packages/app pins @assistant-ui/core at ${declared}, which does not satisfy ${range}, the range ` +
      "@assistant-ui/react-native declares for it. Both resolve, and the result is a runtime built by one core " +
      "driving primitives compiled against another. Move both pins together.",
  ];
}

/** The pin table in `src/assistant/runtime.ts`, against what is on disk. */
export function checkPinnedVersions(facts: DependencyFacts): string[] {
  const failures: string[] = [];
  for (const [name, expected] of Object.entries(ASSISTANT_UI_PINS)) {
    const found = facts.copies.filter(copy => copy.name === name);
    const first = found[0];
    if (first === undefined) {
      failures.push(`${name} is pinned at ${expected} in src/assistant/runtime.ts but is not installed at all.`);
      continue;
    }
    for (const copy of found) {
      if (copy.version === expected) continue;
      failures.push(
        `${name} is ${copy.version ?? "unversioned"} at ${copy.path}, but src/assistant/runtime.ts pins ` +
          `${expected}. Upstream churn arrives here first: review the change against that file, then move the pin.`,
      );
    }
  }
  return failures;
}

/** Every check, in the order a reader would want them. */
export function runChecks(facts: DependencyFacts): string[] {
  return [
    ...checkCloudPeerDeclared(facts),
    ...checkAssistantUiSingletons(facts),
    ...checkReactSingletons(facts),
    ...checkCoreRangeAgreement(facts),
    ...checkPinnedVersions(facts),
  ];
}

function describe(copies: readonly PackageCopy[]): string {
  if (copies.length === 0) return "none";
  return copies.map(copy => `${copy.version ?? "unversioned"} at ${copy.path}`).join(", ");
}

/** `packages/app/scripts` -> the repo root. */
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

// Guarded so the test can import the checks without running the gate, and
// without paying for a full node_modules walk per import.
if (import.meta.main) {
  const failures = runChecks(collectFacts(REPO_ROOT));
  if (failures.length === 0) {
    console.log("assistant-ui dependency gate: clean");
  } else {
    for (const failure of failures) console.error(`assistant-ui dependency gate: ${failure}`);
    process.exit(1);
  }
}
