/**
 * Maps collab host frames onto the ACP `session/update` payloads the phone
 * already renders.
 *
 * The load-bearing rule of the whole guest leg: the app must not learn a
 * second transcript shape. Every collab entry and event becomes the same
 * `sessionUpdate` payload an owned agent's ACP host emits — chunks for
 * message text and thought, `tool_call`/`tool_call_update` for tool cards,
 * `session_info_update` and `usage_update` for the footer — so `attach`,
 * replay, and live delivery all work through the update log unchanged.
 *
 * One transcript source per message, or everything renders twice. The host
 * delivers the same assistant turn twice over: streamed `event` frames while
 * it runs, then the durable `entry` when it lands. The update log is
 * append-only, so unlike the browser guest (whose in-flight ghost is an
 * overlay the entry replaces) this mapper must choose per source:
 *
 * - `snapshot-chunk` entries render in full. They are the back-transcript;
 *   no events exist for them, so there is no second copy to avoid.
 * - live `entry` frames render only user and custom messages. Assistant and
 *   tool-result messages already streamed as events (which are logged as
 *   chunks and tool updates), and user input plus injected guest prompts
 *   have no event counterpart — they would be invisible otherwise.
 * - live `event` frames render and log, giving the phone the same streaming
 *   feel an owned agent has.
 *
 * A reconnect re-delivers the whole back-transcript; entries are deduped by
 * id so the append-only log stays gapless and nothing lands twice. And
 * `message_update` events carry the FULL accumulating message while ACP
 * chunks are deltas, so each in-flight message is diffed against what has
 * already been emitted — by content, not object identity, because every
 * wire frame arrives as a freshly parsed object.
 */

import {
  type AgentEvent,
  type AssistantContent,
  COLLAB_PROMPT_MESSAGE_TYPE,
  type CollabAgentSnapshot,
  type CollabHostFrame,
  parseCollabAgentSnapshots,
  type SessionEntry,
  type SessionHeader,
  type SessionState,
  type WireMessage,
} from "./guest-frames.ts";

/** ACP tool-card kinds, keyed by the omp tool names that produce them. */
const TOOL_KINDS: Record<string, string> = {
  bash: "execute",
  execute: "execute",
  run: "execute",
  sh: "execute",
  read: "read",
  view: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  update: "edit",
  grep: "search",
  glob: "search",
  search: "search",
  find: "search",
  list: "search",
  fetch: "fetch",
  webfetch: "fetch",
  web_fetch: "fetch",
  think: "think",
  thinking: "think",
  move: "move",
  rename: "move",
  delete: "delete",
  remove: "delete",
};

export interface CollabFrameMapping {
  /** ACP `session/update` payloads, in arrival order. */
  updates: unknown[];
  /** Present when the frame carried host state the agent row should adopt. */
  state?: SessionState;
  /** Present on `welcome`: the mirrored session's own header. */
  header?: SessionHeader;
  /** Present on `welcome`: total snapshot entries the host will deliver. */
  entryCount?: number;
  /** True when this frame completes the join-time snapshot (`final: true`, or a zero-entry welcome). */
  snapshotFinal?: boolean;
  /** True when this frame marks the host's read-only verdict for this leg (from `welcome`). */
  readOnly?: boolean;
  /** Present when the frame ends the guest leg (`bye`, pre-welcome `error`); the string is the reason. */
  ended?: string;
  /**
   * Present when the frame carried a valid host agent-registry snapshot
   * (`welcome` or `agents`). Absent when the host sent none, and absent when
   * it sent one that failed validation: both mean "leave the mirrored rows
   * alone", never "apply an empty registry".
   */
  agents?: CollabAgentSnapshot[];
}

/** Progress through the in-flight assistant message. */
interface StreamState {
  /** Content blocks walked so far; the last of them may still be growing and is re-examined on every update. */
  blocks: number;
  /** The state of the last walked block: how far its text has been emitted, or which toolCall it was. */
  last: { kind: "text" | "thinking" | "toolCall" | "other"; emitted: number; toolCallId?: string } | null;
}

export interface CollabStreamMapperOptions {
  /**
   * The daemon guest leg's display name. The host injects a guest's own
   * prompt as a `collab-prompt` custom message carrying the sender's name;
   * the phone already echoed its prompt locally when it sent it (the same
   * rule owned agents follow, where the daemon does not replay a prompt
   * back), so this leg's own entries are suppressed to avoid the double.
   */
  ownName: string;
}

