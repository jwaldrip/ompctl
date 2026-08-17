# 0002. Host ompctl in its own GCP project

Date: 2026-08-15
Status: accepted
Amended: 2026-08-16 (state bucket now lives in this project; see Consequences)

## Context

ompctl (the hub relay plus the web console at ompctl.ai) is a distinct product
with its own domain and its own Cloud Run services. The alternative was to
deploy it alongside unrelated stacks in a shared, general-purpose project.

Sharing a project means a compromised deploy identity reaches every stack in
it. It also means quota, IAM, and org policy are entangled across things that
have no reason to affect each other.

## Decision

A dedicated project, `ompctl`, holding only ompctl's infrastructure.

## Consequences

- IAM blast radius for a compromised `ompctl` deploy is scoped to the `ompctl`
  project alone. It cannot reach any other stack.
- Terraform state lives in `ompctl-terraform-state`, a versioned bucket in this
  same project, created by `bootstrap.sh` because Terraform cannot create the
  bucket holding its own state. An earlier revision of this decision reused a
  shared bucket from another project, which required a cross-project
  `roles/storage.objectAdmin` grant and widened the deploy identity past the one
  project it owns. Its own bucket costs nothing meaningful and removes that
  grant entirely.
- Versioning is enabled on the state bucket: a truncated or corrupted state
  push is recoverable only from a prior generation.
- A Workload Identity Federation pool (`ompctl-github`) is created in this
  project and bound to the single repository that deploys it, so CI holds an
  identity that can reach nothing else. The binding must name the repository
  that actually runs the deploy workflow; if it names a different repository,
  CI auth fails closed at `google-github-actions/auth` rather than degrading
  quietly.
- No service account key is ever created. GitHub proves its identity per run
  over federated OIDC.
- The backend bucket is not hardcoded in `main.tf`; CI passes it via
  `terraform init -backend-config`, so the state location stays out of the tree.

See `packages/hub/deploy/bootstrap.sh` for the one-time setup this decision
requires.
