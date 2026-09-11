import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, ".github/workflows/app-store-distribute.yml"), "utf8");
const workflow = Bun.YAML.parse(source) as Record<string, unknown>;

const triggers = workflow.on as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;

function jobCondition(name: string): string {
  const condition = jobs[name]?.if;
  if (typeof condition !== "string") throw new Error(`${name} has no job condition`);
  return condition;
}
function normalizeCondition(condition: string): string {
  return condition.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}
interface LookupRun {
  exitCode: number;
  output: string;
}

async function runLookupStep(stepName: string, lookupExit: number): Promise<LookupRun> {
  const jobName = stepName.includes("iOS") ? "ios-testflight" : "macos-testflight";
  const job = jobs[jobName] as { steps?: Array<Record<string, unknown>> };
  const step = job.steps?.find(candidate => candidate.name === stepName);
  if (typeof step?.run !== "string") throw new Error(`missing run body for ${stepName}`);
  const dir = mkdtempSync(join(tmpdir(), "ompctl-release-lookup-"));
  const stub = join(dir, "bun");
  const output = join(dir, "output");
  writeFileSync(stub, `#!/bin/sh\necho "lookup stub exited ${lookupExit}" >&2\nexit ${lookupExit}\n`, { mode: 0o755 });
  writeFileSync(output, "");
  try {
    const child = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run], {
      cwd: root,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_OUTPUT: output, OMPD_BUILD_NUMBER: "999" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode: await child.exited, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
interface WorkflowStepRun {
  exitCode: number;
  stdout: string;
  calls: number;
  output: string;
}

interface WorkflowStepOptions {
  event?: "push" | "workflow_dispatch";
  headSha?: string;
  headShaAfterFirst?: string;
  earlierRun?: string;
  failAt?: "head" | "list" | "cancel" | "status";
  failedCancelStatus?: string;
  statusChecksBeforeComplete?: number;
}

async function runWorkflowStep(
  jobName: "release-order" | "ios-testflight" | "macos-testflight",
  stepName: string,
  options: WorkflowStepOptions = {},
): Promise<WorkflowStepRun> {
  const job = jobs[jobName] as { steps?: Array<Record<string, unknown>> };
  const step = job.steps?.find(candidate => candidate.name === stepName);
  if (typeof step?.run !== "string") throw new Error(`missing run body for ${stepName}`);
  const dir = mkdtempSync(join(tmpdir(), "ompctl-release-step-"));
  const stub = join(dir, "gh");
  const counter = join(dir, "calls");
  const headCounter = join(dir, "head-calls");
  const statusCounter = join(dir, "status-calls");
  const output = join(dir, "output");
  writeFileSync(counter, "0");
  writeFileSync(headCounter, "0");
  writeFileSync(statusCounter, "0");
  writeFileSync(output, "");
  writeFileSync(
    stub,
    `#!/bin/sh
count_file="${counter}"
n=$(($(cat "$count_file") + 1))
echo "$n" > "$count_file"
case "$*" in
  *"/commits/main"*)
    [ "${options.failAt ?? ""}" = head ] && exit 1
    head_file="${headCounter}"
    head_n=$(($(cat "$head_file") + 1))
    echo "$head_n" > "$head_file"
    if [ "$head_n" -gt 1 ]; then
      echo "${options.headShaAfterFirst ?? options.headSha ?? "current-sha"}"
    else
      echo "${options.headSha ?? "current-sha"}"
    fi
    ;;
  *"actions/workflows"*)
    [ "${options.failAt ?? ""}" = list ] && exit 1
    echo "${options.earlierRun ?? ""}"
    ;;
  *"--method POST"*)
    [ "${options.failAt ?? ""}" = cancel ] && exit 1
    exit 0
    ;;
  *"actions/runs/"*)
    [ "${options.failAt ?? ""}" = status ] && exit 1
    status_file="${statusCounter}"
    status_n=$(($(cat "$status_file") + 1))
    echo "$status_n" > "$status_file"
    if [ "$status_n" -le ${options.statusChecksBeforeComplete ?? 0} ]; then
      echo in_progress
    else
      echo "${options.failedCancelStatus ?? "completed"}"
    fi
    ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    const child = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run], {
      cwd: jobName === "release-order" ? root : join(root, "packages/app"),
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: options.event ?? "push",
        GITHUB_REPOSITORY: "jwaldrip/ompctl",
        GITHUB_RUN_ID: "200",
        GITHUB_SHA: "current-sha",
        GITHUB_OUTPUT: output,
        GH_TOKEN: "test",
        OMPD_CANCEL_POLL_SECONDS: "0",
        OMPD_CANCEL_WAIT_SECONDS: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {
      exitCode: await child.exited,
      stdout,
      calls: Number(readFileSync(counter, "utf8")),
      output: readFileSync(output, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("App Store release workflow", () => {
  test("every main push uploads iOS and macOS while other platforms remain explicit", () => {
    const push = triggers.push as { branches?: string[] };
    expect(push.branches).toEqual(["main"]);
    expect(triggers).not.toHaveProperty("tags");

    expect(normalizeCondition(jobCondition("ios-testflight"))).toBe(
      "needs.release-order.outputs.release == 'true' && (github.event_name == 'push' || contains(github.event.inputs.platforms, 'ios') || github.event.inputs.platforms == 'all')",
    );
    expect(normalizeCondition(jobCondition("macos-testflight"))).toBe(
      "needs.release-order.outputs.release == 'true' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'macos') || github.event.inputs.platforms == 'all')))",
    );
    expect(normalizeCondition(jobCondition("android-play-internal"))).toBe(
      "github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'android') || github.event.inputs.platforms == 'all')",
    );
    expect(normalizeCondition(jobCondition("windows-msix"))).toBe(
      "github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'windows') || github.event.inputs.platforms == 'all')",
    );
  });

  test("rapid main pushes cancel superseded releases without waiting for successful completion", async () => {
    expect(workflow).not.toHaveProperty("concurrency");
    const order = jobs["release-order"] as {
      outputs?: Record<string, unknown>;
      permissions?: Record<string, unknown>;
      steps?: Array<Record<string, unknown>>;
      "timeout-minutes"?: number;
    };
    expect(order["timeout-minutes"]).toBe(5);
    expect(order.permissions).toMatchObject({ actions: "write", contents: "read" });
    expect(order.outputs?.release).toContain("steps.latest.outputs.release");
    expect(order.steps?.[0]?.uses).toBe("actions/checkout@v4");

    const current = await runWorkflowStep("release-order", "Cancel superseded automatic releases");
    expect(current).toMatchObject({ exitCode: 0, calls: 3 });
    expect(current.output).toContain("release=true");
    expect(current.stdout).toContain("is the current main commit");

    const cancelling = await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
      earlierRun: "100",
    });
    expect(cancelling).toMatchObject({ exitCode: 0, calls: 5 });
    expect(cancelling.stdout).toContain("requested cancellation of superseded release run 100");
    expect(cancelling.stdout).toContain("superseded release run 100 stopped");

    expect(
      await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
        earlierRun: "100",
        statusChecksBeforeComplete: 1,
      }),
    ).toMatchObject({ exitCode: 0, calls: 6 });

    const moved = await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
      headShaAfterFirst: "newer-sha",
    });
    expect(moved).toMatchObject({ exitCode: 0, calls: 3 });
    expect(moved.output).toContain("release=false");
    expect(moved.stdout).toContain("lost the main tip during cancellation");

    const stale = await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
      headSha: "newer-sha",
    });
    expect(stale).toMatchObject({ exitCode: 0, calls: 1 });
    expect(stale.output).toContain("release=false");
    expect(stale.stdout).toContain("is superseded by newer-sha");

    const explicit = await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
      event: "workflow_dispatch",
      headSha: "unrelated-tip",
    });
    expect(explicit).toMatchObject({ exitCode: 0, calls: 0 });
    expect(explicit.output).toContain("release=true");

    expect(
      await runWorkflowStep("release-order", "Cancel superseded automatic releases", { failAt: "head" }),
    ).toMatchObject({ exitCode: 1, calls: 1 });
    expect(
      await runWorkflowStep("release-order", "Cancel superseded automatic releases", { failAt: "list" }),
    ).toMatchObject({ exitCode: 1, calls: 2 });
    expect(
      await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
        earlierRun: "100",
        failAt: "cancel",
        failedCancelStatus: "completed",
      }),
    ).toMatchObject({ exitCode: 0, calls: 5 });
    expect(
      await runWorkflowStep("release-order", "Cancel superseded automatic releases", {
        earlierRun: "100",
        failAt: "cancel",
        failedCancelStatus: "in_progress",
      }),
    ).toMatchObject({ exitCode: 1, calls: 4 });
  });

  test("Apple publishing rechecks main after archiving and before tester assignment", async () => {
    const checks = [
      ["ios-testflight", "Recheck current main before iOS upload"],
      ["ios-testflight", "Recheck current main before publishing iOS build"],
      ["macos-testflight", "Recheck current main before macOS upload"],
      ["macos-testflight", "Recheck current main before publishing macOS build"],
    ] as const;
    for (const [job, step] of checks) {
      expect(await runWorkflowStep(job, step)).toMatchObject({ exitCode: 0, calls: 1, output: "release=true\n" });
      expect(await runWorkflowStep(job, step, { headSha: "newer-sha" })).toMatchObject({
        exitCode: 0,
        calls: 1,
        output: "release=false\n",
      });
      expect(await runWorkflowStep(job, step, { event: "workflow_dispatch", headSha: "unrelated-tip" })).toMatchObject({
        exitCode: 0,
        calls: 0,
        output: "release=true\n",
      });
      expect(await runWorkflowStep(job, step, { failAt: "head" })).toMatchObject({ exitCode: 1, calls: 1 });
    }
  });
  test("Apple main-push jobs fail closed if signing or upload credentials are absent", () => {
    for (const name of ["ios-testflight", "macos-testflight"] as const) {
      const job = jobs[name] as {
        env?: Record<string, unknown>;
        steps?: Array<Record<string, unknown>>;
        needs?: string;
        "timeout-minutes"?: number;
      };
      expect(job.needs).toBe("release-order");
      expect(job["timeout-minutes"]).toBe(180);
      expect(job.env?.OMPD_UPLOAD).toContain("github.event_name == 'push'");
      expect(job.env?.OMPD_APP_ID).toContain("OMPD_ASC_APP_ID");
      expect(job.env?.OMPD_BETA_GROUP_ID).toContain("OMPD_ASC_BETA_GROUP_ID");
      const steps = job.steps ?? [];
      const checkout = steps.find(step => step.uses === "actions/checkout@v4");
      expect(checkout?.with).toMatchObject({ "fetch-depth": 0 });
      const selectXcode = steps.find(step => step.name === "Select release Xcode");
      expect(selectXcode?.run).toBe("bash ./scripts/select-release-xcode.sh");
      if (name === "ios-testflight") expect(selectXcode?.env).toMatchObject({ OMPD_REQUIRE_IOS_SDK: "1" });
      const stepNames = steps.map(step => step.name).filter(Boolean);
      expect(stepNames).toContain("Require distribution certificate");
      expect(stepNames.some(step => String(step).includes("Require ASC release configuration"))).toBe(true);
      const ios = name === "ios-testflight";
      const uploadGuardName = ios
        ? "Recheck current main before iOS upload"
        : "Recheck current main before macOS upload";
      const lookupName = ios ? "Check for an existing iOS upload" : "Check for an existing macOS upload";
      const uploadName = ios ? "Upload to TestFlight" : "Upload macOS to App Store Connect / TestFlight";
      const assignGuardName = ios
        ? "Recheck current main before publishing iOS build"
        : "Recheck current main before publishing macOS build";
      const publishName = ios ? "Publish iOS build to internal testers" : "Publish macOS build to internal testers";
      const uploadGuardIndex = steps.findIndex(step => step.name === uploadGuardName);
      const lookupIndex = steps.findIndex(step => step.name === lookupName);
      const uploadIndex = steps.findIndex(step => step.name === uploadName);
      const assignGuardIndex = steps.findIndex(step => step.name === assignGuardName);
      const publishIndex = steps.findIndex(step => step.name === publishName);
      expect(uploadGuardIndex).toBeGreaterThan(-1);
      expect(lookupIndex).toBeGreaterThan(uploadGuardIndex);
      expect(uploadIndex).toBeGreaterThan(lookupIndex);
      expect(assignGuardIndex).toBeGreaterThan(uploadIndex);
      expect(publishIndex).toBeGreaterThan(assignGuardIndex);
      expect(steps[lookupIndex]?.run).toContain(`find-build "$OMPD_BUILD_NUMBER" ${ios ? "IOS" : "MAC_OS"}`);
      expect(steps[lookupIndex]?.run).toContain('if [[ "$status" -ne 3 ]]');
      expect(steps[uploadIndex]?.if).toContain(`steps.${ios ? "ios_build" : "macos_build"}.outputs.exists != 'true'`);
      expect(steps[publishIndex]?.if).toBe(
        `steps.${ios ? "ios_assign_current" : "macos_assign_current"}.outputs.release == 'true' && env.OMPD_ASC_KEY_PATH != ''`,
      );
    }

    const iosJob = jobs["ios-testflight"] as { env?: Record<string, unknown>; steps?: Array<Record<string, unknown>> };
    expect(iosJob.env?.OMPD_IOS_PROFILE_BASE64).toContain("OMPD_IOS_PROFILE_BASE64");
    const iosStepNames = (iosJob.steps ?? []).map(step => step.name).filter(Boolean);
    expect(iosStepNames).toContain("Require iOS provisioning profile");
    expect(iosStepNames).toContain("Import iOS provisioning profile");

    const macos = jobs["macos-testflight"] as {
      env?: Record<string, unknown>;
      steps?: Array<Record<string, unknown>>;
    };
    expect(macos.env?.OMPD_MACOS_PROFILE_BASE64).toContain("OMPD_MACOS_PROFILE_BASE64");
    expect(macos.env?.OMPD_MACOS_INSTALLER_CERT_P12_BASE64).toContain("OMPD_MACOS_INSTALLER_CERT_P12_BASE64");
    expect(macos.env?.OMPD_MACOS_INSTALLER_CERT_P12_PASSWORD).toContain("OMPD_MACOS_INSTALLER_CERT_P12_PASSWORD");
    const macosSteps = macos.steps ?? [];
    const macosStepNames = macosSteps.map(step => step.name).filter(Boolean);
    expect(macosStepNames).toContain("Require macOS signing material");
    expect(macosStepNames).toContain("Import macOS provisioning profile");
    expect(macosStepNames).toContain("Install macOS pods");
    const macosUpload = macosSteps.find(step => step.name === "Upload macOS to App Store Connect / TestFlight");
    expect(macosUpload?.run).toContain("No signed macOS pkg export found to upload");
    expect(macosUpload?.run).not.toContain("ditto");
  });

  test("upload lookup distinguishes present, missing, and unread remote state", async () => {
    for (const stepName of ["Check for an existing iOS upload", "Check for an existing macOS upload"]) {
      expect(await runLookupStep(stepName, 0)).toEqual({ exitCode: 0, output: "exists=true\n" });
      expect(await runLookupStep(stepName, 3)).toEqual({ exitCode: 0, output: "exists=false\n" });
      expect(await runLookupStep(stepName, 1)).toEqual({ exitCode: 1, output: "" });
    }
  });
});
