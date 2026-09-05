/**
 * Put the `pi_natives` addon next to the compiled binary, so `dist/ompd` is a
 * thing you can copy somewhere and run.
 *
 * `bun build --compile` cannot carry a native `.node` into its single-file
 * executable. `@oh-my-pi/pi-natives` knows that and ships a loader with an
 * embedded-addon slot for exactly this case, but the slot is populated by that
 * package's own release script for omp's own binaries: in the published npm
 * package `embeddedAddon` is `null`. So a compiled `ompd` has to find the addon
 * on disk, and its loader looks in this order for a compiled binary:
 *
 *   1. `<nativesDir>/<version>/`   a copy staged by some earlier run
 *   2. `<userDataDir>/`            the same idea, one directory up
 *   3. `<package>/native/`         only meaningful from a source tree
 *   4. `dirname(process.execPath)` next to the binary
 *
 * Only the fourth is a property of the artifact. The first two are a property of
 * the machine, which is why this went unnoticed: a workstation that has ever run
 * omp already has `~/.omp/natives/<version>/pi_natives.<platform>.node`, so the
 * binary works there and nowhere else. A fresh CI checkout has no staged copy,
 * and the compiled binary cannot reach `node_modules` to make one, because
 * `createRequire(import.meta.url)` inside a compiled binary has no source tree to
 * resolve from. That is the whole bug: `dist/ompd` was never self-contained, and
 * the only reason anyone could run it was an ambient file nobody put there on
 * purpose.
 *
 * So the build copies the addon to candidate four. Refusing rather than warning
 * when it cannot: a binary that builds and then dies on its first start is worse
 * than a build that stops and says which file it wanted.
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";

const require_ = createRequire(import.meta.url);

/** Where `build:cli` puts the binary. Both live in the same directory or neither works. */
const targetArg = process.argv[2];
const outDir = targetArg
  ? existsSync(targetArg) && statSync(targetArg).isDirectory()
    ? resolve(targetArg)
    : dirname(resolve(targetArg))
  : join(import.meta.dir, "..", "dist");

/**
 * The addon filename the loader will look for, built the way the loader builds
 * it: platform tag plus architecture. Read from the leaf package rather than
 * assembled from a template, so a package that renames its file is a build
 * failure here rather than a runtime failure in the field.
 */
function addonSource(): string {
  // The leaf package is an optional dependency selected by `os` and `cpu`, so on
  // any given machine exactly one of them is installed. Resolving through its
  // own `package.json` is what makes this work without hardcoding the platform.
  const tag = `${process.platform}-${process.arch}`;
  const leaf = `@oh-my-pi/pi-natives-${tag}`;
  let leafDir: string;
  try {
    leafDir = dirname(require_.resolve(`${leaf}/package.json`));
  } catch {
    throw new Error(
      `cannot resolve ${leaf}. That is the platform addon a compiled ompd needs beside it, ` +
        `and it is an optional dependency of @oh-my-pi/pi-natives, so an install that skipped ` +
        `optional dependencies will not have it. Re-run \`bun install\` and build again.`,
    );
  }

  // `pi_natives.<tag>.node`, and any CPU variant the package ships beside it.
  // Taking whatever the directory actually holds keeps this honest if the
  // upstream naming changes.
  const candidates = [`pi_natives.${tag}.node`, `pi_natives.${tag}.baseline.node`]
    .map(name => join(leafDir, name))
    .filter(path => existsSync(path));
  const found = candidates[0];
  if (found === undefined) {
    throw new Error(
      `${leafDir} holds no pi_natives .node for ${tag}. The package is installed but its addon is missing, ` +
        `which usually means a partial or interrupted install.`,
    );
  }
  return found;
}

const source = addonSource();
mkdirSync(outDir, { recursive: true });
const target = join(outDir, basename(source));
copyFileSync(source, target);
console.log(`staged ${basename(source)} beside the binary (${statSync(target).size} bytes) in ${outDir}`);
