/**
 * Does an ompctl row rendered inside assistant-ui still behave like an ompctl
 * row?
 *
 * Three separate claims, and they need different proof:
 *
 *  - Identity. `entry-user` and `entry-assistant` are constant per kind because
 *    a path scenario enumerates every row carrying them and compares labels.
 *    Uniquifying them once broke that step while the product was correct on
 *    device, so the ids are asserted as literals here, not derived.
 *  - Containment. omp builds ACP's `title` from a call's own arguments, so a
 *    title routinely carries a command line and whatever token was on it. The
 *    test below plants a bearer token in one and proves it reaches exactly one
 *    place: the card's own text node. Not a label, not a kicker, not a gutter.
 *  - Actionability. A clearance that renders three buttons and dispatches
 *    nothing is worse than no clearance at all, because the operator believes
 *    they answered. So the buttons are pressed, and the dispatch is what is
 *    asserted -- both through the card and through assistant-ui's own approval
 *    seam on the store.
 *
 * Entries come from the real reducer wherever it can produce them. Hand-built
 * literals drift the moment `Entry` gains a field, and one already has.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { ExternalStoreAdapter } from "@assistant-ui/core";
import type { Agent, ApprovalChoice, ApprovalScope } from "@ompd/core/contracts";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { OmpEntryRowProps } from "../src/assistant/renderers.tsx";
import type { Entry } from "../src/session/model.ts";

// Dynamic on purpose, the same way `pair-connections-consistency.test.tsx`
// loads its screens: bun evaluates a file's whole static import graph before
// its body runs, so a static VALUE import of anything reaching `react-native`
// would pull the real one in before `./rnw.ts` could substitute it, and the
// real DOM globals before happy-dom is registered. The `import type` lines
// above are erased, so they cost nothing at runtime.
const { OmpEntryRow } = await import("../src/assistant/renderers.tsx");
const { APPROVAL_OPTIONS, ompStore } = await import("../src/assistant/adapter.ts");
const { GLYPHS } = await import("../src/design/icons.tsx");
const { ink, signal } = await import("../src/design/tokens.ts");
const { EMPTY_SESSION, appendApproval, endTurn, reduce, resolveApproval } = await import("../src/session/model.ts");
const { READY_LOAD } = await import("../src/console/state.ts");
const { StyleSheet } = await import("react-native");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** RNW exposes this stylesheet API at runtime but not in its TypeScript surface. */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/**
 * A command line with a live-looking bearer token in it, shaped the way omp
 * actually builds a title. One string, used by every containment assertion, so
 * a test that stops covering it cannot pass by testing a different string.
 */
const SECRET_TITLE = "bash -c 'curl -H \"Authorization: Bearer sk-live-DEADBEEF\" https://x/y'";

interface Mounted {
  host: HTMLElement;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    host,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function byTestID(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} rendered`);
  return element;
}

/**
 * The declarations an element actually carries, from BOTH places RNW puts them.
 *
 * Static `StyleSheet` values compile to atomic classes whose declarations live
 * in the sheet, not in the markup, so reading the element alone sees class
 * names and no values (the technique
 * `pair-connections-consistency.test.tsx` uses). Values computed at render
 * time -- every colour on these rows, because the gutter and the kicker take
 * their tone from `entry.thought` -- are written inline instead, and are
 * invisible to a sheet-only read. A row's colour would silently read
 * `undefined` from either half alone, so this merges them and lets inline win,
 * which is what the cascade does.
 *
 * Values are stripped of whitespace because the two halves serialise the same
 * colour differently: `rgba(143,169,123,1.00)` in the sheet,
 * `rgba(143, 169, 123, 1.00)` inline.
 */
function declarationsFor(el: Element): Map<string, string> {
  const classes = el.className.split(/\s+/).filter(Boolean);
  const out = new Map<string, string>();
  const take = (text: string): void => {
    for (const declaration of text.matchAll(/([a-z-]+):\s*([^;]+);/gi)) {
      const property = declaration[1];
      const value = declaration[2];
      if (property === undefined || value === undefined) continue;
      out.set(property.toLowerCase(), value.replaceAll(" ", "").trim());
    }
  };
  for (const rule of rnwStyleSheet.getSheet().textContent.split("\n")) {
    if (!classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule))) continue;
    take(rule);
  }
  const inline = el.getAttribute("style");
  if (inline !== null) take(inline.endsWith(";") ? inline : `${inline};`);
  return out;
}

/** A six-digit hex token as the rgba() RNW's compilers serialise it to. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},1.00)`;
}

