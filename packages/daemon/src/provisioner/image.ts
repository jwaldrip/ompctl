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
 * The cache directory is named `omp-<version>-<arch>-<sha12>`, so its name
 * asserts its contents. That is the whole cache: a name that still matches the
 * sha256 of the binary inside it is a hit, and anything else is a miss. There
 * is no state in which a stale or truncated toolchain is reused under a name
 * claiming to be current, which is exactly what a `:latest` tag on a locally
 * built image cannot promise.
 *
 * Precedence is operator-first. `spec.image`, then `OMPD_CONTAINER_IMAGE`
 * (handed in as `envImage` rather than read here, so this module stays a
 * function of its arguments), then the default base plus a mounted toolchain.
 * An operator who names an image owns what is in it: nothing is mounted over
 * it, nothing is downloaded, and `omp` is left to resolve on its PATH.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostSpec } from "@ompd/core";
import { execCommand } from "./exec.ts";
import { type CommandRunner, ProvisionError } from "./types.ts";

/**
 * The base image every default container host runs.
 *
 * Chosen by measurement, not by taste. The omp release is a glibc build, so on
 * `alpine:3.20` it cannot even be executed: the runtime reports
 * `Failed to exec [/opt/ompd/omp --version] Error Domain=NSPOSIXErrorDomain
 * Code=2 "No such file or directory"`, which is what a missing glibc loader
 * looks like from outside. On `debian:bookworm-slim` the same mount prints
 * `omp/18.0.4`. debian-slim also already carries every coreutil the gate
 * wrapper's far side and the shim need: sh, mkdir, chmod, tee, cat, cp, mktemp.
 *
 * Qualified `debian:bookworm-slim` rather than a bare name on purpose. Every
 * runtime here resolves it to Docker Hub's public library, which is the point:
 * the image is pullable with no credential, which is the failure this whole
 * module exists to remove.
 */
export const DEFAULT_BASE_IMAGE = "debian:bookworm-slim";

/** Where the toolchain cache directory is bind-mounted, read-only, inside the container. */
export const TOOLCHAIN_MOUNT_PATH = "/opt/ompd";

/**
 * Where a CA bundle comes from.
 *
 * Neither `debian:bookworm-slim` nor `debian:bookworm` ships
 * `/etc/ssl/certs/ca-certificates.crt` (verified: `ls` inside debian-slim gives
 * `cannot access '/etc/ssl/certs/ca-certificates.crt': No such file or
 * directory`), and omp reaches a model over TLS. Alpine does ship one, so it is
 * copied out of a public image once instead of running `apt-get` in a container
 * that has no reason to have a package manager pointed at the network.
 * `container run --rm alpine:3.20 cat /etc/ssl/certs/ca-certificates.crt`
 * yielded 217769 bytes, 145 certificates, starting exactly with
 * `-----BEGIN CERTIFICATE-----` and with empty stderr.
 */
export const CA_SOURCE_IMAGE = "alpine:3.20";

const CA_SOURCE_PATH = "/etc/ssl/certs/ca-certificates.crt";
const CA_BUNDLE_NAME = "ca-certificates.crt";
const CA_PEM_HEADER = "-----BEGIN CERTIFICATE-----";

/**
 * Floor for an accepted CA bundle. The real one is 217769 bytes; anything this
 * small is a truncated read or a runtime printing something conversational to
 * stdout, and caching either as though it were a trust store would turn a loud
 * TLS failure into a quiet one.
 */
const CA_MIN_BYTES = 1000;

/** Name the shim lands under, and therefore the entrypoint the backend runs. */
const SHIM_NAME = "omp-shim";

const OMP_NAME = "omp";

/** Public, unauthenticated. This is the whole reason the private default is gone. */
const RELEASE_BASE = "https://github.com/can1357/oh-my-pi/releases/download";

/** How much of the digest names the cache directory. 48 bits is ample for one host's cache. */
const DIGEST_LENGTH = 12;

/** Enough of a runtime's own stderr to diagnose from, without pasting a log into an HTTP response. */
const STDERR_TAIL = 800;

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
  spec: HostSpec;
  run?: CommandRunner;
  cacheRoot?: string;
  /** The caller's `process.env.OMPD_CONTAINER_IMAGE`. */
  envImage?: string;
  ompVersion?: string;
  arch?: string;
  fetchAsset?: (url: string) => Promise<Uint8Array>;
  onLog?: (line: string) => void;
}

