/**
 * The PATH.md gate. `bun run check:path` answers one question: can a real
 * phone, off this laptop's network, list this machine's live omp sessions,
 * open one, send a message, and read the agent's reply.
 *
 * The sibling checks prove pieces: `check-lan-roundtrip.ts` proves pairing and
 * turns against a daemon the client can route to, and `check-hub-roundtrip.ts`
 * proves the relay against a daemon this process spawned. Neither can prove
 * the sentence, because both run from this host. The phone is the witness that
 * matters here, so this script drives real hardware and never trusts a
 * happy-looking intermediate.
 *
 * What each phase refuses to accept as evidence:
 * - A `tunnel registered` log line is not stability. That line appeared
 *   several hundred times while this path was broken, because a second daemon
 *   leg sharing one identity kept evicting the first (`4409 replaced by a
 *   newer connection`). Only a quiet log window plus a single `ompd start`
 *   process plus a health probe that answers from this home counts.
 * - A session list over Wi-Fi is not a pass. The daemon sits on the LAN, so a
 *   Wi-Fi run never touches the hub at all; the radio is forced to cellular
 *   before the device run and asserted, not assumed.
 * - An emulator or simulator proves nothing (it shares this host's network),
 *   so the device is pinned by adb serial and its idiom is asserted.
 *
 * The five deliberate misses from PATH.md, each of which must stay red:
 * 1. Daemon stopped: the health probe goes unanswered, and a stopped daemon
 *    also makes the log quiet, which is exactly why liveness is asserted
 *    BEFORE the stability window, never by the window alone.
 * 2. Second daemon by hand: two `ompd start` processes are alive, and the
 *    window sees `4409` evictions; either fails the run.
 * 3. Device pointed at a wrong hub: the app cannot list sessions, the e2e
 *    scenario fails, the suite exits non-zero, and `round trip ok` never
 *    prints.
 * 4. Device left on Wi-Fi: the default transport never becomes CELLULAR, the
 *    assertion fails, and the device run is skipped because a Wi-Fi-carried
 *    round trip would prove nothing even if it passed.
 * 5. App uninstalled: `pm path` finds nothing and the run fails loudly.
 *
 * Wi-Fi is the one piece of Jason's phone state this script mutates, so
 * restoration is guaranteed by construction: the whole cellular phase runs
 * inside a try/finally, and SIGINT/SIGTERM handlers fire the same restore, so
 * a Ctrl-C mid-run cannot leave the phone without Wi-Fi.
 *
 * The run mints its own single-use pairing rather than asking the operator
 * for one: a throwaway keypair approved by the local operator credential
 * with exactly read and prompt, handed to the suite only through process
 * env, and revoked on the same guarantee as the Wi-Fi restore (success,
 * failure, and signal; the revoke is idempotent). The device dials the hub
 * relay for this daemon, and an endpoint naming loopback or private LAN
 * space fails the run outright: the phone has no route there, so such a run
 * could not prove the off-LAN sentence even if everything inside it passed.
 *
 * The identity file's private half is read to derive the daemon id and never
 * printed; only the derived id appears, abbreviated as PATH.md spells it.
 *
 * Usage:
 *   bun run check:path            # the full gate: radio, hub, real device run
 *   bun run check:path --dry-run  # phases 1, 2 and 4 only; never prints PATH GREEN
 *
 * Environment overrides (PATH.md values are the defaults):
 *   OMPCTL_DEVICE_SERIAL          adb serial, default 34241FDH2004KR
 *   OMPCTL_HUB_ORIGIN             hub origin, default https://hub.ompctl.ai
 *   OMPCTL_DAEMON_PORT            daemon health port, default 7777
 *   OMPCTL_STABILITY_WINDOW_SECS  quiet-log window, default 60
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatDeviceCredential } from "../packages/core/src/pairing.ts";
// The daemon's own derivations, not reimplementations: a fingerprint copied
// into this script would drift from the one the daemon actually uses, and the
// check would quietly stop comparing like with like.
import { homeIdFor } from "../packages/daemon/src/home-id.ts";
import { generateIdentity, identityFromPrivate } from "../packages/tunnel/src/identity.ts";

const repo = join(import.meta.dir, "..");
const DRY_RUN = process.argv.includes("--dry-run");

const SERIAL = process.env.OMPCTL_DEVICE_SERIAL ?? "34241FDH2004KR";
/** The socket URL is `wss://`; health is plain HTTP, so normalize if handed a socket form. */
const HUB_ORIGIN = (process.env.OMPCTL_HUB_ORIGIN ?? "https://hub.ompctl.ai")
  .replace(/^ws/, "http")
  .replace(/\/+$/, "");
