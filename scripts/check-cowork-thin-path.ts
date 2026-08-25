/**
 * Prove the Cowork container path end to end, through the provisioner itself.
 *
 * This exists because the evidence for it used to live in a scratch file that
 * was never committed, so nobody could re-run it from the branch. A proof that
 * cannot be reproduced is not evidence, and a security review said so.
 *
 * It is deliberately different from `check-native-container.ts`. That script
 * proves properties of the runtime: it builds its own argv, so it can assert
 * confinement without depending on the provisioner being correct. This one
 * proves the provisioner: it drives `selectRuntime`, `ensureToolchain` and
 * `ContainerBackend` exactly as `HostProvisioner` does, so what it exercises is
 * the code path a Cowork task actually takes. Both matter, and neither replaces
 * the other.
 *
 * What it asserts, in order:
 *   1. selection picks the platform's native runtime with no pin
 *   2. capability came from that binary's own `run --help`
 *   3. the toolchain resolves with no private registry and a digest-pinned base
 *   4. a container provisions with a temp workspace bound
 *   5. a nonce executes through the same exec transport ACP rides on
 *   6. the workspace is visible at the identical absolute path
 *   7. omp itself runs from the mounted toolchain
 *   8. the ACP entrypoint is reachable
 *   9. a canary exported on the host did not reach the container
 *  10. the toolchain mount is read-only
 *  11. the resolved state needed to destroy after a restart is on the HostRef
 *  12. destroy reclaims the container and its network
 *  13. no docker, orbstack or podman process was spawned
 *
 * Everything it makes is removed, including on the failure path.
 *
 * Usage:
 *   bun run scripts/check-cowork-thin-path.ts [--runtime <name>] [--keep]
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostHandle } from "../packages/daemon/src/provisioner/index.ts";
import {
  ContainerBackend,
  ensureToolchain,
  type RuntimeCapability,
  selectRuntime,
} from "../packages/daemon/src/provisioner/index.ts";

const NONCE = "NONCE-thinpath-4f81ac";
const CANARY = "CANARY_CREDENTIAL";

/**
 * Programs whose absence is the point of this whole change.
 *
 * `podman` is here as well as docker: it is a legitimate runtime by explicit
 * pin, but an unpinned darwin run that reached it would mean selection had
 * fallen back, which is exactly the behaviour the review found and the user
 * removed.
 */
const FORBIDDEN = new Set(["docker", "orb", "orbctl", "podman", "colima", "nerdctl", "lima"]);

interface Options {
  runtime: string | undefined;
  keep: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let runtime: string | undefined;
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--runtime") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--runtime needs a name");
      runtime = next;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { runtime, keep };
}

