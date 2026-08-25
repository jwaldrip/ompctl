/**
 * How a container host gets an `omp` to run.
 *
 * The old answer was `ghcr.io/jwaldrip/omp:latest`, a private package. Every
 * provision that did not name its own image therefore died inside the runtime
 * with `error from registry: denied` (exit 125) and reached the Cowork UI as
 * HTTP 500 "Unable to start container". The obvious fix is to build the image
 * locally from the public Dockerfile in `scripts/`. On the runtime actually
 * installed here that does not work, twice over, both observed on this machine
 * against `container` 0.4.1:
 *
 *   1. Its BuildKit builder cannot read the build context. Every `COPY` fails
 *      with `failed to compute cache key: failed to calculate checksum of
 *      ref ...: "/hello.txt": not found`, reproduced with a two-line Dockerfile
 *      and a 14-byte file. `FROM` and `RUN` work; `COPY` does not. The CLI is
 *      0.4.1 and the builder shim it pulls is 0.6.0, which is the likely cause.
 *   2. An unqualified local tag is resolved against Docker Hub at run time:
 *      `container run ompd-min:t1` produced
 *      `HTTP request to https://registry-1.docker.io/v2/library/ompd-min/manifests/t1 ... 401 Unauthorized`.
 *      So even a built tag would not be runnable.
 *
 * Upgrading `container` needs an admin `.pkg` install, which is the operator's
 * decision and not ours to make silently. So this module does not build an
 * image at all. It delivers the toolchain the way the runtime already supports:
 * a public base image, plus a read-only bind mount of a content-addressed cache
 * directory on the host holding the Linux `omp`, the shim, and a CA bundle.
 *
 * That the mount can carry an executable is the load-bearing fact, and it was
 * measured rather than assumed:
 * `container run --rm --volume /tmp/ompd-tools:/opt/ompd:ro debian:bookworm-slim /opt/ompd/omp --version`
 * printed `omp/18.0.4`. The `:ro` is genuinely enforced (a `touch` inside gives
 * `Read-only file system`), and the mount must be a directory: a single-file
 * bind mount fails with `Not a directory` / `VZErrorDomain Code=2`.
 *
 * Precedence is operator-first. An internally-resolved `spec.image`, then the
 * daemon's `containerImage` config field (handed in as `envImage` rather than
 * read here, so this module stays a function of its arguments), then the
 * default base plus a mounted toolchain. Neither of those first two can come
 * from a paired device: the wire refuses `image` outright.
 * An operator who names an image owns what is in it: nothing is mounted over
 * it, nothing is downloaded, nothing is checked against a manifest, and `omp`
 * is left to resolve on its PATH.
 *
 * Nothing unreviewed is mounted
 * -----------------------------
 * Everything on the default path is pinned in `toolchain-manifest.ts`: the base
 * image and the CA source image by OCI index digest, each `omp-linux-<arch>` by
 * the digest and byte count upstream publishes for it, and the trust store by
 * the digest of the file inside the pinned image. That module carries the
 * commands each value came from and the date they were run.
 *
 * The failure this removes is worth stating plainly, because the previous
 * version looked careful and was not. It named `debian:bookworm-slim` and
 * `alpine:3.20` as bare tags, downloaded whatever the release URL served, then
 * hashed what arrived and used that hash as the cache key. Content-addressing a
 * download makes the cache honest about itself and says nothing whatsoever
 * about provenance: a substituted asset would have been hashed, cached under
 * its own digest, mounted, and executed, and every check in this file would
 * have agreed with it. So the expectation is now written down first, in a file
 * a human reviews, and a download is compared against it.
 *
 * Three consequences worth knowing before reading the code:
 *
 *   - An `omp --version` with no manifest entry is refused, with the steps to
 *     add one. It is never a licence to fetch an unpinned asset. An operator
 *     upgrading omp has to look at the release, which is the point.
 *   - The pin is carried in argv, as `<repo>:<tag>@sha256:<digest>`, because
 *     Apple `container` 0.4.1 accepts that spelling and genuinely enforces it.
 *     Proven by contradiction rather than by a passing run:
 *     `container run --rm debian:bullseye-slim@sha256:88200866...4171
 *     cat /etc/debian_version` printed `12.15`, which is bookworm, the digest,
 *     while the plain `debian:bullseye-slim` tag printed `11.11`. A wrong tag
 *     loses to the digest, and a digest that does not exist 404s rather than
 *     falling back to the tag. Had the CLI rejected pinned references the
 *     fallback would have been a `container images inspect` pass after each
 *     pull; that is not in force, and nothing here needs it.
 *   - The trust store is verified against the manifest after every extraction
 *     and on every cache hit, not just when it is first written. That is what
 *     caught OrbStack's docker injecting its own root CA into the bundle on the
 *     way out, and it is why a docker host on OrbStack now fails closed on the
 *     default path with an error naming both digests and the ways forward.
 *
 * The cache is a directory named `omp-<version>-<arch>-<sha12>`, where the
 * digest is now the manifest's rather than a download's. So the name is known
 * before anything is fetched, and a hit is a single `stat` rather than a scan.
 * Every hit then re-reads the contents and checks all three files, because a
 * name derived from a digest is a claim about the contents and not evidence of
 * them.
 *
 * The one container this module runs is confined like any other
 * ----------------------------------------------------------------
 * Extracting the trust store means running the pinned alpine, and until the
 * review that prompted this it ran as `<runtime> run --rm <alpine> cat <path>`
 * with no network argument and no confinement flags at all. That put it on the
 * runtime's shared default network, which is the segment every other container
 * on the machine is on: the operator's database, their cache, their staging
 * API. `cat` needs no network whatsoever, so that reach bought nothing and
 * risked the lot. It now gets `--network none` where the runtime has one and a
 * dedicated network of its own where it does not, created before and removed
 * after on every path including the failing one, plus every confinement and
 * resource flag the capability reports.
 *
 * That confinement is defence in depth and not the primary control, which is
 * worth saying out loud so nobody mistakes it for the thing keeping them safe.
 * The image is pinned by digest and the digest is reviewed, so the primary
 * control is the pin. The reason the confinement still matters is the case the
 * pin cannot cover on its own: a registry serving different bytes for a digest
 * it already published, or a runtime that injects into containers on the way
 * past. OrbStack's docker is the second of those, observed, in the mildest
 * possible form. A pin is a statement about what was asked for, not about what
 * the machine in the middle did with the request.
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HostSpec } from "@ompd/core";
import { execCommand } from "./exec.ts";
import { probeRuntime, type RuntimeCapability } from "./runtime.ts";
import {
  BASE_IMAGE,
  CA_BUNDLE_BYTES,
  CA_BUNDLE_CERT_COUNT,
  CA_BUNDLE_ORBSTACK_SHA256,
  CA_BUNDLE_SHA256,
  CA_ORBSTACK_SUBJECT,
  CA_PEM_HEADER,
  CA_SOURCE_IMAGE_PIN,
  type OmpRelease,
  ompRelease,
  reviewedVersions,
} from "./toolchain-manifest.ts";
import { type CommandResult, type CommandRunner, ProvisionError } from "./types.ts";

/**
 * The base image every default container host runs, digest-pinned.
 *
 * Both the choice of debian-slim and the digest itself live in
 * `toolchain-manifest.ts` with the measurements behind them. This re-export
 * keeps the name callers already use.
 */
