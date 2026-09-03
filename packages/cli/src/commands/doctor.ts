/**
 * `ompd doctor`: one command that answers "is this set up correctly".
 *
 * This is the command someone runs when something is wrong, which makes its
 * output the whole feature. A check that reports `fail` and leaves the reader
 * to work out the next move has done half a job, so every non-ok line carries
 * the command that fixes it. Nothing here mutates anything.
 *
 * The severities mean different things and the exit code respects that. A
 * `fail` is something that is broken now: no daemon, a token the daemon
 * rejects, a login agent pointing at a path that no longer exists. A `warn` is
 * a capability that is absent rather than broken, like having no container
 * runtime installed, and does not make the exit code non-zero. Reporting a
 * missing optional as a failure would train the reader to ignore the exit code.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWN_RUNTIMES,
  loadConfig,
  OMPD_VERSION,
  probeRuntime,
  type RuntimeCapability,
  type RuntimeUnavailable,
  runtimeOrder,
} from "@ompd/daemon";
import { type CliContext, resolveBaseUrl, resolveToken } from "../client.ts";
import { BINARY_NAME, findOnPath } from "../install.ts";
import { PLIST_MARKER, plistPath, plistProgram } from "./service.ts";

type Severity = "ok" | "warn" | "fail";

interface Check {
  label: string;
  severity: Severity;
  detail: string;
  /** Printed under the detail for anything not ok. Says what to run. */
  advice?: string[];
}

interface HealthResponse {
  ok?: boolean;
  version?: string;
}

export async function doctorCommand(ctx: CliContext): Promise<number> {
  const checks: Check[] = [];

  const binary = await binaryCheck(ctx);
  checks.push(binary.check);

  const daemon = await daemonCheck(ctx);
  checks.push(daemon.check);
  checks.push(versionCheck(binary.version, daemon.version));
  checks.push(await tokenCheck(ctx, daemon.reachable));
  checks.push(loginAgentCheck(ctx));
  checks.push(stateCheck(ctx));
  checks.push(await runtimeCheck(ctx));
  checks.push(awakeCheck(ctx));

  const width = checks.reduce((widest, check) => Math.max(widest, check.label.length), 0);
  for (const check of checks) {
    ctx.out(`${MARK[check.severity]} ${check.label.padEnd(width)}  ${check.detail}`);
    // Aligned under the detail, not under the mark: the advice belongs to the
    // line above it, and a ragged left edge is what makes a wall of checks
    // unreadable at the moment someone needs to read it.
    for (const line of check.advice ?? []) ctx.out(`${" ".repeat(width + 7)}${line}`);
  }

  const failed = checks.filter(check => check.severity === "fail").length;
  const warned = checks.filter(check => check.severity === "warn").length;

  ctx.out("");
  if (failed === 0 && warned === 0) {
    ctx.out(`all ${checks.length} checks passed`);
    return 0;
  }
  ctx.out(`${checks.length - failed - warned} ok, ${warned} to look at, ${failed} broken`);
  return failed === 0 ? 0 : 1;
}

const MARK: Record<Severity, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

interface BinaryCheck {
  check: Check;
  /** Version the installed binary reports, or null when there is none. */
  version: string | null;
}

/**
 * Is `ompd` a command on this machine.
 *
 * Resolved by walking `PATH` rather than shelling out to `which`, so the
 * answer comes from the same environment the CLI was handed and a test can set
 * it. The binary is then run for its version, because a file on `PATH` that
 * cannot execute is worse than one that is missing.
 */
