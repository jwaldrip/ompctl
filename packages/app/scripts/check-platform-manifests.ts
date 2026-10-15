#!/usr/bin/env bun
/**
 * Guard platform manifest values that must not drift across release builds.
 *
 * Verifies that:
 *   1. iOS Info.plist uses parameterized versions and enables the New Architecture.
 *   2. macOS Info.plist uses parameterized versions and disables the New Architecture,
 *      because this dependency set contains iOS-only Fabric component registrations.
 *   3. Windows Package.appxmanifest (both ompd and ompd.Package):
 *      Identity Version attribute references $(PackageVersion).
 *   4. Android build.gradle: versionCode reads from OMPD_BUILD_NUMBER or
 *      OMPD_VERSION_CODE project property rather than a hardcoded integer.
 *   5. The macOS host still provides `RNGetRandomValues` itself. That is the
 *      consequence of (2): under the old architecture a module registers
 *      through `RCT_EXPORT_MODULE` and nothing else, and
 *      react-native-get-random-values 2.x ships a TurboModule with no such
 *      registration, so without the host's own module the app has no
 *      `crypto.getRandomValues`, every socket it opens dies on the tunnel's
 *      handshake, and the Mac can reach no daemon at all. A source file alone
 *      is not the check: it has to be compiled into the target, because a file
 *      the target never builds registers nothing.
 *   6. Bundled fonts (*.ttf in src/design/fonts) are registered on every platform.
 *      The native apps shipped for months drawing system fonts while the files
 *      sat in the repo, because copying assets to the source tree does not
 *      register them with platform font loaders (iOS UIAppFonts and Resources,
 *      macOS Resources and ATSApplicationFontsPath, and web @font-face).
 *
 * Exits nonzero with the exact problem if any manifest carries a forbidden value.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Violation {
  file: string;
  field: string;
  expected: string;
  actual: string;
}

export function inspectPlistContent(content: string): {
  buildVersion: string | null;
  marketingVersion: string | null;
  newArchEnabled: boolean | null;
} {
  const buildMatch = content.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/);
  const versionMatch = content.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/);
  const newArchMatch = content.match(/<key>RCTNewArchEnabled<\/key>\s*<(true|false)\/>/);
  return {
    buildVersion: buildMatch ? buildMatch[1]! : null,
    marketingVersion: versionMatch ? versionMatch[1]! : null,
    newArchEnabled: newArchMatch ? newArchMatch[1] === "true" : null,
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

/**
 * The three facts that together mean the macOS binary answers
 * `TurboModuleRegistry.getEnforcing("RNGetRandomValues")`: a module exported
 * under that exact name, a synchronous export (WebCrypto has nowhere to
 * await), and that source compiled into the host target rather than merely
 * sitting in the folder.
 */
