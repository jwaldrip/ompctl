/**
 * Picks the driver for a run from `E2E_CLIENT`, and refuses to guess.
 *
 * An unrecognised value throws rather than falling back to web. A silent
 * fallback would let `E2E_CLIENT=IOS` or a typo report a green web run as though
 * the simulator had passed, which is the most expensive kind of false pass this
 * layer could produce.
 */
import type { ClientKind, E2EClient } from "./client.ts";

const KINDS: readonly ClientKind[] = ["web", "ios", "android"];

function requestedKind(): ClientKind {
  const raw = (process.env.E2E_CLIENT ?? "web").trim();
  const match = KINDS.find((k) => k === raw);
  if (match === undefined) {
    throw new Error(`E2E_CLIENT must be one of ${KINDS.join(", ")}; got "${raw}"`);
  }
  return match;
}

export async function createClient(): Promise<E2EClient> {
  const kind = requestedKind();
  if (kind === "web") {
    const { PlaywrightClient } = await import("./playwright-client.ts");
    return PlaywrightClient.create();
  }
  const { DetoxClient } = await import("./detox-client.ts");
  return await DetoxClient.create(kind);
}

export { type ClientKind, type E2EClient };
