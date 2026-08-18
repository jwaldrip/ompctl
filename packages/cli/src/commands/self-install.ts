/**
 * `ompd self-install`: make `ompd` a command.
 *
 * Everything in the docs starts with the word `ompd`, and until this exists
 * none of it is true: the package declares a `bin` entry that nothing links,
 * so the real invocation is `bun packages/cli/src/main.ts`. That is a fallback
 * masquerading as an interface.
 *
 * The artifact is a `bun build --compile` binary rather than a symlink into
 * the checkout, and that choice is the entire point. A symlink into a linked
 * worktree dies with the branch. A compiled binary embeds its runtime and its
 * bundle, so it keeps working after the tree it was built from is deleted,
 * which is precisely what a login agent needs from the thing it names.
 *
 * The refusal at the target mirrors `install`'s refusal at the plist path, for
 * the same reason and by the same discipline: a marker, checked without ever
 * executing the file that is already there.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { OMPD_VERSION } from "@ompd/daemon";
import type { Command } from "../args.ts";
import type { CliContext } from "../client.ts";
import {
  BINARY_MARKER,
  BINARY_NAME,
  defaultPrefix,
  findOnPath,
  isCompiledRuntime,
  isOmpdBinary,
  pathAdvice,
  sourceEntry,
} from "../install.ts";

/**
 * The `pi_natives` addon the compiled binary needs, placed beside it.
 *
 * `bun build --compile` embeds the JS bundle but not this `.node`, and the
 * loader inside it searches three places: a versioned directory under the omp
 * home, the binary's own directory, and a path inside the compiled filesystem
 * that only exists in omp's own build. So a freshly compiled `ompd` finds
 * nothing and dies at startup on the first native call -- which is every start,
 * because the daemon loads it before it serves.
 *
 * Copying it next to the binary satisfies the second search path and makes the
 * pair self-contained: the addon travels with the artifact rather than relying
 * on a version-matched directory that happens to be populated by some other
 * install. A mismatched one is worse than a missing one, since the loader
 * rejects it by version sentinel and reports a resolve failure that reads like
 * a missing file.
 *
 * Returns null on success, or the lines explaining what was not found.
 */
async function placeNativeAddon(ctx: CliContext, staging: string): Promise<string[] | null> {
  const name = `pi_natives.${process.platform}-${process.arch}.node`;
  const beside = join(staging, "..", name);

  // Copied from the running binary's own sibling when that is the source, so a
  // second prefix gets the same pair rather than re-resolving a package.
  if (isCompiledRuntime()) {
    const sibling = join(process.execPath, "..", name);
    if (!existsSync(sibling)) {
      return [
        `this ompd runs without ${name} beside it, so the copy would inherit the same gap`,
        `  expected: ${sibling}`,
      ];
    }
    copyFileSync(sibling, beside);
    return null;
  }

  const resolved = await resolveAddonFromCheckout(ctx, name);
  if (resolved === null) {
    return [
      `could not find ${name} to install beside the binary`,
      "  the compiled binary loads it at startup, so installing without it would",
      "  produce an ompd that exits before it serves",
    ];
  }
  copyFileSync(resolved, beside);
  return null;
}

