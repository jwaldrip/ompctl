/**
 * Deploy boundary and change detector for hub and web Cloud Run services.
 *
 * Requirements:
 * - README/docs/test-only changes must never start the deploy workflow.
 * - Hub changes roll hub only.
 * - App changes roll web only.
 * - Shared tunnel changes roll both hub and web.
 * - Core changes roll web only (hub does not import core).
 * - Root dependency changes (package.json, bun.lock) roll both hub and web.
 * - Infra-only changes (Terraform, deploy workflow) trigger Terraform apply with live images (no container rebuilds).
 * - Manual workflow_dispatch triggers a full redeploy (both container builds plus apply).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

export interface DeployPlan {
  readonly shouldTriggerWorkflow: boolean;
  readonly buildHub: boolean;
  readonly buildWeb: boolean;
  readonly applyTerraform: boolean;
  readonly reason: string;
}

export interface DeployDetectorOptions {
  readonly isManualDispatch?: boolean;
}

/**
 * Returns true if the path is documentation or a test file that should not trigger deploys.
 */
export function isIgnoredPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");

  // Top-level or package-level markdown and documentation
  if (normalized.endsWith(".md") || normalized.startsWith("docs/")) {
    return true;
  }

  // Tests and test fixtures
  if (
    normalized.includes("/test/") ||
    normalized.startsWith("test/") ||
    normalized.endsWith(".test.ts") ||
    normalized.endsWith(".test.tsx") ||
    normalized.endsWith(".test.js") ||
    normalized.endsWith(".test.jsx")
  ) {
    return true;
  }

  return false;
}

/**
 * Classifies a single path into affected targets.
 */
export function classifyPath(filePath: string): {
  affectsHub: boolean;
  affectsWeb: boolean;
  affectsInfra: boolean;
  isDeployScope: boolean;
} {
  const normalized = filePath.replace(/\\/g, "/");

  if (isIgnoredPath(normalized)) {
    return { affectsHub: false, affectsWeb: false, affectsInfra: false, isDeployScope: false };
  }

  // Deploy infra only: Terraform and workflow files
  if (
    normalized === ".github/workflows/hub-deploy.yml" ||
    normalized === "packages/hub/deploy/main.tf" ||
    normalized === "packages/hub/deploy/.terraform.lock.hcl"
  ) {
    return { affectsHub: false, affectsWeb: false, affectsInfra: true, isDeployScope: true };
  }

  // Root dependency manifests affect both container builds
  if (normalized === "package.json" || normalized === "bun.lock" || normalized === "bun.lockb") {
    return { affectsHub: true, affectsWeb: true, affectsInfra: false, isDeployScope: true };
  }

  // Hub container build files or source
  if (normalized.startsWith("packages/hub/")) {
    // Other files in packages/hub/deploy/ (like Dockerfile, cloudbuild.yaml) affect hub image
    return { affectsHub: true, affectsWeb: false, affectsInfra: false, isDeployScope: true };
  }

  // Shared tunnel package: imported by both packages/hub and packages/app
  if (normalized.startsWith("packages/tunnel/")) {
    return { affectsHub: true, affectsWeb: true, affectsInfra: false, isDeployScope: true };
  }

  // App container source: web console
  if (normalized.startsWith("packages/app/")) {
    return { affectsHub: false, affectsWeb: true, affectsInfra: false, isDeployScope: true };
  }

  // Shared core package: imported by packages/app, NOT by packages/hub
  if (normalized.startsWith("packages/core/")) {
    return { affectsHub: false, affectsWeb: true, affectsInfra: false, isDeployScope: true };
  }

  // Other paths (packages/daemon, packages/cli, packages/site, packages/e2e, other workflows)
  return { affectsHub: false, affectsWeb: false, affectsInfra: false, isDeployScope: false };
}

/**
 * Computes the deploy plan from an array of changed file paths.
 */
