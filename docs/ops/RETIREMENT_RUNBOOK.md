# Operator Runbook: ompctl Infrastructure Retirement

This runbook documents the step-by-step procedure for safely decommissioning ompctl hosted infrastructure, networking, storage, DNS hosting, and the GitHub Pages marketing site.

All mutations occur through GitHub Actions CI or authenticated administrative commands. Creation routes and automatic deployment push triggers have been permanently disabled.

---

## 1. Identity and Scope Boundaries

The teardown applies exclusively to the following project and resources:

| Boundary | Value |
|---|---|
| Target GCP Project ID | `ompctl` |
| Target GCP Project Number | `782181616134` |
| Primary Region | `us-central1` |
| Pinned Google Provider | `hashicorp/google 6.50.0` |
| Terraform State Location | `gs://ompctl-terraform-state/hub/default.tfstate` |
| Managed Terraform Addresses | 19 baseline resources confirmed from CI deployment run 38706883329 (see list below) |
| Confirmed Out-of-State Mappings | `app.ompctl.ai`, `hub.ompctl.ai`, `ompctl.ai`, `www.ompctl.ai` (all us-central1) |
| Substrate Resources | VPC connector `ompctl-connector`, Artifact Registry `ompd`, Cloud Build bucket `ompctl_cloudbuild`, State bucket `ompctl-terraform-state` |

### Explicit Survivors (Must NOT be destroyed)

- **Domain registration:** `ompctl.ai` remains registered at Squarespace (active through 2028-08-14).
- **Source repository:** `github.com/jwaldrip/ompctl`, all branches, commits, worktrees, and release tags.
- **Developer accounts:** Google account `jason@waldrip.net` and unrelated Google Cloud projects.
- **Local tooling:** Developer workstations, local transcripts, and recovery archives.

---

## 2. Baseline Managed Terraform Addresses (19 Verified Resources)

The destroy stage strictly permits deletion of only these 19 baseline addresses:

1. `google_cloud_run_v2_service.hub`
2. `google_cloud_run_v2_service.web`
3. `google_cloud_run_v2_service_iam_member.hub_public`
4. `google_cloud_run_v2_service_iam_member.web_public`
5. `google_dns_managed_zone.ompctl`
6. `google_dns_record_set.apex_txt`
7. `google_dns_record_set.app`
8. `google_dns_record_set.dmarc`
9. `google_dns_record_set.domainkey`
10. `google_dns_record_set.hub`
11. `google_dns_record_set.root_a`
12. `google_dns_record_set.root_aaaa`
13. `google_dns_record_set.www`
14. `google_project_iam_member.deployer_dns`
15. `google_redis_instance.hub`
16. `google_secret_manager_secret.operator_token`
17. `google_secret_manager_secret_iam_member.hub_reads_operator_token`
18. `google_service_account.hub`
19. `google_service_account.web`

---

## 3. Prerequisites: Registrar Delegation, TTL, and Project IAM

### A. Registrar Delegation and Dangling DNS Safeguard

The `ompctl.ai` domain registration is managed via Squarespace.
Currently, authoritative nameservers delegate to Google Cloud DNS (`googledomains.com`).

**CRITICAL SAFEGUARD:**
If the Google Cloud DNS zone is destroyed while Squarespace still delegates to Google nameservers, the domain becomes vulnerable to subdomain and zone hijacking.

Before executing Stage 3 (Retire Routing), Stage 4 (Destroy Terraform), or Stage 6 (Delete Project):
1. Log in to the Squarespace Domain Management console for `ompctl.ai`.
2. Re-point nameservers to registrar-managed default DNS, or configure a dormant no-service profile.
3. Allow the previous nameserver TTL (typically 21600 seconds) to expire so recursive resolvers clear old Google Cloud DNS delegations.
4. Verify with `dig +short NS ompctl.ai` that delegation no longer points to Cloud DNS nameservers.
5. The pipeline enforces nameserver validation across Stages 3, 4, and 6, and will fail closed if nameservers still delegate to Cloud DNS, unless overridden with explicit operator justification (`skip_nameserver_check=true`).

