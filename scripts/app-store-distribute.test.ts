import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

  test("Apple main-push jobs fail closed if signing or upload credentials are absent", () => {
    for (const name of ["ios-testflight", "macos-testflight"] as const) {
      const job = jobs[name] as {
        env?: Record<string, unknown>;
        steps?: Array<Record<string, unknown>>;
        "timeout-minutes"?: number;
      };
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
      const uploadName =
        name === "ios-testflight" ? "Upload to TestFlight" : "Upload macOS to App Store Connect / TestFlight";
      const publishName =
        name === "ios-testflight" ? "Publish iOS build to internal testers" : "Publish macOS build to internal testers";
      const uploadIndex = steps.findIndex(step => step.name === uploadName);
      const publishIndex = steps.findIndex(step => step.name === publishName);
      expect(uploadIndex).toBeGreaterThan(-1);
      expect(publishIndex).toBeGreaterThan(uploadIndex);
      expect(steps[publishIndex]?.if).toBe("env.OMPD_UPLOAD == 'true' && env.OMPD_ASC_KEY_PATH != ''");
    }

    const macos = jobs["macos-testflight"] as {
      env?: Record<string, unknown>;
      steps?: Array<Record<string, unknown>>;
    };
    expect(macos.env?.OMPD_MACOS_PROFILE_BASE64).toContain("OMPD_MACOS_PROFILE_BASE64");
    expect(macos.env?.OMPD_MACOS_INSTALLER_CERT_P12_BASE64).toContain("OMPD_MACOS_INSTALLER_CERT_P12_BASE64");
    expect(macos.env?.OMPD_MACOS_INSTALLER_CERT_P12_PASSWORD).toContain("OMPD_MACOS_INSTALLER_CERT_P12_PASSWORD");
    const macosStepNames = (macos.steps ?? []).map(step => step.name).filter(Boolean);
    expect(macosStepNames).toContain("Require macOS signing material");
    expect(macosStepNames).toContain("Import macOS provisioning profile");
    expect(macosStepNames).toContain("Install macOS pods");
  });
});
