/**
 * Guard assertions and validators for ompctl infrastructure retirement.
 * All functions fail closed on unexpected input, missing attributes, or drift.
 */

import {
  BASELINE_TERRAFORM_ADDRESSES,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  EXPECTED_SUBSTRATE_RESOURCES,
  type SanitizedManifest,
} from "./types.ts";

export interface PlanValidationResult {
  valid: boolean;
  affectedAddresses: string[];
  actionCounts: {
    create: number;
    update: number;
    delete: number;
  };
}

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

interface TerraformResourceChange {
  address: string;
  type: string;
  name: string;
  provider_name?: string;
  change: {
    actions: string[];
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    after_unknown?: Record<string, unknown>;
  };
}

interface TerraformPlanJson {
  format_version?: string;
  terraform_version?: string;
  resource_changes?: TerraformResourceChange[];
}

export function validateTerraformPlanForPrepare(
  planJson: unknown
): PlanValidationResult {
  if (!planJson || typeof planJson !== "object") {
    throw new Error("Invalid plan JSON: root must be an object");
  }

  const plan = planJson as TerraformPlanJson;
  const changes = plan.resource_changes ?? [];

  let createCount = 0;
  let deleteCount = 0;
  let updateCount = 0;
  const affected: string[] = [];

  const allowedToUpdate = new Set<string>([
    "google_cloud_run_v2_service.hub",
    "google_cloud_run_v2_service.web",
  ]);

  for (const rc of changes) {
    const actions = rc.change.actions;
    if (actions.includes("create")) createCount++;
    if (actions.includes("delete")) deleteCount++;
    if (actions.includes("update")) updateCount++;

    const isNoOp =
      actions.length === 1 && (actions[0] === "no-op" || actions[0] === "read");
    if (isNoOp) {
      continue;
    }

    affected.push(rc.address);

    if (!allowedToUpdate.has(rc.address)) {
      throw new Error(
        `Prepare plan drift: unexpected resource change for '${rc.address}' with actions [${actions.join(
          ", "
        )}]. Only Cloud Run services may update during preparation.`
      );
    }

    if (actions.length !== 1 || actions[0] !== "update") {
      throw new Error(
        `Prepare plan drift: resource '${rc.address}' has actions [${actions.join(
          ", "
        )}], expected ['update']. No replacements or creates permitted.`
      );
    }

    // Verify that ONLY deletion_protection is changing to false
    const before = (rc.change.before ?? {}) as Record<string, unknown>;
    const after = (rc.change.after ?? {}) as Record<string, unknown>;

    if (after.deletion_protection !== false) {
      throw new Error(
        `Prepare plan drift: resource '${rc.address}' after.deletion_protection must be false, got ${String(
          after.deletion_protection
        )}`
      );
    }

    // Assert that runtime definitions did not drift
    assertPropertyUnchanged(rc.address, "template", before.template, after.template);
    assertPropertyUnchanged(rc.address, "ingress", before.ingress, after.ingress);
  }

  if (createCount > 0 || deleteCount > 0) {
    throw new Error(
      `Prepare plan rejected: creates (${createCount}) or deletes (${deleteCount}) detected. Preparation must strictly be 0 creates, 0 deletes.`
    );
  }

  const updatedSet = new Set(affected);
  for (const required of allowedToUpdate) {
    if (!updatedSet.has(required)) {
      throw new Error(
        `Prepare plan missing expected update for '${required}'. Both services must have deletion_protection flipped to false.`
      );
    }
  }

  return {
    valid: true,
    affectedAddresses: affected,
    actionCounts: {
      create: createCount,
      update: updateCount,
      delete: deleteCount,
    },
  };
}

function assertPropertyUnchanged(
  address: string,
  field: string,
  beforeVal: unknown,
  afterVal: unknown
): void {
  // If both are undefined/null, no change
  if (beforeVal === afterVal) return;

  const beforeStr = JSON.stringify(beforeVal ?? {});
  const afterStr = JSON.stringify(afterVal ?? {});
  if (beforeStr !== afterStr) {
    throw new Error(
      `Prepare plan drift: resource '${address}' field '${field}' changed between before and after. Template and runtime changes are forbidden during preparation.`
    );
  }
}

export function validateTerraformPlanForDestroy(
  planJson: unknown,
  manifest: SanitizedManifest
): PlanValidationResult {
  if (!planJson || typeof planJson !== "object") {
    throw new Error("Invalid plan JSON: root must be an object");
  }

  const plan = planJson as TerraformPlanJson;
  const changes = plan.resource_changes ?? [];

  const allowedAddresses = new Set<string>(manifest.terraformAddresses);
  const baselineAddresses = new Set<string>(BASELINE_TERRAFORM_ADDRESSES);

  let deleteCount = 0;
  let createCount = 0;
  let updateCount = 0;
  const affected: string[] = [];

  for (const rc of changes) {
    const actions = rc.change.actions;
    const isNoOp =
      actions.length === 1 && (actions[0] === "no-op" || actions[0] === "read");
    if (isNoOp) {
      continue;
    }

    if (actions.includes("create")) createCount++;
    if (actions.includes("update")) updateCount++;
    if (actions.includes("delete")) deleteCount++;

    affected.push(rc.address);

    if (actions.length !== 1 || actions[0] !== "delete") {
      throw new Error(
        `Destroy plan rejected: resource '${rc.address}' has non-delete actions [${actions.join(
          ", "
        )}]. Destructive destroy must only delete.`
      );
    }

    if (!allowedAddresses.has(rc.address)) {
      throw new Error(
        `Destroy plan rejected: resource '${rc.address}' is not present in the approved manifest deletion set.`
      );
    }

    if (!baselineAddresses.has(rc.address)) {
      throw new Error(
        `Destroy plan rejected: resource '${rc.address}' is not in the baseline 19 addresses.`
      );
    }
  }

  if (createCount > 0 || updateCount > 0) {
    throw new Error(
      `Destroy plan rejected: contains ${createCount} creates and ${updateCount} updates. Only deletes are permitted.`
    );
  }

  if (deleteCount === 0) {
    throw new Error("Destroy plan rejected: plan contains 0 deletions");
  }

  return {
    valid: true,
    affectedAddresses: affected,
    actionCounts: {
      create: createCount,
      update: updateCount,
      delete: deleteCount,
    },
  };
}

