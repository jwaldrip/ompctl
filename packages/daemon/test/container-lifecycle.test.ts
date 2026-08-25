/**
 * What a failed container provision leaves behind, and when a grant is
 * actually revoked.
 *
 * Both of these were review findings against the model-broker change, and both
 * are shaped the same way: the code looked correct because every branch an
 * operator normally hits does unwind correctly, and the defect only appeared on
 * the paths nothing exercised.
 *
 * 1. `provision` unwound a step that RETURNED a nonzero exit code and not a
 *    step that THREW. `this.#run` is a seam and the default `execCommand`
 *    rejects rather than exiting non-zero whenever the runtime binary cannot be
 *    started, which is precisely what happens when it has been moved or
 *    upgraded since `selectRuntime` read its `run --help` a few statements
 *    earlier. Such a rejection propagated past every cleanup branch below it,
 *    leaving a LIVE grant, the guest's bearer in a daemon-side `mkdtemp`
 *    directory, and a network -- with no container handle through which
 *    ordinary teardown could ever find them, because the caller never got one.
 * 2. `destroy` removed the id from `#live`, awaited `rm --force`, awaited
 *    `network rm`, and only then revoked. Deleting from `#live` revokes nothing:
 *    the grant lives in the broker's map. So every await before the revoke was
 *    a window in which a bearer taken out of the guest still authenticated, and
 *    a runtime whose `rm` hung rather than answering stretched that window to
 *    the grant's whole TTL.
 *
 * The tests here are written to fail if either fix is undone, which is the only
 * thing that makes them worth having. Both fixes were mutation-checked: the
 * unwind call was removed from `provision`'s `catch` and the revoke was moved
 * back below `destroy`'s awaits, one at a time, and the notes on the affected
 * tests record what each run measured.
 *
 * Nothing here touches a container runtime. `run`, `toolchain` and `modelAccess`
 * are all injectable, so every subprocess is a function in this file and every
 * directory is a real `mkdtemp` under a scratch temp root this file owns.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CommandResult,
  type CommandRunner,
  ContainerBackend,
  GUEST_HOME_MOUNT,
  type GuestBridge,
  type GuestModelAccess,
  type HostHandle,
  type ModelAccessProvider,
  ProvisionError,
  type ResolvedToolchain,
  type RuntimeCapability,
} from "../src/provisioner/index.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * Apple `container` 0.4.1, stated rather than probed, and chosen over docker on
 * purpose.
 *
 * `resolveGuestBridge` decides from the runtime's name plus the platform, and
 * only this combination reaches `network inspect` and therefore the
 * `host-bridge` shape: `docker` off linux short-circuits to `host-alias` before
 * any inspect happens, and podman off linux refuses outright. The inspect call
 * is one of the two unguarded awaits under test, so the tests have to get there.
 */
const APPLE_CAP: RuntimeCapability = {
  runtime: "container",
  version: "container CLI version 0.4.1 (build: release, commit: 4ac18b5)",
  capDrop: false,
  securityOpt: false,
  readOnly: false,
  pidsLimit: false,
  numericUser: false,
  networks: true,
  tmpfsOptions: false,
  networkNone: false,
  memoryLimit: true,
  cpuLimit: true,
};

/** No toolchain mount, so nothing is downloaded and no extra `--volume` appears. */
const stubToolchain = async (): Promise<ResolvedToolchain> => ({
  image: "debian:bookworm-slim",
  source: "default",
  toolsDir: null,
  mountPath: "/opt/ompd",
  ompPath: "omp",
  env: {},
  ompSha256: null,
  caSha256: null,
  cached: true,
});

/**
 * Apple `container` 0.4.1's own `network inspect` output, quoted from a real
 * run: the `status.gateway` spelling rather than the OCI `IPAM.Config` one.
 * Anything else comes back `unsupported` and the provision never reaches the
 * steps under test.
 */
const INSPECT_APPLE = JSON.stringify([{ status: { gateway: "192.168.65.1", address: "192.168.65.0/24" } }]);

/** Passes `CONTAINER_ID`, so the backend accepts it as a handle. */
const CONTAINER = "cnt-lifecycle-0001";

/** A provider-qualified model id, the shape the broker's single-model check wants. */
const MODEL = "anthropic/claude-haiku-4-5";

const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