export interface ResolvedToolchain {
  /** Base image to run. Pulled by the runtime exactly as written. */
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
 * a hit.
 *
 * Version and arch are in the name so a human can read the directory listing,
 * and the digest is in it so the name is a claim about the contents that can be
 * checked. Nothing here is hashed together: the digest is the omp binary's own,
 * so `sha256` of the file inside either matches the name or the directory is
 * not trustworthy.
 */
export function toolchainDir(cacheRoot: string, inputs: ToolchainInputs, ompSha256: string): string {
  return join(cacheRoot, `omp-${inputs.ompVersion}-${inputs.arch}-${ompSha256.slice(0, DIGEST_LENGTH)}`);
}

export async function ensureToolchain(opts: EnsureToolchainOptions): Promise<ResolvedToolchain> {
  // Trimming is the one normalisation applied to an operator's image name: a
  // value read from a config file or a launchd plist can carry a trailing
  // newline, which would otherwise reach argv and be reported by the runtime as
  // part of the image name. Whitespace-only counts as unset, because an empty
  // OMPD_CONTAINER_IMAGE means "not configured" and must not defeat the default
  // that now works.
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

  // Rendered before anything is fetched, so a shim whose shape has drifted
  // costs nothing. It is also needed on the hit path, to notice a cached
  // toolchain still carrying a superseded shim.
  const shim = renderOmpHomeShim(`${TOOLCHAIN_MOUNT_PATH}/${OMP_NAME}`);

  const hit = findCached(cacheRoot, inputs);
  if (hit !== null) {
    refreshShim(hit.dir, shim, opts.onLog);
    opts.onLog?.(`toolchain ${hit.dir} already cached (omp ${ompVersion}, linux/${arch})`);
    return resolved(hit, true);
  }

  // Cheapest first, so a runtime that cannot run anything fails before a
  // 145MB download rather than after it.
  const ca = await extractCaBundle(run, opts.runtime, opts.onLog);
  const url = `${RELEASE_BASE}/v${ompVersion}/omp-linux-${arch}`;
  opts.onLog?.(`downloading ${url}`);
  const omp = await downloadOmp(url, opts.fetchAsset ?? fetchAsset);

  const ompSha256 = createHash("sha256").update(omp).digest("hex");
  const caSha256 = createHash("sha256").update(ca).digest("hex");
  const dir = toolchainDir(cacheRoot, inputs, ompSha256);
  const populated = land(cacheRoot, dir, { omp, shim, ca });

  // What landed, not what was intended. The rename is atomic and the files were
  // fsynced before it, so this should never fire; it fires anyway, because the
  // cost of being wrong is a container that runs a corrupt binary and blames
  // omp for it.
  const landedSha = createHash("sha256")
    .update(readFileSync(join(dir, OMP_NAME)))
    .digest("hex");
  if (landedSha !== ompSha256) {
    throw new ProvisionError(
      `toolchain ${dir} holds omp with sha256 ${landedSha}, expected ${ompSha256}; refusing to mount it`,
      "container",
    );
  }

  opts.onLog?.(`toolchain ${dir} ready (omp ${ompVersion}, linux/${arch}, sha256 ${ompSha256})`);
  return resolved({ dir, ompSha256, caSha256 }, !populated);
}

interface CachedToolchain {
  dir: string;
  ompSha256: string;
  caSha256: string;
}

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
 * A complete cached toolchain for these inputs, or null.
 *
 * The directory name carries the digest, so the search cannot be a single
 * `statSync`: the sha is only known after a download, which is the thing a hit
 * is meant to avoid. So candidates are found by the `omp-<version>-<arch>-`
 * prefix and then each one's own claim is checked against its contents. That
 * makes the check and the lookup the same operation, and it means a directory
 * left behind holding a truncated binary reads as a miss rather than as a hit.
 *
 * Hashing 145MB costs 0.33s on this machine (`shasum -a 256` on the real
 * release), against a provision that is already pulling and booting a container.
 * Trusting the name instead would make a poisoned cache permanent and silent,
 * which is not a trade worth 0.33s.
 */
function findCached(cacheRoot: string, inputs: ToolchainInputs): CachedToolchain | null {
  const prefix = `omp-${inputs.ompVersion}-${inputs.arch}-`;
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return null; // No cache root yet. First provision on this machine.
  }

  for (const name of entries.filter(entry => entry.startsWith(prefix)).sort()) {
    const dir = join(cacheRoot, name);
    try {
      const ompSha256 = createHash("sha256")
        .update(readFileSync(join(dir, OMP_NAME)))
        .digest("hex");
      if (ompSha256.slice(0, DIGEST_LENGTH) !== name.slice(prefix.length)) continue;
      statSync(join(dir, SHIM_NAME));
      const caSha256 = createHash("sha256")
        .update(readFileSync(join(dir, CA_BUNDLE_NAME)))
        .digest("hex");
      return { dir, ompSha256, caSha256 };
    } catch {}
  }
  return null;
}

