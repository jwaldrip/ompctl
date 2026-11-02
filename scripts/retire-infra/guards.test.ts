import { describe, expect, test } from "bun:test";
import { retireInfra } from "./cli.ts";
import { StatefulHttpMirror } from "./mirror.ts";
import {
  AUTHORITATIVE_PARENT_SERVERS,
  type DnsResolver,
  type HostRecordObservation,
  type ParentServerQuery,
} from "./types.ts";

function createMockResolver(params: {
  delegatesToCloudDns?: boolean;
  allParentsAgree?: boolean;
  parentStatus?: string;
  hasDs?: boolean;
  childNsTtl?: number;
  hostRecordTarget?: string;
  hostQueryStatus?: string;
}): DnsResolver {
  const delegates = params.delegatesToCloudDns ?? false;
  const agree = params.allParentsAgree ?? true;
  const status = params.parentStatus ?? "NOERROR";

  return {
    async queryParentNsAndDs(server: string, _domain: string): Promise<ParentServerQuery> {
      let nsNames = delegates
        ? [
            { name: "ns-cloud-c1.googledomains.com", ttl: 3600 },
            { name: "ns-cloud-c2.googledomains.com", ttl: 3600 },
          ]
        : [
            { name: "dns1.registrar-servers.com", ttl: 3600 },
            { name: "dns2.registrar-servers.com", ttl: 3600 },
          ];

      if (!agree && server === "v2n1.nic.ai") {
        nsNames = [{ name: "ns-cloud-c3.googledomains.com", ttl: 3600 }];
      }

      return {
        server,
        status,
        nameservers: nsNames,
        dsRecords: params.hasDs ? [{ data: "12345 8 2 mockdigest", ttl: 3600 }] : [],
        hasAuthoritativeDenial: !params.hasDs,
      };
    },

    async queryChildNs(_server: string, _domain: string) {
      return [
        { name: "ns-cloud-c1.googledomains.com", ttl: params.childNsTtl ?? 21600 },
        { name: "ns-cloud-c2.googledomains.com", ttl: params.childNsTtl ?? 21600 },
      ];
    },

    async queryHostRecord(host: string, type: string): Promise<HostRecordObservation> {
      const qStatus = params.hostQueryStatus ?? "NOERROR";
      const target = params.hostRecordTarget ?? "192.0.2.1";

      return {
        host,
        recordType: type,
        status: qStatus,
        records: qStatus === "NOERROR" ? [{ type, value: target, ttl: 300 }] : [],
        error: qStatus !== "NOERROR" ? `DNS query failed with ${qStatus}` : undefined,
      };
    },
  };
}

