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

import type { RespondToToolApprovalOptions, ThreadMessageLike, ToolApprovalOption } from "@assistant-ui/core";
import type { Agent, ApprovalChoice, ApprovalScope, PlanReviewChoice, PromptImage } from "@ompd/core/contracts";
import { TERMINAL_AGENT_STATES } from "@ompd/core/contracts";
import type { ConnectionState } from "@ompd/core/ompd-client";
import type { PromptScopeAccess, SessionLoad } from "../console/state.ts";
import type { Entry, SessionState } from "../session/model.ts";

/**
 * The decisions a clearance can take, as assistant-ui's own option list.
 *
 * This exists because `RespondToToolApprovalOptions` is
 * `{ approvalId: string; approved: boolean; optionId?: string; reason?: string }`
 * -- a boolean, and nothing else that carries a decision. Our contract is two
 * fields: `ApprovalChoice` ("allow" | "deny") and `ApprovalScope`
 * ("once" | "always"). A boolean cannot say "always", so a standing grant
 * answered through assistant-ui's own path would be silently downgraded to a
 * one-shot approval and the operator would be asked again on the next call.
 *
 * `optionId` is what recovers it, and publishing this list is what makes
 * `optionId` usable at all: the library resolves an option to a boolean by its
 * `kind` (`resolveToolApprovalResponse`: `allow-once` / `allow-always` -> true,
 * `reject-once` / `reject-always` -> false) and THROWS on an option id it
 * cannot find on the part. So `always` is expressible, through the id rather
 * than through `approved`.
 *
 * Exactly the three controls `ApprovalCard` draws, in its order, with its
 * words. A fourth (`reject-always`, which our own daemon contract can express)
 * is deliberately absent: offering a decision on one surface and not the other
 * is how two surfaces stop being the same product.
 *
 * `grants` is left unset. It is documented as "patterns or rules this option
 * would persist, shown before the user commits. Supplied by the host; never
 * derived by the library" -- and the only host that knows what a standing
 * grant actually covers is the daemon, which does not tell us. A sentence
 * invented here would put a claim about permission scope in front of an
 * operator on our authority. `confirm` is unset for the reason `ApprovalCard`
 * has no confirmation step: the three buttons are the decision.
 */
export const APPROVAL_OPTIONS: readonly ToolApprovalOption[] = [
  { id: "omp:allow-once", kind: "allow-once", label: "Allow" },
  { id: "omp:deny-once", kind: "reject-once", label: "Reject" },
  { id: "omp:allow-always", kind: "allow-always", label: "Always" },
];

/** An answered option, back to the two fields the daemon takes. */
const APPROVAL_BY_OPTION: Readonly<Record<string, { choice: ApprovalChoice; scope: ApprovalScope }>> = {
  "omp:allow-once": { choice: "allow", scope: "once" },
  "omp:deny-once": { choice: "deny", scope: "once" },
  "omp:allow-always": { choice: "allow", scope: "always" },
};

/**
 * An assistant row's identity: the row id it was born with, discriminated by
 * channel. Exported because the list's pagination machine has to derive the head
 * key the same way, and two derivations would make a prepend and a re-render
 * indistinguishable.
 */
export function assistantRowId(entry: { rowId: string; thought: boolean }): string {
  return entry.thought ? `thought:${entry.rowId}` : entry.rowId;
}

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
        // `rowId`, never `id`. `id` follows the wire and rotates mid-reply, and
        // assistant-ui keys messages on this field: five rotations made it
        // mount five assistant messages and strand four as sibling branches
        // that nothing reaps, each holding its own `metadata.custom` snapshot.
        // Measured before `rowId` existed: 2 entries in the reducer,
        // `thread.export()` returning 6.
        // The channel is part of the identity, not just the row id. A thought
        // and a reply can carry the SAME wire message id -- `findChunkTarget`
        // keeps them as separate rows precisely because they are different
        // channels -- so keying on `rowId` alone made them collide and one
        // silently won. `transcriptRowKey` already draws this distinction; this
        // is the same discrimination in the same shape.
        id: assistantRowId(entry),
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
              // Published so a decision answered through assistant-ui's own
              // path can say WHICH decision it was. Without a list, the only
              // thing coming back is a boolean and `always` is unsayable. See
              // `APPROVAL_OPTIONS`. Labels only: no title, no arguments.
              options: APPROVAL_OPTIONS,
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
 * The composer's own message, narrowed to the two fields `onNew` reads.
 *
 * Structural rather than `AppendMessage`: that type's `content` is the full
 * union of user part kinds and its `attachments` are `CompleteAttachment`s, and
 * naming it here would make this signature harder to satisfy from a test than
 * from the runtime. What is actually depended on is these two arrays.
 */
interface AppendedMessage {
  readonly content: readonly unknown[];
  readonly attachments?: readonly unknown[];
}

/**
 * The composer's attachments, as the images the daemon takes.
 *
 * assistant-ui carries an image attachment as a part whose `image` is a data
 * URL; `PromptImage.data` is base64 with no wrapper (see its doc comment in
 * `contracts.ts`), so the prefix comes off here. An attachment that is not an
 * image part, or whose payload is not a data URL, is DROPPED rather than
 * forwarded as garbage: `parsePromptImages` on the daemon side would refuse the
 * whole prompt for one bad member, which would lose the operator's text too.
 *
 * Returns `undefined` rather than `[]` because that is what the wire means by
 * "no images" (`{ t: "prompt"; images?: PromptImage[] }`) and what the shipped
 * `Composer` already passes.
 */
