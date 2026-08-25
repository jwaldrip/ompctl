/**
 * Which container runtime to drive, and what that exact binary can confine.
 *
 * Two questions live here, and the code this replaces conflated them.
 *
 * The first is which runtime to use. The old probe walked
 * `["docker", "podman", "container"]` and took the first that answered
 * `--version`, which on a Mac with OrbStack installed is always docker: Apple's
 * native `container` could be installed, its apiserver running, and never once
 * selected. Order is per platform now, `DARWIN_RUNTIME_ORDER` prefers the
 * native runtime, and a pinned runtime is probed alone and never falls back. An
 * operator who pinned `container` and silently got docker has lost the thing
 * they asked for with nothing in the logs to say so, which is the failure this
 * module exists to make impossible.
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
 * refuses on the second rather than guessing which flags are safe to send.
 *
 * Liveness stays name-keyed, in `RUNTIME_FACTS`, because it genuinely is
 * per-runtime knowledge that no help text yields: `container system status`
 * prints `apiserver is running`, docker and podman answer `info`. That table is
 * also the registry of runtimes ompd will touch at all, so a runtime cannot be
 * added to an order list without someone writing down how to check its service
 * and how to install it.
 *
 * `tmpfsOptions` is the single capability that comes from that table rather
 * than from the parse, and the line it sits either side of is the whole point:
 * a flag the CLI rejects is visible in `run --help`, so it must be probed,
 * while a flag the CLI parses and then ignores is invisible to help and can
 * only ever be recorded knowledge with evidence attached. Its own comment
 * carries what was run to establish each value.
 *
 * What is verified and what is not: the docker 29.4.0, podman 4.8.2, and
 * `container` 0.4.1 help fixtures under `packages/daemon/test/fixtures/
 * runtime-help/` were captured from those binaries on this machine, as were the
 * three `--version` lines quoted in `versionFrom`. The 1.3.0 fixture is derived
 * from apple/container's own `docs/command-reference.md` at tag 1.3.0, not from
 * a binary, so what this module claims about 1.3.0 is a documentation claim and
 * the fixture's filename says so. Nothing about 1.3.0 is hardcoded here either
 * way: it is only a test that the parser reads a newer CLI correctly.
 */

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
  /** True only when this CLI's own `--user` description documents a numeric uid. */
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
 * `unverifiable` is the fail-closed case: the CLI is there and answering, and
 * ompd still refuses because it could not read what its `run` accepts.
 */
export type RuntimeUnavailable =
  | { reason: "absent"; runtime: string; hint: string }
  | { reason: "service-down"; runtime: string; hint: string }
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
  /** What to tell an operator whose runtime is installed but not answering. */
  down: string;
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
}

/**
 * Per-runtime knowledge that no help text can supply.
 *
 * Liveness, install advice, and the one capability a help text cannot express.
 * Confinement flags deliberately do not live here: see this file's header for
 * why keying those on a name is the bug this module exists to fix.
 */
const RUNTIME_FACTS: Record<string, RuntimeFacts> = {
  container: {
    install: "`container` is not on ompd's PATH; install a release from https://github.com/apple/container/releases",
    liveness: ["system", "status"],
    expect: "apiserver is running",
    down: "`container` is installed but its apiserver is not answering; run `container system start`",
    tmpfsOptions: false,
    networkNone: false,
  },
  podman: {
    install: "`podman` is not on ompd's PATH; install it with `brew install podman` or your package manager",
    liveness: ["info"],
    down: "`podman info` failed; on macOS the VM has to be up, so run `podman machine start`",
    tmpfsOptions: true,
    networkNone: true,
  },
  docker: {
    install: "`docker` is not on ompd's PATH; install Docker Desktop, OrbStack, Colima, or Rancher Desktop",
    liveness: ["info"],
    down: "`docker info` failed; the docker daemon is not running, so start Docker Desktop, OrbStack, or Colima",
    tmpfsOptions: true,
    networkNone: true,
  },
};

/**
 * Every runtime ompd will touch, derived from `RUNTIME_FACTS` so the two cannot
 * drift. Adding a runtime means writing down how to check its service and how
 * to install it, in one place, or it is not known at all.
 */
export const KNOWN_RUNTIMES: readonly string[] = Object.keys(RUNTIME_FACTS);

