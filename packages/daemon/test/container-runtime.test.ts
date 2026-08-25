/**
 * Runtime selection, and what a specific runtime build can confine.
 *
 * Two shipped regressions are written down here so they fail loudly if they
 * come back.
 *
 * 1. Selection walked a fixed docker-first list and took whatever answered
 *    `--version`, so a Mac with OrbStack installed never chose Apple's
 *    `container` even with it installed and its apiserver up. Order is per
 *    platform now, and a pinned runtime is probed alone and never falls back:
 *    an operator who pinned the native runtime and quietly got docker lost the
 *    thing they asked for with nothing in the logs to say so.
 * 2. Capability was keyed on the runtime's NAME. `container` 0.4.1 and upstream
 *    1.3.0 are two different CLIs behind one name, so a name-keyed table keeps
 *    withholding `--cap-drop` and `--read-only` from an operator who upgraded,
 *    and prints nothing while doing it. Capability comes from the binary's own
 *    `run --help`, and the 1.3.0 case below is what proves it: a newer help
 *    text yields the newer confinement with no code change here.
 *
 * Every help text is loaded from `fixtures/runtime-help/` rather than inlined,
 * so the parser is held to what those binaries actually printed. Three were
 * captured live on this machine (docker 29.4.0, podman 4.8.2, `container`
 * 0.4.1). The fourth is generated from apple/container's own
 * `docs/command-reference.md` at tag 1.3.0, and its filename says so: it is a
 * documentation claim about a build nobody here has run, which is why nothing
 * but the parser's version-forwardness rests on it.
 *
 * No container runtime is executed. `CommandRunner` is a stub that records
 * argv, which is also how the negative half of "a pinned runtime never falls
 * back" is proved: the second runtime is never spawned at all.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capabilityFromHelp,
  DARWIN_RUNTIME_ORDER,
  KNOWN_RUNTIMES,
  LINUX_RUNTIME_ORDER,
  probeRuntime,
  type RuntimeCapability,
  type RuntimeUnavailable,
  runtimeOrder,
  selectRuntime,
} from "../src/provisioner/runtime.ts";
import { type CommandRunner, ProvisionError } from "../src/provisioner/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const HELP_DIR = join(import.meta.dir, "fixtures", "runtime-help");

function helpFixture(name: string): string {
  return readFileSync(join(HELP_DIR, `${name}.txt`), "utf8");
}

/** Narrow, and fail with the unavailability instead of a cryptic undefined. */
function capability(probed: RuntimeCapability | RuntimeUnavailable): RuntimeCapability {
  if ("reason" in probed) throw new Error(`expected a capability, got ${probed.reason}: ${probed.hint}`);
  return probed;
}

/** Narrow the other way, so a silent all-false capability cannot pass as one. */
function unavailable(probed: RuntimeCapability | RuntimeUnavailable): RuntimeUnavailable {
  if (!("reason" in probed)) throw new Error(`expected an unavailability, got a capability for ${probed.runtime}`);
  return probed;
}

interface FakeRuntime {
  /** Omitted means not on PATH, so the runner throws like `Bun.spawn` does. */
  version?: string;
  /** Liveness exit code. */
  code?: number;
  /** Liveness stdout. Defaults to what a healthy `container system status` prints. */
  status?: string;
  /** `run --help` output. */
  help?: string;
}

interface Fake {
  run: CommandRunner;
  /** Every argv the code under test spawned, in order. */
  argv: string[][];
}

function fakeRunner(runtimes: Record<string, FakeRuntime>): Fake {
  const argv: string[][] = [];
  const run: CommandRunner = async command => {
    argv.push(command);
    const runtime = command[0] ?? "";
    const fake = runtimes[runtime];
    if (fake?.version === undefined) {
      // What `execCommand` does for a binary that is not there.
      throw new ProvisionError(`${runtime} could not be started: ENOENT`);
    }
    if (command[1] === "--version") return { code: 0, stdout: fake.version, stderr: "" };
    if (command[1] === "run") return { code: 0, stdout: fake.help ?? helpFixture("docker-29.4.0"), stderr: "" };
    return { code: fake.code ?? 0, stdout: fake.status ?? "apiserver is running", stderr: "" };
  };
  return { run, argv };
}

