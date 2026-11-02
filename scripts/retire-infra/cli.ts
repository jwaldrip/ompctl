#!/usr/bin/env bun
/**
 * CLI driver for guarded ompctl infrastructure retirement.
 *
 * Usage:
 *   bun scripts/retire-infra/cli.ts inventory [--out <manifest-path>]
 *   bun scripts/retire-infra/cli.ts prepare --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path> --manifest-sha <sha>
 *   bun scripts/retire-infra/cli.ts retire-routing --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path> --manifest-sha <sha> [--skip-nameserver-check]
 *   bun scripts/retire-infra/cli.ts destroy-terraform --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path> --manifest-sha <sha> [--skip-nameserver-check]
 *   bun scripts/retire-infra/cli.ts cleanup-substrate --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path> --manifest-sha <sha>
 *   bun scripts/retire-infra/cli.ts delete-project --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path> --manifest-sha <sha> [--skip-nameserver-check]
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractStateResources,
  validateCloudRunStateProtection,
  validateEmptyTerraformState,
  validateNameserverDelegation,
  validateNoLiens,
  validateProjectDeleterPermission,
  validateProjectIdentity,
  validateSubstrateParameters,
  validateTerraformPlanForDestroy,
  validateTerraformPlanForPrepare,
} from "./guards.ts";
import { createSanitizedManifest, verifyManifest } from "./manifest.ts";
import {
  BASELINE_TERRAFORM_ADDRESSES,
  CONFIRMED_CLOUD_RUN_MAPPINGS,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  EXPECTED_REGION,
  EXPECTED_STATE_BUCKET,
  type RetirementOperation,
} from "./types.ts";

const REQUIRED_CONFIRMATION = "CONFIRM-RETIRE-OMPCTL";

function parseArgs(args: string[]): {
  operation: RetirementOperation;
  manifestPath: string;
  manifestSha: string;
  confirmValue: string;
  skipNsCheck: boolean;
  projectId: string;
  projectNumber: string;
} {
  const op = args[0] as RetirementOperation;
  const validOps: Record<RetirementOperation, true> = {
    inventory: true,
    prepare: true,
    "retire-routing": true,
    "destroy-terraform": true,
    "cleanup-substrate": true,
    "delete-project": true,
  };

  if (!op || !validOps[op]) {
    console.error(
      `Invalid or missing operation: '${String(op)}'. Valid operations: ${Object.keys(validOps).join(", ")}`
    );
    process.exit(1);
  }

  let manifestPath = "sanitized-manifest.json";
  let manifestSha = "";
  let confirmValue = "";
  let skipNsCheck = false;
  let projectId = process.env.GCP_PROJECT_ID || EXPECTED_PROJECT_ID;
  let projectNumber = process.env.GCP_PROJECT_NUMBER || EXPECTED_PROJECT_NUMBER;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--manifest-path" || args[i] === "--out") {
      manifestPath = args[++i];
    } else if (args[i] === "--manifest-sha") {
      manifestSha = args[++i];
    } else if (args[i] === "--confirm") {
      confirmValue = args[++i];
    } else if (args[i] === "--skip-nameserver-check") {
      skipNsCheck = true;
    } else if (args[i] === "--project-id") {
      projectId = args[++i];
    } else if (args[i] === "--project-number") {
      projectNumber = args[++i];
    }
  }

  return {
    operation: op,
    manifestPath,
    manifestSha,
    confirmValue,
    skipNsCheck,
    projectId,
    projectNumber,
  };
}

async function runCommand(
  cmd: string[],
  options: { cwd?: string; env?: Record<string, string>; captureOutput?: boolean } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdout: options.captureOutput ? "pipe" : "inherit",
    stderr: options.captureOutput ? "pipe" : "inherit",
  });

  const exitCode = await proc.exited;
  let stdout = "";
  let stderr = "";

  if (options.captureOutput) {
    if (proc.stdout) {
      stdout = await new Response(proc.stdout).text();
    }
    if (proc.stderr) {
      stderr = await new Response(proc.stderr).text();
    }
  }

  if (exitCode !== 0) {
    const errorMsg = `Command failed with exit code ${exitCode}: ${cmd.join(" ")}`;
    if (options.captureOutput && stderr) {
      console.error(stderr);
    }
    throw new Error(errorMsg);
  }

  return { stdout, stderr, exitCode };
}

async function runJsonCommand<T>(cmd: string[]): Promise<T> {
  const { stdout } = await runCommand(cmd, { captureOutput: true });
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    throw new Error(
      `Failed to parse JSON output from command '${cmd.join(" ")}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function checkNameservers(skipNsCheck: boolean): Promise<void> {
  console.log("Checking authoritative parent nameserver delegation for ompctl.ai...");
  let currentNameservers: string[] = [];

  try {
    // Query authoritative parent delegation directly
    const digOutput = await runCommand(
      ["dig", "+short", "NS", "ompctl.ai"],
      { captureOutput: true }
    );
    currentNameservers = digOutput.stdout
      .split("\n")
      .map((s) => s.trim().replace(/\.$/, ""))
      .filter((s) => s.length > 0);
  } catch {
    console.warn("Notice: Could not resolve NS records via dig.");
  }

  validateNameserverDelegation(currentNameservers, skipNsCheck);
  console.log(`✓ Nameserver delegation verified (${currentNameservers.join(", ")}).`);
}

async function resolveLiveServiceInputs(projectId: string): Promise<Record<string, string>> {
  console.log("Resolving live service configurations for Terraform inputs...");

  let hubImage = "";
  let webImage = "";
  let connectorId = `projects/${projectId}/locations/${EXPECTED_REGION}/connectors/ompctl-connector`;
  const networkId = `projects/${projectId}/global/networks/default`;
  let appleTeamId = process.env.OMPCTL_APPLE_TEAM_ID || "";
  let playCertSha = process.env.OMPCTL_PLAY_CERT_SHA256 || "";

  try {
    const hubDesc = await runJsonCommand<{
      spec?: { template?: { spec?: { containers?: Array<{ image?: string }> } } };
      template?: { containers?: Array<{ image?: string }>; vpc_access?: { connector?: string } };
    }>([
      "gcloud",
      "run",
      "services",
      "describe",
      "ompd-hub",
      `--project=${projectId}`,
      `--region=${EXPECTED_REGION}`,
      "--format=json",
    ]);

    hubImage =
      hubDesc.spec?.template?.spec?.containers?.[0]?.image ||
      hubDesc.template?.containers?.[0]?.image ||
      "";
    if (hubDesc.template?.vpc_access?.connector) {
      connectorId = hubDesc.template.vpc_access.connector;
    }
  } catch {
    console.warn("Warning: Could not read live ompd-hub service description via gcloud");
  }

  try {
    const webDesc = await runJsonCommand<{
      spec?: {
        template?: {
          spec?: {
            containers?: Array<{
              image?: string;
              env?: Array<{ name?: string; value?: string }>;
            }>;
          };
        };
      };
      template?: {
        containers?: Array<{
          image?: string;
          env?: Array<{ name?: string; value?: string }>;
        }>;
      };
    }>([
      "gcloud",
      "run",
      "services",
      "describe",
      "ompctl-web",
      `--project=${projectId}`,
      `--region=${EXPECTED_REGION}`,
      "--format=json",
    ]);

    webImage =
      webDesc.spec?.template?.spec?.containers?.[0]?.image ||
      webDesc.template?.containers?.[0]?.image ||
      "";

    const envs =
      webDesc.spec?.template?.spec?.containers?.[0]?.env ||
      webDesc.template?.containers?.[0]?.env ||
      [];
    for (const e of envs) {
      if (e.name === "OMPCTL_APPLE_TEAM_ID" && e.value) appleTeamId = e.value;
      if (e.name === "OMPCTL_PLAY_CERT_SHA256" && e.value) playCertSha = e.value;
    }
  } catch {
    console.warn("Warning: Could not read live ompctl-web service description via gcloud");
  }

  // Fallbacks if not obtainable from live service (must satisfy schema validations in main.tf)
  if (!appleTeamId) appleTeamId = "AAAAAAAAAA";
  if (!playCertSha) playCertSha = "0000000000000000000000000000000000000000000000000000000000000000";

  return {
    project_id: projectId,
    region: EXPECTED_REGION,
    image: hubImage || `us-central1-docker.pkg.dev/${projectId}/ompd/hub:live`,
    web_image: webImage || `us-central1-docker.pkg.dev/${projectId}/ompd/web:live`,
    connector_id: connectorId,
    network_id: networkId,
    apple_team_id: appleTeamId,
    play_cert_sha256: playCertSha,
  };
}

async function opInventory(
  manifestPath: string,
  projectId: string,
  projectNumber: string
): Promise<void> {
  console.log("==> Stage: INVENTORY (Read-only live resource discovery)");
  validateProjectIdentity(projectId, projectNumber);

  console.log(`Checking project identity for '${projectId}'...`);
  const projectDesc = await runJsonCommand<{ projectNumber?: string; lifecycleState?: string }>([
    "gcloud",
    "projects",
    "describe",
    projectId,
    "--format=json",
  ]);

  if (projectDesc.projectNumber !== EXPECTED_PROJECT_NUMBER) {
    throw new Error(
      `Project number mismatch: live reported '${projectDesc.projectNumber}', expected '${EXPECTED_PROJECT_NUMBER}'`
    );
  }
  console.log(`✓ Project verified: ${projectId} (number: ${projectDesc.projectNumber}, state: ${projectDesc.lifecycleState})`);

  console.log("Preflighting project deletion permissions...");
  try {
    const permTest = await runJsonCommand<{ permissions?: string[] }>([
      "gcloud",
      "projects",
      "test-iam-permissions",
      projectId,
      "resourcemanager.projects.delete",
      "--format=json",
    ]);
    const perms = permTest.permissions ?? [];
    if (!perms.includes("resourcemanager.projects.delete")) {
      console.warn(
        "Warning: Deployer identity currently lacks 'resourcemanager.projects.delete'. Owner must grant 'roles/resourcemanager.projectDeleter' before delete-project stage."
      );
    } else {
      console.log("✓ Project deletion permission verified.");
    }
  } catch (err) {
    console.warn("Notice: test-iam-permissions query failed:", err instanceof Error ? err.message : String(err));
  }

  console.log("Checking project deletion liens...");
  const liens = await runJsonCommand<unknown[]>([
    "gcloud",
    "alpha",
    "resource-manager",
    "liens",
    "list",
    `--project=${projectId}`,
    "--format=json",
  ]);
  validateNoLiens(liens);
  console.log("✓ No project liens found.");

  console.log("Checking Cloud Run domain mappings...");
  const mappings = await runJsonCommand<Array<{ metadata?: { name?: string } }>>([
    "gcloud",
    "beta",
    "run",
    "domain-mappings",
    "list",
    `--project=${projectId}`,
    `--region=${EXPECTED_REGION}`,
    "--format=json",
  ]);
  const discoveredMappings = mappings
    .map((m) => m.metadata?.name ?? "")
    .filter((n) => n.length > 0)
    .sort();

  console.log(`Discovered Cloud Run domain mappings: ${discoveredMappings.join(", ")}`);

  console.log("Reading live Terraform state from backend...");
  let stateLineage: string | undefined;
  let stateSerial: number | undefined;
  let discoveredAddresses: string[] = [];

  const tfDir = join(process.cwd(), "packages", "hub", "deploy");
  try {
    await runCommand([
      "terraform",
      "-chdir=" + tfDir,
      "init",
      "-input=false",
      "-lockfile=readonly",
      `-backend-config=bucket=${EXPECTED_STATE_BUCKET}`,
    ]);

    const stateJson = await runJsonCommand<Record<string, unknown>>([
      "terraform",
      "-chdir=" + tfDir,
      "show",
      "-json",
    ]);

    stateLineage = typeof stateJson.lineage === "string" ? stateJson.lineage : undefined;
    stateSerial = typeof stateJson.serial === "number" ? stateJson.serial : undefined;

    const extracted = extractStateResources(stateJson);
    discoveredAddresses = extracted.map((r) => r.address).sort();
    console.log(`✓ Read ${discoveredAddresses.length} managed resources from live state.`);
  } catch (err) {
    console.warn("Notice: Could not query terraform show -json directly during inventory:", err);
    discoveredAddresses = [...BASELINE_TERRAFORM_ADDRESSES];
  }

  const gitSha = (await runCommand(["git", "rev-parse", "HEAD"], { captureOutput: true })).stdout.trim();

  const manifest = createSanitizedManifest({
    sourceSha: gitSha,
    stateLineage,
    stateSerial,
    discoveredDomainMappings:
      discoveredMappings.length > 0 ? discoveredMappings : [...CONFIRMED_CLOUD_RUN_MAPPINGS],
    terraformAddresses:
      discoveredAddresses.length > 0 ? discoveredAddresses : [...BASELINE_TERRAFORM_ADDRESSES],
  });

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`✓ Sanitized manifest generated at: ${manifestPath}`);
  console.log(`✓ Manifest Checksum: ${manifest.checksum}`);
  console.log("Manifest contains NO secrets, tokens, or raw state dumps.");
}

async function opPrepare(
  manifestPath: string,
  manifestSha: string,
  projectId: string,
  projectNumber: string
): Promise<void> {
  console.log("==> Stage: PREPARE (Cloud Run deletion-protection preparation)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), manifestSha);
  console.log(`✓ Manifest verified against operator approval: checksum ${manifest.checksum}`);

  const tfDir = join(process.cwd(), "packages", "hub", "deploy");
  console.log("Initializing Terraform backend...");
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "init",
    "-input=false",
    "-lockfile=readonly",
    `-backend-config=bucket=${manifest.stateMetadata.bucket}`,
  ]);

  const tfVars = await resolveLiveServiceInputs(projectId);

  console.log("Generating preparation plan...");
  const planFile = "prepare.tfplan";
  const planArgs = [
    "terraform",
    "-chdir=" + tfDir,
    "plan",
    "-input=false",
    "-out=" + planFile,
  ];
  for (const [k, v] of Object.entries(tfVars)) {
    planArgs.push(`-var=${k}=${v}`);
  }
  await runCommand(planArgs);

  console.log("Validating plan against guard rules...");
  const planJson = await runJsonCommand<unknown>([
    "terraform",
    "-chdir=" + tfDir,
    "show",
    "-json",
    planFile,
  ]);
  const validation = validateTerraformPlanForPrepare(planJson);
  console.log(
    `✓ Plan validation passed: ${validation.actionCounts.update} updates, ${validation.actionCounts.noOpOrRead} already prepared, 0 creates, 0 deletes.`
  );

  console.log("Applying preparation plan...");
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "apply",
    "-input=false",
    planFile,
  ]);

  console.log("Verifying state has deletion_protection = false on both services...");
  const stateJson = await runJsonCommand<unknown>([
    "terraform",
    "-chdir=" + tfDir,
    "show",
    "-json",
  ]);
  validateCloudRunStateProtection(stateJson);
  console.log("✓ Cloud Run deletion_protection successfully verified as false in state.");
}

async function opRetireRouting(
  manifestPath: string,
  manifestSha: string,
  projectId: string,
  projectNumber: string,
  skipNsCheck: boolean
): Promise<void> {
  console.log("==> Stage: RETIRE-ROUTING (Routing decommissioning and unpublish)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), manifestSha);
  console.log(`✓ Manifest verified against operator approval: checksum ${manifest.checksum}`);

  await checkNameservers(skipNsCheck);

  console.log("Unpublishing GitHub Pages / custom domain if active...");
  try {
    await runCommand(["gh", "api", "--method", "DELETE", "/repos/jwaldrip/ompctl/pages"]);
    console.log("✓ GitHub Pages site unpublished.");
  } catch (err) {
    const errText = err instanceof Error ? err.message : String(err);
    if (/404|Not Found/i.test(errText)) {
      console.log("✓ GitHub Pages site is already absent/unpublished.");
    } else {
      throw new Error(`Failed to unpublish GitHub Pages: ${errText}`);
    }
  }

  console.log("Deleting confirmed unmanaged Cloud Run domain mappings (resumable)...");
  // Query currently existing mappings
  const liveMappings = await runJsonCommand<Array<{ metadata?: { name?: string } }>>([
    "gcloud",
    "beta",
    "run",
    "domain-mappings",
    "list",
    `--project=${projectId}`,
    `--region=${EXPECTED_REGION}`,
    "--format=json",
  ]);
  const liveSet: Record<string, true> = Object.fromEntries(
    liveMappings.map((m) => [m.metadata?.name ?? "", true])
  );

  for (const domain of manifest.outOfStateDomainMappings) {
    if (!liveSet[domain]) {
      console.log(`Mapping '${domain}' is already absent.`);
      continue;
    }

    console.log(`Deleting Cloud Run domain mapping for '${domain}'...`);
    await runCommand([
      "gcloud",
      "beta",
      "run",
      "domain-mappings",
      "delete",
      `--domain=${domain}`,
      `--project=${projectId}`,
      `--region=${EXPECTED_REGION}`,
      "--quiet",
    ]);
    console.log(`✓ Mapping '${domain}' deleted.`);
  }
}

async function opDestroyTerraform(
  manifestPath: string,
  manifestSha: string,
  projectId: string,
  projectNumber: string,
  skipNsCheck: boolean
): Promise<void> {
  console.log("==> Stage: DESTROY-TERRAFORM (Managed infrastructure destruction)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), manifestSha);
  console.log(`✓ Manifest verified against operator approval: checksum ${manifest.checksum}`);

  // Enforce nameserver delegation check before destroying the Cloud DNS zone
  await checkNameservers(skipNsCheck);

  const tfDir = join(process.cwd(), "packages", "hub", "deploy");
  console.log("Initializing Terraform backend...");
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "init",
    "-input=false",
    "-lockfile=readonly",
    `-backend-config=bucket=${manifest.stateMetadata.bucket}`,
  ]);

  const tfVars = await resolveLiveServiceInputs(projectId);

  console.log("Generating destroy plan...");
  const planFile = "destroy.tfplan";
  const planArgs = [
    "terraform",
    "-chdir=" + tfDir,
    "plan",
    "-destroy",
    "-input=false",
    "-out=" + planFile,
  ];
  for (const [k, v] of Object.entries(tfVars)) {
    planArgs.push(`-var=${k}=${v}`);
  }
  await runCommand(planArgs);

  console.log("Validating destroy plan against manifest and baseline...");
  const planJson = await runJsonCommand<unknown>([
    "terraform",
    "-chdir=" + tfDir,
    "show",
    "-json",
    planFile,
  ]);
  const validation = validateTerraformPlanForDestroy(planJson, manifest);
  console.log(
    `✓ Destroy plan validated: exactly ${validation.affectedAddresses.length} deletions, 0 creates, 0 updates.`
  );

  console.log("Applying destroy plan...");
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "apply",
    "-input=false",
    planFile,
  ]);

  console.log("Verifying Terraform state is completely empty of managed resources...");
  const stateJson = await runJsonCommand<unknown>([
    "terraform",
    "-chdir=" + tfDir,
    "show",
    "-json",
  ]);
  validateEmptyTerraformState(stateJson);
  console.log("✓ Managed stack destruction confirmed: state is empty.");
}

async function opCleanupSubstrate(
  manifestPath: string,
  manifestSha: string,
  projectId: string,
  projectNumber: string
): Promise<void> {
  console.log("==> Stage: CLEANUP-SUBSTRATE (Substrate and state bucket cleanup)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), manifestSha);
  validateSubstrateParameters(manifest.substrateResources);
  console.log(`✓ Manifest substrate validated.`);

  console.log("Verifying Terraform state backend is completely empty before bucket deletion...");
  const tfDir = join(process.cwd(), "packages", "hub", "deploy");
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "init",
    "-input=false",
    "-lockfile=readonly",
    `-backend-config=bucket=${manifest.stateMetadata.bucket}`,
  ]);
  const stateJson = await runJsonCommand<unknown>([
    "terraform",
    "-chdir=" + tfDir,
    "show",
    "-json",
  ]);
  validateEmptyTerraformState(stateJson);
  console.log("✓ Verified state backend contains 0 managed resources.");

  // Delete VPC access connector if present
  console.log(`Deleting VPC access connector '${manifest.substrateResources.vpcConnector}'...`);
  try {
    await runCommand([
      "gcloud",
      "compute",
      "networks",
      "vpc-access",
      "connectors",
      "delete",
      manifest.substrateResources.vpcConnector,
      `--project=${projectId}`,
      `--region=${EXPECTED_REGION}`,
      "--quiet",
    ]);
    console.log("✓ VPC connector deleted.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NOT_FOUND|not found/i.test(msg)) {
      console.log("✓ VPC connector is already absent.");
    } else {
      throw err;
    }
  }

  // Delete Artifact Registry repository if present
  console.log(`Deleting Artifact Registry repository '${manifest.substrateResources.artifactRepo}'...`);
  try {
    await runCommand([
      "gcloud",
      "artifacts",
      "repositories",
      "delete",
      manifest.substrateResources.artifactRepo,
      `--project=${projectId}`,
      `--location=${EXPECTED_REGION}`,
      "--quiet",
    ]);
    console.log("✓ Artifact repository deleted.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NOT_FOUND|not found/i.test(msg)) {
      console.log("✓ Artifact repository is already absent.");
    } else {
      throw err;
    }
  }

  // Delete CloudBuild staging bucket if present
  console.log(`Deleting CloudBuild storage bucket 'gs://${manifest.substrateResources.cloudBuildBucket}'...`);
  try {
    await runCommand([
      "gcloud",
      "storage",
      "rm",
      "--recursive",
      `gs://${manifest.substrateResources.cloudBuildBucket}`,
    ]);
    console.log("✓ CloudBuild storage bucket removed.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/BucketNotFound|NotFound|not found/i.test(msg)) {
      console.log("✓ CloudBuild bucket is already absent.");
    } else {
      throw err;
    }
  }

  // Delete Terraform state bucket
  console.log(`Deleting Terraform state bucket 'gs://${manifest.substrateResources.stateBucket}'...`);
  try {
    await runCommand([
      "gcloud",
      "storage",
      "rm",
      "--recursive",
      `gs://${manifest.substrateResources.stateBucket}`,
    ]);
    console.log("✓ Terraform state bucket removed.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/BucketNotFound|NotFound|not found/i.test(msg)) {
      console.log("✓ Terraform state bucket is already absent.");
    } else {
      throw err;
    }
  }
}

async function opDeleteProject(
  manifestPath: string,
  manifestSha: string,
  projectId: string,
  projectNumber: string,
  skipNsCheck: boolean
): Promise<void> {
  console.log("==> Stage: DELETE-PROJECT (Terminal Google Cloud Project Shutdown)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")), manifestSha);
  console.log(`✓ Manifest verified against operator approval: checksum ${manifest.checksum}`);

  // Enforce nameserver delegation check before project deletion
  await checkNameservers(skipNsCheck);

  console.log("Checking for deletion liens before project shutdown...");
  const liens = await runJsonCommand<unknown[]>([
    "gcloud",
    "alpha",
    "resource-manager",
    "liens",
    "list",
    `--project=${projectId}`,
    "--format=json",
  ]);
  validateNoLiens(liens);
  console.log("✓ Zero liens confirmed.");

  console.log("Checking project deletion permissions...");
  const permTest = await runJsonCommand<{ permissions?: string[] }>([
    "gcloud",
    "projects",
    "test-iam-permissions",
    projectId,
    "resourcemanager.projects.delete",
    "--format=json",
  ]);
  const perms = permTest.permissions ?? [];
  validateProjectDeleterPermission(perms.includes("resourcemanager.projects.delete"));

  console.log("Executing project shutdown request...");
  await runCommand(["gcloud", "projects", "delete", projectId, "--quiet"]);

  console.log("\n========================================================");
  console.log(`PROJECT DELETION REQUESTED FOR: ${projectId} (${projectNumber})`);
  console.log("Per Google Cloud Resource Manager lifecycle semantics:");
  console.log("- The project has entered the DELETE_REQUESTED state.");
  console.log("- Google retains resources for a 30-day recovery window.");
  console.log("- Billing stops immediately for deleted resources.");
  console.log("- The project ID 'ompctl' will be permanently retired after 30 days.");
  console.log("========================================================\n");
}

async function main(): Promise<void> {
  const {
    operation,
    manifestPath,
    manifestSha,
    confirmValue,
    skipNsCheck,
    projectId,
    projectNumber,
  } = parseArgs(process.argv.slice(2));

  console.log(`ompctl Infrastructure Retirement Driver`);
  console.log(`Operation: ${operation}`);
  console.log(`Target Project: ${projectId} (${projectNumber})`);

  if (operation !== "inventory") {
    if (confirmValue !== REQUIRED_CONFIRMATION) {
      console.error(
        `Error: Destructive operation '${operation}' requires confirmation flag '--confirm ${REQUIRED_CONFIRMATION}'`
      );
      process.exit(1);
    }
    if (!manifestSha || manifestSha.trim() === "") {
      console.error(
        `Error: Destructive operation '${operation}' requires '--manifest-sha <checksum>' matching approved manifest.`
      );
      process.exit(1);
    }
  }

  try {
    switch (operation) {
      case "inventory":
        await opInventory(manifestPath, projectId, projectNumber);
        break;
      case "prepare":
        await opPrepare(manifestPath, manifestSha, projectId, projectNumber);
        break;
      case "retire-routing":
        await opRetireRouting(manifestPath, manifestSha, projectId, projectNumber, skipNsCheck);
        break;
      case "destroy-terraform":
        await opDestroyTerraform(manifestPath, manifestSha, projectId, projectNumber, skipNsCheck);
        break;
      case "cleanup-substrate":
        await opCleanupSubstrate(manifestPath, manifestSha, projectId, projectNumber);
        break;
      case "delete-project":
        await opDeleteProject(manifestPath, manifestSha, projectId, projectNumber, skipNsCheck);
        break;
    }
  } catch (err) {
    console.error(`\n[FATAL GUARD FAILURE in stage '${operation}']`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
