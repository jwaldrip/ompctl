# Operator Runbook: ompctl Direct Project Retirement

This runbook documents the guarded procedure for direct shutdown of Google Cloud project \`ompctl\` (\`782181616134\`) and removal of the GitHub Pages marketing site.

All operational mutations run through GitHub Actions CI on the default branch (\`main\`). Creation routes and automated deployment push triggers are permanently disabled.

---

## 1. Identity and Scope Boundaries

The teardown applies exclusively to the following fixed project pair:

| Boundary | Value |
|---|---|
| Target GCP Project ID | \`ompctl\` |
| Target GCP Project Number | \`782181616134\` |
| Primary Region | \`us-central1\` |
| CI Service Account | \`ompctl-deployer@ompctl.iam.gserviceaccount.com\` |
| WIF Provider | \`projects/782181616134/locations/global/workloadIdentityPools/ompctl-github/providers/github\` |
| Decommissioning Mechanism | Resource Manager v1 direct project shutdown (\`DELETE /v1/projects/ompctl\`) |

### Contained Assets (Retired with Project)
- Cloud Run services (\`ompd-hub\`, \`ompctl-web\`) and public invoker bindings.
- Unmanaged Cloud Run domain mappings (\`app.ompctl.ai\`, \`hub.ompctl.ai\`, \`ompctl.ai\`, \`www.ompctl.ai\`).
- Google Cloud DNS zone (\`ompctl-ai\`) and all hosted record sets.
- Memorystore Redis instance (\`ompd-hub\`).
- Secret Manager secret (\`ompd-hub-operator-token\`).
- Serverless VPC Access connector (\`ompctl-connector\`).
- Artifact Registry Docker repository (\`ompd\`).
- Cloud Storage buckets (\`gs://ompctl_cloudbuild\`, \`gs://ompctl-terraform-state\`).
- Project-contained service accounts and Workload Identity Pool.

### Explicit Survivors (Must NOT be destroyed)
- **Domain registration:** \`ompctl.ai\` remains registered at Squarespace (active through 2028-08-14).
- **Source repository:** \`github.com/jwaldrip/ompctl\`, all branches, commits, worktrees, and release tags.
- **Developer accounts:** Google account \`jason@waldrip.net\` and unrelated Google Cloud projects.
- **Local tooling:** Developer workstations, local transcripts, and recovery archives.

---

## 2. Active Blocker: Authoritative DNS Cutover & TTL Preservation

All six authoritative \`.ai\` parent nameservers (\`a.nic.ai\` through \`f.nic.ai\`) currently delegate \`ompctl.ai\` to Google Cloud DNS (\`googledomains.com\`) with delegation TTL 3600 seconds, and child Cloud DNS NS records have TTL 21600 seconds.

**CRITICAL SAFEGUARD:**
If the project and its Cloud DNS zone are shut down while parent delegation points to Google nameservers, the domain becomes vulnerable to zone and subdomain hijacking.

Before initiating project shutdown:
1. Log in to the Squarespace Domain Management console for \`ompctl.ai\`.
2. Move nameservers to registrar-managed default/dormant DNS (no mail, no active routing).
3. Confirm that all six parent servers delegate away from Google Cloud DNS.
4. Capture a cutover observation via CI.
5. The pipeline enforces that elapsed time since cutover must exceed the maximum old TTL (21600 seconds) before project shutdown can be authorized.

---

## 3. Operations Sequence

All operations execute via \`.github/workflows/retire-infra.yml\` using \`workflow_dispatch\`.

### Step 1: Capture Baseline DNS Observation (Read-Only)

Run the observation operation to record current authority, parent delegation, and record TTLs:

```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=observe
```

**Actions:**
1. Wait for workflow completion.
2. Note the Run ID (e.g. \`101010101\`).
3. Download the \`ompctl-dns-observation-101010101\` artifact to inspect captured parent queries.

---

### Step 2: Execute Registrar Cutover at Squarespace

1. Switch nameservers in the Squarespace admin console to registrar default/dormant DNS.
2. Verify via \`dig @a.nic.ai NS ompctl.ai +norecurse\` that parent servers report the new nameservers.

---

### Step 3: Capture Cutover DNS Observation (Read-Only)

Once all six parent servers reflect the updated delegation, record the cutover observation:

```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=observe
```

**Actions:**
1. Wait for workflow completion.
2. Note the Cutover Run ID (e.g. \`202020202\`).
3. Verify that \`delegatesToCloudDns: false\` and \`allParentsAgree: true\` in the artifact.

---

### Step 4: Execute Guarded Project Retirement

After the 21600-second old TTL window has elapsed from the cutover run:

```bash
gh workflow run retire-infra.yml \
  --ref main \
  -f operation=retire \
  -f confirmation=CONFIRM-RETIRE-OMPCTL \
  -f baseline_run_id=101010101 \
  -f cutover_run_id=202020202
```

**Automated Guard Validations in this step:**
1. Asserts execution ref is \`refs/heads/main\`.
2. Asserts confirmation token is \`CONFIRM-RETIRE-OMPCTL\`.
3. Validates baseline and cutover artifacts, confirming SHA match, Cloud DNS delegation in baseline, non-Cloud-DNS delegation in cutover, and elapsed time > 21600 seconds.
4. Performs real-time check of parent nameservers and retired hostname targets.
5. Verifies no active deployment workflow runs exist.
6. Tests \`resourcemanager.projects.delete\` permission via Resource Manager v1 REST API. If missing, automatically binds \`roles/resourcemanager.projectDeleter\` to the CI service account and re-verifies.
7. Queries deletion liens (following pagination) and verifies zero liens.
8. Unpublishes GitHub Pages (\`DELETE /repos/jwaldrip/ompctl/pages\`) and reads back absence (HTTP 404).
9. Executes \`DELETE https://cloudresourcemanager.googleapis.com/v1/projects/ompctl\`.
10. Validates HTTP 200 \`{}\` response indicating shutdown request accepted.

---

## 4. Post-Retirement Verification by Owner

After workflow completion, the owner (\`jason@waldrip.net\`) reads live status directly:

```bash
gcloud projects describe ompctl \
  --account=jason@waldrip.net \
  --format='json(projectId,projectNumber,lifecycleState)'
```

**Required Evidence:**
\`\`\`json
{
  "lifecycleState": "DELETE_REQUESTED",
  "projectId": "ompctl",
  "projectNumber": "782181616134"
}
\`\`\`

**Lifecycle Semantics:**
- Google Cloud projects enter the \`DELETE_REQUESTED\` state immediately upon deletion request.
- Resources within the project immediately cease billing and become inaccessible.
- Google retains project data for a 30-day recovery window.
- After 30 days, the project and its contents are permanently deleted.
- Per Google Cloud Resource Manager policy, project IDs cannot be reused after deletion.

**Pages Absence Readback:**
\`\`\`bash
gh api /repos/jwaldrip/ompctl/pages
\`\`\`
Expected response: HTTP 404 Not Found.
