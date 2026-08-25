/**
 * An ACP peer's error has to arrive as a sentence somebody can act on.
 *
 * omp answers a failed `session/new` with the JSON-RPC spec's generic text --
 * `code: -32603, message: "Internal error"` -- and puts the only useful part in
 * `data.details`. Every layer above reads `err.message`, so a client that kept
 * the message alone turned "ompd-webview: Unable to connect. Is the computer
 * able to access the url?" into "Internal error" by the time an operator saw it
 * as an HTTP 500 body, with nothing in the log either. That is what made a
 * container-host defect undiagnosable from the daemon's own output.
 *
 * These run against the real `AcpError`. The first one fails on 7411b47, where
 * the constructor handed `message` straight to `super`.
 */

import { describe, expect, test } from "bun:test";
import { AcpError } from "../src/client.ts";

describe("an ACP error keeps the detail its peer supplied", () => {
  test("data.details is folded into the message", () => {
    const err = new AcpError("Internal error", -32603, {
      details: "ompd-webview: Unable to connect. Is the computer able to access the url?",
    });
    expect(err.message).toBe(
      "Internal error: ompd-webview: Unable to connect. Is the computer able to access the url?",
    );
  });

  test("code and data are still carried whole, for anything that inspects them", () => {
    const data = { details: "x", extra: 1 };
    const err = new AcpError("Internal error", -32603, data);
    expect(err.code).toBe(-32603);
    expect(err.data).toBe(data);
  });

  test("a message with no data is untouched", () => {
    expect(new AcpError("transport closed").message).toBe("transport closed");
  });

  test("data without a string details is untouched, because a message is not a dump", () => {
    expect(new AcpError("boom", 1, { other: { deep: true } }).message).toBe("boom");
    expect(new AcpError("boom", 1, { details: 42 }).message).toBe("boom");
    expect(new AcpError("boom", 1, { details: "" }).message).toBe("boom");
  });

  test("a peer that repeats itself does not get said twice", () => {
    const err = new AcpError("already: unreachable", 1, { details: "unreachable" });
    expect(err.message).toBe("already: unreachable");
  });

  test("it is still an Error, so every catch above keeps working", () => {
    const err = new AcpError("Internal error", -32603, { details: "why" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AcpError");
    expect(String(err)).toContain("why");
  });
});
