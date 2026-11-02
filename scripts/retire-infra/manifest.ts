import {
  BASELINE_TERRAFORM_ADDRESSES,
  CONFIRMED_CLOUD_RUN_MAPPINGS,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  EXPECTED_REGION,
  EXPECTED_STATE_BUCKET,
  EXPECTED_STATE_PREFIX,
  EXPECTED_SUBSTRATE_RESOURCES,
  EXPLICIT_SURVIVORS,
  type SanitizedManifest,
} from "./types.ts";

export function computeManifestChecksum(
  manifest: Omit<SanitizedManifest, "checksum">
): string {
  const canonical = JSON.stringify(manifest, Object.keys(manifest).sort());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonical);
  return hasher.digest("hex");
}

export function createSanitizedManifest(params: {
  sourceSha: string;
  stateLineage?: string;
  stateSerial?: number;
  workspace?: string;
  discoveredDomainMappings?: string[];
  terraformAddresses?: string[];
}): SanitizedManifest {
  const base: Omit<SanitizedManifest, "checksum"> = {
    manifestVersion: "1.0.0",
    sourceSha: params.sourceSha,
    createdAt: new Date().toISOString(),
    targetProject: {
      projectId: EXPECTED_PROJECT_ID,
      projectNumber: EXPECTED_PROJECT_NUMBER,
      region: EXPECTED_REGION,
    },
    stateMetadata: {
      bucket: EXPECTED_STATE_BUCKET,
      prefix: EXPECTED_STATE_PREFIX,
      workspace: params.workspace ?? "default",
      lineage: params.stateLineage,
      serial: params.stateSerial,
    },
    terraformAddresses: (
      params.terraformAddresses ?? [...BASELINE_TERRAFORM_ADDRESSES]
    ).slice().sort(),
    outOfStateDomainMappings: (
      params.discoveredDomainMappings ?? [...CONFIRMED_CLOUD_RUN_MAPPINGS]
    ).slice().sort(),
    substrateResources: { ...EXPECTED_SUBSTRATE_RESOURCES },
    retainedAssets: [...EXPLICIT_SURVIVORS],
  };

  const checksum = computeManifestChecksum(base);
  return {
    ...base,
    checksum,
  };
}

export function verifyManifest(manifest: unknown): SanitizedManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid manifest: must be an object");
  }

  const m = manifest as Record<string, unknown>;
  if (m.manifestVersion !== "1.0.0") {
    throw new Error(`Unsupported manifest version: ${String(m.manifestVersion)}`);
  }

  if (!("targetProject" in m) || typeof m.targetProject !== "object" || !m.targetProject) {
    throw new Error("Manifest missing targetProject definition");
  }
  const targetProject = m.targetProject as Record<string, unknown>;
  if (targetProject.projectId !== EXPECTED_PROJECT_ID) {
    throw new Error(
      `Project ID mismatch in manifest: expected ${EXPECTED_PROJECT_ID}, got ${String(
        targetProject.projectId
      )}`
    );
  }
  if (targetProject.projectNumber !== EXPECTED_PROJECT_NUMBER) {
    throw new Error(
      `Project number mismatch in manifest: expected ${EXPECTED_PROJECT_NUMBER}, got ${String(
        targetProject.projectNumber
      )}`
    );
  }

  if (!("stateMetadata" in m) || typeof m.stateMetadata !== "object" || !m.stateMetadata) {
    throw new Error("Manifest missing stateMetadata definition");
  }
  const stateMetadata = m.stateMetadata as Record<string, unknown>;
  if (stateMetadata.bucket !== EXPECTED_STATE_BUCKET) {
    throw new Error(
      `State bucket mismatch in manifest: expected ${EXPECTED_STATE_BUCKET}, got ${String(
        stateMetadata.bucket
      )}`
    );
  }

  const addresses = m.terraformAddresses;
  if (!Array.isArray(addresses)) {
    throw new Error("Manifest terraformAddresses must be an array");
  }
  const allowedAddresses = new Set<string>(BASELINE_TERRAFORM_ADDRESSES);
  for (const addr of addresses) {
    if (typeof addr !== "string") {
      throw new Error(`Invalid terraform address in manifest: ${String(addr)}`);
    }
    if (!allowedAddresses.has(addr)) {
      throw new Error(`Unpermitted address in manifest: ${addr}`);
    }
  }

  const mappings = m.outOfStateDomainMappings;
  if (!Array.isArray(mappings)) {
    throw new Error("Manifest outOfStateDomainMappings must be an array");
  }
  const allowedMappings = new Set<string>(CONFIRMED_CLOUD_RUN_MAPPINGS);
  for (const mapping of mappings) {
    if (typeof mapping !== "string" || !allowedMappings.has(mapping)) {
      throw new Error(`Unpermitted domain mapping in manifest: ${String(mapping)}`);
    }
  }

  const claimedChecksum = m.checksum;
  if (typeof claimedChecksum !== "string" || claimedChecksum.length !== 64) {
    throw new Error("Manifest checksum missing or invalid format");
  }

  const { checksum: _discard, ...rest } = m;
  const recomputed = computeManifestChecksum(
    rest as unknown as Omit<SanitizedManifest, "checksum">
  );
  if (recomputed !== claimedChecksum) {
    throw new Error(
      `Manifest checksum verification failed: expected ${recomputed}, got ${claimedChecksum}`
    );
  }

  return manifest as SanitizedManifest;
}
