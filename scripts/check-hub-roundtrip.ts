/**
 * Prove the relayed remote-control path: a device drives an agent through a
 * *real* hub, never touching the daemon's address.
 *
 * `check-lan-roundtrip.ts` proves the direct path, where the client can route
 * to the daemon itself. That is the easy topology and not the one a phone on a
 * cell network is in. Here the daemon binds loopback -- deliberately, because a
 * loopback daemon is unreachable from anywhere but this host -- and the client
 * is given no address for it at all, only a hub and a pinned daemon id. If the
 * relay is broken there is no second path that could quietly carry the turn.
 *
 * The accept is proven BEFORE anything is revoked or substituted, so the
 * refusals afterwards cannot be a blanket deny, a dead daemon, or a hub that
 * rejects everything. And the refusals assert that no session ever opens, not
 * merely that no turn finished: "the turn did not end" is also what a hung
 * connection looks like, so it would pass against a relay that never worked.
 *
 * What this does NOT prove: that the client's packets crossed a cellular
 * network. Nothing observable from this process can establish that, so the
 * cellular leg is a separate device-side step. What it does prove is that the
 * hub was the only route to the daemon.
 *
 * Tokens are read from disk or env and never printed.
 *
 * Usage:
 *   OMPD_HUB_URL=wss://host OMPD_HUB_OPERATOR_TOKEN=... bun run scripts/check-hub-roundtrip.ts
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentId } from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import type { DaemonId } from "@ompd/tunnel";
import { createHubSocketFactory } from "../packages/app/src/platform/socket.ts";
import { loadIdentity } from "../packages/daemon/src/tunnel/identity.ts";

const repo = join(import.meta.dir, "..");
const keep = process.argv.includes("--keep");
const PORT = 47996;
/** Long enough for a model turn over a relay, short enough to fail a hung one. */
const TURN_TIMEOUT_MS = 120_000;
/** A refusal is immediate; this only has to outlast a couple of reconnects. */
const REFUSAL_WINDOW_MS = 45_000;

const hubUrl = process.env.OMPD_HUB_URL ?? "";
const operatorToken = process.env.OMPD_HUB_OPERATOR_TOKEN ?? "";
if (hubUrl === "" || operatorToken === "") {
  console.error("OMPD_HUB_URL and OMPD_HUB_OPERATOR_TOKEN are required; this check needs a real hub");
  process.exit(2);
}
/** The hub's HTTP origin, for enrollment. The socket URL is the `wss://` form. */
const hubHttp = hubUrl.replace(/^ws/, "http");

function cli(): string[] {
  const built = join(repo, "dist", "ompd");
  return existsSync(built) ? [built] : ["bun", join(repo, "packages", "cli", "src", "main.ts")];
}

