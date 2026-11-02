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
    noOpOrRead: number;
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

export function validateProjectDeleterPermission(hasPermission: boolean): void {
  if (!hasPermission) {
    throw new Error(
      "Project deletion permission guard failed: caller identity lacks 'resourcemanager.projects.delete' on project 'ompctl'. Project shutdown cannot succeed. Grant 'roles/resourcemanager.projectDeleter' before proceeding."
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
  let noOpCount = 0;
  const affected: string[] = [];

  const allowedServices: Record<string, true> = {
    "google_cloud_run_v2_service.hub": true,
    "google_cloud_run_v2_service.web": true,
  };

  const preparedServices: Record<string, true> = {};

  for (const rc of changes) {
    const actions = rc.change.actions;
    const isNoOp =
      actions.length === 1 && (actions[0] === "no-op" || actions[0] === "read");

    if (actions.includes("create")) createCount++;
    if (actions.includes("delete")) deleteCount++;

    if (isNoOp) {
      noOpCount++;
      // If service is already prepared (deletion_protection is already false), record it as prepared
      if (allowedServices[rc.address]) {
        const before = (rc.change.before ?? {}) as Record<string, unknown>;
        if (before.deletion_protection === false) {
          preparedServices[rc.address] = true;
        }
      }
      continue;
    }

    if (actions.includes("update")) updateCount++;
    affected.push(rc.address);

    if (!allowedServices[rc.address]) {
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

    const before = (rc.change.before ?? {}) as Record<string, unknown>;
    const after = (rc.change.after ?? {}) as Record<string, unknown>;

    if (after.deletion_protection !== false) {
      throw new Error(
        `Prepare plan drift: resource '${rc.address}' after.deletion_protection must be false, got ${String(
          after.deletion_protection
        )}`
      );
    }

    // Comprehensive field comparison: only deletion_protection is allowed to change.
    // Every other property in before and after must remain identical.
    const allKeys = Array.from(
      new Set([...Object.keys(before), ...Object.keys(after)])
    );

    for (const key of allKeys) {
      if (key === "deletion_protection") {
        continue;
      }
      assertPropertyUnchanged(rc.address, key, before[key], after[key]);
    }

    preparedServices[rc.address] = true;
  }

  if (createCount > 0 || deleteCount > 0) {
    throw new Error(
      `Prepare plan rejected: creates (${createCount}) or deletes (${deleteCount}) detected. Preparation must strictly be 0 creates, 0 deletes.`
    );
  }

  for (const requiredService of Object.keys(allowedServices)) {
    if (!preparedServices[requiredService]) {
      throw new Error(
        `Prepare plan missing expected update for '${requiredService}'. Both services must have deletion_protection flipped to false.`
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
      noOpOrRead: noOpCount,
    },
  };
}

function assertPropertyUnchanged(
  address: string,
  field: string,
  beforeVal: unknown,
  afterVal: unknown
): void {
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

  const allowedAddresses: Record<string, true> = Object.fromEntries(
    manifest.terraformAddresses.map((a) => [a, true])
  );
  const baselineAddresses: Record<string, true> = Object.fromEntries(
    BASELINE_TERRAFORM_ADDRESSES.map((a) => [a, true])
  );

  let deleteCount = 0;
  let createCount = 0;
  let updateCount = 0;
  let noOpCount = 0;
  const affected: string[] = [];

  for (const rc of changes) {
    const actions = rc.change.actions;
    const isNoOp =
      actions.length === 1 && (actions[0] === "no-op" || actions[0] === "read");
    if (isNoOp) {
      noOpCount++;
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

    if (!allowedAddresses[rc.address]) {
      throw new Error(
        `Destroy plan rejected: resource '${rc.address}' is not present in the approved manifest deletion set.`
      );
    }

    if (!baselineAddresses[rc.address]) {
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
      noOpOrRead: noOpCount,
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
      )}). Destroying the Cloud DNS zone or deleting the project while parent delegation is active creates a dangling nameserver hijacking vulnerability. Switch nameservers at Squarespace to dormant/default DNS before running destroy, or pass skip_nameserver_check=true with verified justification.`
    );
  }
}

export interface ExtractedResource {
  address: string;
  type: string;
  name: string;
  mode: string;
  attributes: Record<string, unknown>;
}

/**
 * Robustly extract state resources from both 'terraform show -json' representation
 * (where resources live under values.root_module.resources[].values) and legacy
 * raw state files (resources[].instances[].attributes).
 */
export function extractStateResources(stateJson: unknown): ExtractedResource[] {
  if (!stateJson || typeof stateJson !== "object") {
    return [];
  }

  const result: ExtractedResource[] = [];
  const root = stateJson as Record<string, unknown>;

  // Format A: terraform show -json format (values.root_module)
  if (root.values && typeof root.values === "object") {
    const valuesObj = root.values as Record<string, unknown>;
    const collectModule = (mod: Record<string, unknown>) => {
      const resources = mod.resources;
      if (Array.isArray(resources)) {
        for (const res of resources) {
          if (res && typeof res === "object") {
            const r = res as Record<string, unknown>;
            result.push({
              address: typeof r.address === "string" ? r.address : `${String(r.type)}.${String(r.name)}`,
              type: typeof r.type === "string" ? r.type : "",
              name: typeof r.name === "string" ? r.name : "",
              mode: typeof r.mode === "string" ? r.mode : "managed",
              attributes: (r.values ?? {}) as Record<string, unknown>,
            });
          }
        }
      }
      const childModules = mod.child_modules;
      if (Array.isArray(childModules)) {
        for (const child of childModules) {
          if (child && typeof child === "object") {
            collectModule(child as Record<string, unknown>);
          }
        }
      }
    };

    if (valuesObj.root_module && typeof valuesObj.root_module === "object") {
      collectModule(valuesObj.root_module as Record<string, unknown>);
    }
    return result;
  }

  // Format B: raw state format (resources[].instances[].attributes)
  if (Array.isArray(root.resources)) {
    for (const res of root.resources) {
      if (res && typeof res === "object") {
        const r = res as Record<string, unknown>;
        const typeStr = typeof r.type === "string" ? r.type : "";
        const nameStr = typeof r.name === "string" ? r.name : "";
        const modeStr = typeof r.mode === "string" ? r.mode : "managed";
        const instances = r.instances;
        if (Array.isArray(instances) && instances.length > 0) {
          for (const inst of instances) {
            if (inst && typeof inst === "object") {
              const instObj = inst as Record<string, unknown>;
              result.push({
                address: `${typeStr}.${nameStr}`,
                type: typeStr,
                name: nameStr,
                mode: modeStr,
                attributes: (instObj.attributes ?? {}) as Record<string, unknown>,
              });
            }
          }
        }
      }
    }
  }

  return result;
}

export function validateCloudRunStateProtection(stateJson: unknown): void {
  const resources = extractStateResources(stateJson);
  const checked: Record<string, true> = {};

  for (const res of resources) {
    if (res.type === "google_cloud_run_v2_service") {
      const name = res.name;
      const deletionProtection = res.attributes.deletion_protection;

      if (deletionProtection !== false) {
        throw new Error(
          `Cloud Run deletion protection validation failed: service '${name}' has deletion_protection=${String(
            deletionProtection
          )}, expected false.`
        );
      }
      checked[name] = true;
    }
  }

  if (!checked.hub || !checked.web) {
    throw new Error(
      `Cloud Run deletion protection validation failed: expected state to contain both 'hub' and 'web' services, found [${Object.keys(
        checked
      ).join(", ")}]`
    );
  }
}

export function validateEmptyTerraformState(stateJson: unknown): void {
  const resources = extractStateResources(stateJson);
  const managed = resources.filter(
    (r) => r.mode === "managed" && r.type !== "terraform_data"
  );

  if (managed.length > 0) {
    const addresses = managed.map((r) => r.address).join(", ");
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