export function inspectMacosRandomBridge(sources: { module: string | null; pbxproj: string }): {
  exportsModule: boolean;
  exportsSyncMethod: boolean;
  compiled: boolean;
} {
  const module = sources.module ?? "";
  // The macro's argument is the JavaScript-visible name, which is the whole
  // point here: the class may be called anything, the module may not.
  const exportsModule = /RCT_EXPORT_MODULE\(\s*RNGetRandomValues\s*\)/.test(module);
  const exportsSyncMethod = /RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD\(\s*getRandomBase64:/.test(module);
  // Listed in the target's Sources build phase, not merely present on disk:
  // an uncompiled file registers nothing.
  const compiled = /OmpctlRandomValues\.m in Sources/.test(sources.pbxproj);
  return { exportsModule, exportsSyncMethod, compiled };
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every bundled font that a platform does not register, one violation per
 * font per surface. Check 6 in the header says why this exists.
 */
export function missingFontRegistrations(
  fonts: string[],
  sources: {
    iosPlist: string;
    iosPbxproj: string;
    macosPbxproj: string;
    macosPlist: string;
    indexHtml: string;
  },
): Violation[] {
  const violations: Violation[] = [];

  // Parse iOS UIAppFonts array entries. Only strings inside the UIAppFonts array
  // count as registrations; comments and strings under other keys are ignored.
  const registeredIosFonts = new Set<string>();
  const uiAppFontsMatch = sources.iosPlist.match(/<key>UIAppFonts<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (uiAppFontsMatch) {
    const arrayBody = uiAppFontsMatch[1]!.replace(/<!--[\s\S]*?-->/g, "");
    for (const match of arrayBody.matchAll(/<string>([^<]+)<\/string>/g)) {
      registeredIosFonts.add(match[1]!.trim());
    }
  }

  // Parse web @font-face declarations from index.html.
  const registeredWebFonts = new Set<string>();
  const fontFaceBlocks = sources.indexHtml.match(/@font-face\s*\{[\s\S]*?\}/gi) ?? [];
  for (const block of fontFaceBlocks) {
    const cleanBlock = block.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of cleanBlock.matchAll(
      /url\(\s*['"]?(?:[^'")\n?#]*\/)?([^'")\n?#]+\.ttf)(?:[?#][^'")\n]*)?['"]?\s*\)/gi,
    )) {
      registeredWebFonts.add(match[1]!);
    }
  }

  // A file reference alone copies nothing; only a Resources build phase entry
  // puts the font in the bundle, and Xcode names that entry in this comment.
  const inResources = (pbxproj: string, font: string) =>
    new RegExp(`/\\*\\s*${escapeRegex(font)}\\s+in\\s+Resources\\s*\\*/`).test(pbxproj);

  for (const font of fonts) {
    if (!registeredIosFonts.has(font)) {
      violations.push({
        file: "ios/ompd/Info.plist",
        field: "UIAppFonts",
        expected: font,
        actual: "missing",
      });
    }
    if (!inResources(sources.iosPbxproj, font)) {
      violations.push({
        file: "ios/ompd.xcodeproj/project.pbxproj",
        field: "Resources",
        expected: font,
        actual: "missing",
      });
    }
    if (!inResources(sources.macosPbxproj, font)) {
      violations.push({
        file: "macos/ompd.xcodeproj/project.pbxproj",
        field: "Resources",
        expected: font,
        actual: "missing",
      });
    }
    if (!registeredWebFonts.has(font)) {
      violations.push({
        file: "index.html",
        field: "@font-face",
        expected: font,
        actual: "missing",
      });
    }
  }

  // macOS requires ATSApplicationFontsPath set to "." in Info.plist so that
  // font files copied into bundle resources are discovered by CoreText.
  const cleanMacosPlist = sources.macosPlist.replace(/<!--[\s\S]*?-->/g, "");
  const atsMatch = cleanMacosPlist.match(/<key>ATSApplicationFontsPath<\/key>\s*<string>([^<]*)<\/string>/);
  if (!atsMatch) {
    violations.push({
      file: "macos/ompd-macOS/Info.plist",
      field: "ATSApplicationFontsPath",
      expected: ".",
      actual: "missing",
    });
  } else if (atsMatch[1] !== ".") {
    violations.push({
      file: "macos/ompd-macOS/Info.plist",
      field: "ATSApplicationFontsPath",
      expected: ".",
      actual: atsMatch[1]!,
    });
  }

  return violations;
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

  const checkPlist = (relPath: string, expectedNewArch: boolean) => {
    const fullPath = join(appDir, relPath);
    if (!existsSync(fullPath)) {
      violations.push({ file: relPath, field: "file", expected: "exists", actual: "missing" });
      return;
    }
    const content = readFileSync(fullPath, "utf8");
    const { buildVersion, marketingVersion, newArchEnabled } = inspectPlistContent(content);

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

    if (newArchEnabled !== expectedNewArch) {
      violations.push({
        file: relPath,
        field: "RCTNewArchEnabled",
        expected: String(expectedNewArch),
        actual: newArchEnabled === null ? "missing" : String(newArchEnabled),
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

  const checkMacosRandomBridge = () => {
    const modulePath = join(appDir, "macos/ompd-macOS/OmpctlRandomValues.m");
    const bridge = inspectMacosRandomBridge({
      module: existsSync(modulePath) ? readFileSync(modulePath, "utf8") : null,
      pbxproj: readFileSync(join(appDir, "macos/ompd.xcodeproj/project.pbxproj"), "utf8"),
    });
    if (!bridge.exportsModule) {
      violations.push({
        file: "macos/ompd-macOS/OmpctlRandomValues.m",
        field: "RCT_EXPORT_MODULE",
        expected: "RCT_EXPORT_MODULE(RNGetRandomValues)",
        actual: "missing: nothing registers crypto.getRandomValues on macOS",
      });
    }
    if (!bridge.exportsSyncMethod) {
      violations.push({
        file: "macos/ompd-macOS/OmpctlRandomValues.m",
        field: "getRandomBase64",
        expected: "RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getRandomBase64:...)",
        actual: "missing: WebCrypto cannot await, so an async export cannot serve it",
      });
    }
    if (!bridge.compiled) {
      violations.push({
        file: "macos/ompd.xcodeproj/project.pbxproj",
        field: "Sources build phase",
        expected: "OmpctlRandomValues.m in Sources",
        actual: "missing: a file the target does not compile registers nothing",
      });
    }
  };

  const checkFonts = () => {
    const fontsDir = join(appDir, "src/design/fonts");
    const fonts = existsSync(fontsDir)
      ? readdirSync(fontsDir, { withFileTypes: true })
          .filter(d => d.isFile() && d.name.endsWith(".ttf"))
          .map(d => d.name)
          .sort()
      : [];

    const readSource = (relPath: string) => {
      const fullPath = join(appDir, relPath);
      return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
    };

    const fontViolations = missingFontRegistrations(fonts, {
      iosPlist: readSource("ios/ompd/Info.plist"),
      iosPbxproj: readSource("ios/ompd.xcodeproj/project.pbxproj"),
      macosPbxproj: readSource("macos/ompd.xcodeproj/project.pbxproj"),
      macosPlist: readSource("macos/ompd-macOS/Info.plist"),
      indexHtml: readSource("index.html"),
    });

    violations.push(...fontViolations);
  };

  checkPlist("ios/ompd/Info.plist", true);
  checkPlist("macos/ompd-macOS/Info.plist", false);
  checkWindows("windows/ompd/Package.appxmanifest");
  checkWindows("windows/ompd.Package/Package.appxmanifest");
  checkGradle("android/app/build.gradle");
  checkMacosRandomBridge();
  checkFonts();

  return violations;
}

if (import.meta.main) {
  console.log("Checking platform manifest version and runtime settings...");
  const violations = checkPlatformManifests();
  if (violations.length > 0) {
    console.error(`\nFAILED: Found ${violations.length} invalid platform manifest value(s):\n`);
    for (const v of violations) {
      console.error(`  - ${v.file}`);
      console.error(`      field:    ${v.field}`);
      console.error(`      expected: ${v.expected}`);
      console.error(`      actual:   ${v.actual}\n`);
    }
    process.exit(1);
  }
  console.log("OK: Platform manifest version and runtime settings are valid.");
}
