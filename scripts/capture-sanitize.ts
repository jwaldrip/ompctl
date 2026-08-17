/**
 * Strip the operator's command inventory out of a captured `session/update`.
 *
 * `available_commands_update` advertises every command and skill the operator has
 * installed, descriptions included. On a real machine that is a personal
 * inventory: clients, finances, family. `capture-updates.ts` writes its output to
 * a committed test fixture, so capturing that verbatim publishes it, which is
 * exactly what happened once already.
 *
 * Extracted from the capture script so it can be tested. The script itself spawns
 * a host and drives a real turn at module scope, so importing it in a test is not
 * an option, and an untested sanitizer is the one thing here that must not be
 * taken on trust: the repository's provenance sweep only knows a fixed list of
 * terms, while this function is the actual control. A different operator's
 * inventory would carry names no denylist has heard of.
 *
 * The fixture exists to pin the SHAPE of each update, never the operator's list,
 * so the list is replaced with a synthetic one that keeps every field the renderer
 * reads, including one entry with `input` and two without.
 */

/** The only command list that may ever reach the committed fixture. */
export const SYNTHETIC_COMMANDS: ReadonlyArray<Record<string, unknown>> = [
  { name: "help", description: "Show the available commands" },
  { name: "model", description: "Choose the model for this session", input: { hint: "<model-id>" } },
  { name: "resume", description: "Resume an earlier session", input: { hint: "<session-id>" } },
];

/**
 * Replace the command list on a commands update; pass everything else through.
 *
 * Deliberately keyed on `sessionUpdate` rather than on the presence of an
 * `availableCommands` field: a future update kind that also carries a command
 * list would then be missed, and the failure would be silent.
 */
export function scrubUpdate(update: unknown): unknown {
  if (update === null || typeof update !== "object") return update;
  const rec = update as Record<string, unknown>;
  if (rec.sessionUpdate !== "available_commands_update") return update;
  return { ...rec, availableCommands: SYNTHETIC_COMMANDS };
}
