import { describe, expect, test } from "bun:test";
import { retireInfra } from "./cli.ts";
import { StatefulHttpMirror } from "./mirror.ts";
import type { DnsObservation, DnsResolver, ParentServerQuery } from "./types.ts";

function createMockResolver(params: {
  delegatesToCloudDns?: boolean;
  allParentsAgree?: boolean;
  parentStatus?: string;
  hasDs?: boolean;
  hostRecordTarget?: string;
}): DnsResolver {
  const delegates = params.delegatesToCloudDns ?? false;
  const agree = params.allParentsAgree ?? true;
  const status = params.parentStatus ?? "NOERROR";

  return {
    async queryParentNs(server: string, _domain: string): Promise<ParentServerQuery> {
      let nsNames = delegates
        ? [
            { name: "ns-cloud-c1.googledomains.com", ttl: 3600 },
            { name: "ns-cloud-c2.googledomains.com", ttl: 3600 },
          ]
        : [
            { name: "dns1.registrar-servers.com", ttl: 3600 },
            { name: "dns2.registrar-servers.com", ttl: 3600 },
          ];

      if (!agree && server === "f.nic.ai") {
        nsNames = [{ name: "ns-cloud-c3.googledomains.com", ttl: 3600 }];
      }

      return {
        server,
        status,
        nameservers: nsNames,
        dsRecords: params.hasDs ? [{ data: "12345 8 2 mockdigest", ttl: 3600 }] : [],
      };
    },
    async queryHost(_host: string) {
      const target = params.hostRecordTarget ?? "192.0.2.1";
      return [{ type: "A", value: target, ttl: 300 }];
    },
  };
}

function createMockObservation(params: {
  kind: "baseline" | "cutover";
  gitSha?: string;
  delegatesToCloudDns?: boolean;
  allParentsAgree?: boolean;
  capturedAt?: string;
  oldMaxChildNsTtl?: number;
  hasDs?: boolean;
}): DnsObservation {
  const delegates = params.delegatesToCloudDns ?? false;
  const agree = params.allParentsAgree ?? true;

  const parentQueries: ParentServerQuery[] = [
    "a.nic.ai",
    "b.nic.ai",
    "c.nic.ai",
    "d.nic.ai",
    "e.nic.ai",
    "f.nic.ai",
  ].map((server) => {
    let nameservers = delegates
      ? [{ name: "ns-cloud-c1.googledomains.com", ttl: 3600 }]
      : [{ name: "dns1.registrar-servers.com", ttl: 3600 }];
    if (!agree && server === "f.nic.ai") {
      nameservers = [{ name: "ns-cloud-c2.googledomains.com", ttl: 3600 }];
    }
    return {
      server,
      status: "NOERROR",
      nameservers,
      dsRecords: params.hasDs ? [{ data: "12345 8 2 digest", ttl: 3600 }] : [],
    };
  });

  return {
    observationKind: params.kind,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    gitSha: params.gitSha ?? "3662016072646338c3e1cca236b27c9dc7a4f219",
    workflowRunId: "run-100",
    parentQueries,
    oldMaxChildNsTtl: params.oldMaxChildNsTtl ?? 21600,
    hostRecordObservations: [
      { host: "ompctl.ai", records: [{ type: "A", value: "192.0.2.1", ttl: 300 }] },
    ],
    allParentsAgree: agree,
    delegatesToCloudDns: delegates,
  };
}