export const DEFAULT_BASE_IMAGE = BASE_IMAGE.ref;

/** Where the toolchain cache directory is bind-mounted, read-only, inside the container. */
export const TOOLCHAIN_MOUNT_PATH = "/opt/ompd";

/** Where a CA bundle comes from, digest-pinned. Reasoning and digest in `toolchain-manifest.ts`. */
export const CA_SOURCE_IMAGE = CA_SOURCE_IMAGE_PIN.ref;

const CA_SOURCE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const CA_BUNDLE_NAME = "ca-certificates.crt";

/**
 * Floor for something that is recognisably a bundle at all.
 *
 * Strictly redundant now that the exact byte count and digest are checked:
 * every wrong length fails those. It is kept because the messages differ where
 * it matters. A runtime that printed 42 conversational bytes to stdout should
 * be told it did not return a bundle, not handed two lines of hex to compare.
 *
 * Worth being explicit that this is no longer the acceptance criterion, because
 * it used to be. A PEM header plus a length floor accepts every substitution
 * that keeps those two properties, which is nearly all of them: a single
 * self-signed certificate padded past a kilobyte satisfied both and would have
 * been mounted as the trust store for every model call the host makes.
 * `acceptCaBundle` decides, against the manifest.
 */
const CA_MIN_BYTES = 1000;

/**
 * Ceilings for the extraction container, deliberately tighter than a host's.
 *
 * `container.ts` gives an agent host 4g and 4 cpus because an agent compiles
 * things. This container runs `cat` on a 217KB file and exits, so the ceilings
 * are set to what that needs and nothing more. Sharing `container.ts`'s
 * `confinementArgs` was the alternative and was rejected twice over: importing
 * it would put `image.ts` into a cycle with the module that imports it, and the
 * two workloads genuinely want different numbers, so one function serving both
 * would have to be parameterised until it was two functions with extra steps.
 * The flag *selection* logic is the part that must not drift, and it is four
 * lines of `if (cap.x) push(...)` in both places against the same capability
 * fields.
 */
const EXTRACT_MEMORY = "256m";
const EXTRACT_CPUS = "1";
const EXTRACT_PIDS = "32";

/**
 * Prefix for the throwaway network the extraction runs in.
 *
 * Distinct from `container.ts`'s `ompd-` hosts so an operator reading
 * `<runtime> network ls` after a crash can tell which of the two leaked.
 */
const EXTRACT_NETWORK_PREFIX = "ompd-ca-";

/** Name the shim lands under, and therefore the entrypoint the backend runs. */
const SHIM_NAME = "omp-shim";

const OMP_NAME = "omp";

/** How much of the digest names the cache directory. 48 bits is ample for one host's cache. */
const DIGEST_LENGTH = 12;

/** Enough of a runtime's own stderr to diagnose from, without pasting a log into an HTTP response. */
const STDERR_TAIL = 800;

/**
 * Mode for the cache root and every entry in it.
 *
 * Owner-only, and checked on every hit rather than only set at creation. A
 * toolchain directory another account can write to makes every other check in
 * this file racy: the digests would be read, agreed with, and then the file
 * swapped before the runtime opens it. Tightening the mode is what makes the
 * verification meaningful rather than decorative.
 *
 * The obvious worry is that the mount then cannot be read from inside the
 * guest, since the previous layout was deliberately world-readable "because
 * the guest runs as root". Measured on this machine rather than assumed, with a
 * 0700 host directory holding 0555 / 0444 files:
 *
 *   $ container run --rm --volume /tmp/pin-evidence/tools700:/opt/ompd:ro \
 *       debian:bookworm-slim@sha256:88200866...4171 \
 *       sh -c 'id; ls -la /opt/ompd; /opt/ompd/omp-shim --version'
 *     uid=0(root) gid=0(root) groups=0(root)
 *     drwx------ 5 root root 160 ...
 *     omp/18.0.4
 *
 * The same mount under OrbStack's docker also printed `omp/18.0.4`. Both
 * runtimes map the host owner onto the guest's root, so owner-only costs
 * nothing. The mode hardening is free.
 */
const CACHE_MODE = 0o700;

/**
 * The shim, embedded rather than read off disk.
 *
 * It used to be `scripts/omp-home-shim.sh`, resolved relative to this module.
 * That is wrong in the artifact ompd actually ships: inside the single-file
 * binary `bun run build:cli` produces, `import.meta.url` is
 * `file:///$bunfs/root/<name>`, so a module-relative `../../../../scripts`
 * collapses to `/scripts` and the read fails. The daemon would then refuse to
 * provision any container host, and it would do so only once installed, never
 * from the checkout where it was tested.
 *
 * Embedding also removes the string surgery it replaced. The old code read the
 * file and rewrote its final `exec` line to point at the mount, asserting the
 * match so a silent miss could not produce a shim that execs a path which does
 * not exist. A template takes no such risk: the exec target is a parameter, so
 * there is nothing to match and nothing to assert. `renderOmpHomeShim` is
 * exported because the legacy docker-image path in
 * `scripts/check-container-host.ts` needs the same script pointed at
 * `/usr/local/lib/omp/omp` instead, and one source of truth for both is the
 * point.
 *
 * Every line below is load-bearing; see the original for the reasoning, which
 * is preserved verbatim.
 */
export function renderOmpHomeShim(ompPath: string): string {
  return `#!/bin/sh
# Point omp at an OMP home carried in on the workspace mount.
#
# The container backend runs \`<runtime> exec -i <id> <omp>\`, and the only
# things it injects at run time are the image, the workspace bind mount, the
# toolchain mount, and OMPD_REPO / OMPD_REF. There is no flag for "give the
# container credentials", so the workspace is the only channel: the daemon
# mounts it at the same absolute path it has on the host and sets it as the
# container's workdir, and \`exec\` inherits that workdir.
#
# So an OMP home seeded at \`<workspace>/.omp-home\` is picked up here. That is a
# security fact, not a convenience: every credential in it is readable by
# anything running in the container, and by anything that can write to the
# workspace on the host.
#
# Absent, omp runs against the image's own HOME and has no credentials. That is
# left alone rather than refused, because \`omp --version\` and any other local
# check has to keep working, and the failure surfaces loudly at the first model
# call. A seed that is present but has no \`.omp\` in it is different: someone
# meant to pass credentials and the wiring is wrong, so that one is refused
# rather than quietly downgraded to the image's config.
set -eu

SEED="$PWD/.omp-home"
if [ -d "$SEED" ]; then
  if [ ! -d "$SEED/.omp" ]; then
    echo "omp shim: $SEED exists but holds no .omp; refusing to fall back to the image's HOME" >&2
    exit 78
  fi
  # Under /tmp because that is the one writable filesystem a hardened container
  # host has: the root filesystem is mounted read-only where the runtime can
  # express it, and the scratch root is a tmpfs. \`mktemp -d\` rather than a fixed
  # path so nothing already sitting there can be followed, since /tmp is shared
  # and world-writable.
  HOME="$(mktemp -d /tmp/omp-home.XXXXXXXX)"
  export HOME
  # Copied rather than used in place, for two reasons. The seed is a bind mount
  # from the daemon's machine, so an ACP host that refreshed a credential in
  # place would be writing the operator's own OMP home. And omp keeps its state
  # in SQLite, whose locking is not dependable over a virtiofs mount.
  cp -a "$SEED/." "$HOME/"
  chmod -R go-rwx "$HOME"
fi

exec ${ompPath} "$@"
`;
}

