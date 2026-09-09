/**
 * Central build and version resolver for ompctl apps.
 *
 * Provides a single monotonic source of truth for:
 *   - buildNumber (integer build count, e.g. 771)
 *   - versionCode (identical to buildNumber for Android)
 *   - versionName (marketing version, e.g. 0.1.0 or 1.0)
 *   - windowsVersion (four-part MSIX version, e.g. 0.1.771.0)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BuildInfo {
  buildNumber: number;
  versionCode: number;
  versionName: string;
  windowsVersion: string;
}

const FALLBACK_BUILD_FLOOR = 770; // strictly above iOS TestFlight build 15

export function findAppPackageJson(startDir: string = process.cwd()): string | null {
  let cur = startDir;
  while (cur !== "/" && cur.length > 0) {
    const pkgInPackages = join(cur, "packages", "app", "package.json");
    if (existsSync(pkgInPackages)) return pkgInPackages;
    const directPkg = join(cur, "package.json");
    if (existsSync(directPkg) && existsSync(join(cur, "ios")) && existsSync(join(cur, "android"))) {
      return directPkg;
    }
    cur = dirname(cur);
  }
  return null;
}

export function resolveBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  // 1. Build Number
  let buildNum = 0;
  const envNum = env.OMPD_BUILD_NUMBER || env.OMPD_VERSION_CODE;
  if (envNum) {
    const parsed = Number.parseInt(envNum, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      buildNum = parsed;
    }
  }

  if (buildNum <= 0) {
    try {
      const out = execSync("git rev-list --count HEAD", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const count = Number.parseInt(out, 10);
      if (!Number.isNaN(count) && count > 0) {
        buildNum = count;
      }
    } catch {
      // Not a git repo or git missing
    }
  }

  if (buildNum <= 0) {
    buildNum = FALLBACK_BUILD_FLOOR;
  }

  // 2. Marketing Version Name
  let verName = env.OMPD_VERSION_NAME || env.MARKETING_VERSION;
  if (!verName) {
    const pkgPath = findAppPackageJson();
    if (pkgPath) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (typeof pkg.version === "string" && pkg.version.trim()) {
          verName = pkg.version.trim();
        }
      } catch {}
    }
  }

  if (!verName) {
    verName = "0.1.0";
  }
  // 3. Windows 4-part Quad Version (Major.Minor.Build.Revision)
  const match = verName.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  const major = match ? match[1]! : "0";
  const minor = match ? match[2]! : "1";
  const patch = match?.[3] ?? "0";
  const windowsVersion = `${major}.${minor}.${buildNum}.${patch}`;

  return {
    buildNumber: buildNum,
    versionCode: buildNum,
    versionName: verName,
    windowsVersion,
  };
}

if (import.meta.main) {
  const info = resolveBuildInfo();
  const arg = process.argv[2];
  if (arg === "--json") {
    console.log(JSON.stringify(info));
  } else if (arg === "--build-number") {
    console.log(info.buildNumber);
  } else if (arg === "--version-name") {
    console.log(info.versionName);
  } else if (arg === "--windows") {
    console.log(info.windowsVersion);
  } else {
    console.log(`build_number:    ${info.buildNumber}`);
    console.log(`version_code:    ${info.versionCode}`);
    console.log(`version_name:    ${info.versionName}`);
    console.log(`windows_version: ${info.windowsVersion}`);
  }
}
