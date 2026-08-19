/**
 * What a hub-relayed device actually receives from a running daemon.
 *
 * Answers two questions the app's empty Console cannot distinguish between:
 * whether the `agents` frame arrives at all, and whether the connection holds
 * long enough to render it. Also asks the daemon's HTTP session index over the
 * relay, which is how the Fleet browser would have to reach it today.
 *
 * Usage: OMPD_HUB_URL=wss://hub.ompctl.ai OMPD_PROBE_TOKEN=... OMPD_PROBE_DAEMON=dmn_... bun run scripts/probe-fleet-visibility.ts
 */

import type { Agent, SessionSummary } from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import type { DaemonId } from "@ompd/tunnel";
import { createHubSocketFactory } from "../packages/app/src/platform/socket.ts";

const hubUrl = process.env.OMPD_HUB_URL ?? "";
const token = process.env.OMPD_PROBE_TOKEN ?? "";
const daemonId = (process.env.OMPD_PROBE_DAEMON ?? "") as DaemonId;
/** Dial the daemon itself, to tell a bad credential apart from a bad relay. */
const directUrl = process.env.OMPD_PROBE_DIRECT ?? "";
if (token === "" || (directUrl === "" && (hubUrl === "" || daemonId === ""))) {
  console.error("OMPD_PROBE_TOKEN plus either OMPD_PROBE_DIRECT or (OMPD_HUB_URL and OMPD_PROBE_DAEMON) are required");
  process.exit(2);
}

const WINDOW_MS = 75_000;

const statuses: string[] = [];
let agentFrames = 0;
let lastAgents: Agent[] = [];
let indexFrames = 0;
const startedAt = Date.now();
let firstIndexAt: number | null = null;
let lastIndex: SessionSummary[] = [];
const errors: string[] = [];

const client = new OmpdClient(
  directUrl !== ""
    ? { url: `${directUrl}/v1/socket`, token }
    : {
        url: hubUrl,
        token,
        createSocket: createHubSocketFactory({ daemonId }),
        // The default probe dials the hub over HTTP, which the hub does not serve.
        probeCredential: async () => "unknown",
      },
);

client.on("status", event => {
  statuses.push(`${new Date().toISOString().slice(11, 19)} ${event.state}`);
});
client.on("agents", event => {
  agentFrames += 1;
  lastAgents = [...event.agents];
});
client.on("sessions", event => {
  indexFrames += 1;
  firstIndexAt ??= Date.now() - startedAt;
  lastIndex = [...event.sessions];
});
client.on("error", event => {
  errors.push(String((event as { message?: string }).message ?? "error"));
});

client.start();
// The whole point: a relayed client asking for every session on the machine,
// which no HTTP route can answer through a hub.
client.listSessions();
await new Promise(resolve => setTimeout(resolve, WINDOW_MS));
client.close();

console.log(`  status transitions (${statuses.length}):`);
for (const s of statuses.slice(0, 20)) console.log(`    ${s}`);
console.log(`  agents frames: ${agentFrames}`);
console.log(`  agents in last frame: ${lastAgents.length}`);
for (const a of lastAgents.slice(0, 6)) console.log(`    ${a.id} ${a.name} ${a.state}`);
console.log(`  index frames: ${indexFrames}`);
console.log(`  ms to first index frame: ${firstIndexAt ?? "never"}`);
console.log(`  sessions in last index frame: ${lastIndex.length}`);
const byStatus = new Map<string, number>();
for (const row of lastIndex) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
console.log(`  index by status: ${JSON.stringify(Object.fromEntries(byStatus))}`);
for (const row of lastIndex.filter(r => r.status === "live-tui").slice(0, 4)) {
  console.log(`    live-tui ${row.id.slice(0, 13)} pid=${row.pid ?? "none"} ${String(row.title ?? "").slice(0, 40)}`);
}
console.log(`  client errors: ${errors.length}${errors.length > 0 ? ` first=${errors[0]}` : ""}`);

// The session index as the Fleet browser would have to reach it from a phone.
const httpBase = `${hubUrl.replace(/^ws/, "http")}/v1/sessions`;
try {
  const res = await fetch(httpBase, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`  GET ${httpBase} -> ${res.status}`);
} catch (cause) {
  console.log(`  GET ${httpBase} -> threw ${String(cause)}`);
}
