/**
 * Guard assertions and validators for direct project shutdown of ompctl.
 * All functions fail closed on unexpected input, missing attributes, or drift.
 */

import {
  AUTHORITATIVE_PARENT_SERVERS,
  DEPLOYMENT_WORKFLOW_FILENAMES,
  type DnsObservation,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  OLD_CLOUD_DNS_PATTERN,
  RETIRED_DESTINATION_IPS,
  RETIRED_DESTINATION_PATTERNS,
} from "./types.ts";

export function validateProjectIdentity(projectId: string, projectNumber: string): void {
  if (!projectId || projectId.trim() !== EXPECTED_PROJECT_ID) {
    throw new Error(`Project ID guard failed: expected '${EXPECTED_PROJECT_ID}', got '${projectId}'`);
  }
  if (!projectNumber || projectNumber.trim() !== EXPECTED_PROJECT_NUMBER) {
    throw new Error(`Project number guard failed: expected '${EXPECTED_PROJECT_NUMBER}', got '${projectNumber}'`);
  }
}

export function validateConfirmation(confirmation: string): void {
  if (confirmation !== "CONFIRM-RETIRE-OMPCTL") {
    throw new Error(
      "Confirmation guard failed: destructive retirement requires exact confirmation 'CONFIRM-RETIRE-OMPCTL'",
    );
  }
}

export function validateExecutionRef(ref: string): void {
  if (ref !== "refs/heads/main" && ref !== "main") {
    throw new Error(`Execution ref guard failed: retirement requires default branch 'refs/heads/main', got '${ref}'`);
  }
}

export function validateProjectDeleterPermission(hasPermission: boolean): void {
  if (!hasPermission) {
    throw new Error(
      "Project deletion permission guard failed: caller identity lacks 'resourcemanager.projects.delete' on project 'ompctl'. Project shutdown cannot succeed. Grant 'roles/resourcemanager.projectDeleter' before proceeding.",
    );
  }
}

export function validateNoLiens(liens: unknown[]): void {
  if (!Array.isArray(liens)) {
    throw new Error("Liens query result must be an array");
  }
  if (liens.length > 0) {
    throw new Error(
      `Project has active deletion liens (${liens.length} found). Deletion liens indicate protective or cross-project dependencies. Project shutdown is halted.`,
    );
  }
}

export interface WorkflowRunItem {
  id: number;
  name?: string;
  path?: string;
  status: string;
  conclusion: string | null;
}

export function validateNoActiveDeployRuns(runs: WorkflowRunItem[], currentRunId?: string): void {
  const deploymentWorkflowSet: Record<string, true> = Object.fromEntries(
    DEPLOYMENT_WORKFLOW_FILENAMES.map(f => [f, true]),
  );

  const active = runs.filter(r => {
    // Exclude the currently running retirement execution
    if (currentRunId && String(r.id) === String(currentRunId)) {
      return false;
    }

    const isNonTerminal =
      r.status === "in_progress" ||
      r.status === "queued" ||
      r.status === "waiting" ||
      r.status === "pending" ||
      r.status === "requested";

    if (!isNonTerminal) {
      return false;
    }

    // Check if run belongs to deployment workflows
    const filename = r.path?.split("/").pop() || "";
    if (deploymentWorkflowSet[filename]) {
      return true;
    }

    const nameLower = (r.name || "").toLowerCase();
    return nameLower.includes("hub-deploy") || nameLower.includes("site-pages") || nameLower.includes("app store");
  });

  if (active.length > 0) {
    const list = active.map(r => `${r.name || r.path} (#${r.id}: ${r.status})`).join(", ");
    throw new Error(
      `Active deployment or publication runs detected: [${list}]. All deployment workflows must be inactive before retirement.`,
    );
  }
}

export interface DnsCutoverGateInput {
  baseline: DnsObservation;
  cutover: DnsObservation;
  currentObservations: DnsObservation;
  cutoverTimestampMs: number;
  currentTimestampMs: number;
  expectedSha?: string;
}