export function validateNameserverDelegation(
  currentNameservers: string[],
  skipCheck = false
): void {
  if (skipCheck) {
    return;
  }

  if (!currentNameservers || currentNameservers.length === 0) {
    throw new Error(
      "Nameserver guard: unable to determine authoritative nameservers for ompctl.ai."
    );
  }

  const googlePatterns = [/googledomains\.com/i, /google/i, /cloudflare/i];
  const pointsToCloudDns = currentNameservers.some((ns) =>
    googlePatterns.some((pat) => pat.test(ns))
  );

  if (pointsToCloudDns) {
    throw new Error(
      `Nameserver guard failed: registrar nameservers for ompctl.ai still delegate to Cloud DNS (${currentNameservers.join(
        ", "
      )}). Destroying the Cloud DNS zone while parent delegation is active creates a dangling nameserver hijacking vulnerability. Switch nameservers at Squarespace before running destroy, or pass skip_nameserver_check=true with verified justification.`
    );
  }
}

interface TerraformStateResource {
  type: string;
  name: string;
  instances?: Array<{
    attributes?: Record<string, unknown>;
  }>;
}

interface TerraformStateJson {
  resources?: TerraformStateResource[];
}

export function validateCloudRunStateProtection(stateJson: unknown): void {
  if (!stateJson || typeof stateJson !== "object") {
    throw new Error("Invalid state JSON");
  }

  const state = stateJson as TerraformStateJson;
  const resources = state.resources ?? [];

  const checked = new Set<string>();

  for (const res of resources) {
    if (res.type === "google_cloud_run_v2_service") {
      const name = res.name;
      const instance = res.instances?.[0];
      const attrs = instance?.attributes ?? {};
      const deletionProtection = attrs.deletion_protection;

      if (deletionProtection !== false) {
        throw new Error(
          `Cloud Run deletion protection validation failed: service '${name}' has deletion_protection=${String(
            deletionProtection
          )}, expected false.`
        );
      }
      checked.add(name);
    }
  }

  if (!checked.has("hub") || !checked.has("web")) {
    throw new Error(
      `Cloud Run deletion protection validation failed: expected state to contain both 'hub' and 'web' services, found [${Array.from(
        checked
      ).join(", ")}]`
    );
  }
}

export function validateEmptyTerraformState(stateJson: unknown): void {
  if (!stateJson || typeof stateJson !== "object") {
    throw new Error("Invalid state JSON");
  }

  const state = stateJson as TerraformStateJson;
  const resources = state.resources ?? [];
  const managedResources = resources.filter(
    (r) => r.type !== "terraform_data" && (r.instances?.length ?? 0) > 0
  );

  if (managedResources.length > 0) {
    const addresses = managedResources.map((r) => `${r.type}.${r.name}`).join(", ");
    throw new Error(
      `Terraform state is not empty after destroy! Remaining managed resources: ${addresses}`
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

export function validateSubstrateParameters(params: {
  vpcConnector: string;
  artifactRepo: string;
  cloudBuildBucket: string;
  stateBucket: string;
}): void {
  if (params.vpcConnector !== EXPECTED_SUBSTRATE_RESOURCES.vpcConnector) {
    throw new Error(
      `VPC connector mismatch: expected '${EXPECTED_SUBSTRATE_RESOURCES.vpcConnector}', got '${params.vpcConnector}'`
    );
  }
  if (params.artifactRepo !== EXPECTED_SUBSTRATE_RESOURCES.artifactRepo) {
    throw new Error(
      `Artifact repo mismatch: expected '${EXPECTED_SUBSTRATE_RESOURCES.artifactRepo}', got '${params.artifactRepo}'`
    );
  }
  if (params.cloudBuildBucket !== EXPECTED_SUBSTRATE_RESOURCES.cloudBuildBucket) {
    throw new Error(
      `CloudBuild bucket mismatch: expected '${EXPECTED_SUBSTRATE_RESOURCES.cloudBuildBucket}', got '${params.cloudBuildBucket}'`
    );
  }
  if (params.stateBucket !== EXPECTED_SUBSTRATE_RESOURCES.stateBucket) {
    throw new Error(
      `State bucket mismatch: expected '${EXPECTED_SUBSTRATE_RESOURCES.stateBucket}', got '${params.stateBucket}'`
    );
  }
}
