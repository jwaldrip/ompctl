import { describe, expect, test } from "bun:test";
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
  EXPECTED_STATE_BUCKET,
  EXPECTED_SUBSTRATE_RESOURCES,
} from "./types.ts";

describe("Retirement Guards: Project Identity", () => {
  test("accepts exact project ID and number", () => {
    expect(() =>
      validateProjectIdentity(EXPECTED_PROJECT_ID, EXPECTED_PROJECT_NUMBER)
    ).not.toThrow();
  });

  test("rejects mismatched project ID", () => {
    expect(() =>
      validateProjectIdentity("wrong-project", EXPECTED_PROJECT_NUMBER)
    ).toThrow(/Project ID guard failed/);
  });

  test("rejects mismatched project number", () => {
    expect(() =>
      validateProjectIdentity(EXPECTED_PROJECT_ID, "999999999999")
    ).toThrow(/Project number guard failed/);
  });

  test("rejects empty project parameters", () => {
    expect(() => validateProjectIdentity("", EXPECTED_PROJECT_NUMBER)).toThrow();
    expect(() => validateProjectIdentity(EXPECTED_PROJECT_ID, "")).toThrow();
  });
});

describe("Retirement Guards: Manifest Integrity and Schema", () => {
  test("generates and verifies a valid sanitized manifest", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
      stateLineage: "mock-lineage-123",
      stateSerial: 42,
    });

    const verified = verifyManifest(manifest);
    expect(verified.targetProject.projectId).toBe(EXPECTED_PROJECT_ID);
    expect(verified.targetProject.projectNumber).toBe(EXPECTED_PROJECT_NUMBER);
    expect(verified.terraformAddresses.length).toBe(BASELINE_TERRAFORM_ADDRESSES.length);
    expect(verified.outOfStateDomainMappings.length).toBe(CONFIRMED_CLOUD_RUN_MAPPINGS.length);
  });

  test("rejects manifest with tampered checksum", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
    });

    const tampered = { ...manifest, checksum: "a".repeat(64) };
    expect(() => verifyManifest(tampered)).toThrow(/Manifest checksum verification failed/);
  });

  test("rejects manifest with unpermitted terraform address", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
      terraformAddresses: [
        ...BASELINE_TERRAFORM_ADDRESSES,
        "google_compute_instance.malicious",
      ],
    });

    expect(() => verifyManifest(manifest)).toThrow(/Unpermitted address in manifest/);
  });

  test("rejects manifest with unpermitted domain mapping", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
      discoveredDomainMappings: ["attacker.com"],
    });

    expect(() => verifyManifest(manifest)).toThrow(/Unpermitted domain mapping in manifest/);
  });
});