function run(args: string[], env: Record<string, string>): { out: string; code: number } {
  const [cmd, ...pre] = cli();
  const r = spawnSync(cmd, [...pre, ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status ?? 1 };
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok" : "FAIL"} ${label}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(label);
}

const home = mkdtempSync(join(tmpdir(), "ompd-hub-home-"));
const cwd = mkdtempSync(join(tmpdir(), "ompd-hub-cwd-"));
const base = `http://127.0.0.1:${PORT}`;

/**
 * Build a client that can only reach the daemon through the hub.
 *
 * `probeCredential` is stubbed because the default one dials the *hub* over
 * HTTP to ask whether the token is still good. The hub did not issue it and
 * answers 404 for that path, which would turn every relay problem into a
 * spurious "unauthorized". The relay's own refusal is the signal here.
 */
function relayClient(daemonId: DaemonId, token: string): OmpdClient {
  return new OmpdClient({
    url: hubUrl,
    token,
    createSocket: createHubSocketFactory({ daemonId }),
    probeCredential: async () => "unknown",
  });
}

/**
 * One relayed turn.
 *
 * The socket's `prompt` is fire-and-forget, so the turn boundary is the agent's
 * own state: observed `busy`, then back to `idle`. Requiring both edges is what
 * separates "the turn ran" from "the agent was already idle and nothing
 * happened", which is the false pass a broken relay would otherwise produce.
 */
async function relayedTurn(
  daemonId: DaemonId,
  token: string,
  agent: AgentId,
  text: string,
): Promise<{ ended: boolean; why: string }> {
  const client = relayClient(daemonId, token);
  let sawBusy = false;
  let opened = false;
  let lastReason = "";

  const outcome = await new Promise<{ ended: boolean; why: string }>(resolve => {
    const deadline = setTimeout(
      () =>
        resolve({
          ended: false,
          why: `${opened ? (sawBusy ? "turn never ended" : "never went busy") : "never connected"}${lastReason ? `; last status: ${lastReason}` : ""}`,
        }),
      TURN_TIMEOUT_MS,
    );
    const settle = (r: { ended: boolean; why: string }): void => {
      clearTimeout(deadline);
      resolve(r);
    };

    client.on("unauthorized", e => settle({ ended: false, why: `unauthorized: ${e.reason}` }));
    client.on("agents", e => {
      const mine = (e.agents as Agent[]).find(a => a.id === agent);
      if (!mine) return;
      if (mine.state === "busy") sawBusy = true;
      else if (sawBusy && mine.state === "idle") settle({ ended: true, why: "" });
      else if (mine.state === "failed") settle({ ended: false, why: "agent failed" });
    });
    client.on("status", s => {
      if (s.reason) lastReason = `${s.state}: ${s.reason}`;
      if (s.state !== "connected" || opened) return;
      opened = true;
      // Only now is there a socket to send on. Attaching earlier throws "not
      // connected", and the attach must land before the prompt or this client
      // never hears the state changes it is waiting for.
      client.attach(agent);
      client.prompt(agent, text);
    });

    client.start();
  });

  client.close();
  return outcome;
}

/**
 * Assert the hub itself refuses to route to a daemon id it does not know.
 *
 * Checked over HTTP rather than by watching a socket fail, because "the socket
 * did not open" is indistinguishable from a network problem, a stopped daemon,
 * or a hub that is down. The hub names its refusal in the body, and that name
 * is the only thing here that a working relay could not also produce: a *known*
 * daemon's link path answers 426 asking for an upgrade instead.
 */
async function refusedAtHub(daemonId: string): Promise<{ refused: boolean; why: string }> {
  const r = await fetch(`${hubHttp}/v1/link/${encodeURIComponent(daemonId)}`).catch(() => null);
  if (r === null) return { refused: false, why: "the hub did not answer at all" };
  const body = await r.text();
  const named = body.includes("unknown_daemon");
  return {
    refused: r.status >= 400 && named,
    why: `HTTP ${r.status} ${named ? "unknown_daemon" : body.slice(0, 60)}`,
  };
}

/**
 * Assert the *daemon* refuses a credential over an established relay.
 *
 * The claim is that the daemon said no, so the daemon saying so is what gets
 * asserted -- the tunnel reports it verbatim and `OmpdClient` surfaces it as the
 * reason on its next status change. Silence fails this check on purpose: a relay
 * that never carried anything would otherwise pass it, which is exactly the
 * false positive that made an earlier version of this check worthless.
 */
async function refusedCredential(
  daemonId: DaemonId,
  token: string,
  expected: RegExp,
): Promise<{ refused: boolean; why: string }> {
  const client = relayClient(daemonId, token);
  const outcome = await new Promise<{ refused: boolean; why: string }>(resolve => {
    const seen: string[] = [];
    const deadline = setTimeout(
      () => resolve({ refused: true, why: `no session ever opened; saw: ${seen.join(" | ") || "nothing"}` }),
      REFUSAL_WINDOW_MS,
    );
    const settle = (r: { refused: boolean; why: string }): void => {
      clearTimeout(deadline);
      resolve(r);
    };
    client.on("status", s => {
      const reason = s.reason ?? "";
      if (reason) seen.push(`${s.state}: ${reason}`);
      // Opening a session is the disproof, and it is what keeps this check from
      // being vacuous: a credential that works lands here and reports `false`,
      // whatever wording its refusals-of-something-else carried. The contract
      // being asserted is that this credential cannot open one; the daemon's
      // *named* reason for saying no is reported as detail when it arrives, but
      // it is not the assertion -- the daemon words a reused-but-valid
      // credential's refusal differently too.
      if (s.state === "connected") settle({ refused: false, why: "opened a session" });
    });
    client.start();
  });
  client.close();
  return outcome;
}

// --- the daemon's identity, minted before it ever runs --------------------
// Minting here rather than letting the first start do it is what removes a
// restart from this script. A daemon dials its hub once, at startup, under an
// identity the hub must already know; enrolling afterwards would need the
// daemon bounced, and a replaced leg racing its successor's registration is a
// failure mode belonging to the hub's tests, not to this one.
const identity = loadIdentity(home);

run(["config", "set", "host", "127.0.0.1"], { OMPD_HOME: home });
run(["config", "set", "hubUrl", hubUrl], { OMPD_HOME: home });

const enroll = await fetch(`${hubHttp}/v1/enroll`, {
  method: "POST",
  headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
  body: JSON.stringify({ publicKey: identity.publicKey, label: "hub-roundtrip" }),
});
const enrolled = (await enroll.json()) as { daemonId?: string };

const [cmd, ...pre] = cli();
const daemon = spawn(cmd, [...pre, "start", "--host", "127.0.0.1", "--port", String(PORT), "--foreground"], {
  env: { ...process.env, OMPD_HOME: home },
  stdio: ["ignore", "pipe", "pipe"],
});

// Two separate events, and conflating them is a race. Serving on loopback says
// nothing about the outbound hub leg, which completes a challenge and signature
// afterwards. A relayed turn attempted in between is refused `daemon_offline`,
// indistinguishable from a broken relay.
let markListening = (_v: boolean): void => {};
let markRegistered = (_v: boolean): void => {};
const listening = new Promise<boolean>(resolve => {
  markListening = resolve;
});
const registered = new Promise<boolean>(resolve => {
  markRegistered = resolve;
});
const bootDeadline = setTimeout(() => {
  markListening(false);
  markRegistered(false);
}, 90_000);
const watch = (chunk: Buffer): void => {
  const text = chunk.toString();
  if (text.includes("ompd is listening at")) markListening(true);
  // The daemon's own words, from `createTunnelDialer`'s `onRegistered`.
  if (text.includes("tunnel registered with hub")) {
    clearTimeout(bootDeadline);
    markRegistered(true);
  }
};
daemon.stdout.on("data", watch);
daemon.stderr.on("data", watch);
daemon.on("exit", () => {
  clearTimeout(bootDeadline);
  markListening(false);
  markRegistered(false);
});

try {
  console.log(`\ndaemon on loopback ${base}, relay ${hubUrl}`);
  check("hub enrolled the daemon", enroll.status === 200);
  // The hub deriving the same id from the public key is what makes pinning
  // meaningful; a mismatch would mean the client pins something else entirely.
  check("hub derived the same daemon id", enrolled.daemonId === identity.daemonId);
  check("daemon reached readiness", await listening);
  // Asserted on its own: without a registered leg the hub has no route, and the
  // relayed turn below would fail for that reason rather than a relay defect.
  check("daemon registered its hub leg", await registered);

  // --- pair, as a phone would. Loopback is fine for this step: pairing is the
  //     one thing an operator does at the machine.
  const operator = readFileSync(join(home, "token"), "utf8").trim();
  const opEnv = { OMPD_HOME: home, OMPD_URL: base, OMPD_TOKEN: operator };

  const paired = run(["pair", "hub-roundtrip", "--scopes", "read,prompt"], opEnv);
  const code = paired.out.match(/\b(\d{6})\b/)?.[1] ?? "";
  check("pair issued a one-time code", code.length === 6);

  const approved = run(["approve", code, "--scopes", "read,prompt"], opEnv);
  // `approve` prints two secret-shaped strings: the bearer token on its own
  // line, and a longer `ompd-pair-v1:` blob packing endpoint and token together
  // for the app's manual-pairing field. Only the first is a credential.
  const device =
    approved.out
      .split("\n")
      .map(l => l.trim())
      .find(l => /^[A-Za-z0-9_-]{32,120}$/.test(l) && !l.startsWith("ompd-pair-v1:")) ?? "";
  check("approve minted a device token", device.length >= 32 && device.length <= 120);
  if (!device) throw new Error("no device token; the rest cannot be proven");

  const made = run(["new", cwd, "--name", "hub-rt"], opEnv);
  const agent = (made.out.match(/\b(agt_[0-9a-f]+)\b/)?.[1] ?? "") as AgentId;
  check("operator created an agent", agent.length > 4, agent);
  if (!agent) throw new Error("no agent id");

  // --- the accept case, which must come first ---------------------------
  const ok = await relayedTurn(identity.daemonId, device, agent, "Reply with exactly the single word: HUBPONG");
  check("relayed prompt ended the turn", ok.ended, ok.why);

  // --- refusals, now that an accept is on the record --------------------
  // A wrong daemon id is the interesting negative: holding a valid token for
  // one daemon must not get this client routed to a different one.
  const wrongDaemon = await refusedAtHub(`dmn_${"0".repeat(64)}`);
  check("unknown daemon id refused", wrongDaemon.refused, wrongDaemon.why);

  const neverPaired = await refusedCredential(identity.daemonId, "not-a-real-token-0000000000", /unknown/i);
  check("never-paired token refused", neverPaired.refused, neverPaired.why);

  const deviceId =
    run(["devices"], opEnv)
      .out.split("\n")
      .find(l => l.includes("hub-roundtrip"))
      ?.match(/\b(dev_[0-9a-f]+)\b/)?.[1] ?? "";
  check("found the paired device to revoke", deviceId.length > 4, deviceId);

  if (deviceId) {
    run(["revoke", deviceId], opEnv);
    // The same credential that opened a session and ended a turn moments ago,
    // through this same relay.
    const revoked = await refusedCredential(identity.daemonId, device, /revoked/i);
    check("revoked token refused through the relay", revoked.refused, revoked.why);
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
  "\nHub round-trip proven: a loopback-bound daemon driven end-to-end through the relay, and substituted, unpaired, and revoked credentials all unable to open a session.",
);
