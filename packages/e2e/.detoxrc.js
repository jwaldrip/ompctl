/**
 * Detox device and app configuration.
 *
 * `testRunner` is deliberately Cucumber rather than Jest. Detox ships a Jest
 * integration, but the specifications here are `.feature` files that must also
 * run against the browser through the Playwright client, and binding them to
 * Jest would fork them into a native suite and a web suite. Detox is used only
 * as a driver; Cucumber owns the run.
 *
 * Paths are relative to this file, so the app builds are addressed through
 * `../app`. That keeps the config working regardless of where the repository
 * sits, and regardless of how deeply this package is nested.
 */
const androidAppDir = "../app/android";

module.exports = {
  apps: {
    "android.debug": {
      type: "android.apk",
      binaryPath: `${androidAppDir}/app/build/outputs/apk/debug/app-debug.apk`,
      testBinaryPath: `${androidAppDir}/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk`,
      build: `cd ${androidAppDir} && ./gradlew :app:assembleDebug :app:assembleAndroidTest -DtestBuildType=debug`,
    },
    "ios.debug": {
      type: "ios.app",
      // Built by `packages/app/scripts/ios-sim-test.sh`'s derived-data path.
      binaryPath: "../app/ios/build/Build/Products/Debug-iphonesimulator/ompd.app",
      build:
        "cd ../app/ios && xcodebuild -workspace ompd.xcworkspace -scheme ompd -configuration Debug -sdk iphonesimulator -derivedDataPath ./build",
    },
    "ios.device.debug": {
      type: "ios.app",
      // Debug-iphoneos, not Debug-iphonesimulator: hardware needs the device
      // slice, which the simulator entry below never produces. Shares that
      // entry's derived-data path so the two products sit side by side rather
      // than evicting each other on every alternate build.
      binaryPath: "../app/ios/build/Build/Products/Debug-iphoneos/ompd.app",
      // A generic destination, not a UDID: the app product is device-agnostic
      // exactly like the Android APKs, and pinning one phone here would fail
      // the build whenever that phone is unplugged.
      build:
        "cd ../app/ios && xcodebuild -workspace ompd.xcworkspace -scheme ompd -configuration Debug -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath ./build",
    },
  },
  /**
   * Real hardware is mandatory for the PATH run. The claim is that a phone
   * off the daemon's LAN can still drive it through the hub, and a simulator
   * cannot prove that: it shares the host's network stack, so its traffic
   * reaches the hub exactly as the daemon's own does. The real-hardware
   * configurations are `android.attached.debug` and `ios.device.debug`;
   * `android.emu.debug` and `ios.sim.debug` are for local iteration only and
   * can never satisfy the PATH check.
   */
  devices: {
    /**
     * An already-running emulator or a plugged-in phone, pinned by its adb
     * serial. Preferred over the `emulator` device below whenever something is
     * already attached: Detox's own emulator launcher has a retry that can spawn
     * a second QEMU for the same AVD and then wait on the serial of the one it
     * did not keep, which fails a run that had a perfectly good device all along.
     * Pinning the serial removes that whole class of failure, and it is the only
     * way to target a physical phone.
     */
    attached: {
      type: "android.attached",
      device: { adbName: process.env.DETOX_ADB_NAME ?? "emulator-5554" },
    },
    emulator: {
      type: "android.emulator",
      // Matches the AVD created for this repo's runs; override with
      // `--device-name` when a machine has a different one.
      device: { avdName: process.env.DETOX_AVD_NAME ?? "ompctl_pixel" },
    },
    simulator: {
      type: "ios.simulator",
      device: { type: process.env.DETOX_SIM_TYPE ?? "iPad (A16)" },
    },
    /**
     * A physical iPhone, selected by name. The `{ name }` selector form is
     * used rather than `{ id }` because `DETOX_IOS_DEVICE` and the default
     * carry a device name, and a name survives a wiped or replaced phone
     * where a UDID is burned into one physical unit.
     *
     * The installed Detox (20.51.4) has no built-in driver for this type; it
     * treats an unknown device type as an external driver module path and
     * tries to require it, so this entry goes live only once such a driver
     * exists. Failing loudly at init is a detector: rerouting to
     * `ios.simulator` would put a simulator behind a configuration whose
     * whole job is to be real hardware.
     */
    iosDevice: {
      type: "ios.device",
      device: { name: process.env.DETOX_IOS_DEVICE ?? "BushidoPhone" },
    },
  },
  configurations: {
    // Runs against whatever is already attached; `DETOX_ADB_NAME` selects it.
    "android.attached.debug": {
      device: "attached",
      app: "android.debug",
    },
    "android.emu.debug": {
      device: "emulator",
      app: "android.debug",
    },
    "ios.sim.debug": {
      device: "simulator",
      app: "ios.debug",
    },
    // Real hardware: the plugged-in iPhone named by `DETOX_IOS_DEVICE`.
    "ios.device.debug": {
      device: "iosDevice",
      app: "ios.device.debug",
    },
  },
  behavior: {
    init: {
      // `installWorker()` registers `device`, `element`, `by`, and `waitFor` on
      // globalThis, and that is the only API surface available when Detox is
      // driven programmatically rather than through its Jest integration.
      exposeGlobals: true,
      // The Cucumber Before hook launches the app once per scenario itself.
      launchApp: false,
    },
  },
  /**
   * A fixed server port instead of Detox's random one.
   *
   * On a physical phone the app dials the Detox server on the host, which only
   * works through an `adb reverse` for that exact port. A random port cannot be
   * reversed ahead of time, and without the reverse the app's DetoxWSClient sits
   * in "Retrying... At connectToServer" while every element lookup times out
   * against a screen that never rendered.
   */
  session: {
    autoStart: true,
    server: `ws://localhost:${process.env.DETOX_SERVER_PORT ?? "8099"}`,
    sessionId: "ompctl-e2e",
  },
  artifacts: {
    rootDir: process.env.E2E_ARTIFACTS ?? "./artifacts",
    plugins: {
      screenshot: { shouldTakeAutomaticSnapshots: false },
    },
  },
};
