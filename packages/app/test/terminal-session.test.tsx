/**
 * The terminal prompt surface: canned `tui_activity` and refusal frames
 * becoming the hints and the message one live terminal session shows.
 *
 * The screen under test is the one a `live-tui` fleet row opens. It has no
 * transcript to render, so every test here drives the real console reducer
 * with the frames the daemon would send and hands the resulting hints to the
 * real screen: a pass means those frames would paint that screen on a device.
 * The composer is exercised mounted, the way `composer-submit.test.tsx`
 * exercises the agent one, because typing is the only control here.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleEvent, ConsoleState } from "../src/console/state.ts";
import { apply, emptyConsole, tuiSessionFor } from "../src/console/state.ts";

// Dynamic on purpose, same reason as `fleet-screen.test.tsx`: these modules
// import "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { TerminalSessionScreen } = await import("../src/screens/TerminalSessionScreen.tsx");

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

function renderScreen(state: ConsoleState): string {
  return renderToStaticMarkup(
    <TerminalSessionScreen
      title="session s-tui"
      cwd="/Users/op/dev/src/github.com/op/alpha"
      tui={tuiSessionFor(state, SESSION)}
      connection="connected"
      onBack={() => {}}
      onSubmit={() => {}}
    />,
  );
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
          tui={tuiSessionFor(emptyConsole([]), SESSION)}
          connection="connected"
          onBack={() => {}}
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
          tui={tuiSessionFor(state, SESSION)}
          connection="connected"
          onBack={() => {}}
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
    expect(html).toContain("Sent to this terminal");
    expect(html).not.toContain('data-testid="terminal-busy"');
    expect(html).not.toContain('data-testid="terminal-reply"');
  });

  test("a turn_start shows the busy mark; the turn ending clears it", () => {
    const working = drive([{ t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } }]);
    expect(renderScreen(working)).toContain('data-testid="terminal-busy"');

    const done = drive([
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_end" } },
    ]);
    expect(renderScreen(done)).not.toContain('data-testid="terminal-busy"');
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
    expect(html).not.toContain('data-testid="terminal-busy"');
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
    expect(html).toContain('data-testid="terminal-refusal"');
    expect(html).toContain("Restart it in its terminal");
    expect(html).toContain("bridge");
    // The daemon's phrasing names a session id, which is not a remedy; the
    // raw message must not be what the operator reads.
    expect(html).not.toContain("no connected TUI owns");
    expect(html).not.toContain("tui_unreachable");
  });

  test("a prompt after a refusal clears it and sends again", () => {
    expect(renderScreen(drive(refused()))).toContain('data-testid="terminal-refusal"');

    const retried = drive([...refused(), { t: "tui_prompt", sessionId: SESSION, text: "again" }]);
    const html = renderScreen(retried);
    expect(html).not.toContain('data-testid="terminal-refusal"');
    expect(html).toContain("again");
  });
});