### B. Preflight Project Deletion Permissions

Google Cloud Project shutdown requires the `resourcemanager.projects.delete` permission on project `ompctl`.
The deployment service account (`ompctl-deployer@ompctl.iam.gserviceaccount.com`) carries `roles/resourcemanager.projectIamAdmin` but historically lacks `roles/resourcemanager.projectDeleter`.

If Stage 1 (inventory) reports that the CI identity lacks this permission:
1. An authorized owner (`jason@waldrip.net`) must grant the deleter role:
   ```bash
   gcloud projects add-iam-policy-binding ompctl \
     --member="serviceAccount:ompctl-deployer@ompctl.iam.gserviceaccount.com" \
     --role="roles/resourcemanager.projectDeleter"
   ```
2. The pipeline preflights this permission before project deletion and fails closed if it is absent.

---

## 4. Sequential Execution Stages

All retirement operations run via `.github/workflows/retire-infra.yml` using `workflow_dispatch`.
Each destructive stage requires:
- `confirmation: "CONFIRM-RETIRE-OMPCTL"`
- `manifest_sha: "<SHA256 from Stage 1>"`
- `inventory_run_id: "<Run ID of Stage 1>"`

### Stage 1: INVENTORY (Read-only Live Resource Discovery)

This stage performs authenticated reads only. It queries GCP APIs, verifies project identity, checks for liens, reads live Terraform state, preflights project deletion permissions, enumerates Cloud Run domain mappings, and exports a sanitized manifest artifact.

**Operator Command:**
```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=inventory \
  -f target_project_id=ompctl \
  -f target_project_number=782181616134
```

**Actions:**
1. Wait for workflow completion.
2. Note the GitHub Actions Run ID of this run (e.g. `123456789`).
3. Download the `ompctl-sanitized-manifest` artifact.
4. Inspect `sanitized-manifest.json` and copy the `checksum` value (`manifest_sha`).
5. Verify that:
   - `targetProject.projectId` is `ompctl`
   - `targetProject.projectNumber` is `782181616134`
   - `terraformAddresses` contains the 19 verified baseline addresses.
   - `outOfStateDomainMappings` lists the four confirmed mappings (`app.ompctl.ai`, `hub.ompctl.ai`, `ompctl.ai`, `www.ompctl.ai`).

---

### Stage 2: PREPARE (Cloud Run Deletion-Protection Removal)

In Google Cloud provider 6.50.0, Cloud Run services default `deletion_protection = true`.
Terraform will fail deletion if `deletion_protection = false` has not been applied to state.

This stage plans and applies ONLY the removal of `deletion_protection`. The guard verifies:
- Exactly 2 updates: `ompd-hub` and `ompctl-web` (or valid no-op if already false on retry).
- 0 creates, 0 deletes, 0 replacements.
- No changes to container images, environment variables, scaling, ingress, traffic, or VPC connector.
- State readback in `values.root_module.resources` proves `deletion_protection = false` on both services.

**Operator Command:**
```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=prepare \
  -f confirmation=CONFIRM-RETIRE-OMPCTL \
  -f manifest_sha=<MANIFEST_CHECKSUM> \
  -f inventory_run_id=<INVENTORY_RUN_ID> \
  -f target_project_id=ompctl \
  -f target_project_number=782181616134
```

---

### Stage 3: RETIRE-ROUTING (DNS & Routing Teardown)

This stage retires the public routing layers:
1. Verifies registrar nameserver delegation has moved away from Cloud DNS.
2. Unpublishes the GitHub Pages marketing site (`DELETE /repos/jwaldrip/ompctl/pages`).
3. Deletes the four confirmed unmanaged Cloud Run domain mappings via gcloud.