export interface ToolchainInputs {
  ompVersion: string;
  arch: string;
}

export interface EnsureToolchainOptions {
  /** Runtime CLI name, as selected by `selectRuntime`. Only used to extract the CA bundle. */
  runtime: string;
  /**
   * What that runtime's `run` accepts, so the extraction can be confined.
   *
   * Optional, and the caller should always pass it. `container.ts` has it in
   * scope at the call site (`selectRuntime` a dozen lines above) and passing it
   * costs nothing, so the fallback below is a safety net rather than a path
   * anyone is meant to take.
   *
   * Absent, this module probes for it through the same `CommandRunner` rather
   * than defaulting to "send no flags". That distinction is the whole point of
   * the option: an unconfined extraction that nobody notices is exactly the
   * defect being fixed here, so a forgotten argument has to cost three
   * redundant commands and not the confinement. A runtime that comes back
   * unavailable from that probe is a refusal, because ompd is about to run a
   * container through a CLI it cannot establish anything about.
   *
   * Type imported from `runtime.ts`, which is acyclic: that module imports only
   * `exec.ts` and `types.ts`, so this is a new leaf edge and not a cycle with
   * `container.ts`, which already imports both.
   */
  capability?: RuntimeCapability;
  spec: HostSpec;
  run?: CommandRunner;
  cacheRoot?: string;
  /**
   * The daemon's `containerImage` config value. Named `envImage` for historical
   * reasons; it is no longer read from the environment, because a
   * launchd-started daemon inherits no shell.
   */
  envImage?: string;
  ompVersion?: string;
  arch?: string;
  fetchAsset?: (url: string) => Promise<Uint8Array>;
  /**
   * Which reviewed releases to allow. Defaults to the real manifest, and no
   * caller in the daemon passes it.
   *
   * It exists because the reviewed digests describe a 145MB binary, so a test
   * that exercises a *successful* provision cannot produce bytes matching them.
   * The fail-closed paths are tested against the real `OMP_RELEASES` with this
   * left alone, which is where it matters.
   *
   * Worth saying plainly that this is not a way around the pin: `fetchAsset`
   * above already lets a caller return whatever bytes it likes, so anything
   * that can set this could already substitute the binary, and anything that
   * can do either is running arbitrary code inside the daemon. The seam is no
   * weaker than the one beside it.
   */
  releases?: readonly OmpRelease[];
  onLog?: (line: string) => void;
}

export interface ResolvedToolchain {
  /** Base image to run. Pulled by the runtime exactly as written, digest and all. */
  image: string;
  source: "spec" | "env" | "default";
  /** Host directory to bind read-only at `mountPath`, or null when the image carries omp itself. */
  toolsDir: string | null;
  /** Meaningless when `toolsDir` is null; kept non-optional so the caller cannot forget it. */
  mountPath: string;
  /** Path inside the container. The shim on the default path, a bare `omp` when the operator named the image. */
  ompPath: string;
  /** Environment the caller must pass into the container. Empty unless the toolchain supplies something the base image lacks. */
  env: Record<string, string>;
  ompSha256: string | null;
  caSha256: string | null;
  /** False only when this call is the one that populated `toolsDir`. */
  cached: boolean;
}

/**
 * The cache directory for one toolchain. Pure, and the only thing that decides
 * which directory a hit could be in.
 *
 * Version and arch are in the name so a human can read the directory listing,
 * and the digest is in it so the name is a claim about the contents. The digest
 * passed in is now the manifest's, not a download's, so this is computable
 * before anything is fetched. That is why the hit path is a `stat` of one path
 * rather than a scan of every directory sharing a prefix: the expected name is
 * known up front. The name is still only a claim, so the contents are read and
 * checked on every hit regardless.
 */
export function toolchainDir(cacheRoot: string, inputs: ToolchainInputs, ompSha256: string): string {
  return join(cacheRoot, `omp-${inputs.ompVersion}-${inputs.arch}-${ompSha256.slice(0, DIGEST_LENGTH)}`);
}

export async function ensureToolchain(opts: EnsureToolchainOptions): Promise<ResolvedToolchain> {
  // Trimming is the one normalisation applied to an operator's image name: a
  // value read from a config file or a launchd plist can carry a trailing
  // newline, which would otherwise reach argv and be reported by the runtime as
  // part of the image name. Whitespace-only counts as unset, because an unset
  // `containerImage` must not defeat the default that now works.
  //
  // Deliberately ahead of every check in this file. An operator who names an
  // image owns it: it is pulled exactly as written, whether or not it carries a
  // digest, no toolchain is mounted over it, no release is downloaded, no
  // manifest is consulted and `env` is empty. That is not an oversight to
  // tighten later. The manifest exists to constrain what *ompd* chooses on the
  // operator's behalf, and there is nothing to constrain when the operator did
  // the choosing. It is also the documented way out of the trust-store refusal
  // below, which only works if it stays unchecked.
  for (const [source, candidate] of [
    ["spec", opts.spec.image],
    ["env", opts.envImage],
  ] as const) {
    const image = candidate?.trim() ?? "";
    if (image === "") continue;
    return {
      image,
      source,
      toolsDir: null,
      mountPath: TOOLCHAIN_MOUNT_PATH,
      ompPath: OMP_NAME,
      env: {},
      ompSha256: null,
      caSha256: null,
      cached: false,
    };
  }
  return await ensureDefaultToolchain(opts);
}

