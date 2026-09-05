/**
 * The assistant-ui dependency gate, run in CI and proven able to fail.
 *
 * Two halves, and both are load-bearing.
 *
 * The first half points the real checks at the real tree, so the four hazards
 * `scripts/check-assistant-deps.ts` describes are gated by `bun test` rather
 * than by somebody remembering to run a script.
 *
 * The second half proves each check can actually fail. A gate that has never
 * been seen to fail is not evidence of anything, and this one is easy to get
 * wrong: a filter over a package list that silently matches nothing reports a
 * clean tree in exactly the same way a healthy tree does. So every failure case
 * starts from `HEALTHY`, which is asserted to produce no failures at all, and
 * changes exactly one thing. That is what makes each case attributable: the
 * mutation is the only candidate cause.
 *
 * Synthetic facts rather than a mutated `node_modules`. The checks take plain
 * data on purpose, and a test that installs a second copy of React into a live
 * workspace to watch a gate fire would be a worse test and a worse neighbour.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSISTANT_UI_SINGLETONS,
  checkAssistantUiSingletons,
  checkCloudPeerDeclared,
  checkCoreRangeAgreement,
  checkPinnedVersions,
  checkReactSingletons,
  collectFacts,
  type DependencyFacts,
  type PackageCopy,
  REPO_ROOT,
  runChecks,
  TOLERATED_NESTED_REACT,
} from "../scripts/check-assistant-deps.ts";
import { ASSISTANT_UI_PINS } from "../src/assistant/runtime.ts";

/** The real tree, walked once. The whole scan is well under a second. */
const actual = collectFacts(REPO_ROOT);

/**
 * A tree with nothing wrong with it, as the baseline every failure case
 * departs from by exactly one edit.
 */
const HEALTHY: DependencyFacts = {
  appDependencies: { "@assistant-ui/core": ASSISTANT_UI_PINS["@assistant-ui/core"], "assistant-cloud": "0.1.41" },
  libraryDependencies: { "@assistant-ui/core": "^0.3.15" },
  copies: [
    ...Object.entries(ASSISTANT_UI_PINS).map(([name, version]) => ({ name, version, path: `node_modules/${name}` })),
    { name: "react", version: "19.1.4", path: "node_modules/react" },
    { name: "react", version: "19.2.7", path: TOLERATED_NESTED_REACT },
    { name: "react-native", version: "0.81.6", path: "node_modules/react-native" },
  ],
};

function withCopies(extra: readonly PackageCopy[]): DependencyFacts {
  return { ...HEALTHY, copies: [...HEALTHY.copies, ...extra] };
}

