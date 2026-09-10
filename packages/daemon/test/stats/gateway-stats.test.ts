import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { SCOPE_READ, Store } from "@ompd/core";
import type { DashboardStats } from "@ompd/core/contracts";
import { Gateway } from "../../src/gateway/gateway.ts";
import { SessionIndex } from "../../src/sessions/session-index.ts";
import { StatsSubsystem } from "../../src/stats/index.ts";
import { Supervisor } from "../../src/supervisor.ts";

const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const g of gateways) await g.close();
  gateways.length = 0;
  for (const d of scratchDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
  scratchDirs.length = 0;
});

async function makeHarness(sessionsRoot: string): Promise<{
  url: string;
  token: string;
  gateway: Gateway;
  stats: StatsSubsystem;
}> {
  const dbDir = tempDir("gw-stats-db-");
  const store = new Store(join(dbDir, "ompd.db"));
  const supervisor = new Supervisor({ store, home: dbDir });
  const index = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: tempDir("run-") });
  const stats = new StatsSubsystem({ sessionsRoot, statsDbPath: join(dbDir, "stats.db") });
  const gateway = new Gateway({
    store,
    supervisor,
    sessionIndex: index,
    stats,
  });
  gateways.push(gateway);
  const port = await gateway.listen();
  const base = `http://127.0.0.1:${port}`;

  const pairRes = await fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
  });
  const pairBody = (await pairRes.json()) as { code: string };
  const token = gateway.approvePairing(pairBody.code, [SCOPE_READ]);

  return {
    url: base,
    token,
    gateway,
    stats,
  };
}

