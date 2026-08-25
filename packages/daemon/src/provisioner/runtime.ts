/**
 * Which container runtime to drive, and what that exact binary can confine.
 *
 * Two questions live here, and the code this replaces conflated them.
 *
 * The first is which runtime to use. The old probe walked
 * `["docker", "podman", "container"]` and took the first that answered
 * `--version`, which on a Mac with OrbStack installed is always docker: Apple's
 * native `container` could be installed, its apiserver running, and never once
 * selected. Making the order per platform was not enough, and a review of the
 * first attempt found the residue: `DARWIN_RUNTIME_ORDER` still ended in
 * `docker`, and `selectRuntime` walked the order to the first usable entry, so
 * an unpinned selection on a Mac landed on Docker/OrbStack whenever Apple
 * `container` answered `--version` with its apiserver down. That is precisely
 * the dependency container hosts exist to remove, arrived at silently. So there
 * is no fallback on either platform now: exactly one runtime is selected
 * implicitly per platform, `container` on darwin and `podman` on linux, and
 * every other runtime is reachable only by naming it in
 * `OMPD_CONTAINER_RUNTIME`. An operator who wanted docker can still have it;
 * they just have to say so, and it is then in the config rather than in an
 * accident of what happened to be installed.
 *
 * The second is what that runtime's `run` subcommand accepts. That is not a
 * property of the runtime's name, and the table it replaces assumed it was.
 * Verified on this machine: `container` 0.4.1 exits 64 with
 * `Error: Unknown option '--cap-drop'` for each of `--cap-drop`,
 * `--security-opt`, `--read-only`, and `--pids-limit`, while upstream 1.3.0
 * documents `--cap-add`, `--cap-drop`, `--read-only`, `--read-only-path`,
 * `--masked-path`, and `--ulimit`. Same binary name, two different CLIs. A
 * name-keyed table would keep withholding a real security control from an
 * operator who upgraded, and would print nothing while doing it. So
 * `capabilityFromHelp` reads the binary's own `run --help` and reports only
 * what that text declares.
 *
 * Unparseable help is `unverifiable`, never an all-false capability. Those two
 * are indistinguishable to a caller, and one of them means "this runtime
 * confines nothing" while the other means "we could not tell". Provisioning
 * refuses on the second rather than guessing which flags are safe to send. A
 * `run --help` that exits non-zero is `unverifiable` for the same reason: a
 * command that failed can still print a full option list, and trusting one is
 * how a capability report comes out all-true from a runtime that is not
 * working.
 *
 * Liveness stays name-keyed, in `RUNTIME_FACTS`, because it genuinely is
 * per-runtime knowledge that no help text yields: `container system status`
 * prints `apiserver is running`, docker and podman answer `info`. That table is
 * also the registry of runtimes ompd will touch at all, so a runtime cannot be
 * pinned without someone writing down how to check its service and how to
 * install it.
 *
 * Three capabilities come from that table rather than from the parse, and the
 * line they sit either side of is the whole point: a flag the CLI rejects is
 * visible in `run --help`, so it must be probed, while a flag the CLI parses
 * and then ignores, or accepts and then dies on, is invisible to help and can
 * only ever be recorded knowledge with evidence attached. `tmpfsOptions`,
 * `networkNone`, and `numericUser` each carry that evidence in their own
 * comment.
 *
 * Liveness failure is diagnosed per platform, in `diagnoseServiceDown`, because
 * the same failed `podman info` means different things on a Mac and on Linux.
 * On a Mac it is a stopped VM. On Linux podman has no daemon to start at all,
 * so the cause is a host prerequisite for rootless containers, and
 * `probeRootlessPrerequisites` names which one: an operator told to run
 * `podman machine start` on a Linux box has been handed advice for the wrong
 * operating system, which is what the first version of this file did.
 *
 * What is verified and what is not: the docker 29.4.0, podman 4.8.2, and
 * `container` 0.4.1 help fixtures under `packages/daemon/test/fixtures/
 * runtime-help/` were captured from those binaries on this machine, as were the
 * three `--version` lines quoted in `versionFrom`. The 1.3.0 fixture is derived
 * from apple/container's own `docs/command-reference.md` at tag 1.3.0, not from
 * a binary, so what this module claims about 1.3.0 is a documentation claim and
 * the fixture's filename says so. Nothing about 1.3.0 is hardcoded here either
 * way: it is only a test that the parser reads a newer CLI correctly. The
 * rootless prerequisites are not verified on this machine at all, because it is
 * a Mac and none of them exists here; each one cites the upstream document that
 * says it is required, and the probe is covered by injected filesystem and
 * command fakes rather than by a live Linux host.
 */

import { existsSync, readFileSync } from "node:fs";
import { execCommand } from "./exec.ts";
import { type CommandResult, type CommandRunner, ProvisionError } from "./types.ts";

