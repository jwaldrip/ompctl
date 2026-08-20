/**
 * The association files are load-bearing and easy to break silently.
 *
 * `app.ompctl.ai` serves `/.well-known/apple-app-site-association` and
 * `/.well-known/assetlinks.json`. If either stops being served, or starts being
 * served malformed, iOS Universal Links and Android App Links stop opening the
 * app and nothing else fails: no crash, no error, no failing build. The only
 * symptom is a link that opens a browser instead of the app, which nobody notices
 * until a tester reports it.
 *
 * These tests pin the contract. The server is spawned as a subprocess rather than
 * imported, because it calls `Bun.serve` at module scope and `process.exit(2)` on
 * bad configuration; importing it would either bind a port for the whole test run
 * or kill the runner.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const serverPath = join(import.meta.dir, "..", "deploy", "server.ts");

const TEAM = "8H7HVPHS87";
// Structurally valid and obviously not real: 32 colon-separated octets. The
// server only validates shape, and a test must not carry a genuine fingerprint.
const SHA = Array.from({ length: 32 }, () => "AB").join(":");

interface Started {
  base: string;
  stop(): void;
}

const running: Started[] = [];
afterAll(() => {
  for (const s of running) s.stop();
});

/**
 * Boot the server and wait for the signal it already emits.
 *
 * The server logs one readiness line once `Bun.serve` is bound, so this awaits
 * that line rather than polling on a timer. A fixed sleep would guess at the
 * race and pay the guess on every CI run; the log is the actual event.
 *
 * The port is chosen by the OS, not guessed: a random high port collided on CI
 * (`Failed to start server. Is port 45300 in use?`) because two runs picked the
 * same number, and a wider random range only makes that rarer. PORT=0 asks for
 * any free port and the server reports the one it bound, so there is no number
 * left to collide over. Readiness is still confirmed from our own process's
 * output, so a stranger on a port cannot satisfy it.
 */
async function start(env: Record<string, string>): Promise<Started> {
  const proc = Bun.spawn(["bun", serverPath], {
    env: { ...process.env, PORT: "0", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const decoder = new TextDecoder();
  let seen = "";
  // One reader for the stream's lifetime; racing individual reads would orphan
  // the losing call and drop chunks.
  for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
    seen += decoder.decode(chunk, { stream: true });
    // The readiness line carries the bound port, which is the only place this
    // process can learn it once the OS has done the choosing.
    const port = /"message":"ompctl web listening","port":(\d+)/.exec(seen)?.[1];
    if (port !== undefined) {
      const started: Started = { base: `http://127.0.0.1:${port}`, stop: () => proc.kill() };
      running.push(started);
      return started;
    }
  }

  proc.kill();
  const err = await new Response(proc.stderr).text();
  throw new Error(`server never reported listening. stdout: ${seen.slice(0, 200)} stderr: ${err.slice(0, 200)}`);
}

describe("association files", () => {
  test("apple-app-site-association is served and claims the universal bundle once", async () => {
    const { base } = await start({ OMPCTL_APPLE_TEAM_ID: TEAM, OMPCTL_PLAY_CERT_SHA256: SHA });
    const res = await fetch(`${base}/.well-known/apple-app-site-association`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      applinks: { apps: unknown[]; details: Array<{ appIDs: string[]; components?: unknown[]; paths?: string[] }> };
      webcredentials?: { apps: string[] };
    };

    // `apps` must be present and empty; Apple treats a missing key as malformed.
    expect(body.applinks.apps).toEqual([]);

    const ids = body.applinks.details.flatMap(d => d.appIDs);
    expect(ids).toContain(`${TEAM}.ai.ompctl.app`);
    // iOS and macOS now ship under one universal bundle id, so the same appID
    // must appear exactly once rather than twice. Asserted because the naive
    // construction from two variables produced a duplicate, and a malformed
    // association fails silently instead of erroring.
    expect(ids.filter(i => i === `${TEAM}.ai.ompctl.app`)).toHaveLength(1);
    expect(new Set(ids).size).toBe(ids.length);

    // Both the modern and legacy shapes, so older iOS still matches.
    const detail = body.applinks.details[0];
    expect(detail?.components?.length ?? 0).toBeGreaterThan(0);
    expect(detail?.paths?.length ?? 0).toBeGreaterThan(0);

    // Password autofill shares the same identifiers.
    expect(body.webcredentials?.apps ?? []).toContain(`${TEAM}.ai.ompctl.app`);
  });

  test("assetlinks.json delegates the domain to the Android package", async () => {
    const { base } = await start({ OMPCTL_APPLE_TEAM_ID: TEAM, OMPCTL_PLAY_CERT_SHA256: SHA });
    const res = await fetch(`${base}/.well-known/assetlinks.json`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Array<{
      relation: string[];
      target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
    }>;

    expect(body.length).toBeGreaterThan(0);
    const entry = body[0];
    expect(entry?.relation).toContain("delegate_permission/common.handle_all_urls");
    expect(entry?.target.namespace).toBe("android_app");
    expect(entry?.target.package_name).toBe("ai.ompctl.app");
    // The configured fingerprint must actually reach the document, not a default.
    expect(entry?.target.sha256_cert_fingerprints).toContain(SHA);
  });

  test("an unknown well-known path is not invented", async () => {
    const { base } = await start({ OMPCTL_APPLE_TEAM_ID: TEAM, OMPCTL_PLAY_CERT_SHA256: SHA });
    const res = await fetch(`${base}/.well-known/not-a-real-association`);
    expect(res.status).toBe(404);
  });
});

describe("configuration is refused rather than half-applied", () => {
  /**
   * Each of these exits 2 instead of serving a placeholder. That is the right
   * behaviour and worth pinning: an association file containing an empty team id
   * or a bogus fingerprint looks configured while failing every device check,
   * which is strictly worse than not serving one. It also explains a deploy
   * symptom that is otherwise baffling, since a Cloud Run revision missing this
   * configuration crash-loops rather than reporting a config error.
   */
  const cases: Array<[string, Record<string, string>]> = [
    ["no team id", { OMPCTL_PLAY_CERT_SHA256: SHA }],
    ["no play fingerprint", { OMPCTL_APPLE_TEAM_ID: TEAM }],
    ["malformed team id", { OMPCTL_APPLE_TEAM_ID: "nope", OMPCTL_PLAY_CERT_SHA256: SHA }],
    ["malformed fingerprint", { OMPCTL_APPLE_TEAM_ID: TEAM, OMPCTL_PLAY_CERT_SHA256: "AB:CD" }],
  ];

  for (const [label, env] of cases) {
    test(`refuses to start with ${label}`, async () => {
      const proc = Bun.spawn(["bun", serverPath], {
        // A port it must never get far enough to bind.
        env: { ...process.env, PORT: "45999", OMPCTL_APPLE_TEAM_ID: "", OMPCTL_PLAY_CERT_SHA256: "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      expect(code).toBe(2);
      const err = await new Response(proc.stderr).text();
      expect(err).toContain("ERROR");
    });
  }
});
