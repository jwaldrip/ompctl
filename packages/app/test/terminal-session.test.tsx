/**
 * The terminal prompt surface: canned `tui_activity` and refusal frames
 * becoming the hints and the message one live terminal session shows.
 *
 * The screen under test is the one a `live-tui` fleet row opens. Every test
 * drives the real console reducer with the transcript tail, activity, and
 * refusal frames the daemon sends, then hands the resulting state to the real
 * screen: a pass means those frames would paint that screen on a device.
 * The composer is exercised mounted, the way `composer-submit.test.tsx`
 * exercises the agent one, because typing is the only control here.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleEvent, ConsoleState } from "../src/console/state.ts";
import { apply, emptyConsole, tuiSessionFor } from "../src/console/state.ts";

// Dynamic on purpose, same reason as `fleet-screen.test.tsx`: these modules
// import "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { TerminalSessionScreen, HINT_WORDS } = await import("../src/screens/TerminalSessionScreen.tsx");
const { StyleSheet } = await import("react-native");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = "s-tui";

function drive(events: readonly ConsoleEvent[], from = emptyConsole([])): ConsoleState {
  let state = from;
  for (const event of events) state = apply(state, event);
  return state;
}

function renderScreen(state: ConsoleState, onLoadEarlier: () => void = () => {}): string {
  return renderToStaticMarkup(
    <TerminalSessionScreen
      title="session s-tui"
      cwd="/Users/op/dev/src/github.com/op/alpha"
      status="live-tui"
      promptAccess="granted"
      tui={tuiSessionFor(state, SESSION)}
      load={{ phase: "ready", generation: 0, error: null }}
      connection="connected"
      onBack={() => {}}
      onLoadEarlier={onLoadEarlier}
      onSubmit={() => {}}
    />,
  );
}

/**
 * One `session_tail` frame, as the daemon sends it: oldest first, with the
 * cursor for the page older than this one, or null at the file's start.
 */
const served = (truncated: boolean, nextCursor: number | null = null): ConsoleEvent => ({
  t: "session_tail",
  event: {
    sessionId: SESSION,
    messages: [
      { role: "user", text: "run the deploy checks", at: "2026-08-13T00:00:01.000Z" },
      { role: "assistant", text: "all four suites are green", at: "2026-08-13T00:00:02.000Z" },
    ],
    truncated,
    nextCursor,
  },
});

/** Mounted, because containment and layout questions are tree questions. */
function mountScreen(state: ConsoleState, onLoadEarlier: () => void = () => {}): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <TerminalSessionScreen
        title="session s-tui"
        cwd="/alpha"
        status="live-tui"
        promptAccess="granted"
        tui={tuiSessionFor(state, SESSION)}
        load={{ phase: "ready", generation: 0, error: null }}
        connection="connected"
        onBack={() => {}}
        onLoadEarlier={onLoadEarlier}
        onSubmit={() => {}}
      />,
    );
  });
  return { host, root };
}

function unmountScreen(host: HTMLDivElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  host.remove();
}

/**
 * `getSheet` is a react-native-web extension, the same unchecked cast
 * `fleet-screen.test.tsx` makes: static StyleSheet values compile to atomic
 * classes whose declarations live here rather than in the markup.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/** The sheet rules addressing any of these classes, scoped so a declaration on some other element cannot satisfy a layout assertion. */
function sheetRulesFor(classes: readonly string[]): string {
  return rnwStyleSheet
    .getSheet()
    .textContent.split("\n")
    .filter(rule => classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule)))
    .join("\n");
}

