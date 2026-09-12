/**
 * MCP session tools for orchestrating other agent sessions.
 *
 * This module allows one agent session to list the fleet of sessions, create
 * new agent sessions, send prompts to them and await settled replies, read
 * their transcripts, and stop them.
 *
 * Everything here goes through `api`, the same HTTP client the CLI commands
 * use. That preserves the single auth story: resolving the daemon address,
 * presenting the 0600 token at point of use, checking scopes, and formatting
 * errors uniformly.
 *
 * Disciplines kept:
 *
 * A tool result is model-visible text. Secrets are never logged or exposed.
 * The schema descriptions are the only specification a model reads.
 * Annotations reflect the real effects: creation, prompting, and stopping
 * are mutating operations; stopping an agent is destructive.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Agent, AgentState, QueuedIntent, SessionTranscriptResponse, TranscriptTailEntry } from "@ompd/core";
import { z } from "zod";
import { api, type CliContext } from "../client.ts";
import { type ToolErrorResult, toolError } from "./errors.ts";

/**
 * Every session tool this module registers, in registration order.
 */
export const SESSION_TOOL_NAMES = [
  "ompctl_sessions_list",
  "ompctl_session_create",
  "ompctl_session_prompt",
  "ompctl_session_read",
  "ompctl_session_stop",
] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// What the daemon answers with
// ---------------------------------------------------------------------------

interface AgentsResponse {
  agents?: Agent[];
}

interface AgentCreateResponse {
  agent?: Agent;
  intent?: QueuedIntent;
}

