import { describe, expect, test } from "bun:test";
import { DigDnsResolver, retireInfra } from "./cli.ts";
import { StatefulHttpMirror } from "./mirror.ts";
import {
  AUTHORITATIVE_PARENT_SERVERS,
  type CommandRunner,
} from "./types.ts";

function createControlledCommandRunner(params: {
  delegatesToCloudDns?: boolean;
  allParentsAgree?: boolean;
  parentNsStatus?: string;
  parentDsStatus?: string;
  hasDsRecord?: boolean;
  hasAuthoritativeDenial?: boolean;
  childNsTtl?: number;
  childNsStatus?: string;
  hostRecordIp?: string;
  hostQueryStatus?: string;
  hostIsAuthoritative?: boolean;
}): CommandRunner {
  const delegates = params.delegatesToCloudDns ?? false;
  const agree = params.allParentsAgree ?? true;
  const nsStatus = params.parentNsStatus ?? "NOERROR";
  const dsStatus = params.parentDsStatus ?? "NOERROR";
  const hasDs = params.hasDsRecord ?? false;
  const hasDenial = params.hasAuthoritativeDenial ?? !hasDs;
  const childTtl = params.childNsTtl ?? 21600;
  const childStatus = params.childNsStatus ?? "NOERROR";
  const hostIp = params.hostRecordIp ?? "192.0.2.1";
  const hostStatus = params.hostQueryStatus ?? "NOERROR";
  const hostAa = params.hostIsAuthoritative ?? true;

  return async (cmd: string[]) => {
    const cmdStr = cmd.join(" ");

    // 1. Parent NS Query: dig @<server> +norecurse NS ompctl.ai
    if (cmdStr.includes(" NS ompctl.ai") && cmdStr.includes("@v")) {
      const serverMatch = cmdStr.match(/@(v[02]n[0-3]\.nic\.ai)/);
      const server = serverMatch ? serverMatch[1] : "v0n0.nic.ai";

      if (nsStatus !== "NOERROR") {
        return {
          stdout: `;; ->>HEADER<<- opcode: QUERY, status: ${nsStatus}, id: 1001\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      let ns1 = "dns1.registrar-servers.com.";
      let ns2 = "dns2.registrar-servers.com.";

      if (delegates) {
        ns1 = "ns-cloud-c1.googledomains.com.";
        ns2 = "ns-cloud-c2.googledomains.com.";
      } else if (!agree && server === "v2n1.nic.ai") {
        ns1 = "ns-cloud-c3.googledomains.com.";
      }

      return {
        stdout: `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1002\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 2, ADDITIONAL: 0\n;; AUTHORITY SECTION:\nompctl.ai. 3600 IN NS ${ns1}\nompctl.ai. 3600 IN NS ${ns2}\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // 2. Parent DS Query: dig @<server> +norecurse DS ompctl.ai
    if (cmdStr.includes(" DS ompctl.ai") && cmdStr.includes("@v")) {
      if (dsStatus !== "NOERROR") {
        return {
          stdout: `;; ->>HEADER<<- opcode: QUERY, status: ${dsStatus}, id: 1003\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      if (hasDs) {
        return {
          stdout: `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1004\n;; flags: qr rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0\n;; ANSWER SECTION:\nompctl.ai. 3600 IN DS 12345 8 2 0123456789abcdef0123456789abcdef01234567\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      if (hasDenial) {
        return {
          stdout: `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1005\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 0\n;; AUTHORITY SECTION:\nnic.ai. 3600 IN SOA v0n0.nic.ai. hostmaster.nic.ai. 2026110201 7200 3600 1209600 3600\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      // No denial and no DS
      return {
        stdout: `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1006\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // 3. Child NS Query on Cloud DNS: dig @ns-cloud-c*.googledomains.com +norecurse NS ompctl.ai
    if (cmdStr.includes(" NS ompctl.ai") && cmdStr.includes("@ns-cloud")) {
      if (childStatus !== "NOERROR") {
        return {
          stdout: `;; ->>HEADER<<- opcode: QUERY, status: ${childStatus}, id: 1007\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0\n`,
          stderr: "",
          exitCode: 0,
        };
      }

      return {
        stdout: `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1008\n;; flags: qr aa rd; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 0\n;; ANSWER SECTION:\nompctl.ai. ${childTtl} IN NS ns-cloud-c1.googledomains.com.\nompctl.ai. ${childTtl} IN NS ns-cloud-c2.googledomains.com.\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    // 4. Host Record Query: dig [@server] [+norecurse] <host> <type>
    const typeMatch = cmdStr.match(/\b(A|AAAA|CNAME)\b/);
    const hostType = typeMatch ? typeMatch[1] : "A";

    if (hostStatus !== "NOERROR") {
      return {
        stdout: `;; ->>HEADER<<- opcode: QUERY, status: ${hostStatus}, id: 1009\n;; flags: qr rd; QUERY: 1, ANSWER: 0, AUTHORITY: 0, ADDITIONAL: 0\n`,
        stderr: "",
        exitCode: hostStatus === "NOERROR" ? 0 : 9,
      };
    }

    const aaFlag = hostAa ? " aa" : "";
    return {
      stdout: `;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 1010\n;; flags: qr${aaFlag} rd; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 0\n;; ANSWER SECTION:\nompctl.ai. 300 IN ${hostType} ${hostIp}\n`,
      stderr: "",
      exitCode: 0,
    };
  };
}

describe("Guarded Direct Project Shutdown Execution Proof with Wire-Realistic DNS and API Contracts", () => {
  const TEST_SHA = "3662016072646338c3e1cca236b27c9dc7a4f219";

  test("1. Rejects wrong live project ID or number before any lien or IAM call", async () => {
    const mirror = new StatefulHttpMirror({
      projectId: "ompctl",
      projectNumber: "999999999999", // Mismatched project number on live GCP
    });

    const baselinePath = "/tmp/wire-baseline-1.json";
    const cutoverPath = "/tmp/wire-cutover-1.json";

    const baseResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: true }));
    const cutResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: false }));

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: baseResolver,
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: cutResolver,
    });

    mirror.workflowRuns = [
      {
        id: 101,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
      {
        id: 202,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
    ];

    const p = retireInfra({
      operation: "retire",
      targetProjectId: "ompctl",
      targetProjectNumber: "782181616134",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      baselineRunId: "101",
      cutoverRunId: "202",
      expectedSha: TEST_SHA,
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirror,
      dnsResolver: cutResolver,
    });

    expect(p).rejects.toThrow(/Project number mismatch: live reported '999999999999', expected '782181616134'/);

    // Verify halted BEFORE liens query or IAM policy calls
    const liensReq = mirror.requestLog.find((r) => r.url.includes("/v1/liens"));
    expect(liensReq).toBeUndefined();
    const iamReq = mirror.requestLog.find((r) => r.url.includes(":getIamPolicy"));
    expect(iamReq).toBeUndefined();
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
        executionRef: "refs/heads/feature",
        transport: mirror,
      })
    ).rejects.toThrow(/Execution ref guard failed/);

    expect(mirror.requestLog.length).toBe(0);
  });

  test("3. Treat unsuccessful DS query as unknown, not DS absence", async () => {
    const baselinePath = "/tmp/wire-baseline-3.json";
    const cutoverPath = "/tmp/wire-cutover-3.json";

    const baseResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: true }));
    // Resolver simulates SERVFAIL on parent DS query
    const failDsResolver = new DigDnsResolver(
      createControlledCommandRunner({ delegatesToCloudDns: false, parentDsStatus: "SERVFAIL" })
    );

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: baseResolver,
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: failDsResolver,
    });

    const mirror = new StatefulHttpMirror();
    mirror.workflowRuns = [
      {
        id: 101,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
      {
        id: 202,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
    ];

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        baselineRunId: "101",
        cutoverRunId: "202",
        expectedSha: TEST_SHA,
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: failDsResolver,
      })
    ).rejects.toThrow(/cutover DS query to parent 'v0n0.nic.ai' failed with status 'SERVFAIL'/);

    expect(mirror.lifecycleState).toBe("ACTIVE");
  });

  test("4. Proves replacement-authority control and rejects non-authoritative host answers", async () => {
    const baselinePath = "/tmp/wire-baseline-4.json";
    const cutoverPath = "/tmp/wire-cutover-4.json";

    const baseResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: true }));
    const cutResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: false }));
    // Real-time resolver returns non-authoritative answer (lacks 'aa' flag)
    const nonAuthResolver = new DigDnsResolver(
      createControlledCommandRunner({ delegatesToCloudDns: false, hostIsAuthoritative: false })
    );

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: baseResolver,
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: cutResolver,
    });

    const mirror = new StatefulHttpMirror();
    mirror.workflowRuns = [
      {
        id: 101,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
      {
        id: 202,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
    ];

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        baselineRunId: "101",
        cutoverRunId: "202",
        expectedSha: TEST_SHA,
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: nonAuthResolver,
      })
    ).rejects.toThrow(/was not answered authoritatively by the replacement nameserver/);
  });

  test("5. Paginates active/queued workflow inventory and detects active run on page 2", async () => {
    // Generate 120 completed runs on page 1, and 1 active hub-deploy run on page 2
    const dummyRuns: Array<{
      id: number;
      name: string;
      path: string;
      head_branch: string;
      head_sha: string;
      status: string;
      conclusion: string | null;
      updated_at: string;
    }> = [];

    dummyRuns.push({
      id: 101,
      name: "retire-infra",
      path: ".github/workflows/retire-infra.yml",
      head_branch: "main",
      head_sha: TEST_SHA,
      status: "completed",
      conclusion: "success",
      updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
    });

    dummyRuns.push({
      id: 202,
      name: "retire-infra",
      path: ".github/workflows/retire-infra.yml",
      head_branch: "main",
      head_sha: TEST_SHA,
      status: "completed",
      conclusion: "success",
      updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
    });

    for (let i = 300; i < 415; i++) {
      dummyRuns.push({
        id: i,
        name: "verify",
        path: ".github/workflows/verify.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date().toISOString(),
      });
    }

    // Active deployment run placed at index 105 (landing on page 2 when per_page=100)
    dummyRuns.push({
      id: 999111,
      name: "hub-deploy",
      path: ".github/workflows/hub-deploy.yml",
      head_branch: "main",
      head_sha: TEST_SHA,
      status: "queued",
      conclusion: null,
      updated_at: new Date().toISOString(),
    });

    const mirror = new StatefulHttpMirror({
      initialWorkflowRuns: dummyRuns,
    });

    const baselinePath = "/tmp/wire-baseline-5.json";
    const cutoverPath = "/tmp/wire-cutover-5.json";
    const baseResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: true }));
    const cutResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: false }));

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: baseResolver,
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: cutResolver,
    });

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        baselineRunId: "101",
        cutoverRunId: "202",
        expectedSha: TEST_SHA,
        currentRunId: "77777",
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: cutResolver,
      })
    ).rejects.toThrow(/Active deployment or publication runs detected: \[hub-deploy/);

    // Verify that page 2 was queried by the orchestrator
    const page2Req = mirror.requestLog.find((r) => r.url.includes("page=2"));
    expect(page2Req).toBeDefined();
  });

  test("6. Full end-to-end shutdown success with verified provenance and TTL elapsed", async () => {
    const mirror = new StatefulHttpMirror();
    const baseResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: true }));
    const cutResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: false }));

    const baselinePath = "/tmp/wire-baseline-6.json";
    const cutoverPath = "/tmp/wire-cutover-6.json";

    const baseRes = await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: baseResolver,
    });
    expect(baseRes.observation?.parentQueries.map((q) => q.server)).toEqual([...AUTHORITATIVE_PARENT_SERVERS]);

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: cutResolver,
    });

    // Provide authentic run provenance in mirror with cutover completion timestamp > 21600s ago
    mirror.workflowRuns = [
      {
        id: 101,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
      {
        id: 202,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
    ];

    const res = await retireInfra({
      operation: "retire",
      confirmation: "CONFIRM-RETIRE-OMPCTL",
      executionRef: "refs/heads/main",
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      baselineRunId: "101",
      cutoverRunId: "202",
      expectedSha: TEST_SHA,
      currentRunId: "303",
      gcpToken: "valid-bearer-token",
      githubToken: "valid-gh-token",
      transport: mirror,
      dnsResolver: cutResolver,
    });

    expect(res.success).toBe(true);
    expect(res.projectShutdownAccepted).toBe(true);

    // Independent read of live mirror confirms DELETE_REQUESTED
    const ownerRes = await mirror.fetch("https://cloudresourcemanager.googleapis.com/v1/projects/ompctl", {
      headers: { Authorization: "Bearer valid-bearer-token" },
    });
    const ownerData = (await ownerRes.json()) as { projectId: string; projectNumber: string; lifecycleState: string };
    expect(ownerData.projectId).toBe("ompctl");
    expect(ownerData.projectNumber).toBe("782181616134");
    expect(ownerData.lifecycleState).toBe("DELETE_REQUESTED");
  });

  test("7. Halts if baseline child NS query failed (missing child TTL evidence)", async () => {
    const baselinePath = "/tmp/wire-baseline-7.json";
    const cutoverPath = "/tmp/wire-cutover-7.json";

    // Child NS query returns SERVFAIL
    const failChildResolver = new DigDnsResolver(
      createControlledCommandRunner({ delegatesToCloudDns: true, childNsStatus: "SERVFAIL" })
    );
    const cutResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: false }));

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: failChildResolver,
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: cutResolver,
    });

    const mirror = new StatefulHttpMirror();
    mirror.workflowRuns = [
      {
        id: 101,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
      {
        id: 202,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
    ];

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        baselineRunId: "101",
        cutoverRunId: "202",
        expectedSha: TEST_SHA,
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: cutResolver,
      })
    ).rejects.toThrow(/baseline child-authority query to '.*' failed with status 'SERVFAIL'/);
  });

  test("8. Halts if retired host resolves to retired GitHub Pages IP address", async () => {
    const baselinePath = "/tmp/wire-baseline-8.json";
    const cutoverPath = "/tmp/wire-cutover-8.json";

    const baseResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: true }));
    const cutResolver = new DigDnsResolver(createControlledCommandRunner({ delegatesToCloudDns: false }));
    // Real-time resolver returns retired GitHub Pages apex IP
    const retiredPagesIpResolver = new DigDnsResolver(
      createControlledCommandRunner({ delegatesToCloudDns: false, hostRecordIp: "185.199.108.153" })
    );

    await retireInfra({
      operation: "observe",
      observationKind: "baseline",
      outObservationPath: baselinePath,
      expectedSha: TEST_SHA,
      currentRunId: "101",
      dnsResolver: baseResolver,
    });

    await retireInfra({
      operation: "observe",
      observationKind: "cutover",
      outObservationPath: cutoverPath,
      expectedSha: TEST_SHA,
      currentRunId: "202",
      dnsResolver: cutResolver,
    });

    const mirror = new StatefulHttpMirror();
    mirror.workflowRuns = [
      {
        id: 101,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
      {
        id: 202,
        name: "retire-infra",
        path: ".github/workflows/retire-infra.yml",
        head_branch: "main",
        head_sha: TEST_SHA,
        status: "completed",
        conclusion: "success",
        updated_at: new Date(Date.now() - 30000 * 1000).toISOString(),
      },
    ];

    expect(
      retireInfra({
        operation: "retire",
        confirmation: "CONFIRM-RETIRE-OMPCTL",
        executionRef: "refs/heads/main",
        baselineArtifactPath: baselinePath,
        cutoverArtifactPath: cutoverPath,
        baselineRunId: "101",
        cutoverRunId: "202",
        expectedSha: TEST_SHA,
        gcpToken: "valid-bearer-token",
        githubToken: "valid-gh-token",
        transport: mirror,
        dnsResolver: retiredPagesIpResolver,
      })
    ).rejects.toThrow(/still resolves to retired IP destination '185.199.108.153'/);
  });
});
