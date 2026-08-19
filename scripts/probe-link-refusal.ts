/**
 * The hub's own words when a client leg is refused.
 *
 * `OmpdClient` reports "websocket error" for every failed connection, which
 * cannot distinguish a rejected credential from an unroutable daemon from a
 * broken upgrade. This dials the tunnel directly and prints the close code and
 * reason the relay actually sent.
 *
 * Usage: OMPD_HUB_URL=wss://hub.ompctl.ai OMPD_PROBE_TOKEN=... OMPD_PROBE_DAEMON=dmn_... bun run scripts/probe-link-refusal.ts
 */

import type { DaemonId } from "@ompd/tunnel";
import { createHubSocketFactory } from "../packages/app/src/platform/socket.ts";

const hubUrl = process.env.OMPD_HUB_URL ?? "";
const token = process.env.OMPD_PROBE_TOKEN ?? "";
const daemonId = (process.env.OMPD_PROBE_DAEMON ?? "") as DaemonId;
if (hubUrl === "" || token === "" || daemonId === "") {
  console.error("OMPD_HUB_URL, OMPD_PROBE_TOKEN, OMPD_PROBE_DAEMON are required");
  process.exit(2);
}

const socket = createHubSocketFactory({ daemonId })(`${hubUrl}?token=${encodeURIComponent(token)}`);
const settled = Promise.withResolvers<string>();

socket.onopen = () => {
  console.log("  onopen: sealed channel established");
};
socket.onmessage = data => {
  console.log(`  onmessage: ${String(data).slice(0, 160)}`);
};
socket.onerror = error => {
  console.log(`  onerror: ${String((error as { message?: string })?.message ?? error).slice(0, 200)}`);
};
socket.onclose = info => {
  settled.resolve(`code=${info.code} reason=${JSON.stringify(info.reason)}`);
};

const timer = setTimeout(() => settled.resolve("no close within 30s (still open or hung)"), 30_000);
console.log(`  close: ${await settled.promise}`);
clearTimeout(timer);
socket.close();