async function ensureDefaultToolchain(opts: EnsureToolchainOptions): Promise<ResolvedToolchain> {
  const run = opts.run ?? execCommand;
  const cacheRoot = opts.cacheRoot ?? join(homedir(), ".ompd", "toolchain");
  const ompVersion = opts.ompVersion ?? (await detectOmpVersion(run));
  const arch = opts.arch ?? hostReleaseArch();
  const inputs: ToolchainInputs = { ompVersion, arch };

  // Before anything is read from disk or fetched from the network, because a
  // version nobody reviewed has no expected digest, and without one every check
  // downstream would be comparing a download against itself.
  const release = reviewedRelease(ompVersion, arch, opts.releases);

  // Rendered before anything is fetched, so a shim whose shape has drifted
  // costs nothing. It is also needed on the hit path, to notice a cached
  // toolchain still carrying a superseded shim.
  const shim = renderOmpHomeShim(`${TOOLCHAIN_MOUNT_PATH}/${OMP_NAME}`);

  const dir = toolchainDir(cacheRoot, inputs, release.sha256);
  const probe = admit(dir, release, shim, opts.onLog);
  if (probe.kind === "hit") {
    opts.onLog?.(`toolchain ${dir} already cached (omp ${ompVersion}, linux/${arch})`);
    return resolved(probe.entry, true);
  }
  if (probe.kind === "untrusted") {
    // Not a hit and not simply absent: something is at the canonical path that
    // does not match the reviewed record. See `quarantine` for why this rebuilds
    // rather than refusing outright.
    quarantine(dir, probe.reason, opts.onLog);
  }

  // Cheapest first, so a runtime that cannot run anything, or one that rewrites
  // the trust store, fails before a 145MB download rather than after it.
  const ca = await extractCaBundle(run, await extractionCapability(opts, run), opts.onLog);
  opts.onLog?.(`downloading ${release.url}`);
  const omp = await downloadOmp(release, opts.fetchAsset ?? fetchAsset);

  const populated = land(cacheRoot, dir, { omp, shim, ca });

  // What landed, not what was intended, and through the same `admit` the hit
  // path went through rather than a second copy of the same checks. The rename
  // is atomic and the files were fsynced before it, so on the populating path
  // this should never fire; it fires anyway, because the cost of being wrong is
  // a container that runs a corrupt binary and blames omp for it.
  //
  // On the adopting path it is load-bearing rather than belt-and-braces. When
  // `land` reports another provision won the rename, the directory now at the
  // canonical name was written by someone else, and the only thing known about
  // it is its name. A name derived from a digest is a claim about contents, so
  // it is read: the digests handed back below are the adopted bytes', never the
  // ones this call happened to download, and the winner's shim is compared
  // against the current template rather than inherited. A winner that fails is
  // quarantined and refused, not adopted.
  const landed = admit(dir, release, shim, opts.onLog);
  if (landed.kind !== "hit") {
    const reason = landed.kind === "untrusted" ? landed.reason : "it is not there";
    quarantine(dir, reason, opts.onLog);
    throw new ProvisionError(
      `the toolchain that landed at ${dir} does not match the reviewed manifest (${reason}); refusing to mount it` +
        (populated ? "" : ", and it was written by a concurrent provision rather than by this one"),
      "container",
    );
  }

  opts.onLog?.(`toolchain ${dir} ready (omp ${ompVersion}, linux/${arch}, sha256 ${release.sha256})`);
  return resolved(landed.entry, !populated);
}

/**
 * The reviewed release for this version and architecture, or a refusal.
 *
 * Fails closed, and the message is the whole value of failing closed: an
 * operator who upgraded omp needs to be told what to do, not merely stopped.
 * There is no unpinned fallback path to take, deliberately. Downloading an
 * asset with nothing to compare it against is what this module was changed to
 * stop doing.
 */
function reviewedRelease(version: string, arch: string, releases?: readonly OmpRelease[]): OmpRelease {
  const release = ompRelease(version, arch, releases);
  if (release !== undefined) return release;
  throw new ProvisionError(
    `omp ${version} (linux/${arch}) is not in the reviewed toolchain manifest, so there is no digest to check a ` +
      `download against; refusing to fetch an unpinned release. Reviewed: ${reviewedVersions(releases).join(", ")}. ` +
      `To add it, review the release and add an OMP_RELEASES entry to ` +
      `packages/daemon/src/provisioner/toolchain-manifest.ts: take the digest from that tag's SHA256SUMS.txt ` +
      `asset, confirm the served bytes agree with it via \`shasum -a 256 -c SHA256SUMS.txt\`, and record the ` +
      `byte count from the GitHub release API.`,
    "container",
  );
}

interface CachedToolchain {
  dir: string;
  ompSha256: string;
  caSha256: string;
}

/**
 * What is at the canonical cache path.
 *
 * Three outcomes rather than the nullable one this replaced, because "nothing
 * is there" and "something is there and it is wrong" have to be handled
 * differently. Collapsing them is how a poisoned entry gets re-extracted into
 * whatever an attacker left behind.
 */
type CacheProbe =
  | { kind: "hit"; entry: CachedToolchain }
  | { kind: "miss" }
  | { kind: "untrusted"; dir: string; reason: string };

function resolved(hit: CachedToolchain, cached: boolean): ResolvedToolchain {
  return {
    image: DEFAULT_BASE_IMAGE,
    source: "default",
    toolsDir: hit.dir,
    mountPath: TOOLCHAIN_MOUNT_PATH,
    ompPath: `${TOOLCHAIN_MOUNT_PATH}/${SHIM_NAME}`,
    // The base image ships no trust store, so omp is told where the mounted one
    // is. Verified: with `--env SSL_CERT_FILE=/opt/ompd/ca-certificates.crt` on
    // debian-slim, omp runs.
    env: { SSL_CERT_FILE: `${TOOLCHAIN_MOUNT_PATH}/${CA_BUNDLE_NAME}` },
    ompSha256: hit.ompSha256,
    caSha256: hit.caSha256,
    cached,
  };
}

/**
 * The only way a cache directory becomes usable, whichever path reached it.
 *
 * This exists because there were two paths and they were not the same. A cache
 * hit ran `probeCache` and then `refreshShim`. Adopting a directory after
 * losing the atomic rename ran `probeCache` and stopped, so a race winner
 * written by an older build of ompd kept its shim forever. That is not a
 * cosmetic staleness: the shim is the code deciding whether an OMP home seeded
 * on the workspace mount is honoured or refused, so an old copy pinned there is
 * a security behaviour going stale. Two call sites doing almost the same thing
 * is how that happened, and one function both call is the fix. The divergence
 * left is only in what each caller does with a non-hit, which is genuinely
 * different: a hit-path miss rebuilds, an adopt-path miss refuses.
 *
 * The shim comparison stays here rather than moving into `probeCache`, and the
 * split is deliberate. `probeCache` decides trust, and a superseded shim is not
 * a trust failure: the directory is named after the omp binary, so an ompd
 * release that edits the template reuses it, and treating that as tampering
 * would quarantine a valid 145MB binary in order to rewrite two kilobytes
 * beside it. So the probe checks the shim exists and this checks it is current.
 *
 * Every filesystem error out of the refresh becomes a `ProvisionError` naming
 * the directory, which is wider than the raw `ENOENT` the review asked for and
 * wider on purpose. Anything thrown here means the tree changed between being
 * verified and being written to, and the honest reading of that is not "retry
 * the write" but "the thing that was checked is not the thing in front of us".
 * A bare `ENOENT` escaping to the caller would surface as an unclassified
 * `Error` from a module whose every other refusal is a `ProvisionError` with a
 * reason attached.
 */
