/**
 * Collab wire frame types for the daemon's guest leg.
 *
 * A tolerant subset of the wire grammar omp pins in `@oh-my-pi/pi-wire` (and
 * produces in `packages/coding-agent/src/collab/protocol.ts`). Ported, not
 * imported, so the daemon keeps no coding-agent dependency for this feature;
 * `packages/collab-web` proves a guest needs nothing from it. Frames arrive
 * as plain JSON inside the AES-GCM seal, so every consumer here treats the
 * parsed object as untrusted and tolerates unknown members: a newer host may
 * send frame variants this file does not name, and the correct guest response
 * to an unknown variant is to ignore it, exactly as the web guest does.
 */

/** Protocol version negotiated in `hello`; the host rejects mismatches. */
export const COLLAB_PROTO = 3;

// -- content blocks and messages -------------------------------------------

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent =
  | TextContent
  | ThinkingContent
  | { type: "redactedThinking"; data: string }
  | ToolCallContent;

export interface WireUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
}

export type WireMessage =
  | { role: "user"; content: string | Array<TextContent | ImageContent>; timestamp: number }
  | {
      role: "developer";
      content: string | Array<TextContent | ImageContent>;
      timestamp: number;
    }
  | {
      role: "assistant";
      content: AssistantContent[];
      model: string;
      usage: WireUsage;
      stopReason: string;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<TextContent | ImageContent>;
      isError: boolean;
      timestamp: number;
    };

// -- session entries and events --------------------------------------------

export interface SessionHeader {
  type: "session";
  id: string;
  title?: string;
  timestamp: string;
  cwd: string;
}

export interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: WireMessage;
}

/** customType of collab guest prompts injected on the host. */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

export interface CustomMessageEntry extends EntryBase {
  type: "custom_message";
  customType: string;
  content: string | Array<TextContent | ImageContent>;
  details?: unknown;
  display: boolean;
}

export type SessionEntry = MessageEntry | CustomMessageEntry | (EntryBase & { type: string });

/**
 * unknown types fall through a tolerant default.
 */
export type AgentEvent =
  | { type: "message_start"; message: WireMessage }
  /** Carries the FULL accumulating message; consumers diff, not append. */
  | { type: "message_update"; message: WireMessage }
  | { type: "message_end"; message: WireMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string };

// -- host state -------------------------------------------------------------

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface Participant {
  name: string;
  role: "host" | "guest";
  readOnly?: boolean;
}

export interface SessionState {
  isStreaming: boolean;
  queuedMessageCount: number;
  sessionName?: string;
  cwd: string;
  model?: { id: string; name: string; provider: string; contextWindow: number | null };
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  participants: Participant[];
  isAborting?: boolean;
}

// -- agent registry ---------------------------------------------------------

/**
 * One entry of the host's live agent registry, as a room reports it. Ported
 * from `AgentSnapshot` in `@oh-my-pi/pi-wire`, the shape omp 18.0.3's collab
 * host broadcasts (`{ t: "agents", agents }`, debounced on registry change,
 * plus a copy in `welcome`): verified present in the installed binary, which
 * is what makes this the one subagent feed a real host actually speaks. The
 * ACP surface ompd-owned agents run over has no equivalent; nothing upstream
 * emits `notifications/agent_registry`.
 *
 * Dates are epoch milliseconds, unlike the ISO strings the ACP-side registry
 * mirror uses, and the wire carries neither the sub's session id nor its
 * metrics: `hasSessionFile` only gates a transcript fetch this leg does not
 * perform, so a mirrored sub lists but does not open.
 */
export interface CollabAgentSnapshot {
  id: string;
  displayName: string;
  /** No `advisor` here: the host filters advisors out of what it broadcasts. */
  kind: "main" | "sub";
  parentId?: string;
  status: "running" | "idle" | "parked" | "aborted";
  hasSessionFile: boolean;
  createdAt: number;
  lastActivity: number;
}

/**
 * Validates a registry payload from the room. All-or-nothing, the rule the
 * ACP-side `parseAgentRegistryNotification` sets for the same records: the
 * far side of the seal is still a process boundary, and half a registry
 * applied to durable agent rows is worse than none.
 */
export function parseCollabAgentSnapshots(payload: unknown): CollabAgentSnapshot[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const out: CollabAgentSnapshot[] = [];
  for (const candidate of payload) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("id" in candidate) ||
      !("displayName" in candidate) ||
      !("kind" in candidate) ||
      !("status" in candidate) ||
      !("hasSessionFile" in candidate) ||
      !("createdAt" in candidate) ||
      !("lastActivity" in candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.displayName !== "string" ||
      (candidate.kind !== "main" && candidate.kind !== "sub") ||
      (candidate.status !== "running" &&
        candidate.status !== "idle" &&
        candidate.status !== "parked" &&
        candidate.status !== "aborted") ||
      typeof candidate.hasSessionFile !== "boolean" ||
      typeof candidate.createdAt !== "number" ||
      !Number.isFinite(candidate.createdAt) ||
      typeof candidate.lastActivity !== "number" ||
      !Number.isFinite(candidate.lastActivity) ||
      ("parentId" in candidate && candidate.parentId !== undefined && typeof candidate.parentId !== "string")
    ) {
      return undefined;
    }
    out.push({
      id: candidate.id,
      displayName: candidate.displayName,
      kind: candidate.kind,
      ...(candidate.parentId !== undefined ? { parentId: candidate.parentId as string } : {}),
      status: candidate.status,
      hasSessionFile: candidate.hasSessionFile,
      createdAt: candidate.createdAt,
      lastActivity: candidate.lastActivity,
    });
  }
  return out;
}

// -- frames -----------------------------------------------------------------

export type CollabGuestFrame =
  | { t: "hello"; proto: number; name: string; writeToken?: string }
  | { t: "prompt"; text: string; images?: ImageContent[] }
  | { t: "abort" };

export type CollabHostFrame =
  | {
      t: "welcome";
      proto: number;
      header: SessionHeader;
      state: SessionState;
      entryCount: number;
      /** True when this peer joined through a read-only (view) link. */
      readOnly?: boolean;
      /** The host's agent registry at join time; the join-time copy of what `agents` frames then re-broadcast. */
      agents?: CollabAgentSnapshot[];
    }
  /**
   * The host's agent registry, re-broadcast (debounced) whenever it changes:
   * a subagent registers, changes status, or is released. This is the feed
   * the Agent Hub lists from.
   */
  | { t: "agents"; agents: CollabAgentSnapshot[] }
  | { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
  | { t: "entry"; entry: SessionEntry }
  | { t: "event"; event: AgentEvent }
  | { t: "state"; state: SessionState }
  | { t: "bye"; reason: string }
  | { t: "error"; message: string };

/** Relay → guest control message, sent as unencrypted TEXT JSON. */
export type RelayControlToGuest = { t: "room-closed" };

/**
 * Either direction's frame. The codec seals whatever the caller hands it;
 * which side may legitimately send which frame is the guest leg's business,
 * not the seal's, exactly as in omp's own browser guest codec.
 */
export type CollabWireFrame = CollabGuestFrame | CollabHostFrame;
