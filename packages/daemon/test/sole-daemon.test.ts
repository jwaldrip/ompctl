/**
 * The pre-start refusal that keeps one home to one daemon.
 *
 * The incident this file pins down: a daemon hand-started beside the
 * LaunchAgent's, on the same home and a different port, loaded the same
 * identity and dialed the same hub, and the two evicted each other with
 * close code 4409 until both were stopped. A paired phone watched a daemon
 * that was forever one reconnect from gone, which read as "no sessions".
 *
 * So the refusal has to fire on the witness that incident actually left,
 * the endpoint the live daemon published, because the port the second start
 * wanted was free. And it has to stay quiet in the cases that are not that
 * incident: a different home's daemon on the port, and nothing listening at
 * all, which is what every temp-home test daemon and e2e script starts
 * under. The last test drives the real composition root, because the guard
 * only matters if `Ompd.start` itself cannot bypass it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpointPath, Ompd } from "../src/daemon.ts";
import { homeIdFor } from "../src/home-id.ts";
import { assertSoleDaemon, SoleDaemonError, type SoleDaemonOptions } from "../src/tunnel/sole-daemon.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const running: Ompd[] = [];
/**
 * Health stubs stood up per test, torn down by the shared afterEach below.
 * Typed by the one member teardown uses: `Bun.Server` is generic over its
 * websocket data and these stubs never upgrade, so naming the shape keeps the
 * declaration honest without threading a type argument that means nothing here.
 */
const servers: { stop: (closeActiveConnections?: boolean) => void }[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** A healthy daemon for `homeId`, serving `/v1/health` on its own loopback port. */
function healthyDaemon(homeId: string): { base: string; port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request =>
      new URL(request.url).pathname === "/v1/health"
        ? Response.json({ ok: true, version: "0.1.0", homeId })
        : new Response("", { status: 404 }),
  });
  servers.push(server);
  // Bun types the port as optional because a unix-socket server has none. This
  // one always asks for a TCP port, so an absent port is a broken assumption
  // rather than a case to paper over with a fallback.
  const { port } = server;
  if (port === undefined) throw new Error("Bun.serve reported no port for the health stub");
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    stop: () => server.stop(true),
  };
}

/** A port nothing is listening on, which is all the guard needs of it. */
function freePort(): number {
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const { port } = holder;
  holder.stop(true);
  if (port === undefined) throw new Error("Bun.serve reported no port for the free-port probe");
  return port;
}

/** Run the guard and bring back its error rather than a jest-style matcher dance. */
async function refusalOf(opts: SoleDaemonOptions): Promise<SoleDaemonError | null> {
  try {
    await assertSoleDaemon(opts);
    return null;
  } catch (error) {
    if (!(error instanceof SoleDaemonError)) throw error;
    return error;
  }
}
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const daemon of running.splice(0)) await daemon.stop();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("assertSoleDaemon", () => {
  test("refuses when the configured port is held by a healthy daemon for this home", async () => {
    const home = tempDir("ompd-sole-");
    const live = healthyDaemon(homeIdFor(home));

    const refusal = await refusalOf({ home, host: "127.0.0.1", port: live.port });
    expect(refusal?.refusal).toBe("already-running");
    expect(refusal?.message).toContain(`already running at ${live.base}`);
    // Ownership and the way to stop it have to be in the text, or a human
    // reads "already running", starts one anyway, and rebuilds the loop.
    expect(refusal?.message).toContain("the LaunchAgent ai.ompctl already owns this daemon");
    expect(refusal?.message).toContain("launchctl bootout gui/$(id -u)/ai.ompctl");
  });

  test("a different home on the port is a port conflict, not an ownership refusal", async () => {
    const home = tempDir("ompd-sole-");
    const other = healthyDaemon(homeIdFor(tempDir("ompd-sole-other-")));

    const refusal = await refusalOf({ home, host: "127.0.0.1", port: other.port });
    expect(refusal?.refusal).toBe("port-conflict");
    expect(refusal?.message).toContain(`${other.base} is busy`);
    // The LaunchAgent owns nothing here; telling this operator to boot out a
    // daemon that is not theirs would be actively wrong advice.
    expect(refusal?.message).not.toContain("ai.ompctl");
  });

  test("nothing listening anywhere leaves the start free", async () => {
    const home = tempDir("ompd-sole-");
    await expect(assertSoleDaemon({ home, host: "127.0.0.1", port: freePort() })).resolves.toBeUndefined();
  });

  test("a published endpoint refuses a same-home daemon on a different port", async () => {
    const home = tempDir("ompd-sole-");
    // The shape of the incident: the live daemon served on its own port and
    // published it, and the second start wanted a port that was free.
    const live = healthyDaemon(homeIdFor(home));
    writeFileSync(endpointPath(home), `${live.base}\n`);

    const refusal = await refusalOf({ home, host: "127.0.0.1", port: freePort() });
    expect(refusal?.refusal).toBe("already-running");
    expect(refusal?.message).toContain(`already running at ${live.base}`);
  });

  test("a published endpoint nobody answers any more does not block the start", async () => {
    const home = tempDir("ompd-sole-");
    // A daemon that was killed leaves its record behind; the next start, the
    // LaunchAgent's included, has to be able to take the home back.
    const dead = healthyDaemon(homeIdFor(home));
    dead.stop();
    writeFileSync(endpointPath(home), `${dead.base}\n`);

    await expect(assertSoleDaemon({ home, host: "127.0.0.1", port: freePort() })).resolves.toBeUndefined();
  });
});

describe("Ompd.start beside a live daemon on the same home", () => {
  test("a second daemon does not start, whatever port it asks for", async () => {
    const home = tempDir("ompd-sole-");
    const first = new Ompd({
      home,
      overrides: { port: 0 },
      spawnHost: createFakeHost().factory,
      voice: false,
    });
    running.push(first);
    const info = await first.start();

    const second = new Ompd({
      home,
      // Port 0 again, so the configured address cannot be the witness: only
      // the endpoint the live daemon published connects the two starts.
      overrides: { port: 0 },
      spawnHost: createFakeHost().factory,
      voice: false,
    });
    running.push(second);

    const refusal = await second.start().then(
      () => null,
      (error: unknown) => {
        if (!(error instanceof SoleDaemonError)) throw error;
        return error;
      },
    );
    expect(refusal?.refusal).toBe("already-running");
    expect(refusal?.message).toContain(`already running at ${info.url}`);
    expect(refusal?.message).toContain("launchctl bootout gui/$(id -u)/ai.ompctl");

    // The refusal left the live daemon's record alone; overwriting it would
    // strand every later command that finds the daemon through this file.
    expect(readFileSync(endpointPath(home), "utf8").trim()).toBe(info.url);
  });
});
