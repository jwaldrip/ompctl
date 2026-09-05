/**
 * Orchestrates compiling the self-contained ompd CLI binary.
 *
 * Sequence:
 *   1. Build web portal: bun run --cwd packages/app build:web
 *   2. Generate web assets embed: bun scripts/gen-web-assets.ts
 *   3. Generate omp bridge: bun run gen:omp-bridge
 *   4. Compile binary: bun build --compile --external omp-legacy-pi-modules --outfile <outfile> packages/cli/src/main.ts
 *   5. Stage native addon beside binary: bun scripts/stage-native-addon.ts <outfile>
 *
 * In a `finally` block, restores packages/daemon/src/web-assets.ts to its tiny
 * tracked stub using `bun scripts/gen-web-assets.ts --stub`, so the multi-megabyte
 * base64 blob never stays in git status or history.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");

function runStep(cmd: string[], description: string): void {
  console.log(`[build-cli] ${description}...`);
  const res = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${description} failed with exit code ${res.status}`);
  }
}

function restoreStub(): void {
  console.log("[build-cli] restoring web-assets.ts stub...");
  const res = spawnSync(process.execPath, [join(repoRoot, "scripts", "gen-web-assets.ts"), "--stub"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    console.error(`[build-cli] warning: failed to restore web-assets stub (exit ${res.status})`);
  }
}

const args = process.argv.slice(2);
const outfileIdx = args.indexOf("--outfile");
const outfile =
  outfileIdx >= 0 && args[outfileIdx + 1] ? resolve(args[outfileIdx + 1]) : join(repoRoot, "dist", "ompd");

mkdirSync(dirname(outfile), { recursive: true });

try {
  // 1. Build app web bundle
  runStep([process.execPath, "run", "--cwd", "packages/app", "build:web"], "building web portal");

  // 2. Embed web assets
  runStep([process.execPath, join(repoRoot, "scripts", "gen-web-assets.ts")], "embedding web assets");

  // 3. Generate omp bridge
  runStep([process.execPath, "run", "gen:omp-bridge"], "generating omp bridge");

  // 4. Compile binary
  runStep(
    [
      process.execPath,
      "build",
      "--compile",
      "--external",
      "omp-legacy-pi-modules",
      "--outfile",
      outfile,
      join(repoRoot, "packages", "cli", "src", "main.ts"),
    ],
    `compiling binary to ${outfile}`,
  );

  // 5. Stage native addon beside binary
  runStep([process.execPath, join(repoRoot, "scripts", "stage-native-addon.ts"), outfile], "staging native addon");

  console.log(`[build-cli] successfully built ${outfile}`);
} finally {
  restoreStub();
}