interface PromptResponse {
  agentId?: string;
  stopReason?: string;
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const AGENT_STATES: Record<AgentState, AgentState> = {
  provisioning: "provisioning",
  starting: "starting",
  idle: "idle",
  busy: "busy",
  waiting: "waiting",
  stopped: "stopped",
  failed: "failed",
};

const listSessionsShape = {
  cwd: z.string().optional().describe("Narrow the list to agents running in this working directory."),
  state: z.enum(AGENT_STATES).optional().describe("Narrow the list to agents in this lifecycle state."),
};

const createSessionShape = {
  cwd: z.string().min(1).describe("The working directory where the new agent session should run."),
  name: z.string().min(1).optional().describe("Optional display name for the new agent session."),
};

const promptSessionShape = {
  agentId: z.string().min(1).describe("The agent id to prompt (e.g. agt_...)."),
  prompt: z.string().min(1).describe("The prompt text to send to the agent session."),
};

const readSessionShape = {
  sessionId: z.string().min(1).describe("The session id (sess_...) or agent id (agt_...) whose transcript to read."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Number of entries to return from the end of the transcript (default 30, max 100)."),
  before: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Byte offset cursor from a previous read to paginate backwards to older turns."),
  subagent: z.string().optional().describe("Subagent name when inspecting a delegated subagent transcript."),
};

const stopSessionShape = {
  agentId: z.string().min(1).describe("The agent id to stop (e.g. agt_...)."),
};

// ---------------------------------------------------------------------------
// Output schemas
// ---------------------------------------------------------------------------

const sessionSummarySchema = z.object({
  id: z.string().describe("The agent id (agt_...)."),
  name: z.string().describe("Display name of the agent."),
  state: z.string().describe("Lifecycle state."),
  cwd: z.string().describe("Working directory."),
  sessionId: z.string().optional().describe("ACP session id (sess_...), when available."),
  lastActiveAt: z.string().describe("ISO timestamp of last activity."),
});

const listSessionsOutputSchema = {
  count: z.number().int(),
  sessions: z.array(sessionSummarySchema),
};

const createSessionOutputSchema = {
  agentId: z.string().describe("The created agent id (agt_...)."),
  sessionId: z.string().describe("The ACP session id (sess_...)."),
  name: z.string().describe("Display name of the agent."),
  cwd: z.string().describe("Working directory."),
};

const promptSessionOutputSchema = {
  agentId: z.string().describe("The prompted agent id."),
  stopReason: z.string().describe("How the turn ended (e.g. end_turn, cancelled)."),
  reply: z.string().optional().describe("The assistant text reply from the settled turn, if available."),
};

const transcriptEntrySchema = z.object({
  kind: z.string().optional(),
  role: z.string().optional(),
  text: z.string().optional(),
  at: z.string().optional(),
  title: z.string().optional(),
  toolKind: z.string().optional(),
  status: z.string().optional(),
  output: z.string().nullable().optional(),
});

const readSessionOutputSchema = {
  sessionId: z.string().describe("The session id whose transcript was read."),
  entries: z.array(transcriptEntrySchema),
  truncated: z.boolean().describe("Whether older entries exist behind this page."),
  nextCursor: z.number().nullable().describe("Byte offset for paginating older entries, or null at the start."),
  cursor: z.number().optional().describe("Echoed cursor this page was read from."),
};

const stopSessionOutputSchema = {
  agentId: z.string().describe("The stopped agent id."),
  stopped: z.boolean().describe("Whether the agent was stopped."),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolSuccess = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

async function guard(action: string, run: () => Promise<ToolSuccess>): Promise<ToolSuccess | ToolErrorResult> {
  try {
    return await run();
  } catch (err) {
    return toolError(action, err);
  }
}

function formatTranscriptEntry(entry: TranscriptTailEntry): string {
  if (entry.kind === "tool") {
    const detail = entry.output ? ` -> ${entry.output}` : "";
    return `[tool ${entry.title} (${entry.status}) at ${entry.at}]${detail}`;
  }
  if (entry.kind === "thinking") {
    return `[thinking at ${entry.at}]: ${entry.text}`;
  }
  return `[${entry.role} at ${entry.at}]: ${entry.text}`;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSessionTools(server: McpServer, ctx: CliContext): void {
  server.registerTool(
    "ompctl_sessions_list",
    {
      title: "List sessions",
      description:
        "Every agent session held by the daemon fleet, with its id, name, state, working directory, " +
        "session id, and last activity timestamp. Supports filtering by cwd and lifecycle state so an " +
        "orchestrator can find its target sessions.",
      inputSchema: listSessionsShape,
      outputSchema: listSessionsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    args =>
      guard("list sessions", async () => {
        const response = await api<AgentsResponse>(ctx, "/v1/agents");
        const agents = (response.agents ?? [])
          .filter(agent => {
            if (args.state !== undefined && agent.state !== args.state) return false;
            if (args.cwd !== undefined && agent.cwd !== args.cwd) return false;
            return true;
          })
          .map(agent => ({
            id: agent.id,
            name: agent.name,
            state: agent.state,
            cwd: agent.cwd,
            sessionId: agent.acpSessionId,
            lastActiveAt: agent.lastActiveAt,
          }));

        const heading =
          agents.length === 0
            ? "no sessions matched"
            : `${String(agents.length)} session${agents.length === 1 ? "" : "s"}`;
        const lines = agents.map(
          s =>
            `  ${s.id}  ${s.state.padEnd(8)}  ${s.name}  ${s.sessionId ? `(${s.sessionId}) ` : ""}${s.cwd}  active ${s.lastActiveAt}`,
        );

        return {
          content: [{ type: "text", text: [heading, ...lines].join("\n") }],
          structuredContent: { count: agents.length, sessions: agents },
        };
      }),
  );

  server.registerTool(
    "ompctl_session_create",
    {
      title: "Create session",
      description:
        "Create a new agent session at a specified working directory with an optional display name. " +
        "Requires the manage scope. Returns the daemon assigned agent id and session id. Never returns " +
        "optimistic echoes: the result is verified from the daemon's own creation outcome.",
      inputSchema: createSessionShape,
      outputSchema: createSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    args =>
      guard("create session", async () => {
        const name = args.name?.trim() || `session-${crypto.randomUUID().slice(0, 8)}`;
        const response = await api<AgentCreateResponse>(ctx, "/v1/agents", {
          method: "POST",
          body: { name, cwd: args.cwd },
        });
        if (!response.agent && !response.intent) {
          throw new Error("the daemon accepted the creation request but returned no agent or intent");
        }

        const agentId = response.agent?.id ?? response.intent?.agentId ?? "";
        const sessionId = response.agent?.acpSessionId ?? "";
        const assignedName = response.agent?.name ?? name;
        const assignedCwd = response.agent?.cwd ?? args.cwd;

        return {
          content: [
            {
              type: "text",
              text: `created session agent ${agentId}${sessionId ? ` (session ${sessionId})` : ""} at ${assignedCwd}`,
            },
          ],
          structuredContent: {
            agentId,
            sessionId,
            name: assignedName,
            cwd: assignedCwd,
          },
        };
      }),
  );

  server.registerTool(
    "ompctl_session_prompt",
    {
      title: "Prompt session",
      description:
        "Send a prompt to a live agent session and wait for the turn to settle. Requires the prompt scope. " +
        "Uses POST /v1/agents/:id/prompt, which waits for turn completion. The daemon has a deliberately long " +
        "turn timeout to accommodate model reasoning and tool approvals. If a turn outlives this wait, the call " +
        "fails with a timeout error while the agent continues executing in the background until stopped.",
      inputSchema: promptSessionShape,
      outputSchema: promptSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    args =>
      guard("prompt session", async () => {
        const callerAgentId = ctx.env.OMP_AGENT_ID ?? ctx.env.OMPD_AGENT_ID ?? ctx.env.AGENT_ID;
        if (callerAgentId && callerAgentId === args.agentId) {
          throw new Error(
            `cannot prompt agent ${args.agentId}: the calling orchestrator is running as this agent, and prompting itself would loop`,
          );
        }
        const callerSessionId = ctx.env.OMP_SESSION_ID ?? ctx.env.OMPD_SESSION_ID ?? ctx.env.PI_SESSION_ID;
        if (callerSessionId && callerSessionId === args.agentId) {
          throw new Error(
            `cannot prompt agent ${args.agentId}: the calling orchestrator is running in this session, and prompting itself would loop`,
          );
        }

        const response = await api<PromptResponse>(ctx, `/v1/agents/${encodeURIComponent(args.agentId)}/prompt`, {
          method: "POST",
          body: { text: args.prompt },
        });

        const stopReason = response.stopReason ?? "unknown";

        let reply = "";
        try {
          const transcript = await api<SessionTranscriptResponse>(
            ctx,
            `/v1/sessions/${encodeURIComponent(args.agentId)}/transcript?limit=10`,
          );
          if (transcript.entries && transcript.entries.length > 0) {
            for (let i = transcript.entries.length - 1; i >= 0; i--) {
              const entry = transcript.entries[i];
              if (
                entry &&
                "role" in entry &&
                entry.role === "assistant" &&
                typeof entry.text === "string" &&
                entry.text.length > 0
              ) {
                reply = entry.text;
                break;
              }
            }
          }
        } catch {
          // If transcript read fails, stopReason is still returned honestly.
        }

        const summaryText = reply
          ? `agent ${args.agentId} completed turn (${stopReason}):\n\n${reply}`
          : `agent ${args.agentId} completed turn (${stopReason})`;

        return {
          content: [{ type: "text", text: summaryText }],
          structuredContent: {
            agentId: args.agentId,
            stopReason,
            ...(reply ? { reply } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "ompctl_session_read",
    {
      title: "Read session transcript",
      description:
        "Read turns from an existing session transcript backwards from the end of the file. Requires the read scope. " +
        "Accepts either an agent id (agt_...) or a session id (sess_...). Returns recent entries, truncation state, " +
        "and a nextCursor byte offset for paging backwards to older turns.",
      inputSchema: readSessionShape,
      outputSchema: readSessionOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    args =>
      guard("read session transcript", async () => {
        const params = new URLSearchParams();
        if (args.limit !== undefined) params.set("limit", String(args.limit));
        if (args.before !== undefined) params.set("before", String(args.before));
        if (args.subagent !== undefined) params.set("subagent", args.subagent);

        const queryString = params.toString();
        const url = `/v1/sessions/${encodeURIComponent(args.sessionId)}/transcript${queryString ? `?${queryString}` : ""}`;
        const response = await api<SessionTranscriptResponse>(ctx, url);

        const entries = response.entries ?? [];
        const lines = entries.map(formatTranscriptEntry);
        const header = `transcript for session ${response.sessionId} (${entries.length} entries${response.nextCursor !== null ? `, next cursor: ${response.nextCursor}` : ", start of file"}):`;

        return {
          content: [{ type: "text", text: [header, ...lines].join("\n\n") }],
          structuredContent: {
            sessionId: response.sessionId,
            entries,
            truncated: response.truncated ?? false,
            nextCursor: response.nextCursor,
            ...(response.cursor !== undefined ? { cursor: response.cursor } : {}),
          },
        };
      }),
  );

  server.registerTool(
    "ompctl_session_stop",
    {
      title: "Stop session",
      description:
        "Stop a running agent session. Destructive operation that releases agent resources while retaining its transcript. " +
        "Requires the manage scope. Uses DELETE /v1/agents/:id.",
      inputSchema: stopSessionShape,
      outputSchema: stopSessionOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    args =>
      guard("stop session", async () => {
        await api<{ ok?: boolean }>(ctx, `/v1/agents/${encodeURIComponent(args.agentId)}`, {
          method: "DELETE",
        });

        return {
          content: [{ type: "text", text: `stopped agent ${args.agentId}` }],
          structuredContent: {
            agentId: args.agentId,
            stopped: true,
          },
        };
      }),
  );
}
