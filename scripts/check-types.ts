#!/usr/bin/env bun
/**
 * Typecheck one package project and gate on this repo's own diagnostics.
 *
 * The real dependency graph is checked, not a stand-in for it. `@ompd/daemon`
 * imports `@oh-my-pi/pi-coding-agent` and `@oh-my-pi/pi-utils` as source, so
 * every call into omp is verified against omp's actual published types. That is
 * the whole point of running the compiler here rather than declaring the
 * upstream surface ourselves, which would compile happily after upstream
 * renamed something out from under it.
 *
 * What this does not do is fail on a diagnostic inside `node_modules`. omp's
 * own published types are not this repo's to fix, and gating on them would
 * mean this repo could never be green for reasons no change here can fix.
 * They are still printed, counted, and attributed, so nothing is hidden.
 *
 * Failing closed is the other half. A compiler that crashes, cannot open its
 * project, or emits something this parser does not recognise is a failure, not
 * an empty diagnostic list: a check that answers "clean" when it never ran is
 * worse than no check at all.
 */

import { realpathSync } from "node:fs";
import { dirname, relative as relativeTo, resolve, sep } from "node:path";

/** `path(line,col): error TS1234: message`, which is every diagnostic tsgo prints. */
const DIAGNOSTIC =
  /^(?<path>[^(]+)\((?<line>\d+),(?<col>\d+)\): (?<severity>error|warning) (?<code>TS\d+): (?<message>.*)$/;

/** Lines a run can legitimately produce that are not diagnostics. */
const IGNORABLE = [
  /^\s*$/,
  // Continuation lines of a multi-line diagnostic, which tsgo indents.
  /^\s+/,
  /^Found \d+ error/,
  /^No errors/,
];

interface Diagnostic {
  path: string;
  line: number;
  code: string;
  message: string;
  ours: boolean;
}

/**
 * Both sides of the comparison below are resolved through the filesystem, not
 * just normalised as strings. On macOS a worktree under `/tmp` is physically
 * `/private/tmp`, and the compiler prints its cwd's physical path while
 * `import.meta.dirname` keeps the specifier's `/tmp` one. Comparing those two
 * made `relativeTo` answer `../../..`, which `classify` read as "outside this
 * repo, not ours", so every real diagnostic in such a worktree was filed as
 * somebody else's and the project reported clean with its own source broken.
 * That is a gate that cannot fail, which is worse than no gate.
 */
function physical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    // A path that does not exist cannot be resolved, and inventing one would
    // be the same silent misfiling this function exists to prevent.
    return path;
  }
}

const repoRoot = physical(resolve(import.meta.dirname, ".."));
const excludedPrefix = `node_modules${sep}`;

/**
 * Where a diagnostic's file actually is, and whether this repo owns it.
 *
 * `tsgo` prints paths relative to its own working directory, and that
 * directory is not fixed: the root gate runs each package's `check` from that
 * package, so the same file arrives as `src/daemon.ts` there and as
 * `packages/daemon/src/daemon.ts` from the repo root. Resolving against
 * anything but the directory the compiler actually ran in is how a real
 * diagnostic gets filed as somebody else's and stops gating.
 */
function classify(path: string, spawnedIn: string): { path: string; ours: boolean } {
  const absolute = physical(resolve(spawnedIn, path));
  const fromRoot = relativeTo(repoRoot, absolute);
  // Only one kind of diagnostic is legitimately not this repo's: one inside a
  // `node_modules` directory. Anything else that lands outside the repo root
  // is a classification failure rather than somebody else's problem, so it
  // gates. Reporting it absolute says plainly which file could not be placed.
  if (fromRoot.startsWith("..")) {
    return { path: absolute, ours: !absolute.includes(`${sep}node_modules${sep}`) };
  }
  return { path: fromRoot, ours: !fromRoot.startsWith(excludedPrefix) };
}

