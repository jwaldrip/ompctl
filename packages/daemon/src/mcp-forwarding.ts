/**
 * Forward operator-configured MCP servers into daemon-created ACP sessions.
 *
 * Upstream OMP disables on-disk MCP discovery for ACP sessions so the ACP
 * client has exclusive ownership of the session's tool registry (issue #1234).
 * The daemon is that client. This module discovers the operator's configured
 * MCP servers, pre-flights each candidate to isolate fast failures, drops
 * servers colliding with daemon-reserved names, and converts the survivors
 * into ACP wire descriptors.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { McpServer } from "@oh-my-pi/pi-utils/acp";
import type { HostRef } from "@ompd/core";

/**
 * Server names reserved by the daemon.
 *
 * ompd-webview: The daemon owns browser tool approval and per-agent tokens.
 *
 * ompctl: The orchestration server is gated strictly behind role: orchestrator
 * on local hosts (PR #217). An operator who ran ompd mcp install has ompctl in
 * ~/.omp/agent/mcp.json. Forwarding that entry to an unlabelled session would bypass
 * the gate, because for an ordinary session the daemon contributes no ompctl of its
 * own to win the collision. Dropping reserved names unconditionally ensures the label
 * gate cannot be weakened by on-disk configuration.
 */
export const DAEMON_RESERVED_MCP_SERVERS: Record<string, true> = {
  "ompd-webview": true,
  ompctl: true,
};

/**
 * Default connection budget for candidate pre-flights in milliseconds.
 * Matches OMP's internal startup race window so dead servers fail here
 * rather than in the ACP session factory.
 */
export const DEFAULT_PREFLIGHT_TIMEOUT_MS = 250;

/**
 * Check whether a stdio command exists and is marked executable.
 *
 * For commands containing a path separator, checks the path directly. For bare
 * command names, searches each directory listed in PATH. Directories, missing
 * files, and non-executable files return false.
 */
export function isCommandExecutable(command: string, envPath?: string): boolean {
  if (!command || typeof command !== "string") return false;
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;

  if (trimmed.includes("/") || trimmed.includes("\\")) {
    try {
      const target = isAbsolute(trimmed) ? trimmed : resolve(trimmed);
      accessSync(target, constants.X_OK);
      return statSync(target).isFile();
    } catch {
      return false;
    }
  }

  const pathEnv = envPath ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  const dirs = pathEnv.split(":");
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, trimmed);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return true;
    } catch {
      // Continue searching next directory on PATH.
    }
  }
  return false;
}

/**
 * Probe a TCP host and port with a strict deadline.
 *
 * Used for network reachability checks. A closed port fails fast with ECONNREFUSED,
 * while an unreachable host or dropped packet times out.
 */
export function probeTcp(host: string, port: number, timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS): Promise<boolean> {
  const { promise, resolve: resolveProbe } = Promise.withResolvers<boolean>();
  let settled = false;
  const socket = new Socket();

  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolveProbe(ok);
  };

  socket.setTimeout(timeoutMs);
  socket.once("connect", () => finish(true));
  socket.once("timeout", () => finish(false));
  socket.once("error", () => finish(false));

  try {
    socket.connect(port, host);
  } catch {
    finish(false);
  }
  return promise;
}

/**
 * Probe an HTTP or SSE MCP endpoint.
 *
 * Sends a lightweight initialize probe. Excludes endpoints that return 4xx or 5xx
 * (such as unauthenticated OAuth endpoints that return 401) or suffer connection
 * errors, because those fast failures cause session creation to fail inside OMP.
 */
