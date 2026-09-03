/**
 * The container backend.
 *
 * A detached container is started from a base image with the workspace mounted
 * at the same absolute path it has on the host, so a cwd the daemon hands to
 * `session/new` means the same thing on both sides. An operator may name
 * further host directories in `spec.mounts`; each lands at that same identical
 * absolute path inside, for the same reason. The ACP transport is
 * `<runtime> exec -i <id> <omp>`: a duplex byte stream, exactly like the local
 * pipe, which is why the supervisor needs to know nothing about this.
 *
 * The approval gate is preserved, not reimplemented. `spawn` delegates to
 * `spawnLocalHost` with `ompPath` pointing at a generated wrapper, so
 * `spawnLocalHost` still writes the overlay and still passes its own
 * `--config`. ompd never passes `--config` and never authors the overlay.
 *
 * Two things about that are load-bearing here rather than in
 * `gate-wrapper.ts`, which explains why. The overlay is delivered by mounting
 * a daemon-side directory read-only at `GATE_MOUNT`, never by writing into the
 * container. And a container serves exactly ONE ACP connection: the `spawn`
 * closure refuses a second, because the substitution attack that mode replaces
 * needs a process already running inside the container, and the first
 * connection's agent is how one gets there.
 *
 * Two things this file used to get wrong, both of which cost an operator a
 * working sandbox rather than merely a warning.
 *
 * It chose a runtime by taking whichever of `docker`, `podman`, `container`
 * answered `--version` first. On a Mac with Docker installed that is always
 * Docker, so Apple's native runtime was never selected even when it was
 * present and working, and an operator had no way to ask for it. Selection now
 * lives in `runtime.ts`: platform-ordered, pinnable, and fail-closed, so a
 * pinned runtime that is missing is an error rather than a quiet downgrade to
 * whatever else happened to be installed.
 *
 * It also decided confinement from a table keyed on the runtime's *name*. That
 * is not a property of a name: Apple `container` 0.4.1 rejects `--cap-drop`,
 * `--read-only`, `--pids-limit` and `--security-opt` outright (exit 64,
 * `Unknown option`), while 1.3.0 accepts the first two and `--ulimit`. One
 * table entry cannot be true for both, and the failure mode of getting it
 * wrong is silently withholding a real security control. Capability is now
 * derived from the binary's own `run --help` by `runtime.ts` and arrives here
 * as a `RuntimeCapability`; this file sends a flag if and only if that
 * capability says the flag exists.
 *
 * The same table also hid a third defect that no amount of gating the four
 * flags would have caught: `--user <uid>:<gid>` was appended unconditionally,
 * and Apple's `--user` takes a name. Feeding it `501:20` does not produce a
 * usage error, it kills the container (`XPC connection error: Connection
 * interrupted`). So the Apple path could never have provisioned at all. The
 * numeric user flag is now gated on `capability.numericUser`, which is true
 * only when that CLI's own `--user` description documents a numeric uid.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import { spawnLocalHost } from "@ompd/acp";
import { type HostKind, type HostMount, type HostSpec, resolveMountPath } from "@ompd/core";
import { execCommand } from "./exec.ts";
import { type GateWrapper, requireSafePath, writeGateWrapper } from "./gate-wrapper.ts";
import { GUEST_HOME_MOUNT, type GuestModelAccess, seedGuestHome } from "./guest-config.ts";
import { type EnsureToolchainOptions, ensureToolchain, type ResolvedToolchain } from "./image.ts";
import { type RuntimeCapability, selectRuntime } from "./runtime.ts";
import {
  type CommandRunner,
  type GuestBridge,
  type HostHandle,
  type ModelAccessProvider,
  ProvisionError,
  type ProvisionerBackend,
  type SpawnHost,
} from "./types.ts";

/**
 * Where the container's scratch tmpfs is mounted.
 *
 * omp's own scratch, not ompd's. ompd used to keep a per-host directory under
 * here for the approval-gate overlay; it does not any more, because a path the
 * container can write is not somewhere the gate can live. See `GATE_MOUNT`.
 */
const DEFAULT_SCRATCH_ROOT = "/tmp";

/**
 * Where the daemon's gate directory appears inside the container.
 *
 * Not under the scratch tmpfs and not under the toolchain mount, because it
 * must not be shadowed by either of them. `/run` exists in the base images
 * used here, and both runtimes create the mount point themselves even under
 * docker's `--read-only` root: verified by reading the overlay back from inside
 * a container started with the full docker flag set.
 */
const GATE_MOUNT = "/run/ompd-gate";

/**
 * Memory and CPU ceiling for a container host.
 *
 * Sent only where the capability reports the flags, but worth stating why they
 * are here at all: Apple `container` rejects `--pids-limit`, so on that runtime
 * these two are the *only* resource ceiling available. Without them a runaway
 * build inside a sandbox is bounded by nothing but the host.
 */
const DEFAULT_MEMORY = "4g";
const DEFAULT_CPUS = "4";

/** What a runtime may return as a container id. Apple returns a UUID, docker a hash. */
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export interface ContainerBackendOptions {
  /** Pin a runtime instead of probing in platform order. */
  runtime?: string;
  /**
   * Skip the probe entirely and use this capability.
   *
   * The seam the unit tests drive: capability is otherwise derived from a real
   * `run --help`, and the fixtures behind that live in `container-runtime.test.ts`.
   */
  capability?: RuntimeCapability;
  /**
   * Default image when the spec names none. Comes from the daemon's
   * `containerImage` config field, which is the only surface that can name one:
   * a paired device cannot, because an image's ENTRYPOINT runs before the
   * approval gate exists.
   */
  image?: string;
  /** Host directory mounted into the container at the same absolute path. */
  workspace?: string;
  /** Directory inside the container for ompd's scratch. */
  scratchRoot?: string;
  /** Where the mounted toolchain is cached. Defaults to `~/.ompd/toolchain`. */
  toolchainRoot?: string;
  /** Overrides `process.platform` for selection order. */
  platform?: string;
  /**
   * The daemon's own state directory. Never mountable: it holds the pairing
   * token and the audit trail an operator relies on to catch a sandbox doing
   * something it should not, so handing it to the sandbox defeats the point
   * of having one. Defaults to `~/.ompd`, the same default the daemon itself
   * uses when nothing overrides it.
   */
  home?: string;
  /**
   * How this container gets a model, and how it loses it again.
   *
   * Optional only because the unit tests and the cloud/local paths have no
   * broker to hand over. When it IS present, it is not best-effort: a grant
   * that fails fails the provision. The alternative is the defect this exists
   * to remove, which is a container agent that reaches `idle` with a live ACP
   * session and then answers every prompt with "No model selected".
   */
  modelAccess?: ModelAccessProvider;
  run?: CommandRunner;
  spawn?: SpawnHost;
  /** Toolchain resolution seam, so tests never download or extract anything. */
  toolchain?: (opts: EnsureToolchainOptions) => Promise<ResolvedToolchain>;
}

