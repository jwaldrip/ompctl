/**
 * The Cowork websocket frames from the wire: `skills_read`, `connectors_read`,
 * `tasks_read`, `task_create`, `task_cancel`, and `agent_create`, which are the
 * sealed-socket road the whole Cowork surface takes to a hub-paired phone.
 * Everything the HTTP route enforces must hold here too -- the same scope on
 * the same capability, refusals named rather than dropped -- or the frame
 * would be a weaker door beside a strong one, and the hub-paired phone is the
 * client that can only use the frame.
 *
 * The socket helper follows sync-settings-ws.test.ts: every wait is on an
 * arriving frame, never on a clock. The supervisor side follows
 * workspace-tasks-policy.test.ts: real Supervisor, real policy, real Store,
 * scripted ACP peer, so a task created over the socket runs the prompt through
 * the exact path the HTTP route uses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type ClientFrame,
  DefaultPolicy,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  SCOPE_READ,
  type ServerFrame,
  Store,
} from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { Supervisor } from "../src/supervisor.ts";
import { TaskManager } from "../src/workspace/tasks.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];
const gateways: Gateway[] = [];
const sockets: Array<{ close(): void }> = [];

/**
 * Deadline for waiting on a frame that should already be on its way. It never
 * elapses on a passing run and adds no delay to one; it exists so a missing
 * frame fails with the name of what was expected instead of a silent hang.
 */
const SIGNAL_DEADLINE_MS = 3000;

/** The cwd each catalogue was asked for, so a test can prove scoping crossed the wire. */
const askedCwds: string[] = [];