/** What a specific runtime build accepts, read from its own `run --help`. */
export interface RuntimeCapability {
  runtime: string;
  version: string;
  capDrop: boolean;
  securityOpt: boolean;
  readOnly: boolean;
  pidsLimit: boolean;
  /**
   * Whether a numeric uid may be sent to `--user`.
   *
   * Parsed from this CLI's own `--user` description, except where
   * `RUNTIME_FACTS` records otherwise: see that field's comment for the one
   * runtime where a documentation claim would send argv that kills it.
   */
  numericUser: boolean;
  networks: boolean;
  /**
   * `-m, --memory`. On Apple `container` this and `cpuLimit` are the only
   * resource ceilings there are, since it has no `--pids-limit`: without them a
   * runaway build or a fork bomb in a sandbox is bounded by the host and
   * nothing else. Verified on 0.4.1 that they bite rather than being accepted
   * and ignored: `--memory 512M --cpus 2` gave a guest reporting `nproc` = 2
   * and `Mem: 490` total.
   */
  memoryLimit: boolean;
  /** `-c, --cpus`. See `memoryLimit`. */
  cpuLimit: boolean;
  /**
   * Whether `--tmpfs` honours a docker-style option suffix.
   *
   * Not derivable from `run --help`, which is why it comes from `RUNTIME_FACTS`
   * rather than from the parse. Apple `container` 0.4.1 parses
   * `--tmpfs /scratch:rw,exec,nosuid,nodev,size=256m,mode=1777` and exits 0,
   * then mounts nothing at all: `ls -ld /scratch` gives
   * `No such file or directory`, and there is no literal-named directory
   * either. A bare `--tmpfs /scratch` does mount real tmpfs there
   * (`tmpfs on /scratch type tmpfs (rw,relatime)`). Docker 29.4.0 needs the
   * suffixed form to get exec, size, and mode, with mode 1777 verified present.
   * Silent success is worse than exit 64, and no help text says which of the
   * two a given build will do.
   */
  tmpfsOptions: boolean;
  /**
   * Whether "no network at all" is expressible.
   *
   * From `RUNTIME_FACTS`, not from the parse, for the same reason as
   * `tmpfsOptions`: Apple `container` declares `--network`, so a help parse
   * would say yes, but it has no `none` network and `--no-dns` leaves IP
   * egress open. A provider that cannot express this must refuse a request for
   * it rather than approximate it.
   */
  networkNone: boolean;
}

/**
 * Why a runtime cannot be used, kept apart from "used with less confinement".
 *
 * `absent` and `service-down` are the two an operator confuses, and they need
 * opposite actions: install something, or start something already installed.
 * `host-prerequisite` is a third that neither of those describes: the binary is
 * installed and there is no service to start, and it still cannot run a
 * container because the host kernel or `/etc` is not set up for rootless
 * containers. Telling that operator to start a service sends them looking for
 * something that does not exist on their platform.
 * `unverifiable` is the fail-closed case: the CLI is there and answering, and
 * ompd still refuses because it could not read what its `run` accepts.
 */
export type RuntimeUnavailable =
  | { reason: "absent"; runtime: string; hint: string }
  | { reason: "service-down"; runtime: string; hint: string }
  | { reason: "host-prerequisite"; runtime: string; missing: readonly string[]; hint: string }
  | { reason: "unverifiable"; runtime: string; hint: string };

interface RuntimeFacts {
  /** What to tell an operator whose PATH has no such binary. */
  install: string;
  /** Argv after the runtime name that proves the runtime's service is up. */
  liveness: readonly string[];
  /**
   * Substring the liveness command must print on stdout, for a runtime whose
   * exit code alone does not separate "up" from "down".
   */
  expect?: string;
  /**
   * What to tell an operator whose runtime is installed but not answering, as a
   * function of the host OS rather than a single string.
   *
   * A function because the advice is genuinely different per platform and the
   * single string was wrong on one of them: podman's said
   * `podman machine start`, which is a macOS instruction, and it was the only
   * thing a Linux operator with unconfigured rootless prerequisites ever saw.
   */
  down: (platform: string) => string;
  /**
   * Whether `--tmpfs <path>:<options>` is honoured, per `RuntimeCapability`.
   *
   * Recorded rather than probed, because the failure it describes is silent:
   * see that field's comment for the commands that established each value.
   */
  tmpfsOptions: boolean;
  /**
   * Whether the runtime can express "this container gets no network at all",
   * per `RuntimeCapability.networkNone`.
   *
   * Recorded rather than probed for the same reason as `tmpfsOptions`: help
   * text cannot express it. Apple `container` has a `--network` flag, so a
   * parse would say yes, but the flag takes the name of a network that has to
   * exist and there is no `none`: `--network none` fails with
   * `notFound: "network none not found"`, and every network it can create is
   * `mode: nat` with egress open. `--no-dns` is not a substitute, verified:
   * under it `ping 1.1.1.1` and `ping 8.8.8.8` both still succeed, because all
   * it does is delete `/etc/resolv.conf`.
   */
  networkNone: boolean;
  /**
   * Recorded override for `RuntimeCapability.numericUser`, or omitted to trust
   * what this CLI's `--user` description says.
   *
   * Optional where `tmpfsOptions` and `networkNone` are not, because for docker
   * and podman the parse is right and there is nothing to record: their help
   * says `Username or UID (format: <name|uid>...)` and a numeric `--user`
   * works. It exists for the one runtime where believing the documentation
   * sends argv that kills the process.
   */
  numericUser?: boolean;
}

/**
 * Per-runtime knowledge that no help text can supply.
 *
 * Liveness, install advice, and the capabilities a help text cannot express.
 * Confinement flags deliberately do not live here: see this file's header for
 * why keying those on a name is the bug this module exists to fix.
 *
 * All three stay in the table even though only two are ever selected
 * implicitly, because `KNOWN_RUNTIMES` is derived from it and a pin has to be
 * able to name docker or podman.
 */
