/**
 * Forward operator-configured MCP servers into daemon-created ACP sessions.
 *
 * Upstream OMP disables on-disk MCP discovery for ACP sessions so the ACP
 * client has exclusive ownership of the session's tool registry (issue #1234).
 * The daemon is that client.
 *
 * Strategy:
 * 1. Sessions are created with only daemon-owned servers (such as ompd-webview),
 *    which are known good and fast.
 * 2. Operator servers are resolved from on-disk configuration, validated for
 *    wire shape, and stripped of daemon-reserved names.
 * 3. Operator servers are attached after session creation via session/resume.
 *    Attaching post-creation decouples session creation from MCP reachability:
 *    a broken or slow server cannot prevent session creation. If an attach
 *    fails, bisection isolates the failing servers, logs the failure reasons,
 *    and attaches the healthy servers.
 */

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

function safeFailureReason(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}
/**
 * Parse individual failing server names and error details from an ACP error message.
 * Real OMP joins errors with semicolons: "server1: reason1; server2: reason2".
 */
export function parseFailedServerNames(details: string, batch: McpServer[]): Array<{ name: string; reason: string }> {
  const parsed: Array<{ name: string; reason: string }> = [];
  for (const server of batch) {
    const escaped = server.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?:^|;\\s*)${escaped}:\\s*([^;]+)`);
    const match = details.match(pattern);
    if (match?.[1]) {
      parsed.push({ name: server.name, reason: match[1].trim() });
    }
  }
  return parsed;
}

export interface ResolveOperatorMcpOptions {
  agentId?: string;
  host: HostRef;
  cwd: string;
  enabled?: boolean;
  onLog?: (line: string) => void;
  loadConfigs?: (cwd: string) => Promise<{ configs: Record<string, MCPServerConfig> }>;
}

/**
 * Resolve operator-configured MCP servers into ACP descriptors for an ACP session.
 *
 * Non-local hosts receive no operator servers to prevent host credentials
 * crossing into containers. Local hosts load configs via OMP's resolver and
 * drop reserved names. Preflight probing is deliberately omitted: network probes
 * cannot predict credentials stored in OMP's profile store.
 */
export async function resolveOperatorMcpServers(opts: ResolveOperatorMcpOptions): Promise<McpServer[]> {
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
    onLog?.(`${tag}failed to load operator MCP configs: ${safeFailureReason(err)}`);
    return [];
  }

  const entries = Object.entries(loaded.configs ?? {});
  if (entries.length === 0) return [];

  const candidateServers: McpServer[] = [];
  for (const [name, config] of entries) {
    if (DAEMON_RESERVED_MCP_SERVERS[name] === true) {
      onLog?.(`${tag}operator MCP server "${name}" dropped because "${name}" is reserved by the daemon.`);
      continue;
    }

    if (config.enabled === false) {
      continue;
    }

    if (config.type === undefined || config.type === "stdio") {
      const command = config.command;
      if (!command || typeof command !== "string" || command.trim().length === 0) {
        onLog?.(`${tag}operator MCP server "${name}" withheld: command is missing or empty.`);
        continue;
      }
      const desc: McpServer = {
        type: "stdio",
        name,
        command,
        env: toNameValuePairs(config.env),
      };
      if (Array.isArray(config.args)) {
        desc.args = config.args.map(a => String(a));
      }
      candidateServers.push(desc);
      continue;
    }

    if (config.type === "http" || config.type === "sse") {
      const rawUrl = config.url;
      if (!rawUrl || typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
        onLog?.(`${tag}operator MCP server "${name}" withheld: url is missing or empty.`);
        continue;
      }
      candidateServers.push({
        type: config.type,
        name,
        url: rawUrl,
        headers: toNameValuePairs(config.headers),
      });
      continue;
    }
    onLog?.(`${tag}operator MCP server "${name}" withheld: unsupported server type "${String(config.type)}".`);
  }

  return candidateServers;
}

/** Alias for backwards compatibility with earlier callers. */
export const forwardOperatorMcpServers = resolveOperatorMcpServers;
export type ForwardOperatorMcpOptions = ResolveOperatorMcpOptions;

export interface McpAttachClient {
  resumeSession(sessionId: string, cwd: string, mcpServers: unknown[]): Promise<unknown>;
}

export interface AttachOperatorMcpOptions {
  client: McpAttachClient;
  sessionId: string;
  cwd: string;
  daemonServers: unknown[];
  candidateServers: McpServer[];
  agentId?: string;
  onLog?: (line: string) => void;
}

export interface AttachOperatorMcpResult {
  attached: McpServer[];
  failed: Array<{ name: string; reason: string }>;
}

/**
 * Attach operator MCP servers to an already-created ACP session via session/resume.
 *
 * Attaches the candidate servers alongside daemon-owned servers. If the batch
 * fails, isolates the failing servers using parsed error details and binary
 * bisection so all healthy servers reach the session and broken ones are named.
 */
export async function attachOperatorMcpServers(opts: AttachOperatorMcpOptions): Promise<AttachOperatorMcpResult> {
  const { client, sessionId, cwd, daemonServers, candidateServers, agentId, onLog } = opts;
  const tag = agentId ? `agent ${agentId}: ` : "";

  if (candidateServers.length === 0) {
    return { attached: [], failed: [] };
  }

  // Attempt 1: Attach all candidate servers alongside daemon-owned servers in one call.
  // On success, this completes in a single round trip.
  const fullSet = [...daemonServers, ...candidateServers];
  let initialFailureReason = "";
  try {
    await client.resumeSession(sessionId, cwd, fullSet);
    onLog?.(
      `${tag}attached ${candidateServers.length} operator MCP server(s): ${candidateServers.map(s => s.name).join(", ")}`,
    );
    return { attached: candidateServers, failed: [] };
  } catch (initialErr) {
    initialFailureReason = safeFailureReason(initialErr);
    onLog?.(
      `${tag}failed to attach all operator MCP servers at once (${initialFailureReason}); isolating healthy servers.`,
    );
  }

  // Isolation phase:
  // If the initial batch failed, narrow down which servers broke.
  // We use bisection: partition failing sets into halves, testing each half.
  // Every successful call to resumeSession updates the active server set.
  const attached: McpServer[] = [];
  const failed: Array<{ name: string; reason: string }> = [];
  let lastResumeSucceeded = false;

  async function tryResume(servers: McpServer[]): Promise<void> {
    await client.resumeSession(sessionId, cwd, [...daemonServers, ...servers]);
    lastResumeSucceeded = true;
  }

  async function isolate(batch: McpServer[], failureReason: string): Promise<void> {
    if (batch.length === 0) return;
    if (batch.length === 1) {
      const server = batch[0]!;
      failed.push({ name: server.name, reason: failureReason });
      onLog?.(`${tag}operator MCP server "${server.name}" failed to attach: ${failureReason}`);
      return;
    }

    // Try parsing error details if possible to fast-track known broken servers
    const parsed = parseFailedServerNames(failureReason, batch);
    if (parsed.length > 0 && parsed.length < batch.length) {
      const failedMap = new Map(parsed.map(p => [p.name, p.reason]));
      const remaining = batch.filter(s => !failedMap.has(s.name));
      for (const p of parsed) {
        failed.push(p);
        onLog?.(`${tag}operator MCP server "${p.name}" failed to attach: ${p.reason}`);
      }
      if (remaining.length > 0) {
        try {
          await tryResume([...attached, ...remaining]);
          attached.push(...remaining);
          onLog?.(
            `${tag}attached ${remaining.length} operator MCP server(s): ${remaining.map(s => s.name).join(", ")}`,
          );
          return;
        } catch (remErr) {
          lastResumeSucceeded = false;
          return await isolate(remaining, safeFailureReason(remErr));
        }
      }
      return;
    }

    // Binary bisection: split into two halves
    const mid = Math.floor(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);

    // Test left half
    try {
      await tryResume([...attached, ...left]);
      attached.push(...left);
      onLog?.(`${tag}attached ${left.length} operator MCP server(s): ${left.map(s => s.name).join(", ")}`);
    } catch (leftErr) {
      lastResumeSucceeded = false;
      await isolate(left, safeFailureReason(leftErr));
    }

    // Test right half
    try {
      await tryResume([...attached, ...right]);
      attached.push(...right);
      onLog?.(`${tag}attached ${right.length} operator MCP server(s): ${right.map(s => s.name).join(", ")}`);
    } catch (rightErr) {
      lastResumeSucceeded = false;
      await isolate(right, safeFailureReason(rightErr));
    }
  }

  await isolate(candidateServers, initialFailureReason);

  // If the last call to resumeSession was a failure (e.g. the last branch tested
  // failed and no servers were added after), ACP's session record left its
  // mcpManager disconnected. Reconnect with the final working set (or daemonServers alone)
  // so the session is guaranteed clean and usable with all working servers.
  if (!lastResumeSucceeded) {
    try {
      await client.resumeSession(sessionId, cwd, [...daemonServers, ...attached]);
    } catch (restoreErr) {
      onLog?.(`${tag}warning: failed to restore session MCP servers: ${safeFailureReason(restoreErr)}`);
    }
  }

  return { attached, failed };
}
