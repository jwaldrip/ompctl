/**
 * The container toolchain is what replaced a private image nobody could pull.
 * Three properties matter more than the rest, and each is written here to fail
 * loudly if it regresses.
 *
 * 1. An operator who names an image owns it. `spec.image` and
 *    `OMPD_CONTAINER_IMAGE` short-circuit everything: no download, no CA
 *    extraction, nothing mounted over their image. The assertions check the
 *    recorded argv list is empty and the injected fetcher was never called,
 *    because "we did not run anything" is the actual claim.
 * 2. The cache cannot go stale silently. The directory name carries the omp
 *    binary's digest, so a hit is a name that still matches its contents. A
 *    tampered directory reads as a miss, and a landed directory whose contents
 *    disagree with the name is refused rather than mounted.
 * 3. A failure leaves nothing behind. A download or extraction that fails must
 *    not leave a half-populated toolchain, or a staging directory, that a later
 *    run could treat as real.
 *
 * No container runtime and no network is touched: the runtime is a
 * `CommandRunner` this file supplies and the release asset is an injected
 * fetcher. The one thing deliberately read off disk is the real
 * `scripts/omp-home-shim.sh`, because the shim rewrite asserts against a line
 * in that file and a test using a fabricated copy would keep passing after
 * someone edited it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostSpec } from "@ompd/core";
import {
  CA_SOURCE_IMAGE,
  DEFAULT_BASE_IMAGE,
  ensureToolchain,
  TOOLCHAIN_MOUNT_PATH,
  toolchainDir,
} from "../src/provisioner/image.ts";
import type { CommandResult, CommandRunner } from "../src/provisioner/types.ts";
import { ProvisionError } from "../src/provisioner/types.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const REPO_SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts");

const OMP_BYTES = new TextEncoder().encode("#!/fake-elf\nomp payload\n");
const OMP_SHA = createHash("sha256").update(OMP_BYTES).digest("hex");

/** Long enough to clear the module's 1000-byte floor, and shaped like a real bundle. */
const CA_PEM = `-----BEGIN CERTIFICATE-----\n${"QUJD".repeat(500)}\n-----END CERTIFICATE-----\n`;
const CA_SHA = createHash("sha256").update(new TextEncoder().encode(CA_PEM)).digest("hex");

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
}

function harness(opts: HarnessOptions = {}): Harness {
  const argv: string[][] = [];
  const fetched: string[] = [];
  return {
    argv,
    fetched,
    run: async (command: string[]): Promise<CommandResult> => {
      argv.push([...command]);
      if (command[0] === "omp" && command[1] === "--version") {
        return { code: opts.versionCode ?? 0, stdout: opts.version ?? "omp/18.0.4\n", stderr: "" };
      }
      if (command.includes("cat")) {
        return { code: opts.caCode ?? 0, stdout: opts.ca ?? CA_PEM, stderr: opts.caCode === 0 ? "" : "boom" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    fetchAsset: async (url: string): Promise<Uint8Array> => {
      fetched.push(url);
      if (opts.downloadError !== undefined) throw opts.downloadError;
      return opts.omp ?? OMP_BYTES;
    },
  };
}

/** A scripts dir holding a shim whose exec line the module will not recognise. */
function brokenScriptsDir(): string {
  const dir = tempDir("ompd-scripts-");
  writeFileSync(join(dir, "omp-home-shim.sh"), '#!/bin/sh\nexec /somewhere/else/omp "$@"\n');
  return dir;
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

  test("a whitespace-only image counts as unset, so the default still works", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: { kind: "container", image: "   " },
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      envImage: "\n",
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
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
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    expect(resolved.source).toBe("default");
    expect(resolved.image).toBe(DEFAULT_BASE_IMAGE);
    expect(resolved.cached).toBe(false);
    expect(resolved.ompSha256).toBe(OMP_SHA);
    expect(resolved.caSha256).toBe(CA_SHA);
    expect(resolved.toolsDir).toBe(toolchainDir(cacheRoot, { ompVersion: "18.0.4", arch: "arm64" }, OMP_SHA));
    expect(resolved.mountPath).toBe(TOOLCHAIN_MOUNT_PATH);

    // The entrypoint is the shim, not the binary: the shim is what picks up an
    // OMP home seeded on the workspace mount.
    expect(resolved.ompPath).toBe(`${TOOLCHAIN_MOUNT_PATH}/omp-shim`);
    expect(resolved.env).toEqual({ SSL_CERT_FILE: `${TOOLCHAIN_MOUNT_PATH}/ca-certificates.crt` });

    const dir = resolved.toolsDir!;
    expect(readFileSync(join(dir, "omp"))).toEqual(Buffer.from(OMP_BYTES));
    expect(readFileSync(join(dir, "ca-certificates.crt"), "utf8")).toBe(CA_PEM);
    expect(h.fetched).toEqual(["https://github.com/can1357/oh-my-pi/releases/download/v18.0.4/omp-linux-arm64"]);
  });

  test("extracts the CA bundle through the runtime, from a public image", async () => {
    const h = harness();
    await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    expect(h.argv).toEqual([
      ["container", "run", "--rm", CA_SOURCE_IMAGE, "cat", "/etc/ssl/certs/ca-certificates.crt"],
    ]);
  });

  test("the landed shim execs the mounted binary, not the old image path", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    const shim = readFileSync(join(resolved.toolsDir!, "omp-shim"), "utf8");
    expect(shim).toContain(`exec ${TOOLCHAIN_MOUNT_PATH}/omp "$@"`);
    expect(shim).not.toContain("/usr/local/lib/omp/omp");
    // The rest of the shim is carried over, credential handling included.
    expect(shim).toContain("refusing to fall back to the image's HOME");
  });

  test("files are world-readable and unwritable, in a traversable directory", async () => {
    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    const dir = resolved.toolsDir!;
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, "omp")).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, "omp-shim")).mode & 0o777).toBe(0o555);
    expect(statSync(join(dir, "ca-certificates.crt")).mode & 0o777).toBe(0o444);
  });

  test("no staging directory survives a successful landing", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");
    await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    expect(readdirSync(cacheRoot).filter(entry => entry.startsWith(".staging-"))).toEqual([]);
  });

  test("resolves the version from omp --version and the arch from the option", async () => {
    const h = harness({ version: "omp/9.9.9\n" });
    await ensureToolchain({
      runtime: "podman",
      spec: SPEC,
      run: h.run,
      cacheRoot: tempDir("ompd-cache-"),
      scriptsDir: REPO_SCRIPTS,
      arch: "x64",
      fetchAsset: h.fetchAsset,
    });

    expect(h.argv[0]).toEqual(["omp", "--version"]);
    expect(h.fetched).toEqual(["https://github.com/can1357/oh-my-pi/releases/download/v9.9.9/omp-linux-x64"]);
  });
});

