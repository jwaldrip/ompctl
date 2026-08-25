/**
 * `@ompd/core/policy` must stay importable from a React Native bundle.
 *
 * The defect this guards against shipped and went unnoticed: the container
 * mount policy landed `import { existsSync, realpathSync } from "node:fs"` and
 * `import { isAbsolute, resolve } from "node:path"` at `policy.ts`'s module
 * scope. Metro resolves neither. The mobile app imports that exact module --
 * `packages/app/src/browser/WebViewDriver.tsx` needs `undriveableUrlReason` --
 * so `react-native bundle` began failing for ios, android, macos AND windows
 * with `Unable to resolve module node:path from packages/core/src/policy.ts`.
 *
 * Nothing caught it. The app's own CI job did not run on the merge that broke
 * it, and no test in this package knows the app exists. So the check lives
 * here, next to the code whose import list is the thing that matters, rather
 * than in the app where it would be one more red job to interpret.
 *
 * Deliberately a source-level assertion rather than an attempted import: this
 * runs under Bun, where `node:fs` resolves perfectly well, so importing the
 * module proves nothing about Metro. The import list is the actual contract.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = join(dirname(import.meta.dir), "src");

/** Every module specifier `file` imports, as written. */
function importedSpecifiers(file: string): string[] {
  const source = readFileSync(join(SRC, file), "utf8");
  const out: string[] = [];
  // Covers `import ... from "x"`, bare `import "x"`, and `export ... from "x"`.
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*"([^"]+)"/g)) {
    out.push(match[1] as string);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) {
    out.push(match[1] as string);
  }
  return out;
}

/**
 * Modules the app reaches, and the ones it reaches through them. Kept shallow
 * on purpose: these are the files whose import lists a phone's bundler has to
 * satisfy, and naming them is what makes a future addition visible here.
 */
const APP_REACHABLE = ["policy.ts", "contracts.ts", "redact.ts"];

describe("modules the mobile app imports", () => {
  for (const file of APP_REACHABLE) {
    test(`${file} imports no node: builtin`, () => {
      const builtins = importedSpecifiers(file).filter(specifier => specifier.startsWith("node:"));
      expect(builtins).toEqual([]);
    });
  }

  test("the guard can actually fail", () => {
    // Proves the matcher, not the file: a module that DOES import a builtin has
    // to be caught, or the assertions above are decoration. `mount-policy.ts`
    // is exactly that module, and it is where the filesystem policy now lives.
    const builtins = importedSpecifiers("mount-policy.ts").filter(s => s.startsWith("node:"));
    expect(builtins).toContain("node:fs");
    expect(builtins).toContain("node:path");
  });

  test("the app's own import still resolves to the clean module", () => {
    // The boundary is only useful if the symbol the app wants is on the clean
    // side of it. If `undriveableUrlReason` ever moves to `mount-policy.ts`,
    // this fails rather than the app's bundle failing.
    const policy = importedSpecifiers("policy.ts");
    expect(policy).not.toContain("./mount-policy.ts");
    const source = readFileSync(join(SRC, "policy.ts"), "utf8");
    expect(source).toContain("export function undriveableUrlReason");
  });
});