**Operator Command:**
```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=retire-routing \
  -f confirmation=CONFIRM-RETIRE-OMPCTL \
  -f manifest_sha=<MANIFEST_CHECKSUM> \
  -f inventory_run_id=<INVENTORY_RUN_ID> \
  -f target_project_id=ompctl \
  -f target_project_number=782181616134
```

*Note: If Squarespace nameserver delegation is intentionally being switched concurrently and the operator has verified ownership, pass `-f skip_nameserver_check=true`.*

---

### Stage 4: DESTROY-TERRAFORM (Managed Stack Destruction)

This stage generates a Terraform destroy plan and validates it against the approved manifest:
- Verifies nameserver delegation before zone destruction.
- Initializes Terraform backend with provider lock.
- Requires 0 creates and 0 updates.
- Verifies every resource marked for deletion belongs to the 19 verified baseline addresses.
- Applies the destroy plan.
- Verifies that post-apply Terraform state contains 0 managed resources in `values.root_module.resources`.

**Operator Command:**
```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=destroy-terraform \
  -f confirmation=CONFIRM-RETIRE-OMPCTL \
  -f manifest_sha=<MANIFEST_CHECKSUM> \
  -f inventory_run_id=<INVENTORY_RUN_ID> \
  -f target_project_id=ompctl \
  -f target_project_number=782181616134
```

---

### Stage 5: CLEANUP-SUBSTRATE (Substrate and State Cleanup)

After all managed infrastructure is destroyed, this stage deletes the bootstrap substrate:
1. Verifies that the Terraform state backend contains 0 managed resources before any deletion.
2. Serverless VPC Access connector: `ompctl-connector` in `us-central1`.
3. Artifact Registry repository: `ompd` in `us-central1`.
4. Cloud Build staging bucket: `gs://ompctl_cloudbuild`.
5. Terraform state bucket: `gs://ompctl-terraform-state`.

**Operator Command:**
```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=cleanup-substrate \
  -f confirmation=CONFIRM-RETIRE-OMPCTL \
  -f manifest_sha=<MANIFEST_CHECKSUM> \
  -f inventory_run_id=<INVENTORY_RUN_ID> \
  -f target_project_id=ompctl \
  -f target_project_number=782181616134
```

---

### Stage 6: DELETE-PROJECT (Terminal Project Deletion)

This is the final cloud mutation.
1. Verifies nameserver delegation to avoid leaving dangling NS records at Squarespace.
2. Checks for active project deletion liens (fails closed if any exist).
3. Preflights `resourcemanager.projects.delete` permission (fails closed if absent).
4. Requests Google Cloud project deletion: `gcloud projects delete ompctl --quiet`.

**Operator Command:**
```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=delete-project \
  -f confirmation=CONFIRM-RETIRE-OMPCTL \
  -f manifest_sha=<MANIFEST_CHECKSUM> \
  -f inventory_run_id=<INVENTORY_RUN_ID> \
  -f target_project_id=ompctl \
  -f target_project_number=782181616134
```

**Lifecycle Semantics:**
- Google Cloud projects enter the `DELETE_REQUESTED` state.
- Resources within the project immediately cease billing and become inaccessible.
- Google maintains a 30-day recovery window during which project restoration is possible.
- After 30 days, the project and its contents are permanently erased, and the project ID `ompctl` is permanently released.

---

## 5. Post-Retirement Verification

Run these verification checks from an identity external to the `ompctl` project:

1. **Verify Project Status:**
   ```bash
   gcloud projects describe ompctl --format="value(lifecycleState)"
   ```
   *Expected output:* `DELETE_REQUESTED`

2. **Verify Public Endpoints Ceased Serving:**
   ```bash
   curl -I https://app.ompctl.ai
   curl -I https://hub.ompctl.ai
   curl -I https://ompctl.ai
   ```
   *Expected result:* DNS resolution failure or connection refusal.

3. **Verify GitHub Pages Inactive:**
   ```bash
   gh api /repos/jwaldrip/ompctl/pages || echo "Pages disabled"
   ```
   *Expected result:* HTTP 404 Not Found.
