import { describe, expect, test } from "bun:test";
import {
  checkPlatformManifests,
  inspectAndroidGradleContent,
  inspectMacosRandomBridge,
  inspectPlistContent,
  inspectWindowsManifestContent,
  missingFontRegistrations,
} from "../scripts/check-platform-manifests.ts";

const REAL_MODULE = `
@interface OmpctlRandomValues : NSObject <RCTBridgeModule>
@end
@implementation OmpctlRandomValues
RCT_EXPORT_MODULE(RNGetRandomValues)
RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getRandomBase64:(double)byteLength)
{
  return nil;
}
@end
`;
const REAL_PBXPROJ = `		514201652437B4B40078DB4F /* OmpctlRandomValues.m in Sources */,`;

describe("checkPlatformManifests", () => {
  test("current repository manifests pass without violations", () => {
    const violations = checkPlatformManifests();
    expect(violations).toEqual([]);
  });

  describe("inspectPlistContent", () => {
    test("detects parameterized values", () => {
      const sample = `
<dict>
  <key>CFBundleShortVersionString</key>
  <string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key>
  <string>$(CURRENT_PROJECT_VERSION)</string>
</dict>`;
      const res = inspectPlistContent(sample);
      expect(res.buildVersion).toBe("$(CURRENT_PROJECT_VERSION)");
      expect(res.marketingVersion).toBe("$(MARKETING_VERSION)");
    });

    test("detects hardcoded literals", () => {
      const sample = `
<dict>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
</dict>`;
      const res = inspectPlistContent(sample);
      expect(res.buildVersion).toBe("1");
      expect(res.marketingVersion).toBe("1.0");
    });
  });

  describe("inspectWindowsManifestContent", () => {
    test("detects parameterized $(PackageVersion)", () => {
      const sample = `<Package><Identity Name="ompctl" Version="$(PackageVersion)" /></Package>`;
      const res = inspectWindowsManifestContent(sample);
      expect(res.version).toBe("$(PackageVersion)");
    });

    test("detects hardcoded literal quad version", () => {
      const sample = `<Package><Identity Name="ompctl" Version="1.0.0.0" /></Package>`;
      const res = inspectWindowsManifestContent(sample);
      expect(res.version).toBe("1.0.0.0");
    });
  });

  describe("inspectAndroidGradleContent", () => {
    test("detects property lookup expression", () => {
      const sample = `
defaultConfig {
    versionCode Integer.parseInt(project.findProperty("OMPD_BUILD_NUMBER") ?: "1")
}
`;
      const res = inspectAndroidGradleContent(sample);
      expect(res.isLiteral).toBe(false);
      expect(res.versionCodeExpr).toContain("OMPD_BUILD_NUMBER");
    });

    test("flags hardcoded literal integer", () => {
      const sample = `
defaultConfig {
    versionCode 1
}
`;
      const res = inspectAndroidGradleContent(sample);
      expect(res.isLiteral).toBe(true);
      expect(res.versionCodeExpr).toBe("1");
    });
  });

  describe("inspectMacosRandomBridge", () => {
    test("accepts the shipped macOS crypto bridge", () => {
      const res = inspectMacosRandomBridge({ module: REAL_MODULE, pbxproj: REAL_PBXPROJ });
      expect(res).toEqual({ exportsModule: true, exportsSyncMethod: true, compiled: true });
    });

    test("a missing module file is the failure the Mac actually shipped", () => {
      const res = inspectMacosRandomBridge({ module: null, pbxproj: REAL_PBXPROJ });
      expect(res.exportsModule).toBe(false);
      expect(res.exportsSyncMethod).toBe(false);
    });

    test("registering under the class name rather than RNGetRandomValues is not a registration", () => {
      const res = inspectMacosRandomBridge({
        module: REAL_MODULE.replace("RCT_EXPORT_MODULE(RNGetRandomValues)", "RCT_EXPORT_MODULE()"),
        pbxproj: REAL_PBXPROJ,
      });
      expect(res.exportsModule).toBe(false);
    });

    test("an async export cannot serve getRandomValues", () => {
      const res = inspectMacosRandomBridge({
        module: REAL_MODULE.replace("RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD", "RCT_EXPORT_METHOD"),
        pbxproj: REAL_PBXPROJ,
      });
      expect(res.exportsSyncMethod).toBe(false);
    });

    test("a source file the target never compiles registers nothing", () => {
      const res = inspectMacosRandomBridge({
        module: REAL_MODULE,
        pbxproj: "		514201612437B4B40078DB4F /* OmpctlCamera.m in Sources */,",
      });
      expect(res.compiled).toBe(false);
    });
  });
});

