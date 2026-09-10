import { describe, expect, test } from "bun:test";
import { groupBuildPagePath, selectBuildByPlatform } from "../scripts/asc.ts";

const builds = {
  data: [
    {
      id: "mac-build",
      attributes: { version: "869", processingState: "VALID" },
      relationships: { preReleaseVersion: { data: { id: "mac-release" } } },
    },
    {
      id: "ios-build",
      attributes: { version: "869", processingState: "VALID" },
      relationships: { preReleaseVersion: { data: { id: "ios-release" } } },
    },
  ],
  included: [
    { id: "mac-release", attributes: { platform: "MAC_OS" as const } },
    { id: "ios-release", attributes: { platform: "IOS" as const } },
  ],
};

describe("App Store Connect build selection", () => {
  test("selects the requested platform when iOS and macOS share a build number", () => {
    expect(selectBuildByPlatform(builds, "869", "IOS")?.id).toBe("ios-build");
    expect(selectBuildByPlatform(builds, "869", "MAC_OS")?.id).toBe("mac-build");
  });

  test("does not guess a platform when the relationship metadata is absent", () => {
    expect(selectBuildByPlatform({ data: builds.data }, "869", "IOS")).toBeUndefined();
  });
});

describe("App Store Connect tester-group pagination", () => {
  test("follows the provider's opaque cursor on the same collection", () => {
    expect(
      groupBuildPagePath(
        "group-id",
        "https://api.appstoreconnect.apple.com/v1/betaGroups/group-id/builds?cursor=opaque%3Avalue",
      ),
    ).toBe("/v1/betaGroups/group-id/builds?cursor=opaque%3Avalue");
  });

  test("rejects pagination links outside the expected origin or collection", () => {
    expect(() => groupBuildPagePath("group-id", "https://example.com/v1/betaGroups/group-id/builds?cursor=x")).toThrow(
      "invalid tester-group pagination link",
    );
    expect(() =>
      groupBuildPagePath("group-id", "https://api.appstoreconnect.apple.com/v1/betaGroups/other/builds?cursor=x"),
    ).toThrow("invalid tester-group pagination link");
  });
});
