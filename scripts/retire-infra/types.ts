/**
 * Type definitions and immutable identity constants for ompctl infrastructure retirement.
 */

export const EXPECTED_PROJECT_ID = "ompctl" as const;
export const EXPECTED_PROJECT_NUMBER = "782181616134" as const;
export const EXPECTED_REGION = "us-central1" as const;
export const EXPECTED_STATE_BUCKET = "ompctl-terraform-state" as const;
export const EXPECTED_STATE_PREFIX = "hub" as const;
export const EXPECTED_ZONE_NAME = "ompctl-ai" as const;
export const EXPECTED_DNS_NAME = "ompctl.ai." as const;
export const EXPECTED_ROOT_DOMAIN = "ompctl.ai" as const;

/**
 * Exactly 19 baseline managed Terraform addresses confirmed from deployment
 * run 38706883329 and packages/hub/deploy/main.tf.
 */
export const BASELINE_TERRAFORM_ADDRESSES = [
  "google_cloud_run_v2_service.hub",
  "google_cloud_run_v2_service.web",
  "google_cloud_run_v2_service_iam_member.hub_public",
  "google_cloud_run_v2_service_iam_member.web_public",
  "google_dns_managed_zone.ompctl",
  "google_dns_record_set.apex_txt",
  "google_dns_record_set.app",
  "google_dns_record_set.dmarc",
  "google_dns_record_set.domainkey",
  "google_dns_record_set.hub",
  "google_dns_record_set.root_a",
  "google_dns_record_set.root_aaaa",
  "google_dns_record_set.www",
  "google_project_iam_member.deployer_dns",
  "google_redis_instance.hub",
  "google_secret_manager_secret.operator_token",
  "google_secret_manager_secret_iam_member.hub_reads_operator_token",
  "google_service_account.hub",
  "google_service_account.web",
] as const;

export type TerraformAddress = (typeof BASELINE_TERRAFORM_ADDRESSES)[number];

/**
 * Confirmed unmanaged Cloud Run domain mappings identified during live owner inventory.
 * All four mappings reside in region us-central1 outside Terraform management.
 */
export const CONFIRMED_CLOUD_RUN_MAPPINGS = [
  "app.ompctl.ai",
  "hub.ompctl.ai",
  "ompctl.ai",
  "www.ompctl.ai",
] as const;

export type ConfirmedDomainMapping = (typeof CONFIRMED_CLOUD_RUN_MAPPINGS)[number];

export const EXPECTED_SUBSTRATE_RESOURCES = {
  vpcConnector: "ompctl-connector",
  artifactRepo: "ompd",
  cloudBuildBucket: "ompctl_cloudbuild",
  stateBucket: "ompctl-terraform-state",
} as const;

export const EXPLICIT_SURVIVORS = [
  "Squarespace domain registration for ompctl.ai",
  "Git repository jwaldrip/ompctl, worktrees, branches, and commit history",
  "Developer and owner Google accounts (jason@waldrip.net)",
  "Unrelated Google Cloud projects and shared developer infrastructure",
] as const;

export interface SanitizedManifest {
  manifestVersion: "1.0.0";
  sourceSha: string;
  createdAt: string;
  targetProject: {
    projectId: typeof EXPECTED_PROJECT_ID;
    projectNumber: typeof EXPECTED_PROJECT_NUMBER;
    region: typeof EXPECTED_REGION;
  };
  stateMetadata: {
    bucket: typeof EXPECTED_STATE_BUCKET;
    prefix: typeof EXPECTED_STATE_PREFIX;
    workspace: string;
    lineage?: string;
    serial?: number;
  };
  terraformAddresses: string[];
  outOfStateDomainMappings: string[];
  substrateResources: {
    vpcConnector: string;
    artifactRepo: string;
    cloudBuildBucket: string;
    stateBucket: string;
  };
  retainedAssets: string[];
  checksum: string;
}

export type RetirementOperation =
  | "inventory"
  | "prepare"
  | "retire-routing"
  | "destroy-terraform"
  | "cleanup-substrate"
  | "delete-project";
