/**
 * ompctl's transcript, as an assistant-ui external store.
 *
 * The daemon owns session state and that does not change here. This is a
 * conversion, not a second store: `useExternalStoreRuntime` is handed our
 * reducer's `Entry[]` and a converter, and every composer action is dispatched
 * straight back through `OmpdClient`. assistant-ui owns list mechanics,
 * message identity and part dispatch; it owns no state.
 *
 * Three facts shaped this file, all of them measured rather than assumed:
 *
 *  - `useExternalStoreRuntime` is exported ONLY from `@assistant-ui/core/react`.
 *    `@assistant-ui/react-native@0.1.38` exports two runtime hooks and both
 *    keep messages in memory, which is exactly the duplicate store our
 *    contracts forbid. `ExternalStoreAdapter` in turn is exported only from
 *    the `@assistant-ui/core` root, not from `/react`.
 *  - The converter is cached by object identity
 *    (`convertMessages<TIn extends WeakKey>`). Our reducer already shares
 *    unchanged entries by reference, so a streaming token re-converts exactly
 *    one entry and the rest are cache hits. That is why this maps one entry to
 *    one message rather than grouping consecutive parts: grouping would rebuild
 *    a merged object per frame and defeat the cache, and it would also lose the
 *    exact interleaving the operator watched happen.
 *  - `metadata.custom` carries the SOURCE ENTRY BY REFERENCE. That is the whole
 *    reason this conversion is lossless: a custom renderer reads the original
 *    `Entry` back out and renders `ToolCard` / `ApprovalCard` / `RichText`
 *    against it, so no tool state, location list or decision has to survive a
 *    round trip through assistant-ui's own vocabulary.
 */

