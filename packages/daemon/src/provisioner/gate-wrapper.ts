/**
 * How a remote host keeps the approval gate.
 *
 * `spawnLocalHost` owns the gate: it writes the overlay described in
 * `docs/acp-approval-gate.md` and passes `--config <path>` itself. ompd is
 * forbidden from passing `--config`, and `spawnLocalHost` rejects any attempt,
 * because an overlay loaded after ours could set `approvalMode: yolo` and
 * remove the gate silently. Losing the overlay is not a warning: `omp acp`
 * started without it falls back to the operator's global config, and a global
 * `approvalMode: yolo` skips OMP's ACP permission hook entirely, so the daemon
 * sees no permission requests and concludes nothing needed approval.
 *
 * That leaves one problem for container and cloud hosts: the overlay path
 * exists on the daemon's filesystem, and the `omp acp` process does not run
 * there. Rather than weaken the gate, the remote backends point
 * `spawnLocalHost` at a generated wrapper script. `spawnLocalHost` still writes
 * its own overlay and still passes its own `--config`; the wrapper makes that
 * exact file reachable from the far side, verifies it byte for byte, rewrites
 * the flag, and execs. Nothing about the gate is reinterpreted, and every
 * failure exits 78 rather than starting an ungated host.
 *
 * One constraint shapes the generated script: far-side commands must be plain
 * argv with no shell metacharacters, because ssh joins its arguments into a
 * single string for the remote shell to parse, so quoting that survives
 * `docker exec` does not survive ssh. Redirects in the script below are local
 * to the wrapper, never sent to the far side.
 *
 * ## What the gate rests on
 *
 * The invariant, in one sentence: no process ever exists inside a
 * gate-protected container other than the single ACP session it was created
 * for, so there is no in-guest adversary to substitute anything.
 *
 * What enforces it is the one-spawn refusal below plus the backend's per-host
 * teardown. It is NOT the read-only mount, and saying otherwise would be the
 * same class of defect this review exists to catch: a sentence asserting a
 * control the mechanism does not produce.
 *
 * ## The attack this replaced
 *
 * This file used to have exactly one delivery mode, and it was exploitable.
 * The wrapper wrote the overlay into a directory inside the container and then
 * read it back to verify it, as four separate `<runtime> exec` calls. Both the
 * write and the verifying read went through a path the container can write, and
 * a container was meant to serve many connections over its life, so a process a
 * previous connection left behind was sitting on that path.
 *
 * Proven against Apple `container` 0.4.1, not reasoned about. The overlay path
 * is fixed for the container's whole life, so the attack needs no timing at
 * all: a leftover process replaces the path with a FIFO, drains the daemon's
 * overlay through the wrapper's `tee` (learning the exact bytes), replays those
 * bytes for the wrapper's verifying read so `cmp -s` reports a match, and then
 * serves `approvalMode: yolo` to omp's read. The wrapper's verification passed
 * on bytes the attacker chose to serve. Tightening the loop between verify and
 * exec fixes nothing, because there is no loop to tighten: every open of that
 * path is a separate read of a channel the far side owns.
 *
 * Every step of that attack requires a process already running inside the
 * container. One session per container is therefore not a mitigation of it, it
 * is its precondition removed.
 *
 * ## Why there is a mount mode as well
 *
 * `via: "mount"` puts the overlay in a directory on the daemon's own
 * filesystem which the container has mounted read-only, so the copy and the
 * verification are both local to the daemon and the far side only ever reads.
 *
 * On docker and podman that mount is a real boundary and worth having on its
 * own: under the flag set `container.ts` sends them the container runs with
 * `CapEff 0000000000000000` as a non-root uid, a write reports `Read-only file
 * system`, and both `mount -o remount,rw` and `mount --bind` fail with `must be
 * superuser`.
 *
 * On Apple 0.4.1 it is not a boundary, and the difference is not subtle. Apple
 * rejects `--cap-drop` and `--security-opt`, so its guest holds the full
 * capability set (`CapEff 000001ffffffffff`) as root, and `mount --bind
 * /tmp/evil <mount>` succeeds from inside. Measured on the toolchain mount
 * because that one carries omp itself: `/opt/ompd/omp` printed `real-omp`, and
 * after the bind mount the same path printed `SUBSTITUTED-omp`. The gate mount
 * is shadowable in exactly the same way. So on Apple the mount mode buys two
 * real but smaller things, and no guarantee: the overlay never lands on a
 * far-side writable path at all, and the delivery needs no `exec` into the
 * container, which is how the four-call sequence and its FIFO primitive go away.
 *
 * ### What was rejected, and why
 *
 * Delivering the overlay so that no file holds it at all is the strongest
 * option, and omp does support it: `omp acp --config /dev/fd/3` reads a pipe on
 * a spare descriptor, verified by feeding it malformed YAML and getting
 * `Failed to parse config overlay /dev/fd/3`. The transport is what makes it
 * impossible. Neither `container exec` (0.4.1) nor `docker exec` (29.4.0)
 * offers any descriptor but stdin, and the ACP JSON-RPC stream owns stdin. The
 * only way to synthesise a second descriptor on the far side is to exec a shell
 * there and have it open something, which means sending shell metacharacters
 * through a transport this file refuses to quote for, and means the something
 * it opens is a far-side path again. A named pipe on the far side is not a
 * mitigation, it is the exploit primitive above.
 *
 * Installing a fixed wrapper into the read-only toolchain mount was also
 * rejected. It answers a question nobody asked here, because the wrapper
 * already executes from a `mkdtemp` 0700 directory on the daemon's own machine
 * and was never on an agent-writable path. And per the measurement above it
 * would not have been trustworthy there anyway on Apple.
 *
 * ### The residual, stated rather than implied away
 *
 * A session's own agent, having had one approved command, can subvert the rest
 * of its own session on Apple's runtime: by shadowing the gate mount before a
 * later read, or by attaching to the omp process, since `CAP_SYS_PTRACE` is in
 * that capability set. The ptrace path is inferred, not tested. That exposure
 * is bounded by an operator approval. The one this replaces was not bounded by
 * anything: a leftover watcher silently ungated every future connection.
 *
 * `via: "copy"` is the original mode and is still what the cloud backend uses
 * over ssh. It has the same structural defect on a reused cloud machine, and
 * this file cannot fix it alone: the fix is a mount, and only the backend that
 * creates the far side can create one. What the copy mode does get here is the
 * one-spawn guard, which needs no far-side state and removes the precondition
 * the same way.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvisionError } from "./types.ts";

/** The overlay's name inside the gate directory. */
const GATE_FILE = "gate.yml";

