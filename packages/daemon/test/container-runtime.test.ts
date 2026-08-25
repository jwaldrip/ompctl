/**
 * Runtime selection, and what a specific runtime build can confine.
 *
 * Four shipped regressions are written down here so they fail loudly if they
 * come back.
 *
 * 1. Selection walked a fixed docker-first list and took whatever answered
 *    `--version`, so a Mac with OrbStack installed never chose Apple's
 *    `container` even with it installed and its apiserver up. Making the list
 *    per platform was not enough: `DARWIN_RUNTIME_ORDER` still ended in
 *    `docker` and `selectRuntime` walked to the first usable entry, so an
 *    unpinned Mac still landed on Docker/OrbStack whenever Apple `container`
 *    answered `--version` with its apiserver down. There is no fallback now on
 *    either platform, and the tests below prove it by the argv that was never
 *    spawned.
 * 2. Capability was keyed on the runtime's NAME. `container` 0.4.1 and upstream
 *    1.3.0 are two different CLIs behind one name, so a name-keyed table keeps
 *    withholding `--cap-drop` and `--read-only` from an operator who upgraded,
 *    and prints nothing while doing it. Capability comes from the binary's own
 *    `run --help`, and the 1.3.0 case below is what proves it: a newer help
 *    text yields the newer confinement with no code change here.
 * 3. The exit code of `run --help` was ignored, so a runtime whose `run --help`
 *    exited 125 while printing a parseable option list came back with every
 *    confinement flag reported as available.
 * 4. A Linux operator whose rootless prerequisites were not set up was told to
 *    run `podman machine start`, which is a macOS instruction for a VM that
 *    does not exist on their host. Diagnosis is per platform now, and the
 *    Linux path names which prerequisite is missing.
 *
 * Every help text is loaded from `fixtures/runtime-help/` rather than inlined,
 * so the parser is held to what those binaries actually printed. Three were
 * captured live on this machine (docker 29.4.0, podman 4.8.2, `container`
 * 0.4.1). The fourth is generated from apple/container's own
 * `docs/command-reference.md` at tag 1.3.0, and its filename says so: it is a
 * documentation claim about a build nobody here has run, which is why nothing
 * but the parser's version-forwardness rests on it.
 *
 * No container runtime is executed and no real file is read. `CommandRunner` is
 * a stub that records argv, which is also how "there is no fallback" is proved:
 * the other runtimes are never spawned at all. The rootless prerequisite probe
 * takes its filesystem through injected `readFile` and `exists`, so these tests
 * describe a Linux host rather than whichever machine they run on, and they
 * touch no real `/proc`, `/etc`, or `/sys`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  capabilityFromHelp,
  DARWIN_RUNTIME_ORDER,
  diagnoseServiceDown,
  KNOWN_RUNTIMES,
  LINUX_RUNTIME_ORDER,
  probeRootlessPrerequisites,
  probeRuntime,
  type RootlessPrerequisite,
  type RootlessProbeOptions,
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

/** The prerequisites ompd proved missing, which is what an operator is shown. */
function missing(probed: RuntimeUnavailable): readonly string[] {
  if (probed.reason !== "host-prerequisite") {
    throw new Error(`expected host-prerequisite, got ${probed.reason}: ${probed.hint}`);
  }
  return probed.missing;
}