import type { ThreadMessageLike } from "@assistant-ui/core";
import type { Agent } from "@ompd/core/contracts";
import { TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { PromptScopeAccess, SessionLoad } from "../console/state.ts";
import type { Entry, SessionState } from "../session/model.ts";

/** Where a custom renderer finds the entry a message was built from. */
export const OMP_ENTRY = "ompEntry";

/**
 * The message a renderer actually receives, narrowed to the one field we put
 * there. `metadata.custom` is `Record<string, unknown>`, so reading it back
 * needs a guard rather than a cast.
 */
export function entryOf(message: { metadata?: { custom?: Record<string, unknown> } }): Entry | null {
  const custom = message.metadata?.custom;
  if (custom === undefined) return null;
  const candidate = custom[OMP_ENTRY];
  if (candidate === null || typeof candidate !== "object") return null;
  // `kind` and `id` are what every Entry member carries, and what a renderer
  // switches on. Anything without them is not ours.
  if (!("kind" in candidate) || !("id" in candidate)) return null;
  return candidate as Entry;
}

/**
 * One entry, as one message.
 *
 * Roles: ompctl has two speakers, and everything that is not the operator is
 * the agent's side of the turn -- including tool cards and clearance requests,
 * which are things the agent did or asked for. `system` is unused because the
 * daemon never sends one.
 */
export function convertEntry(entry: Entry): ThreadMessageLike {
  const metadata = { custom: { [OMP_ENTRY]: entry } } as const;

  switch (entry.kind) {
    case "user":
      return {
        role: "user",
        id: entry.id,
        content: [{ type: "text", text: entry.text }],
        metadata,
      };

    case "assistant":
      return {
        role: "assistant",
        id: entry.id,
        // A thought is reasoning, which assistant-ui models as its own part
        // kind rather than as prose with a flag. The distinction is the one the
        // transcript already draws with a violet gutter.
        content: entry.thought ? [{ type: "reasoning", text: entry.text }] : [{ type: "text", text: entry.text }],
        // The whole reason `isRunning` is not enough on its own: this is what
        // marks WHICH message is still being written.
        status: entry.streaming ? { type: "running" } : { type: "complete", reason: "unknown" },
        metadata,
      };

    case "tool":
      return {
        role: "assistant",
        id: entry.id,
        content: [
          {
            type: "tool-call",
            // The reducer keys tool entries by the call id itself
            // (`indexOfTool` matches `entry.id === toolCallId`), so there is no
            // separate field to read and inventing one would drift.
            toolCallId: entry.id,
            // The tool's own name, never its `title`: omp builds ACP's `title`
            // from the call's arguments, so it carries command lines and paths.
            // It stays out of anything a generic renderer or a screen reader
            // would reach; the card below renders the real entry.
            toolName: entry.toolKind,
            // `artifact` is `any` in the published type, which is what lets the
            // kind and the touched locations ride without being flattened into
            // args a label might print.
            artifact: { kind: entry.toolKind, status: entry.status, locations: entry.locations },
            result: entry.output ?? undefined,
            isError: entry.status === "failed",
            // `args` and `argsText` are deliberately LEFT UNSET even though
            // `ToolEntry.input` holds the call's arguments. Populating them
            // would put a command line into the field assistant-ui's own
            // `ToolFallback` prints and a screen reader reaches, which is the
            // exact leak `toolName` above avoids. Nothing is lost: `input` is
            // still reachable through `metadata.custom` for `ToolCard`, which
            // is the only thing that renders it and already decides what of it
            // is safe to show. The cost is that assistant-ui's generic tool UI
            // would render argument-less, and we do not use it.
          },
        ],
        status:
          entry.status === "in_progress" || entry.status === "pending"
            ? { type: "running" }
            : { type: "complete", reason: "unknown" },
        metadata,
      };

    case "approval":
      return {
        role: "assistant",
        id: entry.id,
        content: [
          {
            type: "tool-call",
            toolCallId: entry.requestId,
            toolName: entry.tool,
            // A clearance is not a second kind of message: assistant-ui models
            // it as a field on the call it gates, which is the same shape the
            // transcript draws (a card where the call happened).
            approval: {
              id: entry.requestId,
              approved: entry.decision === null ? undefined : entry.decision === "allow",
            },
          },
        ],
        status:
          entry.decision === null
            ? { type: "requires-action", reason: "tool-calls" }
            : { type: "complete", reason: "unknown" },
        metadata,
      };

    default:
      // A payload this build has never seen. The escape hatch is real: a
      // `data-` prefixed part takes arbitrary JSON, so an unknown frame still
      // reaches the operator as itself rather than being dropped for not
      // fitting a vocabulary.
      return {
        role: "assistant",
        id: entry.id,
        content: [{ type: "data-omp-unknown", data: { label: entry.label, payload: entry.payload } }],
        metadata,
      };
  }
}

/**
 * Everything the runtime needs from the pane, in one object.
 *
 * Deliberately the same inputs the screen already has, so no caller has to
 * assemble a second view of the session to use this.
 */
export interface OmpStoreInput {
  readonly agent: Agent;
  readonly session: SessionState;
  readonly connection: ConnectionState;
  readonly load: SessionLoad;
  readonly promptAccess: PromptScopeAccess;
  readonly onSubmit: (text: string) => void;
  readonly onCancel: () => void;
}

/**
 * The adapter object, without the React hook.
 *
 * Split out so the mapping is testable as a pure function: every claim about
 * disabled-ness, running-ness and dispatch can be asserted without mounting a
 * provider, and the provider test then only has to prove the library renders.
 */
export function ompStore(input: OmpStoreInput) {
  const { agent, session, connection, load, promptAccess } = input;

  const streaming = session.entries.some(entry => entry.kind === "assistant" && entry.streaming);
  const clearances = session.pendingApprovals.length + (session.planReview === null ? 0 : 1);

  return {
    messages: session.entries,
    convertMessage: convertEntry,

    /**
     * `isRunning` is the thread's own claim that work is in flight, and it is
     * derived from the same facts `agentActivity` uses rather than from a
     * timer: a state that has gone idle reads idle on this very render.
     */
    isRunning: agent.state === "busy" || streaming || session.activity.running > 0,

    /** The pane is still waiting for its first authoritative answer. */
    isLoading: load.phase === "loading",

    /**
     * The two gates are different and the distinction is load-bearing.
     * `isDisabled` takes the input away entirely, which is right when this
     * device cannot steer at all -- no link, a dead session, or a pane whose
     * open was refused. `isSendDisabled` leaves the operator able to type and
     * only refuses the send, which is right for a missing prompt scope: they
     * can compose, and the refusal below says why it will not go.
     */
    isDisabled: connection !== "connected" || load.phase === "failed" || TERMINAL_AGENT_STATES.includes(agent.state),
    isSendDisabled: promptAccess !== "granted" || clearances > 0,

    onNew: async (message: { content: readonly unknown[] }): Promise<void> => {
      // The composer's own parts, flattened to the text the daemon takes. An
      // attachment adapter is what will carry images; this proof sends prose.
      const text = message.content
        .map(part =>
          part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
            ? String(part.text)
            : "",
        )
        .join("");
      if (text.length === 0) return;
      input.onSubmit(text);
    },

    onCancel: async (): Promise<void> => {
      input.onCancel();
    },
  };
}