async function binaryCheck(ctx: CliContext): Promise<BinaryCheck> {
  const found = findOnPath(ctx.env, BINARY_NAME);
  if (found === null) {
    return {
      version: null,
      check: {
        label: "binary",
        severity: "fail",
        detail: `no ${BINARY_NAME} on PATH; every documented command starts with it`,
        advice: ["run: bun run build:cli && bun packages/cli/src/main.ts self-install"],
      },
    };
  }

  let reported = "";
  let failure = "";
  try {
    const result = await ctx.exec([found, "--version"]);
    if (result.code === 0) reported = result.stdout.trim();
    else failure = result.stderr.trim() || `exit ${result.code}`;
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  if (reported.length === 0) {
    return {
      version: null,
      check: {
        label: "binary",
        severity: "fail",
        detail: `${found} is on PATH but did not report a version: ${failure || "empty output"}`,
        advice: ["it is stale, truncated, or not ompd", "run: ompd self-install"],
      },
    };
  }

  return {
    version: reported,
    check: { label: "binary", severity: "ok", detail: `${found} (${reported})` },
  };
}

interface DaemonCheck {
  check: Check;
  reachable: boolean;
  version: string | null;
}

async function daemonCheck(ctx: CliContext): Promise<DaemonCheck> {
  const base = resolveBaseUrl(ctx);

  let health: HealthResponse | null = null;
  try {
    const response = await ctx.fetch(`${base}/v1/health`);
    if (response.ok) health = (await response.json()) as HealthResponse;
  } catch {
    health = null;
  }

  if (health === null) {
    return {
      reachable: false,
      version: null,
      check: {
        label: "daemon",
        severity: "fail",
        detail: `nothing answered ${base}/v1/health`,
        advice: ["run: ompd start", "already running elsewhere? point this shell at it with OMPD_URL"],
      },
    };
  }

  return {
    reachable: true,
    version: health.version ?? null,
    check: {
      label: "daemon",
      severity: "ok",
      detail: `running at ${base} (${health.version ?? "version unknown"})`,
    },
  };
}

/**
 * Do the three versions in play agree.
 *
 * There are three, not two: the code running this command, the binary on
 * `PATH`, and the daemon that is answering. They disagree in exactly the
 * situation this is here to catch, which is an upgrade that only landed in
 * some of them. A mismatch is stale rather than broken, so it warns, and the
 * advice is the pair of commands that make all three agree.
 */
function versionCheck(binary: string | null, daemon: string | null): Check {
  const holders: Array<[string, string]> = [["cli", OMPD_VERSION]];
  if (binary !== null) holders.push(["binary", binary]);
  if (daemon !== null) holders.push(["daemon", daemon]);

  const byVersion = new Map<string, string[]>();
  for (const [who, version] of holders) {
    byVersion.set(version, [...(byVersion.get(version) ?? []), who]);
  }

  if (holders.length === 1) {
    return {
      label: "versions",
      severity: "ok",
      detail: `cli ${OMPD_VERSION}; nothing else was reachable to compare against`,
    };
  }
  if (byVersion.size === 1) {
    return {
      label: "versions",
      severity: "ok",
      detail: `${holders.map(([who]) => who).join(", ")} all on ${OMPD_VERSION}`,
    };
  }

  return {
    label: "versions",
    severity: "warn",
    detail: [...byVersion].map(([version, who]) => `${who.join(" and ")} ${version}`).join(", "),
    advice: [
      "an upgrade landed in some of them and not the others",
      "run: ompd self-install, then ompd install to restart the login agent",
    ],
  };
}

async function tokenCheck(ctx: CliContext, daemonReachable: boolean): Promise<Check> {
  const token = resolveToken(ctx);
  if (token === null) {
    return {
      label: "token",
      severity: "fail",
      detail: `no token in ${join(ctx.home, "token")} and OMPD_TOKEN is unset`,
      advice: ["run: ompd start (a first start mints the local operator token)"],
    };
  }

  const source = ctx.env.OMPD_TOKEN === undefined ? join(ctx.home, "token") : "OMPD_TOKEN";
  if (!daemonReachable) {
    return { label: "token", severity: "warn", detail: `present at ${source}; no daemon to check it against` };
  }

  let status = 0;
  try {
    const response = await ctx.fetch(`${resolveBaseUrl(ctx)}/v1/status`, {
      headers: { authorization: `Bearer ${token}` },
    });
    status = response.status;
  } catch {
    return { label: "token", severity: "fail", detail: "the daemon stopped answering mid-check" };
  }

  if (status === 200) {
    return { label: "token", severity: "ok", detail: `authenticates against the daemon (${source})` };
  }
  return {
    label: "token",
    severity: "fail",
    detail: `the daemon rejected the token at ${source} (HTTP ${status})`,
    advice: [
      "it was revoked, rotated, or belongs to another daemon",
      "run: ompd rotate, or pair this shell with ompd pair <name>",
    ],
  };
}

/**
 * Is there a login agent, and will it still start anything.
 *
 * The second half is the point. A plist naming a path that has since been
 * deleted loads without complaint and fails at every login with nothing on
 * screen, which is the exact failure this release exists to prevent.
 */
function loginAgentCheck(ctx: CliContext): Check {
  const path = plistPath(ctx);
  if (!existsSync(path)) {
    return {
      label: "login agent",
      severity: "warn",
      detail: "not installed; the daemon will not start at login",
      advice: ["run: ompd install"],
    };
  }

  const contents = readFileSync(path, "utf8");
  if (!contents.includes(`<key>${PLIST_MARKER}</key>`)) {
    return {
      label: "login agent",
      severity: "warn",
      detail: `${path} exists and ompd did not write it`,
      advice: ["ompd will not touch it; move it aside first if it should be ours"],
    };
  }

  const program = plistProgram(contents);
  if (program === null) {
    return {
      label: "login agent",
      severity: "warn",
      detail: `${path} predates the program record`,
      advice: ["run: ompd install (rewrites it)"],
    };
  }
  // An install from before the scheduling class was corrected still carries
  // Background, and the symptom is not subtle: IOPOL_THROTTLE makes every
  // request that touches disk wait behind the rest of the machine, so the
  // daemon reads as hung rather than slow while sitting at 0 percent CPU.
  // Nothing rewrites a plist on its own, so this has to be said out loud.
  if (contents.includes("<string>Background</string>")) {
    return {
      label: "login agent",
      severity: "warn",
      detail: `${path} runs the daemon as a throttled Background job`,
      advice: [
        "disk reads are deprioritised, so listing sessions can look like a hang",
        "run: ompd install (rewrites it as Interactive)",
      ],
    };
  }

  if (!existsSync(program)) {
    return {
      label: "login agent",
      severity: "fail",
      detail: `installed, but it runs ${program}, which no longer exists`,
      advice: ["every login since that path went away has failed silently", "run: ompd self-install && ompd install"],
    };
  }

  return { label: "login agent", severity: "ok", detail: `installed, runs ${program}` };
}

/**
 * The state directory and the credential inside it.
 *
 * `~/.ompd` is created 0700 and the token 0600, but a mode is only worth
 * checking after the fact: an editor, a backup restore, or a `cp -r` can
 * relax either without anyone noticing.
 */
function stateCheck(ctx: CliContext): Check {
  if (!existsSync(ctx.home)) {
    return {
      label: "state dir",
      severity: "warn",
      detail: `${ctx.home} does not exist yet`,
      advice: ["run: ompd start (a first start creates it 0700)"],
    };
  }

  const dirMode = statSync(ctx.home).mode & 0o777;
  const tokenPath = join(ctx.home, "token");
  const tokenMode = existsSync(tokenPath) ? statSync(tokenPath).mode & 0o777 : null;

  const problems: string[] = [];
  if (dirMode !== 0o700) problems.push(`run: chmod 700 ${ctx.home}`);
  if (tokenMode !== null && tokenMode !== 0o600) problems.push(`run: chmod 600 ${tokenPath}`);

  const modes = `${ctx.home} ${dirMode.toString(8).padStart(3, "0")}${
    tokenMode === null ? "" : `, token ${tokenMode.toString(8).padStart(3, "0")}`
  }`;

  if (problems.length > 0) {
    return { label: "state dir", severity: "fail", detail: `${modes} (too permissive)`, advice: problems };
  }
  return { label: "state dir", severity: "ok", detail: modes };
}

/**
 * Which container runtime the provisioner would actually select, what
 * confinement it can express, and which image it would run.
 *
 * Every candidate is reported rather than just the winner, because "docker is
 * installed but you also have Apple's runtime" is exactly the thing an
 * operator needs to see: selection is platform-ordered now, so on a Mac the
 * native runtime wins and the answer to "why is my agent not in the sandbox I
 * thought" is on this line.
 *
 * A runtime that is installed but whose service is down reads differently from
 * one that is absent, and says which command fixes it. That distinction is the
 * reason this is not just a `--version` loop: Apple's runtime answers
 * `--version` perfectly well with its apiserver stopped, and then fails every
 * provision.
 *
 * The pin is read from the daemon's own `config.json`, not from this process's
 * environment. It used to be `ctx.env.OMPD_CONTAINER_RUNTIME`, which is the
 * doctor reporting on its own shell: a launchd-started daemon inherits no
 * shell, so the value this command saw and the value the daemon used were two
 * different things, and this is the one line whose entire job is answering
 * "which runtime is my agent actually on".
 *
 * A pin that cannot be satisfied is a `fail`, not a `warn`, and that is a
 * deliberate split from the unpinned case. No runtime installed is a
 * capability that is absent; a pin naming a runtime that is not usable is
 * broken now, because every container provision will throw rather than fall
 * back, which is the behaviour that was chosen on purpose.
 */
async function runtimeCheck(ctx: CliContext): Promise<Check> {
  const configPath = join(ctx.home, "config.json");
  let pinned: string;
  let image: string;
  try {
    const config = loadConfig(ctx.home);
    pinned = config.containerRuntime;
    image = config.containerImage;
  } catch (err) {
    // `loadConfig` already refuses an unknown runtime naming the valid set and
    // an unusable image saying why, so repeating either check here would be a
    // second copy that can disagree with the daemon's.
    return {
      label: "containers",
      severity: "fail",
      detail: `${configPath} is not loadable: ${err instanceof Error ? err.message : err}`,
      advice: ["fix or delete that file; the daemon refuses to start on it too"],
    };
  }

  const candidates = pinned === "" ? runtimeOrder(process.platform) : [pinned];
  if (candidates.length === 0) {
    return {
      label: "containers",
      severity: "warn",
      detail: `no container runtime is supported on ${process.platform}`,
      advice: ["local hosts still work; container hosts need macOS or Linux"],
    };
  }

  const probes = await Promise.all(candidates.map(runtime => probeRuntime(runtime, ctx.exec, process.platform)));
  const usable = probes.find((probe): probe is RuntimeCapability => !("reason" in probe));
  const unusable = probes.filter((probe): probe is RuntimeUnavailable => "reason" in probe);
  if (usable === undefined) {
    const reasons = unusable.map(probe => `${probe.runtime}: ${probe.reason}`).join(", ");
    if (pinned !== "") {
      return {
        label: "containers",
        severity: "fail",
        detail: `containerRuntime is pinned to ${pinned} and ${reasons}; every container host will fail to provision`,
        advice: [
          ...unusable.map(probe => `${probe.runtime}: ${probe.hint}`),
          `or remove "containerRuntime" from ${configPath} for the platform default, ` +
            `or set it to one of ${KNOWN_RUNTIMES.join(", ")} that is installed`,
        ],
      };
    }
    return {
      label: "containers",
      severity: "warn",
      detail: reasons,
      advice: [
        "local hosts still work; container hosts need one of these",
        ...unusable.map(probe => `${probe.runtime}: ${probe.hint}`),
      ],
    };
  }

  // Named so the line is auditable: an operator can tell at a glance which of
  // the four confinement flags their runtime is actually being asked for, and
  // `docs/running.md` explains why the missing ones differ per runtime rather
  // than all being holes.
  const confinement = [
    usable.capDrop ? "cap-drop" : null,
    usable.securityOpt ? "no-new-privileges" : null,
    usable.readOnly ? "read-only" : null,
    usable.pidsLimit ? "pids-limit" : null,
  ].filter((flag): flag is string => flag !== null);
  const others = probes
    .filter(probe => probe.runtime !== usable.runtime)
    .map(probe => ("reason" in probe ? `${probe.runtime} ${probe.reason}` : probe.runtime));
  const also = others.length > 0 ? ` (also present: ${others.join(", ")})` : "";
  const how = pinned === "" ? "platform default" : "pinned in config.json";
  return {
    label: "containers",
    severity: "ok",
    detail:
      `${usable.runtime} ${usable.version} (${how}), confines with ` +
      `${confinement.length > 0 ? confinement.join(" ") : "its own VM per container"}${also}, ` +
      `${imageLine(image)}`,
    // Advice on an ok line, because a trusted image is not a problem to fix,
    // it is a claim the operator made that they should be able to read back.
    ...(image === ""
      ? {}
      : {
          advice: [
            "ompd mounts nothing over that image and pins no digest for it, and its ENTRYPOINT runs " +
              "before ompd has a process to gate, so the approval gate cannot confine what is inside it",
          ],
        }),
  };
}

/**
 * How the image half of the containers line reads.
 *
 * Split out so the two cases are visibly different sentences rather than one
 * sentence with a value substituted into it: "the pinned default" and "an
 * image an operator vouched for" are different security claims, and a reader
 * skimming this line has to be able to tell which one they are looking at.
 */
function imageLine(image: string): string {
  if (image === "") return "image: ompd's pinned default base plus its mounted toolchain";
  return `image: ${image}, trusted by whoever configured it and checked by nothing ompd does`;
}

/**
 * Whether a turn started from a phone will survive the Mac going idle.
 *
 * Read from the config on disk rather than asked of the daemon: the answer is
 * still useful when the daemon is down, which is when someone is most likely
 * to be running this.
 */
function awakeCheck(ctx: CliContext): Check {
  let keepAwake: boolean;
  try {
    keepAwake = loadConfig(ctx.home).keepAwake;
  } catch (err) {
    return {
      label: "stay awake",
      severity: "fail",
      detail: `${join(ctx.home, "config.json")} is not loadable: ${err instanceof Error ? err.message : err}`,
      advice: ["fix or delete that file; every default is the conservative one"],
    };
  }

  if (!keepAwake) {
    return {
      label: "stay awake",
      severity: "warn",
      detail: "keepAwake is off; idle sleep can kill a turn that is still running",
      advice: [`set "keepAwake": true in ${join(ctx.home, "config.json")} to hold work awake`],
    };
  }
  return {
    label: "stay awake",
    severity: "ok",
    detail: "the daemon holds an idle-sleep assertion while an agent is working",
  };
}