function admit(dir: string, release: OmpRelease, shim: string, onLog?: (line: string) => void): CacheProbe {
  const probe = probeCache(dir, release);
  if (probe.kind !== "hit") return probe;
  try {
    refreshShim(dir, shim, onLog);
  } catch (err) {
    throw new ProvisionError(
      `the toolchain at ${dir} verified against the reviewed manifest and then could not have its shim brought ` +
        `up to date: ${String(err)}. The most likely cause is the directory being removed or replaced while it ` +
        `was being checked, so this refuses rather than mounting a tree that changed underneath the check.`,
      "container",
      { cause: err },
    );
  }
  return probe;
}

/**
 * Decide whether the directory at `dir` is the reviewed toolchain, by reading
 * it rather than by reading its name.
 *
 * The name carries the omp digest, and the review that prompted this rewrite
 * found the hole that follows from trusting it: a hit verified `omp` (whose
 * digest names the directory) and byte-compared the shim, and never looked at
 * `ca-certificates.crt` at all. So a rewritten trust store read as a clean hit
 * and was mounted at `/opt/ompd/ca-certificates.crt` with `SSL_CERT_FILE`
 * pointed at it. The reproduction printed `cached (hit)? true / CA
 * re-extracted? NO`, and the file omp would have trusted for every model call
 * was the tampered one. Every file is checked here now, each against the
 * manifest rather than against something derived from the directory itself.
 *
 * Order matters. The mode is checked first, because a directory another account
 * can write to makes the reads below a race rather than a check: verify, get
 * swapped, mount. Cost on a hit is one `stat` plus hashing 145MB, which is
 * 0.33s of `shasum -a 256` on this machine against a provision that is already
 * pulling and booting a container.
 */
function probeCache(dir: string, release: OmpRelease): CacheProbe {
  let mode: number;
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) return { kind: "untrusted", dir, reason: `${dir} is not a directory` };
    mode = stat.mode & 0o777;
  } catch {
    return { kind: "miss" }; // Nothing there. First provision for this release.
  }

  // An exact mode rather than "no group or other write bit". The set of modes
  // that are arguably safe is a longer argument than it is worth having in a
  // security check, and an exact comparison is one a reader can confirm at a
  // glance. It also makes the upgrade automatic: entries written by the older
  // build are 0755, so the first provision after this change replaces them.
  if (mode !== CACHE_MODE) {
    return {
      kind: "untrusted",
      dir,
      reason: `its mode is ${mode.toString(8).padStart(4, "0")}, not ${CACHE_MODE.toString(8).padStart(4, "0")}`,
    };
  }

  let ompSha256: string;
  let caSha256: string;
  try {
    ompSha256 = createHash("sha256")
      .update(readFileSync(join(dir, OMP_NAME)))
      .digest("hex");
    caSha256 = createHash("sha256")
      .update(readFileSync(join(dir, CA_BUNDLE_NAME)))
      .digest("hex");
    // Present and readable, not compared. A superseded shim is expected rather
    // than suspicious: the directory is named after the omp binary, so an ompd
    // release that edits the shim template reuses this directory, and
    // quarantining the entry would throw away a valid 145MB binary to rewrite
    // two kilobytes beside it. `refreshShim` owns the comparison, on the hit
    // path, where replacing it is the correct outcome. An unreadable one lands
    // in the catch below, because that is a broken entry rather than a stale
    // one.
    statSync(join(dir, SHIM_NAME));
  } catch (err) {
    return { kind: "untrusted", dir, reason: `one of its files could not be read: ${String(err)}` };
  }

  if (ompSha256 !== release.sha256) {
    return { kind: "untrusted", dir, reason: `its omp is sha256 ${ompSha256}, not the reviewed ${release.sha256}` };
  }
  if (caSha256 !== CA_BUNDLE_SHA256) {
    return {
      kind: "untrusted",
      dir,
      reason: `its ${CA_BUNDLE_NAME} is sha256 ${caSha256}, not the reviewed ${CA_BUNDLE_SHA256}`,
    };
  }
  return { kind: "hit", entry: { dir, ompSha256, caSha256 } };
}

/**
 * Move a cache entry that failed verification out of the way, so a fresh one
 * can be built at the canonical path.
 *
 * Rebuilding rather than refusing, and the choice is not obvious, so: refusing
 * outright would mean one byte written into the cache is a permanent denial of
 * service on every container host on the machine, until a human notices and
 * deletes a directory by hand. Rebuilding costs a re-download. Between a
 * recoverable cost and an unrecoverable one, with no difference in what ends up
 * mounted, the recoverable one wins.
 *
 * What is *not* on offer is re-extracting into the suspect directory. That is
 * the actually dangerous option: writing into a tree someone else may control
 * means following their symlinks and racing their writes. So the suspect
 * directory is renamed aside first, in one syscall that never descends into it,
 * which frees the canonical name for the normal staging-and-rename path. The
 * directory that ends up mounted is a brand new inode nothing untrusted ever
 * touched.
 *
 * The quarantined copy is left on disk rather than deleted. Two reasons: an
 * `rm -rf` over a tree someone else may have arranged is its own hazard, and
 * the bytes are the only evidence of what happened. The cost is honest and
 * worth naming: repeated tampering accumulates ~145MB per incident under
 * `.untrusted-*`, and clearing it is the operator's call once they have looked.
 * The leading dot keeps it from ever being mistaken for a cache entry.
 */
function quarantine(dir: string, reason: string, onLog?: (line: string) => void): void {
  const parked = join(dirname(dir), `.untrusted-${basename(dir)}-${randomUUID().slice(0, 8)}`);
  try {
    renameSync(dir, parked);
  } catch (err) {
    throw new ProvisionError(
      `the cached toolchain at ${dir} does not match the reviewed manifest (${reason}), and it could not be moved ` +
        `aside to rebuild: ${String(err)}. Refusing to mount it, and refusing to write into it. Inspect it and ` +
        `remove it by hand.`,
      "container",
      { cause: err },
    );
  }
  onLog?.(
    `cached toolchain ${dir} rejected (${reason}); moved to ${parked} and rebuilding. ` +
      `Nothing was written into the rejected directory. Inspect and remove it once you have looked.`,
  );
}