/** Every `d` attribute in a subtree. A FontAwesome glyph is one of these. */
function pathsIn(el: HTMLElement): string[] {
  return [...el.querySelectorAll("path")].map(path => path.getAttribute("d") ?? "");
}

/** Every accessibility label in a subtree, the element's own included. */
function labelsIn(el: HTMLElement): string[] {
  const out: string[] = [];
  for (const node of [el, ...el.querySelectorAll("*")]) {
    for (const name of ["aria-label", "accessibilitylabel", "aria-labelledby", "title", "alt"]) {
      const value = node.getAttribute(name);
      if (value !== null) out.push(value);
    }
  }
  return out;
}

/**
 * Presses a `Pressable`.
 *
 * Two steps, and both matter. The handler is first read off the rendered node's
 * React props, the way `composer-submit.test.tsx` reads `onChange` off an
 * input: that is what makes a missing handler a loud failure here rather than a
 * silent no-op the assertion would go on to blame on the component. Then a REAL
 * click is dispatched, because RNW's press responder ignores a hand-rolled
 * synthetic event -- measured: calling `props.onClick` with a plausible event
 * object dispatched nothing, while `el.click()` dispatched once.
 */
function press(el: HTMLElement): void {
  const key = Object.keys(el).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered pressable");
  const props = Reflect.get(el, key) as { onClick?: unknown };
  if (typeof props.onClick !== "function") throw new Error("the rendered pressable has no click handler");
  el.click();
}

/**
 * One dispatched decision, recorded verbatim. Typed against the contract on
 * purpose: a test asserting a choice or scope the daemon does not accept fails
 * at the typecheck rather than passing on a string that means nothing.
 */
type DecidedCall = [requestId: string, choice: ApprovalChoice, scope: ApprovalScope | undefined];
type Decided = (requestId: string, choice: ApprovalChoice, scope?: ApprovalScope) => void;

const NO_DECIDE = (): void => {
  throw new Error("onDecide was called by a row that should not decide anything");
};

function row(entry: Entry, overrides: Partial<OmpEntryRowProps> = {}): Mounted {
  return mount(<OmpEntryRow canApprove={false} entry={entry} onDecide={NO_DECIDE} {...overrides} />);
}

// ---------------------------------------------------------------------------
// Fixtures, from the reducer
// ---------------------------------------------------------------------------

function userEntry(text: string): Entry {
  const session = reduce(EMPTY_SESSION, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text },
    messageId: "u1",
  });
  const entry = session.entries[0];
  if (entry === undefined) throw new Error("the reducer produced no user entry");
  return entry;
}

function assistantEntry(text: string, opts: { thought?: boolean; streaming?: boolean } = {}): Entry {
  const opened = reduce(EMPTY_SESSION, {
    sessionUpdate: opts.thought === true ? "agent_thought_chunk" : "agent_message_chunk",
    content: { type: "text", text },
    messageId: "m1",
  });
  // A chunk opens streaming; a settled row is the same row after the turn
  // ended, which is the path the daemon actually takes.
  const session = opts.streaming === true ? opened : endTurn(opened);
  const entry = session.entries[0];
  if (entry === undefined) throw new Error("the reducer produced no assistant entry");
  return entry;
}

function toolEntry(title: string) {
  const session = reduce(EMPTY_SESSION, {
    sessionUpdate: "tool_call",
    toolCallId: "t1",
    kind: "execute",
    title,
    status: "in_progress",
    rawInput: { command: title },
  });
  const entry = session.entries[0];
  if (entry === undefined || entry.kind !== "tool") throw new Error("the reducer produced no tool entry");
  return entry;
}

