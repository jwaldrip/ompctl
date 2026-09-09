#!/usr/bin/env bun
/**
 * Guard against hardcoded version literals across all platform manifests.
 *
 * Verifies that:
 *   1. iOS Info.plist: CFBundleVersion is $(CURRENT_PROJECT_VERSION) and
 *      CFBundleShortVersionString is $(MARKETING_VERSION).
 *   2. macOS Info.plist: CFBundleVersion is $(CURRENT_PROJECT_VERSION) and
 *      CFBundleShortVersionString is $(MARKETING_VERSION).
 *   3. Windows Package.appxmanifest (both ompd and ompd.Package):
 *      Identity Version attribute references $(PackageVersion).
 *   4. Android build.gradle: versionCode reads from OMPD_BUILD_NUMBER or
 *      OMPD_VERSION_CODE project property rather than a hardcoded integer.
 *
 * Exits nonzero with the exact problem if any manifest carries a hardcoded literal.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Violation {
  file: string;
  field: string;
  expected: string;
  actual: string;
}

export function inspectPlistContent(content: string): { buildVersion: string | null; marketingVersion: string | null } {
  const buildMatch = content.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
  const versionMatch = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
  return {
    buildVersion: buildMatch ? buildMatch[1]! : null,
    marketingVersion: versionMatch ? versionMatch[1]! : null,
  };
}

export function inspectWindowsManifestContent(content: string): { version: string | null } {
  const versionMatch = content.match(/<Identity\b[^>]*\bVersion="([^"]*)"/);
  return {
    version: versionMatch ? versionMatch[1]! : null,
  };
}

export function inspectAndroidGradleContent(content: string): { versionCodeExpr: string | null; isLiteral: boolean } {
  const codeLineMatch = content.match(/^\s*versionCode\s+(.+)$/m);
  if (!codeLineMatch) return { versionCodeExpr: null, isLiteral: false };
  const expr = codeLineMatch[1]!.trim();
  const isLiteral = /^\d+$/.test(expr);
  return { versionCodeExpr: expr, isLiteral };
}

export function findAppDir(start: string = process.cwd()): string {
  let cur = start;
  while (cur !== "/" && cur.length > 0) {
    if (existsSync(join(cur, "packages", "app", "package.json"))) {
      return join(cur, "packages", "app");
    }
    if (existsSync(join(cur, "package.json")) && existsSync(join(cur, "ios")) && existsSync(join(cur, "android"))) {
      return cur;
    }
    cur = dirname(cur);
  }
  throw new Error("Could not find packages/app directory");
}

export function checkPlatformManifests(appDir: string = findAppDir()): Violation[] {
  const violations: Violation[] = [];

  const checkPlist = (relPath: string) => {
    const fullPath = join(appDir, relPath);
    if (!existsSync(fullPath)) {
      violations.push({ file: relPath, field: "file", expected: "exists", actual: "missing" });
      return;
    }
    const content = readFileSync(fullPath, "utf8");
    const { buildVersion, marketingVersion } = inspectPlistContent(content);

    if (buildVersion === null) {
      violations.push({
        file: relPath,
        field: "CFBundleVersion",
        expected: "$(CURRENT_PROJECT_VERSION)",
        actual: "missing",
      });
    } else if (buildVersion !== "$(CURRENT_PROJECT_VERSION)") {
      violations.push({
        file: relPath,
        field: "CFBundleVersion",
        expected: "$(CURRENT_PROJECT_VERSION)",
        actual: buildVersion,
      });
    }

    if (marketingVersion === null) {
      violations.push({
        file: relPath,
        field: "CFBundleShortVersionString",
        expected: "$(MARKETING_VERSION)",
        actual: "missing",
      });
    } else if (marketingVersion !== "$(MARKETING_VERSION)") {
      violations.push({
        file: relPath,
        field: "CFBundleShortVersionString",
        expected: "$(MARKETING_VERSION)",
        actual: marketingVersion,
      });
    }
  };

  const checkWindows = (relPath: string) => {
    const fullPath = join(appDir, relPath);
    if (!existsSync(fullPath)) {
      violations.push({ file: relPath, field: "file", expected: "exists", actual: "missing" });
      return;
    }
    const content = readFileSync(fullPath, "utf8");
    const { version } = inspectWindowsManifestContent(content);

    if (version === null) {
      violations.push({ file: relPath, field: "Identity.Version", expected: "$(PackageVersion)", actual: "missing" });
    } else if (version !== "$(PackageVersion)") {
      violations.push({
        file: relPath,
        field: "Identity.Version",
        expected: "$(PackageVersion)",
        actual: version,
      });
    }
  };

  const checkGradle = (relPath: string) => {
    const fullPath = join(appDir, relPath);
    if (!existsSync(fullPath)) {
      violations.push({ file: relPath, field: "file", expected: "exists", actual: "missing" });
      return;
    }
    const content = readFileSync(fullPath, "utf8");
    const { versionCodeExpr, isLiteral } = inspectAndroidGradleContent(content);

    if (versionCodeExpr === null) {
      violations.push({ file: relPath, field: "versionCode", expected: "parameterized expression", actual: "missing" });
    } else if (isLiteral) {
      violations.push({
        file: relPath,
        field: "versionCode",
        expected: "property lookup (OMPD_BUILD_NUMBER or OMPD_VERSION_CODE)",
        actual: `hardcoded literal integer "${versionCodeExpr}"`,
      });
    } else if (!versionCodeExpr.includes("OMPD_BUILD_NUMBER") && !versionCodeExpr.includes("OMPD_VERSION_CODE")) {
      violations.push({
        file: relPath,
        field: "versionCode",
        expected: "property lookup (OMPD_BUILD_NUMBER or OMPD_VERSION_CODE)",
        actual: versionCodeExpr,
      });
    }
  };

  checkPlist("ios/ompd/Info.plist");
  checkPlist("macos/ompd-macOS/Info.plist");
  checkWindows("windows/ompd/Package.appxmanifest");
  checkWindows("windows/ompd.Package/Package.appxmanifest");
  checkGradle("android/app/build.gradle");

  return violations;
}

if (import.meta.main) {
  console.log("Checking platform manifests for hardcoded version literals...");
  const violations = checkPlatformManifests();
  if (violations.length > 0) {
    console.error(`\nFAILED: Found ${violations.length} hardcoded version literal(s) in platform manifests:\n`);
    for (const v of violations) {
      console.error(`  - ${v.file}`);
      console.error(`      field:    ${v.field}`);
      console.error(`      expected: ${v.expected}`);
      console.error(`      actual:   ${v.actual}\n`);
    }
    process.exit(1);
  }
  console.log("OK: All platform manifests read parameterized version settings.");
}