const HEALTHY_DOCKER: FakeRuntime = { version: "Docker version 29.4.0, build 9d7ad9f" };
const HEALTHY_PODMAN: FakeRuntime = { version: "podman version 4.8.2", help: helpFixture("podman-4.8.2") };
const HEALTHY_APPLE: FakeRuntime = {
  version: "container CLI version 0.4.1 (build: release, commit: 4ac18b5)",
  help: helpFixture("apple-container-0.4.1"),
};

/** An option list that is a container CLI, with `extra` spliced in. */
function synthHelp(...extra: string[]): string {
  return ["OPTIONS:", ...extra, "  -v, --volume <volume>   Bind mount a volume into the container"].join("\n");
}

// ---------------------------------------------------------------------------
// capabilityFromHelp, against help text those binaries really printed
// ---------------------------------------------------------------------------

describe("capabilityFromHelp on captured fixtures", () => {
  test("docker 29.4.0 declares every confinement flag ompd asks for", () => {
    expect(capability(capabilityFromHelp("docker", "29.4.0", helpFixture("docker-29.4.0")))).toEqual({
      runtime: "docker",
      version: "29.4.0",
      capDrop: true,
      securityOpt: true,
      readOnly: true,
      pidsLimit: true,
      numericUser: true,
      networks: true,
      memoryLimit: true,
      cpuLimit: true,
      tmpfsOptions: true,
      networkNone: true,
    });
  });

  test("podman 4.8.2 is a drop-in for docker's shape", () => {
    expect(capability(capabilityFromHelp("podman", "4.8.2", helpFixture("podman-4.8.2")))).toEqual({
      runtime: "podman",
      version: "4.8.2",
      capDrop: true,
      securityOpt: true,
      readOnly: true,
      pidsLimit: true,
      numericUser: true,
      networks: true,
      memoryLimit: true,
      cpuLimit: true,
      tmpfsOptions: true,
      networkNone: true,
    });
  });

  test("container 0.4.1 has none of the four, and a --user that takes no uid", () => {
    // Verified against the binary: each of those four exits 64 with
    // `Error: Unknown option '<flag>'`, and `--user 501:20` crashes it with
    // `XPC connection error: Connection interrupted`. Networks, memory, and
    // cpus are real: `--memory 512M --cpus 2` gave a guest reporting nproc 2
    // and 490 MB total.
    expect(capability(capabilityFromHelp("container", "0.4.1", helpFixture("apple-container-0.4.1")))).toEqual({
      runtime: "container",
      version: "0.4.1",
      capDrop: false,
      securityOpt: false,
      readOnly: false,
      pidsLimit: false,
      numericUser: false,
      networks: true,
      memoryLimit: true,
      cpuLimit: true,
      tmpfsOptions: true,
      networkNone: true,
    });
  });

  test("container 1.3.0 gains real confinement with no code change here", () => {
    // The whole reason capability is parsed and not keyed on the runtime name.
    // This fixture is derived from apple/container's docs/command-reference.md
    // at tag 1.3.0, not captured from a binary, and is named to say so. 1.3.0
    // adds --cap-drop, --read-only, --read-only-path, --masked-path, and
    // --ulimit, documents --user as `format: name|uid[:gid]`, and still has
    // neither --security-opt nor --pids-limit.
    expect(
      capability(
        capabilityFromHelp("container", "1.3.0", helpFixture("apple-container-1.3.0-derived-from-upstream-docs")),
      ),
    ).toEqual({
      runtime: "container",
      version: "1.3.0",
      capDrop: true,
      securityOpt: false,
      readOnly: true,
      pidsLimit: false,
      numericUser: true,
      networks: true,
      memoryLimit: true,
      cpuLimit: true,
      tmpfsOptions: true,
      networkNone: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Exact declared tokens, not substrings
// ---------------------------------------------------------------------------

describe("capabilityFromHelp matches declared flags exactly", () => {
  test("--read-only-path and --read-only-tmpfs do not claim a read-only rootfs", () => {
    // Both are real: 1.3.0 has the first, podman has the second. Substring
    // matching would tell the provisioner it may send --read-only, and the run
    // would die on an unknown flag or, worse, look confined and not be.
    const path = capability(capabilityFromHelp("container", "1.3.0", synthHelp("  --read-only-path <path>  Mark it")));
    expect(path.readOnly).toBe(false);

    const tmpfs = capability(capabilityFromHelp("podman", "4.8.2", synthHelp("      --read-only-tmpfs   Mount rw")));
    expect(tmpfs.readOnly).toBe(false);
  });

  test("--memory-swap does not stand in for --memory", () => {
    const cap = capability(capabilityFromHelp("docker", "29.4.0", synthHelp("      --memory-swap bytes   Swap limit")));
    expect(cap.memoryLimit).toBe(false);
    expect(cap.cpuLimit).toBe(false);
  });

  test("a separate --uid option does not make --user numeric", () => {
    // container 0.4.1's exact trap. A whole-text search for "uid" says yes for
    // a CLI whose --user takes a name and whose --uid crashes the runtime.
    const cap = capability(
      capabilityFromHelp(
        "container",
        "0.4.1",
        synthHelp("  --uid <uid>             Set the uid for the process", "  -u, --user <user>       Set the user"),
      ),
    );
    expect(cap.numericUser).toBe(false);
  });

  test("a description that mentions a flag does not declare it", () => {
    const cap = capability(
      capabilityFromHelp("docker", "29.4.0", synthHelp("      --tmpfs list   Ignored when --read-only is set")),
    );
    expect(cap.readOnly).toBe(false);
  });

  test("a wrapped description is read as part of its own option", () => {
    // docker wraps --user onto a second line, and podman does not. The uid here
    // is only on the continuation, so joining is what finds it.
    const cap = capability(
      capabilityFromHelp(
        "docker",
        "29.4.0",
        synthHelp("  -u, --user string        Username or group (format:", "                           <name|uid>)"),
      ),
    );
    expect(cap.numericUser).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fail closed
// ---------------------------------------------------------------------------

describe("capabilityFromHelp refuses rather than reporting nothing", () => {
  test("empty help is unverifiable, not a runtime that confines nothing", () => {
    // The distinction this test defends: an all-false capability tells the
    // provisioner to run with no confinement flags, which is exactly what a
    // real Apple 0.4.1 needs, so it cannot also be what an unreadable help
    // text produces.
    const probed = unavailable(capabilityFromHelp("docker", "29.4.0", ""));
    expect(probed.reason).toBe("unverifiable");
    expect(probed.hint).toContain("run --help");
  });

  test("prose with no option list is unverifiable", () => {
    const probed = unavailable(capabilityFromHelp("docker", "29.4.0", "Cannot connect to the Docker daemon.\n"));
    expect(probed.reason).toBe("unverifiable");
  });

  test("an option list with neither --volume nor --network is not a container CLI", () => {
    // What `orbctl run --help` looks like: real options, none of them a
    // container's. Guessing which of its flags confine anything is how a
    // command that looks like a container and is not one gets built.
    const probed = unavailable(
      capabilityFromHelp("docker", "29.4.0", ["OPTIONS:", "  -m, --machine <machine>   Machine"].join("\n")),
    );
    expect(probed.reason).toBe("unverifiable");
    expect(probed.hint).toContain("--volume");
  });
});

// ---------------------------------------------------------------------------
// probeRuntime
// ---------------------------------------------------------------------------

describe("probeRuntime", () => {
  test("a missing binary is absent, with somewhere to get it", async () => {
    const fake = fakeRunner({});
    const probed = unavailable(await probeRuntime("container", fake.run));
    expect(probed.reason).toBe("absent");
    expect(probed.hint).toContain("https://github.com/apple/container/releases");
    // Nothing else was tried: there is no binary to ask.
    expect(fake.argv).toEqual([["container", "--version"]]);
  });

  test("an installed runtime whose service is down is not absent", async () => {
    // The two an operator confuses, and they need opposite actions.
    const fake = fakeRunner({ container: { ...HEALTHY_APPLE, status: "apiserver is not running" } });
    const probed = unavailable(await probeRuntime("container", fake.run));
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("container system start");
    expect(probed.hint).not.toContain("releases");
    expect(fake.argv).toEqual([
      ["container", "--version"],
      ["container", "system", "status"],
    ]);
  });

  test("docker's daemon being down is reported from its exit code", async () => {
    const fake = fakeRunner({ docker: { ...HEALTHY_DOCKER, code: 1 } });
    const probed = unavailable(await probeRuntime("docker", fake.run));
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("docker daemon is not running");
  });

  test("podman's info failing is reported with the machine hint", async () => {
    const fake = fakeRunner({ podman: { ...HEALTHY_PODMAN, code: 125 } });
    const probed = unavailable(await probeRuntime("podman", fake.run));
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("podman machine start");
  });

  test("the version is the build that was probed, not the whole line", async () => {
    const fake = fakeRunner({ container: HEALTHY_APPLE });
    expect(capability(await probeRuntime("container", fake.run)).version).toBe("0.4.1");
    expect(fake.argv.at(-1)).toEqual(["container", "run", "--help"]);
  });

  test("tmpfsOptions is overridden from the table, against what the help implies", async () => {
    // 0.4.1 accepts `--tmpfs /scratch:rw,exec,...`, exits 0, and mounts
    // nothing. No help text can express that, so the pure parse says true for
    // everyone and the probe corrects the one runtime where it is a lie.
    const help = helpFixture("apple-container-0.4.1");
    expect(capability(capabilityFromHelp("container", "0.4.1", help)).tmpfsOptions).toBe(true);

    const fake = fakeRunner({ container: HEALTHY_APPLE });
    expect(capability(await probeRuntime("container", fake.run)).tmpfsOptions).toBe(false);
  });

  test("docker keeps tmpfsOptions, which it needs for exec, size, and mode", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    expect(capability(await probeRuntime("docker", fake.run)).tmpfsOptions).toBe(true);
  });

  test("networkNone is overridden from the table too, for the same reason", async () => {
    // Apple `container` declares `--network`, so a help parse says it can
    // isolate. It cannot express "no network at all": `--network none` gives
    // `notFound: "network none not found"`, every network it creates is
    // `mode: nat`, and `--no-dns` only deletes `/etc/resolv.conf` (verified:
    // `ping 1.1.1.1` still succeeds under it). A provider that believed the
    // parse would approximate a no-network policy with a flag that does not
    // deny anything.
    const help = helpFixture("apple-container-0.4.1");
    expect(capability(capabilityFromHelp("container", "0.4.1", help)).networkNone).toBe(true);

    const apple = fakeRunner({ container: HEALTHY_APPLE });
    expect(capability(await probeRuntime("container", apple.run)).networkNone).toBe(false);

    const docker = fakeRunner({ docker: HEALTHY_DOCKER });
    expect(capability(await probeRuntime("docker", docker.run)).networkNone).toBe(true);
  });

  test("an unknown runtime name is a bug, not a probe miss", async () => {
    const fake = fakeRunner({ orbctl: { version: "orbctl 1.0" } });
    await expect(probeRuntime("orbctl", fake.run)).rejects.toThrow(ProvisionError);
    // Returning `absent` would read as "install orbctl" for a name ompd has no
    // liveness check and no install advice for.
    expect(fake.argv).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Order and pinning
// ---------------------------------------------------------------------------

describe("runtimeOrder", () => {
  test("darwin prefers the native runtime, linux has no such thing", () => {
    expect(DARWIN_RUNTIME_ORDER).toEqual(["container", "podman", "docker"]);
    expect(LINUX_RUNTIME_ORDER).toEqual(["podman", "docker"]);
    expect(runtimeOrder("darwin")).toEqual(DARWIN_RUNTIME_ORDER);
    expect(runtimeOrder("linux")).toEqual(LINUX_RUNTIME_ORDER);
    expect(runtimeOrder("win32")).toEqual([]);
    expect([...KNOWN_RUNTIMES].sort()).toEqual(["container", "docker", "podman"]);
  });
});

describe("selectRuntime", () => {
  test("darwin takes container over docker when both answer", async () => {
    // The original defect: docker was first in one fixed list, so OrbStack won
    // every time and Apple's runtime was never selected on any Mac that had
    // both.
    const fake = fakeRunner({ container: HEALTHY_APPLE, docker: HEALTHY_DOCKER });
    const chosen = await selectRuntime({ run: fake.run, platform: "darwin" });
    expect(chosen.runtime).toBe("container");
    expect(fake.argv.some(command => command[0] === "docker")).toBe(false);
  });

  test("darwin falls through to docker when the native runtime is not installed", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    expect((await selectRuntime({ run: fake.run, platform: "darwin" })).runtime).toBe("docker");
  });

  test("linux prefers podman, which needs no root daemon", async () => {
    const fake = fakeRunner({ podman: HEALTHY_PODMAN, docker: HEALTHY_DOCKER });
    const chosen = await selectRuntime({ run: fake.run, platform: "linux" });
    expect(chosen.runtime).toBe("podman");
    expect(chosen.capDrop).toBe(true);
    expect(fake.argv.some(command => command[0] === "docker")).toBe(false);
  });

  test("a pinned runtime that is absent throws and never probes another", async () => {
    // The point of pinning. Falling back to docker here would silently undo an
    // operator's explicit choice of the native runtime.
    const fake = fakeRunner({ docker: HEALTHY_DOCKER, podman: HEALTHY_PODMAN });
    await expect(selectRuntime({ run: fake.run, platform: "darwin", pinned: "container" })).rejects.toThrow(
      /pinned container runtime container is unusable \(absent\)/,
    );
    expect(fake.argv).toEqual([["container", "--version"]]);
  });

  test("a pinned runtime whose service is down says so, and still does not fall back", async () => {
    const fake = fakeRunner({
      container: { ...HEALTHY_APPLE, status: "apiserver is not running" },
      docker: HEALTHY_DOCKER,
    });
    await expect(selectRuntime({ run: fake.run, platform: "darwin", pinned: "container" })).rejects.toThrow(
      /service-down.*container system start/s,
    );
    expect(fake.argv.some(command => command[0] === "docker")).toBe(false);
  });

  test("a pinned name ompd does not know names the ones it does, before spawning", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    await expect(selectRuntime({ run: fake.run, platform: "darwin", pinned: "orbctl" })).rejects.toThrow(
      /valid runtimes are container, podman, docker/,
    );
    expect(fake.argv).toEqual([]);
  });

  test("with none usable, the failure separates not-installed from not-running", async () => {
    // "No container runtime found" sends an operator hunting for an install
    // when what they actually have is a daemon to start.
    const fake = fakeRunner({ docker: { ...HEALTHY_DOCKER, code: 1 } });
    const failure = await selectRuntime({ run: fake.run, platform: "darwin" }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProvisionError);
    const message = String(failure);
    expect(message).toContain("container (absent)");
    expect(message).toContain("podman (absent)");
    expect(message).toContain("docker (service-down)");
    expect(message).toContain("start Docker Desktop");
  });

  test("an unsupported platform is named, not reported as an empty search", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    await expect(selectRuntime({ run: fake.run, platform: "win32" })).rejects.toThrow(
      /no container runtime is available on platform win32/,
    );
    expect(fake.argv).toEqual([]);
  });
});
