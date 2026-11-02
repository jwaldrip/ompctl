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

/**
 * The six actual authoritative .ai nameservers per IANA root zone database
 * (https://www.iana.org/domains/root/db/ai.html).
 */
export const AUTHORITATIVE_PARENT_SERVERS = [
  "v0n0.nic.ai",
  "v0n1.nic.ai",
  "v0n2.nic.ai",
  "v0n3.nic.ai",
  "v2n0.nic.ai",
  "v2n1.nic.ai",
] as const;

export const RETIRED_HOSTNAMES = [
  "ompctl.ai",
  "app.ompctl.ai",
  "hub.ompctl.ai",
  "www.ompctl.ai",
] as const;

export const OLD_CLOUD_DNS_PATTERN = /googledomains\.com/i;

export const RETIRED_DESTINATION_PATTERNS = [
  /googlehosted\.com/i,
  /github\.io/i,
  /googledomains\.com/i,
];

export const RETIRED_DESTINATION_IPS = [
  "185.199.108.153",
  "185.199.109.153",
  "185.199.110.153",
  "185.199.111.153",
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
] as const;

export const DEPLOYMENT_WORKFLOW_FILENAMES = [
  "hub-deploy.yml",
  "site-pages.yml",
  "app-store-distribute.yml",
] as const;

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
  hasAuthoritativeDenial?: boolean;
  error?: string;
}

export interface HostRecordObservation {
  host: string;
  recordType: string;
  status: string;
  records: DnsRecordEntry[];
  error?: string;
}

export interface DnsObservation {
  observationKind: "baseline" | "cutover";
  capturedAt: string;
  gitSha: string;
  workflowRunId: string;
  parentQueries: ParentServerQuery[];
  childNsQueries: Array<{
    server: string;
    nameservers: Array<{ name: string; ttl: number }>;
  }>;
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
  queryParentNsAndDs(server: string, domain: string): Promise<ParentServerQuery>;
  queryChildNs(server: string, domain: string): Promise<Array<{ name: string; ttl: number }>>;
  queryHostRecord(host: string, type: string): Promise<HostRecordObservation>;
}
