/**
 * Tests for artifact bytes serving and session artifact enumeration.
 *
 * Exercises:
 * 1. a file inside an allowed root serves with sniffed content type (png, html, md, octet-stream);
 * 2. "../" traversal refuses with out_of_roots;
 * 3. a symlink pointing outside refuses with out_of_roots;
 * 4. an oversized file refuses by name (file_too_large) rather than truncating;
 * 5. a range request returns the right slice and status (206, Content-Range, Accept-Ranges, 416 on unsatisfiable);
 * 6. an unauthorized scope refuses (no token -> 401, missing read scope -> 403);
 * 7. the artifact listing finds a session's reports (<Name>.md and other artifacts).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactReference,
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
import { SessionIndex } from "../src/sessions/index.ts";
import { subagentDirFor } from "../src/sessions/subagents.ts";
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

interface ErrorResponse {
  error: string;
  message?: string;
}

interface SocketClient {
  frames: ServerFrame[];
  send(frame: ClientFrame): void;
  next(match: (frame: ServerFrame) => boolean, label: string): Promise<ServerFrame>;
  close(): void;
}

interface Harness {
  port: number;
  base: string;
  allowedRoot: string;
  outsideRoot: string;
  sessionsRoot: string;
  sessionId: string;
  sessionIndex: SessionIndex;
  pair(scopes: string[]): Promise<string>;
  http(path: string, init?: RequestInit, token?: string): Promise<Response>;
  connect(token: string): Promise<SocketClient>;
}

async function harness(opts: { byteCeiling?: number } = {}): Promise<Harness> {
  const dbPath = join(tempDir("gw-artifacts-db-"), "ompd.db");
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

  const allowedRoot = tempDir("gw-allowed-root-");
  const outsideRoot = tempDir("gw-outside-root-");
  const sessionsRoot = tempDir("gw-sessions-root-");
  const runRoot = tempDir("gw-run-root-");
  const sessionIndex = new SessionIndex({ store, sessionsRoot, runDaemonsRoot: runRoot });

  const sessionId = "019fee60-2c7a-7000-9fd5-7439c7bf3aa1";

  // Create session file
  const groupDir = join(sessionsRoot, "-work");
  mkdirSync(groupDir, { recursive: true });
  const sessionFilePath = join(groupDir, `2026-08-10T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(
    sessionFilePath,
    `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "t", cwd: "/work" })}\n`,
  );

  // Create session artifact directory
  const artifactDir = subagentDirFor(sessionFilePath);
  mkdirSync(artifactDir, { recursive: true });

  const gw = new Gateway({
    supervisor: sup,
    store,
    events,
    port: 0,
    sessions: hosts,
    sessionIndex,
    artifactRoots: [allowedRoot],
    sessionsRoot,
    ...(opts.byteCeiling !== undefined ? { artifactByteCeiling: opts.byteCeiling } : {}),
  });
  gateways.push(gw);
  const port = await gw.listen();
  const base = `http://127.0.0.1:${port}`;

  let nextDevId = 1;
  const pair = async (scopes: string[]): Promise<string> => {
    const devId = `dev_${nextDevId++}`;
    store.addDevice({
      id: devId,
      name: devId,
      publicKey: `pk_${devId}`,
      scopes,
      createdAt: new Date().toISOString(),
    });
    return gw.issueToken(devId);
  };

  const http = (routePath: string, init: RequestInit = {}, token?: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${base}${routePath}`, { ...init, headers });
  };

  const connect = async (token: string): Promise<SocketClient> => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/socket?token=${encodeURIComponent(token)}`);
    const opened = Promise.withResolvers<boolean>();
    const frames: ServerFrame[] = [];
    let cursor = 0;
    let pending: { check: () => boolean; settle: (frame: ServerFrame | null) => void } | null = null;

    const drain = (): void => {
      if (!pending) return;
      if (!pending.check()) return;
      const waiter = pending;
      pending = null;
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

    return {
      frames,
      send: frame => ws.send(JSON.stringify(frame)),
      next: (match, _label) => {
        const settled = Promise.withResolvers<ServerFrame>();
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
        };
        drain();
        return settled.promise;
      },
      close: () => ws.close(),
    };
  };

  return {
    port,
    base,
    allowedRoot,
    outsideRoot,
    sessionsRoot,
    sessionId,
    sessionIndex,
    pair,
    http,
    connect,
  };
}

afterEach(() => {
  while (gateways.length) gateways.pop()?.close();
  while (stores.length) stores.pop()?.close();
  while (paths.length) rmSync(paths.pop() ?? "", { force: true });
  while (scratchDirs.length) rmSync(scratchDirs.pop() ?? "", { recursive: true, force: true });
});

describe("artifact bytes and session artifacts", () => {
  test("a file inside an allowed root serves with sniffed content type", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);

    // 1. PNG file
    const pngPath = join(h.allowedRoot, "image.dat"); // .dat extension to prove sniffing ignores extension
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    writeFileSync(pngPath, pngBytes);

    const pngRes = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(pngPath)}`, {}, token);
    expect(pngRes.status).toBe(200);
    expect(pngRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await pngRes.arrayBuffer())).toEqual(pngBytes);

    // 2. HTML file
    const htmlPath = join(h.allowedRoot, "page.bin");
    const htmlContent = "<!DOCTYPE html><html><body><h1>Title</h1></body></html>";
    writeFileSync(htmlPath, htmlContent);

    const htmlRes = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(htmlPath)}`, {}, token);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await htmlRes.text()).toBe(htmlContent);

    // 3. Markdown report
    const mdPath = join(h.allowedRoot, "report.unknown");
    const mdContent = "# Subagent Report\n\n- Fact 1\n- Fact 2\n";
    writeFileSync(mdPath, mdContent);

    const mdRes = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(mdPath)}`, {}, token);
    expect(mdRes.status).toBe(200);
    expect(mdRes.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await mdRes.text()).toBe(mdContent);

    // 4. Binary file with no known signature falls back to application/octet-stream
    const binPath = join(h.allowedRoot, "data.unknown");
    const binBytes = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
    writeFileSync(binPath, binBytes);

    const binRes = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(binPath)}`, {}, token);
    expect(binRes.status).toBe(200);
    expect(binRes.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await binRes.arrayBuffer())).toEqual(binBytes);
  });

  test("../ traversal refuses", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);

    const secretPath = join(h.outsideRoot, "secret.txt");
    writeFileSync(secretPath, "top-secret");

    // Traversal via ../
    const traversalPath = join(h.allowedRoot, "../", outsideRootBase(h.outsideRoot), "secret.txt");
    const res = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(traversalPath)}`, {}, token);

    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toBe("out_of_roots");
  });

  test("a symlink pointing outside refuses", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);

    const targetFile = join(h.outsideRoot, "target.txt");
    writeFileSync(targetFile, "outside content");

    const symlinkPath = join(h.allowedRoot, "symlink-outside.txt");
    symlinkSync(targetFile, symlinkPath);

    const res = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(symlinkPath)}`, {}, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toBe("out_of_roots");
  });

  test("a sibling directory sharing the root's name prefix refuses", async () => {
    // The root is a path, not a string prefix. A sibling named by extending
    // the root's own name is the escape a naive startsWith lets through, and
    // it needs no traversal and no symlink to reach: anything that can write
    // beside an allowed root can then read back out of it. Containment is
    // only a guard if the separator is part of the comparison.
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);

    const sibling = `${h.allowedRoot}-evil`;
    mkdirSync(sibling, { recursive: true });
    scratchDirs.push(sibling);
    const leaked = join(sibling, "secret.txt");
    writeFileSync(leaked, "top-secret");

    const res = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(leaked)}`, {}, token);
    expect(res.status).toBe(403);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toBe("out_of_roots");
  });

  test("an oversized file refuses by name rather than truncating", async () => {
    // Harness with 1024 byte ceiling
    const h = await harness({ byteCeiling: 1024 });
    const token = await h.pair([SCOPE_READ]);

    const largeFile = join(h.allowedRoot, "large.bin");
    writeFileSync(largeFile, new Uint8Array(2048));

    const res = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(largeFile)}`, {}, token);
    expect(res.status).toBe(413);
    const body = (await res.json()) as ErrorResponse;
    expect(body.error).toBe("file_too_large");
  });

  test("a range request returns the right slice and status", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);

    const filePath = join(h.allowedRoot, "video.mp4");
    // Write 100 bytes of mock video data starting with ftyp box
    const data = new Uint8Array(100);
    // ftyp header
    data[4] = 0x66;
    data[5] = 0x74;
    data[6] = 0x79;
    data[7] = 0x70;
    data[8] = 0x69;
    data[9] = 0x73;
    data[10] = 0x6f;
    data[11] = 0x6d;
    for (let i = 12; i < 100; i++) data[i] = i;
    writeFileSync(filePath, data);

    // Range request for bytes 10-19 (10 bytes total)
    const rangeRes = await h.http(
      `/v1/artifacts/bytes?path=${encodeURIComponent(filePath)}`,
      { headers: { range: "bytes=10-19" } },
      token,
    );

    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get("content-type")).toBe("video/mp4");
    expect(rangeRes.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(rangeRes.headers.get("content-length")).toBe("10");
    expect(rangeRes.headers.get("accept-ranges")).toBe("bytes");

    const slice = new Uint8Array(await rangeRes.arrayBuffer());
    expect(slice).toEqual(data.subarray(10, 20));

    // Suffix range request: bytes=-20 (last 20 bytes)
    const suffixRes = await h.http(
      `/v1/artifacts/bytes?path=${encodeURIComponent(filePath)}`,
      { headers: { range: "bytes=-20" } },
      token,
    );
    expect(suffixRes.status).toBe(206);
    expect(suffixRes.headers.get("content-range")).toBe("bytes 80-99/100");
    expect(suffixRes.headers.get("content-length")).toBe("20");
    expect(new Uint8Array(await suffixRes.arrayBuffer())).toEqual(data.subarray(80, 100));

    // Unsatisfiable range request: bytes=200-300
    const unsatRes = await h.http(
      `/v1/artifacts/bytes?path=${encodeURIComponent(filePath)}`,
      { headers: { range: "bytes=200-300" } },
      token,
    );
    expect(unsatRes.status).toBe(416);
    expect(unsatRes.headers.get("content-range")).toBe("bytes */100");
    const unsatBody = (await unsatRes.json()) as ErrorResponse;
    expect(unsatBody.error).toBe("range_not_satisfiable");
  });

  test("an unauthorized scope refuses", async () => {
    const h = await harness();
    const filePath = join(h.allowedRoot, "file.txt");
    writeFileSync(filePath, "content");

    // 1. No token at all -> 401
    const noTokenRes = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(filePath)}`);
    expect(noTokenRes.status).toBe(401);

    // 2. Token without read scope (e.g. only prompt and manage) -> 403
    const writeOnlyToken = await h.pair([SCOPE_PROMPT, SCOPE_MANAGE]);
    const noReadRes = await h.http(`/v1/artifacts/bytes?path=${encodeURIComponent(filePath)}`, {}, writeOnlyToken);
    expect(noReadRes.status).toBe(403);
    const noReadBody = (await noReadRes.json()) as ErrorResponse;
    expect(noReadBody.error).toBe("forbidden");
  });

  test("the artifact listing finds a session's reports", async () => {
    const h = await harness();
    const token = await h.pair([SCOPE_READ]);

    // In the session's artifact directory, create subagent report and another artifact
    const sessionPath =
      (await h.sessionIndex.pathFor(h.sessionId)) ??
      join(h.sessionsRoot, "-work", `2026-08-10T00-00-00-000Z_${h.sessionId}.jsonl`);
    const artDir = subagentDirFor(sessionPath);

    // Report markdown
    const reportPath = join(artDir, "ScoutReport.md");
    writeFileSync(reportPath, "# Scout Findings\n\nAll clear.");

    // Subagent JSONL transcript (should NOT be in artifact list)
    writeFileSync(join(artDir, "ScoutReport.jsonl"), '{"type":"session","id":"s1"}\n');

    // An image artifact produced by the session
    const imgPath = join(artDir, "chart.png");
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    writeFileSync(imgPath, pngBytes);

    const client = await h.connect(token);
    client.send({ t: "session_artifacts", sessionId: h.sessionId });

    type SessionArtifactsFrame = Extract<ServerFrame, { t: "session_artifacts" }>;
    const frame = (await client.next(
      f => f.t === "session_artifacts" || (f.t === "error" && f.sessionId === h.sessionId),
      "session_artifacts response",
    )) as SessionArtifactsFrame;

    expect(frame.t).toBe("session_artifacts");
    expect(frame.sessionId).toBe(h.sessionId);
    expect(Array.isArray(frame.artifacts)).toBe(true);

    const names = frame.artifacts.map(a => a.name);
    expect(names).toContain("ScoutReport.md");
    expect(names).toContain("chart.png");
    expect(names).not.toContain("ScoutReport.jsonl");

    const reportArt = frame.artifacts.find(a => a.name === "ScoutReport.md") as ArtifactReference;
    expect(reportArt.contentType).toBe("text/markdown; charset=utf-8");
    expect(reportArt.origin).toBe("session");
    expect(reportArt.byteSize).toBeGreaterThan(0);

    const imgArt = frame.artifacts.find(a => a.name === "chart.png") as ArtifactReference;
    expect(imgArt.contentType).toBe("image/png");
    expect(imgArt.origin).toBe("session");

    client.close();
  });
});

function outsideRootBase(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}