interface GateWrapperCommon {
  /**
   * Argv prefix that execs the far-side omp binary, e.g.
   * `["docker", "exec", "-i", "<id>", "omp"]`. Must end with the binary: the
   * wrapper appends the rewritten `acp --config ...` arguments to it.
   */
  attach: string[];
  /** Appears in the script's error messages. */
  label: string;
  /** Host kind, for `ProvisionError`. */
  kind: string;
}

/**
 * Carry the overlay to the far side by writing it there.
 *
 * The far side owns the path it lands on, so this mode cannot promise the bytes
 * omp reads are the bytes that were verified. Kept because ssh has no mount to
 * offer.
 */
export interface GateWrapperCopySpec extends GateWrapperCommon {
  via?: "copy";
  /**
   * Argv prefix that runs a plain command on the far side with stdin attached,
   * e.g. `["docker", "exec", "-i", "<id>"]` or `["ssh", "-T", "host"]`.
   */
  shell: string[];
  /** Absolute path the overlay is copied to on the far side. */
  remoteConfigPath: string;
}

/**
 * Place the overlay on the daemon's own filesystem, where the far side reads it
 * through a read-only mount.
 *
 * No far-side write and no far-side read-back, so the four-call `exec` sequence
 * and the FIFO primitive it handed the far side are both gone. A boundary in its
 * own right on docker and podman; on Apple 0.4.1 it is defence in depth and the
 * one-spawn guard is what holds. See this file's header.
 */
