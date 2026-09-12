import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandRunner,
  ContainerBackend,
  type ResolvedToolchain,
  type RuntimeCapability,
} from "../src/provisioner/index.ts";

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function scratchDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

const DOCKER_CAP: RuntimeCapability = {
  runtime: "docker",
  version: "Docker version 29.4.0",
  capDrop: true,
  securityOpt: true,
  readOnly: true,
  pidsLimit: true,
  numericUser: true,
  networks: true,
  tmpfsOptions: true,
  networkNone: true,
  memoryLimit: true,
  cpuLimit: true,
};

const stubToolchain = async (): Promise<ResolvedToolchain> => ({
  image: "debian:bookworm-slim",
  source: "default",
  toolsDir: null,
  mountPath: "/opt/ompd",
  ompPath: "omp",
  env: {},
  ompSha256: null,
  caSha256: null,
  cached: true,
});

function fakeRunner(containerId = "cnt-mounts-001") {
  const calls: string[][] = [];
  const run: CommandRunner = argv => {
    calls.push(argv);
    const cmd = argv[1];
    if (cmd === "run") return Promise.resolve({ code: 0, stdout: `${containerId}\n`, stderr: "" });
    if (cmd === "network" && argv[2] === "create") return Promise.resolve({ code: 0, stdout: "net-01\n", stderr: "" });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { run, calls };
}

describe("container mount truth", () => {
  test("a ContainerBackend constructed with a workspace, given a bound-subdirectory spec, does not mount the wider workspace", async () => {
    const repo = scratchDir("repo-");
    const sub = join(repo, "packages", "app");
    mkdirSync(sub, { recursive: true });

    const runner = fakeRunner();
    const backend = new ContainerBackend({
      capability: DOCKER_CAP,
      workspace: repo,
      run: runner.run,
      toolchain: stubToolchain,
    });

    const handle = await backend.provision({
      kind: "container",
      mounts: [{ hostPath: sub, mode: "ro" }],
    });

    const runCall = runner.calls.find(argv => argv[1] === "run");
    expect(runCall).toBeDefined();
    const run = runCall!;

    // Must contain the bound subdirectory mount
    expect(run).toContain(`${sub}:${sub}:ro`);

    // Must NOT contain the wider repo mount, either with or without mode suffix
    expect(run).not.toContain(`${repo}:${repo}`);
    expect(run).not.toContain(`${repo}:${repo}:rw`);
    expect(run).not.toContain(`${repo}:${repo}:ro`);

    // The working directory must be the bound subdirectory, not the wider repo
    const workdirIndex = run.indexOf("--workdir");
    expect(workdirIndex).toBeGreaterThanOrEqual(0);
    expect(run[workdirIndex + 1]).toBe(sub);

    // HostRef.spec.mounts must accurately reflect the bound subdirectory
    expect(handle.ref.spec.mounts).toEqual([{ hostPath: sub, mode: "ro" }]);
  });

  test("HostRef.spec.mounts records what the container actually mounts, matching argv", async () => {
    const repo = scratchDir("ws-implicit-");
    const runner = fakeRunner();
    const backend = new ContainerBackend({
      capability: DOCKER_CAP,
      workspace: repo,
      run: runner.run,
      toolchain: stubToolchain,
    });

    const handle = await backend.provision({
      kind: "container",
    });

    const runCall = runner.calls.find(argv => argv[1] === "run");
    expect(runCall).toBeDefined();
    const run = runCall!;

    // Argv mounted the implicit workspace
    expect(run).toContain(`${repo}:${repo}`);

    // HostRef.spec.mounts must record the mounted workspace so it does not drift from argv
    expect(handle.ref.spec.mounts).toBeDefined();
    expect(handle.ref.spec.mounts).toEqual([{ hostPath: repo, mode: "rw" }]);
  });
});
