/**
 * Type definitions and immutable identity constants for direct project shutdown
 * of ompctl (782181616134).
 */

export const EXPECTED_PROJECT_ID = "ompctl" as const;
export const EXPECTED_PROJECT_NUMBER = "782181616134" as const;
export const EXPECTED_REGION = "us-central1" as const;
export const EXPECTED_ROOT_DOMAIN = "ompctl.ai" as const;
export const EXPECTED_CI_PRINCIPAL =
  "serviceAccount:ompctl-deployer@ompctl.iam.gserviceaccount.com" as const;
export const EXPECTED_WIF_PROVIDER =
  "projects/782181616134/locations/global/workloadIdentityPools/ompctl-github/providers/github" as const;

export const AUTHORITATIVE_PARENT_SERVERS = [
  "a.nic.ai",
  "b.nic.ai",
  "c.nic.ai",
  "d.nic.ai",
  "e.nic.ai",
  "f.nic.ai",
] as const;

export const RETIRED_HOSTNAMES = [
  "ompctl.ai",
  "app.ompctl.ai",
  "hub.ompctl.ai",
  "www.ompctl.ai",
] as const;

export const OLD_CLOUD_DNS_PATTERN = /googledomains\.com/i;

export interface DnsRecordEntry {
  type: string;
  value: string;
  ttl: number;
}

export interface ParentServerQuery {
  server: string;
  status: string;
  nameservers: Array<{ name: string; ttl: number }>;
  dsRecords: Array<{ data: string; ttl: number }>;
  error?: string;
}

export interface HostRecordObservation {
  host: string;
  records: DnsRecordEntry[];
}

export interface DnsObservation {
  observationKind: "baseline" | "cutover";
  capturedAt: string;
  gitSha: string;
  workflowRunId: string;
  parentQueries: ParentServerQuery[];
  oldMaxChildNsTtl: number;
  hostRecordObservations: HostRecordObservation[];
  allParentsAgree: boolean;
  delegatesToCloudDns: boolean;
}

export type RetirementOperation = "observe" | "retire";

export interface HttpTransport {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

export interface DnsResolver {
  queryParentNs(server: string, domain: string): Promise<ParentServerQuery>;
  queryHost(host: string): Promise<DnsRecordEntry[]>;
}