const RUNTIME_FACTS: Record<string, RuntimeFacts> = {
  container: {
    install: "`container` is not on ompd's PATH; install a release from https://github.com/apple/container/releases",
    liveness: ["system", "status"],
    expect: "apiserver is running",
    // macOS only, so this one genuinely does not vary by platform.
    down: () => "`container` is installed but its apiserver is not answering; run `container system start`",
    tmpfsOptions: false,
    networkNone: false,
    /**
     * False, recorded, and overriding the parse.
     *
     * Every numeric identity flag verified against 0.4.1 on this machine
     * crashes it rather than failing cleanly: `--user 501:20`,
     * `--uid 1000 --gid 1000`, and `--uid 501` each give
     * `XPC connection error: Connection interrupted`. `--user nobody` and
     * `--uid 0` work, and the default identity is root inside the guest VM.
     *
     * 0.4.1's help would parse to false anyway (`Set the user for the process`
     * mentions no uid), so the override is not about 0.4.1. It is about the
     * next version: upstream's `docs/command-reference.md` at tag 1.3.0
     * documents `--user` as `format: name|uid[:gid]`, which the parser reads as
     * numeric, so an operator who upgraded would start being sent exactly the
     * argv proven to kill the runtime, on the strength of a documentation claim
     * nobody has run. This stays false until someone runs a numeric `--user`
     * against a real 1.3.0 binary and records what it did. Being wrong in this
     * direction costs a container running as root inside its own VM; being
     * wrong in the other direction costs every provision on the platform.
     */
    numericUser: false,
  },
  podman: {
    install: "`podman` is not on ompd's PATH; install it with `brew install podman` or your package manager",
    liveness: ["info"],
    down: platform =>
      platform === "darwin"
        ? "`podman info` failed; on macOS the VM has to be up, so run `podman machine start`"
        : "`podman info` failed; podman has no daemon to start on Linux, so this is the host's configuration rather than a service",
    tmpfsOptions: true,
    networkNone: true,
  },
  docker: {
    install: "`docker` is not on ompd's PATH; install Docker Desktop, OrbStack, Colima, or Rancher Desktop",
    liveness: ["info"],
    down: () => "`docker info` failed; the docker daemon is not running, so start Docker Desktop, OrbStack, or Colima",
    tmpfsOptions: true,
    networkNone: true,
  },
};

/**
 * Every runtime ompd will touch, derived from `RUNTIME_FACTS` so the two cannot
 * drift. Adding a runtime means writing down how to check its service and how
 * to install it, in one place, or it is not known at all.
 *
 * Wider than the two order lists on purpose: this is the set a pin may name,
 * and docker is in it.
 */
export const KNOWN_RUNTIMES: readonly string[] = Object.keys(RUNTIME_FACTS);

/**
 * The only runtime darwin selects implicitly, and deliberately not an order to
 * walk.
 *
 * Apple's `container` runs each container in its own lightweight VM with no
 * shared host kernel and needs no daemon an operator has to remember to start.
 * It used to be first in a list that ended in `docker`, and a review found what
 * that costs: `selectRuntime` walked to the first usable entry, so a Mac whose
 * `container` answered `--version` with its apiserver stopped silently
 * provisioned on Docker/OrbStack instead. Removing the Docker dependency is the
 * entire point of this backend, so a fallback that quietly reintroduces it is
 * not a convenience.
 *
 * Docker and podman are still reachable on darwin, by name:
 * `OMPD_CONTAINER_RUNTIME=docker` or `=podman`. That is a decision an operator
 * made and can read back out of their own configuration, which is the
 * difference that matters.
 */
export const DARWIN_RUNTIME_ORDER: readonly string[] = ["container"];

/**
 * The only runtime linux selects implicitly, matching darwin in having no
 * hidden fallback.
 *
 * Podman because it needs no root daemon and is rootless by design. Docker is
 * not here for the same reason it is not on darwin: an implicit fall back to a
 * root daemon is a change in the security posture of every container ompd runs,
 * and it must be something an operator asked for with
 * `OMPD_CONTAINER_RUNTIME=docker` rather than something that happened because
 * podman's prerequisites were not set up.
 */
export const LINUX_RUNTIME_ORDER: readonly string[] = ["podman"];

/** Probe order for a platform, empty where ompd knows no runtime at all. */
export function runtimeOrder(platform: string): readonly string[] {
  if (platform === "darwin") return DARWIN_RUNTIME_ORDER;
  if (platform === "linux") return LINUX_RUNTIME_ORDER;
  return [];
}

// ---------------------------------------------------------------------------
// Linux rootless prerequisites
// ---------------------------------------------------------------------------

/** One host prerequisite rootless podman needs, and what to do about it. */
export interface RootlessPrerequisite {
  /** Stable short name. This is what lands in `RuntimeUnavailable.missing`. */
  name: string;
  /**
   * False only where this host was proven to be missing it.
   *
   * A check ompd could not carry out is `true` with an `[INFERENCE]` detail
   * rather than false: `missing` is read by an operator as "these are your
   * problem", and naming something ompd never established is how a diagnosis
   * sends someone to fix a prerequisite that was never broken. The unchecked
   * ones are still reported, on their own line, so they are not swallowed.
   */
  ok: boolean;
  /** What was read and from where, marked `[INFERENCE]` when nothing was. */
  detail: string;
  /** The command or file that fixes it. */
  remedy: string;
}

export interface RootlessProbeOptions {
  run?: CommandRunner;
  /** Injected; throws when absent, exactly as `readFileSync` does. */
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  user?: string;
  uid?: number;
}

const USERNS_CLONE = "/proc/sys/kernel/unprivileged_userns_clone";
const USERNS_MAX = "/proc/sys/user/max_user_namespaces";
const CGROUP2_CONTROLLERS = "/sys/fs/cgroup/cgroup.controllers";

/** The setuid bit, as `stat -c %a` prints it. */
const MODE_SETUID = 0o4000;

/** Controllers a rootless container needs delegated to run under any ceiling. */
const REQUIRED_CONTROLLERS: readonly string[] = ["memory", "pids"];

/** A sysctl's integer value, or null when the file is absent or not a number. */
function readInt(readFile: (path: string) => string, exists: (path: string) => boolean, path: string): number | null {
  if (!exists(path)) return null;
  try {
    const raw = readFile(path).trim();
    return /^-?\d+$/.test(raw) ? Number.parseInt(raw, 10) : null;
  } catch {
    return null;
  }
}

