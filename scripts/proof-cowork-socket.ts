/**
 * The Cowork frames against a real daemon process over a real websocket.
 *
 * Not the in-process fake host: this starts `ompd` from this branch with its
 * own state directory, pairs a device through the real pairing route, opens
 * `/v1/socket`, and drives every Cowork frame the surface uses, printing what
 * the daemon answered. Everything it creates it destroys, and it names nothing
 * it did not create.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPolicy, Store } from "@ompd/core";
import type { ClientFrame, ServerFrame } from "@ompd/core/contracts";
import { Gateway, GatewayEvents } from "../packages/daemon/src/gateway/index.ts";
import { HostRegistry } from "../packages/daemon/src/hosts.ts";
import { Supervisor } from "../packages/daemon/src/supervisor.ts";
import { listConnectorCatalog, listSkillCatalog, TaskManager } from "../packages/daemon/src/workspace/index.ts";

const home = mkdtempSync(join(tmpdir(), "cowork-proof-"));
const dbPath = join(home, "ompd.db");
const store = new Store(dbPath);
const events = new GatewayEvents();
const hosts = new HostRegistry({});
const supervisor = new Supervisor({
  store,
  policy: new DefaultPolicy({ mode: "standard" }),
  spawnHost: hosts.spawn,
  events,
});
const gateway = new Gateway({
  store,
  supervisor,
  events,
  port: 0,
  skills: { list: cwd => listSkillCatalog(cwd) },
  connectors: { list: cwd => listConnectorCatalog(cwd) },
  tasks: new TaskManager({ store, supervisor }),
  sessions: hosts,
});

const port = await gateway.listen();
const paired = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "cowork-proof", publicKey: "cowork-proof" }),
});
const { code } = (await paired.json()) as { code: string };
const token = await gateway.approvePairing(code, ["read", "prompt", "manage"]);

const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
const frames: ServerFrame[] = [];
let cursor = 0;
await new Promise<void>((resolve, reject) => {
  ws.addEventListener("open", () => resolve());
  ws.addEventListener("error", () => reject(new Error("socket refused")));
});
ws.addEventListener("message", event => {
  frames.push(JSON.parse(String(event.data)) as ServerFrame);
});

const send = (frame: ClientFrame): void => ws.send(JSON.stringify(frame));

/** Wait for the next frame matching `match`, or fail by name. */
async function next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    while (cursor < frames.length) {
      const frame = frames[cursor];
      cursor += 1;
      if (frame && match(frame)) return frame;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(20);
  }
}

const show = (label: string, frame: ServerFrame): void => {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(frame, null, 2).slice(0, 1200));
};

const cwd = process.cwd();
await next(frame => frame.t === "hello", "hello");

send({ t: "skills_read", cwd });
const skills = await next(frame => frame.t === "skills" || frame.t === "error", "skills");
show(`skills_read cwd=${cwd}`, skills.t === "skills" ? { t: "skills", skills: skills.skills.slice(0, 3) } : skills);
if (skills.t === "skills") console.log(`skills total: ${skills.skills.length}`);

send({ t: "connectors_read", cwd });
const connectors = await next(frame => frame.t === "connectors" || frame.t === "error", "connectors");
show(
  "connectors_read",
  connectors.t === "connectors" ? { t: "connectors", connectors: connectors.connectors.slice(0, 3) } : connectors,
);
if (connectors.t === "connectors") console.log(`connectors total: ${connectors.connectors.length}`);

send({ t: "tasks_read" });
show("tasks_read (before any task exists)", await next(frame => frame.t === "tasks" || frame.t === "error", "tasks"));

send({ t: "agent_create", name: "cowork-proof", cwd });
const agent = await next(frame => frame.t === "agent_created" || frame.t === "error", "agent_created");
show("agent_create", agent);
if (agent.t !== "agent_created") {
  console.log("\nno agent, so no task to create against one: stopping here rather than inventing a target");
} else {
  send({ t: "task_create", title: "Cowork socket proof", prompt: "say ok and stop", agentId: agent.agent.id });
  const created = await next(frame => frame.t === "task" || frame.t === "error", "task after create");
  show("task_create", created);

  send({ t: "tasks_read" });
  show("tasks_read (with the task)", await next(frame => frame.t === "tasks" || frame.t === "error", "tasks"));

  if (created.t === "task") {
    send({ t: "task_cancel", taskId: created.task.id });
    show("task_cancel", await next(frame => frame.t === "task" || frame.t === "error", "task after cancel"));
  }

  // Cleanup: stop only the agent this script created.
  const stopped = await fetch(`http://127.0.0.1:${port}/v1/agents/${agent.agent.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  console.log(`\ncleanup: DELETE /v1/agents/${agent.agent.id} -> ${stopped.status}`);
}

// The refusal side, from a second pairing that holds read alone.
const pairedReader = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "cowork-proof-reader", publicKey: "cowork-proof-reader" }),
});
const readerCode = ((await pairedReader.json()) as { code: string }).code;
const readerToken = await gateway.approvePairing(readerCode, ["read"]);
const reader = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(readerToken)}`);
const readerFrames: ServerFrame[] = [];
await new Promise<void>(resolve => reader.addEventListener("open", () => resolve()));
reader.addEventListener("message", event => readerFrames.push(JSON.parse(String(event.data)) as ServerFrame));
reader.send(JSON.stringify({ t: "agent_create", name: "should-refuse", cwd } satisfies ClientFrame));
const deadline = Date.now() + 10_000;
while (Date.now() < deadline && !readerFrames.some(frame => frame.t === "error")) await Bun.sleep(20);
console.log("\n--- agent_create from a read-only pairing ---");
console.log(JSON.stringify(readerFrames.find(frame => frame.t === "error") ?? readerFrames, null, 2));

ws.close();
reader.close();
await gateway.close();
await supervisor.shutdown();
store.close();
rmSync(home, { recursive: true, force: true });
console.log("\nteardown: daemon closed, state directory removed");
