/**
 * Drive a live omp terminal session the way a phone does: connect as a paired
 * device, ask for the index, then send `session_prompt` for one row and watch
 * the activity come back.
 *
 * This is the end of the chain the rest of the probes cover in pieces. If the
 * turn appears in the terminal and `turn_start`/`assistant_text`/`turn_end`
 * arrive here, then the extension registered the session, the daemon routed
 * the prompt to it, and the session took it as the operator's own turn.
 *
 * Usage: OMPD_PROBE_TOKEN=... OMPD_PROBE_SESSION=<uuid> bun run scripts/probe-session-prompt.ts "text"
 */

import { OmpdClient } from "@ompd/core/ompd-client";

const token = process.env.OMPD_PROBE_TOKEN ?? "";
const sessionId = process.env.OMPD_PROBE_SESSION ?? "";
const url = process.env.OMPD_PROBE_DIRECT ?? "ws://127.0.0.1:7777";
const text = process.argv[2] ?? "Reply with exactly: phone-turn-ok";
if (token === "" || sessionId === "") {
  console.error("OMPD_PROBE_TOKEN and OMPD_PROBE_SESSION are required");
  process.exit(2);
}

const client = new OmpdClient({ url: `${url}/v1/socket`, token });
const activity: string[] = [];
const errors: string[] = [];

client.on("tui_activity", event => {
  const suffix = event.text === undefined ? "" : `: ${event.text.slice(0, 80).replace(/\s+/g, " ")}`;
  activity.push(`${event.kind}${suffix}`);
});
client.on("error", event => {
  errors.push(String((event as { message?: string }).message ?? "error"));
});
client.on("sessions", event => {
  const row = event.sessions.find(s => s.id === sessionId);
  console.log(`  index knows the session: ${row === undefined ? "no" : `yes (${row.status})`}`);
});

client.start();
// The index ask is also what arms activity forwarding, so it comes first.
client.listSessions();
await new Promise(resolve => setTimeout(resolve, 3_000));

console.log(`  prompting ${sessionId.slice(0, 13)} with: ${text}`);
client.sessionPrompt(sessionId, text);

await new Promise(resolve => setTimeout(resolve, 45_000));
client.close();

console.log(`  activity frames: ${activity.length}`);
for (const line of activity.slice(0, 10)) console.log(`    ${line}`);
console.log(`  errors: ${errors.length}${errors.length > 0 ? ` first=${errors[0]}` : ""}`);