/**
 * Keep a cached toolchain's shim current.
 *
 * The directory is named after the omp binary, not the shim, so editing the
 * shim template does not change the directory name and every existing cache
 * entry would otherwise keep serving the old shim forever. The shim is the code
 * that decides whether an OMP home seeded on the workspace mount is picked up
 * or refused, so silently pinning an old copy of it is a security behaviour
 * going stale, not a cosmetic staleness. Two kilobytes, compared on every hit,
 * renamed over only when it actually differs.
 *
 * A stale shim is not treated as tampering, which is worth being explicit
 * about: replacing it is exactly what an ompd upgrade needs, and quarantining
 * every entry on every shim edit would throw away a valid 145MB binary to
 * rewrite two kilobytes beside it.
 */
function refreshShim(dir: string, shim: string, onLog?: (line: string) => void): void {
  const path = join(dir, SHIM_NAME);
  try {
    if (readFileSync(path, "utf8") === shim) return;
  } catch {
    // Unreadable rather than merely stale. Fall through and replace it.
  }
  const staged = `${path}.${randomUUID().slice(0, 8)}.new`;
  writeDurable(staged, new TextEncoder().encode(shim), 0o555);
  renameSync(staged, path);
  onLog?.(`refreshed ${path}`);
}

/**
 * The omp release to mount, taken from the omp the daemon itself runs beside so
 * both sides of the ACP connection speak the same protocol.
 */
async function detectOmpVersion(run: CommandRunner): Promise<string> {
  const probe = await run(["omp", "--version"]);
  const version = probe.stdout.trim().replace(/^omp\//, "");
  if (probe.code !== 0 || version === "") {
    const detail = probe.stderr.trim() === "" ? "" : `: ${probe.stderr.trim().slice(-STDERR_TAIL)}`;
    throw new ProvisionError(
      `omp --version returned nothing (exit ${probe.code}); omp is not on PATH, so there is no version to assemble a toolchain for${detail}`,
      "container",
    );
  }
  return version;
}

/**
 * Which linux release asset to fetch. The published names are `omp-linux-arm64`
 * and `omp-linux-x64`, so this maps node's spelling onto theirs and refuses
 * anything with no asset rather than composing a URL that 404s.
 *
 * This is the host's architecture, which is the container's only because both
 * runtimes here run a guest at the host's architecture by default. Cross
 * building is neither handled nor guessed at: an operator emulating another
 * architecture passes `arch`, and the manifest then decides whether that
 * architecture has a reviewed release.
 */
function hostReleaseArch(): string {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "x64") return "x64";
  throw new ProvisionError(
    `no omp linux release is published for ${process.arch}; pass arch to name one explicitly`,
    "container",
  );
}

/**
 * What the extraction is allowed to reach, and what it is allowed to spend.
 *
 * The strictest option the runtime can express, and for once the strictest is
 * also sufficient: this container runs `cat` on a file already inside its own
 * image, so it needs no network at all. Where `--network none` exists that is
 * what it gets. Where it does not, it gets a network of its own, created for
 * this one `cat` and removed after it, which is a weaker claim than "no
 * network" but a much stronger one than the shared default.
 *
 * The shared default is what this replaced and it is worth naming what was
 * wrong with it. Every container the runtime starts without a `--network`
 * argument lands on one segment, so the extraction could reach the operator's
 * database, their cache, their staging API, and anything else they happen to be
 * running in a container on that machine. It gained nothing from that reach and
 * risked all of it.
 *
 * Two names because they are two things, the same split `container.ts` makes:
 * what `--network` receives, and what teardown has to remove. `null` means
 * nothing was created, so `network rm none` must never be attempted, since on
 * the runtimes that have a `none` network that would be an attempt to delete a
 * runtime-owned name.
 */
interface ExtractionNetwork {
  /** Value for `--network`. */
  arg: string;
  /** What to remove afterwards, or null when nothing was created. */
  created: string | null;
}

/**
 * Confinement for the extraction container.
 *
 * The pinned image is trusted. It is a public alpine at a reviewed index
 * digest, the runtime enforces the pin, and the bytes that come out are
 * compared against a digest a human wrote down. So this is defence in depth and
 * not the control that makes the extraction safe, and saying otherwise would be
 * the kind of claim this codebase is being reviewed for.
 *
 * It still matters, for one specific reason: the pin covers what was asked for,
 * not what the machine in the middle did with the request. A registry serving
 * different bytes under a digest it already published, or a runtime that
 * injects into containers on the way past, are both outside what a pin can say
 * anything about. The second is not hypothetical here. OrbStack's docker
 * rewrites this very file in transit, which is exactly the shape of thing the
 * pin cannot see, in its mildest possible form.
 *
 * A flag absent from the capability was never sent, which is not the same as
 * having held. On Apple `container` 0.4.1 that means `--cap-drop`,
 * `--security-opt`, `--read-only` and `--pids-limit` are all absent, verified
 * against its own `run --help`, which declares only `--cpus`, `--memory`,
 * `--network`, `--tmpfs`, `--user`, `--uid` and `--volume` of the flags that
 * matter here. Apple gives each container its own lightweight VM, so the three
 * that mitigate a shared-kernel escape are a different boundary there rather
 * than a hole in this one.
 *
 * A numeric `--user` goes only where `numericUser` says so. That gate is not
 * conservatism: on Apple's runtime every numeric identity flag crashes it
 * outright with `XPC connection error: Connection interrupted`, so sending one
 * would turn a working extraction into an unexplained failure.
 */
function extractionConfinement(cap: RuntimeCapability): string[] {
  const args: string[] = [];
  if (cap.capDrop) args.push("--cap-drop", "ALL");
  if (cap.securityOpt) args.push("--security-opt", "no-new-privileges:true");
  if (cap.readOnly) args.push("--read-only");
  if (cap.pidsLimit) args.push("--pids-limit", EXTRACT_PIDS);
  if (cap.memoryLimit) args.push("--memory", EXTRACT_MEMORY);
  if (cap.cpuLimit) args.push("--cpus", EXTRACT_CPUS);
  if (cap.numericUser) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid !== undefined && gid !== undefined) args.push("--user", `${uid}:${gid}`);
  }
  return args;
}

/**
 * The capability the extraction confines itself with.
 *
 * Handed in by every caller in the tree. The probe is a safety net for a caller
 * that forgets, and it exists in that shape on purpose: the alternative default
 * is "send no flags", which is an extraction that silently loses its
 * confinement and its network isolation with nothing anywhere reporting that it
 * did. That is the defect this whole function is downstream of, so a forgotten
 * argument costs three redundant commands instead.
 *
 * A runtime the probe cannot establish anything about is a refusal rather than
 * an unconfined run. ompd is one line away from starting a container through
 * that CLI, and `probeRuntime`'s own hint already says what to do about it.
 */