describe("gateway stats endpoints", () => {
  test("the dashboard is omp's own home's to serve, and a daemon on another root says so", async () => {
    // `@oh-my-pi/omp-stats` aggregates exactly one tree, omp's own sessions
    // directory. Before 2026-09-07 a gateway built its own subsystem and
    // synced that real home from every harness that built a gateway, which
    // crashed the daemon suite under --parallel and served one home's
    // figures for another. A foreign root now refuses with the reason.
    const sessionsRoot = tempDir("gw-sessions-");
    const h = await makeHarness(sessionsRoot);
    expect(h.stats.available).toBe(false);
    expect(new StatsSubsystem().available).toBe(true);
    expect(new StatsSubsystem({ sessionsRoot: getSessionsDir() }).available).toBe(true);

    const res = await fetch(`${h.url}/v1/stats?range=7d`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("stats_unavailable");
    expect(body.reason).toContain(sessionsRoot);
    expect(body.reason).toContain(getSessionsDir());
  });

  test("a gateway with no stats subsystem answers the session stats route with stats_unavailable", async () => {
    const dbDir = tempDir("gw-nostats-");
    const store = new Store(join(dbDir, "ompd.db"));
    const supervisor = new Supervisor({ store, home: dbDir });
    const gateway = new Gateway({ store, supervisor });
    gateways.push(gateway);
    const port = await gateway.listen();
    const base = `http://127.0.0.1:${port}`;
    const pairRes = await fetch(`${base}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
    });
    const token = gateway.approvePairing(((await pairRes.json()) as { code: string }).code, [SCOPE_READ]);
    const res = await fetch(`${base}/v1/sessions/019fee60-2c7a-7000-9fd5-7439c7bf3dd2/stats`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("stats_unavailable");
  });

  test("GET /v1/sessions/:id/stats returns per-session stats from JSONL", async () => {
    const sessionsRoot = tempDir("gw-sessions-2-");
    const sessionId = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";
    const groupDir = join(sessionsRoot, "-myproject");
    mkdirSync(groupDir, { recursive: true });

    const filePath = join(groupDir, `2026-08-11T01-11-48-090Z_${sessionId}.jsonl`);
    writeFileSync(
      filePath,
      `${[
        JSON.stringify({ type: "session", title: "Project S", cwd: "/myproject" }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            stopReason: "end_turn",
            usage: {
              input: 120,
              output: 40,
              cacheRead: 240,
              cacheWrite: 0,
              cost: { total: 0.055 },
            },
          },
        }),
      ].join("\n")}\n`,
    );

    const h = await makeHarness(sessionsRoot);

    const res = await fetch(`${h.url}/v1/sessions/${sessionId}/stats`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });

    expect(res.status).toBe(200);
    const stats = (await res.json()) as any;
    expect(stats.cost).toBe(0.055);
    expect(stats.tokens.input).toBe(120);
    expect(stats.tokens.output).toBe(40);
    expect(stats.tokens.cacheRead).toBe(240);
    expect(stats.cacheRate).toBe(240 / (120 + 240)); // 240/360 = 0.6667
    expect(stats.calls).toBe(1);
    expect(stats.errors).toBe(0);
  });

  test("GET /v1/sessions/:id/stats returns 404 for unknown session", async () => {
    const sessionsRoot = tempDir("gw-sessions-3-");
    const h = await makeHarness(sessionsRoot);

    const res = await fetch(`${h.url}/v1/sessions/nonexistent-id/stats`, {
      headers: { Authorization: `Bearer ${h.token}` },
    });

    expect(res.status).toBe(404);
  });

  test("stats frame answers with the same numbers as HTTP /v1/stats for the same range, and refuses without read", async () => {
    const dbDir = tempDir("gw-stats-ws-");
    const store = new Store(join(dbDir, "ompd.db"));
    const supervisor = new Supervisor({ store, home: dbDir });
    const expectedStats: DashboardStats = {
      overall: {
        totalRequests: 42,
        successfulRequests: 40,
        failedRequests: 2,
        errorRate: 2 / 42,
        totalInputTokens: 1000,
        totalOutputTokens: 200,
        totalCacheReadTokens: 500,
        totalCacheWriteTokens: 50,
        cacheRate: 500 / 1500,
        totalCost: 1.23,
        totalPremiumRequests: 0,
        avgDuration: 1200,
        avgTtft: 450,
        avgTokensPerSecond: 35,
        firstTimestamp: 1000,
        lastTimestamp: 2000,
      },
      byModel: [],
      byFolder: [],
      byAgentType: [],
      timeSeries: [],
      modelSeries: [],
      modelPerformanceSeries: [],
      costSeries: [],
    };
    const mockStats = {
      available: true,
      start() {},
      stop() {},
      sync: async () => {},
      getDashboardStats: async () => expectedStats,
      getSessionStats: async () => null,
    } as unknown as StatsSubsystem;

    const gateway = new Gateway({ store, supervisor, stats: mockStats });
    gateways.push(gateway);
    const port = await gateway.listen();

    const pairWith = async (name: string, scopes: string[]): Promise<string> => {
      const pairRes = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const pairBody = (await pairRes.json()) as { code: string };
      return gateway.approvePairing(pairBody.code, scopes);
    };

    const readToken = await pairWith("reader", [SCOPE_READ]);
    const noReadToken = await pairWith("no-reader", []);

    // 1. HTTP returns expectedStats
    const httpRes = await fetch(`http://127.0.0.1:${port}/v1/stats?range=7d`, {
      headers: { Authorization: `Bearer ${readToken}` },
    });
    expect(httpRes.status).toBe(200);
    const httpData = (await httpRes.json()) as DashboardStats;
    expect(httpData.overall.totalCost).toBe(1.23);

    const nextMessage = (ws: WebSocket): Promise<Record<string, unknown>> => {
      const deferred = Promise.withResolvers<Record<string, unknown>>();
      const handler = (ev: MessageEvent) => {
        const parsed: unknown = JSON.parse(String(ev.data));
        if (parsed && typeof parsed === "object") {
          const rec = parsed as Record<string, unknown>;
          if (rec.t === "hello") return;
          ws.removeEventListener("message", handler);
          deferred.resolve(rec);
        }
      };
      ws.addEventListener("message", handler);
      return deferred.promise;
    };
    // 2. WS with read scope
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(readToken)}`);
    const opened = Promise.withResolvers<boolean>();
    ws.addEventListener("open", () => opened.resolve(true));
    expect(await opened.promise).toBe(true);

    const replyPromise = nextMessage(ws);
    ws.send(JSON.stringify({ t: "stats", range: "7d" }));
    const reply = await replyPromise;

    expect(reply.t).toBe("stats");
    expect(reply.stats).toEqual(httpData);
    ws.close();

    // 3. WS without read scope
    const wsNoRead = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(noReadToken)}`);
    const openedNoRead = Promise.withResolvers<boolean>();
    wsNoRead.addEventListener("open", () => openedNoRead.resolve(true));
    expect(await openedNoRead.promise).toBe(true);

    const replyNoReadPromise = nextMessage(wsNoRead);
    wsNoRead.send(JSON.stringify({ t: "stats", range: "7d" }));
    const replyNoRead = await replyNoReadPromise;

    expect(replyNoRead.t).toBe("error");
    expect(replyNoRead.code).toBe("unauthorized");
    wsNoRead.close();
  });
});