function prerequisite(probed: readonly RootlessPrerequisite[], name: string): RootlessPrerequisite {
  const found = probed.find(entry => entry.name === name);
  if (found === undefined) throw new Error(`no prerequisite named ${name} in ${probed.map(e => e.name).join(", ")}`);
  return found;
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
  /** `run --help` exit code. Non-zero is a runtime that answered and failed. */
  helpCode?: number;
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
    if (command[1] === "run") {
      return { code: fake.helpCode ?? 0, stdout: fake.help ?? helpFixture("docker-29.4.0"), stderr: "" };
    }
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
/** The build nobody has run, whose own docs document a numeric `--user`. */
const UPGRADED_APPLE: FakeRuntime = {
  version: "container CLI version 1.3.0 (build: release, commit: 0000000)",
  help: helpFixture("apple-container-1.3.0-derived-from-upstream-docs"),
};

/** An option list that is a container CLI, with `extra` spliced in. */
function synthHelp(...extra: string[]): string {
  return ["OPTIONS:", ...extra, "  -v, --volume <volume>   Bind mount a volume into the container"].join("\n");
}

// ---------------------------------------------------------------------------
// Rootless prerequisite harness: a described Linux host, not this one
// ---------------------------------------------------------------------------

const ROOTLESS_UID = 1000;
const ROOTLESS_USER = "ompd";
const DELEGATED = `/sys/fs/cgroup/user.slice/user-${ROOTLESS_UID}.slice/user@${ROOTLESS_UID}.service/cgroup.controllers`;

/** A host with every prerequisite in place, to be broken one at a time. */
const HEALTHY_HOST: Record<string, string> = {
  "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
  "/proc/sys/user/max_user_namespaces": "15627\n",
  "/etc/subuid": `root:65536:65536\n${ROOTLESS_USER}:100000:65536\n`,
  "/etc/subgid": `root:65536:65536\n${ROOTLESS_USER}:100000:65536\n`,
  "/sys/fs/cgroup/cgroup.controllers": "cpuset cpu io memory pids\n",
  [DELEGATED]: "cpu io memory pids\n",
};

interface IdMapFake {
  /** Directory `command -v` resolves into, or null for "not on PATH". */
  dir?: string | null;
  /** `stat -c %a %u` output, or null to make `stat` fail. */
  stat?: string | null;
  /** `getcap` output, or null for an exit-1 answer. */
  caps?: string | null;
}

/** Stands in for `sh -c command -v`, `stat`, and `getcap` on a Linux host. */
function idMapRunner(fake: IdMapFake = {}): CommandRunner {
  const dir = fake.dir === undefined ? "/usr/bin" : fake.dir;
  return async argv => {
    const [bin, ...rest] = argv;
    if (bin === "sh") {
      if (dir === null) return { code: 1, stdout: "", stderr: "" };
      const binary = (rest[1] ?? "").split(" ").at(-1) ?? "";
      return { code: 0, stdout: `${dir}/${binary}\n`, stderr: "" };
    }
    if (bin === "stat") {
      if (fake.stat === null) return { code: 1, stdout: "", stderr: "stat: cannot statx: No such file" };
      return { code: 0, stdout: `${fake.stat ?? "4755 0"}\n`, stderr: "" };
    }
    if (bin === "getcap") {
      const caps = fake.caps ?? null;
      return caps === null ? { code: 1, stdout: "", stderr: "" } : { code: 0, stdout: caps, stderr: "" };
    }
    throw new Error(`the rootless probe spawned something unexpected: ${argv.join(" ")}`);
  };
}

/** The healthy host, with `files` replacing entries and `idMap` overriding. */
function rootlessOptions(overrides: { files?: Record<string, string | null>; idMap?: IdMapFake } = {}): {
  options: RootlessProbeOptions;
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...HEALTHY_HOST };
  for (const [path, body] of Object.entries(overrides.files ?? {})) {
    if (body === null) delete files[path];
    else files[path] = body;
  }
  return {
    files,
    options: {
      run: idMapRunner(overrides.idMap),
      readFile: path => {
        const body = files[path];
        // Exactly what `readFileSync` does, which is what the probe handles.
        if (body === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
        return body;
      },
      exists: path => files[path] !== undefined,
      user: ROOTLESS_USER,
      uid: ROOTLESS_UID,
    },
  };
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
    const probed = unavailable(await probeRuntime("container", fake.run, "darwin"));
    expect(probed.reason).toBe("absent");
    expect(probed.hint).toContain("https://github.com/apple/container/releases");
    // Nothing else was tried: there is no binary to ask.
    expect(fake.argv).toEqual([["container", "--version"]]);
  });

  test("an installed runtime whose service is down is not absent", async () => {
    // The two an operator confuses, and they need opposite actions.
    const fake = fakeRunner({ container: { ...HEALTHY_APPLE, status: "apiserver is not running" } });
    const probed = unavailable(await probeRuntime("container", fake.run, "darwin"));
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
    const probed = unavailable(await probeRuntime("docker", fake.run, "linux"));
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("docker daemon is not running");
  });

  test("podman's info failing on macOS is reported with the machine hint", async () => {
    const fake = fakeRunner({ podman: { ...HEALTHY_PODMAN, code: 125 } });
    const probed = unavailable(await probeRuntime("podman", fake.run, "darwin"));
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("podman machine start");
  });

  test("podman's info failing on Linux is not, because there is no machine there", async () => {
    // The macOS instruction was the only thing a Linux operator ever saw. This
    // asserts the platform routing; what the Linux path then reports is pinned
    // deterministically in the `diagnoseServiceDown` block below, because here
    // the prerequisite probe reads whichever host these tests run on.
    const fake = fakeRunner({ podman: { ...HEALTHY_PODMAN, code: 125 } });
    const probed = unavailable(await probeRuntime("podman", fake.run, "linux"));
    expect(probed.hint).not.toContain("podman machine start");
    expect(probed.hint).toContain("rootless");
    expect(["host-prerequisite", "service-down"]).toContain(probed.reason);
  });

  test("the version is the build that was probed, not the whole line", async () => {
    const fake = fakeRunner({ container: HEALTHY_APPLE });
    expect(capability(await probeRuntime("container", fake.run, "darwin")).version).toBe("0.4.1");
    expect(fake.argv.at(-1)).toEqual(["container", "run", "--help"]);
  });

  test("a `run --help` that exits non-zero is unverifiable, however parseable", async () => {
    // The reviewer's reproduction: exit 125 with docker's full option list came
    // back as a capability with every confinement flag true. An option list
    // printed by a command that failed is not evidence of anything.
    const fake = fakeRunner({ docker: { ...HEALTHY_DOCKER, helpCode: 125 } });
    const probed = unavailable(await probeRuntime("docker", fake.run, "linux"));
    expect(probed.reason).toBe("unverifiable");
    expect(probed.hint).toContain("exited 125");
    expect(probed.hint).toContain("refuses");
  });

  test("tmpfsOptions is overridden from the table, against what the help implies", async () => {
    // 0.4.1 accepts `--tmpfs /scratch:rw,exec,...`, exits 0, and mounts
    // nothing. No help text can express that, so the pure parse says true for
    // everyone and the probe corrects the one runtime where it is a lie.
    const help = helpFixture("apple-container-0.4.1");
    expect(capability(capabilityFromHelp("container", "0.4.1", help)).tmpfsOptions).toBe(true);

    const fake = fakeRunner({ container: HEALTHY_APPLE });
    expect(capability(await probeRuntime("container", fake.run, "darwin")).tmpfsOptions).toBe(false);
  });

  test("docker keeps tmpfsOptions, which it needs for exec, size, and mode", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    expect(capability(await probeRuntime("docker", fake.run, "linux")).tmpfsOptions).toBe(true);
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
    expect(capability(await probeRuntime("container", apple.run, "darwin")).networkNone).toBe(false);

    const docker = fakeRunner({ docker: HEALTHY_DOCKER });
    expect(capability(await probeRuntime("docker", docker.run, "linux")).networkNone).toBe(true);
  });

  test("Apple's numericUser stays false even when its own docs say otherwise", async () => {
    // Deliberately conservative, and the one place a recorded fact overrides a
    // parse of a NEWER help text rather than an older one. The 1.3.0 fixture is
    // derived from upstream docs, never run, and it documents `--user` as
    // `format: name|uid[:gid]`, so the parse reads numeric. Believing it sends
    // `--user 501:20`, which is the exact argv verified to kill 0.4.1 with
    // `XPC connection error: Connection interrupted`. Being wrong this way
    // costs a container running as root inside its own VM; being wrong the
    // other way costs every provision on the platform. It flips when someone
    // runs a numeric `--user` against a real 1.3.0 binary and records it.
    const parsed = capability(
      capabilityFromHelp("container", "1.3.0", helpFixture("apple-container-1.3.0-derived-from-upstream-docs")),
    );
    expect(parsed.numericUser).toBe(true);

    const upgraded = fakeRunner({ container: UPGRADED_APPLE });
    const probedUpgrade = capability(await probeRuntime("container", upgraded.run, "darwin"));
    expect(probedUpgrade.version).toBe("1.3.0");
    expect(probedUpgrade.numericUser).toBe(false);
    // The rest of 1.3.0's confinement is still gained, so this is a narrow
    // override and not a name-keyed table sneaking back in.
    expect(probedUpgrade.capDrop).toBe(true);
    expect(probedUpgrade.readOnly).toBe(true);

    const current = fakeRunner({ container: HEALTHY_APPLE });
    expect(capability(await probeRuntime("container", current.run, "darwin")).numericUser).toBe(false);
  });

  test("docker and podman keep the parsed numericUser, which is right for them", async () => {
    const docker = fakeRunner({ docker: HEALTHY_DOCKER });
    expect(capability(await probeRuntime("docker", docker.run, "linux")).numericUser).toBe(true);

    const podman = fakeRunner({ podman: HEALTHY_PODMAN });
    expect(capability(await probeRuntime("podman", podman.run, "linux")).numericUser).toBe(true);
  });

  test("an unknown runtime name is a bug, not a probe miss", async () => {
    const fake = fakeRunner({ orbctl: { version: "orbctl 1.0" } });
    await expect(probeRuntime("orbctl", fake.run, "linux")).rejects.toThrow(ProvisionError);
    // Returning `absent` would read as "install orbctl" for a name ompd has no
    // liveness check and no install advice for.
    expect(fake.argv).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linux rootless prerequisites
// ---------------------------------------------------------------------------

describe("probeRootlessPrerequisites", () => {
  test("a host with everything in place reports no failure and no guesswork", async () => {
    const { options } = rootlessOptions();
    const probed = await probeRootlessPrerequisites(options);
    expect(probed.filter(entry => !entry.ok)).toEqual([]);
    expect(probed.map(entry => entry.name)).toEqual([
      "unprivileged-user-namespaces",
      "subuid-subgid-range",
      "newuidmap-newgidmap-privileged",
      "cgroup2-delegation",
    ]);
    expect(probed.some(entry => entry.detail.startsWith("[INFERENCE]"))).toBe(false);
    // Every remedy is actionable on its own, which is the point of splitting
    // "rootless containers are unavailable" into four answers.
    for (const entry of probed) expect(entry.remedy.length).toBeGreaterThan(0);
  });

  test("Debian's disabled userns sysctl is a failure, not a missing file", async () => {
    // Debian and Ubuntu carry a downstream patch adding this sysctl and
    // historically shipped it as 0, so a zero here is the single most likely
    // reason rootless podman does not work on a Debian host.
    const { options } = rootlessOptions({ files: { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "unprivileged-user-namespaces");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("is 0");
    expect(check.remedy).toContain("kernel.unprivileged_userns_clone=1");
    expect(check.remedy).toContain("/etc/sysctl.d/");
  });

  test("an upstream max of zero is a failure too, on hosts with no Debian patch", async () => {
    const { options } = rootlessOptions({
      files: { "/proc/sys/kernel/unprivileged_userns_clone": null, "/proc/sys/user/max_user_namespaces": "0\n" },
    });
    const check = prerequisite(await probeRootlessPrerequisites(options), "unprivileged-user-namespaces");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("/proc/sys/user/max_user_namespaces is 0");
  });

  test("neither sysctl present is unknown, and says so, rather than passing quietly", async () => {
    // Without CONFIG_USER_NS there is no sysctl to read either, so absence is
    // genuinely ambiguous. Calling it a failure sends an operator to fix a
    // prerequisite nothing established was broken.
    const { options } = rootlessOptions({
      files: { "/proc/sys/kernel/unprivileged_userns_clone": null, "/proc/sys/user/max_user_namespaces": null },
    });
    const check = prerequisite(await probeRootlessPrerequisites(options), "unprivileged-user-namespaces");
    expect(check.ok).toBe(true);
    expect(check.detail.startsWith("[INFERENCE]")).toBe(true);
    expect(check.detail).toContain("unknown");
  });

  test("a missing /etc/subuid is named apart from a missing entry in it", async () => {
    const absent = rootlessOptions({ files: { "/etc/subuid": null } });
    const absentCheck = prerequisite(await probeRootlessPrerequisites(absent.options), "subuid-subgid-range");
    expect(absentCheck.ok).toBe(false);
    expect(absentCheck.detail).toContain("/etc/subuid does not exist");
    expect(absentCheck.remedy).toContain("usermod --add-subuids");
    expect(absentCheck.remedy).toContain("needs root");

    const unlisted = rootlessOptions({ files: { "/etc/subgid": "root:65536:65536\nsomeone-else:100000:65536\n" } });
    const unlistedCheck = prerequisite(await probeRootlessPrerequisites(unlisted.options), "subuid-subgid-range");
    expect(unlistedCheck.ok).toBe(false);
    expect(unlistedCheck.detail).toContain("/etc/subgid has no entry for ompd");
  });

  test("a zero-count subuid entry is not a range", async () => {
    const { options } = rootlessOptions({ files: { "/etc/subuid": `${ROOTLESS_USER}:100000:0\n` } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "subuid-subgid-range");
    expect(check.ok).toBe(false);
  });

  test("a uid-keyed subuid entry counts, because shadow-utils allows either", async () => {
    const { options } = rootlessOptions({
      files: {
        "/etc/subuid": `${ROOTLESS_UID}:100000:65536\n`,
        "/etc/subgid": `${ROOTLESS_UID}:100000:65536\n`,
      },
    });
    const check = prerequisite(await probeRootlessPrerequisites(options), "subuid-subgid-range");
    expect(check.ok).toBe(true);
  });

  test("newuidmap missing from PATH is a failure naming shadow-utils", async () => {
    const { options } = rootlessOptions({ idMap: { dir: null } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "newuidmap-newgidmap-privileged");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("newuidmap is not on PATH");
    expect(check.detail).toContain("newgidmap is not on PATH");
    expect(check.remedy).toContain("shadow-utils");
  });

  test("a newuidmap that exists and is not setuid fails, because presence is not privilege", async () => {
    // The kernel only lets privileged code write more than one entry to
    // /proc/self/uid_map, so the setuid bit is the prerequisite and the binary
    // is not. A hand-built or tarball-extracted copy is on PATH and useless.
    const { options } = rootlessOptions({ idMap: { stat: "0755 0" } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "newuidmap-newgidmap-privileged");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("/usr/bin/newuidmap is mode 755");
    expect(check.detail).toContain("neither setuid root nor carrying cap_setuid");
    expect(check.detail).toContain("multi-entry id map");
  });

  test("setuid owned by a non-root user is not privilege either", async () => {
    const { options } = rootlessOptions({ idMap: { stat: "4755 1000" } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "newuidmap-newgidmap-privileged");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("owned by uid 1000");
  });

  test("file capabilities are accepted in place of the setuid bit", async () => {
    // What a Fedora-style install looks like, and what rootlesskit documents as
    // the alternative to setuid root.
    const { options } = rootlessOptions({
      idMap: { stat: "0755 0", caps: "/usr/bin/newuidmap cap_setuid=ep\n/usr/bin/newgidmap cap_setgid=ep\n" },
    });
    const check = prerequisite(await probeRootlessPrerequisites(options), "newuidmap-newgidmap-privileged");
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("cap_setuid");
  });

  test("a stat ompd could not run fails closed rather than assuming privilege", async () => {
    const { options } = rootlessOptions({ idMap: { stat: null } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "newuidmap-newgidmap-privileged");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("could not be stat'ed");
  });

  test("a cgroup v1 host is a failure at the hierarchy, before delegation", async () => {
    const { options } = rootlessOptions({ files: { "/sys/fs/cgroup/cgroup.controllers": null } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "cgroup2-delegation");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("cgroup v2 unified hierarchy");
    expect(check.remedy).toContain("Delegate=cpu cpuset io memory pids");
  });

  test("v2 with nothing delegated to the user slice is a failure", async () => {
    const { options } = rootlessOptions({ files: { [DELEGATED]: null } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "cgroup2-delegation");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("delegated no cgroup controller to this user");
  });

  test("v2 delegating neither memory nor pids names both", async () => {
    // The two ompd cares about, because they are the two a runaway agent
    // exhausts. cpu and io being delegated is not a substitute.
    const { options } = rootlessOptions({ files: { [DELEGATED]: "cpu io\n" } });
    const check = prerequisite(await probeRootlessPrerequisites(options), "cgroup2-delegation");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("missing memory and pids");
  });

  test("the delegated path is this user's slice, not a fixed one", async () => {
    const { options } = rootlessOptions({ files: { [DELEGATED]: "memory pids\n" } });
    const check = prerequisite(await probeRootlessPrerequisites({ ...options, uid: 4242 }), "cgroup2-delegation");
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("user-4242.slice");
    expect(check.detail).toContain("user@4242.service");
  });
});

// ---------------------------------------------------------------------------
// Diagnosis is per platform
// ---------------------------------------------------------------------------

describe("diagnoseServiceDown", () => {
  test("macOS podman gets the machine hint and no prerequisite probe", async () => {
    // Every rootless prerequisite is a Linux path. Running the probe on a Mac
    // would report four missing prerequisites for a host that needs none, so
    // the darwin path must not spawn anything at all.
    const spawned: string[][] = [];
    const probed = await diagnoseServiceDown("podman", "darwin", {
      run: async argv => {
        spawned.push(argv);
        return { code: 0, stdout: "", stderr: "" };
      },
      readFile: path => {
        throw new Error(`the darwin path read ${path}`);
      },
      exists: () => false,
    });
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("podman machine start");
    expect(spawned).toEqual([]);
  });

  test("macOS container gets its own service command", async () => {
    const probed = await diagnoseServiceDown("container", "darwin", {});
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("container system start");
  });

  test("Linux podman with everything configured is service-down, and says what was checked", async () => {
    const { options } = rootlessOptions();
    const probed = await diagnoseServiceDown("podman", "linux", options);
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).not.toContain("podman machine start");
    expect(probed.hint).toContain("no daemon to start on Linux");
    expect(probed.hint).toContain("none is provably missing");
    expect(probed.hint).toContain("cgroup2-delegation");
  });

  test("each prerequisite fails on its own, with its own remedy on its own line", async () => {
    // One at a time, from a host that is otherwise complete, so the reported
    // `missing` is exactly the thing that was broken and nothing else.
    const cases: { name: string; overrides: Parameters<typeof rootlessOptions>[0]; remedy: string }[] = [
      {
        name: "unprivileged-user-namespaces",
        overrides: { files: { "/proc/sys/kernel/unprivileged_userns_clone": "0\n" } },
        remedy: "kernel.unprivileged_userns_clone=1",
      },
      {
        name: "subuid-subgid-range",
        overrides: { files: { "/etc/subuid": null } },
        remedy: "usermod --add-subuids",
      },
      {
        name: "newuidmap-newgidmap-privileged",
        overrides: { idMap: { stat: "0755 0" } },
        remedy: "shadow-utils",
      },
      {
        name: "cgroup2-delegation",
        overrides: { files: { [DELEGATED]: "cpu io\n" } },
        remedy: "Delegate=cpu cpuset io memory pids",
      },
    ];

    for (const one of cases) {
      const { options } = rootlessOptions(one.overrides);
      const probed = await diagnoseServiceDown("podman", "linux", options);
      expect(missing(probed)).toEqual([one.name]);
      expect(probed.hint).toContain("podman is installed but rootless containers are unavailable");
      expect(probed.hint).toContain(one.remedy);
      expect(probed.hint).not.toContain("podman machine start");
      // One line per failing prerequisite, so a hint with two of them stays
      // readable in a log and in an error.
      const named = probed.hint.split("\n").filter(line => line.trim().startsWith(one.name));
      expect(named).toHaveLength(1);
    }
  });

  test("several missing prerequisites are all named, not just the first", async () => {
    const { options } = rootlessOptions({
      files: { "/etc/subuid": null, "/sys/fs/cgroup/cgroup.controllers": null },
      idMap: { dir: null },
    });
    const probed = await diagnoseServiceDown("podman", "linux", options);
    expect(missing(probed)).toEqual(["subuid-subgid-range", "newuidmap-newgidmap-privileged", "cgroup2-delegation"]);
  });

  test("an unchecked prerequisite is reported without being blamed", async () => {
    // The `[INFERENCE]` case must not land in `missing`, which an operator
    // reads as "these are your problem", and must not vanish either.
    const { options } = rootlessOptions({
      files: {
        "/proc/sys/kernel/unprivileged_userns_clone": null,
        "/proc/sys/user/max_user_namespaces": null,
        "/etc/subuid": null,
      },
    });
    const probed = await diagnoseServiceDown("podman", "linux", options);
    expect(missing(probed)).toEqual(["subuid-subgid-range"]);
    expect(probed.hint).toContain("unprivileged-user-namespaces: not checked");
    expect(probed.hint).toContain("[INFERENCE]");
  });

  test("Linux docker is not given podman's diagnosis", async () => {
    const probed = await diagnoseServiceDown("docker", "linux", {
      readFile: path => {
        throw new Error(`the docker path read ${path}`);
      },
      exists: () => false,
    });
    expect(probed.reason).toBe("service-down");
    expect(probed.hint).toContain("docker daemon is not running");
  });

  test("an unknown runtime is a bug here too", async () => {
    await expect(diagnoseServiceDown("orbctl", "linux", {})).rejects.toThrow(ProvisionError);
  });
});

// ---------------------------------------------------------------------------
// Order and pinning: one implicit runtime per platform, no fallback
// ---------------------------------------------------------------------------

describe("runtimeOrder", () => {
  test("exactly one runtime is selected implicitly per platform", () => {
    // Not an order to walk. A fallback list is what put an unpinned Mac on
    // Docker/OrbStack whenever Apple `container` answered `--version` with its
    // apiserver down, which is the dependency container hosts exist to remove.
    expect(DARWIN_RUNTIME_ORDER).toEqual(["container"]);
    expect(LINUX_RUNTIME_ORDER).toEqual(["podman"]);
    expect(runtimeOrder("darwin")).toEqual(DARWIN_RUNTIME_ORDER);
    expect(runtimeOrder("linux")).toEqual(LINUX_RUNTIME_ORDER);
    expect(runtimeOrder("win32")).toEqual([]);
    expect(DARWIN_RUNTIME_ORDER).not.toContain("docker");
    expect(LINUX_RUNTIME_ORDER).not.toContain("docker");
  });

  test("docker stays known, because a pin has to be able to name it", () => {
    expect([...KNOWN_RUNTIMES].sort()).toEqual(["container", "docker", "podman"]);
  });
});

describe("selectRuntime", () => {
  test("darwin with no pin probes container and nothing else", async () => {
    // The original defect: docker was first in one fixed list, so OrbStack won
    // every time. The assertion that matters now is the negative one, on argv:
    // docker and podman are installed and healthy here and are never asked.
    const fake = fakeRunner({ container: HEALTHY_APPLE, docker: HEALTHY_DOCKER, podman: HEALTHY_PODMAN });
    const chosen = await selectRuntime({ run: fake.run, platform: "darwin" });
    expect(chosen.runtime).toBe("container");
    expect(fake.argv).toEqual([
      ["container", "--version"],
      ["container", "system", "status"],
      ["container", "run", "--help"],
    ]);
  });

  test("darwin with container absent refuses, and never touches Docker", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER, podman: HEALTHY_PODMAN });
    const failure = await selectRuntime({ run: fake.run, platform: "darwin" }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProvisionError);
    const message = String(failure);
    expect(message).toContain("container (absent)");
    // Where to get it, and the statement that ompd will not choose another.
    expect(message).toContain("https://github.com/apple/container/releases");
    expect(message).toContain("will not fall back to Docker");
    // The advice names the durable config field, not an environment variable:
    // a launchd-started daemon inherits no shell, so env-only advice pointed an
    // operator at a setting that could not reach the process that needed it.
    expect(message).toContain("`containerRuntime` to `docker` or `podman`");
    expect(message).not.toContain("OMPD_CONTAINER_RUNTIME");
    expect(fake.argv).toEqual([["container", "--version"]]);
  });

  test("darwin with the apiserver down names container system start, and still refuses", async () => {
    // The exact shape the review found: `container` answers `--version`, its
    // apiserver is down, and the old code selected Docker/OrbStack silently.
    const fake = fakeRunner({
      container: { ...HEALTHY_APPLE, status: "apiserver is not running" },
      docker: HEALTHY_DOCKER,
    });
    const failure = await selectRuntime({ run: fake.run, platform: "darwin" }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProvisionError);
    const message = String(failure);
    expect(message).toContain("container (service-down)");
    expect(message).toContain("container system start");
    expect(message).toContain("https://github.com/apple/container/releases");
    expect(message).toContain("will not fall back to Docker");
    expect(fake.argv.some(command => command[0] === "docker")).toBe(false);
    expect(fake.argv.some(command => command[0] === "podman")).toBe(false);
  });

  test("linux with no pin probes podman and nothing else", async () => {
    const fake = fakeRunner({ podman: HEALTHY_PODMAN, docker: HEALTHY_DOCKER });
    const chosen = await selectRuntime({ run: fake.run, platform: "linux" });
    expect(chosen.runtime).toBe("podman");
    expect(chosen.capDrop).toBe(true);
    expect(fake.argv.some(command => command[0] === "docker")).toBe(false);
  });

  test("linux with podman absent refuses instead of falling back to Docker", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    const failure = await selectRuntime({ run: fake.run, platform: "linux" }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProvisionError);
    const message = String(failure);
    expect(message).toContain("podman (absent)");
    expect(message).toContain("will not fall back to Docker on linux");
    expect(message).toContain("`containerRuntime` to `docker`");
    expect(message).not.toContain("OMPD_CONTAINER_RUNTIME");
    expect(fake.argv).toEqual([["podman", "--version"]]);
  });

  test("a pin still reaches docker, on either platform", async () => {
    // Removing the fallback must not remove the choice. Docker is one env var
    // away, and that env var is readable configuration rather than an accident.
    const darwin = fakeRunner({ docker: HEALTHY_DOCKER, container: HEALTHY_APPLE });
    expect((await selectRuntime({ run: darwin.run, platform: "darwin", pinned: "docker" })).runtime).toBe("docker");
    expect(darwin.argv.some(command => command[0] === "container")).toBe(false);

    const linux = fakeRunner({ docker: HEALTHY_DOCKER, podman: HEALTHY_PODMAN });
    expect((await selectRuntime({ run: linux.run, platform: "linux", pinned: "docker" })).runtime).toBe("docker");
    expect(linux.argv.some(command => command[0] === "podman")).toBe(false);
  });

  test("a pin still reaches podman on darwin, where it is not implicit", async () => {
    const fake = fakeRunner({ podman: HEALTHY_PODMAN, container: HEALTHY_APPLE });
    const chosen = await selectRuntime({ run: fake.run, platform: "darwin", pinned: "podman" });
    expect(chosen.runtime).toBe("podman");
    expect(chosen.capDrop).toBe(true);
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

  test("an unsupported platform is named, not reported as an empty search", async () => {
    const fake = fakeRunner({ docker: HEALTHY_DOCKER });
    await expect(selectRuntime({ run: fake.run, platform: "win32" })).rejects.toThrow(
      /no container runtime is available on platform win32/,
    );
    expect(fake.argv).toEqual([]);
  });
});