/**
 * A scratch temp root, so "nothing was left behind" is one exact assertion
 * rather than a search for `ompd-*` needles in the machine's real temp dir.
 *
 * `os.tmpdir()` reads `TMPDIR` on every call, and every directory this backend
 * creates goes through `mkdtempSync(join(tmpdir(), ...))`: the gate directory,
 * the seeded guest home and the gate wrapper's directory. Pointing `TMPDIR` at
 * an empty directory for the duration of a test means `readdirSync` on it
 * afterwards is a complete inventory of what the backend failed to reclaim.
 */
const REAL_TMPDIR = process.env.TMPDIR;
let scratchRoot: string | null = null;

function scratchTmpdir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ompd-lifecycle-"));
  scratchRoot = dir;
  process.env.TMPDIR = dir;
  return dir;
}

afterEach(() => {
  if (REAL_TMPDIR === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = REAL_TMPDIR;
  if (scratchRoot !== null) {
    rmSync(scratchRoot, { recursive: true, force: true });
    scratchRoot = null;
  }
});

/**
 * A promise the test resolves by hand.
 *
 * The executor runs synchronously, so `resolve` holds the real function by the
 * time this returns; the initializer is there only to satisfy definite
 * assignment.
 */
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

type Handler = (argv: string[]) => Promise<CommandResult> | CommandResult;

interface FakeRuntime {
  run: CommandRunner;
  calls: string[][];
  stages: string[];
}

/**
 * A container runtime that is a table of functions.
 *
 * Deliberately NOT an `async` function. An `async` wrapper turns a handler's
 * synchronous `throw` into a rejected promise, and the difference is the whole
 * subject of one of the tests below: `inspectNetwork` guards its call with
 * `.catch(() => null)`, which can only ever see a rejection, so a runner that
 * raises before returning a promise is the shape that escapes it.
 */
function fakeRuntime(handlers: Record<string, Handler> = {}): FakeRuntime {
  const calls: string[][] = [];
  const stages: string[] = [];
  const run: CommandRunner = argv => {
    calls.push([...argv]);
    // Which step of the lifecycle this argv is, so a test can replace exactly
    // one of them and leave the rest working.
    const verb = argv[1] ?? "";
    const at = verb === "network" ? `network ${argv[2] ?? ""}` : verb;
    stages.push(at);
    const handler = handlers[at];
    if (handler !== undefined) return Promise.resolve(handler(argv));
    if (at === "network inspect") return Promise.resolve({ code: 0, stdout: INSPECT_APPLE, stderr: "" });
    if (at === "run") return Promise.resolve({ code: 0, stdout: `${CONTAINER}\n`, stderr: "" });
    return Promise.resolve(OK);
  };
  return { run, calls, stages };
}

interface AccessRecorder {
  provider: ModelAccessProvider;
  /** The single bearer this recorder mints, so tests can assert on the value. */
  token: string;
  granted: GuestBridge[];
  activated: GuestBridge[];
  released: string[];
}

/**
 * A `ModelAccessProvider` that mints one bearer and records every call.
 *
 * `release` is the assertion surface for both findings: it is the only thing
 * that actually revokes a grant, so "was it called, and was it called before
 * the subprocess" is the whole question.
 */
function accessRecorder(opts: { releaseFails?: boolean } = {}): AccessRecorder {
  const recorder: AccessRecorder = {
    token: "guest-bearer-b3d9c1e47a0f4d2c",
    granted: [],
    activated: [],
    released: [],
    provider: {
      async grant(input: { network: string | null; bridge: GuestBridge }): Promise<GuestModelAccess | null> {
        recorder.granted.push(input.bridge);
        return { endpoint: "http://192.168.65.1:8787/v1/messages", token: recorder.token, model: MODEL };
      },
      async activate(input: { bridge: GuestBridge }): Promise<void> {
        recorder.activated.push(input.bridge);
      },
      async release(input: { token: string }): Promise<void> {
        recorder.released.push(input.token);
        // A broker that has already forgotten the grant refuses, and `destroy`
        // has to survive it: reconciliation after a restart hits this on every
        // host it did not create.
        if (opts.releaseFails === true) throw new Error("no such grant");
      },
    },
  };
  return recorder;
}

function backendWith(opts: { run: CommandRunner; modelAccess?: ModelAccessProvider }): ContainerBackend {
  return new ContainerBackend({
    capability: APPLE_CAP,
    platform: "darwin",
    run: opts.run,
    toolchain: stubToolchain,
    modelAccess: opts.modelAccess,
  });
}

/**
 * The host path the guest's HOME was mounted from, read back out of the `run`
 * argv.
 *
 * The backend never returns this path on a failed provision, so reading it off
 * the argv is the only way to name the exact directory that has to be gone
 * afterwards. Asserting on a `mkdtemp` glob instead would pass for a leftover
 * directory belonging to some other test.
 */
function guestHomeSource(argv: string[]): string {
  const suffix = `:${GUEST_HOME_MOUNT}`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== "--volume") continue;
    const value = argv[i + 1] ?? "";
    if (value.endsWith(suffix)) return value.slice(0, -suffix.length);
  }
  throw new Error(`no ${GUEST_HOME_MOUNT} mount in: ${argv.join(" ")}`);
}