export interface GateWrapperMountSpec extends GateWrapperCommon {
  via: "mount";
  /** Daemon-side directory the far side has mounted read-only. */
  gateDir: string;
  /** Where that directory appears on the far side. */
  mountPath: string;
}

export type GateWrapperSpec = GateWrapperCopySpec | GateWrapperMountSpec;

export interface GateWrapper {
  /** Pass as `ompPath` to `spawnLocalHost`. */
  path: string;
  /** Private directory holding the script. Remove this, not just the file. */
  dir: string;
}

/**
 * Characters that survive both a local `sh` word and ssh's argv-to-string
 * round trip untouched. Anything else is refused rather than escaped: a
 * container id or ssh destination containing a quote is a sign something is
 * wrong upstream, and escaping it would hide that.
 */
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/**
 * Refuse a path the wrapper would have to quote for.
 *
 * Exported because the container backend needs the same answer before it builds
 * its `run` argv, not after. Discovering a hostile `TMPDIR` at render time
 * would be too late: the container would already have been started with that
 * path as a mount source.
 */
export function requireSafePath(path: string, what: string, kind: string): string {
  if (!SAFE_TOKEN.test(path)) {
    throw new ProvisionError(`${what} ${JSON.stringify(path)} is not a safe token`, kind);
  }
  return path;
}

function renderArgv(argv: string[], what: string, kind: string): string {
  if (argv.length === 0) throw new ProvisionError(`${what} is empty`, kind);
  const unsafe = argv.find(token => !SAFE_TOKEN.test(token));
  if (unsafe !== undefined) {
    throw new ProvisionError(`${what} contains an unsafe token ${JSON.stringify(unsafe)}`, kind);
  }
  return argv.join(" ");
}

/**
 * Render the wrapper script. Exported for tests, which assert on its fail-closed
 * behaviour by running it against a fake runtime.
 *
 * `stateDir` is the wrapper's own private directory on the daemon's machine.
 * The single-use marker goes there rather than on the far side, because a
 * marker the far side can unlink is not a marker.
 */