/**
 * Keep a cached toolchain's shim current.
 *
 * The directory is named after the omp binary, not the shim, so editing
 * `omp-home-shim.sh` does not change the directory name and every existing
 * cache entry would otherwise keep serving the old shim forever. The shim is
 * the code that decides whether an OMP home seeded on the workspace mount is
 * picked up or refused, so silently pinning an old copy of it is a security
 * behaviour going stale, not a cosmetic staleness. Two kilobytes, compared on
 * every hit, renamed over only when it actually differs.
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
 * architecture passes `arch`.
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
 * Copy a trust store out of a public image.
 *
 * Through the `CommandRunner` like everything else, so tests never pull an
 * image. The result is checked rather than trusted: a runtime that fails here
 * still exits with a code and prints something, and a bundle that is short or
 * does not open with a PEM header is an error page or a truncated read. Caching
 * either one would replace a loud TLS failure at the first model call with a
 * quiet one, which is the worse of the two.
 */
async function extractCaBundle(
  run: CommandRunner,
  runtime: string,
  onLog?: (line: string) => void,
): Promise<Uint8Array> {
  onLog?.(`extracting ${CA_SOURCE_PATH} from ${CA_SOURCE_IMAGE}`);
  const got = await run([runtime, "run", "--rm", CA_SOURCE_IMAGE, "cat", CA_SOURCE_PATH]);
  // PEM is ASCII, so string length is byte length here.
  if (got.code !== 0 || !got.stdout.startsWith(CA_PEM_HEADER) || got.stdout.length < CA_MIN_BYTES) {
    throw new ProvisionError(
      `extracting a CA bundle from ${CA_SOURCE_IMAGE} failed (exit ${got.code}, ${got.stdout.length} bytes on stdout): ${got.stderr.trim().slice(-STDERR_TAIL)}`,
      "container",
    );
  }
  return new TextEncoder().encode(got.stdout);
}

const fetchAsset = async (url: string): Promise<Uint8Array> => {
  const res = await fetch(url);
  if (!res.ok) throw new ProvisionError(`downloading ${url} failed: HTTP ${res.status}`, "container");
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Every download failure becomes a `ProvisionError` before anything is written,
 * so nothing is ever laid down over a truncated or absent binary. Zero bytes is
 * refused for the same reason: it lands cleanly and then every `exec` in that
 * container fails with an exec-format error, which is a much worse place to
 * learn the release was not there.
 */
async function downloadOmp(url: string, fetcher: (url: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  let omp: Uint8Array;
  try {
    omp = await fetcher(url);
  } catch (err) {
    if (err instanceof ProvisionError) throw err;
    throw new ProvisionError(`downloading ${url} failed: ${String(err)}`, "container", { cause: err });
  }
  if (omp.byteLength === 0) throw new ProvisionError(`${url} returned an empty body`, "container");
  return omp;
}

/**
 * Populate the cache directory, atomically. Returns whether this call is the
 * one that created it.
 *
 * Everything is written into a staging directory in the same parent and then
 * renamed, so the directory a later run finds either has all three files or
 * does not exist. A killed download that had written straight to the final path
 * would leave a partial binary under a name asserting a digest, which
 * `findCached` would then have to be trusted to catch every time.
 *
 * Each file is fsynced before the rename. The parent directory deliberately is
 * not: losing the rename in a crash is a cache miss and costs a re-download,
 * whereas losing a file's contents under a name that did land is a poisoned
 * cache. Only one of those two directions is worth paying for.
 *
 * Modes are 0555 / 0444 in a 0755 directory, matching the layout the live probe
 * ran against. Nothing secret is in here (a public binary, a public shim, a
 * public trust store), and the mount has to be readable by whatever uid the
 * guest runs as, which on Apple's runtime is root.
 */
function land(cacheRoot: string, dir: string, files: { omp: Uint8Array; shim: string; ca: Uint8Array }): boolean {
  mkdirSync(cacheRoot, { recursive: true });
  const staging = mkdtempSync(join(cacheRoot, ".staging-"));
  try {
    writeDurable(join(staging, OMP_NAME), files.omp, 0o555);
    writeDurable(join(staging, SHIM_NAME), new TextEncoder().encode(files.shim), 0o555);
    writeDurable(join(staging, CA_BUNDLE_NAME), files.ca, 0o444);
    chmodSync(staging, 0o755);
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
      // first. Same digest means same bytes, so theirs is ours; the only cost
      // is the download we duplicated.
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