/** The bearer as the guest would read it, from the file the guest actually reads. */
function seededToken(home: string): string {
  return readFileSync(join(home, ".omp", "model-token"), "utf8").trim();
}

function networkOps(calls: string[][]): { created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  for (const argv of calls) {
    if (argv[1] !== "network") continue;
    const name = argv[3] ?? "";
    if (argv[2] === "create") created.push(name);
    if (argv[2] === "rm") removed.push(name);
  }
  return { created, removed };
}

// ---------------------------------------------------------------------------
// A failed provision leaves the machine as it found it
// ---------------------------------------------------------------------------

describe("a provision that throws unwinds as completely as one that fails", () => {
  test("a rejecting `container run` leaves no live grant, no bearer on disk and no network", async () => {
    // The BLOCKER. `await this.#run([... "run" ...])` was the last unguarded
    // await in the function, and by the time control reaches it the grant has
    // been minted and the bearer written into a directory the container is
    // about to mount. Mutation-checked by removing the unwind call from
    // `provision`'s `catch`: this test fails on `released`, and a probe of the
    // same shape measured all three leaks at once -- `released` empty, the
    // `ompd-guest-*` directory still holding the bearer, and no `network rm`
    // ever issued.
    const scratch = scratchTmpdir();
    const access = accessRecorder();
    let runArgv: string[] = [];
    let bearerDuringRun = "";
    const runtime = fakeRuntime({
      run: argv => {
        runArgv = [...argv];
        // Read before rejecting, so the assertions below cannot pass vacuously
        // on a provision that never seeded a home or never granted anything.
        bearerDuringRun = seededToken(guestHomeSource(argv));
        // What `execCommand` does when the binary cannot be started at all: it
        // rejects. It does not return a nonzero exit, which is the only case
        // the explicit branch below it ever handled.
        return Promise.reject(new ProvisionError("container could not be started: ENOENT", "container"));
      },
    });
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });

    await expect(backend.provision({ kind: "container" })).rejects.toThrow(/could not be started/);

    // The grant existed and the guest really was holding it.
    expect(access.granted).toHaveLength(1);
    expect(bearerDuringRun).toBe(access.token);

    // Revoked, by name. This is the assertion the finding was about: an
    // unrevoked grant is a credential nobody is holding that keeps spending the
    // operator's quota until its TTL runs out.
    expect(access.released).toEqual([access.token]);

    // And the bearer is off the disk, not merely revoked.
    expect(existsSync(guestHomeSource(runArgv))).toBe(false);

    const ops = networkOps(runtime.calls);
    expect(ops.created).toHaveLength(1);
    expect(ops.removed).toEqual(ops.created);

    // Complete inventory: the gate directory and the guest home both lived
    // here, and nothing else did.
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("a runner that raises on `network inspect` leaves no network and no gate directory", async () => {
    // The second unguarded await. `resolveGuestBridge` sits between `network
    // create` and everything that used to clean up after it, so a throw there
    // leaked the network and the gate directory.
    //
    // Synchronous on purpose. `inspectNetwork` wraps its call in
    // `.catch(() => null)`, and a `.catch` only ever sees a REJECTED promise: a
    // `CommandRunner` is obliged to return a promise, not to be `async`, so a
    // runner that raises before returning one throws straight out of
    // `resolveGuestBridge`. Mutation-checked by the same means: this test fails
    // on the network assertion, and a probe of the same shape measured the
    // scratch root still holding an `ompd-gate-*` directory with no
    // `network rm` issued.
    const scratch = scratchTmpdir();
    const access = accessRecorder();
    const runtime = fakeRuntime({
      "network inspect": () => {
        throw new ProvisionError("container could not be started: ENOENT", "container");
      },
    });
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });

    await expect(backend.provision({ kind: "container" })).rejects.toThrow(/could not be started/);

    // Nothing was granted, because the bridge is resolved before the grant is
    // asked for. So there is no token here -- what had to be reclaimed is the
    // network and the directory.
    expect(access.granted).toEqual([]);
    expect(access.released).toEqual([]);

    const ops = networkOps(runtime.calls);
    expect(ops.created).toHaveLength(1);
    expect(ops.removed).toEqual(ops.created);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("an inspect that rejects instead of raising is refused later and unwinds the container too", async () => {
    // The same runner failure in its async shape, which takes a different route
    // and has to arrive at the same place. `inspectNetwork` swallows the
    // rejection, so the bridge comes back `unsupported`; this provider grants
    // anyway, which is exactly the provider bug the `bridge.kind` gate exists
    // to catch, and by then the container is running.
    //
    // Worth its own test because it is the widest unwind in the function: a
    // grant, a bearer on disk, a container AND a network all exist at once.
    const scratch = scratchTmpdir();
    const access = accessRecorder();
    const runtime = fakeRuntime({
      "network inspect": () => Promise.reject(new Error("container: XPC connection interrupted")),
    });
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });

    await expect(backend.provision({ kind: "container" })).rejects.toThrow(/bridge this host cannot serve/);

    expect(access.released).toEqual([access.token]);
    expect(runtime.calls).toContainEqual(["container", "rm", "--force", CONTAINER]);
    const ops = networkOps(runtime.calls);
    expect(ops.removed).toEqual(ops.created);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("a refused revoke during the unwind does not replace the error the caller needs", async () => {
    // The unwind runs inside a `catch` that is about to rethrow, so anything it
    // raises would be substituted for the `ProvisionError` that says why the
    // provision failed -- an operator would read "no such grant" and have no
    // idea the runtime binary was missing. Every step is best effort for that
    // reason, and this pins it: a broker that refuses the release still leaves
    // the original message on the way out, and the directories still go.
    const scratch = scratchTmpdir();
    const access = accessRecorder({ releaseFails: true });
    const runtime = fakeRuntime({
      run: () => Promise.reject(new ProvisionError("container could not be started: ENOENT", "container")),
    });
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });

    await expect(backend.provision({ kind: "container" })).rejects.toThrow(/could not be started: ENOENT/);

    expect(access.released).toEqual([access.token]);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Destruction revokes first
// ---------------------------------------------------------------------------

describe("destroy revokes before it waits on anything", () => {
  test("the grant is already revoked while `rm --force` is still blocked", async () => {
    // The assertion that pins the ordering, and the one that fails the moment
    // the revoke moves back below the await. Mutation-checked by restoring the
    // old order: `released` is empty at the point `rm` is entered, which is
    // exactly the post-stop window an exfiltrated bearer authenticates in.
    //
    // A hung `rm` is not hypothetical. It is what a wedged runtime daemon looks
    // like from here, and it is the case where the difference between revoking
    // first and revoking last is the grant's whole TTL rather than a few
    // milliseconds.
    scratchTmpdir();
    const access = accessRecorder();
    const rmEntered = deferred<void>();
    const rmAnswer = deferred<CommandResult>();
    const runtime = fakeRuntime({
      rm: () => {
        rmEntered.resolve(undefined);
        return rmAnswer.promise;
      },
    });
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });
    const handle = await backend.provision({ kind: "container" });
    expect(access.released).toEqual([]);

    const destroying = backend.destroy(handle);
    await rmEntered.promise;

    expect(access.released).toEqual([access.token]);
    // And the container really is still un-removed, so the assertion above is
    // about ordering rather than about a teardown that already finished.
    expect(runtime.stages).not.toContain("network rm");

    rmAnswer.resolve(OK);
    await destroying;
    expect(runtime.stages).toContain("network rm");
  });

  test("teardown still reclaims everything, in the order that works", async () => {
    const scratch = scratchTmpdir();
    const access = accessRecorder();
    const runtime = fakeRuntime();
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });
    const handle = await backend.provision({ kind: "container" });
    const guestHome = handle.ref.resolved?.guestHome ?? "";
    expect(existsSync(guestHome)).toBe(true);

    await backend.destroy(handle);

    // The container before the network, because a network with something
    // attached cannot be removed.
    expect(runtime.stages.indexOf("rm")).toBeLessThan(runtime.stages.indexOf("network rm"));
    expect(existsSync(guestHome)).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  test("a release the broker refuses does not fail the teardown", async () => {
    // `destroy` runs on reconciliation and on the TTL sweep, and a throw here
    // would stop the rest of the list being cleared.
    scratchTmpdir();
    const access = accessRecorder({ releaseFails: true });
    const runtime = fakeRuntime();
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });
    const handle = await backend.provision({ kind: "container" });

    await backend.destroy(handle);

    expect(access.released).toEqual([access.token]);
    expect(runtime.calls).toContainEqual(["container", "rm", "--force", CONTAINER]);
  });

  test("a host from a persisted ref is torn down without a token to revoke", async () => {
    // The restart. The first backend is thrown away without destroying, exactly
    // as a killed daemon does, and the second has an empty process map: the
    // token is gone by design, so there is nothing to revoke and nothing that
    // needs revoking, and `guestHome` has to come off the ref instead.
    const scratch = scratchTmpdir();
    const first = accessRecorder();
    const firstRuntime = fakeRuntime();
    const handle = await backendWith({ run: firstRuntime.run, modelAccess: first.provider }).provision({
      kind: "container",
    });
    const guestHome = handle.ref.resolved?.guestHome ?? "";
    const network = handle.ref.resolved?.network ?? "";
    // The bearer is on disk and unreachable by name from the new process, which
    // is what makes reclaiming the directory the only thing a restart can do
    // about it.
    expect(seededToken(guestHome)).toBe(first.token);

    const second = accessRecorder();
    const secondRuntime = fakeRuntime();
    const restarted = backendWith({ run: secondRuntime.run, modelAccess: second.provider });

    // The ref as the store hands it back: JSON round-tripped, with no live
    // record behind it, which is the whole point of the exercise.
    const rehydrated: HostHandle = {
      ref: JSON.parse(JSON.stringify(handle.ref)),
      spawn: () => {
        throw new Error("a rehydrated handle cannot spawn");
      },
    };
    await restarted.destroy(rehydrated);

    // No token reached the new process, so none was revoked. That is the
    // deliberate consequence of keeping the bearer out of `resolved`: the
    // broker forgot every grant when the process it lived in exited.
    expect(second.released).toEqual([]);
    expect(secondRuntime.calls).toContainEqual(["container", "rm", "--force", CONTAINER]);
    expect(secondRuntime.calls).toContainEqual(["container", "network", "rm", network]);
    // The directory holding the bearer is reclaimed all the same, because it is
    // the one piece of this that a restart can still name.
    expect(existsSync(guestHome)).toBe(false);
    // The gate and wrapper directories are not, which is the documented cost of
    // a restart: they are `mkdtemp` litter no `HostRef` records.
    expect(readdirSync(scratch).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// What the store is allowed to see
// ---------------------------------------------------------------------------

describe("the persisted ref carries the directory and never the bearer", () => {
  test("resolved names the guest home, and the token appears nowhere in it", async () => {
    scratchTmpdir();
    const access = accessRecorder();
    const runtime = fakeRuntime();
    const backend = backendWith({ run: runtime.run, modelAccess: access.provider });

    const handle = await backend.provision({ kind: "container" });
    const guestHome = handle.ref.resolved?.guestHome ?? "";

    // The directory is recorded, because nothing else would ever remove it
    // after a restart.
    expect(guestHome).not.toBe("");
    expect(existsSync(guestHome)).toBe(true);

    // The bearer is in it, so the absence assertion below is about a token that
    // really exists rather than one nobody minted.
    expect(seededToken(guestHome)).toBe(access.token);

    // And it is nowhere in the ref, serialized exactly as the store serializes
    // it. A token in `resolved` would outlive both the container and the broker
    // that could revoke it.
    expect(JSON.stringify(handle.ref)).not.toContain(access.token);

    await backend.destroy(handle);
  });
});
