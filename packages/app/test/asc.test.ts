import { describe, expect, test } from "bun:test";
import {
  assignmentResponseAccepted,
  buildStateCanProgress,
  groupBuildPagePath,
  selectBuildByPlatform,
} from "../scripts/asc.ts";

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
describe("App Store Connect processing transitions", () => {
  test("re-reads assignment after success or a concurrent-assignment conflict", () => {
    expect(assignmentResponseAccepted(204)).toBe(true);
    expect(assignmentResponseAccepted(409)).toBe(true);
    expect(assignmentResponseAccepted(500)).toBe(false);
  });

  test("waits only for missing or processing builds and fails on every terminal rejection", () => {
    expect(buildStateCanProgress(undefined)).toBe(true);
    expect(buildStateCanProgress("PROCESSING")).toBe(true);
    expect(buildStateCanProgress("VALID")).toBe(true);
    expect(buildStateCanProgress("FAILED")).toBe(false);
    expect(buildStateCanProgress("INVALID")).toBe(false);
    expect(buildStateCanProgress("EXPIRED")).toBe(false);
  });
});
describe("App Store Connect configuration", () => {
  test("refuses to infer a credential identity when the key id is absent", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/../scripts/asc.ts`, "builds"], {
      env: {
        ...process.env,
        OMPD_APP_ID: "test-app",
        OMPD_ASC_ISSUER_ID: "test-issuer",
        OMPD_ASC_KEY_ID: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain("OMPD_ASC_KEY_ID is required");
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
