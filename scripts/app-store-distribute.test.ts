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
interface OrderRun {
  exitCode: number;
  stdout: string;
  calls: number;
}

async function runOrderStep(ref: string, earlier: boolean, fail: boolean): Promise<OrderRun> {
  const order = jobs["release-order"] as { steps?: Array<Record<string, unknown>> };
  const step = order.steps?.find(candidate => candidate.name === "Wait for earlier main releases");
  if (typeof step?.run !== "string") throw new Error("missing release ordering run body");
  const dir = mkdtempSync(join(tmpdir(), "ompctl-release-order-"));
  const stub = join(dir, "gh");
  const counter = join(dir, "calls");
  writeFileSync(counter, "0");
  writeFileSync(
    stub,
    `#!/bin/sh
count_file="${counter}"
n=$(($(cat "$count_file") + 1))
echo "$n" > "$count_file"
if [ ${fail ? 1 : 0} -eq 1 ]; then
  echo "api unavailable" >&2
  exit 1
fi
if [ ${earlier ? 1 : 0} -eq 1 ] && [ "$n" -eq 1 ]; then
  echo 100
fi
`,
    { mode: 0o755 },
  );
  try {
    const child = Bun.spawn(["/bin/bash", "-e", "-o", "pipefail", "-c", step.run.replace("sleep 15", "sleep 0")], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GITHUB_REF: ref,
        GITHUB_REPOSITORY: "jwaldrip/ompctl",
        GITHUB_RUN_ID: "200",
        GH_TOKEN: "test",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { exitCode: await child.exited, stdout, calls: Number(readFileSync(counter, "utf8")) };
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
      "github.event_name == 'push' || contains(github.event.inputs.platforms, 'ios') || github.event.inputs.platforms == 'all'",
    );
    expect(normalizeCondition(jobCondition("macos-testflight"))).toBe(
      "github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'macos') || github.event.inputs.platforms == 'all'))",
    );
    expect(normalizeCondition(jobCondition("android-play-internal"))).toBe(
      "github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'android') || github.event.inputs.platforms == 'all')",
    );
    expect(normalizeCondition(jobCondition("windows-msix"))).toBe(
      "github.event_name == 'workflow_dispatch' && (contains(github.event.inputs.platforms, 'windows') || github.event.inputs.platforms == 'all')",
    );
  });

  test("rapid main pushes cannot replace a pending release", () => {
    expect(workflow).not.toHaveProperty("concurrency");
  });

  test("main release ordering waits, passes non-main runs, and fails closed", async () => {
    const order = jobs["release-order"] as {
      permissions?: Record<string, unknown>;
      steps?: Array<Record<string, unknown>>;
      "timeout-minutes"?: number;
    };
    expect(order["timeout-minutes"]).toBe(180);
    expect(order.permissions).toMatchObject({ actions: "read", contents: "read" });
    const wait = order.steps?.find(step => step.name === "Wait for earlier main releases");
    expect(wait?.run).toContain("gh api --paginate");
    expect(wait?.run).toContain(".id < $GITHUB_RUN_ID");
    expect(wait?.run).toContain(".status !=");
    expect(wait?.run).toContain("completed");

    const queued = await runOrderStep("refs/heads/main", true, false);
    expect(queued.exitCode).toBe(0);
    expect(queued.calls).toBe(2);
    expect(queued.stdout).toContain("waiting for earlier release runs: 100");
    expect(queued.stdout).toContain("earlier main releases complete");

    expect(await runOrderStep("refs/heads/feature", true, false)).toMatchObject({ exitCode: 0, calls: 0 });
    expect(await runOrderStep("refs/heads/main", false, true)).toMatchObject({ exitCode: 1, calls: 1 });
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
      const selectXcode = steps.find(step => step.name === "Select Xcode 16+");
      expect(String(selectXcode?.run).trimStart().startsWith("sudo xcode-select -s /Applications/Xcode_16.4.app")).toBe(
        true,
      );
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