async function harness() {
  const path = `/tmp/ompd-cowork-ws-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);

  const fake = createFakeHost();
  const events = new GatewayEvents();
  const hosts = new HostRegistry({ spawn: fake.factory });
  const sup = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: hosts.spawn,
    events,
  });
  sups.push(sup);

  const gateway = new Gateway({
    store,
    supervisor: sup,
    events,
    port: 0,
    skills: {
      // The catalogue records the cwd it resolved, because "the frame carried
      // the scoping the route's query parameter carries" is a fact about the
      // wire, not about the catalogue.
      list: async cwd => {
        askedCwds.push(cwd ?? "");
        return [{ name: "debug", description: "diagnose without fixing", kind: "skill", source: "native:native" }];
      },
    },
    connectors: {
      list: async () => [{ name: "github", connected: true, status: "connected" }],
    },
    tasks: new TaskManager({ store, supervisor: sup }),
  });
  gateways.push(gateway);
  const port = await gateway.listen();

  const pair = async (name: string, scopes: string[]) => {
    const paired = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, publicKey: name }),
    });
    const code = ((await paired.json()) as { code: string }).code;
    return gateway.approvePairing(code, scopes);
  };

  const connect = async (token: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
    const opened = Promise.withResolvers<boolean>();
    const frames: ServerFrame[] = [];
    let cursor = 0;
    let pending: { check: () => boolean; settle: (frame: ServerFrame | null) => void; timer: Timer } | null = null;

    const drain = (): void => {
      if (!pending) return;
      if (!pending.check()) return;
      const waiter = pending;
      pending = null;
      clearTimeout(waiter.timer);
      waiter.settle(frames[cursor - 1] ?? null);
    };

    ws.addEventListener("open", () => opened.resolve(true));
    ws.addEventListener("error", () => opened.resolve(false));
    ws.addEventListener("close", () => opened.resolve(false));
    ws.addEventListener("message", event => {
      frames.push(JSON.parse(String(event.data)) as ServerFrame);
      drain();
    });
    if (!(await opened.promise)) throw new Error("expected the websocket to open");

    const client = {
      frames,
      send: (frame: ClientFrame) => ws.send(JSON.stringify(frame)),
      next: (match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame> => {
        const settled = Promise.withResolvers<ServerFrame>();
        const timer = setTimeout(() => {
          pending = null;
          settled.reject(new Error(`timed out waiting for ${label}`));
        }, SIGNAL_DEADLINE_MS);
        pending = {
          check: () => {
            while (cursor < frames.length) {
              const frame = frames[cursor];
              cursor += 1;
              if (frame && match(frame)) return true;
            }
            return false;
          },
          settle: frame => {
            if (frame) settled.resolve(frame);
          },
          timer,
        };
        drain();
        return settled.promise;
      },
      close: () => ws.close(),
    };
    sockets.push(client);
    return client;
  };

  return { store, gateway, pair, connect };
}

function refusal(frame: ServerFrame, code: string): boolean {
  return frame.t === "error" && frame.code === code;
}

describe("the cowork catalogue frames", () => {
  test("a read-scoped phone is answered with the skills it asked for, scoped by cwd", async () => {
    const h = await harness();
    const reader = await h.connect(await h.pair("skills-reader", [SCOPE_READ]));

    reader.send({ t: "skills_read", cwd: "/Users/op/dev" });
    const answer = await reader.next(frame => frame.t === "skills", "skills frame");
    expect(answer).toEqual({
      t: "skills",
      skills: [{ name: "debug", description: "diagnose without fixing", kind: "skill", source: "native:native" }],
    });
    // The scoping crossed the wire: the catalogue saw the frame's cwd, not a
    // guess at one.
    expect(askedCwds.at(-1)).toBe("/Users/op/dev");
  });

  test("a phone with no read scope cannot even ask for skills", async () => {
    const h = await harness();
    const prompter = await h.connect(await h.pair("skills-prompter", [SCOPE_MANAGE]));

    prompter.send({ t: "skills_read" });
    const denied = await prompter.next(frame => refusal(frame, "unauthorized"), "unauthorized error");
    expect(denied.t).toBe("error");
  });

  test("a malformed scoping field is a bad_frame, not a guess", async () => {
    const h = await harness();
    const reader = await h.connect(await h.pair("skills-shape", [SCOPE_READ]));

    reader.send({ t: "skills_read", cwd: 42 } as unknown as ClientFrame);
    const bad = await reader.next(frame => refusal(frame, "bad_frame"), "bad_frame error");
    expect(bad.t).toBe("error");
  });

  test("connectors answer a read-scoped phone and refuse a manage-only one", async () => {
    const h = await harness();
    const reader = await h.connect(await h.pair("connectors-reader", [SCOPE_READ]));
    const manager = await h.connect(await h.pair("connectors-manager", [SCOPE_MANAGE]));

    reader.send({ t: "connectors_read" });
    const answer = await reader.next(frame => frame.t === "connectors", "connectors frame");
    expect(answer).toEqual({
      t: "connectors",
      connectors: [{ name: "github", connected: true, status: "connected" }],
    });

    manager.send({ t: "connectors_read" });
    const denied = await manager.next(frame => refusal(frame, "unauthorized"), "unauthorized error");
    expect(denied.t).toBe("error");
  });
});

describe("the cowork task frames", () => {
  test("a task is created and cancelled over the socket against an agent the socket made", async () => {
    const h = await harness();
    const admin = await h.connect(await h.pair("cowork-admin", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE]));

    // The agent comes from the socket too: this is the container-start frame
    // Cowork's folder binding rides.
    admin.send({ t: "agent_create", name: "probe", cwd: "/work" });
    const created = await admin.next(frame => frame.t === "agent_created", "agent_created frame");
    if (created.t !== "agent_created") throw new Error("expected agent_created");
    expect(created.agent.cwd).toBe("/work");

    admin.send({ t: "task_create", title: "Probe", prompt: "do the thing", agentId: created.agent.id });
    const task = await admin.next(frame => frame.t === "task", "task frame after create");
    if (task.t !== "task") throw new Error("expected task");
    expect(task.task.title).toBe("Probe");
    expect(task.task.agentId).toBe(created.agent.id);

    admin.send({ t: "tasks_read" });
    const roster = await admin.next(frame => frame.t === "tasks", "tasks frame");
    if (roster.t !== "tasks") throw new Error("expected tasks");
    expect(roster.tasks.some(entry => entry.id === task.task.id)).toBe(true);

    admin.send({ t: "task_cancel", taskId: task.task.id });
    const cancelled = await admin.next(frame => frame.t === "task", "task frame after cancel");
    if (cancelled.t !== "task") throw new Error("expected task after cancel");
    expect(cancelled.task.id).toBe(task.task.id);

    // Both doors go through the supervisor's own path, so the mutation
    // records exist exactly once and name the device that acted.
    const audit = h.store.listAudit(50);
    expect(audit.some(entry => entry.action === "agent.create" && entry.outcome === "ok")).toBe(true);
    expect(audit.some(entry => entry.action === "agent.prompt" && entry.outcome === "ok")).toBe(true);
  });

  test("a read-only phone cannot start, cancel, or list tasks", async () => {
    const h = await harness();
    const watcher = await h.connect(await h.pair("task-watcher", [SCOPE_READ]));

    watcher.send({ t: "task_create", title: "Nope", prompt: "nope", agentId: "agt_missing" });
    const startDenied = await watcher.next(frame => refusal(frame, "unauthorized"), "unauthorized on task_create");
    expect(startDenied.t).toBe("error");

    watcher.send({ t: "task_cancel", taskId: "t_missing" });
    const cancelDenied = await watcher.next(frame => refusal(frame, "unauthorized"), "unauthorized on task_cancel");
    expect(cancelDenied.t).toBe("error");
  });

  test("a phone with no read scope cannot read the roster", async () => {
    const h = await harness();
    const manager = await h.connect(await h.pair("roster-manager", [SCOPE_MANAGE]));

    manager.send({ t: "tasks_read" });
    const denied = await manager.next(frame => refusal(frame, "unauthorized"), "unauthorized on tasks_read");
    expect(denied.t).toBe("error");
  });

  test("a malformed task_create is a bad_frame rather than a guess", async () => {
    const h = await harness();
    const admin = await h.connect(await h.pair("task-shape", [SCOPE_READ, SCOPE_PROMPT]));

    admin.send({ t: "task_create", prompt: "missing a title", agentId: "agt_missing" } as unknown as ClientFrame);
    const bad = await admin.next(frame => refusal(frame, "bad_frame"), "bad_frame on task_create");
    expect(bad.t).toBe("error");
  });
});

describe("the agent_create frame", () => {
  test("a read-only phone cannot provision a host", async () => {
    const h = await harness();
    const watcher = await h.connect(await h.pair("create-watcher", [SCOPE_READ]));

    watcher.send({ t: "agent_create", name: "nope", cwd: "/work" });
    const denied = await watcher.next(frame => refusal(frame, "unauthorized"), "unauthorized on agent_create");
    expect(denied.t).toBe("error");

    // Nothing was provisioned and nothing was recorded as created: the
    // refusal is a door decision, not a rollback.
    const audit = h.store.listAudit(10);
    expect(audit.some(entry => entry.action === "agent.create" && entry.outcome === "ok")).toBe(false);
  });

  test("a frame without a name and cwd is refused as a bad_frame", async () => {
    const h = await harness();
    const admin = await h.connect(await h.pair("create-shape", [SCOPE_MANAGE]));

    admin.send({ t: "agent_create", cwd: "/work" } as unknown as ClientFrame);
    const bad = await admin.next(frame => refusal(frame, "bad_frame"), "bad_frame on agent_create");
    expect(bad.t).toBe("error");
  });

  test("a manage-only phone may create even without read: the gate is manage alone", async () => {
    const h = await harness();
    const manager = await h.connect(await h.pair("create-manager", [SCOPE_MANAGE]));

    manager.send({ t: "agent_create", name: "probe", cwd: "/work" });
    const created = await manager.next(frame => frame.t === "agent_created", "agent_created frame");
    expect(created.t).toBe("agent_created");
  });
});

describe("the same frames over a hub-relayed tunnel session", () => {
  test("a relayed socket reaches every cowork capability, and meets the same gates", async () => {
    const h = await harness();
    const token = await h.pair("cowork-hub", [SCOPE_READ, SCOPE_PROMPT, SCOPE_MANAGE]);

    // What the hub does with a relayed connection: hand the daemon the token
    // and a way to write back, then feed it decrypted client frames. No port,
    // no second authorization surface -- `acceptTunnelSession` resolves the
    // device row through the same `authenticate` a local socket uses, which is
    // why the frames below meet the same scope checks.
    const relayed: ServerFrame[] = [];
    const session = h.gateway.acceptTunnelSession(token, raw => {
      relayed.push(JSON.parse(raw) as ServerFrame);
    });
    if (!session.ok) throw new Error(`the tunnel session was refused: ${session.reason}`);

    const answer = async (match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame> => {
      const deadline = Date.now() + SIGNAL_DEADLINE_MS;
      for (;;) {
        const found = relayed.find(match);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} over the tunnel`);
        await Bun.sleep(5);
      }
    };

    session.deliver(JSON.stringify({ t: "skills_read", cwd: "/Users/op/dev" } satisfies ClientFrame));
    const skills = await answer(frame => frame.t === "skills", "skills frame");
    if (skills.t !== "skills") throw new Error("expected skills");
    expect(skills.skills[0]?.name).toBe("debug");

    session.deliver(JSON.stringify({ t: "connectors_read" } satisfies ClientFrame));
    expect((await answer(frame => frame.t === "connectors", "connectors frame")).t).toBe("connectors");

    session.deliver(JSON.stringify({ t: "agent_create", name: "hub-probe", cwd: "/work" } satisfies ClientFrame));
    const created = await answer(frame => frame.t === "agent_created", "agent_created frame");
    if (created.t !== "agent_created") throw new Error("expected agent_created");

    session.deliver(
      JSON.stringify({
        t: "task_create",
        title: "Over the hub",
        prompt: "do the thing",
        agentId: created.agent.id,
      } satisfies ClientFrame),
    );
    const task = await answer(frame => frame.t === "task", "task frame");
    if (task.t !== "task") throw new Error("expected task");

    session.deliver(JSON.stringify({ t: "tasks_read" } satisfies ClientFrame));
    const roster = await answer(frame => frame.t === "tasks", "tasks frame");
    if (roster.t !== "tasks") throw new Error("expected tasks");
    expect(roster.tasks.some(entry => entry.id === task.task.id)).toBe(true);

    session.deliver(JSON.stringify({ t: "task_cancel", taskId: task.task.id } satisfies ClientFrame));
    expect((await answer(frame => frame.t === "task" && frame.task.id === task.task.id, "cancelled task")).t).toBe(
      "task",
    );

    session.close();
  });

  test("a relayed read-only device is refused by the same gate a local one is", async () => {
    const h = await harness();
    const token = await h.pair("cowork-hub-reader", [SCOPE_READ]);

    const relayed: ServerFrame[] = [];
    const session = h.gateway.acceptTunnelSession(token, raw => {
      relayed.push(JSON.parse(raw) as ServerFrame);
    });
    if (!session.ok) throw new Error(`the tunnel session was refused: ${session.reason}`);

    session.deliver(JSON.stringify({ t: "agent_create", name: "nope", cwd: "/work" } satisfies ClientFrame));
    const deadline = Date.now() + SIGNAL_DEADLINE_MS;
    while (Date.now() < deadline && !relayed.some(frame => refusal(frame, "unauthorized"))) await Bun.sleep(5);
    expect(relayed.some(frame => refusal(frame, "unauthorized"))).toBe(true);

    session.close();
  });
});

afterEach(async () => {
  while (sockets.length) sockets.pop()?.close();
  while (gateways.length) await gateways.pop()?.close();
  while (sups.length) await sups.pop()?.shutdown();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
});