function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
  (input as HTMLInputElement).value = value;
  props.onChange({
    target: input,
    currentTarget: input,
    nativeEvent: { text: value },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

// ---------------------------------------------------------------------------
// The composer: the one control that changes something
// ---------------------------------------------------------------------------

describe("the terminal composer", () => {
  test("sends the trimmed text as this session's prompt and clears the field", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const submitted: string[] = [];

    act(() => {
      root.render(
        <TerminalSessionScreen
          title="session s-tui"
          cwd="/alpha"
          status="live-tui"
          promptAccess="granted"
          tui={tuiSessionFor(emptyConsole([]), SESSION)}
          load={{ phase: "ready", generation: 0, error: null }}
          connection="connected"
          onBack={() => {}}
          onLoadEarlier={() => {}}
          onSubmit={text => {
            submitted.push(text);
          }}
        />,
      );
    });

    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLElement | null;
    expect(input).not.toBeNull();
    act(() => {
      typeInto(input!, "  run the deploy checks  ");
    });

    const send = host.querySelector('[data-testid="terminal-composer-send"]') as HTMLElement | null;
    expect(send).not.toBeNull();
    act(() => {
      send?.click();
    });

    expect(submitted).toEqual(["run the deploy checks"]);
    expect((input as HTMLInputElement).value ?? "").toBe("");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("keeps Send while a turn runs: a second prompt steers, it does not stop", () => {
    // An agent's composer swaps its send button for an interrupt mid-turn,
    // because an agent's turn can be cancelled from here. A terminal's
    // cannot, so the button must stay Send and stay usable while busy.
    const state = drive([{ t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } }]);
    const html = renderScreen(state);
    expect(html).toContain('data-testid="terminal-composer-send"');
    expect(html).not.toContain('data-testid="composer-cancel"');
    expect(html).not.toContain("Stop");
    expect(html).toContain("Working in the terminal");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const submitted: string[] = [];
    act(() => {
      root.render(
        <TerminalSessionScreen
          title="session s-tui"
          cwd="/alpha"
          status="live-tui"
          promptAccess="granted"
          tui={tuiSessionFor(state, SESSION)}
          load={{ phase: "ready", generation: 0, error: null }}
          connection="connected"
          onBack={() => {}}
          onLoadEarlier={() => {}}
          onSubmit={text => {
            submitted.push(text);
          }}
        />,
      );
    });
    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLElement | null;
    const send = host.querySelector('[data-testid="terminal-composer-send"]') as HTMLElement | null;
    expect(input).not.toBeNull();
    expect(send).not.toBeNull();
    act(() => {
      typeInto(input!, "steer it");
    });
    expect(send?.hasAttribute("disabled")).toBe(false);
    act(() => {
      send?.click();
    });
    expect(submitted).toEqual(["steer it"]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

// ---------------------------------------------------------------------------
// The hints: sent, busy, reply
// ---------------------------------------------------------------------------

describe("a prompted terminal renders its hints", () => {
  test("a sent prompt with no activity yet still shows as sent, not as a dead screen", () => {
    const state = drive([{ t: "tui_prompt", sessionId: SESSION, text: "status of the deploy?" }]);
    const html = renderScreen(state);
    expect(html).toContain('data-testid="terminal-sent"');
    expect(html).toContain("status of the deploy?");
    // Read from the screen rather than spelled out again: the gutter is 66
    // points wide and the word that goes in it is chosen by what fits there.
    expect(html).toContain(HINT_WORDS.sent);
    // The row IS here, and that is the point of having one producer. The
    // kicker this replaced was gated on `tui.busy` alone, so a steer this
    // device had sent and nothing had answered read as a dead screen, while
    // the header's own indicator said "Working" from `awaitingReply` at the
    // same moment. `tuiActivity` counts an outstanding steer as work, and now
    // exactly one thing on screen reports it.
    expect(html).toContain('data-testid="session-activity"');
    expect(html).not.toContain('data-testid="terminal-reply"');
  });

  test("a turn_start shows the working row; the turn ending clears it", () => {
    // The claim used to be a kicker below the log, in the hints block. It is
    // now a row of the log itself, under the last turn and above the composer:
    // same fact, in the conversation where the operator is looking.
    const working = drive([{ t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } }]);
    expect(renderScreen(working)).toContain('data-testid="session-activity"');

    const done = drive([
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_end" } },
    ]);
    expect(renderScreen(done)).not.toContain('data-testid="session-activity"');
  });

  test("a full turn renders the reply and clears the busy state", () => {
    const state = drive([
      { t: "tui_prompt", sessionId: SESSION, text: "status of the deploy?" },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "assistant_text", text: "all green" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_end" } },
    ]);
    const html = renderScreen(state);
    expect(html).toContain('data-testid="terminal-reply"');
    expect(html).toContain("all green");
    expect(html).not.toContain('data-testid="session-activity"');
  });
  test("a never-prompted terminal says what the surface is instead of nothing", () => {
    const html = renderScreen(emptyConsole([]));
    expect(html).toContain('data-testid="terminal-explainer"');
    expect(html).toContain("live in a terminal");
  });

  test("a never-prompted terminal still carries the way back to the fleet", () => {
    // On a phone this screen replaces the fleet, and its emptiest state is
    // exactly when a person decides they tapped the wrong row: without the
    // back control the hardware key is the only way out.
    expect(renderScreen(emptyConsole([]))).toContain('data-testid="terminal-back"');
  });
});

describe("an unreachable terminal is told how to fix itself", () => {
  /** The frames that produce a refused-but-open terminal screen: prompt sent, refusal answered. */
  const refused = (): ConsoleEvent[] => [
    { t: "tui_select", sessionId: SESSION },
    { t: "tui_prompt", sessionId: SESSION, text: "hello?" },
    { t: "error", event: { message: "no connected TUI owns session s-tui", code: "tui_unreachable" } },
  ];

  test("a tui_unreachable refusal renders guidance naming the remedy, not the raw code", () => {
    const html = renderScreen(drive(refused()));
    expect(html).toContain('data-testid="terminal-owner-gone"');
    expect(html).toContain("Return to that terminal");
    expect(html).toContain("still open");
    // The daemon's phrasing names a session id, which is not a remedy; the
    // raw message must not be what the operator reads.
    expect(html).not.toContain("no connected TUI owns");
    expect(html).not.toContain("tui_unreachable");
  });

  test("a prompt after a refusal clears it and sends again", () => {
    expect(renderScreen(drive(refused()))).toContain('data-testid="terminal-owner-gone"');

    const retried = drive([...refused(), { t: "tui_prompt", sessionId: SESSION, text: "again" }]);
    const html = renderScreen(retried);
    expect(html).not.toContain('data-testid="terminal-owner-gone"');
    expect(html).toContain("again");
  });
});

// ---------------------------------------------------------------------------
// The history: the served transcript tail
// ---------------------------------------------------------------------------

describe("a terminal session renders the transcript the daemon served", () => {
  test("the served turns are rendered in order, newest last, above the composer", () => {
    const html = renderScreen(drive([{ t: "tui_select", sessionId: SESSION }, served(false)]));

    expect(html).toContain('data-testid="terminal-log"');
    expect(html).toContain("run the deploy checks");
    expect(html).toContain("all four suites are green");
    // Order is the contract: oldest first means the newest turn sits closest
    // to the composer, so a reversed list would read as a session running
    // backwards.
    expect(html.indexOf("run the deploy checks")).toBeLessThan(html.indexOf("all four suites are green"));
    // And the composer is below the log, not above it.
    expect(html.indexOf("all four suites are green")).toBeLessThan(
      html.indexOf('data-testid="terminal-composer-input"'),
    );
    // Speaker attribution comes from the served role, not from guesswork.
    expect(html).toContain('data-testid="terminal-turn-0"');
    expect(html).toContain('data-testid="terminal-turn-1"');
    // With history on screen the explainer is gone: it explains an empty
    // surface, and this one is not empty.
    expect(html).not.toContain('data-testid="terminal-explainer"');
  });

  test("a page with older file behind it offers Load earlier, and the file's start offers nothing", () => {
    // What stood here was a kicker reading that older turns are not shown:
    // true, and a dead end. The control is the same one, under the same id,
    // the agent log's transcript uses for the same act.
    const paged = renderScreen(drive([served(true, 4096)]));
    expect(paged).toContain('data-testid="history-load-earlier"');
    expect(paged).toContain("Load earlier");
    expect(paged).not.toContain('data-testid="terminal-log-truncated"');

    // Reaching the start of the file is an answer: no control, and nothing
    // left implying there is more to see.
    const whole = renderScreen(drive([served(false)]));
    expect(whole).not.toContain('data-testid="history-load-earlier"');
    expect(whole).not.toContain("Load earlier");
  });

  test("a page in flight disables the control and says it is loading", () => {
    const loading = renderScreen(drive([served(true, 4096), { t: "tui_history_request", sessionId: SESSION }]));

    expect(loading).toContain('data-testid="history-load-earlier"');
    expect(loading).toContain("Loading earlier…");
    expect(loading).toContain('aria-disabled="true"');
  });

  test("pressing Load earlier asks the console for the older page", () => {
    const asks: number[] = [];
    const { host, root } = mountScreen(drive([served(true, 4096)]), () => asks.push(1));

    const control = host.querySelector('[data-testid="history-load-earlier"]');
    expect(control).not.toBeNull();
    act(() => {
      control?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(asks.length).toBe(1);
    unmountScreen(host, root);
  });

  test("an older page prepends its turns above the ones already on screen", () => {
    const html = renderScreen(
      drive([
        served(true, 4096),
        {
          t: "session_tail",
          event: {
            sessionId: SESSION,
            messages: [
              { role: "user", text: "what did we decide about the index?", at: "2026-08-12T09:00:00.000Z" },
              { role: "assistant", text: "we rebuilt it cold", at: "2026-08-12T09:00:01.000Z" },
            ],
            truncated: true,
            nextCursor: 2048,
            cursor: 4096,
          },
        },
      ]),
    );

    // Older above newer, and the page already on screen is still there: a
    // paged answer that replaced the history would lose the turns the
    // operator was reading.
    expect(html.indexOf("what did we decide about the index?")).toBeLessThan(html.indexOf("run the deploy checks"));
    expect(html.indexOf("we rebuilt it cold")).toBeLessThan(html.indexOf("all four suites are green"));
    // Still more file behind it, so the way back is still offered.
    expect(html).toContain('data-testid="history-load-earlier"');
  });

  test("a session of pure tool traffic still offers the way back, with no log to head", () => {
    // The daemon read a screenful of tool calls and found no words in it,
    // but named the offset to keep reading from. Without a control here the
    // operator's only answer is an explainer about an empty session they
    // plainly talked in.
    const html = renderScreen(
      drive([{ t: "session_tail", event: { sessionId: SESSION, messages: [], truncated: true, nextCursor: 9000 } }]),
    );

    expect(html).not.toContain('data-testid="terminal-log"');
    expect(html).toContain('data-testid="history-load-earlier"');
  });

  test("an empty tail renders the explainer rather than a blank pane", () => {
    // The honest answer for a session whose file holds no turns yet: the
    // daemon answered, and the answer was nothing, so the surface must still
    // say what it is.
    const html = renderScreen(
      drive([{ t: "session_tail", event: { sessionId: SESSION, messages: [], truncated: false, nextCursor: null } }]),
    );

    expect(html).not.toContain('data-testid="terminal-log"');
    expect(html).toContain('data-testid="terminal-explainer"');
    expect(html).toContain("live in a terminal");
  });

  test("a live reply appends below the served history rather than replacing it", () => {
    const html = renderScreen(
      drive([
        served(false),
        { t: "tui_prompt", sessionId: SESSION, text: "and the migration?" },
        { t: "tui_activity", event: { sessionId: SESSION, kind: "assistant_text", text: "migration applied" } },
      ]),
    );

    // The history is still there, and the live hints are below it: a phone
    // that lost the served turns the moment the terminal said something would
    // be back to a one-line screen.
    expect(html).toContain("run the deploy checks");
    expect(html).toContain('data-testid="terminal-reply"');
    expect(html).toContain("migration applied");
    expect(html.indexOf("all four suites are green")).toBeLessThan(html.indexOf("migration applied"));
  });

  test("a tail for another session does not appear on this one", () => {
    // Frames are keyed by session id, and this screen shows exactly one
    // session. Folding a sibling's transcript into whichever surface happens
    // to be open would put another project's words on the operator's screen.
    const html = renderScreen(
      drive([
        { t: "tui_select", sessionId: SESSION },
        {
          t: "session_tail",
          event: {
            sessionId: "s-other",
            messages: [{ role: "user", text: "belongs to another session", at: "" }],
            truncated: false,
            nextCursor: null,
          },
        },
      ]),
    );

    expect(html).not.toContain("belongs to another session");
    expect(html).toContain('data-testid="terminal-explainer"');
  });

  test("mounted, the rows carry the words as their accessibility labels", () => {
    // Mounted rather than rendered to markup, because the list scrolls itself
    // to the newest turn on content-size change and that path only runs in a
    // real mount. A row whose words are only in a nested Text is invisible to
    // an accessibility query even when it is on screen, which is how a device
    // UI test ends up unable to read a transcript that is plainly there.
    const state = drive([served(false)]);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <TerminalSessionScreen
          title="session s-tui"
          cwd="/alpha"
          status="live-tui"
          promptAccess="granted"
          tui={tuiSessionFor(state, SESSION)}
          load={{ phase: "ready", generation: 0, error: null }}
          connection="connected"
          onBack={() => {}}
          onLoadEarlier={() => {}}
          onSubmit={() => {}}
        />,
      );
    });

    const rows = [...host.querySelectorAll('[data-testid^="terminal-turn-"]')];
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.getAttribute("aria-label"))).toEqual([
      "you: run the deploy checks",
      "agent: all four suites are green",
    ]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

// ---------------------------------------------------------------------------
// The conversation: live hints continue the tail, and the log pins to the
// bottom of the pane
// ---------------------------------------------------------------------------

describe("live hints continue the conversation rather than detaching from it", () => {
  test("a live reply renders as a turn below the served tail, inside the log", () => {
    // The iPad frame showed the only agent words on screen stranded in a band
    // under a void. The contract now: the reply is a row of the log, below
    // the tail, answering to the same attribution contract as a served turn.
    const state = drive([
      served(false),
      { t: "tui_prompt", sessionId: SESSION, text: "and the migration?" },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "assistant_text", text: "migration applied" } },
    ]);
    const { host, root } = mountScreen(state);
    const log = host.querySelector('[data-testid="terminal-log"]');
    const reply = host.querySelector('[data-testid="terminal-reply"]');
    expect(log).not.toBeNull();
    expect(reply).not.toBeNull();
    expect(log?.contains(reply!)).toBe(true);
    expect(reply?.closest('[data-testid^="terminal-turn-"]')?.getAttribute("aria-label")).toBe(
      "agent: migration applied",
    );
    expect(
      [...host.querySelectorAll('[data-testid^="terminal-turn-"]')].map(row => row.getAttribute("aria-label")),
    ).toEqual(["you: run the deploy checks", "agent: all four suites are green", "agent: migration applied"]);
    // The boundary notice is not a turn, so it stays a band outside the log.
    expect(log?.contains(host.querySelector('[data-testid="terminal-transcript-limit"]')!)).toBe(false);
    unmountScreen(host, root);
  });

  test("a short conversation sits at the bottom of the pane, not top-aligned with a void", () => {
    // Same discipline as `fleet-screen.test.tsx`: static StyleSheet values
    // compile to atomic classes whose declarations live in the sheet, so the
    // proof is what the content container's classes declare. Growing to fill
    // the pane and packing rows at the end is what puts the newest turn
    // against the bands and the composer; without both declarations the list
    // starts at the top and leaves the void the iPad showed.
    const { host, root } = mountScreen(drive([served(false)]));
    const log = host.querySelector('[data-testid="terminal-log"]');
    // RNW's ScrollView renders exactly one content container child, and it
    // is where contentContainerStyle lands.
    const content = log?.children[0] ?? null;
    expect(content).not.toBeNull();
    const rules = sheetRulesFor([...(content?.classList ?? [])]);
    expect(rules).toMatch(/flex-grow:\s*1/);
    expect(rules).toMatch(/justify-content:\s*flex-end/);
    unmountScreen(host, root);
  });

  test("a sent prompt with no served tail renders as the log's first turn, not as a band", () => {
    // The reducer keeps the sent echo until the terminal takes the turn, so
    // a prompt sent before any tail exists must still have a log to live in:
    // not rendering the list at all was the defect that left the words in a
    // detached band.
    const { host, root } = mountScreen(drive([{ t: "tui_prompt", sessionId: SESSION, text: "status of the deploy?" }]));
    const log = host.querySelector('[data-testid="terminal-log"]');
    const sent = host.querySelector('[data-testid="terminal-sent"]');
    expect(log).not.toBeNull();
    expect(sent).not.toBeNull();
    expect(log?.contains(sent!)).toBe(true);
    expect(sent?.closest('[data-testid^="terminal-turn-"]')?.getAttribute("aria-label")).toBe(
      "you: status of the deploy?",
    );
    unmountScreen(host, root);
  });

  test("a reply whose words the tail already ends with stands down instead of repeating", () => {
    // Re-opening re-serves the tail after the terminal wrote the turn, so
    // the same words arrive once as history and once as the live echo. The
    // history is the file's truth; the echo must not render the row twice.
    // Counted by row, because a row carries its words twice over: once as
    // its accessibility label and once as its text.
    const state = drive([
      served(false),
      { t: "tui_prompt", sessionId: SESSION, text: "and the migration?" },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "assistant_text", text: "all four suites are green" } },
      served(false),
    ]);
    const { host, root } = mountScreen(state);
    expect([...host.querySelectorAll('[aria-label="agent: all four suites are green"]')]).toHaveLength(1);
    expect(host.querySelector('[data-testid="terminal-reply"]')).toBeNull();
    unmountScreen(host, root);
  });

  test("a sent prompt the tail already ends with stands down as well", () => {
    const tailEndsOnPrompt: ConsoleEvent = {
      t: "session_tail",
      event: {
        sessionId: SESSION,
        messages: [
          { role: "assistant", text: "all four suites are green", at: "2026-08-13T00:00:02.000Z" },
          { role: "user", text: "re-run the deploy checks", at: "2026-08-13T00:00:03.000Z" },
        ],
        truncated: false,
        nextCursor: null,
      },
    };
    const { host, root } = mountScreen(
      drive([tailEndsOnPrompt, { t: "tui_prompt", sessionId: SESSION, text: "re-run the deploy checks" }]),
    );
    expect([...host.querySelectorAll('[aria-label="you: re-run the deploy checks"]')]).toHaveLength(1);
    expect(host.querySelector('[data-testid="terminal-sent"]')).toBeNull();
    unmountScreen(host, root);
  });
});