const DAEMON_PORT = Number(process.env.OMPCTL_DAEMON_PORT ?? 7777);
const WINDOW_SECS = Number(process.env.OMPCTL_STABILITY_WINDOW_SECS ?? 60);

const OMPD_HOME = join(homedir(), ".ompd");
const LOG_PATH = join(OMPD_HOME, "ompd.log");
const PACKAGE = "ai.ompctl.app";
const APP_DIR = join(repo, "packages", "e2e");
/** The daemon's HTTP base, where the pairing routes live. */
const DAEMON_BASE = `http://127.0.0.1:${DAEMON_PORT}`;
/** The local operator credential that approves, and later revokes, the run's pairing. */
const OPERATOR_TOKEN_PATH = join(OMPD_HOME, "token");
/**
 * The hub in socket form: the inverse of the `ws` to `http` normalization
 * HUB_ORIGIN performs for health probes, and the exact shape the app's Hub
 * field expects. The daemon id is not in this string; it travels inside the
 * pasted credential.
 */
const HUB_SOCKET_URL = HUB_ORIGIN.replace(/^http/, "ws");

/**
 * The device-run budget has to cover a Detox boot, the app launching by its
 * icon, a listing over cellular, and one real agent turn over the relay. The
 * sibling hub check gives a single relayed turn 120s; the whole suite gets an
 * order of magnitude more before the check calls it hung rather than slow.
 */
const E2E_TIMEOUT_MS = 15 * 60_000;
/** Long enough for the radio to settle after `svc wifi disable`, short enough to fail a wedged one. */
const TRANSPORT_WAIT_MS = 45_000;
const WIFI_OFF_WAIT_MS = 15_000;
const WIFI_RESTORE_WAIT_MS = 20_000;

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// --- adb -------------------------------------------------------------------

const adbProbe = spawnSync("adb", ["version"], { encoding: "utf8" });
if (adbProbe.error) {
  console.error("adb is not on PATH; this check drives real hardware and needs Android platform-tools");
  process.exit(2);
}

/**
 * Every adb shell read goes through here so carriage returns from the device
 * pty never end up inside a parsed value.
 */
function adb(args: string[], timeoutMs = 15_000): { out: string; code: number } {
  const r = spawnSync("adb", ["-s", SERIAL, ...args], { encoding: "utf8", timeout: timeoutMs });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\r/g, ""), code: r.status ?? 1 };
}

/** Poll until a condition accepts the value, then return the last value seen either way. */
function poll<T>(read: () => T, done: (v: T) => boolean, ms: number): T {
  const deadline = Date.now() + ms;
  let last = read();
  while (!done(last) && Date.now() < deadline) {
    sleepSync(2_000);
    last = read();
  }
  return last;
}

// sleepSync rather than await inside poll: the reads are spawnSync calls
// anyway, so the loop gains nothing from being async, and a sync poll cannot
// be accidentally left dangling by a missing await.
function sleepSync(ms: number): void {
  const r = spawnSync("sleep", [String(Math.round(ms / 1000))], { encoding: "utf8" });
  if (r.error) {
    // A platform without `sleep` in PATH would rather block than hang; the
    // poll deadline still bounds the loop either way.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
}

// --- Wi-Fi restoration, armed before anything is disabled -------------------

let e2eChild: ReturnType<typeof spawn> | undefined;
let pendingRestore: (() => void) | undefined;
let restoreVerified: (() => void) | undefined;

function armWifiRestore(originalOn: boolean): void {
  // Found off, left off: that IS the original state, so there is nothing to
  // restore and no reason to touch the radio.
  if (!originalOn) return;
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    adb(["shell", "svc", "wifi", "enable"], 15_000);
  };
  pendingRestore = fire;
  restoreVerified = (): void => {
    fire();
    const on = poll(
      () => adb(["shell", "settings", "get", "global", "wifi_on"]).out.trim() === "1",
      v => v,
      WIFI_RESTORE_WAIT_MS,
    );
    // Restoration gates PATH GREEN: a run that passes every path assertion but
    // leaves the phone without Wi-Fi has not ended well, whatever it proved.
    check("wi-fi restored to on", on);
  };
}

