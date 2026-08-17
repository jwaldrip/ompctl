/**
 * The sanitizer is the control that keeps an operator's command inventory out of
 * the committed fixture. It had none of its own tests, and the repository's
 * provenance sweep cannot substitute for them: the sweep matches a fixed list of
 * terms, so it would miss a different operator's clients entirely. This asserts
 * the mechanism instead of the denylist.
 *
 * The contaminated inputs below are invented. Using real ones would commit them
 * to this repository and the provenance sweep would flag this very file, which is
 * the mistake that sweep caught the first time it ran.
 */
import { describe, expect, test } from "bun:test";
import { SYNTHETIC_COMMANDS, scrubUpdate } from "./capture-sanitize.ts";

/** Shaped like the real thing: skill names plus prose descriptions. */
const OPERATOR_INVENTORY = [
  { name: "acme-holdings-billing", description: "Reconcile invoices for Acme Holdings" },
  { name: "quarterly-payroll", description: "Payroll run for the Northwind account" },
  { name: "family-calendar", description: "Check the shared calendar", input: { hint: "<person>" } },
];

const CONTAMINATED = {
  sessionUpdate: "available_commands_update",
  availableCommands: OPERATOR_INVENTORY,
};

describe("scrubUpdate", () => {
  test("removes every trace of the operator's inventory", () => {
    const out = JSON.stringify(scrubUpdate(CONTAMINATED));
    // Names and descriptions both leak, so both are asserted absent.
    for (const cmd of OPERATOR_INVENTORY) {
      expect(out).not.toContain(cmd.name);
      expect(out).not.toContain(cmd.description);
    }
    expect(out).not.toContain("Acme");
    expect(out).not.toContain("Northwind");
  });

  test("substitutes the synthetic list, so the fixture is not merely emptied", () => {
    // An empty list would also pass the assertion above while destroying the
    // shape the fixture exists to pin.
    const out = scrubUpdate(CONTAMINATED) as Record<string, unknown>;
    expect(out.availableCommands).toEqual(SYNTHETIC_COMMANDS);
    expect((out.availableCommands as unknown[]).length).toBeGreaterThan(0);
  });

  test("keeps the fields the renderer reads", () => {
    // The web and app transcripts read name, description, and input.hint. If the
    // replacement dropped one, the fixture would stop exercising that path and a
    // renderer regression would go unnoticed.
    const cmds = (scrubUpdate(CONTAMINATED) as Record<string, unknown>).availableCommands as Array<
      Record<string, unknown>
    >;
    for (const cmd of cmds) {
      expect(typeof cmd.name).toBe("string");
      expect(typeof cmd.description).toBe("string");
    }
    const withInput = cmds.filter(c => c.input !== undefined);
    const withoutInput = cmds.filter(c => c.input === undefined);
    expect(withInput.length).toBeGreaterThan(0);
    expect(withoutInput.length).toBeGreaterThan(0);
    expect((withInput[0]?.input as Record<string, unknown>)?.hint).toBeTypeOf("string");
  });

  test("preserves sibling fields on the update it scrubs", () => {
    // Only the command list is private. Dropping the rest would silently change
    // the captured shape.
    const out = scrubUpdate({ ...CONTAMINATED, sessionId: "sess-1" }) as Record<string, unknown>;
    expect(out.sessionId).toBe("sess-1");
    expect(out.sessionUpdate).toBe("available_commands_update");
  });

  test("leaves other update kinds untouched", () => {
    // Scrubbing indiscriminately would gut every other captured shape.
    const chunk = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };
    expect(scrubUpdate(chunk)).toBe(chunk);
  });

  test("does not scrub on the presence of a command list alone", () => {
    // The function keys on `sessionUpdate`. A payload that merely carries an
    // `availableCommands` field under a different kind is passed through, which
    // documents the deliberate limit: a NEW kind carrying a command list would
    // need adding here, and this test is where that decision is recorded.
    const other = { sessionUpdate: "session_info_update", availableCommands: OPERATOR_INVENTORY };
    expect(scrubUpdate(other)).toBe(other);
  });

  test("passes non-objects through instead of throwing", () => {
    // The capture loop hands it whatever arrived on the wire.
    expect(scrubUpdate(null)).toBeNull();
    expect(scrubUpdate(undefined)).toBeUndefined();
    expect(scrubUpdate("text")).toBe("text");
    expect(scrubUpdate(7)).toBe(7);
  });

  test("does not mutate its input", () => {
    // The capture loop reassigns the result; a mutating implementation would also
    // corrupt the caller's copy of the real stream, which is harmless here but
    // makes the function unsafe to reuse.
    const input = { sessionUpdate: "available_commands_update", availableCommands: [...OPERATOR_INVENTORY] };
    scrubUpdate(input);
    expect(input.availableCommands).toEqual(OPERATOR_INVENTORY);
  });
});

describe("SYNTHETIC_COMMANDS", () => {
  test("is free of anything machine-specific", () => {
    // Paths, home directories, and hostnames are the ways a "synthetic" list
    // quietly becomes a real one.
    const s = JSON.stringify(SYNTHETIC_COMMANDS);
    expect(s).not.toContain("/Users/");
    expect(s).not.toContain("/home/");
    expect(s).not.toMatch(/\.local|\.internal/);
  });
});
