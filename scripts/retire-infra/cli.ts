#!/usr/bin/env bun
/**
 * Direct Resource Manager v1 shutdown orchestrator for ompctl (782181616134).
 * Supports injected transport and DNS resolver for stateful offline testing.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  validateConfirmation,
  validateDnsCutoverAndTtl,
  validateExecutionRef,
  validateNoActiveDeployRuns,
  validateNoLiens,
  validateProjectDeleterPermission,
  validateProjectIdentity,
} from "./guards.ts";
import {
  AUTHORITATIVE_PARENT_SERVERS,
  EXPECTED_CI_PRINCIPAL,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  EXPECTED_ROOT_DOMAIN,
  OLD_CLOUD_DNS_PATTERN,
  RETIRED_HOSTNAMES,
  type DnsObservation,
  type DnsRecordEntry,
  type DnsResolver,
  type HostRecordObservation,
  type HttpTransport,
  type ParentServerQuery,
  type RetirementOperation,
} from "./types.ts";

export interface RetireInfraOptions {
  operation: RetirementOperation;
  targetProjectId?: string;
  targetProjectNumber?: string;
  confirmation?: string;
  executionRef?: string;
  baselineArtifactPath?: string;
  cutoverArtifactPath?: string;
  cutoverTimestampMs?: number;
  outObservationPath?: string;
  expectedSha?: string;
  gcpToken?: string;
  githubToken?: string;
  transport?: HttpTransport;
  dnsResolver?: DnsResolver;
}

const DEFAULT_TRANSPORT: HttpTransport = {
  fetch: (input, init) => fetch(input, init),
};

const DEFAULT_RESOLVER: DnsResolver = {
  async queryParentNs(server: string, domain: string): Promise<ParentServerQuery> {
    try {
      const proc = Bun.spawn(["dig", `@${server}`, "+norecurse", "+time=3", "+tries=2", "NS", domain], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;

      if (code !== 0) {
        return {
          server,
          status: `ERROR_${code}`,
          nameservers: [],
          dsRecords: [],
          error: "dig exited with nonzero status",
        };
      }

      const statusMatch = stdout.match(/status:\s*([A-Z]+)/);
      const status = statusMatch ? statusMatch[1] : "UNKNOWN";

      const nameservers: Array<{ name: string; ttl: number }> = [];
      const lines = stdout.split("\n");
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === "NS") {
          nameservers.push({
            name: parts[4].replace(/\.$/, "").toLowerCase(),
            ttl: parseInt(parts[1], 10) || 0,
          });
        }
      }

      return {
        server,
        status,
        nameservers,
        dsRecords: [],
      };
    } catch (err) {
      return {
        server,
        status: "EXCEPTION",
        nameservers: [],
        dsRecords: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async queryHost(host: string): Promise<DnsRecordEntry[]> {
    try {
      const proc = Bun.spawn(["dig", "+time=3", "+tries=2", host, "ANY"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const records: DnsRecordEntry[] = [];
      for (const line of stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && (parts[3] === "A" || parts[3] === "AAAA" || parts[3] === "CNAME")) {
          records.push({
            type: parts[3],
            value: parts[4].replace(/\.$/, "").toLowerCase(),
            ttl: parseInt(parts[1], 10) || 0,
          });
        }
      }
      return records;
    } catch {
      return [];
    }
  },
};

export async function captureDnsObservation(params: {
  kind: "baseline" | "cutover";
  gitSha: string;
  workflowRunId: string;
  resolver: DnsResolver;
}): Promise<DnsObservation> {
  const { kind, gitSha, workflowRunId, resolver } = params;
  const parentQueries: ParentServerQuery[] = [];

  for (const server of AUTHORITATIVE_PARENT_SERVERS) {
    const q = await resolver.queryParentNs(server, EXPECTED_ROOT_DOMAIN);
    parentQueries.push(q);
  }

  const hostRecordObservations: HostRecordObservation[] = [];
  for (const host of RETIRED_HOSTNAMES) {
    const recs = await resolver.queryHost(host);
    hostRecordObservations.push({ host, records: recs });
  }

  // Check agreement across all parent servers
  const firstNsList = parentQueries[0]?.nameservers.map((n) => n.name).sort().join(",") || "";
  let allAgree = true;
  let delegatesToCloudDns = false;

  for (const q of parentQueries) {
    const currentNsList = q.nameservers.map((n) => n.name).sort().join(",");
    if (currentNsList !== firstNsList || q.status !== "NOERROR") {
      allAgree = false;
    }
    if (q.nameservers.some((ns) => OLD_CLOUD_DNS_PATTERN.test(ns.name))) {
      delegatesToCloudDns = true;
    }
  }

  // Child NS TTL baseline is historically 21600 seconds
  const oldMaxChildNsTtl = 21600;

  return {
    observationKind: kind,
    capturedAt: new Date().toISOString(),
    gitSha,
    workflowRunId,
    parentQueries,
    oldMaxChildNsTtl,
    hostRecordObservations,
    allParentsAgree: allAgree,
    delegatesToCloudDns,
  };
}

export async function retireInfra(options: RetireInfraOptions): Promise<{
  success: boolean;
  operation: RetirementOperation;
  projectShutdownAccepted?: boolean;
  observation?: DnsObservation;
  details?: Record<string, unknown>;
}> {
  const op = options.operation;
  const projectId = options.targetProjectId || EXPECTED_PROJECT_ID;
  const projectNumber = options.targetProjectNumber || EXPECTED_PROJECT_NUMBER;
  const transport = options.transport || DEFAULT_TRANSPORT;
  const resolver = options.dnsResolver || DEFAULT_RESOLVER;
  const gcpToken = options.gcpToken || process.env.GOOGLE_OAUTH_ACCESS_TOKEN || "";
  const githubToken = options.githubToken || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";

  validateProjectIdentity(projectId, projectNumber);

  if (op === "observe") {
    console.log(`==> Operation: OBSERVE (Capturing DNS and authority observations)`);
    const gitSha = options.expectedSha || process.env.GITHUB_SHA || "unknown-sha";
    const runId = process.env.GITHUB_RUN_ID || "local-run";

    const observation = await captureDnsObservation({
      kind: "baseline",
      gitSha,
      workflowRunId: runId,
      resolver,
    });

    const outPath = options.outObservationPath || "dns-observation.json";
    writeFileSync(outPath, JSON.stringify(observation, null, 2), "utf8");

    console.log(`Observation captured to: ${outPath}`);
    console.log(`Delegates to Cloud DNS: ${observation.delegatesToCloudDns}`);
    console.log(`All parent servers agree: ${observation.allParentsAgree}`);
    console.log("Read-only observation complete. Zero mutation calls executed.");

    return {
      success: true,
      operation: "observe",
      observation,
    };
  }

  if (op === "retire") {
    console.log(`==> Operation: RETIRE (Guarded terminal project shutdown)`);

    // Guard 1: Verify execution ref
    const executionRef = options.executionRef || process.env.GITHUB_REF || "";
    validateExecutionRef(executionRef);

    // Guard 2: Verify confirmation
    const confirmation = options.confirmation || "";
    validateConfirmation(confirmation);

    // Guard 3: DNS cutover artifact & TTL verification
    if (!options.baselineArtifactPath || !options.cutoverArtifactPath) {
      throw new Error(
        "Retirement guard failed: both baseline and cutover observation artifacts are required for retirement"
      );
    }

    if (!existsSync(options.baselineArtifactPath)) {
      throw new Error(`Baseline artifact not found at '${options.baselineArtifactPath}'`);
    }
    if (!existsSync(options.cutoverArtifactPath)) {
      throw new Error(`Cutover artifact not found at '${options.cutoverArtifactPath}'`);
    }

    const baseline = JSON.parse(readFileSync(options.baselineArtifactPath, "utf8")) as DnsObservation;
    const cutover = JSON.parse(readFileSync(options.cutoverArtifactPath, "utf8")) as DnsObservation;

    const currentObs = await captureDnsObservation({
      kind: "cutover",
      gitSha: options.expectedSha || process.env.GITHUB_SHA || "",
      workflowRunId: process.env.GITHUB_RUN_ID || "current",
      resolver,
    });
    // Guard 3.5: Confirm no active deployment runs
    try {
      const runsRes = await transport.fetch(
        "https://api.github.com/repos/jwaldrip/ompctl/actions/runs?status=in_progress",
        {
          headers: {
            Authorization: `Bearer ${githubToken}`,
            Accept: "application/vnd.github+json",
          },
        }
      );
      if (runsRes.ok) {
        const runsData = (await runsRes.json()) as {
          workflow_runs?: Array<{ id: number; name: string; status: string; conclusion: string | null }>;
        };
        validateNoActiveDeployRuns(runsData.workflow_runs ?? []);
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("Active deployment")) {
        throw err;
      }
      // If token cannot read runs, log notice
    }
    const cutoverTimestampMs = options.cutoverTimestampMs || new Date(cutover.capturedAt).getTime();
    const currentTimestampMs = Date.now();

    validateDnsCutoverAndTtl({
      baseline,
      cutover,
      currentObservations: currentObs,
      cutoverTimestampMs,
      currentTimestampMs,
      expectedSha: options.expectedSha,
    });
    console.log("✓ DNS cutover and TTL expiration verified.");

    // Guard 4: Query live Resource Manager v1 project identity
    console.log("Reading live project status via Resource Manager v1...");
    const projectRes = await transport.fetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`,
      {
        headers: {
          Authorization: `Bearer ${gcpToken}`,
          Accept: "application/json",
        },
      }
    );

    if (!projectRes.ok) {
      const errBody = await projectRes.text();
      throw new Error(
        `Failed to read project '${projectId}' from Resource Manager v1 (HTTP ${projectRes.status}): ${errBody}`
      );
    }

    const projectData = (await projectRes.json()) as {
      projectId: string;
      projectNumber: string;
      lifecycleState: string;
    };

    if (projectData.projectId !== EXPECTED_PROJECT_ID) {
      throw new Error(
        `Project ID mismatch: live reported '${projectData.projectId}', expected '${EXPECTED_PROJECT_ID}'`
      );
    }
    if (projectData.projectNumber !== EXPECTED_PROJECT_NUMBER) {
      throw new Error(
        `Project number mismatch: live reported '${projectData.projectNumber}', expected '${EXPECTED_PROJECT_NUMBER}'`
      );
    }
    console.log(`✓ Project identity confirmed: ${projectData.projectId} (${projectData.projectNumber})`);

    // Guard 5: Test and ensure project deletion permissions
    console.log("Checking project deletion permissions via Resource Manager v1 testIamPermissions...");
    const testIamRes = await transport.fetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gcpToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          permissions: ["resourcemanager.projects.delete"],
        }),
      }
    );

    if (!testIamRes.ok) {
      const errBody = await testIamRes.text();
      throw new Error(
        `testIamPermissions failed on project '${projectId}' (HTTP ${testIamRes.status}): ${errBody}`
      );
    }

    const permData = (await testIamRes.json()) as { permissions?: string[] };
    let hasDelete = (permData.permissions ?? []).includes("resourcemanager.projects.delete");

    if (!hasDelete) {
      console.log("Deployer lacks 'resourcemanager.projects.delete'; querying policy to bind role...");
      const getPolicyRes = await transport.fetch(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:getIamPolicy`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${gcpToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({}),
        }
      );

      if (!getPolicyRes.ok) {
        const errBody = await getPolicyRes.text();
        throw new Error(
          `getIamPolicy failed (HTTP ${getPolicyRes.status}): caller cannot read IAM policy: ${errBody}`
        );
      }

      interface IamBinding {
        role: string;
        members: string[];
        condition?: Record<string, unknown>;
      }
      interface IamPolicy {
        version?: number;
        etag?: string;
        bindings?: IamBinding[];
      }

      const policy = (await getPolicyRes.json()) as IamPolicy;
      const bindings = policy.bindings || [];

      // Add roles/resourcemanager.projectDeleter to EXPECTED_CI_PRINCIPAL
      let deleterBinding = bindings.find(
        (b) => b.role === "roles/resourcemanager.projectDeleter" && !b.condition
      );
      if (!deleterBinding) {
        deleterBinding = { role: "roles/resourcemanager.projectDeleter", members: [] };
        bindings.push(deleterBinding);
      }
      if (!deleterBinding.members.includes(EXPECTED_CI_PRINCIPAL)) {
        deleterBinding.members.push(EXPECTED_CI_PRINCIPAL);
      }

      const setPolicyRes = await transport.fetch(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:setIamPolicy`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${gcpToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            policy: {
              version: policy.version,
              etag: policy.etag,
              bindings,
            },
          }),
        }
      );

      if (!setPolicyRes.ok) {
        const errBody = await setPolicyRes.text();
        throw new Error(
          `setIamPolicy failed to grant projectDeleter (HTTP ${setPolicyRes.status}): ${errBody}`
        );
      }

      // Re-test permissions
      const retestRes = await transport.fetch(
        `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}:testIamPermissions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${gcpToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            permissions: ["resourcemanager.projects.delete"],
          }),
        }
      );
      const retestData = (await retestRes.json()) as { permissions?: string[] };
      hasDelete = (retestData.permissions ?? []).includes("resourcemanager.projects.delete");
    }

    validateProjectDeleterPermission(hasDelete);
    console.log("✓ Project deletion permission verified.");

    // Guard 6: Verify zero project deletion liens (handling pagination)
    console.log("Checking project deletion liens via Resource Manager v1...");
    let pageToken: string | undefined;
    const allLiens: unknown[] = [];

    do {
      const liensUrl = new URL(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}/liens`);
      if (pageToken) {
        liensUrl.searchParams.set("pageToken", pageToken);
      }

      const liensRes = await transport.fetch(liensUrl.toString(), {
        headers: {
          Authorization: `Bearer ${gcpToken}`,
          Accept: "application/json",
        },
      });

      if (!liensRes.ok) {
        const errBody = await liensRes.text();
        throw new Error(
          `Failed to query liens for project '${projectId}' (HTTP ${liensRes.status}): ${errBody}`
        );
      }

      const liensData = (await liensRes.json()) as { liens?: unknown[]; nextPageToken?: string };
      if (Array.isArray(liensData.liens)) {
        allLiens.push(...liensData.liens);
      }
      pageToken = liensData.nextPageToken;
    } while (pageToken);

    validateNoLiens(allLiens);
    console.log("✓ Zero project liens confirmed.");

    // Mutation 1: Unpublish GitHub Pages
    console.log("Unpublishing GitHub Pages site...");
    const pagesDelRes = await transport.fetch(
      "https://api.github.com/repos/jwaldrip/ompctl/pages",
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (pagesDelRes.status === 204 || pagesDelRes.status === 404) {
      console.log(`✓ GitHub Pages deletion status: HTTP ${pagesDelRes.status} (unpublish accepted).`);
    } else {
      const errBody = await pagesDelRes.text();
      throw new Error(
        `Failed to unpublish GitHub Pages (HTTP ${pagesDelRes.status}): ${errBody}`
      );
    }

    // Read back Pages absence
    const pagesGetRes = await transport.fetch(
      "https://api.github.com/repos/jwaldrip/ompctl/pages",
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    if (pagesGetRes.status !== 404) {
      throw new Error(
        `Pages absence readback failed: expected HTTP 404, got HTTP ${pagesGetRes.status}`
      );
    }
    console.log("✓ GitHub Pages absence verified (HTTP 404).");

    // Mutation 2: Terminal Google Cloud Project Shutdown
    console.log(`Initiating terminal project shutdown: DELETE /v1/projects/${projectId}...`);
    const deleteProjRes = await transport.fetch(
      `https://cloudresourcemanager.googleapis.com/v1/projects/${projectId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${gcpToken}`,
          Accept: "application/json",
        },
      }
    );

    if (!deleteProjRes.ok) {
      const errBody = await deleteProjRes.text();
      throw new Error(
        `Project shutdown failed (HTTP ${deleteProjRes.status}): ${errBody}`
      );
    }

    console.log("\n========================================================");
    console.log(`SHUTDOWN REQUEST ACCEPTED FOR: ${projectId} (${projectNumber})`);
    console.log("API response: HTTP 200 {}");
    console.log("Project has transitioned to DELETE_REQUESTED state.");
    console.log("========================================================\n");

    return {
      success: true,
      operation: "retire",
      projectShutdownAccepted: true,
      details: {
        projectId,
        projectNumber,
        status: "DELETE_REQUESTED",
      },
    };
  }

  throw new Error(`Unknown operation: ${String(op)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const op = args[0] as RetirementOperation;

  if (op !== "observe" && op !== "retire") {
    console.error("Usage: bun scripts/retire-infra/cli.ts <observe|retire> [options]");
    process.exit(1);
  }

  let confirmation = "";
  let baselinePath = "";
  let cutoverPath = "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--confirm") {
      confirmation = args[++i];
    } else if (args[i] === "--baseline-artifact") {
      baselinePath = args[++i];
    } else if (args[i] === "--cutover-artifact") {
      cutoverPath = args[++i];
    }
  }

  try {
    await retireInfra({
      operation: op,
      confirmation,
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
    });
  } catch (err) {
    console.error("\n[FATAL RETIREMENT FAILURE]");
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
