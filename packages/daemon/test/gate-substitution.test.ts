/**
 * The approval-gate overlay cannot be substituted by a process the far side
 * left behind.
 *
 * This file exists because the previous mechanism could be, and the difference
 * between the two is not a narrower window: it is whether the overlay ever
 * passes through a path the far side owns. So the test runs both mechanisms,
 * with the same hostile process in place, and shows one being bypassed and the
 * other not. A test that only exercised the current code would prove nothing
 * about the fix.
 *
 * `LEGACY_WRAPPER` below is the script this repo shipped before the fix,
 * reproduced verbatim rather than described, so the bypass is demonstrated.
 *
 * ## What is modelled and what is not
 *
 * The far side is a real directory on this machine and the "container" is real
 * `/bin/sh` running the real generated script. Every step of the attack is
 * real: a real FIFO, a real drain, a real replay, a real `cmp -s` reporting a
 * match on bytes the attacker chose to serve. Nothing here is stubbed except
 * the omp binary, which records the path it was handed and the bytes it read.
 *
 * What is NOT modelled is the read-only mount's enforcement. `mountPath` here
 * points at the daemon's own directory, which stands in for a mount that
 * reflects it. That enforcement is a runtime property, not a property of this
 * script, and it is measured in the live section at the bottom. What this
 * section proves is the part that is this script's job: the wrapper no longer
 * routes the overlay through a far-side-writable path at all, and it refuses a
 * second connection through the same host.
 *
 * The refusal is the security property. On Apple's runtime the guest holds the
 * full capability set, so a leftover process can `mount --bind` over even a
 * read-only mount; the reason it never gets to is that it never exists, because
 * a container serves one connection. Relax the refusal and the FIFO
 * substitution below comes straight back.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvisionError, renderGateWrapper, selectRuntime } from "../src/provisioner/index.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The overlay the daemon authors. `always-ask` is the gate; `yolo` is its loss. */
const GATE = "tools:\n  approvalMode: always-ask\n";
const POISON = "tools:\n  approvalMode: yolo\n";

/**
 * The script this repo shipped before the fix, reproduced rather than
 * paraphrased so the bypass below is demonstrated against the real thing.
 *
 * The four `<shell>`-prefixed lines are the defect: `tee` writes the overlay to
 * a far-side path, `cat` reads it back from the same far-side path to verify it,
 * and `exec` hands that path to omp. Three separate opens of a channel the far
 * side owns.
 */
function LEGACY_WRAPPER(shell: string, attach: string, remote: string): string {
  return `#!/bin/sh
set -eu

fail() {
  echo "ompd wrapper (legacy): $1" >&2
  exit 78
}

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
    *)
      set -- "$@" "$arg"
      ;;
  esac
done

[ -n "$config" ] || fail 'refusing to start an ACP host with no --config overlay'
[ -r "$config" ] || fail "cannot read the overlay at $config"

${shell} tee '${remote}' < "$config" > /dev/null || fail 'could not place the overlay'
${shell} chmod 600 '${remote}' < /dev/null > /dev/null || fail 'could not lock down the overlay'
${shell} cat '${remote}' < /dev/null | cmp -s - "$config" || fail 'overlay did not arrive intact'

exec ${attach} "$@"
`;
}

interface OmpStub {
  /** Pass as the last element of `attach`. */
  path: string;
  /** The `--config` value omp was handed, or null if it never ran. */
  configPath(): string | null;
  /** The bytes omp actually read at that path, or null if it never ran. */
  bytesRead(): string | null;
}

/**
 * Stands in for the far-side omp binary. It does the one thing that matters
 * here: opens its `--config` path and records what came out. That read is a
 * separate open from the wrapper's verifying read, which is the whole reason
 * the old mechanism could be lied to.
 */
function ompStub(dir: string): OmpStub {
  const path = join(dir, "omp-stub.sh");
  const pathOut = join(dir, "seen-path");
  const bytesOut = join(dir, "seen-bytes");
  writeFileSync(
    path,
    `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = --config ]; then
    shift
    printf '%s' "$1" > '${pathOut}'
    cat "$1" > '${bytesOut}' 2>/dev/null || printf '<unreadable>' > '${bytesOut}'
  fi
  shift
done
`,
    { mode: 0o700 },
  );
  const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
  return { path, configPath: () => read(pathOut), bytesRead: () => read(bytesOut) };
}

