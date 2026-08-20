/**
 * Detox's process lifecycle, expressed as Cucumber hooks.
 *
 * `detox test` cannot run this suite: its CLI resolves Jest unconditionally and
 * exits before reading any `testRunner` setting, so the specifications would
 * have to be rewritten as Jest tests and would stop being shared with the web
 * run. Instead the suite runs under plain `cucumber-js` and drives Detox through
 * `detox/internals`, which is the same API Detox's own Jest integration uses:
 *
 *   init -> installWorker -> (onTestStart / onTestDone per scenario)
 *        -> uninstallWorker -> cleanup
 *
 * `installWorker()` is the load-bearing call. It allocates the device, installs
 * both APKs, and registers `device`, `element`, `by`, and `waitFor` on
 * globalThis. Without it there is no Detox API to drive at all.
 *
 * Everything here no-ops unless a native driver was asked for, because
 * `cucumber.js` loads `support/**` for every client and a web run must not go
 * looking for adb.
 */
import { execSync } from "node:child_process";
import { AfterAll, Before, BeforeAll, After, type ITestCaseHookParameter } from "@cucumber/cucumber";

const NATIVE = process.env.E2E_CLIENT === "android" || process.env.E2E_CLIENT === "ios";

/** The Detox configuration name, derived from the driver unless given. */
function configuration(): string {
  if (process.env.DETOX_CONFIGURATION !== undefined) return process.env.DETOX_CONFIGURATION;
  if (process.env.E2E_CLIENT === "ios") return "ios.sim.debug";
  // A pinned serial means a real phone or a chosen emulator is on the bench, and
  // that is always a better target than asking Detox to boot one.
  return process.env.DETOX_ADB_NAME !== undefined ? "android.attached.debug" : "android.emu.debug";
}

function adb(): string {
  const root = process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME ?? "";
  return `${root}/platform-tools/adb`;
}

/**
 * Detox's internals are CommonJS. Under an ESM dynamic import that arrives as a
 * namespace whose `default` holds the real module, so reaching for `init`
 * directly finds nothing. Normalising here keeps every call site honest.
 */
async function internals(): Promise<{
  init(options: { argv: Record<string, unknown> }): Promise<void>;
  cleanup(): Promise<void>;
  onTestStart(t: { title: string; fullName: string; status: string }): Promise<void>;
  onTestDone(t: { title: string; fullName: string; status: string }): Promise<void>;
}> {
  const mod = (await import("detox/internals.js")) as Record<string, unknown>;
  const resolved = (mod.default ?? mod) as { init?: unknown };
  if (typeof resolved.init !== "function") {
    throw new Error("detox/internals did not expose init(); the Detox version may be incompatible");
  }
  return resolved as never;
}

/**
 * True when an emulator is already visible to adb.
 *
 * Detox launches its own emulator when it finds none free, and its launcher has
 * a retry that can leave two QEMU processes booting the same AVD, both racing to
 * connect. Letting it discover an already-running device avoids that entirely,
 * so a pre-booted emulator is preferred rather than fought.
 */
function emulatorAlreadyRunning(): boolean {
  try {
    const out = execSync(`${adb()} devices`, { encoding: "utf8" });
    return out.split("\n").some((l) => l.includes("emulator-") && l.trim().endsWith("device"));
  } catch {
    return false;
  }
}

/**
 * Point the device's loopback at this machine's ports.
 *
 * A phone plugged in over USB has no route to the host's localhost. Detox's
 * server and Metro both live there, so without these reverses the app dials
 * nothing: the symptom is a black screen and `DetoxWSClient: Retrying...` in
 * logcat, which looks like a broken app rather than a missing tunnel.
 *
 * Harmless on an emulator, which already reaches the host, so it is not
 * conditioned on the device kind.
 */
function setupAdbReverse(serial: string): void {
  const ports = [Number(process.env.DETOX_SERVER_PORT ?? 8099), 8081];
  for (const port of ports) {
    try {
      execSync(`${adb()} -s ${serial} reverse tcp:${port} tcp:${port}`, { encoding: "utf8" });
      console.log(`  adb reverse tcp:${port} -> host tcp:${port}`);
    } catch (e) {
      console.log(`  adb reverse failed for ${port}: ${(e as Error).message}`);
    }
  }
}

BeforeAll({ timeout: 600_000 }, async () => {
  if (!NATIVE) return;
  const detox = await internals();
  if (process.env.E2E_CLIENT === "android" && emulatorAlreadyRunning()) {
    console.log("  reusing the running emulator rather than letting Detox launch one");
  }
  // Before init, so the app finds the server the moment it first launches.
  const serial = process.env.DETOX_ADB_NAME;
  if (process.env.E2E_CLIENT === "android" && serial !== undefined) setupAdbReverse(serial);
  // init installs a worker unless workerId is null. Installing another worker
  // creates a second tester for the same session even though Detox stores only
  // one, which breaks ownership of the app launch and ready handshake.
  await detox.init({ argv: { configuration: configuration(), loglevel: process.env.DETOX_LOGLEVEL ?? "warn" } });
});

// Detox needs the test boundaries to attribute artifacts and to reset per-test
// state. Registered before the client hook by load order, which is what puts
// `onTestStart` ahead of the app launch.
Before(async function (message: ITestCaseHookParameter) {
  if (!NATIVE) return;
  const detox = await internals();
  await detox.onTestStart({
    title: message.pickle.uri,
    fullName: message.pickle.name,
    status: "running",
  });
});

After(async function (message: ITestCaseHookParameter) {
  if (!NATIVE) return;
  const detox = await internals();
  await detox.onTestDone({
    title: message.pickle.uri,
    fullName: message.pickle.name,
    status: message.result?.status === "PASSED" ? "passed" : "failed",
  });
});

AfterAll({ timeout: 120_000 }, async () => {
  if (!NATIVE) return;
  const detox = await internals();
  // cleanup uninstalls the worker before closing the session server.
  await detox.cleanup();
});
