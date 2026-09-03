/**
 * Prove that a container provisioned through the native runtime actually
 * confines an untrusted workspace, and prove that the proof is capable of
 * failing.
 *
 * `check-container-host.ts` drives the whole daemon path, but only ever against
 * Docker, so nothing has watched the Apple `container` backend confine
 * anything. This script is deliberately much smaller. It needs no omp image, no
 * daemon, and no credential, because the boundary under test belongs to the
 * runtime rather than to the provisioner: a small public image is enough to ask
 * a container what it can reach. It also selects and drives the runtime with
 * its own code rather than importing the provisioner, so a provisioner bug
 * cannot make its own confinement check agree with it.
 *
 * The negative control is the reason this file exists. Every interesting
 * assertion here is a negative ("the canary did not come back", "the host file
 * was unreachable"), and a run where the probe never executed satisfies all of
 * them at once, perfectly, forever. So the same probe text runs first on the
 * bare host, where it MUST leak, and the whole run stops if it does not. After
 * that every answer is a file the probe wrote, and an absent file is a loud
 * failure rather than an empty string that quietly agrees with everything.
 *
 * The same discipline applies to the flags. A flag accepted is not a flag
 * honoured: Apple `container` 0.4.1 takes docker's option-suffix `--tmpfs`
 * spec, exits 0, and mounts nothing at all, with no warning and not even a
 * literal directory of that name. So the scratch mount is asked about from
 * inside, by filesystem type, rather than assumed from the argv.
 *
 * What this does not claim:
 *
 *   - Network egress is not a boundary, and is not dressed up as one. It is
 *     deliberately open because an agent has to reach a model endpoint, and
 *     Apple `container` 0.4.1 cannot express `--network none` at all
 *     (`notFound: "network none not found"`), while `--no-dns` only deletes
 *     /etc/resolv.conf and leaves IP egress up. Reported, never asserted.
 *
 *   - A read-only root filesystem is not asserted on Apple `container`. 0.4.1
 *     has no such flag: `container run --read-only alpine:3.20 true` exits 64
 *     with `Error: Unknown option '--read-only'`, so its rootfs is writable and
 *     claiming otherwise would be false. Under docker and podman the answer IS
 *     asserted, but honestly: this script does not pass `--read-only` there
 *     either, because the probe writes its answers into the workspace mount.
 *     What makes `/` unwritable under docker is the non-root `--user`, not the
 *     mount, and the `--read-only` argv itself is covered by the provisioner's
 *     unit tests rather than by anything here.
 *
 *   - Nothing here says a word about kernel-level isolation or a VM escape. It
 *     proves the mount, environment, and identity boundaries that the
 *     provisioner is responsible for getting right, and only those.
 *
 * Everything it creates is removed on the success and the failure path: the
 * container, its network, and every temp directory. `--keep` keeps only the
 * temp directories, so the answers can be read by hand.
 *
 * Usage:
 *   bun run scripts/check-native-container.ts [--runtime <name>] [--image <tag>] [--keep]
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Probe order on macOS, most preferred first.
 *
 * `container` leads deliberately. The old `detectContainerRuntime` probed
 * docker first and took whatever answered, so on any Mac with OrbStack
 * installed the native runtime could never be chosen no matter what else was
 * present.
 */
const DARWIN_ORDER: readonly string[] = ["container", "podman", "docker"];

/** Probe order elsewhere. There is no Apple `container` off macOS. */
const LINUX_ORDER: readonly string[] = ["podman", "docker"];

/** A public image, small, and nothing to do with omp. Overridable with `--image`. */
const DEFAULT_IMAGE = "alpine:3.20";

/**
 * Where the scratch tmpfs is asked for, inside the guest.
 *
 * A path that does not exist in any base image, on purpose. Pointing this at
 * something like /tmp would make the materialization check meaningless: the
 * directory is already there and already writable, so a `--tmpfs` that mounted
 * nothing would still look like a pass.
 */
