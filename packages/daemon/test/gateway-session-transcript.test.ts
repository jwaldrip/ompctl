/**
 * Tests for GET /v1/sessions/:id/transcript.
 *
 * Covers scope enforcement (read scope required), 503 when the session index is
 * unavailable, 404 for unknown sessions, 400 for invalid before cursor, and 200
 * with transcript entries and pagination cursors.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultPolicy, SCOPE_PROMPT, SCOPE_READ, Store } from "@ompd/core";
import { Gateway, GatewayEvents } from "../src/gateway/index.ts";
import { HostRegistry } from "../src/hosts.ts";
import { SessionIndex } from "../src/sessions/index.ts";
import { Supervisor } from "../src/supervisor.ts";
import { createFakeHost } from "./fake-host.ts";

const paths: string[] = [];
const stores: Store[] = [];
const gateways: Gateway[] = [];
const scratchDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function writeSessionTranscript(
  sessionsRoot: string,
  flattenedDir: string,
  filenameTimestamp: string,
  sessionId: string,
  messages: Array<{ role: "user" | "assistant"; text: string; at?: string }>,
): string {
  const groupDir = join(sessionsRoot, flattenedDir);
  mkdirSync(groupDir, { recursive: true });
  const lines: unknown[] = [
    { type: "title", v: 1, title: "test session", updatedAt: new Date().toISOString() },
    { type: "session", version: 3, id: sessionId, timestamp: "2026-08-13T00:00:00.000Z", cwd: "/test" },
  ];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    lines.push({
      type: "message",
      id: `msg_${i}`,
      timestamp: m.at ?? `2026-08-13T00:00:0${i}.000Z`,
      message: { role: m.role, content: [{ type: "text", text: m.text }] },
    });
  }
  const filePath = join(groupDir, `${filenameTimestamp}_${sessionId}.jsonl`);
  writeFileSync(filePath, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);
  return filePath;
}

interface Harness {
  base: string;
  pair(scopes: string[]): Promise<string>;
  http(path: string, init?: RequestInit, token?: string): Promise<Response>;
  gateway: Gateway;
  store: Store;
  sessionsRoot: string;
}

async function harness(opts: { withSessionIndex?: boolean } = {}): Promise<Harness> {
  const withSessionIndex = opts.withSessionIndex ?? true;
  const dbPath = join(tempDir("gw-transcript-db-"), "ompd.db");
  paths.push(dbPath);
  const store = new Store(dbPath);
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

  const sessionsRoot = tempDir("gw-transcript-tree-");
  const emptyRunRoot = tempDir("gw-transcript-empty-run-");
  const sessionIndex = withSessionIndex
    ? new SessionIndex({ store, sessionsRoot, runDaemonsRoot: emptyRunRoot })
    : undefined;

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    ...(sessionIndex ? { sessionIndex } : {}),
  });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    pair: async scopes => {
      const res = await fetch(`${base}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test-device", publicKey: `pk_${crypto.randomUUID()}` }),
      });
      const body = (await res.json()) as { code?: unknown };
      if (typeof body.code !== "string") throw new Error("pair response carried no code");
      return gw.approvePairing(body.code, scopes);
    },
    http: (path, init = {}, token) => {
      const headers = new Headers(init.headers);
      if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
      return fetch(`${base}${path}`, { ...init, headers });
    },
    gateway: gw,
    store,
    sessionsRoot,
  };
}

afterEach(async () => {
  for (const gw of gateways) await gw.close();
  gateways.length = 0;
  for (const s of stores) s.close();
  stores.length = 0;
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
});

describe("GET /v1/sessions/:id/transcript", () => {
  const SESSION_ID = "019fee60-2c7a-7000-9fd5-7439c7bf3dd2";

  test("requires the read scope", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_PROMPT]); // holds prompt, not read
    const res = await h.http(`/v1/sessions/${SESSION_ID}/transcript`, {}, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("returns 503 when session index is unavailable", async () => {
    const h = await harness({ withSessionIndex: false });
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http(`/v1/sessions/${SESSION_ID}/transcript`, {}, token);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("sessions_unavailable");
  });

  test("returns 404 for an unknown session", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);
    const res = await h.http("/v1/sessions/nonexistent-session/transcript", {}, token);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("session_not_found");
  });

  test("returns 200 with transcript entries for a valid session", async () => {
    const h = await harness();
    writeSessionTranscript(h.sessionsRoot, "-test", "2026-08-13T00-00-00-000Z", SESSION_ID, [
      { role: "user", text: "hello world" },
      { role: "assistant", text: "hello back from assistant" },
    ]);

    const token = await h.pair([SCOPE_READ]);
    const res = await h.http(`/v1/sessions/${SESSION_ID}/transcript`, {}, token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sessionId: string;
      entries: Array<{ role?: string; text?: string }>;
      truncated: boolean;
      nextCursor: number | null;
    };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
    expect(body.entries[0]?.role).toBe("user");
    expect(body.entries[0]?.text).toBe("hello world");
    expect(body.entries[1]?.role).toBe("assistant");
    expect(body.entries[1]?.text).toBe("hello back from assistant");
  });

  test("rejects invalid before cursor with 400", async () => {
    const h = await harness();
    writeSessionTranscript(h.sessionsRoot, "-test", "2026-08-13T00-00-00-000Z", SESSION_ID, [
      { role: "user", text: "hello" },
    ]);

    const token = await h.pair([SCOPE_READ]);
    const res = await h.http(`/v1/sessions/${SESSION_ID}/transcript?before=-1`, {}, token);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_before_cursor");
  });

  test("resolves agentId to session id when session is held by an agent", async () => {
    const h = await harness();
    writeSessionTranscript(h.sessionsRoot, "-test", "2026-08-13T00-00-00-000Z", SESSION_ID, [
      { role: "user", text: "prompt for agent" },
      { role: "assistant", text: "agent response" },
    ]);

    const agentId = "agt_0123456789abcdef";
    h.store.upsertAgent({
      id: agentId,
      name: "test-agent",
      cwd: "/test",
      host: { kind: "local", id: "lcl_1", spec: { kind: "local" } },
      acpSessionId: SESSION_ID,
      createdAt: "2026-08-13T00:00:00.000Z",
      lastActiveAt: "2026-08-13T00:00:00.000Z",
      state: "idle",
      labels: {},
    });

    const token = await h.pair([SCOPE_READ]);
    const res = await h.http(`/v1/sessions/${agentId}/transcript`, {}, token);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sessionId: string;
      entries: Array<{ role?: string; text?: string }>;
    };
    expect(body.sessionId).toBe(SESSION_ID);
    expect(body.entries.length).toBeGreaterThanOrEqual(2);
  });
});