describe("Guarded Direct Project Shutdown Execution Proof", () => {
  const TEST_SHA = "3662016072646338c3e1cca236b27c9dc7a4f219";

  test("1. Rejects wrong live project ID or number", async () => {
    const mirror = new StatefulHttpMirror({
      projectId: "ompctl",
      projectNumber: "999999999999", // Mismatched project number
    });

    const baselinePath = "/tmp/proof-baseline-1.json";
    const cutoverPath = "/tmp/proof-cutover-1.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

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
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(p).rejects.toThrow(/Project number mismatch/);
    expect(mirror.lifecycleState).toBe("ACTIVE");
  });

  test("2. Rejects missing confirmation or invalid execution ref", async () => {
    const mirror = new StatefulHttpMirror();

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "WRONG-CONFIRMATION",
        executionRef: "refs/heads/main",
        transport: mirror,
      })
    ).rejects.toThrow(/Confirmation guard failed/);

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/some-feature",
        transport: mirror,
      })
    ).rejects.toThrow(/Execution ref guard failed/);

    expect(mirror.requestLog.length).toBe(0);
  });

  test("3 & 4. Enforces OAuth access token and halts on permission failure", async () => {
    const mirror = new StatefulHttpMirror();

    const baselinePath = "/tmp/proof-baseline-3.json";
    const cutoverPath = "/tmp/proof-cutover-3.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    // 4a: Missing/empty GCP token results in 401 Unauthorized
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        gcpToken: "", // Empty token
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/HTTP 401/);

    // 4b: testIamPermissions returns 403
    const mirrorIamFail = new StatefulHttpMirror({
      failTestIam: { status: 403, body: { error: { code: 403, message: "Caller lacks permissions" } } },
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
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirrorIamFail,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/testIamPermissions failed on project 'ompctl' \(HTTP 403\)/);
  });

  test("5. Checks deletion liens via real /v1/liens route BEFORE any IAM write", async () => {
    const mirrorWithLien = new StatefulHttpMirror({
      initialLiens: [{ name: "liens/active-lock", reason: "backup hold", parent: "projects/782181616134" }],
    });

    const baselinePath = "/tmp/proof-baseline-5.json";
    const cutoverPath = "/tmp/proof-cutover-5.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
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
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirrorWithLien,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Project has active deletion liens/);

    // Verify /v1/liens was queried with parent param
    const liensReq = mirrorWithLien.requestLog.find((r) => r.url.includes("/v1/liens"));
    expect(liensReq).toBeDefined();
    expect(liensReq?.url).toContain("parent=projects%2F782181616134");

    // Verify ZERO IAM mutation requests were issued before lien check halted
    const setIamReq = mirrorWithLien.requestLog.find((r) => r.url.includes(":setIamPolicy"));
    expect(setIamReq).toBeUndefined();
    expect(mirrorWithLien.lifecycleState).toBe("ACTIVE");
  });

  test("6. Detects active deployment runs and excludes retirement run itself", async () => {
    const mirrorRuns = new StatefulHttpMirror({
      initialWorkflowRuns: [
        {
          id: 55555,
          name: "hub-deploy",
          path: ".github/workflows/hub-deploy.yml",
          head_branch: "main",
          head_sha: TEST_SHA,
          status: "in_progress",
          conclusion: null,
          updated_at: new Date().toISOString(),
        },
        {
          id: 99999,
          name: "retire-infra",
          path: ".github/workflows/retire-infra.yml",
          head_branch: "main",
          head_sha: TEST_SHA,
          status: "in_progress",
          conclusion: null,
          updated_at: new Date().toISOString(),
        },
      ],
    });

    const baselinePath = "/tmp/proof-baseline-6.json";
    const cutoverPath = "/tmp/proof-cutover-6.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    // 6a: Active hub-deploy run causes fail closed
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        currentRunId: "99999", // Retirement run ID
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirrorRuns,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Active deployment or publication runs detected: \[hub-deploy/);

    // 6b: When active hub-deploy completes, current retirement run (99999) does not self-block
    mirrorRuns.workflowRuns[0].status = "completed";
    mirrorRuns.workflowRuns[0].conclusion = "success";

    const res = await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      currentRunId: "99999",
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirrorRuns,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(res.success).toBe(true);
    expect(res.projectShutdownAccepted).toBe(true);
    expect(mirrorRuns.lifecycleState).toBe("DELETE_REQUESTED");
  });

  test("7. Genuine observe -> artifact -> retire path with IANA parent servers", async () => {
    const mirror = new StatefulHttpMirror();
    const baselinePath = "/tmp/proof-baseline-7.json";
    const cutoverPath = "/tmp/proof-cutover-7.json";

    // 1. Observe baseline
    const baseRes = await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });
    expect(baseRes.observation?.delegatesToCloudDns).toBe(true);
    expect(baseRes.observation?.parentQueries.map((q) => q.server)).toEqual([
      ...AUTHORITATIVE_PARENT_SERVERS,
    ]);

    // 2. Observe cutover
    const cutRes = await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });
    expect(cutRes.observation?.delegatesToCloudDns).toBe(false);
    expect(cutRes.observation?.allParentsAgree).toBe(true);

    // 3. Retire
    const retireRes = await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000, // > 21600s elapsed
      expectedSha: TEST_SHA,
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    expect(retireRes.success).toBe(true);
    expect(retireRes.projectShutdownAccepted).toBe(true);
    expect(mirror.lifecycleState).toBe("DELETE_REQUESTED");
  });

  test("8. Halts on unexpired TTL or bad cutover evidence", async () => {
    const mirror = new StatefulHttpMirror();
    const baselinePath = "/tmp/proof-baseline-8.json";
    const cutoverPath = "/tmp/proof-cutover-8.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    // Elapsed time is only 100 seconds (less than 21600 seconds)
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 100 * 1000,
        expectedSha: TEST_SHA,
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/elapsed time since cutover .* has not exceeded the required old TTL window/);
  });

  test("9. Halts if DS record appears on parent (DNSSEC safeguard)", async () => {
    const mirror = new StatefulHttpMirror();
    const baselinePath = "/tmp/proof-baseline-9.json";
    const cutoverPath = "/tmp/proof-cutover-9.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    // Cutover resolver simulates DS record appearing
    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false, hasDs: true }),
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
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false, hasDs: true }),
      })
    ).rejects.toThrow(/unexpected DS record present on parent/);
  });

  test("10. Halts if retired host still resolves to retired IPs or CNAMEs", async () => {
    const mirror = new StatefulHttpMirror();
    const baselinePath = "/tmp/proof-baseline-10.json";
    const cutoverPath = "/tmp/proof-cutover-10.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    // Resolver returns GitHub Pages apex IP 185.199.108.153
    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        cutoverTimestampMs: Date.now() - 30000 * 1000,
        expectedSha: TEST_SHA,
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false, hostRecordTarget: "185.199.108.153" }),
      })
    ).rejects.toThrow(/still resolves to retired IP destination '185.199.108.153'/);
  });

  test("11. Preserves conditional bindings and requestedPolicyVersion: 3 in getIamPolicy", async () => {
    const mirror = new StatefulHttpMirror();
    const baselinePath = "/tmp/proof-baseline-11.json";
    const cutoverPath = "/tmp/proof-cutover-11.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    // Check request body for requestedPolicyVersion
    const getIamReq = mirror.requestLog.find((r) => r.url.includes(":getIamPolicy"));
    expect(getIamReq?.body).toEqual({ options: { requestedPolicyVersion: 3 } });

    // Check policy preserves conditional binding
    const auditor = mirror.iamPolicy.bindings.find((b) => b.role === "roles/viewer");
    expect(auditor?.condition?.title).toBe("expires_2027");

    // Check deployer was granted projectDeleter
    const deleter = mirror.iamPolicy.bindings.find((b) => b.role === "roles/resourcemanager.projectDeleter");
    expect(deleter?.members).toContain("serviceAccount:ompctl-deployer@ompctl.iam.gserviceaccount.com");
  });

  test("12. Pages authorization failure and absence readback handling", async () => {
    const mirrorPagesFail = new StatefulHttpMirror({
      failPagesDelete: { status: 403, body: { message: "Permission denied" } },
    });

    const baselinePath = "/tmp/proof-baseline-12.json";
    const cutoverPath = "/tmp/proof-cutover-12.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
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
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirrorPagesFail,
        dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
      })
    ).rejects.toThrow(/Failed to unpublish GitHub Pages \(HTTP 403\)/);

    expect(mirrorPagesFail.lifecycleState).toBe("ACTIVE");
  });

  test("13. Read-only observe produces zero mutation requests", async () => {
    const mirror = new StatefulHttpMirror();
    const outObs = "/tmp/test-observe-zero-mutation.json";

    const res = await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: outObs,
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    expect(res.success).toBe(true);
    const mutations = mirror.requestLog.filter(
      (r) => r.method === "DELETE" || r.method === "POST" || r.method === "PUT" || r.method === "PATCH"
    );
    expect(mutations.length).toBe(0);
  });

  test("14. Scope containment: zero requests target other projects or orgs", async () => {
    const mirror = new StatefulHttpMirror();
    const baselinePath = "/tmp/proof-baseline-14.json";
    const cutoverPath = "/tmp/proof-cutover-14.json";

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: true }),
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      cutoverTimestampMs: Date.now() - 30000 * 1000,
      expectedSha: TEST_SHA,
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirror,
      dnsResolver: createMockResolver({ delegatesToCloudDns: false }),
    });

    for (const req of mirror.requestLog) {
      if (req.url.startsWith("https://cloudresourcemanager.googleapis.com")) {
        expect(req.url).toMatch(/projects\/ompctl|liens\?parent=projects%2F782181616134/);
        expect(req.url).not.toMatch(/organizations\//);
        expect(req.url).not.toMatch(/billingAccounts\//);
      }
      if (req.url.startsWith("https://api.github.com")) {
        expect(req.url).toMatch(/repos\/jwaldrip\/ompctl/);
      }
    }
  });
});