export class CollabStreamMapper {
  readonly #ownName: string;
  /** Entry ids already mapped, so a reconnect's resnapshot appends nothing twice. */
  readonly #seenEntries = new Set<string>();
  /** toolCallIds already announced, shared by the entry and event paths. */
  readonly #announcedTools = new Set<string>();
  #stream: StreamState | null = null;
  #messageSeq = 0;
  #lastLiveUserText: string | null = null;
  #usedTokens = 0;
  #costTotal = 0;

  constructor(opts: CollabStreamMapperOptions) {
    this.#ownName = opts.ownName;
  }

  /** Cumulative usage the mirrored session consumed, for the agent row's metrics. */
  metrics(): { usedTokens: number; costAmount: number } {
    return { usedTokens: this.#usedTokens, costAmount: this.#costTotal };
  }

  mapFrame(frame: CollabHostFrame): CollabFrameMapping {
    const out: CollabFrameMapping = { updates: [] };
    switch (frame.t) {
      case "welcome":
        out.state = frame.state;
        out.header = frame.header;
        out.readOnly = frame.readOnly === true;
        out.entryCount = frame.entryCount;
        if (frame.agents !== undefined) {
          const agents = parseCollabAgentSnapshots(frame.agents);
          if (agents !== undefined) out.agents = agents;
        }
        // A session with no history completes the snapshot in the welcome
        // itself; the join waiter must not sit waiting for a chunk that
        // will never come.
        if (frame.entryCount === 0) out.snapshotFinal = true;
        break;
      case "agents": {
        const agents = parseCollabAgentSnapshots(frame.agents);
        if (agents !== undefined) out.agents = agents;
        break;
      }
      case "snapshot-chunk":
        for (const entry of frame.entries ?? []) this.#mapEntry(entry, out.updates, { backfill: true });
        // The last chunk's `final` flag is what moves a joining guest from
        // snapshot to live; the join waiter arms a per-chunk timeout on
        // every non-final chunk.
        if (frame.final) out.snapshotFinal = true;
        break;
      case "entry":
        this.#mapEntry(frame.entry, out.updates, { backfill: false });
        break;
      case "event":
        this.#mapEvent(frame.event, out.updates);
        break;
      case "state":
        out.state = frame.state;
        out.updates.push({
          sessionUpdate: "session_info_update",
          title: frame.state.sessionName,
          model: frame.state.model?.name,
          cwd: frame.state.cwd,
          updatedAt: new Date().toISOString(),
        });
        if (frame.state.contextUsage?.tokens != null) {
          out.updates.push({
            sessionUpdate: "usage_update",
            used: frame.state.contextUsage.tokens,
            ...(frame.state.contextUsage.contextWindow != null ? { size: frame.state.contextUsage.contextWindow } : {}),
          });
        }
        break;
      case "bye":
        out.ended = frame.reason;
        break;
      case "error":
        // Pre-welcome errors are the host's targeted reply to hello (proto
        // mismatch, refused join): no welcome will follow, so the leg ends.
        // After welcome they are transient complaints the TUI shows as
        // notices; nothing transcript-bearing rides them.
        if (this.#stream === null && this.#seenEntries.size === 0) out.ended = frame.message;
        break;
      default:
        // Unknown frame from a newer host: ignore, exactly as the web guest
        // does. `bus`, `ui-request`, `ui-request-end`, and `transcript`
        // replies land here deliberately (see the PR notes).
        break;
    }
    return out;
  }

  // -- entries -----------------------------------------------------------------

  #mapEntry(entry: SessionEntry, updates: unknown[], opts: { backfill: boolean }): void {
    if (entry === null || typeof entry !== "object" || typeof (entry as { id?: unknown }).id !== "string") return;
    const id = (entry as { id: string }).id;
    if (this.#seenEntries.has(id)) return;
    this.#seenEntries.add(id);
    if ((entry as { type?: unknown }).type === "message") {
      const message = (entry as { message?: unknown }).message as WireMessage | undefined;
      if (message == null) return;
      if (opts.backfill) {
        this.#mapMessageEntry(message, updates, id);
      } else if (message.role === "user") {
        // Live user entries have no event counterpart; without this the
        // operator's own terminal prompts would never reach the phone.
        this.#pushUserChunk(updates, this.#flattenText(message.content), id);
      }
      // Live assistant and toolResult entries already streamed as events;
      // rendering them again would duplicate the transcript.
      return;
    }
    const custom = entry as {
      type?: string;
      customType?: string;
      content?: unknown;
      details?: unknown;
      display?: boolean;
    };
    if (custom.type === "custom_message") {
      if (custom.display !== true) return;
      if (custom.customType === COLLAB_PROMPT_MESSAGE_TYPE) {
        const from = (custom.details as { from?: string } | undefined)?.from;
        // This leg's own prompt: the asking phone echoed it locally already,
        // the same rule an owned agent follows. Rendered for every other
        // participant, with the sender named.
        if (from === this.#ownName) return;
        const text = this.#flattenText(custom.content);
        this.#pushUserChunk(updates, from === undefined ? text : `[${from}] ${text}`, id);
        return;
      }
      this.#pushUserChunk(updates, this.#flattenText(custom.content), id);
      return;
    }
    // compaction, branch_summary, model_change, thinking_level_change, and
    // anything a newer host adds: footer concerns the state frames already
    // carry live, so there is nothing here the transcript lost.
  }

  #mapMessageEntry(message: WireMessage, updates: unknown[], id: string): void {
    if (message.role === "user") {
      this.#pushUserChunk(updates, this.#flattenText(message.content), id);
      return;
    }
    if (message.role === "assistant") {
      for (const block of message.content ?? []) this.#emitAssistantBlock(block, updates, id);
      this.#accumulateUsage(message);
      return;
    }
    if (message.role === "toolResult") {
      updates.push({
        sessionUpdate: "tool_call_update",
        toolCallId: message.toolCallId,
        status: message.isError ? "failed" : "completed",
        rawOutput: { content: message.content ?? [] },
      });
      return;
    }
    // developer messages ride the context but never the phone transcript.
  }

  // -- events ------------------------------------------------------------------

  #mapEvent(event: AgentEvent, updates: unknown[]): void {
    switch (event.type) {
      case "message_start":
      case "message_update":
      case "message_end": {
        const message = event.message as WireMessage | undefined;
        if (message == null) return;
        if (message.role === "assistant") {
          // `message_start` announces a NEW message: drop the in-flight
          // stream so the next chunks open their own row instead of reading
          // as growth of the message that just ended.
          if (event.type === "message_start") this.#stream = null;
          this.#diffAssistant(message, updates);
          if (event.type === "message_end") this.#accumulateUsage(message);
          return;
        }
        // Non-assistant messages normally arrive as entries; a host that
        // streams one live gets it whole, once per distinct text.
        const text = this.#flattenText(message.content);
        if (text.length === 0 || text === this.#lastLiveUserText) return;
        this.#lastLiveUserText = text;
        this.#pushUserChunk(updates, text, `collab-u${this.#messageSeq++}`);
        return;
      }
      case "tool_execution_start":
        this.#announceTool(updates, event.toolCallId, event.toolName, event.args, "in_progress");
        return;
      case "tool_execution_update":
        if (!this.#announcedTools.has(event.toolCallId)) {
          this.#announceTool(updates, event.toolCallId, event.toolName, event.args, "in_progress");
        }
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: "in_progress",
          rawOutput: { content: [{ type: "text", text: this.#stringify(event.partialResult) }] },
        });
        return;
      case "tool_execution_end":
        if (!this.#announcedTools.has(event.toolCallId)) {
          this.#announceTool(updates, event.toolCallId, event.toolName, undefined, "in_progress");
        }
        updates.push({
          sessionUpdate: "tool_call_update",
          toolCallId: event.toolCallId,
          status: event.isError === true ? "failed" : "completed",
          rawOutput: { content: [{ type: "text", text: this.#stringify(event.result) }] },
        });
        return;
      default:
        // agent_start/end, turn boundaries, notices, retries, compaction
        // chatter: footer and liveness concerns the state frames carry.
        return;
    }
  }

  // -- assistant stream diff ---------------------------------------------------

  /**
   * Emit the delta between the in-flight message's last-seen content and
   * `message`. Collab sends the FULL accumulating message; ACP chunks are
   * append-only text. Earlier blocks are immutable once a later one exists,
   * so only the last walked block can still be growing; a message that
   * rewound or replaced its content restarts under a fresh message id rather
   * than emitting a scramble.
   */
  #diffAssistant(message: Extract<WireMessage, { role: "assistant" }>, updates: unknown[]): void {
    const content: AssistantContent[] = message.content ?? [];
    const stream = this.#stream;
    if (stream === null || content.length < stream.blocks || !this.#compatibleTip(content, stream)) {
      this.#stream = { blocks: 0, last: null };
      this.#messageSeq++;
    }
    const live = this.#stream!;
    const messageId = `collab-m${this.#messageSeq}`;
    // The walk restarts at the last walked block, not after it: that block
    // may still be growing, and re-walking it is idempotent (nothing is
    // emitted when its text has not grown).
    for (let index = Math.max(0, live.blocks - 1); index < content.length; index++) {
      const block = content[index]!;
      if (block.type === "text") {
        const base = live.last !== null && live.last.kind === "text" ? live.last.emitted : 0;
        if (block.text.length > base) {
          updates.push({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: block.text.slice(base) },
            messageId,
          });
        }
        live.last = { kind: "text", emitted: block.text.length };
      } else if (block.type === "thinking") {
        const base = live.last !== null && live.last.kind === "thinking" ? live.last.emitted : 0;
        if (block.thinking.length > base) {
          updates.push({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: block.thinking.slice(base) },
            messageId,
          });
        }
        live.last = { kind: "thinking", emitted: block.thinking.length };
      } else if (block.type === "toolCall") {
        if (!this.#announcedTools.has(block.id)) {
          this.#announceTool(updates, block.id, block.name, block.arguments, "pending", messageId);
        }
        live.last = { kind: "toolCall", emitted: 1, toolCallId: block.id };
      } else {
        // redactedThinking and whatever a newer host adds.
        live.last = { kind: "other", emitted: 0 };
      }
      live.blocks = index + 1;
    }
  }

  /** Whether the block the walk stopped inside is still the same block, still growing forward. */
  #compatibleTip(content: AssistantContent[], stream: StreamState): boolean {
    if (stream.last === null || stream.blocks === 0) return true;
    const tip = content[stream.blocks - 1];
    if (tip === undefined) return false;
    switch (stream.last.kind) {
      case "text":
        return tip.type === "text" && tip.text.length >= stream.last.emitted;
      case "thinking":
        return tip.type === "thinking" && tip.thinking.length >= stream.last.emitted;
      case "toolCall":
        return tip.type === "toolCall" && tip.id === stream.last.toolCallId;
      default:
        return true;
    }
  }

  #emitAssistantBlock(block: AssistantContent, updates: unknown[], messageId: string): void {
    if (block.type === "text") {
      if (block.text.length === 0) return;
      updates.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: block.text },
        messageId,
      });
      return;
    }
    if (block.type === "thinking") {
      if (block.thinking.length === 0) return;
      updates.push({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: block.thinking },
        messageId,
      });
      return;
    }
    if (block.type === "toolCall") {
      this.#announceTool(updates, block.id, block.name, block.arguments, "pending", messageId);
      return;
    }
    // redactedThinking: the host already withheld the content; mirroring
    // nothing is the faithful rendering.
  }

  #announceTool(
    updates: unknown[],
    toolCallId: string,
    toolName: string,
    args: unknown,
    status: "pending" | "in_progress",
    messageId?: string,
  ): void {
    this.#announcedTools.add(toolCallId);
    updates.push({
      sessionUpdate: "tool_call",
      toolCallId,
      title: toolName,
      kind: TOOL_KINDS[toolName.toLowerCase()] ?? "other",
      status,
      rawInput: args,
      ...(messageId === undefined ? {} : { messageId }),
    });
  }

  #pushUserChunk(updates: unknown[], text: string, messageId: string): void {
    if (text.length === 0) return;
    updates.push({
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
      messageId,
    });
  }

  #flattenText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    let joined = "";
    for (const block of content) {
      if (block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text;
        if (typeof text === "string") joined += text;
      }
      // Image blocks carry base64 the phone transcript does not inline; the
      // prompt's local echo already names image counts.
    }
    return joined;
  }

  #stringify(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  #accumulateUsage(message: WireMessage): void {
    if (message.role !== "assistant") return;
    const usage = message.usage;
    if (usage == null) return;
    this.#usedTokens += usage.totalTokens ?? 0;
    this.#costTotal += usage.cost?.total ?? 0;
  }
}