describe("Retirement Guards: Prepare Plan Validation", () => {
  const baseServiceBefore = {
    template: {
      containers: [{ image: "us-central1-docker.pkg.dev/ompctl/ompd/hub:sha123" }],
      scaling: { min_instance_count: 1, max_instance_count: 1 },
    },
    ingress: "INGRESS_TRAFFIC_ALL",
    deletion_protection: true,
  };

  const baseServiceAfter = {
    template: {
      containers: [{ image: "us-central1-docker.pkg.dev/ompctl/ompd/hub:sha123" }],
      scaling: { min_instance_count: 1, max_instance_count: 1 },
    },
    ingress: "INGRESS_TRAFFIC_ALL",
    deletion_protection: false,
  };

  test("approves plan where only deletion_protection is flipped to false", () => {
    const validPlan = {
      resource_changes: [
        {
          address: "google_cloud_run_v2_service.hub",
          type: "google_cloud_run_v2_service",
          name: "hub",
          change: {
            actions: ["update"],
            before: baseServiceBefore,
            after: baseServiceAfter,
          },
        },
        {
          address: "google_cloud_run_v2_service.web",
          type: "google_cloud_run_v2_service",
          name: "web",
          change: {
            actions: ["update"],
            before: baseServiceBefore,
            after: baseServiceAfter,
          },
        },
      ],
    };

    const res = validateTerraformPlanForPrepare(validPlan);
    expect(res.valid).toBe(true);
    expect(res.actionCounts.update).toBe(2);
    expect(res.actionCounts.create).toBe(0);
    expect(res.actionCounts.delete).toBe(0);
  });

  test("rejects plan if container image drifts during prepare", () => {
    const driftedPlan = {
      resource_changes: [
        {
          address: "google_cloud_run_v2_service.hub",
          type: "google_cloud_run_v2_service",
          name: "hub",
          change: {
            actions: ["update"],
            before: baseServiceBefore,
            after: {
              ...baseServiceAfter,
              template: {
                containers: [{ image: "us-central1-docker.pkg.dev/ompctl/ompd/hub:new-image" }],
              },
            },
          },
        },
        {
          address: "google_cloud_run_v2_service.web",
          type: "google_cloud_run_v2_service",
          name: "web",
          change: {
            actions: ["update"],
            before: baseServiceBefore,
            after: baseServiceAfter,
          },
        },
      ],
    };

    expect(() => validateTerraformPlanForPrepare(driftedPlan)).toThrow(
      /field 'template' changed between before and after/
    );
  });

  test("rejects plan with unexpected resource changes", () => {
    const planWithExtra = {
      resource_changes: [
        {
          address: "google_cloud_run_v2_service.hub",
          change: { actions: ["update"], before: baseServiceBefore, after: baseServiceAfter },
        },
        {
          address: "google_cloud_run_v2_service.web",
          change: { actions: ["update"], before: baseServiceBefore, after: baseServiceAfter },
        },
        {
          address: "google_dns_managed_zone.ompctl",
          change: { actions: ["update"], before: {}, after: {} },
        },
      ],
    };

    expect(() => validateTerraformPlanForPrepare(planWithExtra)).toThrow(
      /unexpected resource change for 'google_dns_managed_zone.ompctl'/
    );
  });

  test("rejects plan with resource create or delete", () => {
    const planWithDelete = {
      resource_changes: [
        {
          address: "google_cloud_run_v2_service.hub",
          change: { actions: ["delete"], before: baseServiceBefore, after: null },
        },
      ],
    };

    expect(() => validateTerraformPlanForPrepare(planWithDelete)).toThrow(
      /Prepare plan drift/
    );
  });
});

describe("Retirement Guards: Destroy Plan Validation", () => {
  const manifest = createSanitizedManifest({
    sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
  });

  test("approves valid destroy plan containing baseline addresses", () => {
    const plan = {
      resource_changes: BASELINE_TERRAFORM_ADDRESSES.map((address) => ({
        address,
        change: { actions: ["delete"] },
      })),
    };

    const res = validateTerraformPlanForDestroy(plan, manifest);
    expect(res.valid).toBe(true);
    expect(res.actionCounts.delete).toBe(19);
    expect(res.actionCounts.create).toBe(0);
    expect(res.actionCounts.update).toBe(0);
  });

  test("rejects destroy plan if create action appears", () => {
    const planWithCreate = {
      resource_changes: [
        {
          address: "google_cloud_run_v2_service.hub",
          change: { actions: ["create"] },
        },
      ],
    };

    expect(() => validateTerraformPlanForDestroy(planWithCreate, manifest)).toThrow(
      /has non-delete actions/
    );
  });

  test("rejects destroy plan if unpermitted resource appears", () => {
    const planWithForeign = {
      resource_changes: [
        {
          address: "google_compute_instance.foreign",
          change: { actions: ["delete"] },
        },
      ],
    };

    expect(() => validateTerraformPlanForDestroy(planWithForeign, manifest)).toThrow(
      /not present in the approved manifest deletion set/
    );
  });
});

