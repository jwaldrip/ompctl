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
 * `--config`; the wrapper copies that file into the container, verifies it,
 * and rewrites the flag. See `gate-wrapper.ts`. ompd never passes `--config`
 * and never authors the overlay.
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

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalHost, SpawnLocalHostOptions } from "@ompd/acp";
import { spawnLocalHost } from "@ompd/acp";
import { dangerousMountReason, type HostKind, type HostMount, type HostSpec, isInside } from "@ompd/core";
import { execCommand } from "./exec.ts";
import { type GateWrapper, writeGateWrapper } from "./gate-wrapper.ts";
import { type EnsureToolchainOptions, ensureToolchain, type ResolvedToolchain } from "./image.ts";
import { type RuntimeCapability, selectRuntime } from "./runtime.ts";
import {
  type CommandRunner,
  type HostHandle,
  ProvisionError,
  type ProvisionerBackend,
  type SpawnHost,
} from "./types.ts";

/** Directory inside the container holding ompd's per-host scratch. */
const DEFAULT_SCRATCH_ROOT = "/tmp";

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
  /** Default image when `spec.image` is absent. Normally `OMPD_CONTAINER_IMAGE`. */
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
}

/**
 * Refuse a mount that would hand the sandbox the credentials that make it a
 * sandbox, rather than trusting an operator never to name one by mistake.
 *
 * Reuses `dangerousMountReason`, the project's one list of paths a mount must
 * never name, and adds only what that list cannot know: the daemon's own
 * `home`, which moves with `OMPD_HOME` and cannot be a static pattern.
 */
function refuseIfDangerous(hostPath: string, home: string): void {
  if (!hostPath.startsWith("/")) {
    throw new ProvisionError(`mount path must be absolute, got ${JSON.stringify(hostPath)}`, "container");
  }
  const reason =
    dangerousMountReason(hostPath) ??
    (isInside(home, hostPath) ? `inside the daemon's own state directory ${home}` : null);
  if (reason !== null) {
    throw new ProvisionError(`refusing to mount ${hostPath}: ${reason}`, "container");
  }
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
    const mounts: HostMount[] = (spec.mounts ?? []).map(mount => {
      refuseIfDangerous(mount.hostPath, this.#home);
      return { hostPath: mount.hostPath, mode: mount.mode ?? "ro" };
    });

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
      const madeNetwork = await this.#run([runtime, "network", "create", createdNetwork]);
      if (madeNetwork.code !== 0) {
        throw new ProvisionError(
          `${runtime} network create failed (exit ${madeNetwork.code}): ${madeNetwork.stderr.trim()}`,
          "container",
        );
      }
    }

    // Each named mount lands at the identical absolute path inside, the same
    // property `--volume workspace:workspace` already relies on. Read-only
    // unless the operator opted a path into "rw" explicitly.
    const mountArgs: string[] = [];
    for (const mount of mounts) {
      mountArgs.push("--volume", `${mount.hostPath}:${mount.hostPath}:${mount.mode}`);
    }
    // The toolchain, read-only, and verified to be so: a write into it reports
    // `Read-only file system`. It carries omp itself, so it is the one mount
    // the container must not be able to rewrite.
    if (toolchain.toolsDir !== null) {
      mountArgs.push("--volume", `${toolchain.toolsDir}:${toolchain.mountPath}:ro`);
    }

    // `tail -f /dev/null` keeps the container alive so exec has something to
    // attach to. The ACP host is not the container's main process: one
    // container serves however many connections the supervisor opens.
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
      await this.#removeNetwork(runtime, createdNetwork);
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
      // of this going wrong.
      await this.#removeNetwork(runtime, createdNetwork);
      throw new ProvisionError(`${runtime} run returned no usable container id`, "container");
    }

    const scratch = `${this.#scratchRoot}/ompd-${containerId.slice(0, 12)}`;
    let wrapper: GateWrapper;
    try {
      await this.#prepareScratch(runtime, containerId, scratch);
      wrapper = writeGateWrapper({
        shell: [runtime, "exec", "-i", containerId],
        attach: [runtime, "exec", "-i", containerId, toolchain.ompPath],
        remoteConfigPath: `${scratch}/gate.yml`,
        label: `container ${containerId.slice(0, 12)}`,
        kind: "container",
      });
    } catch (err) {
      // The container exists but is unusable. Remove it here: a half-provisioned
      // container that nobody holds a handle to is never reclaimed. The network
      // goes with it, and only after it, because a network with a container
      // still attached cannot be removed.
      await this.#run([runtime, "rm", "--force", containerId]).catch(() => undefined);
      await this.#removeNetwork(runtime, createdNetwork);
      throw err instanceof ProvisionError
        ? err
        : new ProvisionError(`container ${containerId} could not be prepared: ${String(err)}`, "container", {
            cause: err,
          });
    }

    this.#live.set(containerId, { runtime, containerId, network: createdNetwork, wrapper });
    const spawn = this.#spawn;
    return {
      // Mounts are normalized (default mode filled in) so an operator reading
      // this ref back sees exactly what the container can see, not merely
      // what they happened to type. The image is recorded too: on the default
      // path it is a public base rather than whatever the daemon's default
      // happened to be at the time, and a transcript should say which.
      ref: { kind: "container", id: containerId, spec: { ...spec, image: toolchain.image, mounts } },
      // `ompPath` is overridden rather than merged: the caller's omp path is a
      // path on the daemon's machine and means nothing inside the container.
      spawn: (opts: SpawnLocalHostOptions): LocalHost => spawn({ ...opts, ompPath: wrapper.path }),
    };
  }

  async destroy(handle: HostHandle): Promise<void> {
    const record = this.#live.get(handle.ref.id);
    if (record === undefined) {
      throw new ProvisionError(`unknown container handle ${handle.ref.id}`, "container");
    }
    this.#live.delete(record.containerId);
    try {
      rmSync(record.wrapper.dir, { recursive: true, force: true });
    } catch {
      // Best effort. A leftover script in the temp dir is litter, not a risk.
    }
    const removed = await this.#run([record.runtime, "rm", "--force", record.containerId]);
    // The network is removed whether or not the container went cleanly, and
    // always after it: docker refuses to remove a network something is still
    // attached to. A leftover empty network is litter rather than a risk, so
    // its failure is logged by the caller's audit entry, not thrown here.
    await this.#removeNetwork(record.runtime, record.network);
    if (removed.code !== 0) {
      throw new ProvisionError(
        `${record.runtime} rm failed (exit ${removed.code}): ${removed.stderr.trim()}`,
        "container",
      );
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

  async #prepareScratch(runtime: string, containerId: string, scratch: string): Promise<void> {
    // A private directory created before the overlay is copied, so the copy
    // never lands somewhere another process in the image could have prepared.
    const made = await this.#run([runtime, "exec", containerId, "mkdir", "-p", scratch]);
    if (made.code !== 0) {
      throw new ProvisionError(`could not create ${scratch} in ${containerId}: ${made.stderr.trim()}`, "container");
    }
    const locked = await this.#run([runtime, "exec", containerId, "chmod", "700", scratch]);
    if (locked.code !== 0) {
      throw new ProvisionError(
        `could not lock down ${scratch} in ${containerId}: ${locked.stderr.trim()}`,
        "container",
      );
    }
  }
}
