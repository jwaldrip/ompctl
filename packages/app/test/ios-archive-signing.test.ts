import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const archiveScript = join(import.meta.dir, "..", "scripts", "ios-archive.sh");

function executable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

test("iOS archive uses the imported distribution profile without provisioning updates", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-ios-signing-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const out = join(root, "out");
  const profile = join(root, "profile.mobileprovision");
  const archiveLog = join(root, "xcodebuild-archive.args");
  const exportLog = join(root, "xcodebuild-export.args");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(profile, "fixture");
  executable(
    join(bin, "security"),
    `#!/bin/sh
cat <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Name</key><string>ompctl iOS App Store CI</string>
<key>UUID</key><string>00000000-0000-4000-8000-000000000001</string>
<key>TeamIdentifier</key><array><string>8H7HVPHS87</string></array>
<key>Entitlements</key><dict><key>application-identifier</key><string>8H7HVPHS87.ai.ompctl.app</string></dict>
<key>Platform</key><array><string>iOS</string></array>
</dict></plist>
PLIST
`,
  );
  executable(
    join(bin, "PlistBuddy"),
    `#!/bin/sh
case "$2" in
  "Print :Name") printf '%s\n' "ompctl iOS App Store CI" ;;
  "Print :UUID") printf '%s\n' "00000000-0000-4000-8000-000000000001" ;;
  "Print :TeamIdentifier:0") printf '%s\n' "8H7HVPHS87" ;;
  "Print :Entitlements:application-identifier") printf '%s\n' "8H7HVPHS87.ai.ompctl.app" ;;
  "Print :Platform:0") printf '%s\n' "iOS" ;;
  *) exit 1 ;;
esac
`,
  );
  executable(join(bin, "pod"), "#!/bin/sh\nexit 0\n");
  executable(
    join(bin, "bundle"),
    `#!/bin/sh
if [ "$1" = "install" ]; then exit 0; fi
if [ "$1" = "exec" ]; then shift; exec "$@"; fi
exit 1
`,
  );
  executable(
    join(bin, "xcodebuild"),
    `#!/bin/sh
if [ "$1" = "-exportArchive" ]; then
  printf '%s\n' "$@" > "$XCODE_EXPORT_LOG"
  exit 42
fi
printf '%s\n' "$@" > "$XCODE_ARCHIVE_LOG"
exit 0
`,
  );

  try {
    const child = Bun.spawn(["/bin/bash", archiveScript], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        XCODE_ARCHIVE_LOG: archiveLog,
        XCODE_EXPORT_LOG: exportLog,
        OMPD_APPLE_TEAM_ID: "8H7HVPHS87",
        OMPD_BUILD_NUMBER: "892",
        OMPD_VERSION_NAME: "1.0.1",
        OMPD_IOS_ARCHIVE_DIR: out,
        OMPD_IOS_PROFILE_PATH: profile,
        OMPD_PLIST_BUDDY: join(bin, "PlistBuddy"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 42, stderr: "" });
    const archiveArgs = (await Bun.file(archiveLog).text()).trim().split("\n");
    expect(archiveArgs).toContain("CODE_SIGN_STYLE=Manual");
    expect(archiveArgs).toContain("CODE_SIGN_IDENTITY=Apple Distribution");
    expect(archiveArgs).toContain("PROVISIONING_PROFILE_SPECIFIER=ompctl iOS App Store CI");
    expect(archiveArgs).toContain("CURRENT_PROJECT_VERSION=892");
    expect(archiveArgs).toContain("MARKETING_VERSION=1.0.1");
    expect(archiveArgs).not.toContain("-allowProvisioningUpdates");
    const exportArgs = (await Bun.file(exportLog).text()).trim().split("\n");
    expect(exportArgs).toContain("-exportArchive");
    expect(exportArgs).not.toContain("-allowProvisioningUpdates");
    expect(exportArgs).not.toContain("-authenticationKeyPath");
    const exportPlist = await Bun.file(join(out, "ExportOptions.plist")).text();
    expect(exportPlist).toContain("<string>ompctl iOS App Store CI</string>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone iOS cut archives with its installed distribution profile", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-ios-cut-signing-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const out = join(root, "out");
  const profile = join(root, "profile.mobileprovision");
  const key = join(root, "AuthKey_test.p8");
  const archiveLog = join(root, "xcodebuild-archive.args");
  const exportLog = join(root, "xcodebuild-export.args");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(profile, "fixture");
  writeFileSync(key, "fixture");
  executable(join(bin, "security"), "#!/bin/sh\nprintf '%s\n' fixture\n");
  executable(
    join(bin, "PlistBuddy"),
    `#!/bin/sh
case "$2" in
  "Print :Name") printf '%s\n' "Renamed iOS Profile CI" ;;
  "Print :UUID") printf '%s\n' "00000000-0000-4000-8000-000000000002" ;;
  "Print :TeamIdentifier:0") printf '%s\n' "8H7HVPHS87" ;;
  "Print :Entitlements:application-identifier") printf '%s\n' "8H7HVPHS87.ai.ompctl.app" ;;
  "Print :Platform:0") printf '%s\n' "iOS" ;;
  *) exit 1 ;;
esac
`,
  );
  executable(
    join(bin, "pod"),
    `#!/bin/sh
exit 0
`,
  );
  executable(
    join(bin, "xcodebuild"),
    `#!/bin/sh
if [ "$1" = "-exportArchive" ]; then
  printf '%s\n' "$@" > "$XCODE_EXPORT_LOG"
  exit 42
fi
printf '%s\n' "$@" > "$XCODE_ARCHIVE_LOG"
exit 0
`,
  );

  try {
    const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "..", "scripts", "cut-ios.sh")], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        XCODE_ARCHIVE_LOG: archiveLog,
        XCODE_EXPORT_LOG: exportLog,
        OMPD_ASC_KEY_PATH: key,
        OMPD_ASC_KEY_ID: "test",
        OMPD_ASC_ISSUER_ID: "issuer",
        OMPD_APPLE_TEAM_ID: "8H7HVPHS87",
        OMPD_BUILD_NUMBER: "892",
        OMPD_VERSION_NAME: "1.0.1",
        OMPD_IOS_BUILD_DIR: out,
        OMPD_IOS_PROVISIONING_PROFILE: profile,
        OMPD_PLIST_BUDDY: join(bin, "PlistBuddy"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 42, stderr: "" });
    const archiveArgs = (await Bun.file(archiveLog).text()).trim().split("\n");
    expect(archiveArgs).toContain("CODE_SIGN_STYLE=Manual");
    expect(archiveArgs).toContain("CODE_SIGN_IDENTITY=Apple Distribution");
    expect(archiveArgs).toContain("PROVISIONING_PROFILE_SPECIFIER=Renamed iOS Profile CI");
    expect(archiveArgs).not.toContain("-allowProvisioningUpdates");
    const exportArgs = (await Bun.file(exportLog).text()).trim().split("\n");
    expect(exportArgs).toContain("-exportArchive");
    expect(exportArgs).not.toContain("-allowProvisioningUpdates");
    expect(exportArgs).not.toContain("-authenticationKeyPath");
    const exportPlist = await Bun.file(join(out, "ExportOptions-manual.plist")).text();
    expect(exportPlist).toContain("<key>ai.ompctl.app</key><string>Renamed iOS Profile CI</string>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("standalone iOS cut refuses a mismatched profile before xcodebuild", async () => {
  const root = mkdtempSync(join(tmpdir(), "ompctl-ios-profile-mismatch-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const out = join(root, "out");
  const profile = join(root, "profile.mobileprovision");
  const key = join(root, "AuthKey_test.p8");
  const xcodeMarker = join(root, "xcodebuild-called");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(profile, "fixture");
  writeFileSync(key, "fixture");
  executable(join(bin, "security"), "#!/bin/sh\nprintf '%s\n' fixture\n");
  executable(
    join(bin, "PlistBuddy"),
    `#!/bin/sh
case "$2" in
  "Print :Name") printf '%s\n' "Wrong Team Profile" ;;
  "Print :UUID") printf '%s\n' "00000000-0000-4000-8000-000000000003" ;;
  "Print :TeamIdentifier:0") printf '%s\n' "WRONGTEAM" ;;
  "Print :Entitlements:application-identifier") printf '%s\n' "WRONGTEAM.ai.ompctl.app" ;;
  "Print :Platform:0") printf '%s\n' "iOS" ;;
  *) exit 1 ;;
esac
`,
  );
  executable(join(bin, "xcodebuild"), '#!/bin/sh\ntouch "$XCODE_MARKER"\n');

  try {
    const child = Bun.spawn(["/bin/bash", join(import.meta.dir, "..", "scripts", "cut-ios.sh")], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        XCODE_MARKER: xcodeMarker,
        OMPD_ASC_KEY_PATH: key,
        OMPD_ASC_KEY_ID: "test",
        OMPD_ASC_ISSUER_ID: "issuer",
        OMPD_APPLE_TEAM_ID: "8H7HVPHS87",
        OMPD_BUILD_NUMBER: "892",
        OMPD_VERSION_NAME: "1.0.1",
        OMPD_IOS_BUILD_DIR: out,
        OMPD_IOS_PROVISIONING_PROFILE: profile,
        OMPD_PLIST_BUDDY: join(bin, "PlistBuddy"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("provisioning profile does not match platform, team, and bundle id");
    expect(await Bun.file(xcodeMarker).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