async function extractionCapability(opts: EnsureToolchainOptions, run: CommandRunner): Promise<RuntimeCapability> {
  if (opts.capability !== undefined) {
    // A capability describes one CLI's flags. Sending docker's set to Apple's
    // runtime is how `--user 501:20` reaches a runtime that crashes on it, so a
    // caller that pairs the wrong two is stopped rather than obeyed.
    if (opts.capability.runtime !== opts.runtime) {
      throw new ProvisionError(
        `the capability handed to ensureToolchain describes ${opts.capability.runtime} but the runtime to run is ` +
          `${opts.runtime}; refusing rather than confining one runtime's container with another's flags`,
        "container",
      );
    }
    return opts.capability;
  }
  const probed = await probeRuntime(opts.runtime, run);
  if ("reason" in probed) {
    throw new ProvisionError(
      `no capability was handed to ensureToolchain and ${opts.runtime} could not be probed for one, so the CA ` +
        `extraction has no way to know which confinement flags it accepts; refusing rather than running it ` +
        `unconfined (${probed.reason}: ${probed.hint})`,
      "container",
    );
  }
  return probed;
}

/**
 * Copy a trust store out of the pinned public image, and refuse anything that
 * is not byte-for-byte the reviewed one.
 *
 * Through the `CommandRunner` like everything else, so tests never pull an
 * image. Two distinct failures, in the order that gives the most useful
 * message: what came back is not recognisably a bundle at all, or it is a
 * bundle and not the one that was reviewed.
 *
 * The acceptance criterion is the manifest, and it used not to be. This
 * previously accepted a PEM header plus a thousand bytes, which accepts nearly
 * every substitution that could matter: a single self-signed certificate padded
 * past the floor satisfied both properties and would have been written into the
 * cache and mounted as `SSL_CERT_FILE` for every model call the host makes. Now
 * the reviewed byte count and the reviewed digest both have to match, so any
 * truncation and any substitution fails, and the floor survives only to give a
 * runtime that printed 42 conversational bytes a message about that rather than
 * two lines of hex.
 *
 * The image is pinned by digest and the container has no shared network, so a
 * bundle that differs is not the image moving under us: something between the
 * image and stdout edited it. OrbStack's docker does precisely that, adding its
 * own development root CA and returning 218540 bytes and 146 certificates from
 * the digest this module pins. An unreviewed certificate authority in that file
 * is a standing interception capability over the agent's traffic. Refused
 * rather than logged.
 *
 * The network is removed on every path out of here, success and failure alike,
 * which is why the run sits in a `try` whose `finally` does the teardown. A
 * refusal that leaked a network would leave the operator to find it with
 * `network ls` and guess what made it.
 */
async function extractCaBundle(
  run: CommandRunner,
  cap: RuntimeCapability,
  onLog?: (line: string) => void,
): Promise<Uint8Array> {
  const runtime = cap.runtime;
  const network = await openExtractionNetwork(run, cap);
  try {
    onLog?.(`extracting ${CA_SOURCE_PATH} from ${CA_SOURCE_IMAGE} (network ${network.arg})`);
    // No `-e` of any kind. Nothing in the daemon's environment is any of this
    // container's business, and `cat` takes no configuration.
    const got = await run([
      runtime,
      "run",
      "--rm",
      "--network",
      network.arg,
      ...extractionConfinement(cap),
      CA_SOURCE_IMAGE,
      "cat",
      CA_SOURCE_PATH,
    ]);
    return acceptCaBundle(got, runtime);
  } finally {
    if (network.created !== null) {
      // Swallowed exactly as `ContainerBackend` swallows its own teardown: this
      // runs on the failure path too, and a teardown error must not replace the
      // refusal that is on its way up. The log line is how it stays visible.
      const removed = await run([runtime, "network", "rm", network.created]).catch(() => undefined);
      onLog?.(
        removed?.code === 0
          ? `removed extraction network ${network.created}`
          : `extraction network ${network.created} could not be removed; remove it with \`${runtime} network rm ${network.created}\``,
      );
    }
  }
}

/**
 * Get the extraction a network of its own, or none at all.
 *
 * A `create` that fails is a refusal, not a fallback. Falling back would put
 * the container on the shared default network, which is the exact thing this
 * function exists to avoid, and it would do it at the moment something is
 * already wrong with the runtime's networking.
 */
async function openExtractionNetwork(run: CommandRunner, cap: RuntimeCapability): Promise<ExtractionNetwork> {
  if (cap.networkNone) return { arg: "none", created: null };
  const name = `${EXTRACT_NETWORK_PREFIX}${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const made = await run([cap.runtime, "network", "create", name]);
  if (made.code !== 0) {
    throw new ProvisionError(
      `${cap.runtime} could not create ${name}, the network the CA extraction was to run alone in (exit ` +
        `${made.code}): ${made.stderr.trim().slice(-STDERR_TAIL)}. Refusing rather than falling back to the ` +
        `shared default network, which every other container on this machine is also on.`,
      "container",
    );
  }
  return { arg: name, created: name };
}

/**
 * Decide whether what came back on stdout is the reviewed trust store.
 *
 * Split out from the run so the acceptance rule is one readable block with no
 * process management around it, and so a test can reach it through the runner
 * seam without caring how the container was started.
 */
function acceptCaBundle(got: CommandResult, runtime: string): Uint8Array {
  // PEM is ASCII, so string length is byte length here.
  if (got.code !== 0 || !got.stdout.startsWith(CA_PEM_HEADER) || got.stdout.length < CA_MIN_BYTES) {
    throw new ProvisionError(
      `extracting a CA bundle from ${CA_SOURCE_IMAGE} with ${runtime} did not return one (exit ${got.code}, ` +
        `${got.stdout.length} bytes on stdout, ` +
        `${got.stdout.startsWith(CA_PEM_HEADER) ? "PEM header present" : "no PEM header"}): ` +
        `${got.stderr.trim().slice(-STDERR_TAIL)}`,
      "container",
    );
  }
  const ca = new TextEncoder().encode(got.stdout);
  const sha256 = createHash("sha256").update(ca).digest("hex");
  // Byte count and digest, both against the manifest. The length is redundant
  // against the digest and is checked anyway, because it is free and because it
  // is the number that makes a truncation legible: "217048 bytes where 217769
  // were reviewed" diagnoses itself.
  if (ca.byteLength !== CA_BUNDLE_BYTES || !sameDigest(sha256, CA_BUNDLE_SHA256)) {
    throw new ProvisionError(refuseCaBundle(runtime, got.stdout, ca.byteLength, sha256), "container");
  }
  return ca;
}

/**
 * Why a bundle was refused, and what to do about it.
 *
 * One message for both the length mismatch and the digest mismatch, because an
 * operator does not care which of the two fired and the answer is the same
 * either way. It names the runtime, both digests, both byte counts and both
 * certificate counts, so the diagnosis is in the message rather than in a
 * follow-up investigation.
 */
function refuseCaBundle(runtime: string, text: string, bytes: number, sha256: string): string {
  const certs = text.split(CA_PEM_HEADER).length - 1;
  // Recognising the shape is a message improvement and never an acceptance:
  // this branch is only reachable from inside a refusal.
  const recognised = sameDigest(sha256, CA_BUNDLE_ORBSTACK_SHA256)
    ? ` That digest is recognised: it is exactly the reviewed bundle with "${CA_ORBSTACK_SUBJECT}" appended, which ` +
      `is what OrbStack's docker returns from this index.`
    : "";
  return (
    `the CA bundle ${runtime} extracted from ${CA_SOURCE_IMAGE} is not the reviewed one: sha256 ${sha256} ` +
    `(${bytes} bytes, ${certs} certificates) against the reviewed ${CA_BUNDLE_SHA256} ` +
    `(${CA_BUNDLE_BYTES} bytes, ${CA_BUNDLE_CERT_COUNT} certificates).${recognised} The image is pinned by digest ` +
    `and the extraction ran alone on a network of its own, so this is not the image moving under us: ${runtime} ` +
    `altered the trust store on the way out. Refusing, because this file becomes SSL_CERT_FILE for every model ` +
    `call the host makes, so an unreviewed certificate authority in it can intercept all of them. Three ways ` +
    `forward: run a runtime that does not rewrite the trust store, which on macOS means Apple's \`container\` and ` +
    `is one more reason it is the default; or set \`containerImage\` in \`<OMPD_HOME>/config.json\` to an image ` +
    `carrying its ` +
    `own trust store, which is the operator-owned path where ompd mounts nothing and checks nothing; or review ` +
    `the new bundle yourself and update CA_BUNDLE_SHA256 in ` +
    `packages/daemon/src/provisioner/toolchain-manifest.ts.`
  );
}

