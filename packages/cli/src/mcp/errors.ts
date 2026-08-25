/**
 * Turning a failed daemon call into something a model can act on.
 *
 * An MCP client sees one thing when a tool fails: the text in the error
 * result. So the three states an operator most often lands in have to be
 * visibly different in that text, because they need three different actions
 * and a model handed one message for all three will pick the wrong one.
 *
 *   offline  the daemon is not running, or is not where this shell looked
 *   auth     a token was presented and refused
 *   scope    the token is valid and is not allowed to do this
 *
 * Everything here reuses the CLI's own error types rather than re-reading
 * status codes, so the MCP surface reports the same failures the CLI reports,
 * with the same causes named the same way.
 *
 * Nothing in this file interpolates a response body. A token and a freshly
 * minted webhook secret both travel through these code paths, and an error
 * message is the one place a credential leaks without anyone deciding to
 * print it.
 */

import { ApiError, DaemonUnreachableError, TokenMissingError } from "../client.ts";

/**
 * The shape `McpServer` expects from a failed tool call. Declared here rather
 * than imported from the SDK because it is the narrow part of `CallToolResult`
 * these handlers actually produce, and naming it keeps every handler's return
 * type honest.
 *
 * A `type` and not an `interface` on purpose: the SDK's `CallToolResult`
 * carries an index signature, and TypeScript only gives an anonymous object
 * type the implicit index signature that makes it assignable to one.
 */
export type ToolErrorResult = {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
};

const SCOPE_GUIDANCE =
  "the daemon accepted this token and refused the operation: it does not hold the " +
  "`manage` scope, which every write here needs (create, update, delete, run, rotate). " +
  "Pair a device with `ompd pair <name>` and approve it with the manage scope, or use " +
  "the local operator token at ~/.ompd/token.";

const RUNNER_MISSING_GUIDANCE =
  "this daemon has no routine runner wired in, so routines are off rather than broken. " +
  "Nothing is scheduled and nothing can be started until one is configured; the routine " +
  "list and this tool will keep answering the same way until then.";

/**
 * Map a thrown error onto a tool error result.
 *
 * `action` names what was being attempted, in the imperative, so the first
 * clause of the message is the thing that failed rather than a bare cause with
 * no subject: "create a routine: no operator token was found".
 */
export function toolError(action: string, err: unknown): ToolErrorResult {
  return { content: [{ type: "text", text: `${action}: ${describe(err)}` }], isError: true };
}

function describe(err: unknown): string {
  if (err instanceof TokenMissingError) {
    // The CLI's own guidance text, verbatim, so an operator who reads this in
    // a chat window and then runs the CLI is told the same thing twice rather
    // than two half-answers.
    return (
      "no operator token was found, so nothing was sent. The daemon mints one at " +
      `~/.ompd/token when it starts, and \`ompd start\` is what does that.\n${err.message}`
    );
  }

  if (err instanceof DaemonUnreachableError) {
    // Naming the URL is the whole point: the usual cause is not a dead daemon
    // but a shell pointed at the wrong one by OMPD_URL or a stale endpoint
    // file, and that is invisible unless the address is in the message.
    return `no daemon is listening at ${err.url}, so nothing was sent. Start it with \`ompd start\`, or point this shell at a running one with OMPD_URL.`;
  }

  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        // `api` has already swapped the daemon's body for the CLI's
        // rejected-token guidance, which opens with "the daemon rejected this
        // token" and then explains the three causes. Carried through
        // unchanged: prefixing it with a sentence that says the same thing
        // reads as a stutter, and this is the text an operator acts on.
        return err.message;
      case 403:
        return SCOPE_GUIDANCE;
      case 404:
        // The daemon's own reason, because it distinguishes "no such routine"
        // from "that routine is not a webhook routine" and re-wording it here
        // would flatten the two.
        return `the daemon found nothing to act on: ${withReason(err)}`;
      case 400:
        // Verbatim, error name and reason both. These strings are written to
        // be read by whoever sent the bad request, and paraphrasing a
        // validation failure is how a caller ends up fixing the wrong field.
        return `the daemon refused the request as invalid: ${withReason(err)}`;
      case 503:
        return RUNNER_MISSING_GUIDANCE;
      default:
        return err.message;
    }
  }

  return err instanceof Error ? err.message : String(err);
}

/**
 * The daemon's error name, plus its `reason` when it sent one.
 *
 * `api` puts only the name in `message`, because that is all most callers
 * want. A rejected write is the exception: the reason is the single sentence
 * that says which field to fix, and without it a model retries the same
 * request with a different guess.
 */
function withReason(err: ApiError): string {
  const reason = reasonOf(err.body);
  return reason === null ? err.message : `${err.message} (${reason})`;
}

/** `in` narrows to `unknown`, which is what an unvalidated body holds. */
function reasonOf(body: unknown): string | null {
  if (body === null || typeof body !== "object" || !("reason" in body)) return null;
  const reason = body.reason;
  return typeof reason === "string" && reason.length > 0 ? reason : null;
}
