import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  type Agent,
  type AgentId,
  DefaultPolicy,
  type HostSpec,
  type QueuedIntent,
  SCOPE_APPROVE,
  SCOPE_MANAGE,
  SCOPE_PROMPT,
  Store,
} from "@ompd/core";
import { HttpIntentPeer, QueuedIntentDrainer } from "../src/federation/queued-intents.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { createAgentId, Supervisor } from "../src/supervisor.ts";
import { createFakeHost, type FakeHostController } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const supervisors: Supervisor[] = [];

interface GatewayHarness {
  gateway: Gateway;
  store: Store;
  supervisor: Supervisor;
  fake: FakeHostController;
  baseUrl: string;
  pair(scopes: string[]): Promise<string>;
  request(path: string, init: RequestInit, token?: string): Promise<Response>;
}

function replicaAgent(id: AgentId): Agent {
  const now = new Date().toISOString();
  return {
    id,
    name: "Mirrored agent",
    state: "idle",
    host: { kind: "local", id: "delegate", spec: { kind: "local" } },
    cwd: "/workspace",
    createdAt: now,
    lastActiveAt: now,
    labels: {},
  };
}

async function makeGateway(opts: { replica?: boolean; syncToken?: string } = {}): Promise<GatewayHarness> {
  const path = `/tmp/ompd-queued-intents-${crypto.randomUUID()}.db`;
  paths.push(path);
  const store = new Store(path);
  stores.push(store);
  const fake = createFakeHost();
  const supervisor = new Supervisor({
    store,
    policy: new DefaultPolicy({ mode: "standard" }),
    spawnHost: fake.factory,
  });
  supervisors.push(supervisor);
  const gateway = new Gateway({
    supervisor,
    store,
    port: 0,
    federation:
      opts.syncToken === undefined ? undefined : { replica: opts.replica ?? false, syncToken: opts.syncToken },
  });
  gateways.push(gateway);
  const port = await gateway.listen();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    gateway,
    store,
    supervisor,
    fake,
    baseUrl,
    pair: async scopes => {
      const paired = await fetch(`${baseUrl}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "operator", publicKey: "pk_operator" }),
      });
      const body = (await paired.json()) as { code: string };
      return gateway.approvePairing(body.code, scopes);
    },
    request: (path, init, token) => {
      const headers = new Headers(init.headers);
      headers.set("content-type", "application/json");
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${baseUrl}${path}`, { ...init, headers });
    },
  };
}

afterEach(async () => {
  await Promise.all(gateways.map(gateway => gateway.close()));
  await Promise.all(supervisors.map(supervisor => supervisor.shutdown()));
  for (const store of stores) store.close();
  for (const path of paths) rmSync(path, { force: true });
  gateways.length = 0;
  supervisors.length = 0;
  stores.length = 0;
  paths.length = 0;
});