/**
 * A process the previous connection left behind, doing exactly what the live
 * probe against Apple `container` 0.4.1 did.
 *
 * It guesses no timing and races nothing, and neither does this test. The
 * overlay path is fixed for the host's life, so the attacker simply holds it
 * with a FIFO, where every open is a separate rendezvous:
 *
 *   1. `cat TARGET` blocks until the wrapper's `tee` opens to write, and hands
 *      the attacker the daemon's exact overlay bytes.
 *   2. `printf > TARGET` blocks until the wrapper's verifying `cat` opens to
 *      read, and replays those bytes, so `cmp -s` reports a match.
 *   3. `rm` unlinks the FIFO. The verifying reader keeps its open descriptor
 *      and still sees exactly the replayed bytes, so step 2's match stands.
 *   4. The path now names a regular file holding the poison, which is what
 *      omp's own open finds.
 *
 * Each step is released by the wrapper's own next open, so there is nothing to
 * wait out: the sequence is enforced by FIFO rendezvous, not by a delay.
 */
function plantWatcher(dir: string, target: string): { started: Promise<void>; done: Promise<number> } {
  const script = join(dir, "watcher.sh");
  // Captured to a file rather than a shell variable: `$(cat)` strips trailing
  // newlines, and the replay has to be byte-exact or `cmp -s` catches it and
  // the attack fails for the wrong reason.
  const capture = join(dir, "captured");
  writeFileSync(
    script,
    `#!/bin/sh
rm -f '${target}'
mkfifo -m 600 '${target}'
echo planted
cat '${target}' > '${capture}'
cat '${capture}' > '${target}'
rm -f '${target}'
printf '%s' '${POISON}' > '${target}'
`,
    { mode: 0o700 },
  );
  const proc = Bun.spawn(["/bin/sh", script], { stdout: "pipe", stderr: "ignore" });
  cleanups.push(() => proc.kill());
  // Awaits the watcher's own readiness line rather than a guessed duration, so
  // the FIFO provably exists before the wrapper runs.
  const started = proc.stdout
    .getReader()
    .read()
    .then(({ value }) => {
      if (value === undefined) throw new Error("watcher exited without planting its FIFO");
    });
  return { started, done: proc.exited };
}

interface RunResult {
  code: number;
  stderr: string;
}