function approvalEntry(title: string, decision: "allow" | "deny" | null = null) {
  let session = appendApproval(EMPTY_SESSION, { requestId: "r1", tool: "bash", title, input: { command: title } });
  if (decision !== null) session = resolveApproval(session, "r1", decision);
  const entry = session.entries[0];
  if (entry === undefined || entry.kind !== "approval") throw new Error("the reducer produced no approval entry");
  return entry;
}

function unknownEntry() {
  const session = reduce(EMPTY_SESSION, { sessionUpdate: "a_kind_from_the_future", weird: 1 });
  const entry = session.entries[0];
  if (entry === undefined || entry.kind !== "unknown") throw new Error("the reducer produced no unknown entry");
  return entry;
}

// ---------------------------------------------------------------------------
// Identity: every kind renders its own component, under its own id
// ---------------------------------------------------------------------------

describe("every entry kind renders the component the transcript already draws", () => {
  test("a user turn is the gutter row, with the raw text as its label", () => {
    const mounted = row(userEntry("pineapple-user-nonce"));
    try {
      const el = byTestID(mounted.host, "entry-user");
      expect(el.getAttribute("aria-label")).toBe("you: pineapple-user-nonce");
      // The prose is RichText's, not the label's: the text is on screen too.
      expect(el.textContent).toContain("pineapple-user-nonce");
      expect(declarationsFor(el.firstElementChild!).get("border-left-color")).toBe(rgb(ink.faint));
      expect(el.textContent).toContain("you");
    } finally {
      mounted.unmount();
    }
  });

  test("a reply is `entry-assistant` with the agent attribution", () => {
    const mounted = row(assistantEntry("pineapple-agent-nonce"));
    try {
      const el = byTestID(mounted.host, "entry-assistant");
      expect(el.getAttribute("aria-label")).toBe("agent: pineapple-agent-nonce");
      expect(declarationsFor(el.firstElementChild!).get("border-left-color")).toBe(rgb(signal.sage));
    } finally {
      mounted.unmount();
    }
  });

  test("a thought is the SAME id as a reply, so a driver enumerating rows finds both", () => {
    // Load-bearing. The path scenario reads every `entry-assistant` and
    // compares labels; a separate id for thoughts would hide half the turn.
    const reply = row(assistantEntry("said"));
    const thought = row(assistantEntry("weighed", { thought: true }));
    try {
      expect(byTestID(reply.host, "entry-assistant").getAttribute("aria-label")).toBe("agent: said");
      expect(byTestID(thought.host, "entry-assistant").getAttribute("aria-label")).toBe("thinking: weighed");
    } finally {
      reply.unmount();
      thought.unmount();
    }
  });

  test("a tool call is a ToolCard, keyed by the call id", () => {
    const entry = toolEntry("read src/index.ts");
    const mounted = row(entry);
    try {
      expect(byTestID(mounted.host, `tool-${entry.id}`)).toBeDefined();
      expect(byTestID(mounted.host, `tool-title-${entry.id}`).textContent).toContain("read src/index.ts");
      expect(byTestID(mounted.host, `tool-status-${entry.id}`).textContent).toBe("in progress");
      // Not the generic row: a tool has no gutter and no speaker.
      expect(mounted.host.querySelector('[data-testid="entry-assistant"]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("a clearance is an ApprovalCard, keyed by the request id", () => {
    const mounted = row(approvalEntry("git branch -D park/old"), { canApprove: true, onDecide: () => {} });
    try {
      expect(byTestID(mounted.host, "approval-r1")).toBeDefined();
      expect(byTestID(mounted.host, "approval-state-r1").textContent).toBe("clearance");
      expect(byTestID(mounted.host, "approval-title-r1").textContent).toBe("git branch -D park/old");
    } finally {
      mounted.unmount();
    }
  });

  test("a settled clearance stays in place showing what was decided", () => {
    const mounted = row(approvalEntry("git branch -D park/old", "allow"), { canApprove: true, onDecide: NO_DECIDE });
    try {
      expect(byTestID(mounted.host, "approval-state-r1").textContent).toBe("allowed");
      // No second decision to make, so no controls to mis-press.
      expect(mounted.host.querySelector('[data-testid="approval-allow-r1"]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("an unknown frame still reaches the operator, under its own id", () => {
    const entry = unknownEntry();
    const mounted = row(entry);
    try {
      const el = byTestID(mounted.host, `entry-unknown-${entry.id}`);
      expect(el.textContent).toContain(entry.label);
      expect(pathsIn(el)).toContain(GLYPHS.unknown.icon[4] as string);
    } finally {
      mounted.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Containment: a title is a command line, and it stays where the card put it
// ---------------------------------------------------------------------------

describe("a tool title carries argument text, so it never leaves the card's own surface", () => {
  test("the token is in the card's title node and nowhere else in the row", () => {
    const entry = toolEntry(SECRET_TITLE);
    const mounted = row(entry);
    try {
      // It IS on screen. That is the point of the card: an operator watching a
      // run must be able to read what ran.
      const title = byTestID(mounted.host, `tool-title-${entry.id}`);
      expect(title.textContent).toContain("sk-live-DEADBEEF");

      // And nowhere outside it. Excising exactly that node must leave a row
      // with no trace of the token in its markup -- no label, no kicker, no
      // duplicated aria text, no data attribute.
      title.remove();
      expect(mounted.host.innerHTML).not.toContain("sk-live");
      expect(mounted.host.innerHTML).not.toContain("Authorization");
    } finally {
      mounted.unmount();
    }
  });

  test("no accessibility label anywhere in a tool row mentions it", () => {
    const entry = toolEntry(SECRET_TITLE);
    const mounted = row(entry);
    try {
      const labels = labelsIn(mounted.host);
      for (const label of labels) {
        expect(label).not.toContain("sk-live");
        expect(label).not.toContain("Authorization");
        expect(label).not.toContain("curl");
      }
    } finally {
      mounted.unmount();
    }
  });

  test("the same holds for a clearance, which is where a person actually reads one", () => {
    const mounted = row(approvalEntry(SECRET_TITLE), { canApprove: true, onDecide: () => {} });
    try {
      // The card's own two surfaces: the title, and the command preview under
      // it. Both are deliberate; both are the card's.
      expect(byTestID(mounted.host, "approval-title-r1").textContent).toContain("sk-live-DEADBEEF");

      for (const label of labelsIn(mounted.host)) {
        expect(label).not.toContain("sk-live");
        expect(label).not.toContain("Authorization");
      }
      // The three buttons are labelled by their verb, never by the subject.
      expect(byTestID(mounted.host, "approval-allow-r1").getAttribute("aria-label")).toBe("Allow");
      expect(byTestID(mounted.host, "approval-deny-r1").getAttribute("aria-label")).toBe("Reject");
      expect(byTestID(mounted.host, "approval-always-r1").getAttribute("aria-label")).toBe("Always");
    } finally {
      mounted.unmount();
    }
  });

  test("the option list published to assistant-ui carries verbs, never operands", () => {
    // These labels are what a generic approval UI in the library would draw, so
    // they are a leak surface of exactly the same kind as an aria-label.
    for (const option of APPROVAL_OPTIONS) {
      expect(JSON.stringify(option)).not.toContain("sk-live");
      expect(option.label === undefined ? "" : option.label).toMatch(/^(Allow|Reject|Always)$/);
      expect(option.grants).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Actionability: pressing a control dispatches the decision it is labelled with
// ---------------------------------------------------------------------------

describe("a clearance is a decision, not a picture of one", () => {
  test("pressing allow, reject and always each dispatch their own choice and scope", () => {
    const decided: DecidedCall[] = [];
    const mounted = row(approvalEntry("rm -rf build"), {
      canApprove: true,
      onDecide: (requestId, choice, scope) => {
        decided.push([requestId, choice, scope]);
      },
    });
    try {
      act(() => {
        press(byTestID(mounted.host, "approval-allow-r1"));
      });
      act(() => {
        press(byTestID(mounted.host, "approval-deny-r1"));
      });
      act(() => {
        press(byTestID(mounted.host, "approval-always-r1"));
      });

      expect(decided).toEqual([
        ["r1", "allow", "once"],
        ["r1", "deny", "once"],
        // `always` is a scope, not a third choice: granting a standing
        // permission is allowing, at a wider reach.
        ["r1", "allow", "always"],
      ]);
    } finally {
      mounted.unmount();
    }
  });

  test("without the approve scope there are no controls, and the refusal says why", () => {
    const mounted = row(approvalEntry("rm -rf build"), {
      canApprove: false,
      refusal: "Pair with the approve scope to answer clearances.",
      onDecide: NO_DECIDE,
    });
    try {
      expect(byTestID(mounted.host, "approval-refusal-r1").textContent).toBe(
        "Pair with the approve scope to answer clearances.",
      );
      expect(mounted.host.querySelector('[data-testid="approval-allow-r1"]')).toBeNull();
      expect(mounted.host.querySelector('[data-testid="approval-deny-r1"]')).toBeNull();
      expect(mounted.host.querySelector('[data-testid="approval-always-r1"]')).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("with no refusal supplied the card still says something true", () => {
    const mounted = row(approvalEntry("rm -rf build"), { canApprove: false, onDecide: NO_DECIDE });
    try {
      expect(byTestID(mounted.host, "approval-refusal-r1").textContent).toBe(
        "This device does not hold the approve scope.",
      );
    } finally {
      mounted.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The store's own approval seam
// ---------------------------------------------------------------------------

describe("a decision answered through assistant-ui's path reaches the daemon", () => {
  const agent: Agent = {
    id: "agt_a",
    name: "Alpha",
    state: "idle",
    host: { kind: "local", id: "42", spec: { kind: "local" } },
    cwd: "/Users/op/dev/src/github.com/op/alpha",
    createdAt: "2026-08-24T11:00:00.000Z",
    lastActiveAt: "2026-08-24T11:59:00.000Z",
    labels: {},
  };

  function storeWith(canApprove: boolean, onDecide: Decided) {
    return ompStore({
      agent,
      session: EMPTY_SESSION,
      connection: "connected",
      load: READY_LOAD,
      promptAccess: "granted",
      onSubmit: () => {},
      onCancel: () => {},
      canApprove,
      onDecide,
      onDecidePlan: () => {},
    });
  }

  test("an option id recovers the scope a boolean cannot express", () => {
    const decided: DecidedCall[] = [];
    const store = storeWith(true, (r, c, s) => {
      decided.push([r, c, s]);
    });

    store.onRespondToToolApproval?.({ approvalId: "r1", approved: true, optionId: "omp:allow-always" });
    store.onRespondToToolApproval?.({ approvalId: "r2", approved: true, optionId: "omp:allow-once" });
    store.onRespondToToolApproval?.({ approvalId: "r3", approved: false, optionId: "omp:deny-once" });

    expect(decided).toEqual([
      ["r1", "allow", "always"],
      ["r2", "allow", "once"],
      ["r3", "deny", "once"],
    ]);
  });

  test("a bare boolean is answered at `once`, because a standing grant is never inferred", () => {
    const decided: DecidedCall[] = [];
    const store = storeWith(true, (r, c, s) => {
      decided.push([r, c, s]);
    });

    store.onRespondToToolApproval?.({ approvalId: "r1", approved: true });
    store.onRespondToToolApproval?.({ approvalId: "r2", approved: false });
    // An id we never published is not a decision we can read, so it falls back
    // to the one field the shape guarantees rather than guessing.
    store.onRespondToToolApproval?.({ approvalId: "r3", approved: true, optionId: "someone-elses-id" });

    expect(decided).toEqual([
      ["r1", "allow", "once"],
      ["r2", "deny", "once"],
      ["r3", "allow", "once"],
    ]);
  });

  test("every published option id is one the store can decode", () => {
    // The two halves are written in two places; this is what keeps them one
    // vocabulary. An option offered but not decodable would fall through to the
    // boolean and silently downgrade a standing grant.
    const decided: string[] = [];
    const store = storeWith(true, (_r, c, s) => {
      decided.push(`${c}:${s}`);
    });
    for (const option of APPROVAL_OPTIONS) {
      store.onRespondToToolApproval?.({ approvalId: "r", approved: true, optionId: option.id });
    }
    expect(decided).toEqual(["allow:once", "deny:once", "allow:always"]);
  });

  test("no approve scope means no capability, not a silent no-op", () => {
    // Absent, core throws "Runtime does not support tool approvals." A stub
    // that swallowed the call would tell the operator their answer was sent.
    const store = storeWith(false, NO_DECIDE);
    expect(store.onRespondToToolApproval).toBeUndefined();
  });

  test("client-side tool results are not wired, because this device produces none", () => {
    const store = storeWith(true, () => {});
    expect("onAddToolResult" in store).toBe(false);
  });

  test("the object this adapter builds is exactly what the runtime hook takes", () => {
    // Assignability, checked by `bun run check` rather than at runtime: nothing
    // in this file mounts a provider, so this annotation is what keeps
    // `ompStore`'s shape and `useOmpRuntime(store: ExternalStoreAdapter<T>)`
    // from drifting apart while they live in two files.
    const store: ExternalStoreAdapter<Entry> = storeWith(true, () => {});
    expect(store.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Attribution: a thought reads as a thought, a live turn reads as live
// ---------------------------------------------------------------------------

describe("attribution survives the move into assistant-ui", () => {
  test("a thought is violet on both the kicker and the rail, and its prose is muted", () => {
    const thought = row(assistantEntry("weighing it", { thought: true }));
    const reply = row(assistantEntry("weighing it"));
    try {
      const thoughtRow = byTestID(thought.host, "entry-assistant");
      const replyRow = byTestID(reply.host, "entry-assistant");

      const thoughtGutter = thoughtRow.firstElementChild;
      const replyGutter = replyRow.firstElementChild;
      if (thoughtGutter === null || replyGutter === null) throw new Error("a row rendered without its gutter");

      expect(declarationsFor(thoughtGutter).get("border-left-color")).toBe(rgb(signal.violet));
      expect(declarationsFor(replyGutter).get("border-left-color")).toBe(rgb(signal.sage));

      const thoughtKicker = thoughtGutter.firstElementChild;
      const replyKicker = replyGutter.firstElementChild;
      if (thoughtKicker === null || replyKicker === null) throw new Error("a gutter rendered without its kicker");

      expect(thoughtKicker.textContent).toBe("thinking");
      expect(replyKicker.textContent).toBe("agent");
      expect(declarationsFor(thoughtKicker).get("color")).toBe(rgb(signal.violet));
      expect(declarationsFor(replyKicker).get("color")).toBe(rgb(signal.sage));

      // Muted is not a decoration: `RichText muted` drops prose from
      // `ink.bright` to `ink.plain`, and the same string must therefore render
      // at two different colours in the two rows.
      const thoughtProse = colourOfProse(thoughtRow, "weighing it");
      const replyProse = colourOfProse(replyRow, "weighing it");
      expect(thoughtProse).toBe(rgb(ink.plain));
      expect(replyProse).toBe(rgb(ink.bright));
    } finally {
      thought.unmount();
      reply.unmount();
    }
  });

  test("a streaming reply carries the activity glyph; a settled one does not", () => {
    const live = row(assistantEntry("half a sen", { streaming: true }));
    const done = row(assistantEntry("a whole sentence"));
    try {
      const glyph = GLYPHS.activity.icon[4] as string;
      expect(pathsIn(byTestID(live.host, "entry-assistant"))).toContain(glyph);
      expect(pathsIn(byTestID(done.host, "entry-assistant"))).not.toContain(glyph);
    } finally {
      live.unmount();
      done.unmount();
    }
  });
});

/** The colour the prose node carrying `text` actually renders at. */
function colourOfProse(rowEl: HTMLElement, text: string): string | undefined {
  for (const node of rowEl.querySelectorAll("*")) {
    if (node.textContent !== text) continue;
    const colour = declarationsFor(node).get("color");
    if (colour !== undefined) return colour;
  }
  return undefined;
}