describe("Federation queued intents", () => {
  test("a replica queues authorized writes for an agent it does not own", async () => {
    const cloud = await makeGateway({ replica: true, syncToken: "cloud-sync-token" });
    const operator = await cloud.pair([SCOPE_PROMPT, SCOPE_MANAGE, SCOPE_APPROVE]);
    const agentId = createAgentId();
    cloud.store.upsertAgent(replicaAgent(agentId));

    const prompt = await cloud.request(
      `/v1/agents/${agentId}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "Review the change" }) },
      operator,
    );
    expect(prompt.status).toBe(202);
    expect(cloud.fake.prompts).toEqual([]);

    const tunnel = cloud.gateway.acceptTunnelSession(operator, () => {});
    expect(tunnel.ok).toBeTrue();
    if (!tunnel.ok) throw new Error("paired operator should open the tunnel session");
    tunnel.deliver(JSON.stringify({ t: "cancel", agentId }));
    tunnel.deliver(JSON.stringify({ t: "decide", agentId, requestId: "apr_remote", choice: "allow", scope: "once" }));

    const created = await cloud.request(
      "/v1/agents",
      { method: "POST", body: JSON.stringify({ name: "Queued agent", cwd: "/workspace" }) },
      operator,
    );
    expect(created.status).toBe(202);
    expect(cloud.fake.sessions).toEqual([]);

    const pending = cloud.store.listPendingQueuedIntents();
    expect(pending.map(intent => intent.action).toSorted()).toEqual(["cancel", "decide", "new-agent", "prompt"]);
    expect(
      pending.filter(intent => intent.action !== "new-agent").every(intent => intent.agentId === agentId),
    ).toBeTrue();
    expect(pending.every(intent => intent.actorDeviceId !== "daemon")).toBeTrue();
  });

  test("the owning delegate claims, executes with real actor, and acknowledges", async () => {
    const cloud = await makeGateway({ replica: true, syncToken: "cloud-sync-token" });
    const operator = await cloud.pair([SCOPE_PROMPT, SCOPE_MANAGE]);
    const local = await makeGateway();
    const agentId = createAgentId();
    cloud.store.upsertAgent(replicaAgent(agentId));

    // The originating device must exist on the local delegate for authorization.
    const operatorDevice = cloud.store.listDevices().find(device => !device.revokedAt);
    expect(operatorDevice).toBeDefined();
    local.store.addDevice({
      id: operatorDevice!.id,
      name: operatorDevice!.name,
      publicKey: operatorDevice!.publicKey,
      scopes: [SCOPE_PROMPT, SCOPE_MANAGE],
      createdAt: operatorDevice!.createdAt,
    });

    await local.supervisor.createAgent(
      { id: agentId, name: "Local delegate", cwd: "/workspace" },
      { deviceId: operatorDevice!.id, scopes: [] },
    );

    const queued = await cloud.request(
      `/v1/agents/${agentId}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "Execute this locally" }) },
      operator,
    );
    expect(queued.status).toBe(202);

    const peer = new HttpIntentPeer({ url: cloud.baseUrl, token: "cloud-sync-token" });
    const drainer = new QueuedIntentDrainer({ supervisor: local.supervisor, peer });
    expect(await drainer.drain()).toBe(1);
    expect(local.fake.prompts).toHaveLength(1);
    expect(local.fake.prompts[0]?.text).toBe("Execute this locally");

    const pending = await cloud.request("/v1/sync/intents", { method: "GET" }, "cloud-sync-token");
    expect(pending.status).toBe(200);
    expect((await pending.json()) as { intents: QueuedIntent[] }).toEqual({ intents: [] });

    // The claim path rejects a second claim, and ack of pending IDs is a no-op.
    const body = (await queued.json()) as { intent: QueuedIntent };
    const reclaimed = await cloud.request(
      "/v1/sync/intents/claim",
      { method: "POST", body: JSON.stringify({ id: body.intent.id }) },
      "cloud-sync-token",
    );
    expect(reclaimed.status).toBe(409);
  });

  test("claim is required before markDelivered advances status", async () => {
    const cloud = await makeGateway({ replica: true, syncToken: "cloud-sync-token" });
    const operator = await cloud.pair([SCOPE_PROMPT]);
    const agentId = createAgentId();
    cloud.store.upsertAgent(replicaAgent(agentId));
    const queued = await cloud.request(
      `/v1/agents/${agentId}/prompt`,
      { method: "POST", body: JSON.stringify({ text: "claim me" }) },
      operator,
    );
    const body = (await queued.json()) as { intent: QueuedIntent };

    const ackPending = await cloud.request(
      "/v1/sync/intents/ack",
      { method: "POST", body: JSON.stringify({ ids: [body.intent.id] }) },
      "cloud-sync-token",
    );
    expect(ackPending.status).toBe(200);
    expect(((await ackPending.json()) as { delivered: number }).delivered).toBe(0);
    expect(cloud.store.listPendingQueuedIntents().map(intent => intent.id)).toEqual([body.intent.id]);

    const claimed = await cloud.request(
      "/v1/sync/intents/claim",
      { method: "POST", body: JSON.stringify({ id: body.intent.id }) },
      "cloud-sync-token",
    );
    expect(claimed.status).toBe(200);
    expect(cloud.store.listPendingQueuedIntents()).toEqual([]);

    const ackClaimed = await cloud.request(
      "/v1/sync/intents/ack",
      { method: "POST", body: JSON.stringify({ ids: [body.intent.id] }) },
      "cloud-sync-token",
    );
    expect(((await ackClaimed.json()) as { delivered: number }).delivered).toBe(1);
  });

  test("a missing local actor refuses delivery rather than inventing authority", async () => {
    const local = await makeGateway();
    const agentId = createAgentId();
    // Create agent with a known local device first.
    local.store.addDevice({
      id: "dev_local",
      name: "local",
      publicKey: "pk_local",
      scopes: [SCOPE_MANAGE, SCOPE_PROMPT],
      createdAt: new Date().toISOString(),
    });
    await local.supervisor.createAgent(
      { id: agentId, name: "Local", cwd: "/workspace" },
      { deviceId: "dev_local", scopes: [] },
    );

    const errors: Error[] = [];
    const drainer = new QueuedIntentDrainer({
      supervisor: local.supervisor,
      onError: error => errors.push(error),
      peer: {
        pullPendingIntents: async () => [
          {
            id: "qi_unknown_actor",
            agentId,
            actorDeviceId: "dev_unknown",
            action: "prompt",
            payload: { text: "should not run" },
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        ],
        claimIntent: async () => true,
        acknowledgeDelivered: async () => {
          throw new Error("should not acknowledge a refused intent");
        },
      },
    });

    expect(await drainer.drain()).toBe(0);
    expect(local.fake.prompts).toEqual([]);
    expect(errors.some(error => /unknown device|unauthorized/i.test(error.message))).toBeTrue();
  });

  test("new-agent short-circuit still authorizes the originating actor", async () => {
    const local = await makeGateway();
    const agentId = createAgentId();
    local.store.addDevice({
      id: "dev_revoked",
      name: "revoked",
      publicKey: "pk",
      scopes: [SCOPE_MANAGE],
      createdAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    });
    // Pre-create the reserved agent under a different authorized device so
    // ownsAgent is true and the short-circuit path is taken.
    local.store.addDevice({
      id: "dev_owner",
      name: "owner",
      publicKey: "pk2",
      scopes: [SCOPE_MANAGE],
      createdAt: new Date().toISOString(),
    });
    await local.supervisor.createAgent(
      { id: agentId, name: "Already exists", cwd: "/workspace" },
      { deviceId: "dev_owner", scopes: [] },
    );

    const errors: Error[] = [];
    let acknowledged = false;
    const drainer = new QueuedIntentDrainer({
      supervisor: local.supervisor,
      onError: error => errors.push(error),
      peer: {
        pullPendingIntents: async () => [
          {
            id: "qi_new_revoked",
            agentId,
            actorDeviceId: "dev_revoked",
            action: "new-agent",
            payload: { name: "Already exists", cwd: "/workspace" },
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        ],
        claimIntent: async () => true,
        acknowledgeDelivered: async () => {
          acknowledged = true;
        },
      },
    });

    expect(await drainer.drain()).toBe(0);
    expect(acknowledged).toBeFalse();
    expect(errors.some(error => /revoked|unauthorized/i.test(error.message))).toBeTrue();
  });

  test("stop awaits an in-flight drain before returning", async () => {
    const local = await makeGateway();
    const agentId = createAgentId();
    local.store.addDevice({
      id: "dev_local",
      name: "local",
      publicKey: "pk",
      scopes: [SCOPE_MANAGE, SCOPE_PROMPT],
      createdAt: new Date().toISOString(),
    });
    await local.supervisor.createAgent(
      { id: agentId, name: "Local", cwd: "/workspace" },
      { deviceId: "dev_local", scopes: [] },
    );

    const gate = Promise.withResolvers<void>();
    let drainEntered = false;
    let drainFinished = false;
    const drainer = new QueuedIntentDrainer({
      supervisor: local.supervisor,
      peer: {
        pullPendingIntents: async () => {
          drainEntered = true;
          await gate.promise;
          return [
            {
              id: "qi_slow",
              agentId,
              actorDeviceId: "dev_local",
              action: "prompt",
              payload: { text: "slow" },
              createdAt: new Date().toISOString(),
              status: "pending",
            },
          ];
        },
        claimIntent: async () => true,
        acknowledgeDelivered: async () => {
          drainFinished = true;
        },
      },
    });

    const drainPromise = drainer.drain();
    // Wait until the drain has entered the peer pull.
    while (!drainEntered) await Promise.resolve();

    const stopPromise = drainer.stop();
    // stop must not resolve while the drain is still blocked.
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBeFalse();

    gate.resolve();
    await stopPromise;
    expect(stopped).toBeTrue();
    expect(await drainPromise).toBe(1);
    expect(drainFinished).toBeTrue();
  });

  test("the delegate preserves a reserved agent id when it drains a queued creation", async () => {
    const local = await makeGateway();
    const agentId = createAgentId();
    local.store.addDevice({
      id: "dev_cloud_operator",
      name: "cloud operator",
      publicKey: "pk",
      scopes: [SCOPE_MANAGE],
      createdAt: new Date().toISOString(),
    });
    const intent: QueuedIntent = {
      id: "qi_new_agent",
      agentId,
      actorDeviceId: "dev_cloud_operator",
      action: "new-agent",
      payload: { name: "Created by delegate", cwd: "/workspace" },
      createdAt: new Date().toISOString(),
      status: "pending",
    };
    const acknowledged: string[][] = [];
    const claimed: string[] = [];
    const drainer = new QueuedIntentDrainer({
      supervisor: local.supervisor,
      peer: {
        pullPendingIntents: async () => [intent],
        claimIntent: async id => {
          claimed.push(id);
          return true;
        },
        acknowledgeDelivered: async ids => void acknowledged.push([...ids]),
      },
    });

    expect(await drainer.drain()).toBe(1);
    expect(claimed).toEqual([intent.id]);
    expect(local.supervisor.listAgents().map(agent => agent.id)).toContain(agentId);
    expect(acknowledged).toEqual([[intent.id]]);
  });

  // -------------------------------------------------------------------------
  // The third door: a replayed host spec is revalidated by the wire's own
  // validator, not by a parser this file used to keep for itself.
  //
  // Every case below is driven through a real `QueuedIntentDrainer` rather than
  // against the validator directly, because the defect was that this door
  // existed at all. The stale `parseHostSpec`/`parseMounts` it replaced are
  // reproduced as `STALE_PARSE` so each test can show what the merged code did
  // with the same payload; a test that only shows the new code working would not
  // prove a bypass was closed.
  // -------------------------------------------------------------------------

  /**
   * `parseHostSpec` and `parseMounts` exactly as they stood at `ca5df43`, the
   * head this branch is fixing. Kept as a fixture rather than imported from
   * that revision so the comparison runs in-process and cannot rot into a
   * git-history read that silently stops resolving.
   */
  function STALE_PARSE(value: unknown): Record<string, unknown> {
    const fields = value as Record<string, unknown>;
    return {
      kind: fields.kind,
      ...(typeof fields.image === "string" ? { image: fields.image } : {}),
      ...(typeof fields.repo === "string" ? { repo: fields.repo } : {}),
      ...(Array.isArray(fields.mounts)
        ? {
            mounts: fields.mounts.map(entry => {
              const mount = entry as Record<string, unknown>;
              if (typeof mount.containerPath !== "string") throw new Error("host mount needs containerPath");
              return {
                hostPath: mount.hostPath,
                containerPath: mount.containerPath,
                ...(mount.readOnly === true ? { readOnly: true } : {}),
              };
            }),
          }
        : {}),
    };
  }

  /**
   * Replay one `new-agent` intent and report what reached `createAgent`.
   *
   * The observation point is `createAgent`'s own argument, not the created
   * agent, and that is deliberate rather than convenient. The reviewer's
   * finding was phrased as "arbitrary image survives to createAgent", so the
   * argument is the thing under test. It is also the only observation that
   * works here: this harness builds a supervisor with no provisioner, so any
   * container spec that got through would die later with "host kind container
   * requires the provisioner" and a test reading the stored agent would see an
   * absence it could not attribute. Wrapping the method separates "the
   * validator refused it" from "the harness has no backend", which are the two
   * outcomes that must never be confused.
   */
  async function replayHost(host: unknown): Promise<{
    reached: HostSpec | undefined;
    called: boolean;
    acknowledged: boolean;
    errors: Error[];
  }> {
    const local = await makeGateway();
    local.store.addDevice({
      id: "dev_manage",
      name: "manage",
      publicKey: "pk_manage",
      scopes: [SCOPE_MANAGE],
      createdAt: new Date().toISOString(),
    });

    let reached: HostSpec | undefined;
    let called = false;
    const supervisor = local.supervisor;
    const realCreateAgent = supervisor.createAgent.bind(supervisor);
    supervisor.createAgent = async (input, actor) => {
      called = true;
      reached = input.host;
      // Still calls through, so authorization and every other check downstream
      // behaves exactly as it does in production. A stub would make this a test
      // of the stub.
      return await realCreateAgent(input, actor);
    };

    const errors: Error[] = [];
    let acknowledged = false;
    const drainer = new QueuedIntentDrainer({
      supervisor,
      onError: error => errors.push(error),
      peer: {
        pullPendingIntents: async () => [
          {
            id: "qi_host",
            agentId: createAgentId(),
            actorDeviceId: "dev_manage",
            action: "new-agent",
            payload: { name: "replayed", cwd: "/workspace", host },
            createdAt: new Date().toISOString(),
            status: "pending",
          },
        ],
        claimIntent: async () => true,
        acknowledgeDelivered: async () => {
          acknowledged = true;
        },
      },
    });

    await drainer.drain();
    return { reached, called, acknowledged, errors };
  }

  test("a replayed image is refused, and the intent is not acknowledged", async () => {
    // Fail-before: the stale parser copied any string image straight through,
    // which is the whole bypass. Everything the default path pins is defeated
    // by naming an image, and the gate cannot help because an image's
    // ENTRYPOINT runs before ompd has a process to gate.
    expect(STALE_PARSE({ kind: "container", image: "evil/omp:latest" }).image).toBe("evil/omp:latest");

    const result = await replayHost({ kind: "container", image: "evil/omp:latest" });
    expect(result.called).toBeFalse();
    // Not acked, so the intent is not recorded as delivered. A refusal that
    // acked would lose the intent AND the evidence.
    expect(result.acknowledged).toBeFalse();
    expect(result.errors.some(error => /host\.image is not accepted/.test(error.message))).toBeTrue();
    expect(result.errors.some(error => /qi_host/.test(error.message))).toBeTrue();
  });

  test("a padded or control-character image cannot smuggle itself past a trim", async () => {
    for (const image of ["  --privileged", "\t-x", "evil\nomp"]) {
      const result = await replayHost({ kind: "container", image });
      expect(result.called).toBeFalse();
      expect(result.acknowledged).toBeFalse();
    }
  });

  test("a replayed network policy survives instead of silently becoming isolated", async () => {
    // Fail-before: the stale parser dropped `network` entirely, so a "none"
    // intent replayed as isolated with open egress and nothing said so.
    expect(STALE_PARSE({ kind: "container", network: "none" }).network).toBeUndefined();

    const result = await replayHost({ kind: "container", network: "none" });
    expect(result.called).toBeTrue();
    expect(result.reached?.network).toBe("none");
  });

  test("a local host asking for a network is refused at replay, matching the wire", async () => {
    const result = await replayHost({ kind: "local", network: "none" });
    expect(result.called).toBeFalse();
    expect(result.acknowledged).toBeFalse();
    expect(result.errors.some(error => /cannot be set on a local host/.test(error.message))).toBeTrue();
  });

  test("a current-shape mount survives replay with its mode intact", async () => {
    // Fail-before, in both directions: the stale parser REFUSED a current
    // mount for lacking `containerPath`, and the legacy shape it accepted
    // dropped `mode`, so an rw mount became the default.
    expect(() => STALE_PARSE({ kind: "container", mounts: [{ hostPath: "/data", mode: "rw" }] })).toThrow(
      /containerPath/,
    );
    const legacy = STALE_PARSE({
      kind: "container",
      mounts: [{ hostPath: "/data", containerPath: "/data", readOnly: false }],
    });
    expect((legacy.mounts as Record<string, unknown>[])[0]?.mode).toBeUndefined();

    const result = await replayHost({ kind: "container", mounts: [{ hostPath: "/data", mode: "rw" }] });
    expect(result.called).toBeTrue();
    expect(result.reached?.mounts).toEqual([{ hostPath: "/data", mode: "rw" }]);
  });

  test("the legacy mount shape is refused rather than guessed at", async () => {
    const result = await replayHost({
      kind: "container",
      mounts: [{ hostPath: "/data", containerPath: "/data", readOnly: true }],
    });
    expect(result.called).toBeFalse();
    expect(result.acknowledged).toBeFalse();
    expect(result.errors.some(error => /unknown field "containerPath"/.test(error.message))).toBeTrue();
  });

  test("repo, ref and ttlSeconds all survive replay", async () => {
    // Fail-before: the stale parser kept `repo` and dropped the other two.
    const stale = STALE_PARSE({ kind: "container", repo: "r", ref: "main", ttlSeconds: 60 });
    expect(stale.repo).toBe("r");
    expect(stale.ref).toBeUndefined();
    expect(stale.ttlSeconds).toBeUndefined();

    const result = await replayHost({ kind: "container", repo: "r", ref: "main", ttlSeconds: 60 });
    expect(result.called).toBeTrue();
    expect(result.reached?.repo).toBe("r");
    expect(result.reached?.ref).toBe("main");
    expect(result.reached?.ttlSeconds).toBe(60);
  });

  test("an unknown host field is refused at replay", async () => {
    const result = await replayHost({ kind: "container", privileged: true });
    expect(result.called).toBeFalse();
    expect(result.acknowledged).toBeFalse();
    expect(result.errors.some(error => /unknown field "privileged"/.test(error.message))).toBeTrue();
  });
});
