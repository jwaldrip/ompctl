#!/usr/bin/env bun
/**
 * Direct Resource Manager v1 shutdown orchestrator for ompctl (782181616134).
 * Supports injected transport and DNS resolver for deterministic offline testing.
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
  type WorkflowRunItem,
} from "./guards.ts";
import {
  AUTHORITATIVE_PARENT_SERVERS,
  EXPECTED_CI_PRINCIPAL,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  EXPECTED_ROOT_DOMAIN,
  OLD_CLOUD_DNS_PATTERN,
  RETIRED_HOSTNAMES,
  type ChildNsQuery,
  type CommandRunner,
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
  observationKind?: "baseline" | "cutover";
  targetProjectId?: string;
  targetProjectNumber?: string;
  confirmation?: string;
  executionRef?: string;
  baselineArtifactPath?: string;
  cutoverArtifactPath?: string;
  baselineRunId?: string;
  cutoverRunId?: string;
  cutoverTimestampMs?: number;
  outObservationPath?: string;
  expectedSha?: string;
  currentRunId?: string;
  gcpToken?: string;
  githubToken?: string;
  transport?: HttpTransport;
  dnsResolver?: DnsResolver;
}

const DEFAULT_TRANSPORT: HttpTransport = {
  fetch: (input, init) => fetch(input, init),
};

const DEFAULT_COMMAND_RUNNER: CommandRunner = async (cmd: string[]) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
};

export class DigDnsResolver implements DnsResolver {
  private runner: CommandRunner;

  constructor(runner?: CommandRunner) {
    this.runner = runner || DEFAULT_COMMAND_RUNNER;
  }

  async queryParentNsAndDs(server: string, domain: string): Promise<ParentServerQuery> {
    try {
      // 1. Query NS
      const nsRes = await this.runner([
        "dig",
        `@${server}`,
        "+norecurse",
        "+time=3",
        "+tries=2",
        "NS",
        domain,
      ]);

      const nsStatusMatch = nsRes.stdout.match(/status:\s*([A-Z]+)/);
      const nsStatus = nsStatusMatch
        ? nsStatusMatch[1]
        : nsRes.exitCode === 0
        ? "NOERROR"
        : `ERROR_${nsRes.exitCode}`;

      const nameservers: Array<{ name: string; ttl: number }> = [];
      for (const line of nsRes.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === "NS") {
          nameservers.push({
            name: parts[4].replace(/\.$/, "").toLowerCase(),
            ttl: parseInt(parts[1], 10) || 0,
          });
        }
      }

      // 2. Query DS
      const dsRes = await this.runner([
        "dig",
        `@${server}`,
        "+norecurse",
        "+time=3",
        "+tries=2",
        "DS",
        domain,
      ]);

      const dsStatusMatch = dsRes.stdout.match(/status:\s*([A-Z]+)/);
      const dsStatus = dsStatusMatch
        ? dsStatusMatch[1]
        : dsRes.exitCode === 0
        ? "NOERROR"
        : `ERROR_${dsRes.exitCode}`;

      const dsRecords: Array<{ data: string; ttl: number }> = [];
      let hasAuthoritativeDenial = false;

      let inAuthoritySection = false;
      let inAnswerSection = false;

      for (const line of dsRes.stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.includes(";; ANSWER SECTION:")) {
          inAnswerSection = true;
          inAuthoritySection = false;
          continue;
        }
        if (trimmed.includes(";; AUTHORITY SECTION:")) {
          inAuthoritySection = true;
          inAnswerSection = false;
          continue;
        }
        if (trimmed.startsWith(";;") || trimmed === "") {
          continue;
        }

        const parts = trimmed.split(/\s+/);
        if (inAnswerSection && parts.length >= 5 && parts[3] === "DS") {
          dsRecords.push({
            data: parts.slice(4).join(" "),
            ttl: parseInt(parts[1], 10) || 0,
          });
        }

        if (inAuthoritySection && parts.length >= 5 && parts[3] === "SOA") {
          hasAuthoritativeDenial = true;
        }
      }

      // If status is NOERROR/NXDOMAIN and SOA is returned in authority section without DS in answer,
      // that is an authoritative negative denial of DS
      if (dsStatus === "NOERROR" && dsRecords.length === 0 && hasAuthoritativeDenial) {
        hasAuthoritativeDenial = true;
      }

      return {
        server,
        nsStatus,
        dsStatus,
        nameservers,
        dsRecords,
        hasAuthoritativeDenial,
      };
    } catch (err) {
      return {
        server,
        nsStatus: "EXCEPTION",
        dsStatus: "EXCEPTION",
        nameservers: [],
        dsRecords: [],
        hasAuthoritativeDenial: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async queryChildNs(server: string, domain: string): Promise<ChildNsQuery> {
    try {
      const res = await this.runner([
        "dig",
        `@${server}`,
        "+norecurse",
        "+time=3",
        "+tries=2",
        "NS",
        domain,
      ]);

      const statusMatch = res.stdout.match(/status:\s*([A-Z]+)/);
      const status = statusMatch
        ? statusMatch[1]
        : res.exitCode === 0
        ? "NOERROR"
        : `ERROR_${res.exitCode}`;

      const nameservers: Array<{ name: string; ttl: number }> = [];
      for (const line of res.stdout.split("\n")) {
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
      };
    } catch (err) {
      return {
        server,
        status: "EXCEPTION",
        nameservers: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async queryHostRecord(
    host: string,
    type: string,
    queryServer?: string
  ): Promise<HostRecordObservation> {
    try {
      const cmd = ["dig", "+time=3", "+tries=2"];
      if (queryServer) {
        cmd.push(`@${queryServer}`, "+norecurse");
      }
      cmd.push(host, type);

      const res = await this.runner(cmd);
      const statusMatch = res.stdout.match(/status:\s*([A-Z]+)/);
      const status = statusMatch
        ? statusMatch[1]
        : res.exitCode === 0
        ? "NOERROR"
        : `ERROR_${res.exitCode}`;

      const isAuthoritative = /\bflags:.*?\baa\b/.test(res.stdout);

      const records: DnsRecordEntry[] = [];
      for (const line of res.stdout.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[3] === type) {
          records.push({
            type,
            value: parts[4].replace(/\.$/, "").toLowerCase(),
            ttl: parseInt(parts[1], 10) || 0,
          });
        }
      }

      return {
        host,
        recordType: type,
        queryServer,
        status,
        isAuthoritative,
        records,
      };
    } catch (err) {
      return {
        host,
        recordType: type,
        queryServer,
        status: "EXCEPTION",
        isAuthoritative: false,
        records: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

export const DEFAULT_RESOLVER = new DigDnsResolver();

export async function captureDnsObservation(params: {
  kind: "baseline" | "cutover";
  gitSha: string;
  workflowRunId: string;
  resolver: DnsResolver;
}): Promise<DnsObservation> {
  const { kind, gitSha, workflowRunId, resolver } = params;
  const parentQueries: ParentServerQuery[] = [];

  for (const server of AUTHORITATIVE_PARENT_SERVERS) {
    const q = await resolver.queryParentNsAndDs(server, EXPECTED_ROOT_DOMAIN);
    parentQueries.push(q);
  }

  // Query child nameservers on Cloud DNS to discover real child NS TTL
  const childNsQueries: ChildNsQuery[] = [];
  const cloudDnsServers = [
    "ns-cloud-c1.googledomains.com",
    "ns-cloud-c2.googledomains.com",
    "ns-cloud-c3.googledomains.com",
    "ns-cloud-c4.googledomains.com",
  ];

  for (const cServer of cloudDnsServers) {
    const cq = await resolver.queryChildNs(cServer, EXPECTED_ROOT_DOMAIN);
    childNsQueries.push(cq);
  }

  // Determine replacement nameserver to query authoritatively if in cutover
  let replacementServer: string | undefined;
  if (kind === "cutover") {
    for (const pq of parentQueries) {
      const nonCloud = pq.nameservers.find(
        (ns) => !OLD_CLOUD_DNS_PATTERN.test(ns.name)
      );
      if (nonCloud) {
        replacementServer = nonCloud.name;
        break;
      }
    }
  }

  // Query explicit record types (A, AAAA, CNAME) for all retired hostnames
  const hostRecordObservations: HostRecordObservation[] = [];
  for (const host of RETIRED_HOSTNAMES) {
    for (const type of ["A", "AAAA", "CNAME"]) {
      const obs = await resolver.queryHostRecord(host, type, replacementServer);
      hostRecordObservations.push(obs);
    }
  }

  // Calculate actual observed old TTLs from parent, child, and host records
  let maxObservedOldTtl = 21600; // Floor minimum
  for (const q of parentQueries) {
    for (const ns of q.nameservers) {
      if (ns.ttl > maxObservedOldTtl) maxObservedOldTtl = ns.ttl;
    }
  }
  for (const cq of childNsQueries) {
    for (const ns of cq.nameservers) {
      if (ns.ttl > maxObservedOldTtl) maxObservedOldTtl = ns.ttl;
    }
  }
  for (const h of hostRecordObservations) {
    for (const r of h.records) {
      if (r.ttl > maxObservedOldTtl) maxObservedOldTtl = r.ttl;
    }
  }

  // Check agreement across all parent servers
  const firstNsList =
    parentQueries[0]?.nameservers.map((n) => n.name).sort().join(",") || "";
  let allAgree = true;
  let delegatesToCloudDns = false;

  for (const q of parentQueries) {
    const currentNsList = q.nameservers.map((n) => n.name).sort().join(",");
    if (currentNsList !== firstNsList || q.nsStatus !== "NOERROR") {
      allAgree = false;
    }
    if (q.nameservers.some((ns) => OLD_CLOUD_DNS_PATTERN.test(ns.name))) {
      delegatesToCloudDns = true;
    }
  }

  return {
    observationKind: kind,
    capturedAt: new Date().toISOString(),
    gitSha,
    workflowRunId,
    parentQueries,
    childNsQueries,
    oldMaxChildNsTtl: maxObservedOldTtl,
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
  const currentRunId = options.currentRunId || process.env.GITHUB_RUN_ID || "";

  validateProjectIdentity(projectId, projectNumber);

  if (op === "observe") {
    const kind = options.observationKind || "baseline";
    console.log(`==> Operation: OBSERVE (kind: ${kind})`);
    const gitSha = options.expectedSha || process.env.GITHUB_SHA || "unknown-sha";
    const runId = currentRunId || "local-run";

    const observation = await captureDnsObservation({
      kind,
      gitSha,
      workflowRunId: runId,
      resolver,
    });

    const outPath = options.outObservationPath || "dns-observation.json";
    writeFileSync(outPath, JSON.stringify(observation, null, 2), "utf8");

    console.log(`Observation (${kind}) captured to: ${outPath}`);
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
    if (!options.baselineRunId || !options.cutoverRunId) {
      throw new Error(
        "Retirement guard failed: both baselineRunId and cutoverRunId are required to verify artifact provenance"
      );
    }

    if (!existsSync(options.baselineArtifactPath)) {
      throw new Error(`Baseline artifact not found at '${options.baselineArtifactPath}'`);
    }
    if (!existsSync(options.cutoverArtifactPath)) {
      throw new Error(`Cutover artifact not found at '${options.cutoverArtifactPath}'`);
    }

    const baseline = JSON.parse(
      readFileSync(options.baselineArtifactPath, "utf8")
    ) as DnsObservation;
    const cutover = JSON.parse(
      readFileSync(options.cutoverArtifactPath, "utf8")
    ) as DnsObservation;

    // Validate provenance of baseline and cutover runs via GitHub API
    console.log(`Verifying baseline run #${options.baselineRunId} provenance...`);
    const baseRunRes = await transport.fetch(
      `https://api.github.com/repos/jwaldrip/ompctl/actions/runs/${options.baselineRunId}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!baseRunRes.ok) {
      throw new Error(
        `Failed to read baseline run #${options.baselineRunId} provenance (HTTP ${baseRunRes.status})`
      );
    }
    const baseRun = (await baseRunRes.json()) as {
      status: string;
      conclusion: string | null;
      head_branch: string;
      head_sha: string;
      path?: string;
    };
    if (baseRun.status !== "completed" || baseRun.conclusion !== "success") {
      throw new Error(`Baseline run #${options.baselineRunId} was not a successful completed run`);
    }
    if (baseRun.head_branch !== "main") {
      throw new Error(`Baseline run #${options.baselineRunId} was not on branch 'main'`);
    }
    if (options.expectedSha && baseRun.head_sha !== options.expectedSha) {
      throw new Error(
        `Baseline run SHA '${baseRun.head_sha}' does not match expected SHA '${options.expectedSha}'`
      );
    }
    if (String(baseline.workflowRunId) !== String(options.baselineRunId)) {
      throw new Error(
        `Baseline artifact run ID '${baseline.workflowRunId}' does not match verified run ID '${options.baselineRunId}'`
      );
    }

    console.log(`Verifying cutover run #${options.cutoverRunId} provenance...`);
    const cutRunRes = await transport.fetch(
      `https://api.github.com/repos/jwaldrip/ompctl/actions/runs/${options.cutoverRunId}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!cutRunRes.ok) {
      throw new Error(
        `Failed to read cutover run #${options.cutoverRunId} provenance (HTTP ${cutRunRes.status})`
      );
    }
    const cutRun = (await cutRunRes.json()) as {
      status: string;
      conclusion: string | null;
      head_branch: string;
      head_sha: string;
      updated_at?: string;
      path?: string;
    };
    if (cutRun.status !== "completed" || cutRun.conclusion !== "success") {
      throw new Error(`Cutover run #${options.cutoverRunId} was not a successful completed run`);
    }
    if (cutRun.head_branch !== "main") {
      throw new Error(`Cutover run #${options.cutoverRunId} was not on branch 'main'`);
    }
    if (options.expectedSha && cutRun.head_sha !== options.expectedSha) {
      throw new Error(
        `Cutover run SHA '${cutRun.head_sha}' does not match expected SHA '${options.expectedSha}'`
      );
    }
    if (String(cutover.workflowRunId) !== String(options.cutoverRunId)) {
      throw new Error(
        `Cutover artifact run ID '${cutover.workflowRunId}' does not match verified run ID '${options.cutoverRunId}'`
      );
    }

    // Derive TTL start strictly from verified API completion metadata
    if (!cutRun.updated_at) {
      throw new Error("Cutover run metadata missing updated_at timestamp");
    }
    const cutoverTimestampMs = Date.parse(cutRun.updated_at);
    if (!Number.isFinite(cutoverTimestampMs) || cutoverTimestampMs <= 0) {
      throw new Error(`Invalid cutover updated_at timestamp: '${cutRun.updated_at}'`);
    }

    const currentObs = await captureDnsObservation({
      kind: "cutover",
      gitSha: options.expectedSha || process.env.GITHUB_SHA || "",
      workflowRunId: currentRunId || "current",
      resolver,
    });

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

    // Guard 4: Confirm no active deployment runs across all paginated pages
    console.log("Checking for active deployment or publication runs with pagination...");
    const allWorkflowRuns: WorkflowRunItem[] = [];
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
      const runsUrl = `https://api.github.com/repos/jwaldrip/ompctl/actions/runs?per_page=100&page=${page}`;
      const runsRes = await transport.fetch(runsUrl, {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
      });

      if (!runsRes.ok) {
        const errBody = await runsRes.text();
        throw new Error(
          `Failed to query GitHub Actions runs on page ${page} (HTTP ${runsRes.status}): ${errBody}`
        );
      }

      const runsData = (await runsRes.json()) as {
        workflow_runs?: WorkflowRunItem[];
      };
      const pageRuns = runsData.workflow_runs || [];
      allWorkflowRuns.push(...pageRuns);

      if (pageRuns.length < 100) {
        hasMorePages = false;
      } else {
        page++;
      }
    }

    validateNoActiveDeployRuns(allWorkflowRuns, currentRunId);
    console.log(`✓ Zero active deployment workflow runs confirmed across ${allWorkflowRuns.length} queried runs.`);

    // Guard 5: Query and validate live Resource Manager v1 project identity
    console.log("Validating live project identity via Resource Manager v1...");
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
    if (projectData.lifecycleState !== "ACTIVE") {
      throw new Error(
        `Project lifecycle state is not ACTIVE: live reported '${projectData.lifecycleState}'`
      );
    }
    console.log(
      `✓ Live project identity confirmed: ${projectData.projectId} (${projectData.projectNumber}, state: ${projectData.lifecycleState})`
    );

    // Guard 6: Check deletion liens via official Resource Manager v1 endpoint
    console.log("Checking project deletion liens via Resource Manager v1 (/v1/liens)...");
    let pageToken: string | undefined;
    const allLiens: unknown[] = [];

    do {
      const liensUrl = new URL("https://cloudresourcemanager.googleapis.com/v1/liens");
      liensUrl.searchParams.set("parent", `projects/${projectData.projectNumber}`);
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
    console.log("✓ Zero project deletion liens confirmed.");

    // Guard 7: Test and ensure project deletion permissions
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
          body: JSON.stringify({
            options: {
              requestedPolicyVersion: 3,
            },
          }),
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
              version: policy.version || 3,
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
      console.log(
        `✓ GitHub Pages deletion status: HTTP ${pagesDelRes.status} (unpublish accepted).`
      );
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
      throw new Error(`Project shutdown failed (HTTP ${deleteProjRes.status}): ${errBody}`);
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

  let kind: "baseline" | "cutover" = "baseline";
  let confirmation = "";
  let baselinePath = "";
  let cutoverPath = "";
  let baselineRunId = "";
  let cutoverRunId = "";
  let expectedSha = "";
  let currentRunId = process.env.GITHUB_RUN_ID || "";

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--kind") {
      kind = args[++i] as "baseline" | "cutover";
    } else if (args[i] === "--confirm") {
      confirmation = args[++i];
    } else if (args[i] === "--baseline-artifact") {
      baselinePath = args[++i];
    } else if (args[i] === "--cutover-artifact") {
      cutoverPath = args[++i];
    } else if (args[i] === "--baseline-run-id") {
      baselineRunId = args[++i];
    } else if (args[i] === "--cutover-run-id") {
      cutoverRunId = args[++i];
    } else if (args[i] === "--expected-sha") {
      expectedSha = args[++i];
    } else if (args[i] === "--current-run-id") {
      currentRunId = args[++i];
    }
  }

  try {
    await retireInfra({
      operation: op,
      observationKind: kind,
      confirmation,
      baselineArtifactPath: baselinePath,
      cutoverArtifactPath: cutoverPath,
      baselineRunId,
      cutoverRunId,
      expectedSha,
      currentRunId,
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
