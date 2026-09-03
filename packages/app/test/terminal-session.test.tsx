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
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { EMPTY_SESSION } = await import("../src/session/model.ts");
const { rhythm } = await import("../src/design/rhythm.ts");
const { WithOmpTheme } = await import("./theme.tsx");
// The scheme `WithOmpTheme` pins, so an assertion names the colour the surface
// actually read rather than a token that happens to match in one theme.
const { ompDarkTheme } = await import("../src/design/theme.ts");
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

/**
 * Every harness in this file mounts under the design system, because the screen
 * now draws Paper components: a `Button` rendered with no provider above it
 * comes out in Material's palette with Material's icon renderer, which is not
 * the control a person is handed.
 */
function renderScreen(state: ConsoleState, onLoadEarlier: () => void = () => {}): string {
  return renderToStaticMarkup(
    <WithOmpTheme>
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
      />
    </WithOmpTheme>,
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
      <WithOmpTheme>
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
        />
      </WithOmpTheme>,
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

/**
 * The declarations one element actually carries, read out of the sheet by the
 * classes on its markup, plus anything react-native-web wrote inline. Static
 * `StyleSheet` values compile to atomic classes and dynamic ones land on the
 * element, so reading only one of the two places sees half the style. Same
 * reader as `pair-connections-consistency.test.tsx`, which asks the same
 * question of two other screens.
 */
function declarationsFor(el: Element): Map<string, string> {
  const classes = el.className.split(/\s+/).filter(Boolean);
  const out = new Map<string, string>();
  const take = (text: string): void => {
    for (const declaration of text.matchAll(/([a-z-]+):\s*([^;]+);?/gi)) {
      const property = declaration[1];
      const value = declaration[2];
      if (property === undefined || value === undefined) continue;
      out.set(property.toLowerCase(), value.trim());
    }
  };
  for (const rule of rnwStyleSheet.getSheet().textContent.split("\n")) {
    if (!classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule))) continue;
    take(rule);
  }
  const inline = el.getAttribute("style");
  if (inline !== null) take(inline);
  return out;
}

function byTestID(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} rendered`);
  return element;
}

/**
 * The six-digit hex of a token as the rgba() react-native-web's compiler
 * serialises it to, with no spaces. The atomic sheet writes it that way and the
 * `style` attribute writes it with spaces after the commas, so `colourOf` reads
 * in the same shape rather than the caller guessing which half a value came
 * from.
 */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},1.00)`;
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

// ---------------------------------------------------------------------------
// One design: this surface and the agent log pay the same gutter
// ---------------------------------------------------------------------------

/**
 * The agent log, mounted whole and under the same provider. The point of this
 * section is a comparison, so both sides have to come from the real screens: a
 * number this file declared for the agent side would be an assertion about a
 * test rather than about the app.
 */
function mountAgentScreen(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <WithOmpTheme>
        <SessionScreen
          agent={{
            id: "agt_probe",
            name: "probe",
            state: "idle",
            host: { kind: "local", id: "1", spec: { kind: "local" } },
            cwd: "/alpha",
            createdAt: new Date(0).toISOString(),
            lastActiveAt: new Date(0).toISOString(),
            labels: {},
          }}
          session={EMPTY_SESSION}
          load={{ phase: "ready", generation: 0, error: null }}
          context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
          connection="connected"
          attempt={0}
          voice={{
            access: "granted",
            mic: { available: false, reason: "no microphone in this test" },
            speech: { available: false, reason: "no playback in this test" },
            dictation: null,
            capturing: false,
            busyElsewhere: false,
            onToggle: () => {},
          }}
          spoken={null}
          fleetClearances={0}
          canApprove
          onBack={() => {}}
          onOpenConfig={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
        />
      </WithOmpTheme>,
    );
  });
  return { host, root };
}

/**
 * The left and right inset an element actually renders, in points.
 *
 * `paddingHorizontal` is not a CSS property: react-native-web compiles it to a
 * pair, and which pair depends on the build, so both spellings are read and the
 * two sides are required to agree. A screen whose left and right insets differ
 * is already the defect this section exists to catch.
 */