interface ContainerRecord {
  runtime: string;
  containerId: string;
  /**
   * Removed after the container, which is the only order that works. `null`
   * when the host ran with no network, so nothing was created to reclaim.
   */
  network: string | null;
  wrapper: GateWrapper;
  /**
   * The daemon-side directory the container has mounted read-only, holding the
   * approval-gate overlay. Removed on teardown: it is the overlay the daemon
   * wrote for this host, and nothing else should be able to read it once the
   * host is gone.
   */
  gateDir: string;
  /**
   * The daemon-side directory mounted as the guest's `HOME`, or `null` when
   * the host was provisioned with no model access. Removed on teardown for a
   * stronger reason than the gate directory: it holds the guest's bearer.
   */
  guestHome: string | null;
  /**
   * The bearer the broker issued for this container, held in memory only.
   *
   * Never written to `HostRef.resolved`, because the store persists that. So
   * this field, and the ability to revoke the grant by name, does not survive
   * a daemon restart -- which is why a restart withdraws model access rather
   * than leaving a token live with nobody able to name it.
   */
  modelToken: string | null;
}

/**
 * Everything a failed `provision` has to undo, recorded as each thing comes
 * into existence.
 *
 * A mutable accumulator rather than a stack of cleanup closures, because the
 * unwind order is fixed and is not the reverse of the creation order: the grant
 * is created third and must be revoked first, and the network is created second
 * but can only be removed after the container that joined it. A closure stack
 * would encode the wrong order by construction.
 *
 * Every field starts `null` except `gateDir`, which is the first thing this
 * backend creates and therefore the reason the unwind exists at all. A field is
 * filled at the moment the resource behind it exists, never before, so the
 * unwind can only ever be asked to remove something real.
 */
interface ProvisionUnwind {
  /** The runtime whose CLI removes the container and the network. */
  runtime: string;
  /** The daemon-side gate directory. Always set: it is created first. */
  gateDir: string;
  /** The network this provision created, or `null` under a `"none"` policy. */
  network: string | null;
  /** The bearer the broker minted for this container, or `null` if none was. */
  token: string | null;
  /** The seeded guest home holding that bearer, or `null` if none was seeded. */
  guestHome: string | null;
  /** The container id, set only once it passed `CONTAINER_ID`. */
  containerId: string | null;
}

/**
 * Remove a daemon-side directory this backend created, best effort.
 *
 * Best effort because the alternative is worse: a failure here would mask the
 * error that made us unwind in the first place, and a leftover directory under
 * the temp root is litter rather than a live container nobody has reclaimed.
 */
function discard(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Litter, not a risk.
  }
}

/**
 * Resolve a mount to the canonical path that will be mounted, or refuse it.
 *
 * Delegates to `resolveMountPath`, which canonicalizes before deciding. The
 * order is the whole point and the reason this no longer calls
 * `dangerousMountReason` directly: the old code applied policy to the
 * operator's literal string, so `/Users/<name>/.` and `/Users/<name>/..` and
 * `//Users/<name>` all slipped past a rule that only recognised
 * `/Users/<name>`, and the review demonstrated `/Users/jwaldrip/.` being
 * mounted read-write, home directory and `~/.ssh` and `~/.ompd` included.
 *
 * The CANONICAL path is what goes into argv. Mounting the operator's original
 * string would reintroduce the same hole one layer down, because the runtime
 * would resolve it again on the far side.
 */
function resolveMount(hostPath: string, home: string): string {
  const resolution = resolveMountPath(hostPath, { home, mustExist: true });
  if (!resolution.ok) {
    throw new ProvisionError(`refusing to mount ${hostPath}: ${resolution.reason}`, "container");
  }
  return resolution.path;
}

/**
 * Refuse an image reference the runtime would read as a flag.
 *
 * `spec.image` reaches argv as the image positional, and a `-`-prefixed value
 * is consumed as a flag there: `spec.image: "--privileged"` produces
 * `... --privileged tail -f /dev/null`, which makes `tail` the image name. That
 * is denial-shaped rather than privilege-shaped, because the command word is
 * eaten as the image, but an unchecked field reaching argv is worth closing at
 * both ends. The gateway validates it too; this is the backend's own guard, so
 * a caller that is not the gateway cannot skip it.
 */
function refuseIfFlagShaped(image: string): void {
  if (image.startsWith("-")) {
    throw new ProvisionError(
      `refusing image reference ${JSON.stringify(image)}: an image reference cannot begin with a dash, ` +
        `the runtime would read it as a flag rather than an image`,
      "container",
    );
  }
}

/**
 * Hostname a Docker Desktop guest resolves to the host it runs on.
 *
 * Docker's own, injected by the Desktop VM's resolver rather than by anything
 * ompd does. Not available on Linux docker, where it is also not needed
 * because the bridge gateway is a real host interface.
 */
const DOCKER_HOST_ALIAS = "host.docker.internal";

/**
 * Addresses that are never a usable answer from `network inspect`.
 *
 * A wildcard reaching the broker would bind a listener on every interface,
 * which the design forbids outright: the whole containment argument for the
 * bridge shape is that only containers on that one network can reach it.
 * `0.0.0.0` was measured reachable from every container network AND the host
 * LAN. So a runtime that reports one is treated as reporting nothing, and the
 * provision refuses with a reason rather than widening silently.
 */
const WILDCARD_ADDRESSES: Record<string, true> = { "0.0.0.0": true, "::": true, "[::]": true, "*": true };

/**
 * A `network inspect` address this backend is willing to act on, or null.
 *
 * Four call sites need the same answer in lockstep, and the rule it applies is
 * not obvious from the expression: an empty string and a wildcard are both
 * "the runtime told us nothing usable", and the wildcard case is a security
 * decision rather than a tidiness one.
 */
function usableAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || WILDCARD_ADDRESSES[trimmed] === true ? null : trimmed;
}

/**
 * What a runtime's `network inspect` said, in whichever shape it says it.
 *
 * Two spellings, both parsed, because the runtimes disagree and the difference
 * is not cosmetic. Apple `container` 0.4.1, measured:
 * `[{"status":{"gateway":"192.168.65.1","address":"192.168.65.0/24"}, ...}]`.
 * Docker and podman: `[{"IPAM":{"Config":[{"Gateway":"172.17.0.1",
 * "Subnet":"172.17.0.0/16"}]}, ...}]`.
 *
 * Both answer immediately after `network create`, before any container has
 * run, which is what makes the grant-then-bind ordering in `provision`
 * possible: the guest's config has to name an endpoint before the container
 * that reads it starts, and BINDING that address does not work until a
 * container is attached to the network.
 *
 * Nothing here guesses. Subnets are handed out in network creation order and
 * have nothing to do with the network's name, so the second container on a
 * machine gets a different subnet from the first. A hardcoded `192.168.65.1`
 * would work once and then hand a container an address belonging to another,
 * so no default exists anywhere in this path.
 */