// Ctrl-C must not be able to strand the phone with Wi-Fi off, nor leave this
// run's minted pairing alive on the daemon: an unhandled signal terminates
// without unwinding any finally, so both fire here too. The restore is
// synchronous; the revoke is a bounded fetch whose settle the exit follows.
for (const [sig, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  process.on(sig, () => {
    e2eChild?.kill("SIGTERM");
    pendingRestore?.();
    void revokeMintedPairing().finally(() => process.exit(code));
  });
}

// --- phase 1: the daemon leg ------------------------------------------------

function logLines(): string[] {
  return readFileSync(LOG_PATH, "utf8").split("\n");
}

/**
 * Assert the one daemon, and that it is THIS daemon: healthy on the expected
 * port, serving the home whose identity file names the id the log prints, and
 * the only `ompd start` process alive. Returns whether the premise for the
 * device phases holds.
 */
async function phaseDaemon(): Promise<boolean> {
  const before = failures.length;

  let health: { ok?: boolean; homeId?: string } = {};
  let answered = false;
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/v1/health`, { signal: AbortSignal.timeout(5_000) });
    health = (await res.json()) as { ok?: boolean; homeId?: string };
    answered = res.status === 200 && health.ok === true;
  } catch {
    answered = false;
  }
  // PATH.md miss 1: a daemon stopped with `launchctl bootout` stops answering
  // here, and that is the failure on record. This is deliberately asserted
  // before the quiet-log window, because a stopped daemon also makes the log
  // quiet, and a quiet log alone would read as stability.
  check("daemon answers /v1/health", answered);

  // The health endpoint publishes a fingerprint of the daemon's home so a
  // second daemon on a different home cannot be mistaken for this one. The
  // identity file lives in that same home, so a match ties the port to the
  // id derived below.
  const expectedHomeId = homeIdFor(OMPD_HOME);
  check(
    "health homeId is this home",
    answered && health.homeId === expectedHomeId,
    `${health.homeId ?? "?"} vs ${expectedHomeId}`,
  );

  // PATH.md miss 2: a hand-started `ompd start` alongside the launchd one.
  // `ps` plus an in-process filter rather than pgrep: pgrep's long-format
  // output differs between macOS and Linux, and a pattern that matches its own
  // command line is a classic false positive. The filter wants processes that
  // are both an ompd binary and a `start` invocation; one-shot CLI calls
  // (`ompd approve`, `ompd invite`) are not daemons and must not count.
  const ps = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const daemonProcesses = (ps.stdout ?? "")
    .split("\n")
    .filter(l => /\bompd\b/.test(l) && /\bstart\b/.test(l))
    .map(l => l.trim());
  check("exactly one ompd start process", daemonProcesses.length === 1, daemonProcesses.join("; ") || "none");

  // The identity file is the anchor for the daemon id. `loadIdentity` is wrong
  // here even though it exists: it MINTS an identity into a home that lacks
  // one, and a check must never write the live home. A missing or unparsable
  // identity is a failure, full stop.
  const identityPath = join(OMPD_HOME, "identity");
  if (existsSync(identityPath)) {
    try {
      daemonId = identityFromPrivate(readFileSync(identityPath, "utf8").trim()).daemonId;
    } catch {
      daemonId = "";
    }
  }
  check("identity derives a daemon id", daemonId.startsWith("dmn_"), daemonId);

  // The running daemon prints its own id in the startup banner; the derived id
  // appearing there closes the loop between the identity file, the home, and
  // the process that wrote this log.
  let log: string[] = [];
  try {
    log = logLines();
  } catch {
    check("daemon log is readable", false, LOG_PATH);
  }
  if (log.length > 0) {
    check("daemon log names the derived id", daemonId !== "" && log.some(l => l.includes(daemonId)));
  }

  const premiseHeld = failures.length === before;
  if (!answered || !premiseHeld) {
    // The window is only meaningful against a live daemon; against a stopped
    // one it measures silence and would call it stable.
    return false;
  }

  const baseline = log.length;
  await sleep(WINDOW_SECS * 1000);
  const after = logLines();
  // A shrank log means the daemon restarted mid-window (rewrite), which is
  // churn even when no `tunnel closed` line survived the rewrite.
  const restarted = after.length < baseline;
  const fresh = after.slice(baseline);
  const closures = fresh.filter(l => l.includes("tunnel closed")).length;
  const evictions = fresh.filter(l => l.includes("4409")).length;
  // PATH.md miss 2 lives here: the eviction loop shows up as `4409` closures
  // inside the window. A single `tunnel registered` line proves nothing, which
  // is why the window, not the log tail, is the evidence.
  check(
    "no tunnel churn in the stability window",
    !restarted && closures === 0 && evictions === 0,
    restarted ? "log shrank; daemon restarted" : `${closures} closures, ${evictions} evictions`,
  );
  if (!restarted && closures === 0 && evictions === 0) {
    console.log(`tunnel stable: 0 closures in ${WINDOW_SECS}s`);
  }
  return failures.length === before;
}

// --- phase 2: the real device ------------------------------------------------

/**
 * Read the hardware: attached and authorized, the app installed at a version
 * read off the device (never off a build), and a phone. Returns whether the
 * premise for the radio and device-run phases holds.
 */
function phaseDevice(): boolean {
  const before = failures.length;

  const listed = spawnSync("adb", ["devices", "-l"], { encoding: "utf8" });
  const line = `${listed.stdout ?? ""}`.split("\n").find(l => l.startsWith(SERIAL));
  const state = line?.trim().split(/\s+/)[1] ?? "";
  check("device attached in device state", state === "device", state || `${SERIAL} not in adb devices`);
  if (!line) return false;

  const model = adb(["shell", "getprop", "ro.product.model"]).out.trim();
  check("model read from the device", model !== "", model);
  // PATH.md spells the model `Pixel_7`: the string doubles as a token, and a
  // space in it would invite quoting drift in everything that greps for it.
  if (model !== "") console.log(`device ${SERIAL} ${model.replace(/\s+/g, "_")}`);

  // PATH.md miss 5: an uninstalled app must fail loudly, not pass quietly, so
  // presence is asserted before anything tries to read a version from it.
  const pm = adb(["shell", "pm", "path", PACKAGE]);
  const present = pm.code === 0 && pm.out.includes("package:");
  check(`${PACKAGE} installed`, present, present ? "" : "pm path found nothing");

  if (present) {
    const dump = adb(["shell", "dumpsys", "package", PACKAGE]).out;
    const versionName = dump.match(/versionName=(\S+)/)?.[1] ?? "";
    const versionCode = dump.match(/versionCode=(\d+)/)?.[1] ?? "";
    check(
      "installed version read off the device",
      versionName !== "" && versionCode !== "",
      `${versionName}/${versionCode}`,
    );
    if (versionName !== "" && versionCode !== "") {
      console.log(`installed ${PACKAGE} ${versionName}/${versionCode}`);
    }
  }

  // The idiom signal is the computed smallest-width qualifier, because that is
  // what actually selects tablet chrome: sw >= 600 is the tablet resource
  // bucket. `ro.build.characteristics` is NOT usable here: this bench device
  // answers `nosdcard`, an SD-slot fact that says nothing about idiom.
  const characteristics = adb(["shell", "getprop", "ro.build.characteristics"]).out.trim();
  const sizeMatch = adb(["shell", "wm", "size"]).out.match(/Physical size:\s*(\d+)x(\d+)/);
  const density = Number(adb(["shell", "getprop", "ro.sf.lcd_density"]).out.trim());
  let phoneOk = false;
  let swDetail = "screen or density unreadable";
  if (sizeMatch && Number.isFinite(density) && density > 0) {
    const w = Number(sizeMatch[1]);
    const h = Number(sizeMatch[2]);
    const swDp = Math.floor((Math.min(w, h) * 160) / density);
    phoneOk = swDp < 600;
    swDetail = `sw ${swDp}dp (characteristics: ${characteristics})`;
  }
  check("idiom is phone", phoneOk, swDetail);
  if (phoneOk) console.log("idiom phone");

  return failures.length === before;
}

// --- phase 3: off the home LAN ------------------------------------------------

function wifiOn(): boolean {
  return adb(["shell", "settings", "get", "global", "wifi_on"]).out.trim() === "1";
}

/**
 * The active default network's transport, from connectivity's own dump: the
 * `Active default network` line names a net id, and the NetworkAgentInfo line
 * for that id carries the transport. Network offers also contain "Transports:"
 * lines, so the agent line is found by its `network{id}` first, never by
 * transport alone.
 */
function defaultTransport(): string {
  const dump = adb(["shell", "dumpsys", "connectivity"], 20_000).out;
  const id = dump.match(/Active default network: (\d+)/)?.[1];
  if (!id) return "";
  const agent = dump.split("\n").find(l => l.includes(`network{${id}}`) && l.includes("Transports:"));
  return agent?.match(/Transports: ([A-Z_]+)/)?.[1] ?? "";
}

/**
 * Force the phone off the LAN and prove it landed on cellular. Returns whether
 * the transport was proven CELLULAR; the caller decides what still makes
 * sense to run against that verdict.
 */
async function phaseCellular(originalOn: boolean): Promise<boolean> {
  if (originalOn) {
    adb(["shell", "svc", "wifi", "disable"]);
    const off = poll(
      () => !wifiOn(),
      v => v,
      WIFI_OFF_WAIT_MS,
    );
    // Some builds refuse `svc wifi` without root. The one thing that must not
    // happen is faking the off-LAN state and running anyway, so this fails
    // with the manual step named rather than degrading into a Wi-Fi run.
    check(
      "wi-fi disabled without root",
      off,
      off
        ? ""
        : "svc wifi disable did not take; manual step: turn Wi-Fi off on the Pixel by hand, this check will not fake the off-LAN state",
    );
    if (!off) return false;
  }

  // PATH.md miss 4: a device left on Wi-Fi never flips its default network to
  // CELLULAR, so this assertion fails and the device run is skipped.
  const transport = poll(
    () => defaultTransport(),
    v => v === "CELLULAR",
    TRANSPORT_WAIT_MS,
  );
  check("default transport is CELLULAR", transport === "CELLULAR", `saw ${transport || "no default network"}`);
  if (transport === "CELLULAR") {
    console.log("transport CELLULAR");
    return true;
  }
  return false;
}

// --- phase 4: registered through the hub --------------------------------------

async function phaseHubRegistration(): Promise<void> {
  const before = failures.length;

  let instanceId = "";
  let hubOk = false;
  try {
    const res = await fetch(`${HUB_ORIGIN}/v1/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { ok?: boolean; instanceId?: string };
    hubOk = res.status === 200 && body.ok === true;
    instanceId = body.instanceId ?? "";
  } catch {
    hubOk = false;
  }
  check("hub healthy", hubOk, HUB_ORIGIN);

  let log: string[] = [];
  try {
    log = logLines();
  } catch {
    check("daemon log readable for registration", false, LOG_PATH);
  }

  // The hub redeploys under a new instanceId; only the daemon's LAST
  // registration counts, and it must name the instance answering health right
  // now, or the relay the phone would use is not the one being checked.
  let registrationIdx = -1;
  let registeredInstance = "";
  for (let i = log.length - 1; i >= 0; i -= 1) {
    const m = log[i].match(/tunnel registered with hub instance (inst_\w+)/);
    if (m) {
      registrationIdx = i;
      registeredInstance = m[1];
      break;
    }
  }
  check("daemon has registered with the hub", registeredInstance !== "", registeredInstance || "no registration line");
  check(
    "registration names the live hub instance",
    registeredInstance !== "" && registeredInstance === instanceId,
    `${registeredInstance || "?"} vs ${instanceId || "?"}`,
  );

  // A registration followed by a later `tunnel closed` is a dead leg wearing
  // a live registration line; the current state, not the last success, is
  // what the phone will be routed through.
  let lastTunnelIdx = -1;
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (/tunnel (registered|closed|error)/.test(log[i])) {
      lastTunnelIdx = i;
      break;
    }
  }
  check("registration is the latest tunnel event", registrationIdx !== -1 && registrationIdx === lastTunnelIdx);

  if (failures.length === before && daemonId.startsWith("dmn_")) {
    // Abbreviated exactly as PATH.md prints it: nine head characters, an
    // ellipsis, five tail characters.
    const short = `${daemonId.slice(0, 9)}…${daemonId.slice(-5)}`;
    console.log(`daemon ${short} registered ${registeredInstance}`);
  }
}