export function validateDnsCutoverAndTtl(params: DnsCutoverGateInput): void {
  const { baseline, cutover, currentObservations, cutoverTimestampMs, currentTimestampMs, expectedSha } = params;

  if (baseline.observationKind !== "baseline") {
    throw new Error("DNS guard failed: baseline artifact must have observationKind='baseline'");
  }
  if (cutover.observationKind !== "cutover") {
    throw new Error("DNS guard failed: cutover artifact must have observationKind='cutover'");
  }

  if (expectedSha && expectedSha.trim() !== "") {
    if (baseline.gitSha !== expectedSha) {
      throw new Error(
        `DNS guard failed: baseline gitSha '${baseline.gitSha}' does not match expected '${expectedSha}'`,
      );
    }
    if (cutover.gitSha !== expectedSha) {
      throw new Error(`DNS guard failed: cutover gitSha '${cutover.gitSha}' does not match expected '${expectedSha}'`);
    }
  }

  // 1. Validate baseline child-authority TTL evidence
  if (!Array.isArray(baseline.childNsQueries) || baseline.childNsQueries.length === 0) {
    throw new Error("DNS guard failed: baseline artifact lacks required child-authority NS query evidence");
  }

  for (const cq of baseline.childNsQueries) {
    if (cq.status !== "NOERROR") {
      throw new Error(
        `DNS guard failed: baseline child-authority query to '${cq.server}' failed with status '${cq.status}'`,
      );
    }
    if (!Array.isArray(cq.nameservers) || cq.nameservers.length === 0) {
      throw new Error(`DNS guard failed: baseline child-authority query to '${cq.server}' returned zero nameservers`);
    }
  }

  // 2. Validate cutover parent queries across all 6 IANA parent servers
  if (!Array.isArray(cutover.parentQueries) || cutover.parentQueries.length < AUTHORITATIVE_PARENT_SERVERS.length) {
    throw new Error(
      `DNS guard failed: cutover artifact must contain queries for all ${AUTHORITATIVE_PARENT_SERVERS.length} authoritative parent servers`,
    );
  }

  const expectedServers: Record<string, true> = Object.fromEntries(AUTHORITATIVE_PARENT_SERVERS.map(s => [s, true]));

  let cutoverFirstNs = "";
  for (const q of cutover.parentQueries) {
    if (!expectedServers[q.server]) {
      throw new Error(`DNS guard failed: unrecognized parent server in cutover: '${q.server}'`);
    }
    if (q.nsStatus !== "NOERROR") {
      throw new Error(`DNS guard failed: cutover NS query to parent '${q.server}' failed with status '${q.nsStatus}'`);
    }
    if (!Array.isArray(q.nameservers) || q.nameservers.length === 0) {
      throw new Error(`DNS guard failed: cutover query to parent '${q.server}' returned zero nameservers`);
    }

    const currentNs = q.nameservers
      .map(n => n.name)
      .sort()
      .join(",");
    if (!cutoverFirstNs) {
      cutoverFirstNs = currentNs;
    } else if (currentNs !== cutoverFirstNs) {
      throw new Error("DNS guard failed: cutover parent queries do not agree on replacement nameservers");
    }

    for (const ns of q.nameservers) {
      if (OLD_CLOUD_DNS_PATTERN.test(ns.name)) {
        throw new Error(
          `DNS guard failed: parent server '${q.server}' still delegates to Cloud DNS nameserver '${ns.name}' in cutover artifact`,
        );
      }
    }

    // DS query validation
    if (q.dsStatus !== "NOERROR") {
      throw new Error(`DNS guard failed: cutover DS query to parent '${q.server}' failed with status '${q.dsStatus}'`);
    }
    if (!q.hasAuthoritativeDenial) {
      throw new Error(`DNS guard failed: cutover DS query to parent '${q.server}' lacked authoritative denial of DS`);
    }
    if (Array.isArray(q.dsRecords) && q.dsRecords.length > 0) {
      throw new Error(`DNS guard failed: unexpected DS record present on parent '${q.server}' in cutover artifact`);
    }
  }

  // 3. Validate cutover timestamp & TTL elapsed time
  if (!Number.isFinite(cutoverTimestampMs) || cutoverTimestampMs <= 0) {
    throw new Error(`DNS guard failed: invalid cutover timestamp '${String(cutoverTimestampMs)}'`);
  }

  if (currentTimestampMs < cutoverTimestampMs) {
    throw new Error("DNS guard failed: clock anomaly, current timestamp is before cutover timestamp");
  }

  const requiredElapsedSeconds = Math.max(baseline.oldMaxChildNsTtl, 21600);
  const actualElapsedSeconds = Math.floor((currentTimestampMs - cutoverTimestampMs) / 1000);

  if (actualElapsedSeconds < requiredElapsedSeconds) {
    throw new Error(
      `DNS guard failed: elapsed time since cutover (${actualElapsedSeconds}s) has not exceeded the required old TTL window (${requiredElapsedSeconds}s). Caches may still direct traffic to Cloud DNS.`,
    );
  }

  // 4. Real-time parent check at execution time
  if (!Array.isArray(currentObservations.parentQueries) || currentObservations.parentQueries.length === 0) {
    throw new Error("DNS guard failed: real-time parent queries are missing");
  }

  let realTimeFirstNs = "";
  for (const q of currentObservations.parentQueries) {
    if (q.nsStatus !== "NOERROR") {
      throw new Error(
        `DNS guard failed: real-time NS query to parent '${q.server}' failed with status '${q.nsStatus}'`,
      );
    }
    if (!Array.isArray(q.nameservers) || q.nameservers.length === 0) {
      throw new Error(`DNS guard failed: real-time query to parent '${q.server}' returned zero nameservers`);
    }

    const currentNs = q.nameservers
      .map(n => n.name)
      .sort()
      .join(",");
    if (!realTimeFirstNs) {
      realTimeFirstNs = currentNs;
    } else if (currentNs !== realTimeFirstNs) {
      throw new Error(
        "DNS guard failed: real-time parent nameserver check shows mixed delegation across authoritative parent servers",
      );
    }

    for (const ns of q.nameservers) {
      if (OLD_CLOUD_DNS_PATTERN.test(ns.name)) {
        throw new Error(
          `DNS guard failed: real-time parent nameserver check confirms delegation is still pointing to Cloud DNS (${ns.name})`,
        );
      }
    }

    if (q.dsStatus !== "NOERROR") {
      throw new Error(
        `DNS guard failed: real-time DS query to parent '${q.server}' failed with status '${q.dsStatus}'`,
      );
    }
    if (!q.hasAuthoritativeDenial) {
      throw new Error(`DNS guard failed: real-time DS query to parent '${q.server}' lacked authoritative denial of DS`);
    }
    if (Array.isArray(q.dsRecords) && q.dsRecords.length > 0) {
      throw new Error(`DNS guard failed: unexpected DS record present on parent '${q.server}' during real-time check`);
    }
  }

  // 5. Host record checks against replacement authority
  const retiredIpSet: Record<string, true> = Object.fromEntries(RETIRED_DESTINATION_IPS.map(ip => [ip, true]));

  if (
    !Array.isArray(currentObservations.hostRecordObservations) ||
    currentObservations.hostRecordObservations.length === 0
  ) {
    throw new Error("DNS guard failed: replacement authority host record observations are missing");
  }

  for (const hostObs of currentObservations.hostRecordObservations) {
    if (hostObs.status !== "NOERROR" && hostObs.status !== "NXDOMAIN") {
      throw new Error(
        `DNS guard failed: host query for '${hostObs.host}' (${hostObs.recordType}) failed with status '${hostObs.status}': ${hostObs.error || "unresolved"}`,
      );
    }

    if (hostObs.isAuthoritative === false) {
      throw new Error(
        `DNS guard failed: host query for '${hostObs.host}' was not answered authoritatively by the replacement nameserver`,
      );
    }

    for (const rec of hostObs.records) {
      // Check for CNAME matching retired destinations
      for (const pat of RETIRED_DESTINATION_PATTERNS) {
        if (pat.test(rec.value)) {
          throw new Error(
            `DNS guard failed: retired host '${hostObs.host}' still points to retired cloud service target '${rec.value}'`,
          );
        }
      }

      // Check for A/AAAA matching retired GitHub Pages or Google Cloud Run IPs
      if (retiredIpSet[rec.value]) {
        throw new Error(
          `DNS guard failed: retired host '${hostObs.host}' still resolves to retired IP destination '${rec.value}'`,
        );
      }
    }
  }
}