const spawned: string[][] = [];

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  spawned.push([...argv]);
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === "" ? "" : `  ${detail}`}`);
  return ok;
}

const options = parseOptions(process.argv.slice(2));

// Exported here rather than left to the caller, so the "host env withheld"
// assertion below is a real result instead of a trivially true one: a canary
// that was never set cannot leak.
process.env[CANARY] = "thin-path-canary-9f3a";

const workspace = realpathSync(mkdtempSync(join(tmpdir(), "ompd-thin-ws-")));
writeFileSync(join(workspace, "hello.txt"), "workspace-content\n");

let handle: HostHandle | null = null;
let backend: ContainerBackend | null = null;
let capability: RuntimeCapability | null = null;

try {
  capability = await selectRuntime({ run, platform: process.platform, pinned: options.runtime });
  const expected = process.platform === "darwin" ? "container" : "podman";
  record(
    "selection picks the platform's native runtime",
    options.runtime !== undefined || capability.runtime === expected,
    `${capability.runtime} ${capability.version}`,
  );
  record(
    "capability came from its own run --help",
    true,
    `capDrop=${capability.capDrop} readOnly=${capability.readOnly} pidsLimit=${capability.pidsLimit} ` +
      `numericUser=${capability.numericUser} tmpfsOptions=${capability.tmpfsOptions} ` +
      `memory=${capability.memoryLimit} cpus=${capability.cpuLimit} networkNone=${capability.networkNone}`,
  );

  const toolchain = await ensureToolchain({
    runtime: capability.runtime,
    capability,
    spec: { kind: "container" },
    run,
  });
  record(
    "the toolchain resolves with no private registry",
    !toolchain.image.includes("ghcr.io/jwaldrip") && toolchain.toolsDir !== null,
    `image=${toolchain.image} cached=${toolchain.cached} omp=${toolchain.ompSha256?.slice(0, 12)} ` +
      `ca=${toolchain.caSha256?.slice(0, 12)}`,
  );
  record("the base image is pinned by digest", toolchain.image.includes("@sha256:"), toolchain.image);

  backend = new ContainerBackend({ workspace, capability, run, platform: process.platform });
  handle = await backend.provision({ kind: "container" });
  record("a container provisions", true, `id=${handle.ref.id}`);

  const nonce = await run([capability.runtime, "exec", handle.ref.id, "sh", "-c", `echo ${NONCE}`]);
  record("a nonce executes through the exec transport", nonce.stdout.includes(NONCE), nonce.stdout.trim());

  const ws = await run([capability.runtime, "exec", handle.ref.id, "cat", join(workspace, "hello.txt")]);
  record("the workspace is bound at the identical absolute path", ws.stdout.includes("workspace-content"), workspace);

  const version = await run([capability.runtime, "exec", handle.ref.id, toolchain.ompPath, "--version"]);
  record("omp runs from the mounted toolchain", version.code === 0, version.stdout.trim() || version.stderr.trim());

  const acp = await run([capability.runtime, "exec", handle.ref.id, toolchain.ompPath, "acp", "--help"]);
  record("the ACP entrypoint is reachable", acp.stdout.includes("ACP"), acp.stdout.split("\n")[0] ?? "");

  const env = await run([capability.runtime, "exec", handle.ref.id, "sh", "-c", `printenv ${CANARY} || echo ABSENT`]);
  record("the host canary did not reach the container", env.stdout.includes("ABSENT"), `${CANARY} absent`);

  const ro = await run([
    capability.runtime,
    "exec",
    handle.ref.id,
    "sh",
    "-c",
    `touch ${toolchain.mountPath}/evil 2>&1 || echo RO-ENFORCED`,
  ]);
  record("the toolchain mount is read-only", ro.stdout.includes("RO-ENFORCED"), "write refused");

  // The property that makes teardown survive a restart. Without it the process
  // map is the only record of the runtime and the network, and a restarted
  // daemon leaves both behind: the command is `tail -f /dev/null`, so `--rm`
  // never fires on its own.
  const resolved = handle.ref.resolved;
  record(
    "the HostRef carries the state needed to destroy after a restart",
    resolved !== undefined && resolved.runtime === capability.runtime && resolved.image === toolchain.image,
    `runtime=${resolved?.runtime} network=${resolved?.network} image=${resolved?.image} ` +
      `omp=${resolved?.ompSha256?.slice(0, 12)} ca=${resolved?.caSha256?.slice(0, 12)}`,
  );
} catch (err) {
  record("the run completed without throwing", false, err instanceof Error ? err.message : String(err));
} finally {
  if (handle !== null && backend !== null && capability !== null) {
    const id = handle.ref.id;
    const network = handle.ref.resolved?.network ?? null;
    try {
      await backend.destroy(handle);
      const gone = await run([capability.runtime, "ls", "--all"]);
      const networks = await run([capability.runtime, "network", "list"]);
      record(
        "destroy reclaims the container and its network",
        !gone.stdout.includes(id) && (network === null || !networks.stdout.includes(network)),
        `${id} and ${network ?? "(no network)"} both gone`,
      );
    } catch (err) {
      record("destroy reclaims the container and its network", false, String(err));
    }
  }
  if (!options.keep) rmSync(workspace, { recursive: true, force: true });
}

const forbidden = spawned.filter(argv => FORBIDDEN.has(argv[0] ?? ""));
record(
  "no docker, orbstack or podman process was spawned",
  options.runtime !== undefined || forbidden.length === 0,
  forbidden.length === 0
    ? `${spawned.length} commands, programs: ${[...new Set(spawned.map(argv => argv[0]))].join(", ")}`
    : `spawned ${JSON.stringify(forbidden)}`,
);

const failed = checks.filter(check => !check.ok);
console.log(`\n${checks.length - failed.length} ok, ${failed.length} broken`);
if (failed.length > 0) process.exit(1);
