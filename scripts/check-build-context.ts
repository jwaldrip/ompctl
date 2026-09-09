/**
 * Refuse an ignore file that hides tracked source from a build.
 *
 * The failure this exists for is silent everywhere it is cheap to look. A
 * pattern in `.gitignore` matched `packages/app/src/artifacts/`; git kept the
 * files because they were already tracked, so every checkout and every local
 * build had them. `gcloud builds submit` falls back to `.gitignore` when no
 * `.gcloudignore` exists, so Cloud Build alone received a tree with that
 * directory cut out, and failed on a module resolution error whose real text
 * lived only inside the Cloud Build log. Two production deploys died on it.
 *
 * The check is the one question that would have caught it: does any ignore
 * file that shapes a build context exclude a file this repository tracks as
 * source? `git ls-files -c -i --exclude-from=<file>` answers exactly that,
 * listing tracked paths a given exclude set would drop, so the matching is
 * git's own rather than a reimplementation of its pattern semantics.
 *
 * Scoped to `src` directories on purpose. `.dockerignore` legitimately drops
 * tracked trees a server image does not need, `packages/app/ios` among them.
 * Source is the line: nothing under a `src` directory is ever reproducible
 * inside the image, so excluding it can only ever be an accident.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Ignore files that decide what a build actually receives. */
const CONTEXT_IGNORE_FILES = [".gcloudignore", ".dockerignore", ".gitignore"] as const;

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");

/**
 * Tracked paths the given exclude set would drop. `-c` restricts to files git
 * already tracks, which is the whole point: an untracked match is the pattern
 * doing its job, and a tracked match is a file that exists for every reader
 * except the build.
 */
function trackedButExcluded(ignoreFile: string): string[] {
  const result = spawnSync(
    "git",
    // `:(glob)` matters. A bare git pathspec is not a glob and its `*` spans
    // separators, so `packages/*/src/**` also reached
    // `packages/app/android/app/src/`, a native tree the server images drop on
    // purpose. The magic prefix restores the usual meaning, one path segment,
    // which narrows this to the TypeScript source a package roots at `src`.
    ["ls-files", "-c", "-i", `--exclude-from=${ignoreFile}`, "--", ":(glob)packages/*/src/**"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed for ${ignoreFile}: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter(line => line.length > 0);
}

let failed = false;

for (const name of CONTEXT_IGNORE_FILES) {
  const path = join(repoRoot, name);
  if (!existsSync(path)) continue;
  const hidden = trackedButExcluded(path);
  if (hidden.length === 0) {
    console.log(`  ${name}: hides no tracked source`);
    continue;
  }
  failed = true;
  console.error(`\n${name} excludes ${hidden.length} tracked source file(s) from the build context:`);
  for (const file of hidden.slice(0, 20)) console.error(`  ${file}`);
  if (hidden.length > 20) console.error(`  ...and ${hidden.length - 20} more`);
  console.error(
    `\nThese files are in git, so every local build has them and only the remote build does not.\n` +
      `Anchor the pattern to the directory it was written for rather than leaving it to match at every depth.`,
  );
}

if (failed) process.exit(1);
console.log("build context: no ignore file hides tracked source");