export async function probeHttpEndpoint(
  url: string,
  headers?: Record<string, string>,
  timeoutMs = DEFAULT_PREFLIGHT_TIMEOUT_MS,
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: `unsupported protocol "${parsed.protocol}"` };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ompd-probe", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 400) {
      return { ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Probe a stdio command to verify it does not exit immediately with an error.
 */
export function probeStdioCommand(
  command: string,
  args: string[] = [],
  env?: Record<string, string>,
  timeoutMs = 150,
): Promise<{ ok: boolean; reason?: string }> {
  if (!isCommandExecutable(command, env?.PATH)) {
    return Promise.resolve({ ok: false, reason: `command "${command}" not found or not executable` });
  }

  const { promise, resolve: resolveProbe } = Promise.withResolvers<{ ok: boolean; reason?: string }>();
  let proc: ChildProcess;
  try {
    proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
    });
  } catch (err) {
    return Promise.resolve({ ok: false, reason: err instanceof Error ? err.message : String(err) });
  }

  let settled = false;
  const finish = (ok: boolean, reason?: string) => {
    if (settled) return;
    settled = true;
    try {
      proc.kill();
    } catch {}
    resolveProbe({ ok, reason });
  };

  proc.on("error", err => finish(false, err.message));
  proc.on("exit", code => {
    if (code !== 0 && code !== null) {
      finish(false, `process exited with code ${code}`);
    }
  });

  try {
    proc.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "ompd-probe", version: "1.0.0" },
        },
      })}\n`,
    );
  } catch {}

  setTimeout(() => finish(true), timeoutMs);
  return promise;
}

/**
 * Convert an environment or header dictionary into ACP's expected array of pairs.
 */
export function toNameValuePairs(
  source?: Record<string, unknown> | Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  if (!source || typeof source !== "object") return [];
  if (Array.isArray(source)) {
    return source
      .filter(item => item && typeof item === "object" && "name" in item && "value" in item)
      .map(item => ({ name: String(item.name), value: String(item.value) }));
  }
  return Object.entries(source).map(([name, value]) => ({ name, value: String(value) }));
}

export interface ForwardOperatorMcpOptions {
  agentId?: string;
  host: HostRef;
  cwd: string;
  enabled?: boolean;
  timeoutMs?: number;
  onLog?: (line: string) => void;
  loadConfigs?: (cwd: string) => Promise<{ configs: Record<string, MCPServerConfig> }>;
  probeHttp?: (
    url: string,
    headers?: Record<string, string>,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; reason?: string }>;
  probeStdio?: (
    command: string,
    args?: string[],
    env?: Record<string, string>,
    timeoutMs?: number,
  ) => Promise<{ ok: boolean; reason?: string }>;
}

/**
 * Resolve and pre-flight operator-configured MCP servers for an ACP session.
 *
 * Non-local hosts receive no operator servers to prevent host credentials
 * crossing into containers. Local hosts load configs via OMP's resolver,
 * drop reserved names, and pre-flight stdio binaries and network endpoints
 * in parallel so broken servers are withheld without stalling healthy ones.
 */
export async function forwardOperatorMcpServers(opts: ForwardOperatorMcpOptions): Promise<McpServer[]> {
  const { agentId, host, cwd, enabled = true, onLog } = opts;
  const tag = agentId ? `agent ${agentId}: ` : "";

  if (host.kind !== "local") {
    onLog?.(
      `${tag}no operator MCP servers forwarded on this ${host.kind} host. Host credentials and local sockets ` +
        `are confined to the daemon's machine.`,
    );
    return [];
  }

  if (!enabled) {
    onLog?.(`${tag}operator MCP server forwarding is disabled by daemon config (forwardOperatorMcp: false).`);
    return [];
  }

  const loader = opts.loadConfigs ?? (dir => loadAllMCPConfigs(dir));
  let loaded: { configs: Record<string, MCPServerConfig> };
  try {
    loaded = await loader(cwd);
  } catch (err) {
    onLog?.(`${tag}failed to load operator MCP configs: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const entries = Object.entries(loaded.configs ?? {});
  if (entries.length === 0) return [];

  const timeoutMs = opts.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
  const httpChecker = opts.probeHttp ?? probeHttpEndpoint;
  const stdioChecker = opts.probeStdio ?? probeStdioCommand;

  const preflights = entries.map(async ([name, config]): Promise<McpServer | null> => {
    if (DAEMON_RESERVED_MCP_SERVERS[name] === true) {
      onLog?.(`${tag}operator MCP server "${name}" dropped because "${name}" is reserved by the daemon.`);
      return null;
    }

    if (config.type === undefined || config.type === "stdio") {
      const stdio = config;
      const command = stdio.command;
      if (!command || typeof command !== "string" || command.trim().length === 0) {
        onLog?.(`${tag}operator MCP server "${name}" withheld: command is missing or empty.`);
        return null;
      }
      const stringEnv: Record<string, string> | undefined =
        stdio.env && typeof stdio.env === "object"
          ? Object.fromEntries(Object.entries(stdio.env).map(([k, v]) => [k, String(v)]))
          : undefined;
      const probeResult = await stdioChecker(command, stdio.args, stringEnv, 150);
      if (!probeResult.ok) {
        onLog?.(`${tag}operator MCP server "${name}" withheld: ${probeResult.reason ?? "failed stdio probe"}.`);
        return null;
      }
      const descriptor: McpServer = {
        type: "stdio",
        name,
        command,
        env: toNameValuePairs(stdio.env),
      };
      if (Array.isArray(stdio.args)) {
        descriptor.args = stdio.args.map((a: unknown) => String(a));
      }
      return descriptor;
    }

    if (config.type === "http" || config.type === "sse") {
      const remote = config;
      const rawUrl = remote.url;
      if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
        onLog?.(`${tag}operator MCP server "${name}" withheld: url is missing or empty.`);
        return null;
      }
      const stringHeaders: Record<string, string> | undefined =
        remote.headers && typeof remote.headers === "object"
          ? Object.fromEntries(Object.entries(remote.headers).map(([k, v]) => [k, String(v)]))
          : undefined;
      const probeResult = await httpChecker(rawUrl, stringHeaders, timeoutMs);
      if (!probeResult.ok) {
        onLog?.(`${tag}operator MCP server "${name}" withheld: ${probeResult.reason ?? "failed http probe"}.`);
        return null;
      }
      return {
        type: remote.type,
        name,
        url: rawUrl,
        headers: toNameValuePairs(remote.headers),
      };
    }

    onLog?.(
      `${tag}operator MCP server "${name}" withheld: unsupported server type "${String((config as MCPServerConfig).type)}".`,
    );
    return null;
  });

  const resolved = await Promise.all(preflights);
  return resolved.filter((server): server is McpServer => server !== null);
}
