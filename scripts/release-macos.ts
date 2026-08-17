#!/usr/bin/env bun
/**
 * Build, sign, notarize, and staple the macOS installer.
 *
 * Usage:
 *   bun scripts/release-macos.ts build     # full chain from a clean archive
 *   bun scripts/release-macos.ts verify <pkg>   # assert an existing .pkg is shippable
 *
 * Why this is a script and not a README: producing the first shippable package
 * took two rounds, and the failure was invisible at every step that reported
 * success. `xcodebuild archive` printed ARCHIVE SUCCEEDED, `codesign --verify`
 * passed, and `pkgutil --check-signature` reported a valid Developer ID chain.
 * The notary service then returned Invalid, because Xcode had not enabled the
 * hardened runtime on the main executable. The fix is a deliberate re-sign with
 * `--options runtime` after export and before packaging, and the reason it is
 * encoded here rather than remembered is that nothing else in the toolchain
 * complains when it is missing.
 *
 * Every step asserts a property of what it produced. See ./release/verify.ts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  gatekeeperNotarized,
  notaryAccepted,
  parseNotaryStatus,
  parseSubmissionId,
  stapleValid,
  TEAM_ID,
  verifySigning,
} from "./release/verify.ts";

const APP_DIR = join(import.meta.dir, "..", "packages", "app", "macos");
const OUT = "/tmp/ompctl-macos-build";
const BUNDLE_ID = "ai.ompctl.app";
const NOTARY_PROFILE = "ompctl";
const APP_IDENTITY = `Developer ID Application: Jason Waldrip (${TEAM_ID})`;
const INSTALLER_IDENTITY = `Developer ID Installer: Jason Waldrip (${TEAM_ID})`;

function run(cmd: string, args: string[], opts: { cwd?: string } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function die(msg: string, detail?: string): never {
  console.error(`FAIL ${msg}`);
  if (detail)
    console.error(
      detail
        .split("\n")
        .slice(-12)
        .map(l => `  ${l}`)
        .join("\n"),
    );
  process.exit(1);
}

/** codesign display output for a path. */
function codesignInfo(path: string): string {
  const r = run("codesign", ["-d", "--verbose=2", path]);
  // codesign writes its report to stderr and exits 0; a failure exits nonzero.
  if (r.code !== 0) die(`codesign could not read ${path}`, r.out);
  return r.out;
}

function assertShippable(pkg: string) {
  if (!existsSync(pkg)) die(`no package at ${pkg}`);

  // 1. Gatekeeper must see a NOTARIZED source, not merely an accepted signature.
  const spctl = run("spctl", ["--assess", "--type", "install", "-vv", pkg]);
  if (!gatekeeperNotarized(spctl.out)) {
    die("Gatekeeper does not report a notarized Developer ID package", spctl.out);
  }

  // 2. A stapled ticket must be present, so the package installs offline.
  const staple = run("xcrun", ["stapler", "validate", pkg]);
  if (!stapleValid(staple.out)) die("no stapled notarization ticket", staple.out);

  console.log(`  ok ${pkg}`);
  console.log("     gatekeeper: notarized Developer ID");
  console.log("     staple: valid");
}

async function build() {
  rmSync(OUT, { recursive: true, force: true });

  console.log("archiving");
  const archivePath = join(OUT, "ompctl.xcarchive");
  const arch = run(
    "xcodebuild",
    [
      "archive",
      "-workspace",
      "ompd.xcworkspace",
      "-scheme",
      "ompd-macOS",
      "-configuration",
      "Release",
      "-destination",
      "generic/platform=macOS",
      "-archivePath",
      archivePath,
      `DEVELOPMENT_TEAM=${TEAM_ID}`,
      "CODE_SIGN_STYLE=Manual",
      "CODE_SIGN_IDENTITY=Developer ID Application",
    ],
    { cwd: APP_DIR },
  );
  if (arch.code !== 0 || !/ARCHIVE SUCCEEDED/.test(arch.out)) die("archive failed", arch.out);

  console.log("exporting");
  const exportDir = join(OUT, "export");
  const plist = join(OUT, "ExportOptions.plist");
  await Bun.write(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string>${TEAM_ID}</string>
  <key>signingStyle</key><string>automatic</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
</dict></plist>
`,
  );
  const exp = run("xcodebuild", [
    "-exportArchive",
    "-archivePath",
    archivePath,
    "-exportPath",
    exportDir,
    "-exportOptionsPlist",
    plist,
  ]);
  if (exp.code !== 0 || !/EXPORT SUCCEEDED/.test(exp.out)) die("export failed", exp.out);

  const app = join(exportDir, "ompctl.app");
  if (!existsSync(app)) die(`export produced no app at ${app}`);

  // The load-bearing step. Xcode does not set CS_RUNTIME here, and nothing below
  // this point objects until the notary service rejects the upload.
  console.log("re-signing with hardened runtime");
  const sign = run("codesign", [
    "--force",
    "--deep",
    "--options",
    "runtime",
    "--timestamp",
    "--sign",
    APP_IDENTITY,
    app,
  ]);
  if (sign.code !== 0) die("hardened-runtime re-sign failed", sign.out);

  const appInfo = codesignInfo(app);
  const appVerdict = verifySigning(appInfo, {
    leafPrefix: "Developer ID Application",
    bundleId: BUNDLE_ID,
    requireHardenedRuntime: true,
  });
  if (!appVerdict.ok) die("app signature is not notarizable", appVerdict.problems.join("\n"));
  console.log("  ok app: Developer ID Application, hardened runtime on");

  console.log("packaging");
  const pkg = join(OUT, "ompctl.pkg");
  const build = run("productbuild", ["--component", app, "/Applications", "--sign", INSTALLER_IDENTITY, pkg]);
  if (build.code !== 0 || !existsSync(pkg)) die("productbuild failed", build.out);

  console.log("notarizing");
  const sub = run("xcrun", ["notarytool", "submit", pkg, "--keychain-profile", NOTARY_PROFILE, "--wait"]);
  // notarytool exits 0 for a submission it tracked, including a rejected one.
  if (!notaryAccepted(sub.out)) {
    const id = parseSubmissionId(sub.out);
    const status = parseNotaryStatus(sub.out) ?? "unknown";
    let detail = sub.out;
    if (id) {
      const log = run("xcrun", ["notarytool", "log", id, "--keychain-profile", NOTARY_PROFILE]);
      detail = log.out;
    }
    die(`notarization returned ${status}`, detail);
  }
  console.log("  ok notary: Accepted");

  console.log("stapling");
  const staple = run("xcrun", ["stapler", "staple", pkg]);
  if (!stapleValid(staple.out)) die("stapling failed", staple.out);

  assertShippable(pkg);
  console.log(`\nshippable: ${pkg}`);
}

const [mode, arg] = process.argv.slice(2);
if (mode === "verify") {
  if (!arg) die("usage: release-macos.ts verify <pkg>");
  assertShippable(arg);
} else if (mode === "build") {
  await build();
} else {
  console.error("usage: release-macos.ts build | verify <pkg>");
  process.exit(2);
}
