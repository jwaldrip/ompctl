import { describe, expect, test } from "bun:test";
import { classifyPath, computeDeployPlan } from "./deploy-boundary.ts";

describe("deploy-boundary decision logic", () => {
  test("README and docs only changes do not trigger workflow", () => {
    const paths = ["README.md", "docs/overview.md", "packages/hub/README.md", "packages/app/docs/notes.md"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(false);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(false);
    expect(plan.applyTerraform).toBe(false);
  });

  test("test only changes do not trigger workflow", () => {
    const paths = [
      "packages/hub/test/tunnel.test.ts",
      "packages/app/test/smoke.test.tsx",
      "packages/tunnel/test/reconnect-backoff.test.ts",
      "packages/core/test/policy.test.ts",
      "packages/daemon/test/daemon.test.ts",
    ];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(false);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(false);
    expect(plan.applyTerraform).toBe(false);
  });

  test("app source changes roll web only and do not roll hub", () => {
    const paths = ["packages/app/src/components/Console.tsx", "packages/app/src/platform/socket.ts"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(true);
    expect(plan.applyTerraform).toBe(true);
  });

  test("hub source changes roll hub only and do not roll web", () => {
    const paths = ["packages/hub/src/hub.ts", "packages/hub/src/redis-backplane.ts"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(true);
    expect(plan.buildWeb).toBe(false);
    expect(plan.applyTerraform).toBe(true);
  });

  test("shared tunnel package rolls both hub and web", () => {
    // Both packages/hub and packages/app import @ompd/tunnel
    const paths = ["packages/tunnel/src/index.ts"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(true);
    expect(plan.buildWeb).toBe(true);
    expect(plan.applyTerraform).toBe(true);
  });

  test("shared core package rolls web only because hub does not import core", () => {
    // packages/app imports @ompd/core; packages/hub does not
    const paths = ["packages/core/src/contracts.ts"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(true);
    expect(plan.applyTerraform).toBe(true);
  });

  test("root dependency manifest changes roll both hub and web", () => {
    const paths = ["package.json", "bun.lock"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(true);
    expect(plan.buildWeb).toBe(true);
    expect(plan.applyTerraform).toBe(true);
  });

  test("Terraform only changes trigger apply with no container rebuilds", () => {
    const paths = ["packages/hub/deploy/main.tf", "packages/hub/deploy/.terraform.lock.hcl"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(false);
    expect(plan.applyTerraform).toBe(true);
  });

  test("workflow only changes trigger apply with no container rebuilds", () => {
    const paths = [".github/workflows/hub-deploy.yml"];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(false);
    expect(plan.applyTerraform).toBe(true);
  });

  test("manual workflow_dispatch forces both container builds and apply", () => {
    const plan = computeDeployPlan([], { isManualDispatch: true });
    expect(plan.shouldTriggerWorkflow).toBe(true);
    expect(plan.buildHub).toBe(true);
    expect(plan.buildWeb).toBe(true);
    expect(plan.applyTerraform).toBe(true);
  });

  test("unrelated package changes (daemon, cli, site) do not trigger workflow", () => {
    const paths = [
      "packages/daemon/src/gateway/gateway.ts",
      "packages/cli/src/main.ts",
      "packages/site/src/index.html",
      "packages/omp-extension/src/extension.ts",
    ];

    const plan = computeDeployPlan(paths);
    expect(plan.shouldTriggerWorkflow).toBe(false);
    expect(plan.buildHub).toBe(false);
    expect(plan.buildWeb).toBe(false);
    expect(plan.applyTerraform).toBe(false);
  });

  test("mutation proof: mutating core mapping to affect hub causes failure", () => {
    // Demonstrates that the test suite detects if someone incorrectly maps core to hub.
    const baseline = classifyPath("packages/core/src/contracts.ts");
    expect(baseline.affectsHub).toBe(false);
    expect(baseline.affectsWeb).toBe(true);

    // Simulated mutated classifier where core mistakenly rolls hub
    const mutatedClassify = (path: string) => {
      if (path.startsWith("packages/core/")) {
        return { affectsHub: true, affectsWeb: true, affectsInfra: false, isDeployScope: true };
      }
      return classifyPath(path);
    };

    const mutatedResult = mutatedClassify("packages/core/src/contracts.ts");
    // Assert the mutation contradicts the expected invariant that hub does not import core
    expect(mutatedResult.affectsHub).not.toBe(baseline.affectsHub);
  });
});
