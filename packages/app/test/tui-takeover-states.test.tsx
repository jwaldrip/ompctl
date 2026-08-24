import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { SessionLiveStatus } from "@ompd/core/contracts";
import { SCOPE_PROMPT, SCOPE_READ } from "@ompd/core/contracts";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConsoleEvent, ConsoleState, TuiPromptAccess } from "../src/console/state.ts";
import { apply, emptyConsole, tuiPromptAccess, tuiSessionFor } from "../src/console/state.ts";

// The React Native mock must be installed before this module resolves react-native.
const { TerminalSessionScreen } = await import("../src/screens/TerminalSessionScreen.tsx");

const SESSION = "session-from-terminal";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function drive(events: readonly ConsoleEvent[]): ConsoleState {
  let state = emptyConsole([]);
  for (const event of events) state = apply(state, event);
  return state;
}

function renderScreen(
  state: ConsoleState,
  options: {
    status?: SessionLiveStatus | null;
    promptAccess?: TuiPromptAccess;
  } = {},
): string {
  return renderToStaticMarkup(
    <TerminalSessionScreen
      title="Terminal work"
      cwd="/Users/operator/work"
      status={options.status === undefined ? "live-tui" : options.status}
      promptAccess={options.promptAccess ?? "granted"}
      tui={tuiSessionFor(state, SESSION)}
      load={{ phase: "ready", generation: 0, error: null }}
      connection="connected"
      onBack={() => {}}
      onLoadEarlier={() => {}}
      onSubmit={() => {}}
    />,
  );
}

function mountScreen(options: {
  status?: SessionLiveStatus | null;
  promptAccess?: TuiPromptAccess;
  state?: ConsoleState;
  onSubmit: (text: string) => void;
}): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <TerminalSessionScreen
        title="Terminal work"
        cwd="/Users/operator/work"
        status={options.status === undefined ? "live-tui" : options.status}
        promptAccess={options.promptAccess ?? "granted"}
        tui={tuiSessionFor(options.state ?? emptyConsole([]), SESSION)}
        load={{ phase: "ready", generation: 0, error: null }}
        connection="connected"
        onBack={() => {}}
        onLoadEarlier={() => {}}
        onSubmit={options.onSubmit}
      />,
    );
  });
  return { host, root };
}

