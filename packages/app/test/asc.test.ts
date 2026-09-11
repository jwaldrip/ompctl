import { describe, expect, test } from "bun:test";
import {
  assignIfAutomaticReleaseIsCurrent,
  assignmentResponseAccepted,
  automaticReleaseIsCurrent,
  buildStateCanProgress,
  groupBuildPagePath,
  requestWithRetry,
  selectBuildByPlatform,
} from "../scripts/asc.ts";

function response(status: number, body = "{}", retryAfter: string | null = null) {
  return {
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? retryAfter : null) },
    text: async () => body,
  };
}
function githubResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
describe("App Store Connect request retries", () => {
  test("retries throttling and server failures before returning the successful response", async () => {
    const responses = [response(429, "{}", "1"), response(503), response(200, '{"data":[{"id":"build"}]}')];
    const sleeps: number[] = [];
    let calls = 0;
    const result = await requestWithRetry("GET", "/v1/builds", undefined, {
      fetcher: async () => {
        calls += 1;
        return responses.shift() ?? response(500);
      },
      token: async () => "token",
      sleep: async ms => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ status: 200, json: { data: [{ id: "build" }] } });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 3000]);
  });

  test("does not retry a definitive client rejection", async () => {
    let calls = 0;
    const result = await requestWithRetry("GET", "/v1/builds", undefined, {
      fetcher: async () => {
        calls += 1;
        return response(400, '{"errors":["bad request"]}');
      },
      token: async () => "token",
      sleep: async () => {},
    });
    expect(result.status).toBe(400);
    expect(calls).toBe(1);
  });
});

const builds = {
  data: [
    {
      id: "mac-build",
      attributes: { version: "869", processingState: "VALID", uploadedDate: "2026-09-10T06:00:00Z" },
      relationships: { preReleaseVersion: { data: { id: "mac-release" } } },
    },
    {
      id: "old-ios-build",
      attributes: { version: "869", processingState: "FAILED", uploadedDate: "2026-09-10T04:00:00Z" },
      relationships: { preReleaseVersion: { data: { id: "ios-release" } } },
    },
    {
      id: "ios-build",
      attributes: { version: "869", processingState: "VALID", uploadedDate: "2026-09-10T05:00:00Z" },
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

describe("automatic release tester assignment", () => {
  const env = {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REPOSITORY: "jwaldrip/ompctl",
    GITHUB_SHA: "current-sha",
    GH_TOKEN: "token",
  };

  test("allows explicit dispatch without consulting the moving main branch", async () => {
    let calls = 0;
    expect(
      await automaticReleaseIsCurrent({ GITHUB_EVENT_NAME: "workflow_dispatch" }, async () => {
        calls += 1;
        return githubResponse(500, {});
      }),
    ).toBe(true);
    expect(calls).toBe(0);
  });

  test("does not call the tester assignment mutation after a release loses main", async () => {
    let assignments = 0;
    expect(
      await assignIfAutomaticReleaseIsCurrent(
        async () => false,
        async () => {
          assignments += 1;
        },
      ),
    ).toBe(false);
    expect(assignments).toBe(0);

    expect(
      await assignIfAutomaticReleaseIsCurrent(
        async () => true,
        async () => {
          assignments += 1;
        },
      ),
    ).toBe(true);
    expect(assignments).toBe(1);
  });

  test("allows only the automatic release whose SHA is still main", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const current = await automaticReleaseIsCurrent(env, async (url, init) => {
      request = { url, init };
      return githubResponse(200, { sha: "current-sha" });
    });
    expect(current).toBe(true);
    expect(request?.url).toBe("https://api.github.com/repos/jwaldrip/ompctl/commits/main");
    expect(request?.init.headers).toMatchObject({ Authorization: "Bearer token" });
    expect(await automaticReleaseIsCurrent(env, async () => githubResponse(200, { sha: "newer-sha" }))).toBe(false);
  });

  test("fails closed when GitHub identity or main state is unreadable", async () => {
    await expect(
      automaticReleaseIsCurrent({ GITHUB_EVENT_NAME: "push" }, async () => githubResponse(200, {})),
    ).rejects.toThrow("GITHUB_REPOSITORY, GITHUB_SHA, and GH_TOKEN are required");
    await expect(automaticReleaseIsCurrent(env, async () => githubResponse(503, {}))).rejects.toThrow(
      "GitHub main commit lookup returned 503",
    );
    await expect(automaticReleaseIsCurrent(env, async () => githubResponse(200, {}))).rejects.toThrow(
      "GitHub main commit lookup returned no SHA",
    );
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