async function inspectNetwork(
  run: CommandRunner,
  runtime: string,
  network: string,
): Promise<{ gateway: string | null; cidr: string | null }> {
  const unknown = { gateway: null, cidr: null };
  const inspected = await run([runtime, "network", "inspect", network]).catch(() => null);
  if (inspected === null || inspected.code !== 0) return unknown;

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch {
    return unknown;
  }
  const first: unknown = Array.isArray(parsed) ? parsed[0] : undefined;
  if (typeof first !== "object" || first === null) return unknown;

  // Apple's spelling first, and narrowed rather than asserted onto. Docker
  // answers this same key with a literal `null` rather than omitting it,
  // measured on docker 29.4.0, so `"status" in first` is true there and a cast
  // to `{ status?: { gateway?: unknown } }` would sail straight past it and
  // then read `.gateway` off `null`.
  if ("status" in first) {
    const status = first.status;
    if (typeof status === "object" && status !== null && "gateway" in status) {
      const gateway = usableAddress(status.gateway);
      if (gateway !== null) {
        return { gateway, cidr: "address" in status ? usableAddress(status.address) : null };
      }
    }
  }

  // The OCI spelling, shared by docker and podman. Measured on docker 29.4.0:
  // `{"IPAM":{"Config":[{"Subnet":"192.168.147.0/24","Gateway":"192.168.147.1"}]}}`.
  if ("IPAM" in first) {
    const ipam = first.IPAM;
    if (typeof ipam === "object" && ipam !== null && "Config" in ipam && Array.isArray(ipam.Config)) {
      const entry: unknown = ipam.Config[0];
      if (typeof entry === "object" && entry !== null && "Gateway" in entry) {
        const gateway = usableAddress(entry.Gateway);
        if (gateway !== null) {
          return { gateway, cidr: "Subnet" in entry ? usableAddress(entry.Subnet) : null };
        }
      }
    }
  }
  return unknown;
}

/**
 * Whether podman is running rootless, which decides whether its bridge gateway
 * is an address this host can bind.
 *
 * Rootful podman creates a real bridge on the host, exactly like docker on
 * Linux. Rootless podman does not: its network lives in a user namespace
 * behind slirp4netns or pasta, and the gateway `network inspect` reports is
 * inside that namespace, so a listener on the host can never bind it and a
 * guest can never reach one that did. Getting this backwards would hand a
 * container an endpoint nothing answers, so every uncertain answer -- probe
 * failed, output unparseable, field absent -- is reported as rootless.
 *
 * `podman info` is the runtime's own answer to this question rather than an
 * inference from uid, which matters because ompd can be running as a different
 * user from the podman that will create the network.
 */
async function podmanIsRootless(run: CommandRunner, runtime: string): Promise<boolean> {
  const info = await run([runtime, "info", "--format", "json"]).catch(() => null);
  if (info === null || info.code !== 0) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(info.stdout);
  } catch {
    return true;
  }
  if (typeof parsed !== "object" || parsed === null || !("host" in parsed)) return true;
  const host = parsed.host;
  if (typeof host !== "object" || host === null || !("security" in host)) return true;
  const security = host.security;
  if (typeof security !== "object" || security === null || !("rootless" in security)) return true;
  return typeof security.rootless === "boolean" ? security.rootless : true;
}

/**
 * Work out how, if at all, a guest on this network can reach a listener on this
 * host.
 *
 * Three shapes, and which one applies is a property of the runtime AND the
 * host platform rather than of either alone. That is a different claim from the
 * one `runtime.ts` refuses to make: confinement flags are not derivable from a
 * runtime's name and are therefore read off `run --help`, but no `--help` text
 * says whether this binary's bridge lives in a VM. Docker Desktop on macOS and
 * docker on Linux are the same CLI, the same flags and the same `network
 * inspect` shape, and only one of them puts the gateway on a host interface.
 * So this decides from the name plus the platform, and says why each time.
 *
 * `unsupported` is a first-class answer rather than an error. It carries a
 * reason written for an operator, and the provider turns it into a refusal:
 * there is no branch anywhere that provisions a container without model access
 * once a provider is configured.
 */
async function resolveGuestBridge(input: {
  run: CommandRunner;
  runtime: string;
  platform: string;
  network: string | null;
}): Promise<GuestBridge> {
  const { run, runtime, platform, network } = input;

  // A `"none"` policy created nothing to reach the host over, and that is a
  // refusal rather than a missing address: an agent on a sealed network cannot
  // reach a model endpoint by any route.
  if (network === null) {
    return {
      kind: "unsupported",
      reason:
        `this host was asked for a "none" network policy, so no bridge exists and nothing on it can reach a ` +
        `model endpoint. Ask for the "isolated" policy, or provision without model access.`,
    };
  }

  // Docker Desktop runs the engine inside a Linux VM, so the bridge gateway
  // `network inspect` reports is an address in that VM and not on this host.
  // Binding it fails, and a guest pointed at it reaches the VM's own bridge
  // rather than ompd. The guest CAN reach the host by Docker's injected alias,
  // so the broker binds loopback and the guest is given the name. Peers arrive
  // NAT'd through the VM on that path, which is why the peer-address check is
  // not available under this shape and `host-alias` exists to say so instead
  // of quietly weakening a check the other shapes still enforce.
  if (runtime === "docker" && platform !== "linux") {
    return { kind: "host-alias", hostname: DOCKER_HOST_ALIAS, bindHost: "127.0.0.1" };
  }

  // Podman off Linux is `podman machine`, which is a VM for the same reasons,
  // but podman injects no equivalent of Docker's alias that has been measured
  // here. Refused rather than guessed at.
  if (runtime === "podman" && platform !== "linux") {
    return {
      kind: "unsupported",
      reason:
        `podman on ${platform} runs its engine inside a \`podman machine\` VM, so the bridge gateway is not an ` +
        `address this host can bind, and no host alias has been established for it. Use Apple \`container\` on ` +
        `darwin, or docker, or run ompd on the same Linux host as a rootful podman.`,
    };
  }

  if (runtime === "podman" && (await podmanIsRootless(run, runtime))) {
    return {
      kind: "unsupported",
      reason:
        `this podman is rootless (or would not answer \`podman info\`), so the gateway it reports for a network ` +
        `lives inside a user namespace and cannot be bound from this host. Rootful podman on Linux is supported; ` +
        `rootless is refused rather than given an endpoint nothing can listen on.`,
    };
  }

  const { gateway, cidr } = await inspectNetwork(run, runtime, network);
  if (gateway === null || cidr === null) {
    return {
      kind: "unsupported",
      reason:
        `${runtime} reported no usable gateway for network ${network}: \`${runtime} network inspect\` returned ` +
        `neither Apple's \`status.gateway\`/\`status.address\` nor the OCI \`IPAM.Config[0].Gateway\`/\`Subnet\` ` +
        `shape. Without an address the guest can reach, model access cannot be provisioned.`,
    };
  }
  return { kind: "host-bridge", gateway, cidr };
}

/**
 * Whether a failed `rm` means the container was already gone.
 *
 * Reconciliation after a restart removes hosts the store still lists, and some
 * of those are legitimately absent: the operator removed the container by hand,
 * or the whole machine rebooted. Treating that as an error would make startup
 * noisy and would stop reconciliation clearing the rest of the list, so it is
 * folded into success. A runtime that answered and refused for any other reason
 * still throws, because that is a container nobody has reclaimed.
 *
 * Matched on the runtimes' own wording, quoted from each: Apple `container`
 * says `notFound`, docker says `No such container`, podman says
 * `no such container`.
 */
