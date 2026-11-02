/**
 * Guard assertions and validators for direct project shutdown of ompctl.
 * All functions fail closed on unexpected input, missing attributes, or drift.
 */

import {
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  OLD_CLOUD_DNS_PATTERN,
  RETIRED_HOSTNAMES,
  type DnsObservation,
} from "./types.ts";

export function validateProjectIdentity(
  projectId: string,
  projectNumber: string
): void {
  if (!projectId || projectId.trim() !== EXPECTED_PROJECT_ID) {
    throw new Error(
      `Project ID guard failed: expected '${EXPECTED_PROJECT_ID}', got '${projectId}'`
    );
  }
  if (!projectNumber || projectNumber.trim() !== EXPECTED_PROJECT_NUMBER) {
    throw new Error(
      `Project number guard failed: expected '${EXPECTED_PROJECT_NUMBER}', got '${projectNumber}'`
    );
  }
}

export function validateConfirmation(confirmation: string): void {
  if (confirmation !== "CONFIRM-RETIRE-OMPCTL") {
    throw new Error(
      "Confirmation guard failed: destructive retirement requires exact confirmation 'CONFIRM-RETIRE-OMPCTL'"
    );
  }
}

export function validateExecutionRef(ref: string): void {
  if (ref !== "refs/heads/main" && ref !== "main") {
    throw new Error(
      `Execution ref guard failed: retirement requires default branch 'refs/heads/main', got '${ref}'`
    );
  }
}

export function validateProjectDeleterPermission(hasPermission: boolean): void {
  if (!hasPermission) {
    throw new Error(
      "Project deletion permission guard failed: caller identity lacks 'resourcemanager.projects.delete' on project 'ompctl'. Project shutdown cannot succeed. Grant 'roles/resourcemanager.projectDeleter' before proceeding."
    );
  }
}

export function validateNoLiens(liens: unknown[]): void {
  if (!Array.isArray(liens)) {
    throw new Error("Liens query result must be an array");
  }
  if (liens.length > 0) {
    throw new Error(
      `Project has active deletion liens (${liens.length} found). Deletion liens indicate protective or cross-project dependencies. Project shutdown is halted.`
    );
  }
}

export function validateNoActiveDeployRuns(
  runs: Array<{ id: number; name: string; status: string; conclusion: string | null }>
): void {
  const active = runs.filter(
    (r) => r.status === "in_progress" || r.status === "queued" || r.status === "waiting"
  );
  if (active.length > 0) {
    const list = active.map((r) => `${r.name} (#${r.id}: ${r.status})`).join(", ");
    throw new Error(
      `Active deployment or publication runs detected: [${list}]. All deployment workflows must be inactive before retirement.`
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

  if (expectedSha) {
    if (baseline.gitSha !== expectedSha) {
      throw new Error(
        `DNS guard failed: baseline gitSha '${baseline.gitSha}' does not match expected '${expectedSha}'`
      );
    }
    if (cutover.gitSha !== expectedSha) {
      throw new Error(
        `DNS guard failed: cutover gitSha '${cutover.gitSha}' does not match expected '${expectedSha}'`
      );
    }
  }

  if (!baseline.delegatesToCloudDns) {
    throw new Error("DNS guard failed: baseline observation must confirm delegation to Cloud DNS");
  }

  if (cutover.delegatesToCloudDns) {
    throw new Error("DNS guard failed: cutover observation indicates domain still delegates to Cloud DNS");
  }

  if (!cutover.allParentsAgree) {
    throw new Error("DNS guard failed: cutover observation has mixed parent delegation (not all parents agree)");
  }

  // Verify all authoritative parent servers in cutover report non-Cloud-DNS nameservers
  for (const q of cutover.parentQueries) {
    if (q.status !== "NOERROR") {
      throw new Error(`DNS guard failed: cutover query to parent '${q.server}' returned status '${q.status}'`);
    }
    for (const ns of q.nameservers) {
      if (OLD_CLOUD_DNS_PATTERN.test(ns.name)) {
        throw new Error(
          `DNS guard failed: parent server '${q.server}' still returned Cloud DNS nameserver '${ns.name}' in cutover artifact`
        );
      }
    }
    if (q.dsRecords.length > 0) {
      throw new Error(`DNS guard failed: unexpected DS record present on parent '${q.server}'`);
    }
  }

  // Old TTL expiry check
  const requiredElapsedSeconds = Math.max(baseline.oldMaxChildNsTtl, 21600);
  const actualElapsedSeconds = Math.floor((currentTimestampMs - cutoverTimestampMs) / 1000);

  if (actualElapsedSeconds < requiredElapsedSeconds) {
    throw new Error(
      `DNS guard failed: elapsed time since cutover (${actualElapsedSeconds}s) has not exceeded the required old TTL window (${requiredElapsedSeconds}s). Caches may still direct traffic to Cloud DNS.`
    );
  }

  // Real-time parent check at execution time
  if (currentObservations.delegatesToCloudDns) {
    throw new Error(
      "DNS guard failed: real-time parent nameserver check confirms delegation is still pointing to Cloud DNS"
    );
  }

  if (!currentObservations.allParentsAgree) {
    throw new Error(
      "DNS guard failed: real-time parent nameserver check shows mixed delegation across authoritative parent servers"
    );
  }

  // Host record checks
  for (const hostObs of currentObservations.hostRecordObservations) {
    if (!RETIRED_HOSTNAMES.includes(hostObs.host as (typeof RETIRED_HOSTNAMES)[number])) {
      continue;
    }
    for (const rec of hostObs.records) {
      if (/googlehosted\.com/i.test(rec.value) || /github\.io/i.test(rec.value)) {
        throw new Error(
          `DNS guard failed: retired host '${hostObs.host}' still points to retired cloud service target '${rec.value}'`
        );
      }
    }
  }
}