/** The addon inside the checkout this is being built from, if it is there. */
async function resolveAddonFromCheckout(ctx: CliContext, name: string): Promise<string | null> {
  const pkg = `@oh-my-pi/pi-natives-${process.platform}-${process.arch}`;
  const candidates = [
    join(ctx.cwd, "node_modules", pkg, name),
    join(sourceEntry(), "..", "..", "..", "..", "node_modules", pkg, name),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function selfInstallCommand(
  ctx: CliContext,
  cmd: Extract<Command, { kind: "self-install" }>,
): Promise<number> {
  const prefix =
    cmd.prefix === undefined
      ? defaultPrefix(ctx.env)
      : isAbsolute(cmd.prefix)
        ? cmd.prefix
        : resolve(ctx.cwd, cmd.prefix);
  const target = join(prefix, BINARY_NAME);

  if (existsSync(target)) {
    if (statSync(target).isDirectory()) {
      ctx.err(`${target} is a directory. Pick a different --prefix.`);
      return 1;
    }
    if (!isOmpdBinary(target)) {
      ctx.err(`${target} exists and ompd did not build it.`);
      ctx.err(`  It carries no ${BINARY_MARKER} marker, so overwriting it would clobber`);
      ctx.err("  someone else's file. Move or remove it yourself, or pass --prefix.");
      return 1;
    }
  }

  mkdirSync(prefix, { recursive: true });

  // Built beside the target and renamed over it. A rename within one directory
  // is atomic, so a failure part-way through leaves the previous binary intact
  // rather than a truncated file that launchd would happily try to exec.
  const staging = join(prefix, `.${BINARY_NAME}.${process.pid}.tmp`);
  const built = await build(ctx, staging);
  if (built !== null) {
    rmSync(staging, { force: true });
    for (const line of built) ctx.err(line);
    return 1;
  }

  chmodSync(staging, 0o755);

  // Verified BEFORE it is moved into place, which is the whole point of staging.
  //
  // This used to rename first and check afterwards. The check did fail and the
  // command did return 1, but by then the previous binary was already gone, so
  // a build that cannot run replaced one that could and the exit code was the
  // only trace. On a machine whose login agent names this path, the next
  // restart crash-loops the daemon -- reported as a failed install, delivered
  // as a broken service.
  //
  // The native addon has to be beside it for this to mean anything: the loader
  // searches the binary's own directory, so a staged binary checked without it
  // would fail for a reason the installed one would not have had.
  const addon = await placeNativeAddon(ctx, staging);
  if (addon !== null) {
    rmSync(staging, { force: true });
    for (const line of addon) ctx.err(line);
    return 1;
  }

  const staged = await ctx.exec([staging, "--version"]);
  if (staged.code !== 0) {
    rmSync(staging, { force: true });
    ctx.err(`built ${BINARY_NAME} but it did not run, so ${target} was left alone:`);
    ctx.err(`  ${staged.stderr.trim().split("\n")[0] ?? `exit ${staged.code}`}`);
    return 1;
  }

  renameSync(staging, target);

  const version = await ctx.exec([target, "--version"]);
  if (version.code !== 0) {
    ctx.err(`installed ${target} but it did not run: ${version.stderr.trim() || `exit ${version.code}`}`);
    return 1;
  }

  ctx.out(`installed ompd ${version.stdout.trim() || OMPD_VERSION}`);
  ctx.out(`  path         ${target}`);
  ctx.out(
    isCompiledRuntime()
      ? "  source       copied from the running binary"
      : `  source       compiled from ${sourceEntry()}`,
  );

  reportPath(ctx, prefix, target);
  ctx.out("");
  ctx.out("  next: `ompd start`, then `ompd doctor`");
  return 0;
}

/** Null on success; otherwise the lines explaining what failed. */
async function build(ctx: CliContext, staging: string): Promise<string[] | null> {
  // A compiled binary has no source tree to build from, and does not need one:
  // it already is the artifact. `self-install` from an installed ompd is how a
  // binary gets copied to a second prefix.
  if (isCompiledRuntime()) {
    copyFileSync(process.execPath, staging);
    return null;
  }

  // `process.execPath` is bun here, which is the compiler. Using it rather
  // than the string "bun" means self-install works when bun is not on PATH,
  // which is the same class of problem this command exists to fix.
  // `--external`: `omp-legacy-pi-modules` is a virtual module that only
  // exists inside omp's own compiled-binary build pipeline
  // (legacy-pi-compat.ts's IS_COMPILED_BINARY-gated dynamic import). ompd's
  // own commands never reach omp's plugin/legacy-module loader, so the
  // import is dead code for this binary; unresolved rather than external, it
  // fails the whole build instead. Kept in sync with root package.json's
  // build:cli script.
  const result = await ctx.exec([
    process.execPath,
    "build",
    "--compile",
    "--external",
    "omp-legacy-pi-modules",
    "--outfile",
    staging,
    sourceEntry(),
  ]);
  if (result.code === 0 && existsSync(staging)) return null;

  return [
    `compiling ${sourceEntry()} failed (exit ${result.code}).`,
    ...(result.stderr.trim().length > 0 ? [`  ${result.stderr.trim()}`] : []),
  ];
}

/**
 * Whether the shell will find what was just installed.
 *
 * Three different answers, and printing the wrong one wastes someone's
 * afternoon: already reachable, shadowed by another `ompd` earlier on `PATH`,
 * or not on `PATH` at all. Only the last is worth a shell profile edit, so
 * only the last prints one.
 */
function reportPath(ctx: CliContext, prefix: string, target: string): void {
  const advice = pathAdvice(ctx.env, prefix);

  if (!advice.onPath) {
    ctx.out(`  PATH         ${prefix} is not on your PATH.`);
    ctx.out(`               add this line to ${advice.rcPath}, then open a new shell:`);
    ctx.out(`                 ${advice.line}`);
    return;
  }

  const found = findOnPath(ctx.env, BINARY_NAME);
  if (found !== null && found !== target) {
    ctx.out(`  PATH         ${prefix} is on your PATH, but ${found} comes first`);
    ctx.out(`               and will win. Remove it, or call ${target} directly.`);
    return;
  }

  ctx.out(`  PATH         ${prefix} is already on your PATH; nothing to edit`);
}
