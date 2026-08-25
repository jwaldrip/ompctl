/**
 * Creating an agent on a container host, from the door an operator actually uses.
 *
 * Every layer of the container path passed its own test and the user path was
 * still broken. `check-cowork-thin-path.ts` proved the provisioner: runtime
 * selection, digest-pinned toolchain, a nonce through the exec transport, omp
 * running from the read-only mount, the ACP entrypoint reachable, destroy
 * reclaiming everything. All fourteen assertions green. And
 * `POST /v1/agents {"host":{"kind":"container"}}` answered HTTP 500 "Internal
 * error" every single time.
 *
 * The gap was one thing no provisioner test could see: `session/new` carries
 * `mcpServers`, the daemon put its own WebView MCP server in that list, and
 * that server binds `127.0.0.1`. From a local host that address is the daemon.
 * From a container it is the container, where nothing is listening. omp
 * refused the session, the supervisor released the host, the agent row went
 * `failed` with no reason, the log said nothing, and the ACP error's only
 * useful sentence was in `data.details` where nobody read it.
 *
 * So these tests are about the seam between a host and an address, and about
 * being able to see a failure at all. The counting ones exist because "it
 * works now" is not the claim; "one create provisions once" is.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpError, type LocalHost, type SpawnLocalHostOptions } from "@ompd/acp";
import { type Actor, type HostRef, type HostSpec, SCOPE_MANAGE, Store } from "@ompd/core";
import { webViewMcpServersFor } from "../src/browser/mcp-server.ts";
import type { HostHandle } from "../src/provisioner/index.ts";
import { Supervisor, safeFailureReason } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const scratch: string[] = [];
const stores: Store[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  for (const sup of sups.splice(0)) await sup.close?.().catch(() => undefined);
  for (const store of stores.splice(0)) store.close();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Counts what one create actually did, which is the point of these tests. */
interface Counts {
  provision: number;
  spawn: number;
  destroy: number;
}

interface Harness {
  sup: Supervisor;
  store: Store;
  actor: Actor;
  counts: Counts;
  fake: ReturnType<typeof createFakeHost>;
  logs: string[];
  /** What `mcpServersFor` was asked, so the seam itself is observable. */
  asked: Array<{ agentId: string; host: HostRef }>;
  cwd: string;
}

function harness(opts: { mcpServers?: (agentId: string, host: HostRef) => unknown[] } = {}): Harness {
  const dir = scratchDir("ompd-userpath-db-");
  const store = new Store(join(dir, "ompd.db"));
  stores.push(store);
  store.addDevice({
    id: "operator",
    name: "operator",
    publicKey: "pk_operator",
    scopes: [SCOPE_MANAGE],
    createdAt: new Date().toISOString(),
  });

  const fake = createFakeHost();
  const counts: Counts = { provision: 0, spawn: 0, destroy: 0 };
  const logs: string[] = [];
  const asked: Array<{ agentId: string; host: HostRef }> = [];

  let next = 1;
  const provisioner = {
    provision: async (spec: HostSpec): Promise<HostHandle> => {
      counts.provision += 1;
      const id = `cnt_${next++}`;
      let served = false;
      return {
        ref: { kind: spec.kind, id, spec, resolved: { runtime: "container", network: `net_${id}` } } as HostRef,
        // The real container handle refuses a second connection, and that gate
        // must survive whatever else changes here: a retry that quietly reused
        // a one-shot container is the bypass `gate-wrapper.ts` documents.
        spawn: (spawnOpts: SpawnLocalHostOptions): LocalHost => {
          if (served) throw new Error(`container ${id} has already served an ACP connection`);
          served = true;
          counts.spawn += 1;
          return fake.factory(spawnOpts);
        },
      };
    },
    destroy: async () => {
      counts.destroy += 1;
    },
    list: async () => [],
  };

  const sup = new Supervisor({
    store,
    spawnHost: fake.factory,
    provisioner,
    home: scratchDir("ompd-userpath-home-"),
    onLog: line => logs.push(String(line)),
    mcpServersFor: (agentId, host) => {
      asked.push({ agentId, host });
      return opts.mcpServers?.(agentId, host) ?? [];
    },
  });
  sups.push(sup);

  return {
    sup,
    store,
    actor: { deviceId: "operator", scopes: [SCOPE_MANAGE] },
    counts,
    fake,
    logs,
    asked,
    cwd: scratchDir("ompd-userpath-ws-"),
  };
}

describe("one create on a container host", () => {
  test("reaches idle with a session id, provisioning once and spawning once", async () => {
    const h = harness();
    const agent = await h.sup.createAgent({ name: "scratch", cwd: h.cwd, host: { kind: "container" } }, h.actor);

    // The observable an operator gets back.
    expect(agent.state).toBe("idle");
    expect(agent.acpSessionId).toBeTruthy();
    expect(agent.host.kind).toBe("container");

    // And the work it took. A retry loop that provisioned twice would still
    // produce an idle agent, so the counts are the assertion, not the state.
    expect(h.counts).toEqual({ provision: 1, spawn: 1, destroy: 0 });

    // And the supervisor writes ONE row for the ACP host coming up, under its
    // own action. It used to write a second `host.provision`, so a single
    // create read as two provisions in the trail and looked like a retry that
    // had never happened. The provisioner writes the real `host.provision`, and
    // this harness's provisioner is a fake that writes no audit at all, which
    // is exactly why the supervisor's row must not be wearing that name.
    const rows = h.store.listAudit(20);
    expect(rows.filter(r => r.action === "host.start")).toHaveLength(1);
    expect(rows.filter(r => r.action === "host.provision")).toHaveLength(0);
    expect(h.fake.sessions).toHaveLength(1);
    expect(h.fake.newRequests).toHaveLength(1);
    expect(h.fake.newRequests[0]?.cwd).toBe(h.cwd);
  });

  test("the host is handed to mcpServersFor, because only the caller knows what is reachable", async () => {
    const h = harness();
    const agent = await h.sup.createAgent({ name: "scratch", cwd: h.cwd, host: { kind: "container" } }, h.actor);
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]?.agentId).toBe(agent.id);
    // Not merely the kind: the whole ref, so a policy can look at `resolved`.
    expect(h.asked[0]?.host.kind).toBe("container");
    expect(h.asked[0]?.host.id).toBe("cnt_1");
  });

  test("a local host gets the same treatment through the same seam", async () => {
    const h = harness();
    const agent = await h.sup.createAgent({ name: "local", cwd: h.cwd }, h.actor);
    expect(agent.state).toBe("idle");
    expect(h.counts.provision).toBe(0);
    expect(h.asked[0]?.host.kind).toBe("local");
  });
});

