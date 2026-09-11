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
interface SelectionRun {
  calls: number;
  exitCode: number;
  output: string;
}

async function runSelectionStep(
  event: "push" | "workflow_dispatch",
  headSha: string,
  fail = false,
  runAttempt = "1",
): Promise<SelectionRun> {
  const job = jobs["release-current"] as { steps?: Array<Record<string, unknown>> };
  const step = job.steps?.find(candidate => candidate.name === "Check main head");
  if (typeof step?.run !== "string") throw new Error("missing current-release selection step");
  const dir = mkdtempSync(join(tmpdir(), "ompctl-release-current-"));
  const stub = join(dir, "gh");
  const counter = join(dir, "calls");
  const output = join(dir, "output");
  writeFileSync(counter, "0");
  writeFileSync(output, "");
  writeFileSync(
    stub,
    `#!/bin/sh
echo $(($(cat "${counter}") + 1)) > "${counter}"
${fail ? "exit 1" : `echo "${headSha}"`}
`,
    { mode: 0o755 },
  );
  try {
    const child = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_EVENT_NAME: event,
        GITHUB_REPOSITORY: "jwaldrip/ompctl",
        GITHUB_RUN_ATTEMPT: runAttempt,
        GITHUB_SHA: "current-sha",
        GITHUB_OUTPUT: output,
        GH_TOKEN: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return {
      calls: Number(readFileSync(counter, "utf8")),
      exitCode: await child.exited,
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
      "needs.release-current.outputs.release == 'true' && (github.event_name == 'push' || contains(github.event.inputs.platforms, 'ios') || github.event.inputs.platforms == 'all')",
    );
    expect(normalizeCondition(jobCondition("macos-testflight"))).toBe(
      "needs.release-current.outputs.release == 'true' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'macos') || github.event.inputs.platforms == 'all')))",
    );
    expect(normalizeCondition(jobCondition("android-play-internal"))).toBe(
      "github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'android') || github.event.inputs.platforms == 'all')",
    );
    expect(normalizeCondition(jobCondition("windows-msix"))).toBe(
      "github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'windows') || github.event.inputs.platforms == 'all')",
    );
  });

  test("first-attempt pushes coalesce while reruns and manual dispatches stay independent", async () => {
    const concurrency = workflow.concurrency as { group?: string; queue?: string; "cancel-in-progress"?: boolean };
    expect(concurrency).toEqual({
      group: `app-store-distribute-\${{ github.event_name == 'push' && github.run_attempt == 1 && github.ref || github.run_id }}`,
    });
    expect(concurrency).not.toHaveProperty("queue");
    expect(concurrency).not.toHaveProperty("cancel-in-progress");

    const selector = jobs["release-current"] as {
      outputs?: Record<string, unknown>;
      permissions?: Record<string, unknown>;
      "timeout-minutes"?: number;
    };
    expect(selector["timeout-minutes"]).toBe(5);
    expect(selector.permissions).toMatchObject({ contents: "read" });
    expect(selector.outputs?.release).toContain("steps.current.outputs.release");
    expect(await runSelectionStep("push", "current-sha")).toEqual({ calls: 1, exitCode: 0, output: "release=true\n" });
    expect(await runSelectionStep("push", "newer-sha")).toEqual({ calls: 1, exitCode: 0, output: "release=false\n" });
    expect(await runSelectionStep("push", "current-sha", false, "2")).toEqual({
      calls: 0,
      exitCode: 0,
      output: "release=false\n",
    });
    expect(await runSelectionStep("workflow_dispatch", "unrelated-sha", false, "2")).toEqual({
      calls: 0,
      exitCode: 0,
      output: "release=true\n",
    });
    expect(await runSelectionStep("push", "unused", true)).toMatchObject({ calls: 1, exitCode: 1 });

    for (const name of ["ios-testflight", "macos-testflight"] as const) {
      const job = jobs[name] as { concurrency?: unknown; needs?: string };
      expect(job.needs).toBe("release-current");
      expect(job).not.toHaveProperty("concurrency");
    }
  });
  test("Apple main-push jobs fail closed if signing or upload credentials are absent", () => {
    for (const name of ["ios-testflight", "macos-testflight"] as const) {
      const job = jobs[name] as {
        env?: Record<string, unknown>;
        needs?: string;
        steps?: Array<Record<string, unknown>>;
        "timeout-minutes"?: number;
      };
      expect(job.needs).toBe("release-current");
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
      const lookupName = ios ? "Check for an existing iOS upload" : "Check for an existing macOS upload";
      const uploadName = ios ? "Upload to TestFlight" : "Upload macOS to App Store Connect / TestFlight";
      const publishName = ios ? "Publish iOS build to internal testers" : "Publish macOS build to internal testers";
      const lookupIndex = steps.findIndex(step => step.name === lookupName);
      const uploadIndex = steps.findIndex(step => step.name === uploadName);
      const publishIndex = steps.findIndex(step => step.name === publishName);
      expect(lookupIndex).toBeGreaterThan(-1);
      expect(uploadIndex).toBeGreaterThan(lookupIndex);
      expect(publishIndex).toBeGreaterThan(uploadIndex);
      expect(steps[lookupIndex]?.run).toContain(`find-build "$OMPD_BUILD_NUMBER" ${ios ? "IOS" : "MAC_OS"}`);
      expect(steps[lookupIndex]?.run).toContain('if [[ "$status" -ne 3 ]]');
      expect(steps[uploadIndex]?.if).toContain(`steps.${ios ? "ios_build" : "macos_build"}.outputs.exists != 'true'`);
      expect(steps[publishIndex]?.if).toBe("env.OMPD_UPLOAD == 'true' && env.OMPD_ASC_KEY_PATH != ''");
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