const fetchAsset = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) throw new ProvisionError(`downloading ${url} failed: HTTP ${res.status}`, "container");
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Fetch the reviewed release and prove it is the reviewed release.
 *
 * Every failure here is a `ProvisionError` raised before anything touches the
 * filesystem, which is stronger than staging and deleting: there is no window
 * in which a rejected download exists on disk for a later run to find, so there
 * is nothing to clean up and nothing to get wrong while cleaning up. The
 * download is held in memory precisely so that is true.
 *
 * Length is checked before the digest because it is free and it is the common
 * failure: a truncated transfer or an HTML error page served with a 200. Zero
 * bytes gets its own message, since it lands cleanly if unchecked and then
 * every `exec` in the container fails with an exec-format error, which is a
 * much worse place to learn the release was not there.
 */
async function downloadOmp(release: OmpRelease, fetcher: (url: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  let omp: Uint8Array;
  try {
    omp = await fetcher(release.url);
  } catch (err) {
    if (err instanceof ProvisionError) throw err;
    throw new ProvisionError(`downloading ${release.url} failed: ${String(err)}`, "container", { cause: err });
  }
  if (omp.byteLength === 0) throw new ProvisionError(`${release.url} returned an empty body`, "container");
  if (omp.byteLength !== release.bytes) {
    throw new ProvisionError(
      `${release.url} returned ${omp.byteLength} bytes, but omp ${release.version} (linux/${release.arch}) is ` +
        `${release.bytes} bytes in the reviewed manifest; refusing it, and nothing was written to disk`,
      "container",
    );
  }
  const sha256 = createHash("sha256").update(omp).digest("hex");
  if (!sameDigest(sha256, release.sha256)) {
    throw new ProvisionError(
      `${release.url} returned sha256 ${sha256}, but omp ${release.version} (linux/${release.arch}) is reviewed as ` +
        `${release.sha256}; refusing it, and nothing was written to disk. Either the release was re-cut, or ` +
        `something between the release and here substituted it.`,
      "container",
    );
  }
  return omp;
}

/**
 * Compare two hex digests.
 *
 * Constant-time, which is admittedly close to theatre for a locally computed
 * hash: nobody is timing this loop across a network. It costs one allocation
 * and removes the need to think about it, and the habit is the right one in a
 * file whose whole job is comparing digests. Lengths are compared first because
 * `timingSafeEqual` throws on a mismatch, and a differing length is public
 * information anyway.
 */
function sameDigest(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * Populate the cache directory, atomically. Returns whether this call is the
 * one that created it.
 *
 * Everything is written into a staging directory in the same parent and then
 * renamed, so the directory a later run finds either has all three files or
 * does not exist. A killed download that had written straight to the final path
 * would leave a partial binary under a name asserting a digest, which
 * `probeCache` would then have to be trusted to catch every time.
 *
 * Each file is fsynced before the rename. The parent directory deliberately is
 * not: losing the rename in a crash is a cache miss and costs a re-download,
 * whereas losing a file's contents under a name that did land is a poisoned
 * cache. Only one of those two directions is worth paying for.
 *
 * The cache root is created and then re-chmodded to 0700 on every call, not
 * only when it is new. The root is where the staging directory is made and
 * where the rename lands, so a root another account can write to lets someone
 * pre-create the target name or swap it between the rename and the mount, which
 * is a hole in the entry check rather than in the entry. The root is repaired
 * rather than rejected because rejecting it has no recovery path, and unlike an
 * entry it holds nothing whose contents could be verified instead.
 *
 * Files are 0555 / 0444 inside a 0700 directory. Owner-only on the directory is
 * what matters; the file modes are there so nothing in the tree is writable
 * once landed. Both runtimes read this layout from inside the guest, measured
 * (see `CACHE_MODE`).
 */
function land(cacheRoot: string, dir: string, files: { omp: Uint8Array; shim: string; ca: Uint8Array }): boolean {
  mkdirSync(cacheRoot, { recursive: true, mode: CACHE_MODE });
  chmodSync(cacheRoot, CACHE_MODE);
  const staging = mkdtempSync(join(cacheRoot, ".staging-"));
  try {
    writeDurable(join(staging, OMP_NAME), files.omp, 0o555);
    writeDurable(join(staging, SHIM_NAME), new TextEncoder().encode(files.shim), 0o555);
    writeDurable(join(staging, CA_BUNDLE_NAME), files.ca, 0o444);
    chmodSync(staging, CACHE_MODE);
    try {
      renameSync(staging, dir);
      return true;
    } catch (err) {
      // Narrowed rather than asserted: `err` really is unknown here, and the
      // only two codes that mean "someone else got there first" are these.
      // Anything else is a broken cache root, which must not read as a race.
      const code =
        err !== null && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : "";
      if (code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw new ProvisionError(`cannot place the toolchain at ${dir}: ${String(err)}`, "container", { cause: err });
      }
      // A concurrent provision landed the same content-addressed directory
      // first. Whether theirs holds what ours would have is not assumed: the
      // caller re-probes the landed directory against the manifest either way.
      return false;
    }
  } finally {
    // A no-op after a successful rename, since the staging path is gone.
    rmSync(staging, { recursive: true, force: true });
  }
}

function writeDurable(path: string, bytes: Uint8Array, mode: number): void {
  // Write access comes from the open, so a read-only mode on the new file is
  // fine: it applies to every later open, which is the point.
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