function isAlreadyGone(stderr: string): boolean {
  const text = stderr.toLowerCase();
  return text.includes("no such container") || text.includes("notfound") || text.includes("not found");
}

/**
 * The confinement flags this runtime's CLI actually accepts.
 *
 * Nothing an ACP host does needs a Linux capability; none can be regained
 * afterwards because no-new-privileges blocks setuid; a fork bomb in a sandbox
 * should not take the operator's machine with it. All of that holds only on a
 * runtime that can express it. A flag absent from the capability was never
 * sent, which is not the same as having held, and `docs/running.md` reports the
 * difference per runtime rather than rounding every runtime up to docker.
 *
 * The three that Apple's runtime lacks (`--cap-drop`, `--security-opt`,
 * `--pids-limit`) all mitigate a shared-kernel escape, and Apple gives each
 * container its own lightweight VM, so their absence there is a different
 * boundary rather than a hole in this one. `--read-only` is not that: it is
 * whether the image itself can be rewritten from inside, and losing it is a
 * real loss whichever kernel the container has.
 */
function confinementArgs(cap: RuntimeCapability): string[] {
  const args: string[] = [];
  if (cap.capDrop) args.push("--cap-drop", "ALL");
  if (cap.securityOpt) args.push("--security-opt", "no-new-privileges:true");
  if (cap.readOnly) args.push("--read-only");
  if (cap.pidsLimit) args.push("--pids-limit", "1024");
  if (cap.memoryLimit) args.push("--memory", DEFAULT_MEMORY);
  if (cap.cpuLimit) args.push("--cpus", DEFAULT_CPUS);

  // The daemon's own ids rather than a name baked into the image, because the
  // workspace arrives as a bind mount owned by whoever runs the daemon: a
  // container running as anyone else could not write to the directory it was
  // given, and one running as root would leave root-owned files in the
  // operator's repository.
  //
  // Sent only where the CLI documents a numeric uid for `--user`. On Apple's
  // runtime it does not, and neither concern applies there anyway: virtiofs
  // squashes ownership, so a file the container creates in a mount lands owned
  // by the host user whether the container ran as root or as nobody.
  if (cap.numericUser) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined) args.push("--user", `${uid}:${gid}`);
  }
  return args;
}

/**
 * The scratch tmpfs, spelled the way this runtime actually honours.
 *
 * `exec` is on because omp unpacks and runs native helpers out of its own
 * scratch; withholding it would break the binary without bounding anything,
 * since the agent can already run commands from the workspace by design.
 *
 * The option suffix is gated because Apple `container` 0.4.1 *parses*
 * `--tmpfs /scratch:rw,exec,...`, exits 0, and then mounts nothing at all:
 * `ls -ld /scratch` reports no such file. A bare path mounts real tmpfs there.
 * Docker needs the suffix to get exec, size and mode. A flag that succeeds and
 * does nothing is worse than one that errors, so this is the one property here
 * that cannot be read off `run --help` and is recorded knowledge instead.
 */
function tmpfsArgs(cap: RuntimeCapability, scratchRoot: string): string[] {
  return cap.tmpfsOptions
    ? ["--tmpfs", `${scratchRoot}:rw,exec,nosuid,nodev,size=1g,mode=1777`]
    : ["--tmpfs", scratchRoot];
}

export class ContainerBackend implements ProvisionerBackend {
  readonly kind: HostKind = "container";

  #runtime: string | undefined;
  #capability: RuntimeCapability | undefined;
  #image: string | undefined;
  #workspace: string;
  #scratchRoot: string;
  #toolchainRoot: string | undefined;
  #platform: string | undefined;
  #home: string;
  #modelAccess: ModelAccessProvider | undefined;
  #run: CommandRunner;
  #spawn: SpawnHost;
  #toolchain: (opts: EnsureToolchainOptions) => Promise<ResolvedToolchain>;
  #live = new Map<string, ContainerRecord>();

  constructor(opts: ContainerBackendOptions = {}) {
    this.#runtime = opts.runtime;
    this.#capability = opts.capability;
    this.#image = opts.image;
    this.#workspace = opts.workspace ?? process.cwd();
    this.#scratchRoot = opts.scratchRoot ?? DEFAULT_SCRATCH_ROOT;
    this.#toolchainRoot = opts.toolchainRoot;
    this.#platform = opts.platform;
    this.#home = opts.home ?? join(homedir(), ".ompd");
    this.#modelAccess = opts.modelAccess;
    this.#run = opts.run ?? execCommand;
    this.#spawn = opts.spawn ?? spawnLocalHost;
    this.#toolchain = opts.toolchain ?? ensureToolchain;
  }

  async provision(spec: HostSpec): Promise<HostHandle> {
    if (spec.kind !== "container") {
      throw new ProvisionError(`container backend cannot serve a ${spec.kind} host`, spec.kind);
    }

    // Validated before anything is created, so a refused mount costs nothing
    // to clean up. The reason lands on the same "host.provision" audit entry
    // `HostProvisioner` already writes for any provision failure -- nothing
    // new to wire, because a thrown `ProvisionError` is already audited there.
    //
    // `hostPath` is replaced by its canonical form, not merely checked, so the
    // `HostRef` an operator reads back names the directory that was actually
    // mounted rather than the string they typed.
    const mounts: HostMount[] = (spec.mounts ?? []).map(mount => ({
      hostPath: resolveMount(mount.hostPath, this.#home),
      mode: mount.mode ?? "ro",
    }));
    if (spec.image !== undefined) refuseIfFlagShaped(spec.image);

    // Capability, not a name. `selectRuntime` throws a `ProvisionError` naming
    // every candidate and its specific reason, so "not installed" and
    // "installed but its service is down" read differently and each says what
    // to run next.
    const cap =
      this.#capability ?? (await selectRuntime({ run: this.#run, platform: this.#platform, pinned: this.#runtime }));
    const runtime = cap.runtime;

    // The base image and, on the default path, a host directory holding omp
    // that gets bind-mounted read-only. Nothing here touches a private
    // registry: that is the whole point, since a denied pull from
    // `ghcr.io/jwaldrip/omp:latest` is what made every container provision
    // fail before.
    const toolchain = await this.#toolchain({
      runtime,
      // Handed over rather than re-probed. The CA extraction runs its own
      // confined container and needs to know which confinement flags this
      // runtime accepts; the answer is already in scope here, and probing again
      // inside `image.ts` would re-run `--version`, the liveness check and
      // `run --help` for facts the caller already holds.
      capability: cap,
      spec,
      run: this.#run,
      cacheRoot: this.#toolchainRoot,
      envImage: this.#image,
    });

    const env: string[] = [];
    for (const [key, value] of Object.entries(toolchain.env)) env.push("--env", `${key}=${value}`);
    if (spec.repo !== undefined) env.push("--env", `OMPD_REPO=${spec.repo}`);
    if (spec.ref !== undefined) env.push("--env", `OMPD_REF=${spec.ref}`);