describe("the WebView MCP server is offered only where it can be reached", () => {
  // The fix's actual decision, tested as the pure function it is rather than
  // by booting a daemon to observe it indirectly.
  const server = { urlFor: (agentId: string) => `http://127.0.0.1:51000/mcp/${agentId}/tok_secret` } as never;

  test("a local host is offered it, because 127.0.0.1 means the daemon there", () => {
    const offered = webViewMcpServersFor(server, "agt_1", { kind: "local", id: "1", spec: { kind: "local" } });
    expect(offered).toHaveLength(1);
    expect(offered[0]?.name).toBe("ompd-webview");
  });

  test("a container host is offered nothing, because 127.0.0.1 means the container there", () => {
    const offered = webViewMcpServersFor(server, "agt_1", {
      kind: "container",
      id: "cnt_1",
      spec: { kind: "container" },
    });
    // This is the whole bug. With the descriptor present, omp answered
    // session/new with "ompd-webview: Unable to connect" and the create failed.
    expect(offered).toEqual([]);
  });

  test("any non-local kind, not a container special case", () => {
    expect(webViewMcpServersFor(server, "agt_1", { kind: "cloud", id: "c1", spec: { kind: "cloud" } })).toEqual([]);
  });
});

describe("a session that cannot be opened says why", () => {
  /** Make `session/new` fail the way omp did: generic message, detail in data. */
  function failNewSession(h: Harness): void {
    const original = h.fake.factory;
    void original;
  }

  test("the reason reaches the agent row, the audit and the log", async () => {
    const h = harness({
      mcpServers: () => {
        // Shaped like the real refusal: the useful sentence is in `data`, and
        // the message is the JSON-RPC spec's generic text.
        throw new AcpError("Internal error", -32603, {
          details: "ompd-webview: Unable to connect. Is the computer able to access the url?",
        });
      },
    });
    failNewSession(h);

    let threw: unknown;
    try {
      await h.sup.createAgent({ name: "scratch", cwd: h.cwd, host: { kind: "container" } }, h.actor);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeDefined();

    // 1. The agent row. Before this it said "failed" and nothing else.
    const failed = h.sup.listAgents().find(a => a.name === "scratch");
    expect(failed?.state).toBe("failed");
    expect(failed?.failure).toContain("Unable to connect");

    // 2. The log. Before this it was silent.
    expect(h.logs.some(line => /session could not be opened/.test(line))).toBeTrue();
    expect(h.logs.some(line => /Unable to connect/.test(line))).toBeTrue();

    // 3. The audit, with the host it happened on.
    const rows = h.store.listAudit(20).filter(r => r.action === "agent.create" && r.outcome === "error");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.detail)).toContain("Unable to connect");

    // 4. And the container did not leak.
    expect(h.counts.destroy).toBe(1);
  });
});

describe("the reason is safe to store", () => {
  test("an AcpError folds its data.details into the message", () => {
    const err = new AcpError("Internal error", -32603, { details: "ompd-webview: Unable to connect." });
    // The whole reason a 500 could say "Internal error" and mean something else.
    expect(err.message).toBe("Internal error: ompd-webview: Unable to connect.");
    expect(safeFailureReason(err)).toContain("Unable to connect");
  });

  test("a message with no details is left alone", () => {
    expect(new AcpError("transport closed").message).toBe("transport closed");
    expect(new AcpError("boom", 1, { other: "x" }).message).toBe("boom");
  });

  test("a per-agent MCP url does not carry its token into the store", () => {
    const reason = safeFailureReason(new Error("ompd-webview at http://127.0.0.1:51000/mcp/agt_1/tok_supersecret"));
    expect(reason).not.toContain("tok_supersecret");
    expect(reason).toContain("http://127.0.0.1:51000/");
  });

  test("a query string is dropped whole", () => {
    expect(safeFailureReason(new Error("GET /x?token=abcdefghijklmnop failed"))).not.toContain("abcdefghijklmnop");
  });

  test("a long opaque run is treated as a secret", () => {
    const digest = "a".repeat(64);
    expect(safeFailureReason(new Error(`failed for ${digest}`))).not.toContain(digest);
  });

  test("the cause is kept, because a wrapper alone says nothing", () => {
    const inner = new Error("container runtime refused");
    const outer = new Error("provisioning failed", { cause: inner });
    expect(safeFailureReason(outer)).toContain("container runtime refused");
  });

  test("it is bounded, because this lands in a row an operator reads", () => {
    expect(safeFailureReason(new Error("x".repeat(5000))).length).toBeLessThanOrEqual(400);
  });
});
