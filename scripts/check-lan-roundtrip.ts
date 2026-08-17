/**
 * Prove the whole remote-control path over a real LAN address: a device pairs,
 * gets approved, attaches to an agent, prompts it, and the turn ends.
 *
 * Loopback would prove almost nothing here. The interesting failures are the
 * ones that only appear once the daemon is bound to a routable address and the
 * caller is a *paired device* rather than the local operator, so this binds to
 * the host's LAN IPv4 and drives the flow with the device token that `approve`
 * mints once.
 *
 * The negative half runs in the same process against the same live daemon,
 * because a refusal only means something if an accept was possible a moment
 * earlier. Order matters: the real token is proven to return 200 BEFORE the
 * device is revoked, so the 401 afterwards cannot be a blanket deny, a wrong
 * URL, or a daemon that died. A check that only ever sees refusals passes just
 * as happily against a crashed process.
 *
 * Tokens are read from disk and passed through env; none is ever printed.
 *
 * Usage: bun run scripts/check-lan-roundtrip.ts [--keep]
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const PORT = 47990;

/**
 * The one address worth binding to: a routable IPv4 on a real interface.
 * `0.0.0.0` would also be LAN-reachable but would let a loopback-only
 * regression pass, since every request could still be served on 127.0.0.1.
 */
function lanAddress(): string {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) {
        console.log(`  lan interface ${name} -> ${a.address}`);
        return a.address;
      }
    }
  }
  throw new Error("no non-internal IPv4 interface; this check needs a real network");
}

/** The CLI under test: the shipped binary when built, else the source entry. */
function cli(): string[] {
  const built = join(repo, "dist", "ompd");
  return existsSync(built) ? [built] : ["bun", join(repo, "packages", "cli", "src", "main.ts")];
}

function run(args: string[], env: Record<string, string>): { out: string; code: number } {
  const [cmd, ...pre] = cli();
  const r = spawnSync(cmd, [...pre, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? 1 };
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

/** An HTTP status is the whole assertion, so read it and nothing else. */
async function status(path: string, token: string, init: RequestInit = {}): Promise<number> {
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
    });
    return res.status;
  } catch {
    return 0; // unreachable is a failure, never a pass
  }
}

const host = lanAddress();
const base = `http://${host}:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "ompd-lan-rt-"));
const cwd = mkdtempSync(join(tmpdir(), "ompd-lan-cwd-"));

const [cmd, ...pre] = cli();
const daemon = spawn(cmd, [...pre, "start", "--host", host, "--port", String(PORT), "--foreground"], {
  env: { ...process.env, OMPD_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});

/** Readiness is the daemon saying it listens, not the process existing. */
const ready = await new Promise<boolean>(resolve => {
  const deadline = setTimeout(() => resolve(false), 90_000);
  const watch = (chunk: Buffer): void => {
    if (chunk.toString().includes("ompd is listening at")) {
      clearTimeout(deadline);
      resolve(true);
    }
  };
  daemon.stdout.on("data", watch);
  daemon.stderr.on("data", watch);
  daemon.on("exit", () => {
    clearTimeout(deadline);
    resolve(false);
  });
});

try {
  console.log(`\nbound at ${base}`);
  check("daemon reached readiness on the LAN address", ready);
  if (!ready) throw new Error("daemon never listened");

  const operator = readFileSync(join(home, "token"), "utf8").trim();
  const opEnv = { OMPD_HOME: home, OMPD_URL: base, OMPD_TOKEN: operator };

  // --- pair, as a phone would -------------------------------------------
  const paired = run(["pair", "lan-roundtrip", "--scopes", "read,prompt"], opEnv);
  const code = paired.out.match(/\b(\d{6})\b/)?.[1] ?? "";
  check("pair issued a one-time code", code.length === 6);

  const approved = run(["approve", code, "--scopes", "read,prompt"], opEnv);
  // `approve` prints two secret-shaped strings: the bearer token on its own
  // line, and a much longer `ompd-pair-v1:` blob that packs the endpoint and
  // token together for the app's manual-pairing field. Only the first is a
  // credential. Matching the blob first yielded a 251-char "token" that every
  // request rejected, so the standalone line wins and the length is bounded.
  const device =
    approved.out
      .split("\n")
      .map(l => l.trim())
      .find(l => /^[A-Za-z0-9_-]{32,120}$/.test(l) && !l.startsWith("ompd-pair-v1:")) ?? "";
  check("approve minted a device token", device.length >= 32 && device.length <= 120, `${device.length} chars`);
  if (!device) throw new Error("no device token; the rest cannot be proven");

  // --- the agent the device will drive ----------------------------------
  const made = run(["new", cwd, "--name", "lan-rt"], opEnv);
  const agent = made.out.match(/\b(agt_[0-9a-f]+)\b/)?.[1] ?? "";
  check("operator created an agent", agent.length > 4, agent);
  if (!agent) throw new Error("no agent id");

  // --- the accept case, which must come first ---------------------------
  const devEnv = { OMPD_URL: base, OMPD_TOKEN: device };
  check("paired device can read over LAN", (await status("/v1/agents", device)) === 200);

  const turn = run(["prompt", agent, "Reply with exactly the single word: LANPONG"], devEnv);
  check(
    "paired device prompt ended the turn over LAN",
    turn.code === 0 && /end_turn/.test(turn.out),
    `exit=${turn.code}`,
  );

  // --- refusals, now that an accept is on the record --------------------
  check("never-paired token refused", (await status("/v1/agents", "not-a-real-token-0000000000")) === 401);
  check("empty credential refused", (await status("/v1/agents", "")) === 401);

  const deviceId =
    run(["devices"], opEnv)
      .out.split("\n")
      .find(l => l.includes("lan-roundtrip"))
      ?.match(/\b(dev_[0-9a-f]+)\b/)?.[1] ?? "";
  check("found the paired device to revoke", deviceId.length > 4, deviceId);

  if (deviceId) {
    run(["revoke", deviceId], opEnv);
    // The same credential that just returned 200. If this still passes, the
    // daemon is trusting a withdrawn device.
    check("revoked token refused on the read path", (await status("/v1/agents", device)) === 401);
    check(
      "revoked token refused on the prompt path",
      (await status(`/v1/agents/${agent}/prompt`, device, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "must never run" }),
      })) === 401,
    );
  }
} finally {
  daemon.kill("SIGTERM");
  if (!keep) {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  } else {
    console.log(`\nkept ${home} and ${cwd}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(
  "\nLAN round-trip proven: pair -> approve -> attach -> prompt -> end_turn, and withdrawn credentials refused.",
);