// ---------------------------------------------------------------------------
// Cache hits
// ---------------------------------------------------------------------------

describe("a cached toolchain", () => {
  test("is reused without a download or a CA extraction", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const first = harness();
    const populated = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: first.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: first.fetchAsset,
    });

    const second = harness();
    const hit = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: second.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: second.fetchAsset,
    });

    expect(hit.cached).toBe(true);
    expect(hit.toolsDir).toBe(populated.toolsDir);
    expect(hit.ompSha256).toBe(OMP_SHA);
    expect(hit.caSha256).toBe(CA_SHA);
    expect(second.fetched).toEqual([]);
    expect(second.argv).toEqual([]);
  });

  test("a tampered binary reads as a miss rather than a hit", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const first = harness();
    const populated = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: first.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: first.fetchAsset,
    });

    // Truncate it the way a killed process would have, and make it writable
    // first because the landed file is 0555 on purpose.
    const omp = join(populated.toolsDir!, "omp");
    chmodSync(omp, 0o644);
    writeFileSync(omp, "");
    chmodSync(omp, 0o555);

    const second = harness();
    // The rename onto the existing directory loses, and the post-landing digest
    // check then refuses to hand back a directory holding the wrong bytes.
    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: second.run,
        cacheRoot,
        scriptsDir: REPO_SCRIPTS,
        ompVersion: "18.0.4",
        arch: "arm64",
        fetchAsset: second.fetchAsset,
      }),
    ).rejects.toThrow(ProvisionError);
    // It did not silently trust the name: it went and fetched.
    expect(second.fetched.length).toBe(1);
  });

  test("a superseded shim is refreshed in place, still without a download", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const scriptsDir = tempDir("ompd-scripts-");
    const realShim = readFileSync(join(REPO_SCRIPTS, "omp-home-shim.sh"), "utf8");
    writeFileSync(join(scriptsDir, "omp-home-shim.sh"), realShim);

    const first = harness();
    const populated = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: first.run,
      cacheRoot,
      scriptsDir,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: first.fetchAsset,
    });

    writeFileSync(join(scriptsDir, "omp-home-shim.sh"), realShim.replace("set -eu", "set -eu\n# a later fix\n"));

    const second = harness();
    const hit = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: second.run,
      cacheRoot,
      scriptsDir,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: second.fetchAsset,
    });

    expect(hit.cached).toBe(true);
    expect(second.fetched).toEqual([]);
    const shim = readFileSync(join(populated.toolsDir!, "omp-shim"), "utf8");
    expect(shim).toContain("# a later fix");
    expect(shim).toContain(`exec ${TOOLCHAIN_MOUNT_PATH}/omp "$@"`);
    expect(readdirSync(populated.toolsDir!).sort()).toEqual(["ca-certificates.crt", "omp", "omp-shim"]);
  });

  test("another version or arch does not collide with the cached one", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    const first = harness();
    await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: first.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: first.fetchAsset,
    });

    const second = harness();
    const other = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: second.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.5",
      arch: "arm64",
      fetchAsset: second.fetchAsset,
    });

    expect(other.cached).toBe(false);
    expect(second.fetched).toEqual(["https://github.com/can1357/oh-my-pi/releases/download/v18.0.5/omp-linux-arm64"]);
    expect(readdirSync(cacheRoot).sort()).toEqual([
      `omp-18.0.4-arm64-${OMP_SHA.slice(0, 12)}`,
      `omp-18.0.5-arm64-${OMP_SHA.slice(0, 12)}`,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Failures leave nothing behind
// ---------------------------------------------------------------------------

describe("a failed toolchain", () => {
  /** Nothing landed, and no staging directory either. */
  function expectEmptyCache(cacheRoot: string): void {
    expect(readdirSync(cacheRoot)).toEqual([]);
  }

  test("a failing download throws and lands nothing", async () => {
    const h = harness({ downloadError: new Error("connection reset") });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot,
        scriptsDir: REPO_SCRIPTS,
        ompVersion: "18.0.4",
        arch: "arm64",
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(ProvisionError);
    expectEmptyCache(cacheRoot);
  });

  test("an empty release body is refused rather than mounted", async () => {
    const h = harness({ omp: new Uint8Array(0) });
    const cacheRoot = tempDir("ompd-cache-");

    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot,
        scriptsDir: REPO_SCRIPTS,
        ompVersion: "18.0.4",
        arch: "arm64",
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(/empty body/);
    expectEmptyCache(cacheRoot);
  });

  test("a short or non-PEM CA bundle is refused before any download", async () => {
    for (const ca of ["", "not a certificate at all", `-----BEGIN CERTIFICATE-----\nshort\n`]) {
      const h = harness({ ca });
      const cacheRoot = tempDir("ompd-cache-");

      await expect(
        ensureToolchain({
          runtime: "container",
          spec: SPEC,
          run: h.run,
          cacheRoot,
          scriptsDir: REPO_SCRIPTS,
          ompVersion: "18.0.4",
          arch: "arm64",
          fetchAsset: h.fetchAsset,
        }),
      ).rejects.toThrow(/CA bundle/);
      expect(h.fetched).toEqual([]);
      expectEmptyCache(cacheRoot);
    }
  });

  test("a non-zero CA extraction is refused even if stdout looks like a bundle", async () => {
    const h = harness({ caCode: 125 });
    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot: tempDir("ompd-cache-"),
        scriptsDir: REPO_SCRIPTS,
        ompVersion: "18.0.4",
        arch: "arm64",
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(/exit 125/);
  });

  test("a shim whose exec line moved is refused before any download", async () => {
    const h = harness();
    const cacheRoot = tempDir("ompd-cache-");

    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot,
        scriptsDir: brokenScriptsDir(),
        ompVersion: "18.0.4",
        arch: "arm64",
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(/no longer contains/);
    expect(h.fetched).toEqual([]);
    expect(h.argv).toEqual([]);
    expectEmptyCache(cacheRoot);
  });

  test("a missing scripts directory names the path it could not read", async () => {
    const h = harness();
    const missing = join(tempDir("ompd-scripts-"), "gone");

    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot: tempDir("ompd-cache-"),
        scriptsDir: missing,
        ompVersion: "18.0.4",
        arch: "arm64",
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(join(missing, "omp-home-shim.sh"));
  });

  test("omp not on PATH is a named failure, not a 404 URL", async () => {
    const h = harness({ version: "", versionCode: 127 });

    await expect(
      ensureToolchain({
        runtime: "container",
        spec: SPEC,
        run: h.run,
        cacheRoot: tempDir("ompd-cache-"),
        scriptsDir: REPO_SCRIPTS,
        arch: "arm64",
        fetchAsset: h.fetchAsset,
      }),
    ).rejects.toThrow(/omp is not on PATH/);
    expect(h.fetched).toEqual([]);
  });

  test("a cache root that cannot be read is a miss, not a crash", async () => {
    // `findCached` has to tolerate an absent root: the first provision on a
    // machine runs before anything has created it.
    const h = harness();
    const cacheRoot = join(tempDir("ompd-cache-"), "nested", "toolchain");
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    expect(resolved.cached).toBe(false);
    expect(statSync(resolved.toolsDir!).isDirectory()).toBe(true);
  });

  test("an unrelated directory sharing the prefix is skipped, not mounted", async () => {
    const cacheRoot = tempDir("ompd-cache-");
    // Same version and arch, and complete: all three files present, so the only
    // thing that can reject it is the digest in its own name failing to match
    // the binary inside. An incomplete decoy would be skipped for being
    // incomplete and would prove nothing about the digest check.
    const decoy = join(cacheRoot, "omp-18.0.4-arm64-deadbeefcafe");
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, "omp"), "not the release");
    writeFileSync(join(decoy, "omp-shim"), '#!/bin/sh\nexec /opt/ompd/omp "$@"\n');
    writeFileSync(join(decoy, "ca-certificates.crt"), CA_PEM);

    const h = harness();
    const resolved = await ensureToolchain({
      runtime: "container",
      spec: SPEC,
      run: h.run,
      cacheRoot,
      scriptsDir: REPO_SCRIPTS,
      ompVersion: "18.0.4",
      arch: "arm64",
      fetchAsset: h.fetchAsset,
    });

    expect(resolved.cached).toBe(false);
    expect(resolved.toolsDir).toBe(join(cacheRoot, `omp-18.0.4-arm64-${OMP_SHA.slice(0, 12)}`));
    expect(h.fetched.length).toBe(1);
  });
});