export function computeDeployPlan(changedFiles: readonly string[], options: DeployDetectorOptions = {}): DeployPlan {
  if (options.isManualDispatch) {
    return {
      shouldTriggerWorkflow: true,
      buildHub: true,
      buildWeb: true,
      applyTerraform: true,
      reason: "manual workflow_dispatch forces full redeploy of both hub and web",
    };
  }

  let buildHub = false;
  let buildWeb = false;
  let affectsInfra = false;
  let hasDeployScope = false;
  const matchedPaths: string[] = [];

  for (const file of changedFiles) {
    const classification = classifyPath(file);
    if (classification.isDeployScope) {
      hasDeployScope = true;
      matchedPaths.push(file);
    }
    if (classification.affectsHub) buildHub = true;
    if (classification.affectsWeb) buildWeb = true;
    if (classification.affectsInfra) affectsInfra = true;
  }

  const applyTerraform = buildHub || buildWeb || affectsInfra;

  let reason = "no deploy-scope files changed";
  if (buildHub && buildWeb) {
    reason = "shared or multi-package changes require rebuilding both hub and web";
  } else if (buildHub) {
    reason = "hub source changed; rebuilding hub image only";
  } else if (buildWeb) {
    reason = "app or core source changed; rebuilding web image only";
  } else if (affectsInfra) {
    reason = "infra or deploy workflow changed; applying terraform with live images";
  }

  return {
    shouldTriggerWorkflow: hasDeployScope,
    buildHub,
    buildWeb,
    applyTerraform,
    reason,
  };
}

/**
 * Resolves changed files from git between two revisions.
 * Handles initial pushes and all-zero before SHAs safely.
 */
export function getChangedFilesFromGit(beforeSha?: string, headSha?: string): string[] {
  const head = headSha?.trim() || "HEAD";
  const before = beforeSha?.trim();

  const isAllZeros = !before || /^0+$/.test(before);

  let diffRange: string | null = null;

  if (!isAllZeros && before) {
    try {
      execFileSync("git", ["rev-parse", "--verify", `${before}^{commit}`], { stdio: "ignore" });
      diffRange = `${before}..${head}`;
    } catch {
      // before commit not found in local repo
      diffRange = null;
    }
  }

  if (!diffRange) {
    // Fall back to comparing against HEAD~1 if possible
    try {
      execFileSync("git", ["rev-parse", "--verify", `${head}~1`], { stdio: "ignore" });
      diffRange = `${head}~1..${head}`;
    } catch {
      diffRange = null;
    }
  }

  try {
    if (diffRange) {
      const output = execFileSync("git", ["diff", "--name-only", diffRange], { encoding: "utf8" });
      return output
        .split("\n")
        .map(s => s.trim())
        .filter(Boolean);
    }

    // Single commit with no parent
    const output = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", head], {
      encoding: "utf8",
    });
    return output
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn(`[deploy-boundary] git diff failed: ${error}`);
    return [];
  }
}

// CLI execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  let beforeSha = process.env.GITHUB_BEFORE || "";
  let headSha = process.env.GITHUB_SHA || "";
  let eventName = process.env.GITHUB_EVENT_NAME || "";
  let filesArg = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--before" && args[i + 1]) {
      beforeSha = args[++i];
    } else if (args[i] === "--sha" && args[i + 1]) {
      headSha = args[++i];
    } else if (args[i] === "--event" && args[i + 1]) {
      eventName = args[++i];
    } else if (args[i] === "--files" && args[i + 1]) {
      filesArg = args[++i];
    }
  }

  const isManualDispatch = eventName === "workflow_dispatch";
  let changedFiles: string[] = [];

  if (filesArg) {
    changedFiles = filesArg
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  } else if (!isManualDispatch) {
    changedFiles = getChangedFilesFromGit(beforeSha, headSha);
  }

  const plan = computeDeployPlan(changedFiles, { isManualDispatch });

  console.log(JSON.stringify(plan, null, 2));

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `should_trigger=${plan.shouldTriggerWorkflow}\n`);
    appendFileSync(githubOutput, `build_hub=${plan.buildHub}\n`);
    appendFileSync(githubOutput, `build_web=${plan.buildWeb}\n`);
    appendFileSync(githubOutput, `apply_terraform=${plan.applyTerraform}\n`);
    appendFileSync(githubOutput, `reason=${plan.reason}\n`);
  }
}