describe("assistant-ui dependency gate, against the real tree", () => {
  test("the tree passes every check", () => {
    expect(runChecks(actual)).toEqual([]);
  });

  test("the walk actually found the packages, so a clean result means something", () => {
    // A filter that matches nothing produces the same empty failure list as a
    // healthy tree. This is the assertion that tells the two apart.
    expect(actual.copies.length).toBeGreaterThan(100);
    for (const name of Object.keys(ASSISTANT_UI_PINS)) {
      expect(actual.copies.filter(copy => copy.name === name)).toHaveLength(1);
    }
    expect(actual.copies.filter(copy => copy.name === "react-native")).toHaveLength(1);
  });

  test("the walk reaches nested node_modules, or a duplicate could hide in one", () => {
    // The whole point of the singleton checks is finding a copy somewhere
    // other than the hoisted root. A walker that never descended would report
    // exactly one of everything and look perfectly healthy.
    const nested = actual.copies.filter(copy => copy.path.split("node_modules/").length > 2);
    expect(nested.length).toBeGreaterThan(0);
    expect(actual.copies.map(copy => copy.path)).toContain(TOLERATED_NESTED_REACT);
  });

  test("the walk reaches workspace-package node_modules too", () => {
    // `packages/app/node_modules` is a separate root from the hoisted one, and
    // it is exactly where a nested @assistant-ui copy would land.
    expect(actual.copies.map(copy => copy.path)).toContain("packages/app/node_modules/typescript");
  });

  test("copies are reported by canonical path, not by the route that found them", () => {
    // bun links `node_modules/@ompd/app` at `packages/app`, so every
    // package-local copy is reachable twice. Reporting the symlink route would
    // make path-based tolerance depend on walk order, and deduping by route
    // rather than by real path would count one copy as two.
    for (const copy of actual.copies) {
      expect(copy.path).not.toContain("@ompd/");
    }
    const byPath = new Set(actual.copies.map(copy => copy.path));
    expect(byPath.size).toBe(actual.copies.length);
  });

  test("assistant-cloud is declared, because core imports its own optional peer", () => {
    // bun install and `tsc --noEmit` are both silent when this is missing;
    // Metro and Vite are not.
    expect(actual.appDependencies["assistant-cloud"]).toBe(ASSISTANT_UI_PINS["assistant-cloud"]);
  });

  test("every assistant-ui pin is literal, never a caret", () => {
    for (const name of ["@assistant-ui/core", "@assistant-ui/react-native", "assistant-cloud"]) {
      const declared = actual.appDependencies[name];
      expect(declared).toBeDefined();
      expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  test("the installed versions match ASSISTANT_UI_PINS", () => {
    const installed: Record<string, string | null> = {};
    for (const name of Object.keys(ASSISTANT_UI_PINS)) {
      installed[name] = actual.copies.find(copy => copy.name === name)?.version ?? null;
    }
    expect(installed).toEqual({ ...ASSISTANT_UI_PINS });
  });

  test("the only nested react is the tolerated one", () => {
    const reacts = actual.copies.filter(copy => copy.name === "react").map(copy => copy.path);
    expect(reacts.toSorted()).toEqual(["node_modules/react", TOLERATED_NESTED_REACT].toSorted());
  });
});

describe("each check can fail", () => {
  test("the baseline is genuinely healthy, so every mutation below is the sole cause", () => {
    expect(runChecks(HEALTHY)).toEqual([]);
  });

  test("assistant-cloud missing from the app's dependencies", () => {
    const { "assistant-cloud": _dropped, ...withoutCloud } = HEALTHY.appDependencies;
    const failures = checkCloudPeerDeclared({ ...HEALTHY, appDependencies: withoutCloud });
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("assistant-cloud is not in packages/app/package.json");
  });

  test("a second copy of @assistant-ui/store, the one holding the React context", () => {
    const failures = checkAssistantUiSingletons(
      withCopies([
        { name: "@assistant-ui/store", version: "0.3.9", path: "packages/app/node_modules/@assistant-ui/store" },
      ]),
    );
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("@assistant-ui/store is installed 2 times");
    expect(failures.join("\n")).toContain("packages/app/node_modules/@assistant-ui/store");
  });

  test("a second copy of @assistant-ui/core", () => {
    const failures = checkAssistantUiSingletons(
      withCopies([
        { name: "@assistant-ui/core", version: "0.3.16", path: "packages/other/node_modules/@assistant-ui/core" },
      ]),
    );
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("@assistant-ui/core is installed 2 times");
  });

  test("both singletons doubled produce one failure each", () => {
    const failures = checkAssistantUiSingletons(
      withCopies(
        ASSISTANT_UI_SINGLETONS.map(name => ({ name, version: "9.9.9", path: `packages/other/node_modules/${name}` })),
      ),
    );
    expect(failures).toHaveLength(ASSISTANT_UI_SINGLETONS.length);
  });

  test("a second react anywhere other than the tolerated path", () => {
    const failures = checkReactSingletons(
      withCopies([{ name: "react", version: "19.2.7", path: "packages/app/node_modules/react" }]),
    );
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("Expected exactly one react copy");
    expect(failures.join("\n")).toContain("packages/app/node_modules/react");
  });

  test("the tolerance is by path, so the same version at another path still fails", () => {
    // Tolerating by count, or by version, would let a genuinely dangerous
    // nested copy through as long as it looked like the known one.
    const failures = checkReactSingletons(
      withCopies([{ name: "react", version: "19.2.7", path: "node_modules/@somebody/else/node_modules/react" }]),
    );
    expect(failures.join("\n")).toContain("@somebody/else");
  });

  test("no react at all", () => {
    const failures = checkReactSingletons({
      ...HEALTHY,
      copies: HEALTHY.copies.filter(copy => copy.name !== "react"),
    });
    expect(failures.join("\n")).toContain("found 0");
  });

  test("a second react-native", () => {
    const failures = checkReactSingletons(
      withCopies([{ name: "react-native", version: "0.81.9", path: "packages/app/node_modules/react-native" }]),
    );
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("Expected exactly one react-native copy, found 2");
  });

  test("our core pin outside the range the library declares", () => {
    const failures = checkCoreRangeAgreement({
      ...HEALTHY,
      appDependencies: { ...HEALTHY.appDependencies, "@assistant-ui/core": "0.4.0" },
    });
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("0.4.0");
    expect(failures.join("\n")).toContain("^0.3.15");
  });

  test("a patch bump inside the library's caret is not a failure", () => {
    // The check must not fire on the legitimate move, or it gets disabled.
    expect(
      checkCoreRangeAgreement({
        ...HEALTHY,
        appDependencies: { ...HEALTHY.appDependencies, "@assistant-ui/core": "0.3.20" },
      }),
    ).toEqual([]);
  });

  test("core undeclared by the app", () => {
    const { "@assistant-ui/core": _dropped, ...withoutCore } = HEALTHY.appDependencies;
    const failures = checkCoreRangeAgreement({ ...HEALTHY, appDependencies: withoutCore });
    expect(failures.join("\n")).toContain("not in packages/app/package.json dependencies");
  });

  test("the library no longer depending on core at all", () => {
    const failures = checkCoreRangeAgreement({ ...HEALTHY, libraryDependencies: {} });
    expect(failures.join("\n")).toContain("does not declare a dependency on @assistant-ui/core");
  });

  test("an installed version drifting off the pin table", () => {
    const failures = checkPinnedVersions({
      ...HEALTHY,
      copies: HEALTHY.copies.map(copy => (copy.name === "@assistant-ui/core" ? { ...copy, version: "0.3.16" } : copy)),
    });
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("@assistant-ui/core is 0.3.16");
    expect(failures.join("\n")).toContain("src/assistant/runtime.ts pins 0.3.15");
  });

  test("a pinned package not installed at all", () => {
    const failures = checkPinnedVersions({
      ...HEALTHY,
      copies: HEALTHY.copies.filter(copy => copy.name !== "assistant-cloud"),
    });
    expect(failures).toHaveLength(1);
    expect(failures.join("\n")).toContain("assistant-cloud is pinned at 0.1.41");
    expect(failures.join("\n")).toContain("not installed at all");
  });

  test("runChecks reports every hazard at once rather than the first", () => {
    const { "assistant-cloud": _dropped, ...withoutCloud } = HEALTHY.appDependencies;
    const failures = runChecks({
      ...HEALTHY,
      appDependencies: withoutCloud,
      copies: [
        ...HEALTHY.copies,
        { name: "@assistant-ui/core", version: "0.3.16", path: "packages/other/node_modules/@assistant-ui/core" },
        { name: "react", version: "19.2.7", path: "packages/app/node_modules/react" },
      ],
    });
    // cloud, duplicate core, duplicate react, and the drifted duplicate's pin.
    expect(failures.length).toBeGreaterThanOrEqual(4);
  });
});

describe("why the version assertion is not in src/assistant/runtime.ts", () => {
  /**
   * The module's doc comment claims the assertion cannot ship because these
   * packages do not export `./package.json`, and Vite refuses the specifier
   * outright (`Missing "./package.json" specifier`) while Metro only warns.
   * That claim is a fact about the installed packages, so it is checked rather
   * than trusted: if upstream starts exporting the subpath, this fails and the
   * decision recorded in `runtime.ts` gets revisited instead of quietly rotting.
   */
  const UNEXPORTED = [
    "@assistant-ui/core",
    "@assistant-ui/react-native",
    "@assistant-ui/store",
    "@assistant-ui/tap",
    "assistant-stream",
    "assistant-cloud",
  ];

  function exportsOf(name: string): Record<string, unknown> {
    const manifest: unknown = JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", name, "package.json"), "utf8"));
    if (manifest === null || typeof manifest !== "object" || !("exports" in manifest)) return {};
    const field = manifest.exports;
    if (field === null || typeof field !== "object") return {};
    return { ...field };
  }

  test.each(UNEXPORTED)("%s does not export ./package.json, so Vite cannot resolve it", name => {
    expect(Object.hasOwn(exportsOf(name), "./package.json")).toBe(false);
  });

  test("zustand does export it, which is why it alone resolved under Vite", () => {
    expect(Object.hasOwn(exportsOf("zustand"), "./package.json")).toBe(true);
  });

  test("the pin table covers exactly the packages that boundary reasoning depends on", () => {
    expect(Object.keys(ASSISTANT_UI_PINS).toSorted()).toEqual([...UNEXPORTED, "zustand"].toSorted());
  });
});

/**
 * The checks above are driven by hand-built facts, which proves the predicates
 * and nothing about the walk that feeds them. `collectFacts` is the half that
 * can fail quietly: a walker that never descends into a nested `node_modules`
 * reports exactly one of everything and looks identical to a healthy tree.
 *
 * So this builds a real (tiny) repo on disk with a real duplicate in it, and
 * requires the whole pipeline to find it. The healthy case is built by the same
 * function, so a failure here is attributable to the duplicate rather than to
 * some unrelated defect in the fixture.
 */
describe("collectFacts, against a real filesystem", () => {
  function buildTree(duplicateCoreAt: string | null): string {
    const root = mkdtempSync(join(tmpdir(), "assistant-deps-"));
    const writeManifest = (dir: string, body: Record<string, unknown>): void => {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "package.json"), JSON.stringify(body));
    };

    writeManifest("packages/app", {
      name: "@ompd/app",
      dependencies: { "@assistant-ui/core": ASSISTANT_UI_PINS["@assistant-ui/core"], "assistant-cloud": "0.1.41" },
    });
    for (const [name, version] of Object.entries(ASSISTANT_UI_PINS)) {
      writeManifest(join("node_modules", name), { name, version });
    }
    writeManifest("node_modules/@assistant-ui/react-native", {
      name: "@assistant-ui/react-native",
      version: ASSISTANT_UI_PINS["@assistant-ui/react-native"],
      dependencies: { "@assistant-ui/core": "^0.3.15" },
    });
    writeManifest("node_modules/react", { name: "react", version: "19.1.4" });
    writeManifest("node_modules/react-native", { name: "react-native", version: "0.81.6" });
    writeManifest(join("node_modules", TOLERATED_NESTED_REACT.slice("node_modules/".length)), {
      name: "react",
      version: "19.2.7",
    });
    if (duplicateCoreAt !== null) {
      writeManifest(duplicateCoreAt, { name: "@assistant-ui/core", version: "0.3.15" });
    }
    return root;
  }

  test("a healthy tree on disk produces no failures", () => {
    const root = buildTree(null);
    try {
      expect(runChecks(collectFacts(root))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a duplicate core inside a workspace package's node_modules is found", () => {
    const at = "packages/app/node_modules/@assistant-ui/core";
    const root = buildTree(at);
    try {
      const failures = runChecks(collectFacts(root));
      expect(failures.join("\n")).toContain("@assistant-ui/core is installed 2 times");
      expect(failures.join("\n")).toContain(at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a duplicate core nested under another package is found", () => {
    // Metro's disableHierarchicalLookup makes this copy invisible at build
    // time, which is precisely why it has to be visible here.
    const at = "node_modules/some-package/node_modules/@assistant-ui/core";
    const root = buildTree(at);
    try {
      const failures = runChecks(collectFacts(root));
      expect(failures.join("\n")).toContain("@assistant-ui/core is installed 2 times");
      expect(failures.join("\n")).toContain(at);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a checkout reached through a symlink still reports paths inside the repo", () => {
    // Found by this suite rather than reasoned about: macOS `mkdtemp` hands
    // back `/var/...` while `realpath` resolves `/private/var/...`, so a
    // logical root against canonicalised package paths produced
    // `../../../../private/var/.../node_modules/react`. TOLERATED_NESTED_REACT
    // is matched by path, so the healthy tree failed the react check.
    //
    // An explicit symlink rather than relying on that: `/tmp` is a symlink on
    // macOS and an ordinary directory on Linux, so without this the regression
    // would only be caught on one of the two platforms CI runs.
    const parent = mkdtempSync(join(tmpdir(), "assistant-deps-link-"));
    const physical = buildTree(null);
    const through = join(parent, "link");
    symlinkSync(physical, through);
    try {
      const facts = collectFacts(through);
      expect(runChecks(facts)).toEqual([]);
      for (const copy of facts.copies) {
        expect(copy.path.startsWith("..")).toBe(false);
      }
      expect(facts.copies.map(copy => copy.path)).toContain(TOLERATED_NESTED_REACT);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(physical, { recursive: true, force: true });
    }
  });
});

describe("the gate as a command", () => {
  test("exits 0 against the real tree", async () => {
    // Bun's concurrent test harness loses this child process's pipes, but not
    // its exit status. This remains an end-to-end execution gate: a dependency
    // violation exits 1, as the tests above prove from fixture trees.
    const run = Bun.spawn({
      cmd: ["bun", join(REPO_ROOT, "packages/app/scripts/check-assistant-deps.ts")],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
  });
});
