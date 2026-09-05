/**
 * Prove the remote portal's transport against the LIVE daemon and hub, the way
 * the web build does it: a device token minted by `ompd invite`, the sealed
 * hub leg, the session index over the socket, a dormant or owned agent
 * attached, one prompt, and the model's own answer streamed back.
 *
 * Usage: OMPD_DEVICE_TOKEN_FILE=<path holding "<token>.<daemonId>"> \
 *        bun scripts/probe-hub-portal.ts <agentId> [hubHost]
 *
 * The token is read from a file so it never lands in argv or a shell history.
 * Nothing here is printed but counts, ids, and the nonce round trip.
 */
import { readFileSync } from "node:fs";
import type { Agent, AgentId } from "@ompd/core/contracts";
import { OmpdClient } from "@ompd/core/ompd-client";
import { parseDeviceCredential } from "@ompd/core/pairing";
import { createHubSocketFactory } from "../packages/app/src/platform/socket.ts";

const agentId = process.argv[2] as AgentId | undefined;
const hubHost = process.argv[3] ?? "hub.ompctl.ai";
const tokenFile = process.env.OMPD_DEVICE_TOKEN_FILE ?? "";
if (agentId === undefined || tokenFile === "") {
  console.error("usage: OMPD_DEVICE_TOKEN_FILE=<file> bun scripts/probe-hub-portal.ts <agentId> [hubHost]");
  process.exit(2);
}
const credential = parseDeviceCredential(readFileSync(tokenFile, "utf8").trim());
if (credential === null) {
  console.error("the token file does not hold a <token>.<daemonId> credential");
  process.exit(2);
}

const nonce = `portal_${Date.now().toString(36)}`;
const client = new OmpdClient({
  url: `wss://${hubHost}`,
  token: credential.token,
  createSocket: createHubSocketFactory({ daemonId: credential.daemonId }),
  probeCredential: async () => "unknown",
});

let sessionsListed = -1;
let attached = false;
let assistantText = "";
const phases: string[] = [];
const phase = (line: string): void => {
  phases.push(line);
  console.log(`PHASE: ${line}`);
};

const outcome = await new Promise<string>(resolve => {
  const deadline = setTimeout(
    () =>
      resolve(
        `timed out after ${phases.length} phases; assistant text so far: ${JSON.stringify(assistantText.slice(0, 120))}`,
      ),
    120_000,
  );
  const settle = (why: string): void => {
    clearTimeout(deadline);
    resolve(why);
  };
  client.on("unauthorized", e => settle(`unauthorized: ${e.reason}`));
  client.on("error", e => {
    if (e.agentId === agentId || e.code === "agent_busy") settle(`daemon error: ${e.code ?? ""} ${e.message}`);
  });
  client.on("sessions", e => {
    if (sessionsListed >= 0) return;
    sessionsListed = e.sessions.length;
    phase(`sessions listed: ${sessionsListed}`);
  });
  client.on("agents", e => {
    const mine = (e.agents as Agent[]).find(a => a.id === agentId);
    if (mine === undefined || attached) return;
    attached = true;
    phase(`agent ${agentId} seen, state ${mine.state}`);
    client.attach(agentId);
    client.prompt(agentId, `Reply with exactly this token and nothing else: ${nonce}`);
    phase("prompt sent through the hub");
  });
  client.on("update", e => {
    if (e.agentId !== agentId) return;
    const update = e.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
      assistantText += update.content.text ?? "";
      if (assistantText.includes(nonce)) settle("ok");
    }
  });
  client.on("status", s => {
    if (s.state !== "connected") return;
    phase(`connected through ${hubHost} to daemon ${credential.daemonId.slice(0, 12)}...`);
    client.listSessions({});
  });
  client.start();
});

client.close();
if (outcome === "ok") {
  console.log(`PHASE: assistant answered with the nonce (${assistantText.trim().length} chars)`);
  console.log(`PORTAL TRANSPORT GREEN sessions=${sessionsListed} nonce=${nonce}`);
  process.exit(0);
}
console.error(`PORTAL TRANSPORT RED: ${outcome}`);
process.exit(1);