export function renderGateWrapper(spec: GateWrapperSpec, stateDir: string): string {
  const attach = renderArgv(spec.attach, "far-side attach command", spec.kind);
  const state = requireSafePath(stateDir, "wrapper state directory", spec.kind);
  const label = spec.label.replace(/[^A-Za-z0-9 _.:@/-]/g, ".");

  // Where the far side will be told to read the overlay, and how it gets there.
  let remote: string;
  let deliver: string;
  if (spec.via === "mount") {
    const gateDir = requireSafePath(spec.gateDir, "daemon-side gate directory", spec.kind);
    const mountPath = requireSafePath(spec.mountPath, "far-side gate mount path", spec.kind);
    remote = `${mountPath}/${GATE_FILE}`;
    deliver = `# Both of these run on the daemon's machine, not on the far side. '${gateDir}' is
# mounted read-only over there, so there is no far-side write in this path and
# no far-side read-back that could be lied to. What stops the far side reading
# something else is that nothing is running over there yet; the mount alone does
# not stop it on Apple's runtime. See this file's header.
cat < "$config" > '${gateDir}/${GATE_FILE}' || fail 'could not place the overlay'
chmod 600 '${gateDir}/${GATE_FILE}' || fail 'could not lock down the overlay'
cmp -s '${gateDir}/${GATE_FILE}' "$config" || fail 'the overlay did not persist intact'`;
  } else {
    const shell = renderArgv(spec.shell, "far-side shell command", spec.kind);
    remote = requireSafePath(spec.remoteConfigPath, "far-side overlay path", spec.kind);
    deliver = `# The far side owns this path, so the read below proves the copy arrived and
# nothing more. ssh has no mount to offer, so the overlay has to land on a
# far-side filesystem; the guard above is what keeps a previous session from
# already sitting on it. See this file's header.
${shell} tee '${remote}' < "$config" > /dev/null || fail 'could not place the overlay'
${shell} chmod 600 '${remote}' < /dev/null > /dev/null || fail 'could not lock down the overlay'
${shell} cat '${remote}' < /dev/null | cmp -s - "$config" || fail 'overlay did not arrive intact'`;
  }

  return `#!/bin/sh
# Generated by ompd for ${label}. Do not edit.
#
# spawnLocalHost wrote the approval-gate overlay and passed it as
# '--config <path>'. That path is on the daemon's machine only, so this script
# makes the overlay reachable from the far side, checks it, rewrites the flag,
# and execs. ompd never authors the overlay and never passes --config itself;
# this only makes the file the daemon wrote reachable.
#
# Exit 78 means the gate could not be guaranteed. An 'omp acp' started without
# the overlay falls back to the operator's global config, and a global
# 'approvalMode: yolo' skips OMP's ACP permission hook entirely: the daemon
# would then see no permission requests and conclude nothing needed approval.
set -eu

fail() {
  echo "ompd wrapper (${label}): $1" >&2
  exit 78
}

# Rewrite --config to the far-side path, leaving every other argument alone.
config=''
n=$#
consumed=0
while [ "$consumed" -lt "$n" ]; do
  arg=$1
  shift
  consumed=$((consumed + 1))
  case $arg in
    --config)
      [ "$consumed" -lt "$n" ] || fail 'saw --config with no value'
      config=$1
      shift
      consumed=$((consumed + 1))
      set -- "$@" --config '${remote}'
      ;;
    --config=*)
      config=\${arg#--config=}
      set -- "$@" '--config=${remote}'
      ;;
    *)
      set -- "$@" "$arg"
      ;;
  esac
done

[ -n "$config" ] || fail 'refusing to start an ACP host with no --config overlay'
[ -r "$config" ] || fail "cannot read the overlay at $config"

# One ACP connection per host, refused here as well as in the backend, because
# this is the last thing that runs before the exec.
#
# 'mkdir' is the guard because it is atomic and it fails when the directory is
# already there. The reason there is a guard at all: once a connection has
# ended, code the model chose has run on the far side, and a process it left
# behind can substitute the overlay for the next connection. On Apple's runtime
# it can do that even through a read-only mount, by mounting over it. This is
# the daemon's own directory, so the far side cannot clear the marker.
mkdir '${state}/served' 2>/dev/null || fail 'this host has already served an ACP connection and must not serve another'

${deliver}

exec ${attach} "$@"
`;
}

/**
 * Write the wrapper into a fresh private directory and return its location.
 *
 * Synchronous, `mkdtempSync`, and `wx` for the same reasons `writeGateConfig`
 * is: an unpredictable 0700 directory created in one step cannot be
 * pre-created world-writable by another local user, and refusing to overwrite
 * means we never follow a planted symlink. Replacing this script would replace
 * the gate.
 *
 * The directory is created before the script is rendered, because it is also
 * where the single-use marker lives and the script has to name it. A refused
 * spec therefore has a directory to clean up, and cleans it up: otherwise every
 * hostile token an operator typed would leak one.
 */
export function writeGateWrapper(spec: GateWrapperSpec): GateWrapper {
  const dir = mkdtempSync(join(tmpdir(), "ompd-host-"));
  let script: string;
  try {
    script = renderGateWrapper(spec, dir);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const path = join(dir, "omp-wrapper.sh");
  writeFileSync(path, script, { mode: 0o700, flag: "wx" });
  if (readFileSync(path, "utf8") !== script) {
    throw new ProvisionError(`host wrapper at ${path} did not persist intact`, spec.kind);
  }
  return { path, dir };
}