// --- the run's own pairing: minted, handed over, revoked -----------------------

/**
 * The device run consumes a pairing minted by this run, because PATH.md
 * promises one command with no credential exported by hand. Everything about
 * it is single-use: a throwaway keypair, scopes pinned to exactly read and
 * prompt (the @path prompt forbids tools precisely because this pairing
 * cannot approve one, and the sibling scenario asserts the invite control
 * stays hidden without the approve scope), and a device row that is revoked
 * on every exit path. The minted token is never printed; it reaches the
 * suite through process env and dies with this process.
 */
let pairing: { deviceId: string } | null = null;
/** Read once for the authorize headers, held for this run, never printed. */
let operatorBearer = "";

let revokeSettled = false;
let revokeInFlight: Promise<boolean> | undefined;

/**
 * Withdraw the run's pairing from the daemon (`DELETE /v1/devices/:id`, the
 * gateway's own revocation route). Idempotent by construction: callers that
 * race share one attempt, callers after a completed successful one are
 * no-ops, and the daemon's 404 for an already-gone row reads as success. A
 * live credential left behind is not an acceptable outcome of a test run,
 * so a false return must become a check failure wherever this is awaited.
 */
async function revokeMintedPairing(): Promise<boolean> {
  if (revokeSettled || pairing === null) return true;
  const target = pairing;
  revokeInFlight ??= (async () => {
    try {
      const res = await fetch(`${DAEMON_BASE}/v1/devices/${encodeURIComponent(target.deviceId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${operatorBearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      // 200 is the revocation; 404 is the row already gone, which is the
      // same end state (a double fire lands here).
      return res.status === 200 || res.status === 404;
    } catch {
      return false;
    }
  })();
  const ok = await revokeInFlight;
  if (ok) revokeSettled = true;
  return ok;
}

/**
 * Whether a hub host names somewhere the off-LAN phone cannot be proven
 * against: loopback, link-local, or RFC 1918 private space. The phone has no
 * route to this laptop's network at run time, so an endpoint naming any of
 * these would fail for the wrong reason, or pass while proving nothing.
 */
function isLanHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) {
    return true;
  }
  const rfc1918 = /^172\.(\d+)\./.exec(h);
  return rfc1918 !== null && Number(rfc1918[1]) >= 16 && Number(rfc1918[1]) <= 31;
}

/**
 * Mint, approve, and arm the revocation of this run's pairing against the
 * live daemon, and resolve what the device will be handed. Returns the
 * endpoint and credential for the suite, or null with the failure already
 * on the record. A pairing code alone grants nothing, and only a fully
 * minted pairing arms the revoke path, so every refusal bails with nothing
 * live behind it.
 */
async function mintRunPairing(): Promise<{ endpoint: string; credential: string } | null> {
  const before = failures.length;

  // A real throwaway Ed25519 key, minted and encoded by the same identity
  // module every daemon identity uses (base64url of the raw 32-byte key),
  // rather than an encoding invented here. The daemon stores the string
  // opaquely and every existing /v1/pair client sends a sentinel (`cli:` or
  // `invite:` prefixed throwaways); a well-formed key is what the field
  // claims to be, and costs nothing to produce.
  const name = `ompctl check:path ${randomUUID().slice(0, 8)}`;

  // Present but unreadable (permissions) fails the check rather than the
  // process: an uncaught read here would end the run without a report line.
  try {
    operatorBearer = existsSync(OPERATOR_TOKEN_PATH) ? readFileSync(OPERATOR_TOKEN_PATH, "utf8").trim() : "";
  } catch {
    operatorBearer = "";
  }
  check("operator credential readable", operatorBearer !== "", OPERATOR_TOKEN_PATH);

  let code = "";
  if (operatorBearer !== "") {
    try {
      const res = await fetch(`${DAEMON_BASE}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: generateIdentity().publicKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { code?: string };
      if (res.status === 200 && typeof body.code === "string") code = body.code;
    } catch {
      code = "";
    }
  }
  check("pairing code issued for this run", code !== "");

  // The scopes are the approver's choice, never the pairing client's, so
  // they are pinned here: exactly read and prompt, nothing wider.
  let token = "";
  if (code !== "" && operatorBearer !== "") {
    try {
      const res = await fetch(`${DAEMON_BASE}/v1/pairings/approve`, {
        method: "POST",
        headers: { authorization: `Bearer ${operatorBearer}`, "content-type": "application/json" },
        body: JSON.stringify({ code, scopes: ["read", "prompt"] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 403) {
        // This route's only 403 is a caller without the approve scope: the
        // local operator credential cannot approve a pairing, and the run
        // must say so rather than fall through to a hand-exported token.
        check(
          "operator credential can approve a pairing",
          false,
          `${OPERATOR_TOKEN_PATH} was refused (403 forbidden); it does not hold the approve scope`,
        );
      } else {
        const body = (await res.json()) as { token?: string };
        if (res.status === 200 && typeof body.token === "string") token = body.token;
      }
    } catch {
      token = "";
    }
  }
  check("pairing approved with exactly read and prompt", token !== "");

  // The device row exists the moment approve answers; its id is read back
  // now because revocation is by id, and arming `pairing` here is what lets
  // every exit path (the finally and the signal handlers) fire the revoke.
  let deviceId = "";
  if (token !== "") {
    try {
      const res = await fetch(`${DAEMON_BASE}/v1/devices`, {
        headers: { authorization: `Bearer ${operatorBearer}` },
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { devices?: { id?: string; name?: string }[] };
      if (res.status === 200 && Array.isArray(body.devices)) {
        deviceId = body.devices.find(d => d.name === name)?.id ?? "";
      }
    } catch {
      deviceId = "";
    }
  }
  // An approved token whose row cannot be found again must not be handed
  // out either: without the id there is no revoke, and the run says so.
  check("minted device row found for revocation", deviceId !== "");

  // The endpoint the DEVICE dials is the hub base in socket form: what the
  // app's Hub field parses (`parsePairTarget` reads a `wss://` base with no
  // path as the relay) and the same transport the daemon itself offers
  // (`reachableEndpoints` builds `{transport: "hub", hubUrl, daemonId}`).
  // The daemon id does not travel in this field; it rides inside the
  // credential, which is why the field stays short enough to type.
  const host = /^wss?:\/\/([^/?#:]+)/.exec(HUB_SOCKET_URL)?.[1] ?? "";
  check(
    "device endpoint is the hub relay, not a LAN address",
    host !== "" && !isLanHost(host),
    host === "" ? HUB_SOCKET_URL : `${host}; a LAN or loopback endpoint cannot prove the off-LAN path`,
  );

  if (failures.length !== before) return null;
  pairing = { deviceId };
  return {
    endpoint: HUB_SOCKET_URL,
    // The credential packs the live daemon id with the minted token exactly
    // as `formatDeviceCredential` spells it (`<id body>.<token>`), the one
    // shape the app's token field accepts as a device credential.
    credential: formatDeviceCredential({ daemonId, token }),
  };
}

// --- phase 5: the real-device round trip --------------------------------------

/**
 * Run the e2e suite against the attached hardware. Output streams through
 * live (a silent multi-minute gap helps nobody) while being captured for the
 * parse, because the canonical strings are printed by THIS script only.
 */
function runSuite(endpoint: string, credential: string): Promise<{ code: number; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    const child = spawn("bun", ["run", "test:android:device"], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        DETOX_ADB_NAME: SERIAL,
        E2E_TAGS: "@path",
        // This run's own minted pairing, deliberately overriding anything
        // exported into the environment: a stale hand-exported credential
        // would widen scopes behind the check's back and dodge the revoke.
        OMPD_E2E_ENDPOINT: endpoint,
        OMPD_E2E_TOKEN: credential,
      },
    });
    e2eChild = child;
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, E2E_TIMEOUT_MS);
    const take = (chunk: Buffer): void => {
      const text = chunk.toString();
      out += text;
      process.stdout.write(text);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", err => {
      clearTimeout(timer);
      e2eChild = undefined;
      resolve({ code: 1, out: `${out}${err}`, timedOut: false });
    });
    child.on("exit", code => {
      clearTimeout(timer);
      e2eChild = undefined;
      resolve({ code: code ?? 1, out, timedOut });
    });
  });
}

async function phaseRoundTrip(): Promise<void> {
  const before = failures.length;
  // Minted immediately before the spawn so the token's exposure window is
  // the suite's own lifetime; a refusal leaves the failure on the record
  // and there is nothing to run the suite with.
  const handoff = await mintRunPairing();
  if (handoff === null) return;
  const run = await runSuite(handoff.endpoint, handoff.credential);
  // PATH.md miss 3: a device pointed at a wrong hub cannot list sessions, the
  // scenario fails on device, and this exit code is where the check sees it.
  check("e2e suite exited 0", run.code === 0 && !run.timedOut, run.timedOut ? "timed out" : `exit ${run.code}`);

  // The scenario prints `[path] sessions listed: <n>` once it has seen the
  // rows on device (and only after asserting n >= 1 itself). The last match
  // wins if a future scenario ever emits more than one.
  const counts = [...run.out.matchAll(/\[path\] sessions listed: (\d+)/g)].map(m => Number(m[1]));
  const listed = counts.length > 0 ? counts[counts.length - 1] : 0;
  check(
    "session count parsed from the run",
    listed >= 1,
    counts.length > 0 ? `parsed ${listed}` : "no marker line in suite output",
  );

  if (failures.length === before) {
    console.log(`sessions listed: ${listed}`);
    console.log("round trip ok");
  }
}

// --- the flow -------------------------------------------------------------------

let daemonId = "";

console.log(
  `\npath check: daemon on 127.0.0.1:${DAEMON_PORT}, hub ${HUB_ORIGIN}, device ${SERIAL}${DRY_RUN ? ", dry run" : ""}`,
);

const daemonPremise = await phaseDaemon();
const devicePremise = phaseDevice();

if (DRY_RUN) {
  // A dry run exercises the cheap assertions only. It must never be able to
  // print PATH GREEN: that string claims the whole path, radio and round trip
  // included, and three phases cannot establish it. Pairing readiness stops
  // at the operator credential being present and readable: minting writes a
  // pairing to the live daemon, and a dry run does not write.
  let tokenPresent = false;
  try {
    tokenPresent = existsSync(OPERATOR_TOKEN_PATH) && readFileSync(OPERATOR_TOKEN_PATH, "utf8").trim().length > 0;
  } catch {
    tokenPresent = false;
  }
  check("operator credential present for pairing", tokenPresent, OPERATOR_TOKEN_PATH);
  await phaseHubRegistration();
} else if (daemonPremise && devicePremise) {
  // The radio is only touched when the rest is worth a device run: a broken
  // daemon leg or a missing app is already red, and no device result can turn
  // it green, so the phone's Wi-Fi stays alone.
  const originalOn = wifiOn();
  armWifiRestore(originalOn);
  try {
    const cellularOk = await phaseCellular(originalOn);
    await phaseHubRegistration();
    // A round trip carried over Wi-Fi proves nothing (the daemon is on that
    // same LAN), so with the transport unproven the suite is skipped: red is
    // already on the record, and a device run cannot add information to it.
    if (cellularOk) await phaseRoundTrip();
  } finally {
    restoreVerified?.();
    // The phone's radio first (a stranded phone outranks a stray device
    // row), then the run's own credential: a pairing that survived its run
    // is a failure of the run, not a note for later.
    const revoked = await revokeMintedPairing();
    check("run's pairing revoked", revoked, revoked ? "" : "the daemon still holds this run's device row");
  }
} else {
  // Still diagnose the hub leg: the report should say which link was broken,
  // not just that something was.
  await phaseHubRegistration();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed:`);
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
if (DRY_RUN) {
  console.log("\ndry run ok (phases 1, 2, 4; transport and round trip not exercised)");
  process.exit(0);
}
console.log("\nPATH GREEN");
