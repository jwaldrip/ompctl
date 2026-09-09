/**
 * Resolution order for the omp executable:
 * 1. Operator's configured ompPath wins.
 * 2. Real omp on system PATH wins over bundled.
 * 3. Bundled copy is used when neither configured nor PATH omp exists.
 *
 * A bundled copy is never run against an existing ~/.omp created by a
 * different major version (e.g. major 18 vs bundled major 17).
 */

import { spawnSync } from "node:child_process";
import { existsSync as fsExistsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const BUNDLED_OMP_VERSION = "17.3.4";
export const BUNDLED_OMP_MAJOR_VERSION = 17;

export type OmpSource = "configured" | "path" | "bundled";

export interface ResolvedOmp {
  path: string;
  source: OmpSource;
  version?: string;
}

export class OmpResolutionError extends Error {
  readonly checked: {
    configured?: string;
    pathSearched?: boolean;
    bundledCandidates: string[];
    versionConflict?: string;
  };

  constructor(
    message: string,
    checked: {
      configured?: string;
      pathSearched?: boolean;
      bundledCandidates: string[];
      versionConflict?: string;
    },
  ) {
    super(message);
    this.name = "OmpResolutionError";
    this.checked = checked;
  }
}

export interface ResolveOmpOptions {
  /** Configured ompPath from daemon config or CLI override. */
  configuredPath?: string;
  /** System PATH string (defaults to process.env.PATH). */
  envPath?: string;
  /** State directory for omp (defaults to ~/.omp or PI_CODING_AGENT_DIR). */
  ompHome?: string;
  /** Directory containing running executable (defaults to dirname(process.execPath)). */
  execDir?: string;
  /** Root directory of the repository or package checkout. */
  repoRoot?: string;
  /** Filesystem existence seam. */
  existsSync?: (path: string) => boolean;
  /** Executable permission seam. */
  isExecutable?: (path: string) => boolean;
  /** Version probe seam. */
  readVersion?: (path: string) => string | null;
  /** Major version detector for ~/.omp. */
  readOmpMajorVersion?: (ompHome: string) => number | null;
}

function defaultIsExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return false;
    // On Windows, any existing file is considered runnable
    if (process.platform === "win32") return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function defaultReadVersion(binPath: string): string | null {
  try {
    const res = spawnSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, PI_TIMING: undefined },
    });
    if (res.status === 0 && res.stdout) {
      const match = res.stdout.match(/(?:omp\/)?([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
      if (match?.[1]) return match[1];
    }
  } catch {
    // Probe failures return null
  }
  return null;
}

export function defaultReadOmpMajorVersion(ompHome: string): number | null {
  const nativesDir = join(ompHome, "natives");
  try {
    if (!fsExistsSync(nativesDir)) return null;
    const entries = readdirSync(nativesDir, { withFileTypes: true });
    let maxMajor: number | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^([0-9]+)\./);
      if (match?.[1]) {
        const major = Number.parseInt(match[1], 10);
        if (maxMajor === null || major > maxMajor) {
          maxMajor = major;
        }
      }
    }
    return maxMajor;
  } catch {
    return null;
  }
}

function findOnPath(
  envPath: string,
  binName: string,
  exists: (p: string) => boolean,
  executable: (p: string) => boolean,
): string | null {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = envPath.split(sep).filter(d => d.length > 0);
  for (const dir of dirs) {
    const candidate = join(dir, binName);
    if (exists(candidate) && executable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveOmp(opts: ResolveOmpOptions = {}): ResolvedOmp {
  const exists = opts.existsSync ?? fsExistsSync;
  const executable = opts.isExecutable ?? defaultIsExecutable;
  const readVer = opts.readVersion ?? defaultReadVersion;
  const readMajor = opts.readOmpMajorVersion ?? defaultReadOmpMajorVersion;

  const rawConfigured = opts.configuredPath?.trim();
  const hasCustomConfigured = rawConfigured !== undefined && rawConfigured.length > 0 && rawConfigured !== "omp";

  // 1. Operator's configured ompPath wins
  if (hasCustomConfigured) {
    const target = isAbsolute(rawConfigured) ? rawConfigured : resolve(rawConfigured);
    if (!exists(target) || !executable(target)) {
      throw new OmpResolutionError(`configured ompPath "${rawConfigured}" does not exist or is not executable`, {
        configured: rawConfigured,
        bundledCandidates: [],
      });
    }
    const version = readVer(target) ?? undefined;
    return {
      path: target,
      source: "configured",
      version,
    };
  }

  // 2. Real omp on PATH wins
  const envPath = opts.envPath ?? process.env.PATH ?? "";
  const pathBinary = findOnPath(envPath, "omp", exists, executable);
  if (pathBinary !== null) {
    const version = readVer(pathBinary) ?? undefined;
    return {
      path: pathBinary,
      source: "path",
      version,
    };
  }

  // 3. Bundled copy
  const execDir = opts.execDir ?? dirname(process.execPath);
  const repoRoot = opts.repoRoot ?? resolve(import.meta.dirname, "../../..");
  const bundledCandidates: string[] = [
    // Staged binary beside ompd
    join(execDir, "omp-bundled"),
    join(execDir, "omp"),
    // In build output dist directory
    join(repoRoot, "dist", "omp-bundled"),
    join(repoRoot, "dist", "omp"),
    // Development checkout package entry
    join(repoRoot, "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js"),
  ];

  let resolvedBundled: string | null = null;
  for (const candidate of bundledCandidates) {
    if (exists(candidate) && executable(candidate)) {
      resolvedBundled = candidate;
      break;
    }
  }

  if (resolvedBundled !== null) {
    // Check version coupling against existing ~/.omp
    const ompHome = opts.ompHome ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp");
    const existingMajor = readMajor(ompHome);
    if (existingMajor !== null && existingMajor !== BUNDLED_OMP_MAJOR_VERSION) {
      const conflictMessage =
        `refusing to use bundled omp (${BUNDLED_OMP_VERSION}): existing ~/.omp was written by omp version ${existingMajor}. ` +
        `Running bundled omp ${BUNDLED_OMP_MAJOR_VERSION} against a ~/.omp from a different major version risks database and config corruption. ` +
        `Install omp ${existingMajor} on PATH or configure ompPath in config.json.`;
      throw new OmpResolutionError(conflictMessage, {
        pathSearched: true,
        bundledCandidates,
        versionConflict: conflictMessage,
      });
    }

    const version = readVer(resolvedBundled) ?? BUNDLED_OMP_VERSION;
    return {
      path: resolvedBundled,
      source: "bundled",
      version,
    };
  }

  // Refusal when nothing resolves
  throw new OmpResolutionError(
    "no usable omp found: no configured ompPath, omp not found on PATH, and no bundled copy found beside binary or in node_modules",
    {
      configured: rawConfigured,
      pathSearched: true,
      bundledCandidates,
    },
  );
}