function typeInto(input: HTMLInputElement, value: string): void {
  const propsKey = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  const props =
    propsKey === undefined ? null : (Reflect.get(input, propsKey) as { onChange?: (event: unknown) => void });
  input.value = value;
  act(() => {
    props?.onChange?.({
      target: input,
      currentTarget: input,
      nativeEvent: { text: value },
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  });
}

function unmountScreen(host: HTMLDivElement, root: Root): void {
  act(() => {
    root.unmount();
  });
  host.remove();
}

describe("terminal takeover states", () => {
  test("uses daemon scope truth, with an explicit unknown state for legacy pairings", () => {
    expect(tuiPromptAccess(emptyConsole([]), [])).toBe("unknown");
    expect(tuiPromptAccess(emptyConsole([SCOPE_READ]), [SCOPE_READ])).toBe("missing");
    expect(tuiPromptAccess(emptyConsole([SCOPE_PROMPT]), [SCOPE_PROMPT])).toBe("granted");

    const narrowed = apply(emptyConsole([SCOPE_PROMPT]), {
      t: "agents",
      event: { agents: [], scopes: [SCOPE_READ] },
    });
    const granted = apply(emptyConsole([SCOPE_READ]), {
      t: "agents",
      event: { agents: [], scopes: [SCOPE_PROMPT] },
    });
    expect(tuiPromptAccess(narrowed, [SCOPE_PROMPT])).toBe("missing");
    expect(tuiPromptAccess(granted, [SCOPE_READ])).toBe("granted");
  });

  test("keeps the terminal as transcript owner while progress renders on the phone", () => {
    const state = drive([
      { t: "tui_prompt", sessionId: SESSION, text: "check the release" },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "assistant_text", text: "checking now" } },
    ]);

    const html = renderScreen(state);
    expect(html).toContain('data-testid="terminal-busy"');
    expect(html).toContain('data-testid="terminal-reply"');
    expect(html).toContain("checking now");
    expect(html).toContain('data-testid="terminal-transcript-limit"');
    expect(html).toContain("full transcript and tool output stay in the terminal");
  });

  test("renders a named not live TUI state and leaves the disabled control visible", () => {
    const submitted: string[] = [];
    const { host, root } = mountScreen({
      status: "dormant",
      onSubmit: text => {
        submitted.push(text);
      },
    });
    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLInputElement | null;
    const send = host.querySelector('[data-testid="terminal-composer-send"]') as HTMLButtonElement | null;
    expect(input).not.toBeNull();
    expect(send).not.toBeNull();
    typeInto(input!, "must not leave");
    act(() => {
      send?.click();
    });

    expect(host.innerHTML).toContain('data-testid="terminal-not-live-tui"');
    expect(host.innerHTML).toContain("Not a live terminal session");
    expect(send?.disabled).toBe(true);
    expect(submitted).toEqual([]);
    unmountScreen(host, root);
  });

  test("names a known missing prompt scope before a steer can be sent", () => {
    const submitted: string[] = [];
    const { host, root } = mountScreen({
      promptAccess: "missing",
      onSubmit: text => {
        submitted.push(text);
      },
    });
    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLInputElement | null;
    const send = host.querySelector('[data-testid="terminal-composer-send"]') as HTMLButtonElement | null;
    expect(input).not.toBeNull();
    expect(send).not.toBeNull();
    typeInto(input!, "must not steer");
    act(() => {
      send?.click();
    });

    expect(host.innerHTML).toContain('data-testid="terminal-scope-refusal"');
    expect(host.innerHTML).toContain("prompt scope");
    expect(send?.disabled).toBe(true);
    expect(submitted).toEqual([]);
    unmountScreen(host, root);
  });

  test("names the owning terminal going away after the daemon refuses the steer", () => {
    const state = drive([
      { t: "tui_select", sessionId: SESSION },
      { t: "tui_prompt", sessionId: SESSION, text: "are you there?" },
      { t: "error", event: { code: "tui_unreachable", message: `no connected TUI owns session ${SESSION}` } },
    ]);

    const html = renderScreen(state);
    expect(html).toContain('data-testid="terminal-owner-gone"');
    expect(html).toContain("Owning terminal is unreachable");
  });

  test("names and keeps a daemon scope refusal that raced an unknown grant", () => {
    const state = drive([
      { t: "tui_select", sessionId: SESSION },
      { t: "tui_prompt", sessionId: SESSION, text: "run tests" },
      { t: "error", event: { code: "unauthorized", message: "session prompt requires prompt scope" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
    ]);
    const submitted: string[] = [];
    const { host, root } = mountScreen({
      state,
      promptAccess: "unknown",
      onSubmit: text => {
        submitted.push(text);
      },
    });
    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLInputElement | null;
    const send = host.querySelector('[data-testid="terminal-composer-send"]') as HTMLButtonElement | null;
    expect(input).not.toBeNull();
    expect(send).not.toBeNull();
    typeInto(input!, "retry must not leave");
    act(() => {
      send?.click();
    });

    expect(host.innerHTML).toContain('data-testid="terminal-scope-refusal"');
    expect(host.innerHTML).toContain("prompt scope");
    expect(send?.disabled).toBe(true);
    expect(submitted).toEqual([]);
    unmountScreen(host, root);
  });

  test("names a turn whose reply stayed in the terminal", () => {
    const state = drive([
      { t: "tui_prompt", sessionId: SESSION, text: "show the tool result" },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_start" } },
      { t: "tui_activity", event: { sessionId: SESSION, kind: "turn_end" } },
    ]);

    const html = renderScreen(state);
    expect(html).toContain('data-testid="terminal-reply-unavailable"');
    expect(html).toContain("Reply stayed in the terminal");
  });

  test("submits a steer without replacing the terminal writer", () => {
    const submitted: string[] = [];
    const { host, root } = mountScreen({
      onSubmit: text => {
        submitted.push(text);
      },
    });
    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    typeInto(input!, "continue from the phone");
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="terminal-composer-send"]')?.click();
    });

    expect(submitted).toEqual(["continue from the phone"]);
    unmountScreen(host, root);
  });
});