describe("Retirement Orchestrator & Stateful Mirror Execution Proof", () => {
  const TEST_SHA = "3662016072646338c3e1cca236b27c9dc7a4f219";

  test("1. Rejects wrong live project ID or number", async () => {
    const mirror = new StatefulHttpMirror({
      projectId: "ompctl",
      projectNumber: "999999999999", // Mismatched project number
    });

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });

    const baselinePath = "/tmp/test-baseline-1.json";
    const cutoverPath = "/tmp/test-cutover-1.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    const p = retireInfra({
      operation: "retire",
      targetProjectId: "ompctl",
      targetProjectNumber: "782181616134",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(p).rejects.toThrow(/Project number mismatch/);
    expect(mirror.lifecycleState).toBe("ACTIVE");
  });

  test("2. Rejects missing confirmation or invalid execution ref", async () => {
    const mirror = new StatefulHttpMirror();

    // Bad confirmation
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "WRONG-TOKEN",
        executionRef: "refs/heads/main",
        transport: mirror,
      })
    ).rejects.toThrow(/Confirmation guard failed/);

    // Bad ref (e.g. branch or pr)
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/feature-branch",
        transport: mirror,
      })
    ).rejects.toThrow(/Execution ref guard failed/);

    expect(mirror.requestLog.length).toBe(0);
  });

  test("3 & 4. Uses real REST route and halts on testIamPermissions failure", async () => {
    const mirror = new StatefulHttpMirror({
      failTestIam: { status: 403, body: { error: { code: 403, message: "Forbidden" } } },
    });

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-3.json";
    const cutoverPath = "/tmp/test-cutover-3.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    const p = retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(p).rejects.toThrow(/testIamPermissions failed on project 'ompctl' \(HTTP 403\)/);
    // Verify real REST endpoint was targeted
    const req = mirror.requestLog.find((r) => r.url.includes(":testIamPermissions"));
    expect(req).toBeDefined();
    expect(req?.method).toBe("POST");
    expect(mirror.lifecycleState).toBe("ACTIVE");
  });

  test("5. Missing IAM-write permission, grant not effective, and conflicting etag", async () => {
    // 5a: getIamPolicy fails with 403
    const mirrorGetFail = new StatefulHttpMirror({
      failGetIamPolicy: { status: 403, body: { error: { message: "Cannot get policy" } } },
    });
    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-5.json";
    const cutoverPath = "/tmp/test-cutover-5.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirrorGetFail,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/getIamPolicy failed/);

    // 5b: setIamPolicy fails with 409 etag conflict
    const mirrorEtagConflict = new StatefulHttpMirror({
      simulateEtagMismatch: true,
    });
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirrorEtagConflict,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/setIamPolicy failed to grant projectDeleter \(HTTP 409\)/);

    // 5c: Grant not effective
    const mirrorNotEffective = new StatefulHttpMirror({
      grantNotEffective: true,
    });
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirrorNotEffective,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Project deletion permission guard failed/);
  });

  test("6. Preserves unrelated and conditional IAM bindings when granting projectDeleter", async () => {
    const mirror = new StatefulHttpMirror();
    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-6.json";
    const cutoverPath = "/tmp/test-cutover-6.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    // Check that existing conditional binding (auditor) and owner binding are preserved
    const bindings = mirror.iamPolicy.bindings;
    const auditor = bindings.find((b) => b.role === "roles/viewer");
    expect(auditor?.condition).toBeDefined();
    expect(auditor?.condition?.title).toBe("expires_2027");

    const owner = bindings.find((b) => b.role === "roles/owner");
    expect(owner?.members).toContain("user:jason@waldrip.net");

    const deleter = bindings.find((b) => b.role === "roles/resourcemanager.projectDeleter");
    expect(deleter?.members).toContain("serviceAccount:ompctl-deployer@ompctl.iam.gserviceaccount.com");
  });

  test("7. Discovers and halts on liens located on later pagination page", async () => {
    const mirror = new StatefulHttpMirror({
      liensPageSize: 1,
      initialLiens: [
        { name: "liens/notice-only", reason: "not-blocking", parent: "projects/782181616134" },
        { name: "liens/critical-lien", reason: "disaster recovery lock", parent: "projects/782181616134" },
      ],
    });

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-7.json";
    const cutoverPath = "/tmp/test-cutover-7.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Project has active deletion liens/);

    // Verify pagination requests were made
    const liensRequests = mirror.requestLog.filter((r) => r.url.includes("/liens"));
    expect(liensRequests.length).toBeGreaterThanOrEqual(2);
    expect(mirror.lifecycleState).toBe("ACTIVE");
  });

  test("8. Halts on unexpired TTL or bad DNS cutover evidence", async () => {
    const mirror = new StatefulHttpMirror();
    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-8.json";
    const cutoverPath = "/tmp/test-cutover-8.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    // Case 8a: Unexpired TTL (only 10 seconds elapsed)
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 10 * 1000,
        expectedSha: TEST_SHA,
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/elapsed time since cutover .* has not exceeded the required old TTL window/);

    // Case 8b: Cutover artifact still delegates to Cloud DNS
    const badCutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: true, gitSha: TEST_SHA });
    await Bun.write(cutoverPath, JSON.stringify(badCutover));

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/cutover observation indicates domain still delegates to Cloud DNS/);
  });

  test("9. Pages authorization failure and unsuccessful readback stops execution", async () => {
    // 9a: Pages DELETE fails with 403
    const mirrorPagesFail = new StatefulHttpMirror({
      failPagesDelete: { status: 403, body: { message: "Resource not accessible by integration" } },
    });

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-9.json";
    const cutoverPath = "/tmp/test-cutover-9.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirrorPagesFail,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Failed to unpublish GitHub Pages \(HTTP 403\)/);

    expect(mirrorPagesFail.lifecycleState).toBe("ACTIVE");
  });

  test("10. Partial success: Pages already removed (404) allows project shutdown to proceed", async () => {
    const mirror = new StatefulHttpMirror({
      initialPagesPublished: false, // Pages already deleted
    });

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-10.json";
    const cutoverPath = "/tmp/test-cutover-10.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    const res = await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(res.success).toBe(true);
    expect(res.projectShutdownAccepted).toBe(true);
    expect(mirror.lifecycleState).toBe("DELETE_REQUESTED");
  });

  test("11. Rejected project delete halts and preserves status details", async () => {
    const mirror = new StatefulHttpMirror({
      failProjectDelete: { status: 400, body: { error: { code: 400, message: "Precondition failed" } } },
    });

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-11.json";
    const cutoverPath = "/tmp/test-cutover-11.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Project shutdown failed \(HTTP 400\)/);

    expect(mirror.lifecycleState).toBe("ACTIVE");
  });

  test("12. Successful v1 delete response followed by independent mirror owner read of DELETE_REQUESTED", async () => {
    const mirror = new StatefulHttpMirror();

    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-12.json";
    const cutoverPath = "/tmp/test-cutover-12.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    const res = await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(res.success).toBe(true);
    expect(res.projectShutdownAccepted).toBe(true);

    // Independent owner read of the mirror
    const ownerReadRes = await mirror.fetch("https://cloudresourcemanager.googleapis.com/v1/projects/ompctl");
    const ownerData = (await ownerReadRes.json()) as { projectId: string; projectNumber: string; lifecycleState: string };
    expect(ownerData.projectId).toBe("ompctl");
    expect(ownerData.projectNumber).toBe("782181616134");
    expect(ownerData.lifecycleState).toBe("DELETE_REQUESTED");
  });

  test("13. Read-only observe operation produces zero mutation requests", async () => {
    const mirror = new StatefulHttpMirror();
    const outObs = "/tmp/test-observe-out.json";

    const res = await retireInfra({
      operation: "observe",
      outObservationPath: outObs,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    expect(res.success).toBe(true);
    expect(res.observation).toBeDefined();

    // Verify ZERO mutation requests in mirror
    const mutationCalls = mirror.requestLog.filter(
      (r) => r.method === "DELETE" || r.method === "POST" || r.method === "PUT" || r.method === "PATCH"
    );
    expect(mutationCalls.length).toBe(0);
  });

  test("14. No request targets another project, organization, billing account, or repository", async () => {
    const mirror = new StatefulHttpMirror();
    const baseline = createMockObservation({ kind: "baseline", delegatesToCloudDns: true, gitSha: TEST_SHA });
    const cutover = createMockObservation({ kind: "cutover", delegatesToCloudDns: false, gitSha: TEST_SHA });
    const baselinePath = "/tmp/test-baseline-14.json";
    const cutoverPath = "/tmp/test-cutover-14.json";
    await Bun.write(baselinePath, JSON.stringify(baseline));
    await Bun.write(cutoverPath, JSON.stringify(cutover));

    await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    for (const req of mirror.requestLog) {
      if (req.url.startsWith("https://cloudresourcemanager.googleapis.com")) {
        expect(req.url).toMatch(/projects\/ompctl/);
        expect(req.url).not.toMatch(/organizations\//);
        expect(req.url).not.toMatch(/billingAccounts\//);
      }
      if (req.url.startsWith("https://api.github.com")) {
        expect(req.url).toMatch(/repos\/jwaldrip\/ompctl/);
      }
    }
  });
});
