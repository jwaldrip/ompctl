import { describe, expect, test } from "bun:test";
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
import {
  canonicalJson,
  computeManifestChecksum,
  createSanitizedManifest,
  verifyManifest,
} from "./manifest.ts";
import {
  BASELINE_TERRAFORM_ADDRESSES,
  CONFIRMED_CLOUD_RUN_MAPPINGS,
  EXPECTED_PROJECT_ID,
  EXPECTED_PROJECT_NUMBER,
  EXPECTED_STATE_BUCKET,
  EXPECTED_SUBSTRATE_RESOURCES,
} from "./types.ts";

describe("Retirement Guards: Project Identity & Permissions", () => {
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

  test("project deleter permission passes when present", () => {
    expect(() => validateProjectDeleterPermission(true)).not.toThrow();
  });

  test("project deleter permission fails closed when absent", () => {
    expect(() => validateProjectDeleterPermission(false)).toThrow(
      /Project deletion permission guard failed/
    );
  });
});

describe("Retirement Guards: Manifest Integrity, Hashing and Approval", () => {
  test("generates and verifies a valid sanitized manifest with canonical JSON", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
      stateLineage: "mock-lineage-123",
      stateSerial: 42,
    });

    const verified = verifyManifest(manifest, manifest.checksum);
    expect(verified.targetProject.projectId).toBe(EXPECTED_PROJECT_ID);
    expect(verified.targetProject.projectNumber).toBe(EXPECTED_PROJECT_NUMBER);
    expect(verified.terraformAddresses.length).toBe(BASELINE_TERRAFORM_ADDRESSES.length);
    expect(verified.outOfStateDomainMappings.length).toBe(CONFIRMED_CLOUD_RUN_MAPPINGS.length);
  });

  test("nested field tampering alters manifest checksum", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
      stateLineage: "lineage-a",
    });

    const { checksum: _, ...manifestWithoutChecksum } = manifest;
    const baseHash = computeManifestChecksum(manifestWithoutChecksum);

    // Tamper with a deeply nested field in stateMetadata
    const tampered = {
      ...manifestWithoutChecksum,
      stateMetadata: {
        ...manifestWithoutChecksum.stateMetadata,
        workspace: "malicious-workspace",
      },
    };
    const tamperedHash = computeManifestChecksum(tampered);

    expect(tamperedHash).not.toBe(baseHash);
  });

  test("rejects manifest with tampered checksum", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
    });

    const tampered = { ...manifest, checksum: "0".repeat(64) };
    expect(() => verifyManifest(tampered)).toThrow(/Manifest checksum verification failed/);
  });

  test("rejects manifest if operator approval sha does not match", () => {
    const manifest = createSanitizedManifest({
      sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
    });

    expect(() =>
      verifyManifest(manifest, "1".repeat(64))
    ).toThrow(/Manifest approval mismatch/);
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

  test("canonicalJson produces deterministic sorted output at all nesting levels", () => {
    const obj1 = { b: 1, a: { z: 2, y: [ { d: 4, c: 3 } ] } };
    const obj2 = { a: { y: [ { c: 3, d: 4 } ], z: 2 }, b: 1 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });
});

describe("Retirement Guards: Prepare Plan Validation", () => {
  const baseServiceBefore = {
    template: {
      containers: [{ image: "us-central1-docker.pkg.dev/ompctl/ompd/hub:sha123" }],
      scaling: { min_instance_count: 1, max_instance_count: 1 },
    },
    traffic: [{ percent: 100, type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" }],
    ingress: "INGRESS_TRAFFIC_ALL",
    deletion_protection: true,
  };

  const baseServiceAfter = {
    template: {
      containers: [{ image: "us-central1-docker.pkg.dev/ompctl/ompd/hub:sha123" }],
      scaling: { min_instance_count: 1, max_instance_count: 1 },
    },
    traffic: [{ percent: 100, type: "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" }],
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

  test("accepts already-prepared service on retry (resumability)", () => {
    const alreadyPreparedService = {
      ...baseServiceBefore,
      deletion_protection: false,
    };

    const retryPlan = {
      resource_changes: [
        {
          address: "google_cloud_run_v2_service.hub",
          type: "google_cloud_run_v2_service",
          name: "hub",
          change: {
            actions: ["no-op"],
            before: alreadyPreparedService,
            after: alreadyPreparedService,
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

    const res = validateTerraformPlanForPrepare(retryPlan);
    expect(res.valid).toBe(true);
    expect(res.actionCounts.update).toBe(1);
    expect(res.actionCounts.noOpOrRead).toBe(1);
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

  test("rejects plan if traffic routing changes during prepare", () => {
    const trafficDriftPlan = {
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
              traffic: [{ percent: 50, type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION" }],
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

    expect(() => validateTerraformPlanForPrepare(trafficDriftPlan)).toThrow(
      /field 'traffic' changed between before and after/
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
});

describe("Retirement Guards: Destroy Plan Validation", () => {
  const manifest = createSanitizedManifest({
    sourceSha: "3662016072646338c3e1cca236b27c9dc7a4f219",
  });

  test("approves valid destroy plan containing verified baseline 19 addresses", () => {
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

describe("Retirement Guards: State Readback Parsing (terraform show -json schema)", () => {
  test("parses terraform show -json format and validates deletion_protection = false", () => {
    // Realistic terraform show -json format: values.root_module.resources[].values
    const stateJsonShowFormat = {
      format_version: "1.0",
      terraform_version: "1.9.0",
      values: {
        root_module: {
          resources: [
            {
              address: "google_cloud_run_v2_service.hub",
              mode: "managed",
              type: "google_cloud_run_v2_service",
              name: "hub",
              provider_name: "registry.terraform.io/hashicorp/google",
              values: {
                name: "ompd-hub",
                location: "us-central1",
                deletion_protection: false,
              },
            },
            {
              address: "google_cloud_run_v2_service.web",
              mode: "managed",
              type: "google_cloud_run_v2_service",
              name: "web",
              provider_name: "registry.terraform.io/hashicorp/google",
              values: {
                name: "ompctl-web",
                location: "us-central1",
                deletion_protection: false,
              },
            },
          ],
        },
      },
    };

    const extracted = extractStateResources(stateJsonShowFormat);
    expect(extracted.length).toBe(2);
    expect(extracted[0].attributes.deletion_protection).toBe(false);
    expect(extracted[1].attributes.deletion_protection).toBe(false);

    expect(() => validateCloudRunStateProtection(stateJsonShowFormat)).not.toThrow();
  });

  test("fails if service has deletion_protection = true in terraform show -json", () => {
    const stateWithProtection = {
      values: {
        root_module: {
          resources: [
            {
              address: "google_cloud_run_v2_service.hub",
              mode: "managed",
              type: "google_cloud_run_v2_service",
              name: "hub",
              values: {
                deletion_protection: true,
              },
            },
            {
              address: "google_cloud_run_v2_service.web",
              mode: "managed",
              type: "google_cloud_run_v2_service",
              name: "web",
              values: {
                deletion_protection: false,
              },
            },
          ],
        },
      },
    };

    expect(() => validateCloudRunStateProtection(stateWithProtection)).toThrow(
      /deletion_protection=true, expected false/
    );
  });

  test("validates empty state correctly in terraform show -json format", () => {
    const emptyShowState = {
      values: {
        root_module: {
          resources: [],
        },
      },
    };

    expect(() => validateEmptyTerraformState(emptyShowState)).not.toThrow();
  });

  test("fails empty state check if managed resources remain in terraform show -json", () => {
    const populatedShowState = {
      values: {
        root_module: {
          resources: [
            {
              address: "google_redis_instance.hub",
              mode: "managed",
              type: "google_redis_instance",
              name: "hub",
              values: { id: "projects/ompctl/locations/us-central1/instances/ompd-hub" },
            },
          ],
        },
      },
    };

    expect(() => validateEmptyTerraformState(populatedShowState)).toThrow(
      /Terraform state is not empty after destroy! Remaining managed resources: google_redis_instance.hub/
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