const SCRATCH_MOUNT = "/ompd-scratch";

/**
 * Written last by the probe, and a fixed constant rather than anything from the
 * environment, because the container is handed no environment at all.
 *
 * This is the single value that makes every negative answer mean something. If
 * it is missing or wrong then the probe did not run, and no other answer in the
 * workspace may be believed.
 */
const PROBE_NONCE = "ompd-native-probe-ran-4f1c9a72";

/** How long the idle container is asked to stay up while it is questioned. */
const CONTAINER_LIFETIME = "300";

/** The canonical Docker socket, checked for existence before it is ever used. */
const DOCKER_SOCKET = "/var/run/docker.sock";

/** Program names that would mean Docker or OrbStack was involved after all. */
const FORBIDDEN_PROGRAMS: Record<string, true> = { docker: true, orbctl: true, orb: true };

/**
 * Shapes a container id may take, so an id is validated before it is ever an
 * argument to `exec` or `rm --force`.
 *
 * Apple `container` prints a UUID, docker prints 64 hex characters, and a
 * runtime that printed nothing at all would otherwise hand an empty string to
 * a forced removal.
 */
const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

/**
 * The hostile probe.
 *
 * It answers questions, it does not judge them. Every answer goes to its own
 * file so that the caller reads back something the probe actually wrote, which
 * is what lets an unanswered question be told apart from a comfortable answer.
 *
 * The same text runs on the bare host as the negative control and inside the
 * container as the real subject, so nothing in it may be runtime specific and
 * nothing may be baked in that exists on only one side. It is POSIX sh, run by
 * macOS /bin/sh on one leg and busybox sh on the other.
 *
 *   $1  directory to write answers into
 *   $2  a path the caller says must be unreachable
 *   $3  a path the caller says must be readable
 */
const PROBE_SH = `#!/bin/sh
out="$1"
denied="$2"
allowed="$3"

if [ -z "$out" ]; then
  echo "probe: needs an output directory" >&2
  exit 2
fi
mkdir -p "$out" || exit 2

# A host credential sitting in the environment. The container is provisioned
# with no --env of any kind, so anything arriving here arrived by the runtime's
# own doing. The bare expansion is fine, this script never runs under set -u.
printf '%s' "$CANARY_CREDENTIAL" > "$out/env.txt"

# Reading outside the mounted workspace.
if [ -r "$denied" ] && denied_body=$(cat "$denied" 2>/dev/null); then
  printf 'READ %s' "$denied_body" > "$out/host_read.txt"
else
  printf 'UNREACHABLE %s' "$denied" > "$out/host_read.txt"
fi

# Reading inside it. Without this answer the one above is worthless: a workspace
# that was never mounted at all makes every "unreachable" verdict true for free.
if [ -r "$allowed" ] && allowed_body=$(cat "$allowed" 2>/dev/null); then
  printf 'READ %s' "$allowed_body" > "$out/ws_read.txt"
else
  printf 'UNREACHABLE %s' "$allowed" > "$out/ws_read.txt"
fi

# Is / writable. The marker is removed immediately, because the host leg of this
# probe runs unconfined and a check that litters the real root filesystem is
# doing the exact thing it exists to prove impossible.
rootmarker="/.ompd-native-check-rootfs-$$"
if touch "$rootmarker" 2>/dev/null; then
  printf 'writable' > "$out/rootfs.txt"
  rm -f "$rootmarker"
else
  printf 'not-writable' > "$out/rootfs.txt"
fi

# Did the scratch mount the caller asked the runtime for actually arrive. The
# mount line goes in the answer as well as the writability, because a directory
# that exists and accepts writes is not yet evidence of a tmpfs: only the
# filesystem type says whether the flag was honoured or quietly dropped.
if [ -d ${SCRATCH_MOUNT} ]; then
  scratch_mount=$(mount 2>/dev/null | grep "on ${SCRATCH_MOUNT} " | head -n 1)
  if [ -z "$scratch_mount" ]; then
    scratch_mount="(no mount entry for ${SCRATCH_MOUNT})"
  fi
  if echo scratch > ${SCRATCH_MOUNT}/probe 2>/dev/null; then
    printf 'writable %s' "$scratch_mount" > "$out/tmpfs.txt"
  else
    printf 'not-writable %s' "$scratch_mount" > "$out/tmpfs.txt"
  fi
else
  printf 'absent %s' '${SCRATCH_MOUNT}' > "$out/tmpfs.txt"
fi

id -u > "$out/uid.txt"

# Outbound reachability, asked three ways. ping alone would be a lie under
# --cap-drop ALL, where a dropped CAP_NET_RAW fails on a host with wide open
# egress, so a TCP connect is tried first and ping is only the last resort.
net="blocked"
via="nothing answered"
if command -v nc >/dev/null 2>&1 && nc -z -w 3 1.1.1.1 443 >/dev/null 2>&1; then
  net="reachable"
  via="nc 1.1.1.1:443"
elif command -v wget >/dev/null 2>&1 && wget -q -T 3 -O /dev/null http://1.1.1.1/ >/dev/null 2>&1; then
  net="reachable"
  via="wget http://1.1.1.1/"
elif command -v ping >/dev/null 2>&1 && ping -c 1 1.1.1.1 >/dev/null 2>&1; then
  net="reachable"
  via="ping 1.1.1.1"
fi
printf '%s via %s' "$net" "$via" > "$out/net.txt"

# Last on purpose. Everything above is a negative, and this is the file that
# says the negatives were produced by a run rather than by a run that never
# happened.
printf '%s' '${PROBE_NONCE}' > "$out/output.txt"
`;