function parse(output: string, spawnedIn: string): { diagnostics: Diagnostic[]; unparsed: string[] } {
  const diagnostics: Diagnostic[] = [];
  const unparsed: string[] = [];
  for (const raw of output.split("\n")) {
    const match = DIAGNOSTIC.exec(raw);
    if (match?.groups) {
      const located = classify(match.groups.path ?? "", spawnedIn);
      diagnostics.push({
        path: located.path,
        line: Number(match.groups.line),
        code: match.groups.code ?? "",
        message: match.groups.message ?? "",
        ours: located.ours,
      });
      continue;
    }
    if (raw.length > 0 && !IGNORABLE.some(pattern => pattern.test(raw))) unparsed.push(raw);
  }
  return { diagnostics, unparsed };
}

function summarize(diagnostics: Diagnostic[]): string[] {
  const byArea = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    // `packages/ai`, `node_modules/onnxruntime-common`: two segments is enough
    // to name who owns the file without listing thousands of lines.
    const area = diagnostic.path.split(sep).slice(0, 2).join(sep);
    byArea.set(area, (byArea.get(area) ?? 0) + 1);
  }
  return [...byArea].sort((a, b) => b[1] - a[1]).map(([area, count]) => `    ${count} ${area}`);
}

const projects = process.argv.slice(2);
if (projects.length === 0) {
  console.error("usage: check-types.ts <tsconfig.json> [...]");
  process.exit(2);
}

let failed = false;
for (const project of projects) {
  // Spawned in the project's own directory so the compiler's relative paths
  // have exactly one meaning, whichever directory this script was called from.
  //
  // Physical, and `PWD` set to match, because the compiler reports each file
  // relative to `PWD` while resolving the file itself physically. Under a
  // worktree reached through a symlink, macOS `/tmp` being `/private/tmp`
  // being the everyday case, those two disagree and it emits paths like
  // `../../../../private/tmp/<repo>/packages/app/src/x.ts`: up out of the
  // logical path, back down the physical one. Re-resolved here that lands
  // outside the repo, where `classify` reads it as somebody else's and stops
  // gating, so the project reports clean with its own source broken.
  const projectPath = physical(resolve(process.cwd(), project));
  const spawnedIn = dirname(projectPath);
  const run = Bun.spawnSync(["bunx", "tsgo", "-p", projectPath, "--noEmit"], {
    cwd: spawnedIn,
    env: { ...process.env, PWD: spawnedIn },
  });
  const output = new TextDecoder().decode(run.stdout) + new TextDecoder().decode(run.stderr);
  const { diagnostics, unparsed } = parse(output, spawnedIn);
  const ours = diagnostics.filter(diagnostic => diagnostic.ours);
  const theirs = diagnostics.filter(diagnostic => !diagnostic.ours);

  // A nonzero exit with no diagnostic at all is the compiler failing to run.
  // Trusting it would turn a broken invocation into a silent pass.
  if (run.exitCode !== 0 && diagnostics.length === 0) {
    console.error(`${project}: tsgo exited ${run.exitCode} without diagnostics`);
    console.error(output.trim() || "(no output)");
    failed = true;
    continue;
  }
  if (unparsed.length > 0) {
    console.error(`${project}: unrecognised compiler output, treating as failure`);
    for (const line of unparsed.slice(0, 10)) console.error(`  ${line}`);
    failed = true;
  }

  if (theirs.length > 0) {
    console.log(`${project}: ${theirs.length} diagnostics in node_modules (not gating)`);
    for (const line of summarize(theirs)) console.log(line);
  }
  if (ours.length === 0) {
    console.log(`${project}: clean`);
    continue;
  }
  console.error(`${project}: ${ours.length} diagnostics`);
  for (const diagnostic of ours) {
    console.error(`  ${diagnostic.path}:${diagnostic.line} ${diagnostic.code}: ${diagnostic.message}`);
  }
  failed = true;
}

process.exit(failed ? 1 : 0);