    // A network policy the runtime can actually enforce, or a refusal.
    //
    // `"none"` is refused outright where the runtime cannot express it, rather
    // than approximated. On Apple `container` the tempting approximation is
    // `--no-dns`, and it is a false one: all it does is delete
    // `/etc/resolv.conf`, and under it `ping 1.1.1.1` and `ping 8.8.8.8` both
    // still succeed. Accepting the request and sending that flag would report a
    // sealed container while handing the agent open egress, which is worse than
    // saying no.
    const policy = spec.network ?? "isolated";
    if (policy === "none" && !cap.networkNone) {
      throw new ProvisionError(
        `${runtime} ${cap.version} cannot express a container with no network, so a "none" policy is refused ` +
          `rather than approximated: it has no \`none\` network, and \`--no-dns\` only removes the resolver ` +
          `while leaving IP egress open. Use a runtime that supports \`--network none\`, or ask for "isolated".`,
        "container",
      );
    }

    // The gate directory, created on the daemon's own filesystem before
    // anything else exists, because it becomes a mount source in the `run`
    // argv below.
    //
    // Validated here rather than at render time, which is what
    // `requireSafePath` is exported for. `mkdtemp` under a hostile `TMPDIR`
    // could produce a path the wrapper would have to quote for, and finding
    // that out after the container had already been started with that path as
    // a mount source would be too late.
    const gateDir = mkdtempSync(join(tmpdir(), "ompd-gate-"));
    try {
      requireSafePath(gateDir, "gate directory", "container");
    } catch (err) {
      discard(gateDir);
      throw err;
    }

    // One unwind for every failure below this line, and the reason it is a
    // `try` rather than a cleanup call per branch.
    //
    // The explicit branches below unwind correctly when a step RETURNS a
    // nonzero exit code, and they always did. What none of them covered is a
    // step that THROWS. `this.#run` is a seam, and the default `execCommand`
    // rejects rather than exiting non-zero whenever the runtime binary cannot
    // be started -- which is exactly what happens when it has been moved,
    // upgraded or uninstalled since `selectRuntime` read its `run --help` a
    // few statements earlier. `resolveGuestBridge` is the same story one layer
    // in: `inspectNetwork` and `podmanIsRootless` each swallow a rejected
    // promise, but neither catches a runner that raises synchronously, and a
    // `CommandRunner` is only obliged to return a promise, not to be `async`.
    //
    // Before this accumulator, either rejection propagated straight past every
    // cleanup branch underneath it and left the worst combination available: a
    // LIVE grant, the guest's bearer still sitting in a daemon-side `mkdtemp`
    // directory, a network, and no container handle through which ordinary
    // teardown could ever find any of it, because the caller never received
    // one.
    //
    // The invariant, stated here so it survives the next edit: there is no
    // path out of `provision` that leaves a live grant, a bearer on disk, a
    // container, or a network behind. A failed provision leaves the machine as
    // it found it.
    const unwind: ProvisionUnwind = {
      runtime,
      gateDir,
      network: null,
      token: null,
      guestHome: null,
      containerId: null,
    };
    try {
      // Otherwise a network of its own, created before the container that joins
      // it.
      //
      // The default bridge puts every container on one segment, so an agent on
      // it can reach the operator's database, cache, and anything else they
      // happen to be running. Egress to the internet stays open because the
      // agent has to reach a model endpoint, and neither docker nor Apple's
      // runtime can express "this one host and nothing else" without a proxy in
      // the path. That is a real remaining exposure and `docs/running.md` says
      // so rather than implying this is a sealed box.
      //
      // Two names, because they are two things: what `--network` receives, and
      // what teardown has to remove. A `"none"` policy creates nothing, so there
      // is nothing to reclaim and `network rm none` must never be attempted.
      const createdNetwork = policy === "none" ? null : `ompd-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const networkArg = createdNetwork ?? "none";
      if (createdNetwork !== null) {
        // Recorded BEFORE the await, not after it, because a rejected `network
        // create` cannot tell us whether the network exists: `execCommand`
        // rejects only when the binary would not start, but any runner that
        // wraps a timeout around a live subprocess rejects with the network
        // already up. `#removeNetwork` is best effort, so recording it early
        // costs at most one swallowed nonzero exit for removing a name that was
        // never created, and NOT recording it early costs a leaked network.
        unwind.network = createdNetwork;
        const madeNetwork = await this.#run([runtime, "network", "create", createdNetwork]);
        if (madeNetwork.code !== 0) {
          throw new ProvisionError(
            `${runtime} network create failed (exit ${madeNetwork.code}): ${madeNetwork.stderr.trim()}`,
            "container",
          );
        }
      }

      // How a guest on this network can reach a listener on this host, decided
      // per runtime and per platform. `resolveGuestBridge` owns the three shapes
      // and why each applies; `GuestBridge` owns what each one costs.
      //
      // Resolved even under a `"none"` policy, because "sealed network" is one of
      // the answers rather than a reason to skip the question: it comes back
      // `unsupported` with a reason, and the provider turns that into the same
      // refusal every other unusable answer gets. Nothing is special-cased into a
      // silent skip, because a silent skip is how a container reaches idle
      // unable to answer.
      const bridge = await resolveGuestBridge({
        run: this.#run,
        runtime,
        platform: this.#platform ?? process.platform,
        network: createdNetwork,
      });

      // Model access, or no container at all.
      //
      // Never proceed to `container run` without model access when a provider is
      // configured: a container that cannot answer a prompt is the defect this
      // change exists to remove. Before this, a container agent reached `idle`
      // holding a live ACP session and then failed every single prompt with "No
      // model selected. Use /login, set an API key environment variable, or
      // create /root/.omp/agent/agent.db" -- advice that names three things the
      // operator cannot do from outside a sandbox. Failing the provision instead
      // costs the operator a container they were never going to be able to use,
      // and says why.
      //
      // Both failure shapes are fatal and both unwind the same way. A `null`
      // result means the provider is not configured to serve this container; a
      // throw means it tried and could not. There is no third branch that
      // provisions anyway, and no fallback to a local model or an invented
      // default: either would hand the operator an agent whose answers came from
      // somewhere they did not choose.
      //
      // Read into a local once, so `grant` and the `activate` below are provably
      // the same provider even though a `#`-private read is not narrowed across
      // the statements between them.
      const modelAccess = this.#modelAccess;
      let access: GuestModelAccess | null = null;
      if (modelAccess !== undefined) {
        try {
          access = await modelAccess.grant({ network: createdNetwork, bridge });
        } catch (err) {
          // The provider's own message names what is missing -- a config key, a
          // model that would not resolve, a bridge that does not exist -- so it
          // is carried through rather than replaced with a generic one. Cleanup
          // is the shared unwind's job; this branch only shapes the error.
          throw err instanceof ProvisionError
            ? err
            : new ProvisionError(`container model access could not be granted: ${String(err)}`, "container", {
                cause: err,
              });
        }
        if (access === null) {
          throw new ProvisionError(
            `container model access is not configured, so this container would reach idle unable to answer a ` +
              `prompt. Provisioning is refused rather than producing an agent that cannot work.`,
            "container",
          );
        }
        // The bearer enters the unwind the instant the broker mints it, and this
        // is the one line in the accumulator that has to be exact. A grant that
        // outlives the provision that asked for it is a credential nobody is
        // holding: the container it was minted for either never started or is
        // about to be removed, so nothing legitimate will ever present it again,
        // and it authenticates until its TTL expires.
        unwind.token = access.token;
      }

