#!/usr/bin/env bun
/**
 * CLI driver for guarded ompctl infrastructure retirement.
 *
 * Usage:
 *   bun scripts/retire-infra/cli.ts inventory [--out <manifest-path>]
 *   bun scripts/retire-infra/cli.ts prepare --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path>
 *   bun scripts/retire-infra/cli.ts retire-routing --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path> [--skip-nameserver-check]
 *   bun scripts/retire-infra/cli.ts destroy-terraform --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path>
 *   bun scripts/retire-infra/cli.ts cleanup-substrate --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path>
 *   bun scripts/retire-infra/cli.ts delete-project --confirm CONFIRM-RETIRE-OMPCTL --manifest-path <path>
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateCloudRunStateProtection,
  validateEmptyTerraformState,
  validateNameserverDelegation,
  validateNoLiens,
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
  let confirmValue = "";
  let skipNsCheck = false;
  let projectId = process.env.GCP_PROJECT_ID || EXPECTED_PROJECT_ID;
  let projectNumber = process.env.GCP_PROJECT_NUMBER || EXPECTED_PROJECT_NUMBER;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--manifest-path" || args[i] === "--out") {
      manifestPath = args[++i];
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

async function opInventory(manifestPath: string, projectId: string, projectNumber: string): Promise<void> {
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
  for (const mapping of CONFIRMED_CLOUD_RUN_MAPPINGS) {
    if (!discoveredMappings.includes(mapping)) {
      console.warn(`Warning: Expected mapping '${mapping}' was not found in list output`);
    }
  }

  console.log("Querying Terraform state metadata...");
  let stateLineage: string | undefined;
  let stateSerial: number | undefined;

  try {
    const stateObj = await runJsonCommand<{ generation?: string; updated?: string }>([
      "gcloud",
      "storage",
      "objects",
      "describe",
      `gs://${EXPECTED_STATE_BUCKET}/hub/default.tfstate`,
      "--format=json",
    ]);
    console.log(`✓ State object found: generation=${stateObj.generation}, updated=${stateObj.updated}`);
  } catch (err) {
    console.warn("Notice: Could not read state object metadata directly via gcloud storage");
  }

  const gitSha = (await runCommand(["git", "rev-parse", "HEAD"], { captureOutput: true })).stdout.trim();

  const manifest = createSanitizedManifest({
    sourceSha: gitSha,
    stateLineage,
    stateSerial,
    discoveredDomainMappings: discoveredMappings.length > 0 ? discoveredMappings : [...CONFIRMED_CLOUD_RUN_MAPPINGS],
    terraformAddresses: [...BASELINE_TERRAFORM_ADDRESSES],
  });

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`✓ Sanitized manifest generated at: ${manifestPath}`);
  console.log(`✓ Manifest Checksum: ${manifest.checksum}`);
  console.log("Manifest contains NO secrets, tokens, or raw state dumps.");
}

async function opPrepare(manifestPath: string, projectId: string, projectNumber: string): Promise<void> {
  console.log("==> Stage: PREPARE (Cloud Run deletion-protection preparation)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'. Run inventory stage first.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(`✓ Manifest verified: checksum ${manifest.checksum}`);

  const tfDir = join(process.cwd(), "packages", "hub", "deploy");
  console.log("Initializing Terraform...");
  await runCommand(
    [
      "terraform",
      "-chdir=" + tfDir,
      "init",
      "-input=false",
      "-lockfile=readonly",
      `-backend-config=bucket=${manifest.stateMetadata.bucket}`,
    ]
  );

  console.log("Generating preparation plan...");
  const planFile = "prepare.tfplan";
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "plan",
    "-input=false",
    "-out=" + planFile,
    `-var=project_id=${projectId}`,
    `-var=region=${EXPECTED_REGION}`,
  ]);

  console.log("Validating plan against guard rules...");
  const planJson = await runJsonCommand<unknown>([
    "terraform",
    "-chdir=" + tfDir,
    "show",
    "-json",
    planFile,
  ]);
  const validation = validateTerraformPlanForPrepare(planJson);
  console.log(`✓ Plan validation passed: ${validation.affectedAddresses.length} updates, 0 creates, 0 deletes.`);

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
  projectId: string,
  projectNumber: string,
  skipNsCheck: boolean
): Promise<void> {
  console.log("==> Stage: RETIRE-ROUTING (Routing decommissioning and unpublish)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(`✓ Manifest verified: checksum ${manifest.checksum}`);

  console.log("Checking authoritative nameserver delegation for ompctl.ai...");
  let currentNameservers: string[] = [];
  try {
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
  console.log("✓ Nameserver delegation check passed.");

  console.log("Unpublishing GitHub Pages / custom domain if active...");
  try {
    await runCommand(["gh", "api", "--method", "DELETE", "/repos/jwaldrip/ompctl/pages"]);
    console.log("✓ GitHub Pages site unpublished.");
  } catch (err) {
    console.log("Notice: Pages unpublish call returned non-zero (site may already be unpublished).");
  }

  console.log("Deleting confirmed unmanaged Cloud Run domain mappings...");
  for (const domain of manifest.outOfStateDomainMappings) {
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

async function opDestroyTerraform(manifestPath: string, projectId: string, projectNumber: string): Promise<void> {
  console.log("==> Stage: DESTROY-TERRAFORM (Managed infrastructure destruction)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(`✓ Manifest verified: checksum ${manifest.checksum}`);

  const tfDir = join(process.cwd(), "packages", "hub", "deploy");
  console.log("Generating destroy plan...");
  const planFile = "destroy.tfplan";
  await runCommand([
    "terraform",
    "-chdir=" + tfDir,
    "plan",
    "-destroy",
    "-input=false",
    "-out=" + planFile,
    `-var=project_id=${projectId}`,
    `-var=region=${EXPECTED_REGION}`,
  ]);

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

async function opCleanupSubstrate(manifestPath: string, projectId: string, projectNumber: string): Promise<void> {
  console.log("==> Stage: CLEANUP-SUBSTRATE (Substrate and state bucket cleanup)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  validateSubstrateParameters(manifest.substrateResources);
  console.log(`✓ Manifest substrate validated.`);

  console.log(`Deleting VPC access connector '${manifest.substrateResources.vpcConnector}'...`);
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

  console.log(`Deleting Artifact Registry repository '${manifest.substrateResources.artifactRepo}'...`);
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

  console.log(`Deleting CloudBuild storage bucket 'gs://${manifest.substrateResources.cloudBuildBucket}'...`);
  await runCommand([
    "gcloud",
    "storage",
    "rm",
    "--recursive",
    `gs://${manifest.substrateResources.cloudBuildBucket}`,
  ]);
  console.log("✓ CloudBuild storage bucket removed.");

  console.log(`Deleting Terraform state bucket 'gs://${manifest.substrateResources.stateBucket}'...`);
  await runCommand([
    "gcloud",
    "storage",
    "rm",
    "--recursive",
    `gs://${manifest.substrateResources.stateBucket}`,
  ]);
  console.log("✓ Terraform state bucket removed.");
}

async function opDeleteProject(manifestPath: string, projectId: string, projectNumber: string): Promise<void> {
  console.log("==> Stage: DELETE-PROJECT (Terminal Google Cloud Project Shutdown)");
  validateProjectIdentity(projectId, projectNumber);

  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest file not found at '${manifestPath}'.`);
  }
  const manifest = verifyManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  console.log(`✓ Manifest verified: checksum ${manifest.checksum}`);

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
  const { operation, manifestPath, confirmValue, skipNsCheck, projectId, projectNumber } = parseArgs(
    process.argv.slice(2)
  );

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
  }

  try {
    switch (operation) {
      case "inventory":
        await opInventory(manifestPath, projectId, projectNumber);
        break;
      case "prepare":
        await opPrepare(manifestPath, projectId, projectNumber);
        break;
      case "retire-routing":
        await opRetireRouting(manifestPath, projectId, projectNumber, skipNsCheck);
        break;
      case "destroy-terraform":
        await opDestroyTerraform(manifestPath, projectId, projectNumber);
        break;
      case "cleanup-substrate":
        await opCleanupSubstrate(manifestPath, projectId, projectNumber);
        break;
      case "delete-project":
        await opDeleteProject(manifestPath, projectId, projectNumber);
        break;
    }
  } catch (err) {
    console.error(`\n[FATAL GUARD FAILURE in stage '${operation}']`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
