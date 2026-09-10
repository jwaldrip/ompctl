import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, ".github/workflows/app-store-distribute.yml"), "utf8");
const workflow = Bun.YAML.parse(source) as Record<string, unknown>;

const triggers = workflow.on as Record<string, unknown>;
const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
const concurrency = workflow.concurrency as Record<string, unknown>;

function jobCondition(name: string): string {
  const condition = jobs[name]?.if;
  if (typeof condition !== "string") throw new Error(`${name} has no job condition`);
  return condition;
}

describe("App Store release workflow", () => {
  test("every main push uploads iOS and macOS while other platforms remain explicit", () => {
    const push = triggers.push as { branches?: string[] };
    expect(push.branches).toEqual(["main"]);
    expect(triggers).not.toHaveProperty("tags");

    const ios = jobCondition("ios-testflight");
    const macos = jobCondition("macos-testflight");
    const android = jobCondition("android-play-internal");
    const windows = jobCondition("windows-msix");

    expect(ios).toContain("github.event_name == 'push'");
    expect(macos).toContain("github.event_name == 'push'");
    expect(android).not.toContain("github.event_name == 'push'");
    expect(windows).not.toContain("github.event_name == 'push'");
  });

  test("main releases are serialized and never cancelled by a newer merge", () => {
    expect(concurrency.group).toContain("github.ref");
    expect(concurrency["cancel-in-progress"]).toBe(false);
  });

  test("Apple main-push jobs fail closed if signing or upload credentials are absent", () => {
    for (const name of ["ios-testflight", "macos-testflight"] as const) {
      const job = jobs[name] as { env?: Record<string, unknown>; steps?: Array<Record<string, unknown>> };
      expect(job.env?.OMPD_UPLOAD).toContain("github.event_name == 'push'");
      const stepNames = (job.steps ?? []).map(step => step.name).filter(Boolean);
      expect(stepNames).toContain("Require distribution certificate");
      expect(stepNames.some(step => String(step).includes("Require ASC secrets"))).toBe(true);
    }
  });
});