      // The guest's HOME, seeded on the daemon's filesystem before the container
      // that mounts it exists. `guest-config.ts` owns what goes in it, and why
      // the bearer lands in one 0600 file rather than in this argv.
      //
      // A failure here is the first point at which unwinding has to release the
      // grant as well: the broker has already minted a token, and leaving it live
      // for a container that will never start is a credential nobody is holding.
      let guestHome: string | null = null;
      if (access !== null) {
        try {
          guestHome = seedGuestHome({ access });
        } catch (err) {
          // `seedGuestHome` removes its own directory before it throws, so there
          // is nothing left on disk here and nothing to record; what has to be
          // unwound is the grant, which the accumulator is already holding.
          throw err instanceof ProvisionError
            ? err
            : new ProvisionError(`the container's guest home could not be seeded: ${String(err)}`, "container", {
                cause: err,
              });
        }
        unwind.guestHome = guestHome;
      }

      // Each named mount lands at the identical absolute path inside, the same
      // property `--volume workspace:workspace` already relies on. Read-only
      // unless the operator opted a path into "rw" explicitly.
      const mountArgs: string[] = [];
      for (const mount of mounts) {
        mountArgs.push("--volume", `${mount.hostPath}:${mount.hostPath}:${mount.mode}`);
      }
      // The toolchain, read-only. A write into it reports `Read-only file system`
      // on every runtime here. What is NOT true, and used to be claimed on this
      // line, is that the container cannot rewrite it: Apple rejects `--cap-drop`
      // and `--security-opt`, so its guest holds the full capability set and
      // `mount --bind /tmp/evil /opt/ompd` succeeds from inside. Measured: a
      // binary at that path printed `real-omp`, and after the bind mount the same
      // path printed `SUBSTITUTED-omp`. Under the flags docker and podman accept
      // the same container has `CapEff 0000000000000000` and both `mount -o
      // remount,rw` and `mount --bind` fail with `must be superuser`, so the
      // mount is a real boundary there and defence in depth on Apple.
      if (toolchain.toolsDir !== null) {
        mountArgs.push("--volume", `${toolchain.toolsDir}:${toolchain.mountPath}:ro`);
      }
      // The gate directory, read-only, for the same reasons and with the same
      // per-runtime caveat. `gate-wrapper.ts` owns why the overlay is delivered
      // this way rather than written into the container.
      mountArgs.push("--volume", `${gateDir}:${GATE_MOUNT}:ro`);
      // The seeded guest home, and the one mount this backend adds that is NOT
      // read-only.
      //
      // Read-write because omp writes into its own config directory as a matter
      // of course: `agent.db`, session state and caches all land beside the two
      // files seeded here, so a read-only mount would break omp at startup
      // rather than confine anything. The obvious narrower alternative -- mount
      // the individual config files read-only -- does not exist on this runtime:
      // Apple `container` rejects `--volume host_file:/a/b/f` with
      // `NSPOSIXErrorDomain Code=20 "Not a directory"`, so a directory is the
      // only channel there is.
      //
      // What the guest can therefore write into is a `mkdtemp` directory this
      // daemon created for this one container and removes on destroy. It is not
      // operator data, nothing else reads it, and nothing from `~/.omp` was
      // copied into it. The read-only rule this breaks exists to stop a guest
      // rewriting things the operator owns, and this directory is not one.
      //
      // Placed with the other `mountArgs` rather than given its own argv slot,
      // which is safe for two independent reasons: the argv below already
      // spreads `mountArgs` after `tmpfsArgs`, so this lands exactly where the
      // gate mount does; and `GUEST_HOME_MOUNT` shares a prefix with neither the
      // scratch tmpfs nor the toolchain mount, so no ordering the runtime could
      // choose lets one shadow the other.
      if (guestHome !== null) {
        mountArgs.push("--volume", `${guestHome}:${GUEST_HOME_MOUNT}`);
        // The mount does nothing on its own. Without this, omp reads the image's
        // own HOME, finds no provider, and every prompt fails with "No model
        // selected" -- the mount would be present and useless, which is the
        // hardest version of this to diagnose. No secret is in this value: it is
        // a path, and the bearer is in a 0600 file underneath it.
        env.push("--env", `HOME=${GUEST_HOME_MOUNT}`);
      }