function promptImagesOf(attachments: readonly unknown[] | undefined): PromptImage[] | undefined {
  if (attachments === undefined || attachments.length === 0) return undefined;
  const images: PromptImage[] = [];
  for (const attachment of attachments) {
    if (attachment === null || typeof attachment !== "object") continue;
    const mimeType = Reflect.get(attachment, "contentType");
    const content: unknown = Reflect.get(attachment, "content");
    if (typeof mimeType !== "string" || !Array.isArray(content)) continue;
    const part: unknown = content[0];
    if (part === null || typeof part !== "object") continue;
    if (Reflect.get(part, "type") !== "image") continue;
    const url = Reflect.get(part, "image");
    if (typeof url !== "string" || !url.startsWith("data:")) continue;
    const comma = url.indexOf(",");
    if (comma < 0) continue;
    const data = url.slice(comma + 1);
    if (data.length === 0) continue;
    images.push({ mimeType, data });
  }
  return images.length === 0 ? undefined : images;
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
  /**
   * The same signature the shipped `Composer` already calls
   * (`Composer.tsx:89`), so a screen wires one handler to either surface. An
   * image-only prompt sends with empty text, which is #131's contract.
   */
  readonly onSubmit: (text: string, images?: PromptImage[]) => void;
  readonly onCancel: () => void;
  /**
   * False when this device's pairing does not hold the approve scope. It gates
   * two things that must agree: whether `ApprovalCard` draws controls at all,
   * and whether this store claims the approval capability. They are the same
   * fact, so they read the same field.
   */
  readonly canApprove: boolean;
  /** Why approval is refused, when the daemon has said so. Shown, not implied. */
  readonly refusal?: string;
  /**
   * Required, not optional, and that is the point: a screen that assembled
   * this without a decision handler would render clearance buttons that do
   * nothing, and an operator would tap allow on a command that never ran. A
   * missing handler is a compile error instead.
   */
  readonly onDecide: (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;
  /**
   * A plan review is not an `Entry` -- it is `session.planReview`, drawn by
   * `PlanCard` above the log rather than as a row in it -- so nothing in this
   * conversion reaches it. It rides here because it is the other half of the
   * same clearance surface (`isSendDisabled` above already counts it), and a
   * consumer holding this object should not have to assemble a second one to
   * answer it.
   */
  readonly onDecidePlan: (requestId: string, choice: PlanReviewChoice) => void;
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

    onNew: async (message: AppendedMessage): Promise<void> => {
      // The composer's own parts, flattened to the text the daemon takes.
      const text = message.content
        .map(part =>
          part !== null && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
            ? String(part.text)
            : "",
        )
        .join("");
      const images = promptImagesOf(message.attachments);
      // An image-only prompt is as real as a text-only one (#131), so the guard
      // is "nothing at all", not "no text". Refusing here would swallow a send
      // the composer had already accepted.
      if (text.length === 0 && images === undefined) return;
      input.onSubmit(text, images);
    },

    onCancel: async (): Promise<void> => {
      input.onCancel();
    },

    /**
     * A clearance answered through assistant-ui's own path, dispatched to the
     * daemon. `ApprovalCard` calls `onDecide` directly and always will; this is
     * the second door -- a keyboard shortcut, an approval primitive, anything
     * in the library that resolves an approval -- and it lands in the same
     * place rather than in a silent no-op.
     *
     * Supplied only when this device holds the approve scope. That is not
     * belt-and-braces: `canApprove` is exactly the fact that decides whether
     * `ApprovalCard` draws controls, and if this seam stayed live while the
     * card showed its refusal, the library's own path would be a way around
     * the scope gate. Absent, `respondToToolApproval` throws "Runtime does not
     * support tool approvals." from core itself
     * (`external-store-thread-runtime-core.js:426`), which is the honest
     * answer: no scope, no capability.
     */
    onRespondToToolApproval: input.canApprove
      ? ({ approvalId, approved, optionId }: RespondToToolApprovalOptions): void => {
          // `approvalId` is our `requestId`: it is what `convertEntry` puts in
          // `approval.id`, so no lookup is needed to get back to the daemon's
          // own identifier.
          const decided = optionId === undefined ? undefined : APPROVAL_BY_OPTION[optionId];
          if (decided !== undefined) {
            input.onDecide(approvalId, decided.choice, decided.scope);
            return;
          }
          // No option id, or one we never published. `approved` is the only
          // field the shape guarantees, so it decides the choice -- and the
          // scope is `once`, because a standing permission is a different act
          // from approving one command and is never something to infer.
          input.onDecide(approvalId, approved ? "allow" : "deny", "once");
        }
      : undefined,

    // `onAddToolResult` is deliberately NOT wired, and not stubbed either.
    // It exists for tools that execute in the client: the runtime calls it with
    // `{ messageId, toolName, toolCallId, result, isError }` so the adapter can
    // send that result back to its backend. ompctl has no client-side tools --
    // every call runs inside omp on the host machine and the daemon streams the
    // outcome to us, which is where `ToolEntry.output` comes from. There is
    // nothing for this device to send back, and the pipeline that would produce
    // a call is off (`unstable_enableToolInvocations` defaults false). A stub
    // would be worse than the absence: writing into our store here would invent
    // transcript content the daemon never produced, and returning silently
    // would claim a result reached omp when nothing left the device.
  };
}