/**
 * Native first on macOS. Apple's `container` runs each container in its own
 * lightweight VM with no shared host kernel, and it needs no daemon an operator
 * has to remember to start, so preferring it over a docker CLI that OrbStack,
 * Colima, and Rancher all provide is both the safer and the likelier-to-work
 * choice. Docker last, not absent: it is still the only one of the three with
 * the full set of confinement flags.
 */
export const DARWIN_RUNTIME_ORDER: readonly string[] = ["container", "podman", "docker"];

/**
 * Apple's `container` is macOS only, so linux has two. Podman first because it
 * needs no root daemon; both accept the same confinement flags.
 */
export const LINUX_RUNTIME_ORDER: readonly string[] = ["podman", "docker"];

/** Probe order for a platform, empty where ompd knows no runtime at all. */
export function runtimeOrder(platform: string): readonly string[] {
  if (platform === "darwin") return DARWIN_RUNTIME_ORDER;
  if (platform === "linux") return LINUX_RUNTIME_ORDER;
  return [];
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
 * 1.3.0 adds `(format: name|uid[:gid])`.
 *
 * `tmpfsOptions` is the one field a help text cannot answer, so this pure
 * function reports the docker-shaped majority and `probeRuntime` overrides it
 * from `RUNTIME_FACTS`. Defaulting keeps the function total, and the override
 * is where the verified exception lives.
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
 * The only thing this adds to the parse is `tmpfsOptions`, which no help text
 * can answer: a suffixed `--tmpfs` that parses and mounts nothing looks exactly
 * like one that works.
 */
export async function probeRuntime(
  runtime: string,
  run: CommandRunner = execCommand,
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
    if (!up) return { reason: "service-down", runtime, hint: facts.down };
  } catch {
    // The CLI answered `--version` a moment ago and cannot be started now.
    // Whatever moved, the operator's next step is the same one.
    return { reason: "service-down", runtime, hint: facts.down };
  }

  try {
    // Both streams: docker prints `run --help` on stdout, and a CLI that put it
    // on stderr would otherwise look like a runtime with no options at all.
    const help = await run([runtime, "run", "--help"]);
    const capability = capabilityFromHelp(runtime, version, `${help.stdout}\n${help.stderr}`);
    return isCapability(capability)
      ? { ...capability, tmpfsOptions: facts.tmpfsOptions, networkNone: facts.networkNone }
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
 * The runtime to provision with, or a `ProvisionError` naming why none is.
 *
 * A pinned runtime is probed alone and never falls back. Falling back is the
 * one behaviour this module must not have: the operator who pins the native
 * runtime is pinning it to avoid docker, and quietly handing them docker takes
 * away a choice they made explicitly and tells them nothing.
 *
 * Without a pin, the failure message carries every candidate and its own
 * reason, because "no container runtime found" sends an operator hunting for an
 * install when the actual problem is a service they need to start.
 */
export async function selectRuntime(opts: ProbeOptions = {}): Promise<RuntimeCapability> {
  const run = opts.run ?? execCommand;

  if (opts.pinned !== undefined) {
    if (!KNOWN_RUNTIMES.includes(opts.pinned)) {
      throw new ProvisionError(
        `pinned container runtime ${JSON.stringify(opts.pinned)} is not one ompd knows; valid runtimes are ${KNOWN_RUNTIMES.join(", ")}`,
        "container",
      );
    }
    const probed = await probeRuntime(opts.pinned, run);
    if (isCapability(probed)) return probed;
    throw new ProvisionError(
      `pinned container runtime ${opts.pinned} is unusable (${probed.reason}): ${probed.hint}`,
      "container",
    );
  }

  const platform = opts.platform ?? process.platform;
  const order = runtimeOrder(platform);
  if (order.length === 0) {
    throw new ProvisionError(
      `no container runtime is available on platform ${platform}; ompd drives ${DARWIN_RUNTIME_ORDER.join(", ")} on darwin and ${LINUX_RUNTIME_ORDER.join(", ")} on linux`,
      "container",
    );
  }

  const failures: string[] = [];
  for (const runtime of order) {
    const probed = await probeRuntime(runtime, run);
    if (isCapability(probed)) return probed;
    failures.push(`${runtime} (${probed.reason}): ${probed.hint}`);
  }
  throw new ProvisionError(`no container runtime is usable on ${platform}: ${failures.join("; ")}`, "container");
}