describe("missingFontRegistrations", () => {
  const VALID_SOURCES = {
    iosPlist: `
<plist version="1.0">
<dict>
	<key>UIAppFonts</key>
	<array>
		<string>Archivo-Regular.ttf</string>
		<string>SymbolsNF.ttf</string>
	</array>
</dict>
</plist>`,
    iosPbxproj: `
		F04700010000000000000011 /* Archivo-Regular.ttf in Resources */ = {isa = PBXBuildFile; };
		F04700010000000000000012 /* SymbolsNF.ttf in Resources */ = {isa = PBXBuildFile; };
`,
    macosPbxproj: `
		F04700020000000000000011 /* Archivo-Regular.ttf in Resources */ = {isa = PBXBuildFile; };
		F04700020000000000000012 /* SymbolsNF.ttf in Resources */ = {isa = PBXBuildFile; };
`,
    macosPlist: `
<plist version="1.0">
<dict>
	<key>ATSApplicationFontsPath</key>
	<string>.</string>
</dict>
</plist>`,
    indexHtml: `
<!DOCTYPE html>
<html>
  <head>
    <style>
      @font-face {
        font-family: "Archivo-Regular";
        src: url("/src/design/fonts/Archivo-Regular.ttf") format("truetype");
      }
      @font-face {
        font-family: "SymbolsNF";
        src: url("/src/design/fonts/SymbolsNF.ttf") format("truetype");
      }
    </style>
  </head>
</html>`,
  };

  test("all registered gives no violations", () => {
    const violations = missingFontRegistrations(["Archivo-Regular.ttf", "SymbolsNF.ttf"], VALID_SOURCES);
    expect(violations).toEqual([]);
  });

  test("a font missing from only UIAppFonts gives exactly that one violation, not fooled by comments or other keys", () => {
    const sources = {
      ...VALID_SOURCES,
      iosPlist: `
<plist version="1.0">
<dict>
	<!-- Mentioning SymbolsNF.ttf here in a comment must not register it -->
	<key>CommentNote</key>
	<string>SymbolsNF.ttf</string>
	<key>UIAppFonts</key>
	<array>
		<string>Archivo-Regular.ttf</string>
	</array>
</dict>
</plist>`,
    };
    const violations = missingFontRegistrations(["Archivo-Regular.ttf", "SymbolsNF.ttf"], sources);
    expect(violations).toEqual([
      {
        file: "ios/ompd/Info.plist",
        field: "UIAppFonts",
        expected: "SymbolsNF.ttf",
        actual: "missing",
      },
    ]);
  });

  test("a font missing from macOS Resources", () => {
    const sources = {
      ...VALID_SOURCES,
      macosPbxproj: `
		F04700020000000000000011 /* Archivo-Regular.ttf in Resources */ = {isa = PBXBuildFile; };
`,
    };
    const violations = missingFontRegistrations(["Archivo-Regular.ttf", "SymbolsNF.ttf"], sources);
    expect(violations).toEqual([
      {
        file: "macos/ompd.xcodeproj/project.pbxproj",
        field: "Resources",
        expected: "SymbolsNF.ttf",
        actual: "missing",
      },
    ]);
  });

  test("missing @font-face", () => {
    const sources = {
      ...VALID_SOURCES,
      indexHtml: `
<!DOCTYPE html>
<html>
  <head>
    <style>
      @font-face {
        font-family: "Archivo-Regular";
        src: url("/src/design/fonts/Archivo-Regular.ttf") format("truetype");
      }
    </style>
  </head>
</html>`,
    };
    const violations = missingFontRegistrations(["Archivo-Regular.ttf", "SymbolsNF.ttf"], sources);
    expect(violations).toEqual([
      {
        file: "index.html",
        field: "@font-face",
        expected: "SymbolsNF.ttf",
        actual: "missing",
      },
    ]);
  });

  test("missing ATSApplicationFontsPath", () => {
    const sources = {
      ...VALID_SOURCES,
      macosPlist: `
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>ompd</string>
</dict>
</plist>`,
    };
    const violations = missingFontRegistrations(["Archivo-Regular.ttf", "SymbolsNF.ttf"], sources);
    expect(violations).toEqual([
      {
        file: "macos/ompd-macOS/Info.plist",
        field: "ATSApplicationFontsPath",
        expected: ".",
        actual: "missing",
      },
    ]);
  });
});