/**
 * Can this user create a user namespace at all.
 *
 * Two files because two families of distribution express it differently.
 * Debian and Ubuntu carry a downstream patch adding
 * `kernel.unprivileged_userns_clone`, historically shipped as 0
 * (https://lists.debian.org/debian-kernel/2020/03/msg00237.html), and upstream
 * uses `user.max_user_namespaces`, which some hardened hosts set to 0. Podman's
 * own rootless tutorial names both
 * (containers/podman `docs/tutorials/rootless_tutorial.md`).
 *
 * A kernel with neither readable is not a pass and not a failure. Without
 * `CONFIG_USER_NS` there is no sysctl to read either, so absence is genuinely
 * ambiguous, and this reports it as unknown rather than picking a side.
 */
function checkUserNamespaces(
  readFile: (path: string) => string,
  exists: (path: string) => boolean,
): RootlessPrerequisite {
  const name = "unprivileged-user-namespaces";
  const remedy = `enable unprivileged user namespaces (needs root): \`sysctl -w kernel.unprivileged_userns_clone=1\` on Debian or Ubuntu, \`sysctl -w user.max_user_namespaces=15000\` elsewhere, persisted in \`/etc/sysctl.d/\``;

  const clone = readInt(readFile, exists, USERNS_CLONE);
  const max = readInt(readFile, exists, USERNS_MAX);

  if (clone === 0) {
    return {
      name,
      ok: false,
      detail: `${USERNS_CLONE} is 0, so this kernel refuses an unprivileged \`clone(CLONE_NEWUSER)\` and no rootless container can start`,
      remedy,
    };
  }
  if (max !== null && max <= 0) {
    return {
      name,
      ok: false,
      detail: `${USERNS_MAX} is ${max}, so this user is allowed to hold no user namespaces`,
      remedy,
    };
  }
  if (clone === null && max === null) {
    return {
      name,
      ok: true,
      detail: `[INFERENCE] neither ${USERNS_CLONE} nor ${USERNS_MAX} could be read, so whether this kernel permits unprivileged user namespaces is unknown; this check is not evidence either way`,
      remedy,
    };
  }
  const seen = [clone === null ? null : `${USERNS_CLONE} is ${clone}`, max === null ? null : `${USERNS_MAX} is ${max}`]
    .filter((line): line is string => line !== null)
    .join(", ");
  return { name, ok: true, detail: seen, remedy };
}

/** The subordinate id count granted to `user` or `uid` in `path`, or null. */
function subordinateCount(readFile: (path: string) => string, path: string, user: string, uid: number): number | null {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    // `name:start:count`, per shadow-utils subuid(5).
    const fields = line.trim().split(":");
    if (fields.length < 3) continue;
    const owner = fields[0];
    if (owner !== user && owner !== String(uid)) continue;
    const count = Number.parseInt(fields[2] ?? "", 10);
    if (Number.isFinite(count) && count > 0) return count;
  }
  return null;
}

/**
 * Does this user own a range of subordinate ids to map into the container.
 *
 * Required by both runc and podman (containers/podman
 * `docs/tutorials/rootless_tutorial.md`), and not something ompd can arrange:
 * `/etc/subuid` and `/etc/subgid` are root-owned, so a user cannot grant
 * themselves a range. Absent file and absent entry are both failures and are
 * worded apart, because "install shadow-utils" and "add an entry" are different
 * jobs.
 */
function checkSubordinateIds(
  readFile: (path: string) => string,
  exists: (path: string) => boolean,
  user: string,
  uid: number,
): RootlessPrerequisite {
  const name = "subuid-subgid-range";
  const who = user === "" ? String(uid) : user;
  const remedy = `grant a subordinate id range (needs root): \`usermod --add-subuids 100000-165535 --add-subgids 100000-165535 ${who}\``;

  const problems: string[] = [];
  const found: string[] = [];
  for (const path of ["/etc/subuid", "/etc/subgid"]) {
    if (!exists(path)) {
      problems.push(`${path} does not exist`);
      continue;
    }
    const count = subordinateCount(readFile, path, user, uid);
    if (count === null) problems.push(`${path} has no entry for ${who} with a non-zero count`);
    else found.push(`${path} grants ${who} ${count} ids`);
  }
  if (problems.length > 0) return { name, ok: false, detail: problems.join("; "), remedy };
  return { name, ok: true, detail: found.join("; "), remedy };
}