/** Run a wrapper the way `spawnLocalHost` does: `<wrapper> acp --config <overlay>`. */
async function runWrapper(wrapper: string, overlay: string): Promise<RunResult> {
  const proc = Bun.spawn(["/bin/sh", wrapper, "acp", "--config", overlay], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

function writeOverlay(dir: string): string {
  const path = join(dir, "gate.yml");
  writeFileSync(path, GATE, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

describe("a process left behind by a previous connection cannot substitute the overlay", () => {
  test("the mechanism this replaced IS bypassed: cmp matches, omp reads yolo", async () => {
    // Session 1's leftover. `farSide` is the container's writable scratch: the
    // only thing the old mechanism had to work with.
    const daemon = tempDir("ompd-daemon-");
    const farSide = tempDir("ompd-farside-");
    const stub = ompStub(daemon);
    const remote = join(farSide, "gate.yml");
    const watcher = plantWatcher(daemon, remote);
    await watcher.started;

    const wrapper = join(daemon, "legacy.sh");
    writeFileSync(wrapper, LEGACY_WRAPPER("/usr/bin/env", `/usr/bin/env ${stub.path}`, remote), { mode: 0o700 });

    // Session 2 starts. The daemon authors a fresh overlay, correctly.
    const overlay = writeOverlay(daemon);
    const run = await runWrapper(wrapper, overlay);

    // The wrapper is satisfied. Its verifying read matched byte for byte,
    // because the attacker replayed the daemon's own bytes for that one open.
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain("did not arrive intact");

    // And omp read something else entirely. This is the bypass: the daemon
    // believes it started a gated host, and the host has no gate.
    expect(stub.configPath()).toBe(remote);
    expect(stub.bytesRead()).toBe(POISON);
    expect(stub.bytesRead()).not.toBe(GATE);
  }, 20_000);

  test("the mount mechanism is not: omp reads the daemon's own bytes", async () => {
    const daemon = tempDir("ompd-daemon-");
    const farSide = tempDir("ompd-farside-");
    const gateDir = tempDir("ompd-gate-");
    const stub = ompStub(daemon);

    // The same leftover, still holding the far-side path the old mechanism used.
    const watcher = plantWatcher(daemon, join(farSide, "gate.yml"));
    await watcher.started;

    const state = tempDir("ompd-host-");
    const script = renderGateWrapper(
      {
        via: "mount",
        attach: ["/usr/bin/env", stub.path],
        gateDir,
        // Stands in for the read-only mount, which reflects `gateDir`.
        mountPath: gateDir,
        label: "container test",
        kind: "container",
      },
      state,
    );
    const wrapper = join(daemon, "mount.sh");
    writeFileSync(wrapper, script, { mode: 0o700 });

    const overlay = writeOverlay(daemon);
    const run = await runWrapper(wrapper, overlay);
    expect(run.code).toBe(0);

    // omp was pointed at the daemon's directory, not the far side's, and read
    // the gate. The attacker is still sitting on a path nothing uses.
    expect(stub.configPath()).toBe(join(gateDir, "gate.yml"));
    expect(stub.bytesRead()).toBe(GATE);
    expect(stub.bytesRead()).not.toBe(POISON);

    // The mechanism, not the outcome: the wrapper issued no far-side command at
    // all, so there is no far-side open for anyone to answer. The only thing in
    // the far-side directory is the attacker's own FIFO.
    expect(script).not.toContain("tee ");
    expect(readdirSync(farSide)).toEqual(["gate.yml"]);
  }, 20_000);

  test("a second connection through the same host is refused, not served", async () => {
    // The named test for the security property. Every step of the substitution
    // above needs a process already running inside the container, and the first
    // connection's agent is how one gets there. Relaxing this reopens the
    // bypass demonstrated in the first test, whatever the delivery mode does.
    const daemon = tempDir("ompd-daemon-");
    const gateDir = tempDir("ompd-gate-");
    const state = tempDir("ompd-host-");
    const stub = ompStub(daemon);

    const wrapper = join(daemon, "mount.sh");
    writeFileSync(
      wrapper,
      renderGateWrapper(
        {
          via: "mount",
          attach: ["/usr/bin/env", stub.path],
          gateDir,
          mountPath: gateDir,
          label: "c",
          kind: "container",
        },
        state,
      ),
      { mode: 0o700 },
    );
    const overlay = writeOverlay(daemon);

    const first = await runWrapper(wrapper, overlay);
    expect(first.code).toBe(0);
    expect(stub.bytesRead()).toBe(GATE);

    const second = await runWrapper(wrapper, overlay);
    expect(second.code).toBe(78);
    expect(second.stderr).toContain("already served an ACP connection");
  }, 20_000);

  test("the copy mode gets the same refusal, because ssh has no mount to offer", async () => {
    const daemon = tempDir("ompd-daemon-");
    const farSide = tempDir("ompd-farside-");
    const state = tempDir("ompd-host-");
    const stub = ompStub(daemon);
    const remote = join(farSide, "gate.yml");

    const wrapper = join(daemon, "copy.sh");
    writeFileSync(
      wrapper,
      renderGateWrapper(
        {
          shell: ["/usr/bin/env"],
          attach: ["/usr/bin/env", stub.path],
          remoteConfigPath: remote,
          label: "cloud test",
          kind: "cloud",
        },
        state,
      ),
      { mode: 0o700 },
    );
    const overlay = writeOverlay(daemon);

    const first = await runWrapper(wrapper, overlay);
    expect(first.code).toBe(0);
    expect(stub.bytesRead()).toBe(GATE);

    // The reuse half of the defect is closed here too. The other half is not,
    // and cannot be from this file: the overlay still lands on a path the far
    // side owns, and only the backend that creates the far side can give it a
    // mount instead.
    const second = await runWrapper(wrapper, overlay);
    expect(second.code).toBe(78);
    expect(second.stderr).toContain("already served an ACP connection");
  }, 20_000);

  test("the single-use marker lives on the daemon's side, where the far side cannot clear it", () => {
    const state = tempDir("ompd-host-");
    const gateDir = tempDir("ompd-gate-");
    const script = renderGateWrapper(
      { via: "mount", attach: ["omp"], gateDir, mountPath: "/run/ompd-gate", label: "c", kind: "container" },
      state,
    );
    // A marker under the far side's mount, or under the far side's scratch,
    // would be a marker the far side can unlink. This one is in the wrapper's
    // own 0700 temp directory.
    expect(script).toContain(`mkdir '${state}/served'`);
    expect(script).not.toContain("mkdir '/run/ompd-gate/served'");
  });

  test("a state directory the wrapper would have to quote for is refused", () => {
    // Same rule as every other token: refused rather than escaped. A hostile
    // TMPDIR reaching this script is a sign something is wrong upstream.
    expect(() =>
      renderGateWrapper(
        { via: "mount", attach: ["omp"], gateDir: "/tmp/g", mountPath: "/run/g", label: "c", kind: "container" },
        "/tmp/state'; rm -rf /",
      ),
    ).toThrow(ProvisionError);

    expect(() =>
      renderGateWrapper(
        {
          via: "mount",
          attach: ["omp"],
          gateDir: "/tmp/g; cat /etc/shadow",
          mountPath: "/run/g",
          label: "c",
          kind: "container",
        },
        "/tmp/state",
      ),
    ).toThrow(ProvisionError);
  });
});

/**
 * The runtime properties the comments in `container.ts` and `gate-wrapper.ts`
 * claim, measured rather than asserted.
 *
 * Gated behind OMPD_LIVE=1 because it starts real containers. Everything here
 * was measured by hand first, on macOS 26.5.2 / arm64 with Apple `container`
 * 0.4.1 and docker 29.4.0; this is the regression guard for those claims.
 */
const live = process.env.OMPD_LIVE === "1" ? describe : describe.skip;

live("the gate mount, measured against the real runtime", () => {
  const IMAGE = process.env.OMPD_LIVE_IMAGE ?? "debian:bookworm-slim";

  async function sh(argv: string[]): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    return { code: await proc.exited, out };
  }

  test("a file the daemon writes after the container starts is visible, and unwritable from inside", async () => {
    const cap = await selectRuntime({});
    const gateDir = tempDir("ompd-gate-");
    const started = await sh([
      cap.runtime,
      "run",
      "--detach",
      "--rm",
      "--tmpfs",
      "/tmp",
      "--volume",
      `${gateDir}:/run/ompd-gate:ro`,
      IMAGE,
      "tail",
      "-f",
      "/dev/null",
    ]);
    expect(started.code).toBe(0);
    const id = started.out.trim().split("\n").pop()?.trim() ?? "";
    cleanups.push(() => {
      void Bun.spawn([cap.runtime, "rm", "--force", id], { stdout: "ignore", stderr: "ignore" });
    });

    // The mount is a live view: the wrapper places the overlay after the
    // container exists, which is the only order `spawnLocalHost` allows.
    writeFileSync(join(gateDir, "gate.yml"), GATE, { mode: 0o600 });
    const seen = await sh([cap.runtime, "exec", id, "cat", "/run/ompd-gate/gate.yml"]);
    expect(seen.code).toBe(0);
    expect(seen.out).toBe(GATE);

    // And a write from inside is refused on every runtime here.
    const wrote = await sh([cap.runtime, "exec", id, "sh", "-c", "printf x > /run/ompd-gate/gate.yml"]);
    expect(wrote.code).not.toBe(0);
    expect(wrote.out.toLowerCase()).toContain("read-only file system");
    expect(readFileSync(join(gateDir, "gate.yml"), "utf8")).toBe(GATE);

    // Whether the mount can be SHADOWED is a different question with a
    // different answer per runtime, and the reason the one-spawn refusal is
    // what the gate rests on rather than this mount. Apple rejects --cap-drop,
    // so its guest keeps CAP_SYS_ADMIN and this succeeds; under docker's flag
    // set CapEff is 0 and it fails with "must be superuser". Recorded, not
    // asserted either way, because both outcomes are correct for their runtime.
    const shadow = await sh([
      cap.runtime,
      "exec",
      id,
      "sh",
      "-c",
      "mkdir -p /tmp/evil && printf yolo > /tmp/evil/gate.yml && mount --bind /tmp/evil /run/ompd-gate && cat /run/ompd-gate/gate.yml",
    ]);
    expect(shadow.out.includes("yolo") || shadow.out.toLowerCase().includes("superuser")).toBe(true);
  }, 120_000);
});