interface Options {
  runtime: string;
  pinned: boolean;
  image: string;
  keep: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * `note` is a third verdict, not a soft failure.
 *
 * Some answers are genuinely runtime dependent, and asserting either value
 * would be a claim the runtime does not support. Those are reported and counted
 * separately, so the summary cannot hide them among the passes.
 */
type Verdict = "ok" | "note" | "fail";

interface Check {
  name: string;
  verdict: Verdict;
  detail: string;
}

const checks: Check[] = [];
let step = 0;

/**
 * Every argv this script has spawned, in order.
 *
 * This is the evidence behind "no Docker and no OrbStack was involved". An
 * assertion about the machine would be far weaker, since OrbStack may well be
 * running, started long before this script, for reasons of its own. What can be
 * proven is what this process launched.
 */
const spawned: string[][] = [];

function record(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, verdict: ok ? "ok" : "fail", detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
  return ok;
}

/** Report an answer without judging it, and keep it out of the pass count. */
function observe(name: string, detail = ""): void {
  checks.push({ name, verdict: "note", detail });
  console.log(`note ${name}${detail ? `  ${detail}` : ""}`);
}

function phase(title: string): void {
  step += 1;
  console.log(`\n-- ${step}. ${title}`);
}

async function run(argv: string[], stdin?: string): Promise<RunResult> {
  spawned.push([...argv]);
  // Two spawn calls rather than one with a computed stdio element. A union in
  // the tuple ("ignore" | "pipe") matches no specific overload, so the streams
  // come back nullable and every read below needs a guard for a case that
  // cannot happen. Literal tuples keep them typed as the pipes they are.
  const child =
    stdin === undefined
      ? spawn(argv[0] ?? "", argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
      : spawn(argv[0] ?? "", argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const { promise, resolve } = Promise.withResolvers<RunResult>();
  child.on("error", err => resolve({ code: 127, stdout, stderr: String(err) }));
  child.on("close", code => resolve({ code: code ?? 0, stdout, stderr }));
  if (stdin !== undefined && child.stdin) {
    // A guest that exits before reading raises EPIPE here, which without a
    // listener takes the whole script down as an unhandled 'error' event rather
    // than as a failed check.
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  }
  return await promise;
}

function parseOptions(argv: string[]): Options {
  let runtime = "";
  let image = DEFAULT_IMAGE;
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") {
      keep = true;
    } else if (arg === "--runtime") {
      const next = argv[i + 1];
      if (next === undefined || next === "") throw new Error("--runtime needs a name");
      if (!/^[A-Za-z0-9._-]+$/.test(next)) throw new Error(`--runtime ${JSON.stringify(next)} is not a program name`);
      runtime = next;
      i += 1;
    } else if (arg === "--image") {
      const next = argv[i + 1];
      if (next === undefined || next === "") throw new Error("--image needs a tag");
      image = next;
      i += 1;
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return { runtime, pinned: runtime !== "", image, keep };
}

/**
 * Pick a runtime, and never fall back off a pinned one.
 *
 * `--runtime docker` has to be able to fail. A selector that quietly tried the
 * next candidate would make the one command that exists to compare runtimes
 * unable to report a difference between them.
 */
async function selectRuntime(opts: Options): Promise<{ runtime: string; version: string } | null> {
  const order = opts.pinned ? [opts.runtime] : process.platform === "darwin" ? DARWIN_ORDER : LINUX_ORDER;
  for (const candidate of order) {
    const probed = await run([candidate, "--version"]);
    if (probed.code === 0) {
      return { runtime: candidate, version: (probed.stdout + probed.stderr).trim().split("\n")[0] ?? "" };
    }
    console.log(`  ${candidate} did not answer --version (exit ${probed.code})`);
  }
  return null;
}

/**
 * Read one probe answer, recording an explicit failure when it is not there.
 *
 * The indirection is the whole discipline. Every question below is a negative,
 * and a missing file read as an empty string satisfies all of them at once, so
 * absence has to be louder than a wrong answer rather than quieter.
 */
function answerOf(name: string, dir: string, file: string): string | null {
  const path = join(dir, file);
  if (!existsSync(path)) {
    record(name, false, `the probe never wrote ${file}, so this question has no answer (${path})`);
    return null;
  }
  return readFileSync(path, "utf8").trim();
}

async function main(): Promise<number> {
  const opts = parseOptions(process.argv.slice(2));
  const rand = randomBytes(4).toString("hex");
  const network = `ompd-check-${rand}`;

  const scratch = mkdtempSync(join(tmpdir(), "ompd-native-neg-"));
  const workspace = mkdtempSync(join(tmpdir(), "ompd-native-ws-"));
  const outside = mkdtempSync(join(tmpdir(), "ompd-native-host-"));
  const tempDirs = [scratch, workspace, outside];

  /**
   * A per-run secret placed in this process's own environment, so that "the
   * canary did not come back" is a statement about the runtime rather than a
   * statement about a variable nobody ever set.
   */
  const canary = `ompd-canary-${randomBytes(8).toString("hex")}`;
  process.env.CANARY_CREDENTIAL = canary;

  const hostOnly = join(outside, "host-only.txt");
  const hostOnlyBody = `a host secret the container must not reach ${rand}`;
  writeFileSync(hostOnly, `${hostOnlyBody}\n`, { mode: 0o600 });

  let runtime = "";
  let containerId = "";
  let networkCreated = false;
  let socketBefore: number | null = null;

  try {
    phase("a runtime answers, and its service is up");
    const order = (process.platform === "darwin" ? DARWIN_ORDER : LINUX_ORDER).join(", ");
    const selected = await selectRuntime(opts);
    if (!selected) {
      record(
        "a container runtime is available",
        false,
        opts.pinned
          ? `--runtime ${opts.runtime} did not answer --version, and a pinned runtime is never replaced`
          : `none of ${order} answered --version`,
      );
      return 1;
    }
    runtime = selected.runtime;
    const isApple = runtime === "container";
    record(
      "a container runtime is available",
      true,
      `${runtime} ${opts.pinned ? "(pinned)" : `(first of ${order} to answer)`}: ${selected.version}`,
    );

    if (isApple) {
      // Apple's runtime is a launchd service and the CLI is not it. With the
      // apiserver down every later step fails as an XPC error, which reads like
      // a confinement failure and is nothing of the kind, so it is separated
      // out here with the exact remedy attached.
      const status = await run([runtime, "system", "status"]);
      const up = (status.stdout + status.stderr).includes("apiserver is running");
      const remedy = up ? "apiserver is running" : "remedy: container system start";
      if (!record("the container apiserver is running", up, remedy)) return 1;
    }

    if (existsSync(DOCKER_SOCKET)) {
      try {
        socketBefore = statSync(DOCKER_SOCKET).mtimeMs;
      } catch (err) {
        console.log(`  could not stat ${DOCKER_SOCKET}: ${String(err)}`);
      }
    }

    phase("negative control: the same probe, unconfined, must leak");
    // First, and fatal if it passes. Every assertion after this point is a
    // negative, so a probe that cannot leak even when handed the whole machine
    // makes all of them vacuous and the rest of the run worthless.
    const negProbe = join(scratch, "probe.sh");
    writeFileSync(negProbe, PROBE_SH, { mode: 0o755 });
    const negAllowed = join(scratch, "probe.txt");
    writeFileSync(negAllowed, "the negative control may read this\n");
    const negAnswers = join(scratch, "answers");
    mkdirSync(negAnswers, { recursive: true });

    const neg = await run(["/bin/sh", negProbe, negAnswers, hostOnly, negAllowed]);
    console.log(`  host probe exit ${neg.code}${neg.stderr.trim() ? `: ${neg.stderr.trim()}` : ""}`);

    const negRan = answerOf("the unconfined probe ran at all", negAnswers, "output.txt");
    if (negRan === null) return 1;
    if (!record("the unconfined probe ran at all", negRan === PROBE_NONCE, `output.txt = ${negRan || "(empty)"}`)) {
      return 1;
    }

    const negEnv = answerOf("unconfined, the canary DOES leak", negAnswers, "env.txt");
    if (negEnv === null) return 1;
    if (
      !record(
        "unconfined, the canary DOES leak",
        negEnv === canary,
        negEnv === canary
          ? "CANARY_CREDENTIAL came back, so its absence later is a real result"
          : `expected the canary, got ${negEnv || "(empty)"}, so the environment assertion below would be vacuous`,
      )
    ) {
      return 1;
    }

    const negRead = answerOf("unconfined, the host file IS readable", negAnswers, "host_read.txt");
    if (negRead === null) return 1;
    if (
      !record(
        "unconfined, the host file IS readable",
        negRead.startsWith("READ ") && negRead.includes(hostOnlyBody),
        negRead.startsWith("READ ")
          ? "host-only.txt was read, so its unreachability later is a real result"
          : `${negRead.slice(0, 80)}, so the filesystem assertion below would be vacuous`,
      )
    ) {
      return 1;
    }

    phase("provision a confined container on the native runtime");
    const created = await run([runtime, "network", "create", network]);
    const netDetail = created.code === 0 ? network : `${network}: ${created.stderr.trim().slice(0, 120)}`;
    if (!record("a network of its own was created", created.code === 0, netDetail)) return 1;
    networkCreated = true;

    writeFileSync(join(workspace, "probe.sh"), PROBE_SH, { mode: 0o755 });
    writeFileSync(join(workspace, "probe.txt"), "the container may read this\n");
    const answers = join(workspace, "answers");
    mkdirSync(answers, { recursive: true });

    const uid = process.getuid?.() ?? -1;
    const gid = process.getgid?.() ?? -1;
    const hardening = isApple
      ? // Apple container 0.4.1 rejects --cap-drop, --security-opt and
        // --pids-limit outright (exit 64, "Unknown option"), and CRASHES on any
        // numeric identity flag: `--user 501:20` dies with `XPC connection
        // error: Connection interrupted`. Passing them would not harden
        // anything here, it would stop the container from ever starting.
        []
      : [
          "--user",
          `${uid}:${gid}`,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--pids-limit",
          "1024",
        ];
    // Apple's --tmpfs takes a bare path and silently mounts nothing when handed
    // docker's option-suffix form, so the spec differs by runtime and the result
    // is asked about from inside rather than trusted.
    const scratchSpec = isApple ? SCRATCH_MOUNT : `${SCRATCH_MOUNT}:rw,exec,nosuid,nodev,size=256m,mode=1777`;
    // No --read-only on any runtime, on purpose: the probe writes its answers
    // into the workspace mount, and leaving the flag out keeps this script
    // honest about which mechanism produced the rootfs answer below.
    const runArgv = [
      runtime,
      "run",
      "--detach",
      "--rm",
      "--network",
      network,
      "--volume",
      `${workspace}:${workspace}`,
      "--workdir",
      workspace,
      "--tmpfs",
      scratchSpec,
      ...hardening,
      opts.image,
      "sleep",
      CONTAINER_LIFETIME,
    ];
    console.log(`  ${runArgv.join(" ")}`);

    const identityFlags = runArgv.filter(arg => arg === "--user" || arg === "-u" || arg === "--uid" || arg === "--gid");
    if (isApple) {
      record(
        "no identity flag was passed to Apple container",
        identityFlags.length === 0,
        "numeric --user/--uid/--gid crash 0.4.1 with an interrupted XPC connection",
      );
    } else {
      record("a non-root identity was requested", identityFlags.includes("--user"), `--user ${uid}:${gid}`);
    }
    record(
      "no host environment was forwarded",
      !runArgv.includes("--env") && !runArgv.includes("-e") && !runArgv.includes("--env-file"),
      "the argv carries no --env, -e or --env-file",
    );

    const startedRun = await run(runArgv);
    if (
      !record(
        "the container started",
        startedRun.code === 0,
        startedRun.code === 0
          ? `${runtime} run exited 0`
          : `exit ${startedRun.code}: ${(startedRun.stderr || startedRun.stdout).trim().slice(0, 240)}`,
      )
    ) {
      return 1;
    }

    // No --name was passed, so the id is whatever the runtime printed, which is
    // a UUID on Apple and 64 hex characters on docker. Validated before it is
    // ever an argument to exec or rm --force, because an empty or whitespace id
    // handed to a forced removal is a question about the whole machine.
    const printed = startedRun.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
    if (!record("the runtime printed a usable container id", CONTAINER_ID.test(printed), printed || "(nothing)")) {
      return 1;
    }
    containerId = printed;

    phase("question the container from inside it");
    const probeArgs = [join(workspace, "probe.sh"), answers, hostOnly, join(workspace, "probe.txt")];
    const probed = await run([runtime, "exec", containerId, "sh", ...probeArgs]);
    console.log(
      `  guest probe exit ${probed.code}${probed.stderr.trim() ? `: ${probed.stderr.trim().slice(0, 200)}` : ""}`,
    );

    const ran = answerOf("the confined probe ran at all", answers, "output.txt");
    if (ran !== null) {
      record(
        "the confined probe ran at all",
        ran === PROBE_NONCE,
        ran === PROBE_NONCE ? PROBE_NONCE : `output.txt = ${ran || "(empty)"}, so nothing below may be believed`,
      );
    }

    const wsRead = answerOf("the workspace really is mounted", answers, "ws_read.txt");
    if (wsRead !== null) {
      // Guards the next assertion. If nothing was mounted then "the host file
      // was unreachable" is true for free and proves nothing about confinement.
      record(
        "the workspace really is mounted",
        wsRead.startsWith("READ "),
        wsRead.startsWith("READ ") ? "probe.txt was read from inside" : wsRead.slice(0, 100),
      );
    }

    const env = answerOf("the host canary did not reach the container", answers, "env.txt");
    if (env !== null) {
      record(
        "the host canary did not reach the container",
        env === "",
        env === "" ? "CANARY_CREDENTIAL is empty inside" : `env.txt = ${env.slice(0, 60)}`,
      );
    }

    const hostRead = answerOf("the file outside the workspace is unreachable", answers, "host_read.txt");
    if (hostRead !== null) {
      record(
        "the file outside the workspace is unreachable",
        hostRead.startsWith("UNREACHABLE ") && !hostRead.includes(hostOnlyBody),
        hostRead.startsWith("UNREACHABLE ") ? `${hostOnly} is not there` : hostRead.slice(0, 100),
      );
    }

    const tmpfs = answerOf("the scratch tmpfs actually arrived", answers, "tmpfs.txt");
    if (tmpfs !== null) {
      // Asserted on every runtime, and by filesystem type rather than by the
      // directory existing: a writable directory would also be the answer if
      // --tmpfs had been dropped and the image happened to ship that path.
      record(
        "the scratch tmpfs actually arrived",
        tmpfs.startsWith("writable ") && tmpfs.includes("type tmpfs"),
        `${SCRATCH_MOUNT}: ${tmpfs}`,
      );
    }

    const rootfs = answerOf("root filesystem writability", answers, "rootfs.txt");
    if (rootfs !== null) {
      if (isApple) {
        observe(
          "root filesystem writability",
          `/ is ${rootfs}; container 0.4.1 has no --read-only flag (exit 64, Unknown option), so this is reported and not asserted`,
        );
      } else {
        record(
          "the root filesystem is not writable",
          rootfs === "not-writable",
          `/ is ${rootfs}; under ${runtime} that comes from the non-root --user, not from --read-only, which this script does not pass`,
        );
      }
    }

    const guestUid = answerOf("the uid inside the container", answers, "uid.txt");
    if (guestUid !== null) {
      if (isApple) {
        observe(
          "the uid inside the container",
          `uid ${guestUid}; Apple container gives every guest root inside its own VM and crashes on any numeric identity flag, so this is reported and not asserted`,
        );
      } else {
        record("the container is not uid 0", guestUid !== "0", `uid ${guestUid}`);
      }
    }

    const net = answerOf("outbound network reachability", answers, "net.txt");
    if (net !== null) {
      // Informational on every runtime, but for different reasons, and the
      // difference matters: on docker egress is open because this script chose
      // to attach a nat network, which is a choice that could be revisited. On
      // Apple container it is open because there is no other option to choose.
      const why = isApple
        ? "Apple container cannot express --network none at all (notFound: network none not found), so this is a limit and not a setting"
        : `${runtime} could express --network none; this script attaches a nat network of its own instead`;
      observe(
        "outbound network reachability",
        `${net}; open on purpose because an agent must reach a model endpoint. ${why}`,
      );
    }

    phase("the duplex stream the ACP transport rides on");
    const nonce = `ompd-stdin-${randomBytes(6).toString("hex")}`;
    const echoed = await run([runtime, "exec", "-i", containerId, "cat"], `${nonce}\n`);
    record(
      "a nonce written to stdin came back on stdout",
      echoed.code === 0 && echoed.stdout.includes(nonce),
      echoed.stdout.includes(nonce)
        ? nonce
        : `exit ${echoed.code}, stdout ${JSON.stringify(echoed.stdout.slice(0, 80))}`,
    );

    phase("no Docker and no OrbStack was involved");
    if (runtime === "docker") {
      observe("no Docker and no OrbStack was involved", "skipped: docker is the runtime under test on this run");
    } else {
      const programs = spawned.map(argv => basename(argv[0] ?? ""));
      const offenders = programs.filter(program => FORBIDDEN_PROGRAMS[program] === true);
      record(
        "this script spawned no docker, orb or orbctl",
        offenders.length === 0,
        `${spawned.length} argv recorded, programs: ${[...new Set(programs)].join(", ")}${offenders.length === 0 ? "" : `, offenders: ${offenders.join(", ")}`}`,
      );

      // Reported for what it is worth, which is less than the ledger above. A
      // unix socket's mtime is not bumped by a connection, so an unchanged
      // mtime corroborates the ledger rather than proving anything by itself,
      // and saying otherwise would overstate it.
      if (socketBefore === null) {
        observe(
          "the Docker socket was not touched",
          existsSync(DOCKER_SOCKET)
            ? `${DOCKER_SOCKET} could not be stat'd, so only the argv ledger carries this claim`
            : `${DOCKER_SOCKET} does not exist, so this check did not run and only the argv ledger carries this claim`,
        );
      } else {
        // The measurement comes first and alone. Resolving the symlink is only
        // decoration, and on this machine it is decoration that throws:
        // /var/run/docker.sock is an OrbStack symlink whose realpath answers
        // EOPNOTSUPP, so a cosmetic failure sharing a try block with the stat
        // would delete the number this check exists to compare.
        let socketAfter: number | null = null;
        try {
          socketAfter = statSync(DOCKER_SOCKET).mtimeMs;
        } catch (err) {
          console.log(`  could not re-stat ${DOCKER_SOCKET}: ${String(err)}`);
        }
        // statSync rather than lstatSync on purpose: the symlink's own mtime
        // moves on its own here, while the socket's is set once at bind and
        // stays put, which is the only version of this that is not flaky.
        let resolved = DOCKER_SOCKET;
        try {
          resolved = `${DOCKER_SOCKET} -> ${readlinkSync(DOCKER_SOCKET)}`;
        } catch {
          resolved = `${DOCKER_SOCKET} (not a symlink, or unreadable)`;
        }
        record(
          "the Docker socket mtime did not move",
          socketAfter !== null && socketAfter === socketBefore,
          `${resolved} mtime ${socketBefore} -> ${socketAfter}; corroboration only, a unix socket's mtime does not move on connect`,
        );
      }
    }
  } finally {
    // Each step is guarded on its own. One failing teardown must not skip the
    // rest, and a check that leaks a container is worse than a check that fails.
    phase("teardown");
    if (containerId && runtime) {
      const removed = await run([runtime, "rm", "--force", containerId]);
      const why = removed.code === 0 ? "" : `: ${removed.stderr.trim().slice(0, 160)}`;
      console.log(`  removed container ${containerId.slice(0, 24)} (exit ${removed.code})${why}`);
    }
    if (networkCreated && runtime) {
      let gone = await run([runtime, "network", "rm", network]);
      if (gone.code !== 0) {
        // Apple's runtime refuses to delete a network while a container is still
        // detaching from it, and that detach is not synchronous with the removal
        // above.
        await Bun.sleep(1500);
        gone = await run([runtime, "network", "rm", network]);
      }
      const why = gone.code === 0 ? "" : `: ${gone.stderr.trim().slice(0, 160)}`;
      console.log(`  removed network ${network} (exit ${gone.code})${why}`);
    }
    if (opts.keep) {
      console.log(`  --keep: left ${tempDirs.join(" ")} in place`);
    } else {
      for (const dir of tempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch (err) {
          console.log(`  removing ${dir} failed, remove it by hand: ${String(err)}`);
        }
      }
      console.log("  removed every temp directory");
    }
  }

  const broken = checks.filter(check => check.verdict === "fail").length;
  const passed = checks.filter(check => check.verdict === "ok").length;
  const notes = checks.filter(check => check.verdict === "note").length;
  console.log(`\n${passed} ok, ${notes} to look at, ${broken} broken`);
  return broken === 0 ? 0 : 1;
}

process.exit(await main());