function horizontalInset(el: Element): number {
  const style = declarationsFor(el);
  const side = (logical: string, physical: string): number => {
    const written = style.get(logical) ?? style.get(physical) ?? style.get("padding");
    if (written === undefined) throw new Error(`no ${physical} declared on the element`);
    const points = Number.parseFloat(written);
    if (Number.isNaN(points)) throw new Error(`${physical} is ${written}, which is not a length in points`);
    return points;
  };
  const left = side("padding-inline-start", "padding-left");
  const right = side("padding-inline-end", "padding-right");
  if (left !== right) throw new Error(`the element insets its content ${left} on the left and ${right} on the right`);
  return left;
}

describe("the terminal and the agent log pay one gutter", () => {
  test("both headers inset their content by rhythm.gutter, and therefore by the same number", () => {
    // The report was "spacing looks off", and this is the shape of it: two
    // screens a person moves between in one gesture, each picking its own step
    // off the grid, so the title's left edge jumps when the route changes.
    // Asserting only that the terminal pays 16 would pass on the day the agent
    // log moves to 20, which is exactly the drift being fixed.
    const terminal = mountScreen(emptyConsole([]));
    const agent = mountAgentScreen();
    try {
      const terminalGutter = horizontalInset(byTestID(terminal.host, "terminal-head"));
      const agentGutter = horizontalInset(byTestID(agent.host, "session-head"));
      expect(terminalGutter).toBe(rhythm.gutter);
      expect(agentGutter).toBe(rhythm.gutter);
      expect(terminalGutter).toBe(agentGutter);
    } finally {
      unmountScreen(agent.host, agent.root);
      unmountScreen(terminal.host, terminal.root);
    }
  });

  test("every band the terminal owns pays that one gutter, not three near-misses", () => {
    // The class, not the one margin: the header, the log's content and the
    // band of hints under it are the three places this screen insets from the
    // screen edge, and they were 12 apiece against a 16 everywhere else.
    const { host, root } = mountScreen(drive([served(false)]));
    try {
      const log = byTestID(host, "terminal-log");
      // RNW's ScrollView renders exactly one content container child, and it
      // is where `contentContainerStyle` lands.
      const content = log.children[0];
      if (!(content instanceof HTMLElement)) throw new Error("the terminal log has no content container");
      expect(horizontalInset(byTestID(host, "terminal-head"))).toBe(rhythm.gutter);
      expect(horizontalInset(content)).toBe(rhythm.gutter);
      expect(horizontalInset(byTestID(host, "terminal-transcript-limit").parentElement!)).toBe(rhythm.gutter);
    } finally {
      unmountScreen(host, root);
    }
  });

  test("the attribution column is rhythm.attribution, the same measure the transcript reads", () => {
    // One measure for both logs, instead of the 76 this one used and the 68 the
    // transcript used. Read off the rendered row, so moving it back to a local
    // number fails here even on a day the number happens to match.
    const { host, root } = mountScreen(drive([served(false)]));
    try {
      const row = byTestID(host, "terminal-turn-0");
      const gutter = row.firstElementChild;
      if (!(gutter instanceof HTMLElement)) throw new Error("the turn has no attribution gutter");
      expect(gutter.textContent).toContain("you");
      expect(declarationsFor(gutter).get("width")).toBe(`${rhythm.attribution}px`);
    } finally {
      unmountScreen(host, root);
    }
  });

  test("Load earlier keeps its role and its label after becoming a Paper control", () => {
    // The shape changed from a hand-rolled Pressable to Paper's Button, so what
    // has to survive is what the id means: a button, named the same way to
    // assistive technology, saying the same words.
    const { host, root } = mountScreen(drive([served(true, 4096)]));
    try {
      const control = byTestID(host, "history-load-earlier");
      expect(control.getAttribute("role")).toBe("button");
      expect(control.getAttribute("aria-label")).toBe("Load earlier turns of this terminal session");
      expect(control.textContent).toContain("Load earlier");
    } finally {
      unmountScreen(host, root);
    }
  });

  test("Load earlier draws ompctl's own glyph with no provider above it", () => {
    // Paper resolves a STRING icon name through `settings.icon`, which only
    // exists under `OmpThemeProvider`: written that way this control draws
    // nothing at all in every harness that mounts a screen bare, and warns
    // rather than fails. Handing Paper the drawing instead is what makes the
    // glyph unconditional, so the proof has to be taken without the provider --
    // wrapped, a string icon would pass this and hide the whole defect.
    const bare = renderToStaticMarkup(
      <TerminalSessionScreen
        title="session s-tui"
        cwd="/alpha"
        status="live-tui"
        promptAccess="granted"
        tui={tuiSessionFor(drive([served(true, 4096)]), SESSION)}
        load={{ phase: "ready", generation: 0, error: null }}
        connection="connected"
        onBack={() => {}}
        onLoadEarlier={() => {}}
        onSubmit={() => {}}
      />,
    );
    const control = bare.slice(bare.indexOf('data-testid="history-load-earlier"'));
    // `icons.tsx` draws Font Awesome paths through react-native-svg, so a path
    // element inside the control is the proof the app's own family drew it.
    expect(control.slice(0, control.indexOf("</button>"))).toContain("<path");
  });

  test("Load earlier wears this app's colour and corner, not Paper's", () => {
    // The two Material defaults Paper applies unless told otherwise, and both
    // are the "no Material look" rule rather than taste. Text mode returns
    // `colors.primary`, which is signal sage -- the "press this one" colour the
    // composer's send owns, so a secondary way-back control taking it breaks
    // the one-emphasis rule. And v3 computes `roundness * 5`, a 40 point pill,
    // where nothing in this app is a pill except that same send disc.
    //
    // Rendered ENABLED on purpose: Paper drops a custom `textColor` while
    // `disabled` (`customTextColor && !disabled`) and falls to
    // `onSurfaceDisabled`, so a loading-state render would measure the greying
    // rather than the choice.
    const { host, root } = mountScreen(drive([served(true, 4096)]));
    try {
      const control = byTestID(host, "history-load-earlier");
      // Paper's own id for the label it wraps our words in. Read rather than
      // asserted as a name: it is where the colour lands. Spaces stripped
      // because the `style` attribute writes `rgba(1, 2, 3, 1.00)` where the
      // atomic sheet writes it closed up, and which half a value comes from is
      // Paper's business rather than this assertion's.
      //
      // Exact equality, and deliberately WITHOUT a companion `not.toBe(sage)`:
      // `toBe` already excludes every other colour, so that line could never
      // fail on its own and would only look like a second check. Reverting
      // `textColor` reports rgba(143,169,123,1.00), which is the sage this is
      // here to keep out.
      const words = declarationsFor(byTestID(host, "history-load-earlier-text")).get("color")?.replace(/\s+/g, "");
      expect(words).toBe(rgb(ompDarkTheme.ink.muted));

      // The label's colour alone does NOT cover the emphasis rule, and reading
      // only it left a hole: `mode="contained"` with `textColor` kept renders
      // this control filled sage and the assertion above still passes. Paper
      // puts our testID on the inner touchable and the FILL on the Surface
      // above it, so the node carrying the violation was outside what was being
      // read. Verified: with `mode="contained"` this array is what fails, and
      // the label check does not.
      //
      // Stated as "paints nothing" rather than "is not sage", so any filled
      // mode fails rather than only the one colour thought of here.
      const fills = [control, byTestID(host, "history-load-earlier-container")]
        .map(el => declarationsFor(el).get("background-color")?.replace(/\s+/g, ""))
        .filter(fill => fill !== undefined && fill !== "rgba(0,0,0,0.00)");
      expect(fills).toEqual([]);

      // Paper writes the radius inline as four longhands rather than into the
      // atomic sheet, so a reader that only consults `StyleSheet.getSheet()`
      // finds nothing here and passes a 40 point pill.
      //
      // Measured, both halves: with the override off, `corners` reads
      // ["40px", "40px"] -- Paper draws the radius on the container AND on the
      // touchable, and both flip together. So the positive is what discriminates
      // here and `not.toContain("40px")` is a cheap guard rather than a proven
      // second check; I did not observe a state where the two disagree. The
      // length assertion is the one that stops the negative going vacuous: a
      // reader that found no radius at all would otherwise "pass" on a pill.
      const corners = [control, byTestID(host, "history-load-earlier-container")].flatMap(el =>
        [...declarationsFor(el)].filter(([property]) => property.includes("radius")).map(([, value]) => value),
      );
      expect(corners.length).toBeGreaterThan(0);
      expect(corners).toContain(`${ompDarkTheme.radius.control}px`);
      expect(corners).not.toContain("40px");
    } finally {
      unmountScreen(host, root);
    }
  });
});