describe("Retirement Guards: Nameserver Delegation", () => {
  test("fails closed when nameservers still point to Cloud DNS", () => {
    const cloudDnsNs = [
      "ns-cloud-a1.googledomains.com",
      "ns-cloud-a2.googledomains.com",
      "ns-cloud-a3.googledomains.com",
      "ns-cloud-a4.googledomains.com",
    ];

    expect(() => validateNameserverDelegation(cloudDnsNs, false)).toThrow(
      /Nameserver guard failed: registrar nameservers for ompctl.ai still delegate to Cloud DNS/
    );
  });

  test("passes when nameservers point to external registrar / dormant DNS", () => {
    const dormantNs = ["dns1.registrar-servers.com", "dns2.registrar-servers.com"];
    expect(() => validateNameserverDelegation(dormantNs, false)).not.toThrow();
  });

  test("allows override when skipCheck is explicitly true", () => {
    const cloudDnsNs = ["ns-cloud-a1.googledomains.com"];
    expect(() => validateNameserverDelegation(cloudDnsNs, true)).not.toThrow();
  });
});

describe("Retirement Guards: State Protection & Post-Destroy Empty State", () => {
  test("verifies Cloud Run services have deletion_protection = false in state", () => {
    const validState = {
      resources: [
        {
          type: "google_cloud_run_v2_service",
          name: "hub",
          instances: [{ attributes: { deletion_protection: false } }],
        },
        {
          type: "google_cloud_run_v2_service",
          name: "web",
          instances: [{ attributes: { deletion_protection: false } }],
        },
      ],
    };

    expect(() => validateCloudRunStateProtection(validState)).not.toThrow();
  });

  test("fails if service still has deletion_protection = true in state", () => {
    const protectedState = {
      resources: [
        {
          type: "google_cloud_run_v2_service",
          name: "hub",
          instances: [{ attributes: { deletion_protection: true } }],
        },
        {
          type: "google_cloud_run_v2_service",
          name: "web",
          instances: [{ attributes: { deletion_protection: false } }],
        },
      ],
    };

    expect(() => validateCloudRunStateProtection(protectedState)).toThrow(
      /deletion_protection=true, expected false/
    );
  });

  test("verifies empty state after destroy", () => {
    const emptyState = { resources: [] };
    expect(() => validateEmptyTerraformState(emptyState)).not.toThrow();
  });

  test("fails if managed resources remain in state after destroy", () => {
    const dirtyState = {
      resources: [
        {
          type: "google_redis_instance",
          name: "cache",
          instances: [{ attributes: { id: "projects/ompctl/locations/us-central1/instances/ompd-cache" } }],
        },
      ],
    };

    expect(() => validateEmptyTerraformState(dirtyState)).toThrow(
      /Terraform state is not empty after destroy/
    );
  });
});

describe("Retirement Guards: Liens and Substrate Boundaries", () => {
  test("passes when no liens exist", () => {
    expect(() => validateNoLiens([])).not.toThrow();
  });

  test("fails closed if liens exist", () => {
    expect(() => validateNoLiens([{ name: "liens/123" }])).toThrow(
      /active deletion liens/
    );
  });

  test("validates substrate parameters match expected", () => {
    expect(() =>
      validateSubstrateParameters({
        vpcConnector: EXPECTED_SUBSTRATE_RESOURCES.vpcConnector,
        artifactRepo: EXPECTED_SUBSTRATE_RESOURCES.artifactRepo,
        cloudBuildBucket: EXPECTED_SUBSTRATE_RESOURCES.cloudBuildBucket,
        stateBucket: EXPECTED_STATE_BUCKET,
      })
    ).not.toThrow();
  });

  test("rejects mismatched substrate bucket", () => {
    expect(() =>
      validateSubstrateParameters({
        vpcConnector: EXPECTED_SUBSTRATE_RESOURCES.vpcConnector,
        artifactRepo: EXPECTED_SUBSTRATE_RESOURCES.artifactRepo,
        cloudBuildBucket: EXPECTED_SUBSTRATE_RESOURCES.cloudBuildBucket,
        stateBucket: "foreign-bucket",
      })
    ).toThrow(/State bucket mismatch/);
  });
});