      // `tail -f /dev/null` keeps the container alive so exec has something to
      // attach to, so the ACP host is not the container's main process. It serves
      // exactly one ACP connection all the same: see the `spawn` closure below.
      //
      // The one await in this function that can leave something behind the
      // accumulator cannot name. A rejection here -- the runtime binary gone
      // since the capability probe, a runner that wraps its own timeout -- may
      // have started a container whose id was never printed, and an id is the
      // only handle a `rm` takes. The unwind still revokes the grant, deletes the
      // bearer and attempts the network removal, and a container still attached
      // makes that removal fail, so the leftover `ompd-*` network is the visible
      // trace an operator is left to follow. That is as far as this can be
      // pushed: nothing in either runtime's CLI reports the id of a container
      // whose `run` never returned.
      const created = await this.#run([
        runtime,
        "run",
        "--detach",
        "--rm",
        "--network",
        networkArg,
        ...confinementArgs(cap),
        ...tmpfsArgs(cap, this.#scratchRoot),
        "--volume",
        `${this.#workspace}:${this.#workspace}`,
        ...mountArgs,
        "--workdir",
        this.#workspace,
        ...env,
        toolchain.image,
        "tail",
        "-f",
        "/dev/null",
      ]);
      if (created.code !== 0) {
        throw new ProvisionError(
          `${runtime} run failed (exit ${created.code}): ${created.stderr.trim() || created.stdout.trim()}`,
          "container",
        );
      }

      const containerId = created.stdout.trim().split("\n").pop()?.trim() ?? "";
      if (!CONTAINER_ID.test(containerId)) {
        // Something is running that we cannot name, so it cannot be removed by
        // id. Removing the network it is attached to is the only handle left,
        // and it fails while the container holds it, which is the loud version
        // of this going wrong. The grant is revoked regardless: the token is the
        // one thing here that can be withdrawn without naming the container.
        //
        // Deliberately not recorded in the accumulator. `CONTAINER_ID` exists to
        // keep a value the runtime printed out of argv, and an unwind that fed
        // the rejected string to `rm --force` would be that pattern's only
        // bypass.
        throw new ProvisionError(`${runtime} run returned no usable container id`, "container");
      }
      unwind.containerId = containerId;

      // The broker binds here, and not a line earlier.
      //
      // This is the second half of the ordering `resolveGuestBridge` describes.
      // The address was readable the moment the network existed, but nothing can
      // bind it until a container is attached: before that, `bind()` fails
      // `EADDRNOTAVAIL (49)`. The container is now running, so the bridge address
      // exists, and the endpoint already written into the guest's config finally
      // has something listening on it.
      //
      // Fatal on failure, and the unwind is the widest in this function because
      // by now everything exists. The guest is holding an endpoint that nothing
      // answers, so letting it start would produce precisely the agent this
      // change exists to stop shipping: reachable, idle, and unable to answer.
      //
      // Gated on the GRANT rather than on the provider, which is the difference
      // between a check and a hole. Gating on the bridge shape alone would
      // silently skip the bind for a provider that had already handed out a
      // token, and a skipped bind looks exactly like a working provision until
      // the first prompt. A provider that granted against an `unsupported`
      // bridge is refused here instead: it is the same defect as a missing
      // grant, arriving one step later.
      if (modelAccess !== undefined && access !== null) {
        if (bridge.kind === "unsupported") {
          throw new ProvisionError(
            `container ${containerId} was granted model access over a bridge this host cannot serve, so nothing ` +
              `can listen on the endpoint the guest was given: ${bridge.reason}`,
            "container",
          );
        }
        try {
          await modelAccess.activate({ bridge });
        } catch (err) {
          throw err instanceof ProvisionError
            ? err
            : new ProvisionError(
                `container ${containerId} model access could not be activated: ${String(err)}`,
                "container",
                { cause: err },
              );
        }
      }

      // No `exec` into the container, and no path inside it: the overlay is
      // delivered through `gateDir`, which the container has mounted read-only at
      // `GATE_MOUNT`. The two `exec` calls that used to create and lock down a
      // scratch directory for it are gone with the directory, because the four
      // `exec` round trips they served were the FIFO substitution primitive
      // `gate-wrapper.ts` documents.
      let wrapper: GateWrapper;
      try {
        wrapper = writeGateWrapper({
          via: "mount",
          attach: [runtime, "exec", "-i", containerId, toolchain.ompPath],
          gateDir,
          mountPath: GATE_MOUNT,
          label: `container ${containerId.slice(0, 12)}`,
          kind: "container",
        });
      } catch (err) {
        // The container exists but is unusable, and the unwind removes it: a
        // half-provisioned container that nobody holds a handle to is never
        // reclaimed. The network goes with it, and only after it, because a
        // network with a container still attached cannot be removed.
        throw err instanceof ProvisionError
          ? err
          : new ProvisionError(`container ${containerId} could not be prepared: ${String(err)}`, "container", {
              cause: err,
            });
      }

      this.#live.set(containerId, {
        runtime,
        containerId,
        network: createdNetwork,
        wrapper,
        gateDir,
        guestHome,
        // In memory and nowhere else. `ref.resolved` below deliberately omits
        // it, so this is the only record of which grant belongs to which
        // container and it dies with the process.
        modelToken: access?.token ?? null,
      });
      const spawn = this.#spawn;
      // One ACP connection per container, and this is where it is enforced.
      //
      // This is the security property, not a tidiness rule. Every step of the
      // substitution attack `gate-wrapper.ts` documents needs a process already
      // running inside the container, and a second connection is exactly when one
      // exists: the first connection's agent can leave a watcher behind that
      // pre-plants a FIFO on the overlay path, or on Apple's runtime mounts over
      // `GATE_MOUNT` and serves its own `gate.yml`. Refusing here means no such
      // process has ever run when omp opens the overlay. Relaxing it reopens the
      // bypass, whatever the delivery mode does.
      let served = false;
      return {
        // Mounts are normalized (canonical path, default mode filled in) so an
        // operator reading this ref back sees exactly what the container can
        // see, not merely what they happened to type.
        //
        // `resolved` is the part that makes teardown survive a restart. Before
        // it existed, `#live` was the only record of the runtime and the network,
        // so a restarted daemon threw `unknown container handle` and left a
        // running container and an `ompd-*` network behind: the command is
        // `tail -f /dev/null`, so `--rm` never fires on its own. It is also the
        // audit record, because `spec.image` is the caller's value and is
        // `undefined` on the default path.
        //
        // `guestHome` is here for exactly that reason and the token is not. The
        // directory has to be reclaimable after a restart, because it is a
        // daemon-side `mkdtemp` holding the guest's config and its bearer, and
        // nothing else would ever remove it. The bearer itself must never be
        // written here: the store persists `HostRef`, so a token in `resolved`
        // would outlive both the container and the broker that could revoke it.
        //
        // The consequence is deliberate rather than a gap. Grants live only in
        // the broker's memory, so a daemon restart withdraws model access from
        // every container it did not start. That is the safe direction: a
        // restarted daemon can still remove the container and delete the
        // directory, and a container left running against a broker that has
        // forgotten it gets 401s rather than unbounded use of the operator's
        // credential.
        ref: {
          kind: "container",
          id: containerId,
          spec: { ...spec, image: toolchain.image, mounts },
          resolved: {
            runtime,
            network: createdNetwork,
            image: toolchain.image,
            ompSha256: toolchain.ompSha256 ?? undefined,
            caSha256: toolchain.caSha256 ?? undefined,
            guestHome,
            createdAt: new Date().toISOString(),
          },
        },
        // `ompPath` is overridden rather than merged: the caller's omp path is a
        // path on the daemon's machine and means nothing inside the container.
        spawn: (opts: SpawnLocalHostOptions): LocalHost => {
          if (served) {
            throw new ProvisionError(
              `container ${containerId} has already served an ACP connection and will not serve another: a ` +
                `process the first connection left behind can substitute the approval-gate overlay for the ` +
                `second. Provision a new container.`,
              "container",
            );
          }
          served = true;
          return spawn({ ...opts, ompPath: wrapper.path });
        },
      };
    } catch (err) {
      // The same unwind every explicit branch above used to run inline, now run
      // for a throw as well as for a nonzero exit. The error is rethrown
      // untouched, so a caller still receives the `ProvisionError` the branch
      // wrote, carrying the same message and the same `cause` it always did.
      await this.#unwindProvision(unwind);
      throw err;
    }
  }

  /**
   * Release a container, from memory when this process created it and from the
   * persisted `HostRef` when it did not.
   *
   * Idempotent on purpose. A caller racing the TTL sweep, retrying after a
   * timeout, or reconciling at startup must not get an error for work already
   * done, and `rm --force` on an id the runtime has never heard of is the
   * ordinary case during reconciliation rather than a fault. What is still an
   * error is a runtime that answered and refused, because that is a container
   * nobody has reclaimed.
   */
  async destroy(handle: HostHandle): Promise<void> {
    const record = this.#live.get(handle.ref.id);
    const resolved = handle.ref.resolved;
    if (record === undefined && resolved === undefined) {
      throw new ProvisionError(
        `cannot destroy container ${handle.ref.id}: this process did not create it and its HostRef carries no ` +
          `resolved runtime, so there is nothing to address. A host provisioned before resolved state existed ` +
          `has to be removed by hand.`,
        "container",
      );
    }

    const runtime = record?.runtime ?? resolved?.runtime ?? "";
    const network = record === undefined ? (resolved?.network ?? null) : record.network;
    // Reclaimed from the record when this process created the host, and from
    // the persisted `HostRef` when it did not. Unlike the gate and wrapper
    // directories this one survives a restart, because it holds the guest's
    // bearer and its whole configuration rather than an overlay nobody can
    // reach any more.
    const guestHome = record === undefined ? (resolved?.guestHome ?? null) : record.guestHome;
    this.#live.delete(handle.ref.id);

    // Revocation first, and specifically before either subprocess is awaited.
    //
    // This ordering is the security property, not tidiness, and it will look
    // pointless to whoever reads it next. Deleting the id from `#live` above
    // revokes nothing: the grant lives in the broker's map, and only
    // `release` removes it. So every await placed before the revoke is a window
    // in which a bearer exfiltrated from the guest still authenticates -- and
    // if the runtime's `rm` hangs rather than answering, that window runs to
    // the grant's whole TTL. Revoking is an in-process map delete and cannot
    // hang; `rm --force` and `network rm` are subprocesses and can. Putting the
    // one that cannot hang first is what makes "revoked when the container
    // stops" true rather than approximately true.
    //
    // It matters most on the `host-alias` shape, whose listener is host
    // loopback with the peer-address check unavailable, so an exfiltrated
    // bearer is presentable by any process on this machine rather than only by
    // something on the container network.
    //
    // Only the token comes from the record: it is deliberately absent from
    // `resolved`, so after a restart there is nothing here to revoke and
    // nothing that needs revoking -- the broker forgot every grant when the
    // process it lived in exited.
    await this.#discardAccess(record?.modelToken ?? null);

    if (record !== undefined) {
      // Both daemon-side directories, and the gate one matters more than the
      // wrapper: it holds the overlay the daemon wrote for this host. After a
      // restart there is no record, so neither is reclaimed here; they are
      // `mkdtemp` directories under the temp root, which is litter of the same
      // class the wrapper dir has always been. What restart teardown does still
      // reclaim, from `resolved` alone, is the container, its network and the
      // guest home.
      discard(record.wrapper.dir);
      discard(record.gateDir);
    }

    const removed = await this.#run([runtime, "rm", "--force", handle.ref.id]);
    // The network is removed whether or not the container went cleanly, and
    // always after it: docker refuses to remove a network something is still
    // attached to. A leftover empty network is litter rather than a risk, so
    // its failure is logged by the caller's audit entry, not thrown here.
    await this.#removeNetwork(runtime, network);
    // The seeded home last, and after the container that mounted it is gone.
    //
    // Last because it is the only one of these whose removal has no urgency
    // left: the bearer inside it was revoked before the first await, so the
    // file is inert bytes by the time this runs, and removing it while the
    // container still had it mounted would only pull the guest's config out
    // from under a process about to be killed. Reclaimed from the record when
    // this process created the host and from the persisted `HostRef` when it
    // did not, which is why it is computed above rather than read off `record`.
    if (guestHome !== null) discard(guestHome);
    if (removed.code !== 0 && !isAlreadyGone(removed.stderr)) {
      throw new ProvisionError(`${runtime} rm failed (exit ${removed.code}): ${removed.stderr.trim()}`, "container");
    }
  }

  /**
   * Undo everything a failed `provision` created, in the one order that is
   * safe, and never throw.
   *
   * The order is not the reverse of the creation order, which is why this is a
   * method with a comment rather than a loop over cleanup closures.
   *
   * 1. The grant, first and before any subprocess is awaited, for the same
   *    reason `destroy` revokes first: it is an in-process map delete that
   *    cannot hang, and everything after it can. A bearer the guest already
   *    read off its mounted home keeps authenticating until this line runs.
   * 2. The container, because a network cannot be removed while something is
   *    attached to it. Skipped when no id was recorded, which is either because
   *    `run` never returned one or because what it returned failed
   *    `CONTAINER_ID` and must not reach argv.
   * 3. The network, after the container for that same reason.
   * 4. The two daemon-side directories, last, because they are inert once the
   *    grant is dead: the guest home holds a revoked bearer and the gate
   *    directory holds an overlay nothing can reach.
   *
   * Never throws, and that is a requirement rather than a nicety: this runs
   * inside a `catch` that is about to rethrow, and an error raised here would
   * replace the `ProvisionError` the caller needs with a cleanup failure. Every
   * step is already best effort -- `#discardAccess` swallows, `#removeNetwork`
   * swallows, `discard` swallows -- and the `rm` is given the same `.catch` the
   * explicit branches always gave it.
   */
  async #unwindProvision(state: ProvisionUnwind): Promise<void> {
    await this.#discardAccess(state.token);
    if (state.containerId !== null) {
      await this.#run([state.runtime, "rm", "--force", state.containerId]).catch(() => undefined);
      // A record is only ever written on the last statement of a successful
      // provision, so this normally removes nothing. It is here because the
      // invariant is "no path out of `provision` leaves a live grant", and a
      // `#live` entry for a container this method just removed would be a
      // handle to a grant that no longer exists -- cheap to delete, and it
      // keeps the invariant true of any future statement added after the set.
      this.#live.delete(state.containerId);
    }
    await this.#removeNetwork(state.runtime, state.network);
    if (state.guestHome !== null) discard(state.guestHome);
    discard(state.gateDir);
  }

  /**
   * Withdraw a container's model access.
   *
   * Best effort, for the same reason `discard` is: this runs on every unwind
   * path in `provision` as well as on `destroy`, and a failure here would mask
   * the error that made us unwind. What it must never do is throw, and what it
   * must always be is safe when this process did not create the host -- after a
   * restart the token is gone by design, so `null` arrives here and there is
   * nothing to revoke.
   *
   * It takes the token and nothing else on purpose. It used to remove the
   * seeded guest home too, and pairing them read as one step when they are two
   * resources with two different urgencies: revoking is instant and must happen
   * before anything that can block, while the directory holds bytes that are
   * worthless the moment the revoke lands. Both callers now remove the
   * directory at the point in their own sequence where it belongs, which is
   * after the container is gone.
   *
   * The token reaches this method and stops here. It is not logged, not put in
   * the error the caller is about to throw, and not written anywhere the store
   * can see.
   */
  async #discardAccess(token: string | null): Promise<void> {
    if (token !== null && this.#modelAccess !== undefined) {
      await this.#modelAccess.release({ token }).catch(() => undefined);
    }
  }

  /**
   * Remove a network this backend created, and only one it created.
   *
   * `null` means the host ran under a `"none"` policy, so nothing was created
   * and there is nothing to reclaim. Attempting `network rm none` would try to
   * delete a runtime-owned name on the runtimes that have one.
   */
  async #removeNetwork(runtime: string, network: string | null): Promise<void> {
    if (network === null) return;
    await this.#run([runtime, "network", "rm", network]).catch(() => undefined);
  }
}
