# Cowork parity review

**Review date:** 2026-09-09  
**Reviewed base:** `origin/main` at `6c93f1c`  
**Scope:** Cowork app, wire, daemon container path, proof scripts, and current first-party competitor documentation.

## Verdict

Cowork has the right product premise and an incomplete product loop. Work should run on hardware the operator owns, while the operator can start, watch, steer, approve, and review it from a phone. Current Cowork presents three neighboring mechanisms: a task sidebar for existing sessions, a host capability catalogue, and a container launcher. They do not yet form one run from project selection through reviewed changes.

The current surface is behind the field on environment reproduction, repository isolation, task-to-host binding, live progress, and change review. Its best architecture is the model broker: the guest receives a narrow, revocable model grant rather than a reusable provider credential. The reviewed base also contains a release-blocking mount path that defeats that boundary for an installed daemon. PR [#196](https://github.com/jwaldrip/ompctl/pull/196) contains the remediation, but the base and installed binary remain unsafe until that change lands and is proven through the launchd entry path.

The parity target should be narrow and explicit:

> Choose an owned project, start one isolated task on owned compute, watch and steer it from the phone, inspect the diff and proof, then accept, apply, push, or discard the result.

Cloud placement is outside that target. Workflow integrity is inside it.

## What Cowork actually is

| Part | Current behavior | Evidence |
| --- | --- | --- |
| Entry and hidden target | Cowork picks the currently selected agent, otherwise the first top-level agent. With no agent, task creation refuses. The composer does not show the selected agent or project. | `packages/app/src/console/Console.tsx`, `coworkTarget`; `packages/app/src/cowork/useCowork.ts:53-57,118-136`; `packages/app/src/components/TaskSidebar.tsx:27-90` |
| Tasks | A task is a named prompt against an existing agent. It creates no host, checkout, branch, environment, or model grant. `waiting` is derived when that agent waits on approval. Success stores the ACP stop reason, not a work summary. | `packages/daemon/src/workspace/tasks.ts:46-140`; `packages/core/src/contracts.ts:2087-2124` |
| Skills and connectors | The surface polls host discovery every four seconds. Skills can be invoked as prompts against the hidden target agent. Connectors are health inventory. Plugins are a grouping of those same skills and connectors by loader provenance. | `packages/app/src/cowork/useCowork.ts:35-113`; `packages/app/src/cowork/catalog.ts`; `packages/app/src/components/CoworkCatalogueViews.tsx` |
| Folder catalogue | The phone browses directories on the daemon's disk over `fs_list`. Only daemon-confirmed directories can open. Files stay inert, symlinks are shown but not followed, and the roots menu cannot be bound. | `packages/app/src/screens/FolderPickerScreen.tsx:1-25,66-172`; `packages/app/src/remote/useRemoteStart.ts:71-176` |
| Folder binding | Bound folders live only in React state. A selection always becomes `{ hostPath, mode: "ro" }`; no persisted project record or write-mode control exists. | `packages/app/src/cowork/useCoworkFolders.ts:28-43,91-94,130-143` |
| Container start | The first bound folder becomes `cwd`; every bound folder goes into `host.mounts`. The app sends `agent_create`, then records only the returned agent ID in the local start state. | `packages/app/src/cowork/useCoworkFolders.ts:72-89,97-125,145-177` |
| After start | The start control becomes “Container running. Open the session.” Opening it leaves Cowork. The new agent ID never becomes the task composer's explicit target. Returning after opening the session can make it the selected target, but that is an indirect navigation side effect rather than a task contract. | `packages/app/src/screens/CoworkScreen.tsx:352-379`; `packages/app/src/console/Console.tsx`, `CoworkSurface` and `coworkTarget` |
| Task review | Detail shows title, state, prompt, stop reason or error, timestamps, Retry, and Open session. It has no plan, setup log, tool log, changed-file list, diff, test evidence, artifact, branch, or PR/apply action. | `packages/app/src/components/TaskDetail.tsx:27-91`; `packages/core/src/contracts.ts:2122-2123` |
| Portable handoff | `handoff-container.ts` defines a separate `.ompsession` JSON file containing a session ID, handoff markdown, active model, and optional daemon hint. It carries no bearer and no environment or repository snapshot. | `packages/core/src/handoff-container.ts:1-58` |

### The broken task-to-container link

The product wording implies “bind folders, start a container, start work.” The code implements two independent paths:

1. `useCoworkFolders` creates a new container agent and holds its ID only in `ContainerStart.started` (`packages/app/src/cowork/useCoworkFolders.ts:97-115`).
2. `useCowork.startTask` sends the task to `defaultAgentId`, supplied by `coworkTarget` from the selected or first existing top-level agent (`packages/app/src/cowork/useCowork.ts:118-136`; `packages/app/src/console/Console.tsx`, `coworkTarget`).

A user with an existing session can launch a container and then start a task that runs somewhere else. The screen does not show that destination. PR #197 fixes retrying a historical task on the wrong agent, but it does not join a newly launched container to a new task.

### The chosen folder has no intentional code-write path

The UI always binds the project `ro` (`packages/app/src/cowork/useCoworkFolders.ts:130-138`). On the reviewed base, an installed daemon also mounts its launch working directory read-write, which accidentally gives the guest a write path. That path is the security defect below. PR #196 removes it and uses the first explicit bound folder as the workspace, preserving its `ro` mode. After that correction, a Cowork container can inspect the chosen repository but cannot edit it. A safe coding workflow still needs a separate writable task workspace.

## Release blocker: the installed daemon mounts the operator's home

The safety claim and the mechanism disagree on the reviewed base.

| Link | Measured or read fact |
| --- | --- |
| Installed service | The live `~/Library/LaunchAgents/ai.ompctl.plist:24-25` sets `WorkingDirectory` to the operator's home. `packages/cli/src/commands/service.ts:59-95` generates that value deliberately. |
| CLI to daemon | `startCommand` passes `repoRoot: ctx.cwd` (`packages/cli/src/commands/daemon.ts:151-155`). Under that plist, `ctx.cwd` is the home directory. |
| Daemon to backend | The daemon passes `repoRoot` to `ContainerBackend.workspace` (`packages/daemon/src/daemon.ts:754-775`). |
| Validation boundary | `spec.mounts` go through `resolveMount`, which rejects protected roots. The implicit workspace bypasses that loop (`packages/daemon/src/provisioner/container.ts:645-689` on the reviewed base). |
| Runtime argv | The base emits `--volume ${workspace}:${workspace}` with no `:ro`, then uses it as `--workdir` (`packages/daemon/src/provisioner/container.ts:967-986` on the reviewed base). The native proof writes its answer files through that unqualified workspace mount. |

An installed daemon therefore gives a Cowork container the full home directory read-write. The picked folder may be mounted again as read-only at its exact path, but sibling paths under home remain visible. That includes the daemon state and the host OMP credential store that the broker design says never enters a guest. The issue matters more here than in a vendor cloud sandbox because the blast radius is the operator's real workstation.

The defect also contradicts three operator-facing claims:

- The UI labels the selected folder `ro` and says that is what the container gets (`packages/app/src/screens/CoworkScreen.tsx:275-324`).
- The container documentation says home roots, `~/.ssh`, `~/.omp`, and `~/.ompd` are refused (`docs/running.md:869-884`).
- The model documentation says no part of `~/.omp` is mounted into the guest (`docs/running.md:705-725`; `packages/daemon/src/provisioner/guest-config.ts:1-29`).

PR [#196](https://github.com/jwaldrip/ompctl/pull/196) routes the implicit workspace through the protected-root resolver, clears the default workspace under launchd or when the daemon starts in home, and uses the first explicit mount when no safe default exists. Its pre-fix test captures the unsafe `home:home` argv; its post-fix tests refuse home before any runtime call. The author reports 55 provisioner tests and 1,413 repository tests passing, plus a clean `bun run check`. The PR is open. The installed entry path still needs a real post-merge proof before the blocker can close.

## Container and model path

The intended path has several strong decisions:

- Runtime choice is platform ordered and fail-closed. macOS selects Apple `container`; Linux selects Podman unless the daemon config explicitly pins another supported runtime (`docs/running.md:536-567`; `packages/daemon/src/provisioner/runtime.ts`).
- A remote client cannot select an image. The daemon chooses `containerImage`, because an image entrypoint runs before the approval gate (`docs/running.md:598-624`; `packages/app/src/cowork/client.ts:30-48`).
- The default path uses digest-pinned `debian:bookworm-slim` plus a content-addressed, read-only mounted OMP toolchain and CA bundle (`docs/running.md:626-660`; `packages/daemon/src/provisioner/image.ts`).
- ACP crosses the boundary through `<runtime> exec -i <container> <omp-wrapper>`. The wrapper preserves the daemon approval overlay and permits one ACP connection per container (`packages/daemon/src/provisioner/container.ts:1-23,1052-1159`).
- Extra folders land at the same absolute path and default to read-only (`packages/daemon/src/provisioner/container.ts:650-661,895-900`).
- Container browser access is deliberately omitted. The existing WebView MCP server controls the operator's browser from daemon loopback, so exposing it to the guest would widen a different security boundary (`docs/running.md:521-534`). A container-local browser remains absent.

### What the model broker gives the guest

The broker gives one container one endpoint, one random bearer, and one model (`packages/daemon/src/provisioner/guest-config.ts:40-53`). The daemon creates a fresh guest home with exactly three generated files:

- `.omp/model-token`, mode `0600`
- `.omp/agent/models.yml`, pointing only at the daemon broker and reading the bearer with `!cat`
- `.omp/agent/config.yml`, pointing `default`, `smol`, and `tiny` at the one allowed model

Evidence: `packages/daemon/src/provisioner/guest-config.ts:154-251`.

The default grant expires after one day and is capped at 2,000 requests, 5,000,000 tokens, and four concurrent requests (`packages/daemon/src/model-broker/model-access.ts:51-71,290-301`). The listener accepts only `POST /v1/messages` and `POST /v1/messages/count_tokens`, verifies the bearer, enforces the one model and peer range when available, and reserves request ceilings before yielding (`packages/daemon/src/model-broker/broker.ts:12-16,60-66,621-738`). Stop revokes the grant before waiting on container teardown (`packages/daemon/src/provisioner/container.ts:1203-1225`).

That is an excellent credential shape once the home mount is gone. The current implementation grants model access only. Host skills, plugins, MCP connectors, and their credentials are not seeded into the guest. The Cowork catalogue therefore describes the hidden target session's host capabilities, not capabilities the new container necessarily receives.

## Proof ledger

| Command run on 2026-09-09 | Result | What it proves and what it does not |
| --- | --- | --- |
| `bun run scripts/proof-cowork-socket.ts` | Completed. The socket returned 982 skills, 40 connectors, an empty task list, a created local agent, a running task row, and `unauthorized: agent_create requires manage scope` for a read-only pairing. Cleanup returned 200 and removed the scratch daemon state. | Proves the Cowork wire asks and the scope refusal. The created host was local, so it proves no container property. |
| `bun run scripts/check-cowork-thin-path.ts` | `14 ok, 0 broken`. Apple `container 0.4.1`, pinned Debian digest, OMP 17.3.4, identical workspace path, host canary absent, toolchain read-only, and container/network reclaimed. | Proves the provisioner against a safe temporary workspace. It does not exercise the installed launchd working directory, which is why it missed the home mount. |
| `bun run scripts/check-native-container.ts` | `17 ok, 4 to look at, 0 broken`. | Proves workspace and environment isolation with a temporary workspace. It also records the current Apple runtime limits: writable root filesystem, uid 0 inside its VM, open outbound IP access, and no Docker socket measurement. |
| `bun run scripts/check-container-model-turn.ts` | The container completed a real model turn, the broker accounting and revocation checks passed, and teardown completed. The run ended `52 ok, 1 failed` because its preflight expected `anthropic/claude-opus-5:xhigh` while production intentionally normalizes that to `anthropic/claude-opus-5`. | The one failure was a stale proof expectation, not a failed model turn. PR [#195](https://github.com/jwaldrip/ompctl/pull/195) exports one normalization function for production and proof; its body reports `53 ok, 0 failed`. `check:container-model` is still absent from `check`, `test`, and every workflow. |
| `bun run scripts/check-container-host.ts` | Stopped before the Docker assertions because the Docker/OrbStack socket was absent. | Docker-specific confinement remains unmeasured in this review. The script failed rather than converting an unavailable runtime into a pass. |

## Refusals and empty states

The refusal model is a product feature, not error decoration. Current source defines these states:

| State | Operator-facing behavior | Evidence |
| --- | --- | --- |
| No folders | “No folders bound; the container will see only its own workspace.” The start button remains enabled, so tapping it changes the screen into a non-retryable “Bind a folder first” refusal. | `packages/app/src/screens/CoworkScreen.tsx:257-273,362-379`; `packages/app/src/cowork/useCoworkFolders.ts:145-155` |
| Broker unknown | The start button is enabled until a `container_state` frame arrives. | `packages/app/src/screens/CoworkScreen.tsx:257-260`; `packages/app/src/cowork/useCoworkFolders.ts:117-124` |
| Broker unavailable | A warning row explains the broker reason and disables start. The state does not include runtime, image, network, or project writability. | `packages/app/src/screens/CoworkScreen.tsx:338-350`; `packages/daemon/src/provisioner/container.ts:621-643` |
| Starting | The button becomes disabled and reads “Starting the container...” No setup stage, pull progress, toolchain progress, or elapsed state is shown. | `packages/app/src/screens/CoworkScreen.tsx:363-378` |
| Started | The start button is replaced with an Open session action. | `packages/app/src/screens/CoworkScreen.tsx:352-379` |
| Scope refusal | `unauthorized` becomes a non-retryable explanation that the pairing lacks manage scope. | `packages/app/src/cowork/useCoworkFolders.ts:185-191` |
| Provision refusal | Every `agent_create_failed` is non-retryable but is prefixed “the daemon refused the mounts,” even when the underlying failure is a missing runtime, image pull, or model grant. | `packages/app/src/cowork/useCoworkFolders.ts:200-208`; `packages/daemon/src/gateway/gateway.ts:3418-3449` |
| Replica refusal | The app explains that paths browsed on a replica mean nothing on the owning daemon and refuses rather than queueing the start elsewhere. | `packages/daemon/src/gateway/gateway.ts:3428-3439`; `packages/app/src/cowork/useCoworkFolders.ts:210-218` |
| Link failure | `offline` and `send` are retryable. Unknown errors default to retryable. | `packages/app/src/cowork/useCoworkFolders.ts:220-233` |
| Empty task or catalogue | Tasks, skills, connectors, and plugins each render an empty message. The first task screen can therefore stack folder absence, task absence, and broker state before the operator has selected a project. | `packages/app/src/components/TaskSidebar.tsx:83-115`; `packages/app/src/components/CoworkCatalogueViews.tsx:20-113`; `packages/app/src/screens/CoworkScreen.tsx:261-379` |

Three refusal defects were found while tracing those states:

1. `useCowork` sends skills, connectors, and tasks together but stores one global error. Any later successful slice clears it, so a failed catalogue can become indistinguishable from a legitimate empty catalogue (`packages/app/src/cowork/useCowork.ts:60-94` on the reviewed base).
2. `useCoworkFolders` treats the first generic socket error while `awaiting` as the container-start result. Catalogue polling uses the same socket. A catalogue error during a slow provision can mark the start refused, clear `awaiting`, and cause the later real `agent_created` frame to be ignored (`packages/app/src/cowork/useCoworkFolders.ts:97-115`; `packages/app/src/cowork/useCowork.ts:60-67`).
3. Retry resubmits a historical task through the current default agent rather than the task's original `agentId` (`packages/app/src/screens/CoworkScreen.tsx:164-174`; `packages/app/src/cowork/useCowork.ts:118-136` on the reviewed base).

PR [#197](https://github.com/jwaldrip/ompctl/pull/197) adds request IDs and catalogue discriminators, independent slice states, dedicated refused views, correlated container starts, and retry against the original agent. The author reports 93 app Cowork tests, 31 daemon Cowork tests, and 267 core tests passing, plus scoped type checks. The PR is open, so the reviewed base still has all three defects.

## Rendered surface status

The rendered screen was not measured. This reviewer had no browser/Eval facade, the relay path could not safely create or adopt a dedicated tab, and the alternate browser rig was closing pages during interaction. Launching another Chrome is prohibited. After the home-mount finding, starting a Cowork container through the live installed daemon would also have exercised the unsafe path, so I did not do it.

Runtime availability was mixed rather than absent. The Docker proof could not start because its socket was missing, and Podman was not running. Apple `container 0.4.1` was available and completed the native and thin-path proofs. The browser rig, followed by the unsafe installed entry path, blocked the surface observation.

Source specifies a narrow layout at 390 points with a bottom four-tab bar and pushed task detail. A desktop width at or above 860 points uses a 104-point rail, 300-point task sidebar, and remaining content pane (`packages/app/src/design/layout.ts:14-34`; `packages/app/src/screens/CoworkScreen.tsx:184-221,419-531`). Those are source facts, not visual findings. No claim about clipping, visual hierarchy, contrast, scroll, or above-the-fold content is made here.

A trustworthy visual pass should cover the following matrix before anyone acts on layout recommendations:

- 390 points, 860 points, 1,280 points, and the actual desktop width.
- No tasks and no folders, broker unknown, broker unavailable, runtime unavailable, manage-scope refusal, dangerous-mount refusal, starting, started, waiting, failed, and done.
- Direct and hub pairings.
- Document overflow, ink clipping, occlusion, refusal wrapping, bottom-nav safe area, keyboard focus, touch targets, contrast, and which action remains visible without scrolling.
- A real scratch daemon and disposable repository, with the runtime and model path exercised, rather than canned props alone.

## Current field

The comparison separates three product types. Codex, Claude Code on the web, Cursor Cloud Agents, Jules, Copilot cloud agent, and Devin are asynchronous Git task products. Replit Agent is a hosted application builder with Git support. E2B and Daytona supply sandbox infrastructure to products that build their own agent and review UX.

Every external source below returned HTTP 200 when retrieved on 2026-09-09.

[^openai]: OpenAI, retrieved 2026-09-09: [Codex cloud](https://learn.chatgpt.com/docs/cloud), [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment), [Agent internet access](https://learn.chatgpt.com/docs/cloud/internet-access).
[^anthropic]: Anthropic, retrieved 2026-09-09: [Claude Code on the web quickstart](https://code.claude.com/docs/en/web-quickstart), [Claude Code on the web reference](https://code.claude.com/docs/en/claude-code-on-the-web), [Cloud environments](https://code.claude.com/docs/en/cloud-environments).
[^cursor]: Cursor, retrieved 2026-09-09: [Cloud Agents](https://cursor.com/docs/cloud-agent), [Cloud environment setup](https://cursor.com/docs/cloud-agent/setup), [Secrets and network](https://cursor.com/docs/cloud-agent/security-network).
[^jules]: Google, retrieved 2026-09-09: [Jules environment setup](https://jules.google/docs/environment/), [Running tasks](https://jules.google/docs/running-tasks/), [Limits and plans](https://jules.google/docs/usage-limits/).
[^copilot]: GitHub, retrieved 2026-09-09: [About Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent), [Configure the development environment](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment), [Secrets and variables](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/configure-secrets-and-variables), [Manage agent sessions](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/manage-and-track-agents).
[^devin]: Cognition, retrieved 2026-09-09: [Enterprise deployment](https://docs.devin.ai/enterprise/deployment/overview), [Environment blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints), [Session tools](https://docs.devin.ai/work-with-devin/devin-session-tools), [Secrets](https://docs.devin.ai/product-guides/secrets), [Git integrations](https://docs.devin.ai/enterprise/integrations/git-integrations), [Dynamic workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows).
[^replit]: Replit, retrieved 2026-09-09: [Agent overview](https://docs.replit.com/features/agent/overview), [App configuration](https://docs.replit.com/features/project-setup/configuration), [Checkpoints and rollbacks](https://docs.replit.com/features/version-control/checkpoints-and-rollbacks), [AI billing and plan limits](https://docs.replit.com/billing/ai-billing), [Git pane](https://docs.replit.com/features/workspace-tools/git-interface).
[^e2b]: E2B, retrieved 2026-09-09: [Sandbox lifecycle](https://docs.e2b.dev/sandbox), [Template snapshots](https://docs.e2b.dev/template/how-it-works), [Internet access](https://docs.e2b.dev/network/internet-access), [Secrets](https://docs.e2b.dev/secrets), [Billing and limits](https://docs.e2b.dev/billing).
[^daytona]: Daytona, retrieved 2026-09-09: [Sandboxes](https://www.daytona.io/docs/en/sandboxes/), [Architecture](https://www.daytona.io/docs/en/architecture/), [Git operations](https://www.daytona.io/docs/en/git-operations/), [Secrets](https://www.daytona.io/docs/en/secrets/), [Limits](https://www.daytona.io/docs/en/limits/).

### OpenAI Codex cloud tasks

- **Run location:** Each task runs in an isolated cloud container, separate from the developer's device.[^openai]
- **Environment:** Codex checks out a selected branch or SHA into its `universal` image, supports version pins, automatic or manual setup, maintenance scripts, and cached container state. Setup has internet; the agent phase blocks egress by default and can use domain and HTTP-method allowlists.[^openai]
- **Repository flow:** GitHub and GitLab projects enter through connected environments. The result is a summary and diff with follow-up prompts and PR or MR creation.[^openai]
- **Review and observation:** The operator can watch logs while the task runs, leave it in the background, inspect the final answer and diff, and iterate before opening the review artifact.[^openai]
- **Concurrent top-level work:** Parallel cloud tasks are a first-class feature. The cited documentation gives no fixed numeric top-level task ceiling, so “parallel” is the supported claim and “unlimited” is not.[^openai]
- **Secrets and model:** Plain environment variables persist through the task. Encrypted secrets are available only to setup and are removed before the agent phase. Model access is part of the Codex service rather than a provider credential placed in the task environment.[^openai]

### Anthropic Claude Code on the web

- **Run location:** A session runs in a fresh Anthropic-managed Ubuntu VM by default, or on an organization runner under the self-hosted environment option.[^anthropic]
- **Environment:** Saved environments define network level, ordinary environment variables, setup scripts, and cached setup state. Network choices are None, Trusted, Full, or Custom.[^anthropic]
- **Repository flow:** Claude clones GitHub repositories, pushes a session branch, can create a draft or full PR, and can teleport the branch and conversation into a local CLI session. The web flow supports multiple selected repositories; CLI `--cloud` remains single-repository.[^anthropic]
- **Review and observation:** Web and mobile show setup progress, the live conversation, and steering. The diff has a file list, line counts, inline comments that feed the next prompt, PR creation, and optional PR auto-fix.[^anthropic]
- **Concurrent top-level work:** The product explicitly supports several independent sessions and branches at once. The cited pages publish no total simultaneous-session ceiling.[^anthropic]
- **Secrets and model:** Git operations use a credential-swapping proxy. Pro and Max environments can store API credentials that the agent proxy adds after requests leave the VM, while ordinary environment variables remain readable inside it. Claude model access is service-managed.[^anthropic]

### Cursor Cloud Agents, formerly Background Agents

- **Run location:** Managed runs use isolated VMs in Cursor's AWS infrastructure. Self-hosted machines move tool execution to customer workers while retaining Cursor's cloud control and model plane.[^cursor]
- **Environment:** Agent-led setup or `.cursor/environment.json` can define a Dockerfile, install script, start commands, terminals, secrets, network rules, and a saved build. Successful builds become pre-warmed disk snapshots. Multi-repository environments are supported.[^cursor]
- **Repository flow:** Cursor connects GitHub, GitLab, Bitbucket, or Azure DevOps, clones the selected repositories, works on separate branches, pushes, and opens PRs in changed repositories.[^cursor]
- **Review and observation:** Web, iOS, Android PWA, and desktop surfaces show transcripts and tool output. Agents can produce screenshots, videos, and logs. The operator can take over the remote sandbox desktop and then return control.[^cursor]
- **Concurrent top-level work:** Cursor's docs say users can run as many cloud agents as desired in parallel. Plan, spend, and infrastructure limits still bound use; the cited page publishes no single numeric task cap.[^cursor]
- **Secrets and model:** Environment variables are agent-readable. Runtime Secrets still exist as environment variables but are redacted from agent-visible outputs and commits. Build Secrets stay in the Docker build. OIDC can mint short-lived cloud identity. The service offers a curated model set.[^cursor]

### Google Jules

- **Run location:** Every task runs in a secure, short-lived Google-hosted Ubuntu VM.[^jules]
- **Environment:** Jules can infer setup from the repository, README, and `AGENTS.md`, or run an explicit setup script. A successful Run and Snapshot captures a reusable VM disk state for later tasks.[^jules]
- **Repository flow:** The operator selects a GitHub repository and branch. Jules creates changes in its VM, then can create a branch and hand off to a GitHub PR.[^jules]
- **Review and observation:** Jules offers plan review before coding, an activity feed, inline explanations, mini diffs, a full multi-file diff, mid-task feedback, pause, completion summary, and browser notifications.[^jules]
- **Concurrent top-level work:** Current plans document 3, 15, and 60 concurrent tasks, paired with 15, 100, and 300 tasks per rolling day.[^jules]
- **Secrets and model:** The cited environment and task documentation does not document a dedicated task-secret vault or out-of-guest injection mechanism. Model access is plan-based Gemini access.[^jules]

### GitHub Copilot cloud agent

- **Run location:** Each session gets an ephemeral GitHub Actions-powered environment. Repositories can select GitHub-hosted or ephemeral self-hosted Ubuntu or Windows runners.[^copilot]
- **Environment:** `.github/workflows/copilot-setup-steps.yml` supplies setup steps, permissions, services, runner labels, optional snapshots, and a session timeout. A failed setup step does not necessarily block agent work, so the session log matters.[^copilot]
- **Repository flow:** The product is GitHub-only. It works in one repository, one branch, and at most one PR per task.[^copilot]
- **Review and observation:** The agents panel shows live progress, reasoning, tools, token use, and session length. Operators can steer or stop a run. Commits link back to the session log, and normal GitHub PR review handles the diff.[^copilot]
- **Concurrent top-level work:** Multiple background sessions are supported. The cited product documentation publishes no numeric concurrent-session cap.[^copilot]
- **Secrets and model:** Dedicated repository or organization Agents secrets are exposed as environment variables and masked in logs; MCP-only values use a prefix. The task entry point can offer a model picker.[^copilot]

### Devin

- **Run location:** The Brain stays in Cognition's cloud. Each session's Devbox runs on an isolated machine in Cognition's multi-tenant cloud or a customer-dedicated VPC.[^devin]
- **Environment:** Reviewable YAML blueprints define initialize, maintenance, knowledge, clone, and post-build behavior. Builds clone repositories and produce snapshots; each session boots a fresh copy.[^devin]
- **Repository flow:** Enterprise integrations cover GitHub, GitHub Enterprise, GitLab, Bitbucket, and Azure DevOps with explicit repository grants. Work leaves through branches and PRs.[^devin]
- **Review and observation:** Progress joins shell commands, edits, and browser activity. Separate Shell, embedded VS Code, and Desktop tabs allow inspection and takeover; side chats ask read-only questions without stopping the main run.[^devin]
- **Concurrent top-level work:** Dynamic workflows can fan work across agents and VMs. Public documentation describes the mechanism but no universal organization-level session count.[^devin]
- **Secrets and model:** Organization, personal, repository, and session secrets are encrypted but become environment variables in the Devbox. Cognition's compound model service supplies the Brain; third-party LLM API keys are unsupported.[^devin]

### Replit Agent

- **Run location:** Agent works inside a Replit-hosted application workspace. Its primary output is a running Replit app or artifact, rather than a Git patch alone.[^replit]
- **Environment:** `.replit` defines run, build, services, ports, and tool behavior; `replit.nix` defines system packages. Replit calls the Nix path reproducible.[^replit]
- **Repository flow:** Projects can be created in Replit or connected to Git. Agent checkpoints create corresponding Git commits, while the Git pane can stage, branch, push, pull, and resolve conflicts. PR creation is optional through shell tooling rather than the center of the Agent loop.[^replit]
- **Review and observation:** Agent chat, application preview, file changes, checkpoints, cost, and rollback form the main review surface. Checkpoints can cover code, conversation, configuration, and optional development database state.[^replit]
- **Concurrent top-level work:** Current plan documentation lists 0, 1, and 10 active background tasks for Starter, Core, and Pro.[^replit]
- **Secrets and model:** Replit Secrets enter the workspace as environment variables. Replit routes supported model providers behind Agent and bills their use through Replit credits, so users do not supply the Agent's model credential.[^replit]

### Sandbox substrates

#### E2B

- **Run location and environment:** E2B starts isolated Linux VMs from templates built from container definitions. A template snapshots filesystem and running process state for fast later starts.[^e2b]
- **Repository flow:** The SDK exposes files and command execution; a caller runs Git or uploads code. E2B itself supplies no opinionated branch or PR workflow.[^e2b]
- **Review and observation:** SDK callbacks, process output, filesystem watchers, lifecycle state, and a console expose infrastructure activity. **[INFERENCE]** A product using E2B must build its own task, diff, approval, and human review surface.[^e2b]
- **Concurrent sandboxes:** Current limits are 20 on Hobby, 100 included on Pro with add-ons up to 1,100, and custom above that. These are sandbox pool counts, not end-user task slots.[^e2b]
- **Secrets and model:** Network rules can disable egress or apply IP, CIDR, and domain controls. Its private-beta secret service injects credentials into approved outbound HTTPS requests outside the VM. **[INFERENCE]** The caller supplies the agent and model layer.[^e2b]

#### Daytona

- **Run location and environment:** Daytona supplies isolated Linux containers by default, optional Linux or Windows VMs, GPU sandboxes, OCI snapshots, and cloud or customer-run compute planes.[^daytona]
- **Repository flow:** A first-class Git API can clone a branch or commit, inspect status, create branches, stage, commit, push, and pull. It remains a primitive for the calling product rather than a ready-made PR agent.[^daytona]
- **Review and observation:** SDK, CLI, dashboard, SSH, process logs, terminal sessions, and OTLP expose the sandbox. **[INFERENCE]** A caller must add task planning, diff review, approvals, and product-level completion semantics.[^daytona]
- **Concurrent sandboxes:** Capacity is expressed as an organization CPU, memory, and storage pool. The number of simultaneous sandboxes depends on each sandbox's allocation; tier-one starts with 10 vCPU and higher tiers expand the pool.[^daytona]
- **Secrets and model:** Daytona's proxy replaces opaque placeholders with secrets only for allowed outbound HTTPS hosts and scrubs reflected values before they return. **[INFERENCE]** The caller supplies model routing.[^daytona]

## Position by axis

| Axis | Position | Evidence and judgment |
| --- | --- | --- |
| Compute ownership | **Ahead** | The daemon and tools run on the operator's machine, reachable through the existing sealed socket even over the hub (`packages/app/src/console/Console.tsx`, `CoworkSurface`; `packages/app/src/cowork/client.ts`). Competitor self-hosted runners remain hybrid vendor-control arrangements.[^anthropic][^cursor][^copilot][^devin] Keep this difference. |
| Isolation claim | **Behind on the reviewed base** | The installed daemon mounts home read-write and bypasses its own protected-root rule. PR #196 has the right immediate fix. Owned hardware raises the required standard because the adjacent data is real operator data, not one disposable vendor VM. |
| Project environment reproduction | **Behind** | Ompctl pins the base and OMP toolchain but has no per-project setup contract, validated environment build, snapshot, maintenance hook, or cache provenance surfaced to Cowork (`docs/running.md:598-660`). Every direct Git task peer offers an environment mechanism.[^openai][^anthropic][^cursor][^jules][^copilot][^devin] |
| Repository ingress and egress | **Behind** | Cowork browses folders already on the daemon and mounts them read-only. It creates no task branch, worktree, commit, diff, apply step, or PR. Local non-Git folders should remain first class, but Git projects need a safe run boundary. |
| Task-to-host integrity | **Behind** | Container start and task start are separate state machines with separate agent selection. The destination is hidden. An operator cannot read one task row and tell which project snapshot, host, policy, environment, or base ref it owns. |
| Task review | **Behind** | `Task.result` is a stop reason. The detail surface shows metadata and links to the session (`TaskDetail.tsx:27-91`). Every direct peer supplies at least a change diff and most add plans, logs, artifacts, or PR handoff.[^openai][^anthropic][^cursor][^jules][^copilot][^devin] |
| Live observation and steering | **Behind inside Cowork** | The task list polls every four seconds and exposes only state. Opening the session reaches the existing transcript and approval surface, which is useful, but it leaves the task context. Cursor and Devin demonstrate the stronger joined shape; Codex, Claude, Jules, and Copilot at least keep logs and steering with the task.[^openai][^anthropic][^cursor][^jules][^copilot][^devin] |
| Concurrent top-level tasks | **Behind as a product surface** | The model broker caps concurrent model requests per grant, but Cowork exposes no host capacity, queue, task slots, batch launch, or parallel attempt model. The model proof created two containers, so “at least two” is measured; no intentional user-level concurrency contract is present. Competitor task limits vary, which is a reason to expose owned capacity rather than copy a number.[^openai][^anthropic][^cursor][^jules][^copilot][^devin][^replit] |
| Model credential design | **Behind today, ahead-shaped after #196** | The one-model bearer, route allowlist, peer range, quotas, and revoke-first teardown are stronger than ordinary runtime environment injection (`guest-config.ts`; `model-broker/broker.ts`; `model-broker/model-access.ts`). The home mount currently bypasses them. E2B and Daytona validate the broader out-of-sandbox injection pattern.[^e2b][^daytona] |
| General secrets and connectors | **Behind** | Cowork can list connector health but grants none to the container. A raw mount of `~/.omp` would be unacceptable. The model broker pattern should expand into host and route-scoped connector grants. |
| Browser and visual proof | **Behind** | The container gets no browser tool. Cursor, Devin, and Replit make running software and visual artifacts part of the work surface.[^cursor][^devin][^replit] Bridging the operator's browser into an untrusted guest would be the wrong fix; a sandbox-local browser is the safe target. |
| Phone and cross-device control | **Level, with a stronger local premise** | Claude and Cursor have explicit mobile task surfaces, and the other cloud tools are web reachable.[^anthropic][^cursor][^openai][^jules][^copilot][^devin] Ompctl reaches the operator's own running sessions rather than a vendor copy. The remaining gap is task review quality, not reachability. |
| Refusal honesty | **Behind on the base, improving in #197** | Named non-retryable and retryable states are the right model. Generic socket errors, cross-slice erasure, false mount wording, and missing runtime readiness make the current answer unreliable. PR #197 closes the correlation and slice-state defects, but provision failures still need structured categories and actionable remediation. |
| Task ordering | **Level** | Waiting precedes running, and terminal work is ordered by recent update (`packages/app/src/cowork/tasks.ts:40-91`). That fits “pick up where I left off” better than directory-first ordering. Project filtering and visible targets are missing. |

## Differences to keep

1. **Keep execution on owned hardware.** Moving the default to a vendor cloud would erase the product's reason to exist. Hybrid remote workers may extend the owned fleet later, but the control plane must not turn into a requirement for the vendor to hold code, disks, and task history.
2. **Keep image trust local.** A paired phone may request work, but it should not select an arbitrary OCI image whose entrypoint runs before the gate. `containerImage` belongs to local daemon policy (`docs/running.md:598-624`).
3. **Keep reusable credentials outside guests.** Copilot, Devin, Replit, and parts of Cursor expose secrets as environment variables, even when logs redact them.[^copilot][^devin][^replit][^cursor] Ompctl should extend its broker pattern, not regress to raw injection.
4. **Keep approvals on consequential host actions.** Cursor auto-runs terminal commands in a vendor VM.[^cursor] Owned-machine work needs explicit capability grants and durable audit. The better usability move is task-scoped policy, not blanket auto-run.
5. **Keep local folders and non-Git work first class.** GitHub-only intake would exclude work that exists only on the operator's machine. Add Git workflow where a repository exists; do not make a hosted provider the definition of a project.
6. **Keep concurrency honest.** Cursor markets open-ended parallelism, while Jules and Replit publish plan slots.[^cursor][^jules][^replit] Ompctl should expose available CPU, memory, model slots, and queued work from the owned machine. A made-up global number would hide the constraint instead of managing it.
7. **Keep the operator's real browser outside the guest.** Cursor and Devin allow takeover inside their disposable remote desktops.[^cursor][^devin] Ompctl's comparable surface should be a browser inside the task sandbox or a narrowly brokered preview, never a route from untrusted code to the operator's personal browser.

## Review-triggered remediations

- PR [#195](https://github.com/jwaldrip/ompctl/pull/195) replaces duplicated model-reference normalization in the native model proof. Its body records `53 ok, 0 failed` after the change.
- PR [#196](https://github.com/jwaldrip/ompctl/pull/196) refuses the implicit home workspace and makes an explicit bound folder the installed daemon's only container workspace.
- PR [#197](https://github.com/jwaldrip/ompctl/pull/197) correlates Cowork requests, preserves independent catalogue refusals, prevents unrelated socket errors from hijacking container start, and retries tasks on their original agent.
- All three PRs are open. The reviewed base and installed binary do not yet contain them.

## Ranked build list

1. **Land and prove the home-mount fix before another Cowork container is trusted.** Merge #196 only after its full gate, install the resulting daemon, start it through the real launchd plist, provision from the phone with a disposable project, and prove from inside that home, `~/.ssh`, `~/.omp`, and `~/.ompd` are unreachable. Keep a failing pre-fix control. This closes the broken isolation claim.
2. **Replace “start a container” with one durable isolated-task operation.** A request should name project, prompt, base state, environment, policy, requested capabilities, and desired output. The daemon should create the workspace, host, agent, and task as one transaction and return one run ID. The app should never infer the target from whichever session happens to be selected. This closes the task-to-host gap.
3. **Give every writable Git task a daemon-managed worktree or clone.** Mount that disposable task directory read-write and mount reference folders read-only. Preserve the operator's checkout. Capture an explicit dirty patch only when the operator chooses it. Finish with apply, branch push, PR, or discard. Keep a read-only mode for non-Git analysis. This creates a legitimate code-write and recovery path.
4. **Add a per-project environment contract and proven cache.** Reuse existing standards where possible: devcontainer, Containerfile, setup script, and project instructions. Record the image digest, setup input fingerprint, successful validation, runtime capabilities, and cache provenance. A stale or failed environment must refuse before the task starts. This closes the reproducibility gap without moving compute away from the operator.
5. **Make the task the review surface.** Store and stream setup stages, tool activity, approvals, changed files, diff, verification commands and outcomes, screenshots or artifacts, final summary, and disposition. Keep Open session as an escape hatch, not the only way to understand the result. Replace the misleading “Result: end_turn” presentation with a real task outcome.
6. **Add a sandbox-local browser and preview path.** Give the guest a browser it can control inside its own boundary, plus a narrowly scoped way to stream screenshots, video, console output, and a local service preview to the phone. Preserve the refusal to expose the operator's personal browser. This closes the visual-proof gap.
7. **Generalize the model broker pattern to connector capabilities.** Grant one task selected operations against selected hosts, inject secrets outside the guest, cap calls, audit use, and revoke on task teardown. Pair it with egress default-deny or an explicit allowlist. Never mount the operator's OMP home to make host plugins appear inside the container.
8. **Build admission and parallel work around measured owned capacity.** Show running containers, queued tasks, reserved CPU and memory, model-request slots, and why a task is waiting. Support several top-level attempts when capacity exists, then let the operator compare their diffs. Refuse or queue beyond the measured ceiling rather than borrowing a cloud product's number.
9. **Land #197 and finish refusal semantics.** Keep per-request correlation and per-slice states. Split `agent_create_failed` into mount, runtime, image, network, model, and policy failures; attach one concrete recovery action; keep the refusal visible until that operation is retried. Add runtime and image readiness to `container_state` so the green start control does not promise only that the model broker has config.
10. **Simplify Cowork around projects and work.** Remove the standalone container-start button from the primary flow. Replace Bound folders with a persistent project selector in the task composer. Move Plugins to settings. Keep Skills as composer commands and show Connectors as capabilities requested by the task. Collapse the stacked first-run empties into one action: choose a project and describe the work.
11. **Gate the hardware proofs on a labeled machine.** Keep the default suite hardware-independent, but run the native container, broker turn, and Docker confinement proofs on an explicit scheduled or release gate with recorded runtime versions. PR #195 fixed one proof that had drifted while ungated; a proof that can lie cannot remain ceremonial.
