/**
 * Refusing to be the second daemon on a home.
 *
 * A second `ompd` on one state directory is not redundant, it is destructive.
 * Both processes load the same identity file, present the same daemon id to
 * the hub, and the hub treats a repeated id as a replacement: every
 * registration closes the other's tunnel with 4409, so the two daemons evict
 * each other forever. A paired phone watches a daemon that is always one
 * reconnect from gone, which reads as "no sessions", and the log fills with
 * `tunnel closed (4409 replaced by a newer connection)`. The two processes
 * also write one SQLite store behind the daemon's back.
 *
 * So a start proves it is the only daemon for its home before it binds or
 * dials anything. Two addresses can establish that without a race: the
 * endpoint this home published while serving, which catches a same-home
 * daemon on any port, and the host and port this start is configured to
 * bind. `/v1/health` is unauthenticated and answers with the home's id, so
 * the comparison needs no token and holds no lock.
 *
 * The door this guards is `--foreground`, which is how launchd runs the real
 * daemon and how a hand start bypasses every check the backgrounded CLI
 * makes. A start that passes quietly here stays free: a fresh home and a
 * free port, which is what every e2e script and test daemon uses.
 */

import { existsSync, readFileSync } from "node:fs";
import { endpointPath } from "../endpoint.ts";
import { homeIdFor } from "../home-id.ts";

/** A healthy daemon on loopback answers long inside this; nothing else should hold the start hostage to a hung port. */
const PROBE_TIMEOUT_MS = 1_000;

export type SoleDaemonRefusal = "already-running" | "port-conflict";

export class SoleDaemonError extends Error {
  constructor(
    message: string,
    readonly refusal: SoleDaemonRefusal,
  ) {
    super(message);
    this.name = "SoleDaemonError";
  }
}

/**
 * What a start beside a daemon that is already serving this home must say.
 *
 * The message is the fix as much as the refusal is: the incident happened
 * because a human ran `ompd start` by hand beside a daemon that was already
 * running, so the words have to carry who owns it, how to stop it, and that
 * starting it is not something this machine's operator ever needs to do.
 */
export function alreadyRunningLines(base: string): string[] {
  return [
    `a daemon for this home is already running at ${base}, so this one did not start.`,
    "",
    "Two daemons on one home load one identity, and the hub answers a repeated identity",
    "by evicting whichever daemon registered first, back and forth forever. That loop is",
    "why a paired phone sees no sessions, and a hand start only ever creates it.",
    "",
    "Nothing needs starting by hand: the LaunchAgent ai.ompctl already owns this daemon",
    "and restarts it whenever it exits.",
    "",
    "  to stop it instead: launchctl bootout gui/$(id -u)/ai.ompctl",
    "  to run a second daemon on purpose: OMPD_HOME=<dir> ompd start --port <n>",
  ];
}

/** What a start into an address held by someone else's daemon must say. */
export function portConflictLines(base: string): string[] {
  return [
    `${base} is busy, and what answers there is not a daemon for this home.`,
    "",
    `  start this one elsewhere with \`ompd start --port <n>\`, or stop whatever holds ${base}`,
  ];
}

export interface SoleDaemonOptions {
  home: string;
  host: string;
  port: number;
  /**
   * Defaults to the global fetch. Narrowed to the shape a health probe
   * needs, so a test can answer as any daemon without implementing the rest.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Deadline for one health probe. */
  probeTimeoutMs?: number;
}

/** One address, as a health probe saw it. */
interface Probe {
  /** False when nothing answered there at all. */
  busy: boolean;
  /** The responder's `homeId`, when it proved to be an ompd. */
  homeId?: string;
}

async function probeHealth(
  fetchHealth: NonNullable<SoleDaemonOptions["fetch"]>,
  base: string,
  timeoutMs: number,
): Promise<Probe> {
  let response: Response;
  try {
    response = await fetchHealth(`${base}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    // Nothing answered, or it never finished answering: this address is not
    // holding a daemon this start would be displacing.
    return { busy: false };
  }
  try {
    const body: unknown = await response.json();
    if (body !== null && typeof body === "object" && "homeId" in body && typeof body.homeId === "string") {
      return { busy: true, homeId: body.homeId };
    }
    // Answered, but not in a way that identifies a home: an old daemon, or
    // something else entirely. Either way the port is held.
    return { busy: true };
  } catch {
    // An answer that is not JSON at all still holds the port, and the bind
    // would fail against it anyway.
    return { busy: true };
  }
}

/**
 * Throw `SoleDaemonError` when another daemon is already serving this home,
 * or when the address this start wants is held by anyone else. Resolve
 * quietly when the field is clear.
 */
export async function assertSoleDaemon(opts: SoleDaemonOptions): Promise<void> {
  const fetchHealth = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const ours = homeIdFor(opts.home);

  // The published endpoint first, because it is the only witness to the
  // original incident's shape: a same-home daemon on a different port, where
  // the configured port was free and nothing else connected the two starts.
  const published = readPublishedEndpoint(opts.home);
  if (published !== null) {
    const found = await probeHealth(fetchHealth, published, timeoutMs);
    if (found.busy && found.homeId === ours) {
      throw new SoleDaemonError(alreadyRunningLines(published).join("\n"), "already-running");
    }
    // A published address answered by anyone else, or by no one, is a stale
    // record: the CLI already reports it on its own probes, and this start
    // is free to bind elsewhere and republish over it.
  }

  if (opts.port === 0) return;

  // A wildcard bind address means every interface, not a destination.
  // Probing loopback reaches the same daemon that binding the wildcard
  // would be fighting for the home.
  const host = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
  const base = `http://${host}:${opts.port}`;
  if (base === published) return;

  const found = await probeHealth(fetchHealth, base, timeoutMs);
  if (!found.busy) return;

  // Busy is the only outcome left: either our own daemon already holds the
  // port, or someone else's does and the bind would fail anyway. Telling the
  // two apart is the difference between "do nothing" and "move".
  const refusal: SoleDaemonRefusal = found.homeId === ours ? "already-running" : "port-conflict";
  const lines = refusal === "already-running" ? alreadyRunningLines(base) : portConflictLines(base);
  throw new SoleDaemonError(lines.join("\n"), refusal);
}

/** The address a previous daemon of this home recorded, if it left one. */
function readPublishedEndpoint(home: string): string | null {
  const path = endpointPath(home);
  if (!existsSync(path)) return null;
  const url = readFileSync(path, "utf8").trim();
  return url.length > 0 ? url : null;
}