/** An absolute path `command -v` resolved to, or null when it is not on PATH. */
async function resolveOnPath(run: CommandRunner, binary: string): Promise<string | null> {
  try {
    const found = await run(["sh", "-c", `command -v ${binary}`]);
    const path = firstLine(found.stdout);
    return found.code === 0 && path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

/**
 * Is this id-map helper actually privileged, rather than merely present.
 *
 * The kernel only lets privileged code write more than one entry to
 * `/proc/self/uid_map`, which is why the setuid bit rather than the binary is
 * the prerequisite: shadow-utils ships `newuidmap` and `newgidmap` setuid root
 * (or carrying `cap_setuid` / `cap_setgid` as file capabilities) precisely so an
 * unprivileged user can get a full range mapped
 * (rootless-containers/rootlesskit). A copy that lost its bit, which is what a
 * hand-built or tarball-extracted install produces, is on PATH and cannot do
 * the one thing it is needed for.
 *
 * A mode ompd could not read is a failure, not a pass: this module refuses on
 * what it cannot verify everywhere else, and claiming a privilege from a `stat`
 * that did not answer is the same mistake as trusting a failed `run --help`.
 */
async function idMapPrivilege(
  run: CommandRunner,
  path: string,
  capability: string,
): Promise<{ ok: boolean; detail: string }> {
  let mode: number | null = null;
  let owner: number | null = null;
  try {
    // `-c` is GNU coreutils and busybox; both are what a Linux host has.
    const stat = await run(["stat", "-c", "%a %u", path]);
    if (stat.code === 0) {
      const [rawMode, rawOwner] = firstLine(stat.stdout).split(/\s+/);
      const parsedMode = Number.parseInt(rawMode ?? "", 8);
      const parsedOwner = Number.parseInt(rawOwner ?? "", 10);
      if (Number.isFinite(parsedMode)) mode = parsedMode;
      if (Number.isFinite(parsedOwner)) owner = parsedOwner;
    }
  } catch {
    // No `stat` on PATH. The file capability check below is the other half.
  }

  if (mode !== null && owner !== null && (mode & MODE_SETUID) !== 0 && owner === 0) {
    return { ok: true, detail: `${path} is setuid root (mode ${mode.toString(8)})` };
  }

  try {
    const caps = await run(["getcap", path]);
    if (caps.code === 0 && caps.stdout.includes(capability)) {
      return { ok: true, detail: `${path} carries ${capability} (${firstLine(caps.stdout)})` };
    }
  } catch {
    // No `getcap` either, so there is nothing left that could prove privilege.
  }

  if (mode !== null && owner !== null) {
    return {
      ok: false,
      detail: `${path} is mode ${mode.toString(8)} owned by uid ${owner}, which is neither setuid root nor carrying ${capability}, so it cannot write a multi-entry id map`,
    };
  }
  return {
    ok: false,
    detail: `${path} could not be stat'ed and \`getcap\` did not report ${capability}, so ompd cannot establish that it is privileged and will not assume it`,
  };
}

/** Both id-map helpers, present and privileged, or the reason they are not. */
async function checkIdMapHelpers(run: CommandRunner): Promise<RootlessPrerequisite> {
  const name = "newuidmap-newgidmap-privileged";
  const remedy =
    "install shadow-utils, which ships `newuidmap` and `newgidmap` setuid root (`apt install uidmap`, `dnf install shadow-utils`), and do not strip the setuid bit";

  const problems: string[] = [];
  const found: string[] = [];
  for (const [binary, capability] of [
    ["newuidmap", "cap_setuid"],
    ["newgidmap", "cap_setgid"],
  ] as const) {
    const resolved = await resolveOnPath(run, binary);
    if (resolved === null) {
      problems.push(`${binary} is not on PATH`);
      continue;
    }
    const privilege = await idMapPrivilege(run, resolved, capability);
    if (privilege.ok) found.push(privilege.detail);
    else problems.push(privilege.detail);
  }
  if (problems.length > 0) return { name, ok: false, detail: problems.join("; "), remedy };
  return { name, ok: true, detail: found.join("; "), remedy };
}

/**
 * Cgroups v2, unified, with controllers delegated to this user's slice.
 *
 * Two separate things, and an operator needs to know which one they have. The
 * unified hierarchy is the kernel and mount layer: without
 * `/sys/fs/cgroup/cgroup.controllers` the host is on v1 or hybrid and a
 * rootless container gets no ceiling at all. Delegation is systemd handing the
 * user's own slice the controllers it may set, which is what runc's
 * `docs/cgroup-v2.md` describes as the rootless path, via
 * `systemd-run --user --scope` under
 * `/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service`. `memory` and
 * `pids` are the two ompd cares about, because they are the two a runaway agent
 * exhausts.
 */
function checkCgroupDelegation(
  readFile: (path: string) => string,
  exists: (path: string) => boolean,
  uid: number,
): RootlessPrerequisite {
  const name = "cgroup2-delegation";
  const remedy = `delegate cgroup controllers to the user slice (needs root): put \`[Service]\` and \`Delegate=cpu cpuset io memory pids\` in \`/etc/systemd/system/user@.service.d/delegate.conf\`, then \`systemctl daemon-reload\``;

  if (!exists(CGROUP2_CONTROLLERS)) {
    return {
      name,
      ok: false,
      detail: `${CGROUP2_CONTROLLERS} does not exist, so this host is not on the cgroup v2 unified hierarchy and a rootless container can be given no memory or process ceiling`,
      remedy,
    };
  }

  const delegated = `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.controllers`;
  let controllers: string;
  try {
    controllers = readFile(delegated).trim();
  } catch {
    return {
      name,
      ok: false,
      detail: `${delegated} could not be read, so systemd has delegated no cgroup controller to this user`,
      remedy,
    };
  }
  const available = controllers.split(/\s+/).filter(token => token !== "");
  const absent = REQUIRED_CONTROLLERS.filter(controller => !available.includes(controller));
  if (absent.length > 0) {
    return {
      name,
      ok: false,
      detail: `${delegated} delegates ${available.length > 0 ? available.join(" ") : "nothing"}, which is missing ${absent.join(" and ")}`,
      remedy,
    };
  }
  return { name, ok: true, detail: `${delegated} delegates ${available.join(" ")}`, remedy };
}

/**
 * Every host prerequisite rootless podman needs on Linux, each answered
 * separately.
 *
 * Separately because "rootless containers are unavailable" is not actionable
 * and "your user has no subuid range" is. None of these can be bundled or
 * arranged by ompd: user namespaces are a kernel build and a sysctl, subuid
 * ranges and the setuid id-map helpers need root, and cgroup delegation is
 * systemd's. Naming which one is missing is the whole value ompd can add.
 *
 * Every input is injectable, and the defaults are the only place this module
 * reads the real filesystem. Nothing here runs on darwin: `diagnoseServiceDown`
 * gates on the platform, because on a Mac none of these paths exists and the
 * probe would report four missing prerequisites for a host that needs none of
 * them.
 */
export async function probeRootlessPrerequisites(
  opts: RootlessProbeOptions = {},
): Promise<readonly RootlessPrerequisite[]> {
  const run = opts.run ?? execCommand;
  const readFile = opts.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const exists = opts.exists ?? ((path: string) => existsSync(path));
  // `process.getuid` is absent on Windows, where nothing here applies anyway.
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const user = opts.user ?? process.env.USER ?? process.env.LOGNAME ?? "";

  return [
    checkUserNamespaces(readFile, exists),
    checkSubordinateIds(readFile, exists, user, uid),
    await checkIdMapHelpers(run),
    checkCgroupDelegation(readFile, exists, uid),
  ];
}

/**
 * Why a runtime that answered `--version` will not answer its liveness command.
 *
 * Exported so the linux path is testable with an injected filesystem: the
 * alternative is a probe whose only coverage is the host the tests happen to
 * run on, which for this repo is a Mac that has none of these files.
 *
 * The linux podman case is the one this exists for. Podman has no daemon there,
 * so `service-down` with the macOS `podman machine start` string was advice for
 * the wrong operating system, and it was the only message a Linux operator with
 * unconfigured rootless prerequisites ever got. When a prerequisite is provably
 * missing this returns `host-prerequisite` naming it. When every one passes it
 * still reports `service-down`, and says which ones were checked, so the
 * operator knows where not to look.
 */
export async function diagnoseServiceDown(
  runtime: string,
  platform: string,
  rootless: RootlessProbeOptions = {},
): Promise<RuntimeUnavailable> {
  const facts = RUNTIME_FACTS[runtime];
  if (facts === undefined) {
    throw new ProvisionError(
      `unknown container runtime ${JSON.stringify(runtime)}; ompd knows ${KNOWN_RUNTIMES.join(", ")}`,
      "container",
    );
  }
  if (platform !== "linux" || runtime !== "podman") {
    return { reason: "service-down", runtime, hint: facts.down(platform) };
  }

  const prerequisites = await probeRootlessPrerequisites(rootless);
  const failing = prerequisites.filter(prerequisite => !prerequisite.ok);
  const unchecked = prerequisites.filter(
    prerequisite => prerequisite.ok && prerequisite.detail.startsWith("[INFERENCE]"),
  );
  if (failing.length === 0) {
    const checked = prerequisites.map(prerequisite => prerequisite.name).join(", ");
    return {
      reason: "service-down",
      runtime,
      hint: `${facts.down(platform)}; ompd checked the rootless prerequisites (${checked}) and none is provably missing, so run \`podman info\` by hand and read what it says`,
    };
  }
  const lines = [
    `podman is installed but rootless containers are unavailable: ${failing.map(prerequisite => prerequisite.name).join(", ")}`,
    ...failing.map(prerequisite => `  ${prerequisite.name}: ${prerequisite.detail}; fix: ${prerequisite.remedy}`),
    ...unchecked.map(prerequisite => `  ${prerequisite.name}: not checked, ${prerequisite.detail}`),
  ];
  return {
    reason: "host-prerequisite",
    runtime,
    missing: failing.map(prerequisite => prerequisite.name),
    hint: lines.join("\n"),
  };
}

/** One option as its own CLI describes it. */
interface OptionBlock {
  /** Flag tokens exactly as written, for example `["-u", "--user"]`. */
  flags: readonly string[];
  /** Metavar, description, and every continuation line, joined by spaces. */
  text: string;
}

/**
 * A flag token at the head of a string, plus the comma that means another flag
 * follows it.
 *
 * Both halves are load bearing. The name must start with a letter, which is
 * what stops docker's wrapped `--pids-limit` description (`-1 for unlimited)`,
 * alone on its own line) from being read as a new option. The trailing comma is
 * the real grammar of a flag list, `-u, --user, --usr <meta>`: a token that is
 * not comma-terminated ends the list, so a description that happens to mention
 * `--read-only` cannot add that flag to the option that mentions it.
 */
const FLAG_HEAD = /^(--?[A-Za-z][A-Za-z0-9-]*)(,[ \t]*)?/;

/** A version token from a `--version` line. */
const VERSION_TOKEN = /\d+\.\d+(?:\.\d+)?/;

/**
 * Start an option block at `line`, or null if it does not declare flags.
 *
 * `column` is where the block's first long flag sits, not the line's indent,
 * because docker indents a long flag to column 6 whether or not a short alias
 * precedes it (`  -a, --attach` and `      --add-host` both put `--` at 6).
 * Using the indent would make every long-only option a continuation of the
 * option above it.
 */
function startBlock(line: string): { block: OptionBlock; column: number } | null {
  const trimmed = line.trimStart();
  const flags: string[] = [];
  let rest = trimmed;
  for (;;) {
    const head = FLAG_HEAD.exec(rest);
    if (head === null) break;
    flags.push(head[1] as string);
    rest = rest.slice(head[0].length);
    if (head[2] === undefined) break;
  }
  if (flags.length === 0) return null;
  const long = flags.find(flag => flag.startsWith("--"));
  const column = long === undefined ? line.length - trimmed.length : line.indexOf(long);
  return { block: { flags, text: rest.trim() }, column };
}

/**
 * Every option block in a `run --help`, from any of the three help formats.
 *
 * A line indented past the open block's flag column continues it: both docker's
 * getopt-style output and swift-argument-parser's wrap descriptions onto their
 * own lines, and the discriminator this module needs most often lands on a
 * wrapped line (docker's `--user` says `Username or UID (format:` and finishes
 * `<name|uid>[:<group|gid>])` on the next). A blank line or an unindented
 * heading closes the block.
 */
function optionBlocks(help: string): OptionBlock[] {
  const blocks: OptionBlock[] = [];
  let open: { block: OptionBlock; column: number } | null = null;
  for (const line of help.split("\n")) {
    if (line.trim() === "") {
      open = null;
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (open !== null && indent > open.column) {
      open.block.text = `${open.block.text} ${line.trim()}`.trim();
      continue;
    }
    open = startBlock(line);
    if (open !== null) blocks.push(open.block);
  }
  return blocks;
}

/**
 * What a `run --help` declares. Pure: no subprocess, no filesystem, so every
 * runtime this module supports is covered by a fixture in the test suite.
 *
 * Flags match on the exact declared token, never a substring. Podman has
 * `--read-only-tmpfs` and `container` 1.3.0 has `--read-only-path`, and either
 * one satisfying `--read-only` would claim a read-only rootfs ompd never asked
 * for.
 *
 * `numericUser` reads only the block that declares `--user`, because
 * `container` 0.4.1 carries the exact trap a whole-text search falls into: it
 * has a separate `--uid <uid>` option, so "does this help mention uid" answers
 * yes for a CLI whose `--user` takes a name and whose `--uid` crashes the
 * runtime (`XPC connection error: Connection interrupted`, verified for
 * `--user 501:20`, `--uid 1000 --gid 1000`, and `--uid 501`). The honest
 * question is whether this CLI's own `--user` documents a numeric uid: docker
 * 29.4.0 and podman 4.8.2 say `Username or UID (format: <name|uid>...)`,
 * `container` 0.4.1 says `Set the user for the process` and nothing more, and
 * 1.3.0 adds `(format: name|uid[:gid])`. That last one is a documentation claim
 * about a build nobody has run, which is why `RUNTIME_FACTS.container` records
 * `numericUser: false` and `probeRuntime` lets the record win.
 *
 * `tmpfsOptions`, `networkNone`, and `numericUser` are the fields a help text
 * cannot answer, so this pure function reports what the text implies and
 * `probeRuntime` overrides them from `RUNTIME_FACTS`. Defaulting keeps the
 * function total, and the override is where the verified exceptions live.
 */
export function capabilityFromHelp(
  runtime: string,
  version: string,
  help: string,
): RuntimeCapability | RuntimeUnavailable {
  const blocks = optionBlocks(help);
  const declares = (flag: string): boolean => blocks.some(block => block.flags.includes(flag));

  if (blocks.length === 0) {
    return {
      reason: "unverifiable",
      runtime,
      hint: `\`${runtime} run --help\` printed no option list ompd could read, so which confinement flags this build accepts is unknown and provisioning refuses rather than guessing at them; run it by hand and compare with packages/daemon/test/fixtures/runtime-help/`,
    };
  }
  if (!declares("--volume") && !declares("--network")) {
    return {
      reason: "unverifiable",
      runtime,
      hint: `\`${runtime} run --help\` declares neither \`--volume\` nor \`--network\`, so it is not a container-run CLI ompd can drive; provisioning refuses rather than guessing which of its flags confine anything`,
    };
  }

  const user = blocks.find(block => block.flags.includes("--user"));
  return {
    runtime,
    version,
    capDrop: declares("--cap-drop"),
    securityOpt: declares("--security-opt"),
    readOnly: declares("--read-only"),
    pidsLimit: declares("--pids-limit"),
    numericUser: user !== undefined && /uid/i.test(user.text),
    networks: declares("--network"),
    memoryLimit: declares("--memory"),
    cpuLimit: declares("--cpus"),
    tmpfsOptions: true,
    networkNone: true,
  };
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0]?.trim() ?? "";
}

/**
 * The version token from a `--version` line, or the whole line when there is
 * none.
 *
 * Observed on this machine: `Docker version 29.4.0, build 9d7ad9f`,
 * `podman version 4.8.2`, and
 * `container CLI version 0.4.1 (build: release, commit: 4ac18b5)`. Nothing keys
 * off this string. Capability comes from `run --help`; the version is carried
 * so a log line or an error names the build that was probed.
 */
function versionFrom(probe: CommandResult): string {
  const line = firstLine(probe.stdout) || firstLine(probe.stderr);
  return VERSION_TOKEN.exec(line)?.[0] ?? line;
}

export interface ProbeOptions {
  run?: CommandRunner;
  platform?: string;
  pinned?: string;
}

/**
 * Is this runtime installed, is its service up, and what does its `run` accept.
 *
 * An unknown name throws rather than returning `absent`. `absent` is an
 * operator's machine missing a tool; an unknown name is ompd asking for a
 * runtime it has no facts for, which is a bug in a caller and must not read as
 * a normal probe miss.
 *
 * `platform` is a parameter rather than a read of `process.platform` because
 * the diagnosis for a runtime that is installed and not answering is different
 * per operating system, and a value taken from the host is a value no test can
 * vary.
 *
 * What this adds to the parse is the three capabilities no help text can
 * answer: a suffixed `--tmpfs` that parses and mounts nothing looks exactly
 * like one that works, a `--network` flag with no `none` network looks exactly
 * like isolation, and a documented numeric `--user` looks exactly like one that
 * does not crash the runtime.
 */
export async function probeRuntime(
  runtime: string,
  run: CommandRunner = execCommand,
  platform: string = process.platform,
): Promise<RuntimeCapability | RuntimeUnavailable> {
  const facts = RUNTIME_FACTS[runtime];
  if (facts === undefined) {
    throw new ProvisionError(
      `unknown container runtime ${JSON.stringify(runtime)}; ompd knows ${KNOWN_RUNTIMES.join(", ")}`,
      "container",
    );
  }

  let version: string;
  try {
    const probe = await run([runtime, "--version"]);
    if (probe.code !== 0) {
      return {
        reason: "unverifiable",
        runtime,
        hint: `\`${runtime} --version\` exited ${probe.code}: ${firstLine(probe.stderr) || firstLine(probe.stdout)}`,
      };
    }
    version = versionFrom(probe);
  } catch {
    // `Bun.spawn` throws for a missing binary rather than exiting non-zero, so
    // this is the ordinary "not installed" path, not an error.
    return { reason: "absent", runtime, hint: facts.install };
  }

  try {
    const status = await run([runtime, ...facts.liveness]);
    const up = status.code === 0 && (facts.expect === undefined || status.stdout.includes(facts.expect));
    if (!up) return await diagnoseServiceDown(runtime, platform, { run });
  } catch {
    // The CLI answered `--version` a moment ago and cannot be started now.
    // Whatever moved, the operator's next step is the same one.
    return await diagnoseServiceDown(runtime, platform, { run });
  }

  try {
    // Both streams: docker prints `run --help` on stdout, and a CLI that put it
    // on stderr would otherwise look like a runtime with no options at all.
    const help = await run([runtime, "run", "--help"]);
    if (help.code !== 0) {
      // A failed command can still print a complete option list, and a parse of
      // one reports every flag as available. That is how a broken runtime comes
      // back fully capable, so the exit code decides and the text is discarded.
      return {
        reason: "unverifiable",
        runtime,
        hint: `\`${runtime} run --help\` exited ${help.code}, so ompd refuses to read confinement flags out of a command that failed rather than trusting the option list it printed; run it by hand and read the error (${firstLine(help.stderr) || firstLine(help.stdout) || "no output"})`,
      };
    }
    const capability = capabilityFromHelp(runtime, version, `${help.stdout}\n${help.stderr}`);
    return isCapability(capability)
      ? {
          ...capability,
          tmpfsOptions: facts.tmpfsOptions,
          networkNone: facts.networkNone,
          numericUser: facts.numericUser ?? capability.numericUser,
        }
      : capability;
  } catch (err) {
    return {
      reason: "unverifiable",
      runtime,
      hint: `\`${runtime} run --help\` could not be run (${String(err)}), so its confinement flags are unknown and provisioning refuses rather than guessing at them`,
    };
  }
}

function isCapability(probed: RuntimeCapability | RuntimeUnavailable): probed is RuntimeCapability {
  return !("reason" in probed);
}

/**
 * Why ompd refuses instead of trying the next runtime, per platform.
 *
 * Said out loud in the error because the behaviour is deliberate and looks like
 * a bug from the outside: an operator with Docker installed and working, told
 * that no container runtime is usable, will otherwise assume ompd failed to
 * find it. It did find it. It will not select it without being asked.
 */
function noFallbackNote(platform: string): string {
  if (platform === "darwin") {
    return "ompd will not fall back to Docker, OrbStack, Colima, or podman on darwin: walking a fallback order is what put an unpinned selection on Docker/OrbStack whenever Apple `container` answered `--version` with its apiserver down, and removing that dependency is the reason container hosts exist. Apple's `container` is at https://github.com/apple/container/releases, and `container system start` brings its apiserver up. To use a different runtime, ask for it: `OMPD_CONTAINER_RUNTIME=docker` or `OMPD_CONTAINER_RUNTIME=podman`.";
  }
  if (platform === "linux") {
    return "ompd will not fall back to Docker on linux, for the same reason it does not on darwin: an implicit move to a root daemon changes the security posture of every container it runs. To use it, ask for it: `OMPD_CONTAINER_RUNTIME=docker`.";
  }
  return "";
}

/**
 * The runtime to provision with, or a `ProvisionError` naming why none is.
 *
 * There is no fallback on either path. A pinned runtime is probed alone,
 * because the operator who pins the native runtime is pinning it to avoid
 * docker and quietly handing them docker takes away a choice they made
 * explicitly. An unpinned selection probes exactly one runtime per platform for
 * the same reason: the operator who installed ompd on a Mac to stop depending
 * on Docker did not ask for Docker either, and a fallback order gave it to them
 * whenever Apple's apiserver was down.
 *
 * The failure message carries the candidate's own reason and then says plainly
 * that no other runtime was tried and how to ask for one, because "no container
 * runtime is usable" reads as a discovery failure on a machine that visibly has
 * three of them installed.
 */
export async function selectRuntime(opts: ProbeOptions = {}): Promise<RuntimeCapability> {
  const run = opts.run ?? execCommand;
  const platform = opts.platform ?? process.platform;

  if (opts.pinned !== undefined) {
    if (!KNOWN_RUNTIMES.includes(opts.pinned)) {
      throw new ProvisionError(
        `pinned container runtime ${JSON.stringify(opts.pinned)} is not one ompd knows; valid runtimes are ${KNOWN_RUNTIMES.join(", ")}`,
        "container",
      );
    }
    const probed = await probeRuntime(opts.pinned, run, platform);
    if (isCapability(probed)) return probed;
    throw new ProvisionError(
      `pinned container runtime ${opts.pinned} is unusable (${probed.reason}): ${probed.hint}`,
      "container",
    );
  }

  const order = runtimeOrder(platform);
  if (order.length === 0) {
    throw new ProvisionError(
      `no container runtime is available on platform ${platform}; ompd selects ${DARWIN_RUNTIME_ORDER.join(", ")} on darwin and ${LINUX_RUNTIME_ORDER.join(", ")} on linux, and can be pinned with OMPD_CONTAINER_RUNTIME to any of ${KNOWN_RUNTIMES.join(", ")} on those platforms`,
      "container",
    );
  }

  const failures: string[] = [];
  for (const runtime of order) {
    const probed = await probeRuntime(runtime, run, platform);
    if (isCapability(probed)) return probed;
    failures.push(`${runtime} (${probed.reason}): ${probed.hint}`);
  }
  throw new ProvisionError(
    `no container runtime is usable on ${platform}: ${failures.join("; ")}. ${noFallbackNote(platform)}`,
    "container",
  );
}
