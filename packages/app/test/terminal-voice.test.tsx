import "./rnw.ts";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionVoice } from "../src/screens/SessionScreen.tsx";
import type { NarrationSpeech } from "../src/voice/narration.ts";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

// Dynamic on purpose: loading them after rnw.ts is what makes this test exercise
// the web target instead of Bun trying to load native code.
const { TerminalSessionScreen } = await import("../src/screens/TerminalSessionScreen.tsx");
const { emptyConsole, tuiSessionFor } = await import("../src/console/state.ts");
const { WithOmpTheme } = await import("./theme.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  setWindowSize(820, 1180);
});
afterEach(() => {
  resetWindowSize();
});

class MockNarrationSpeech implements NarrationSpeech {
  readonly spoken: string[] = [];
  stopped = false;
  readonly availability: { readonly available: true } = { available: true };

  async speak(text: string): Promise<void> {
    this.spoken.push(text);
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}

function readyVoice(overrides: Partial<SessionVoice> = {}): SessionVoice {
  return {
    access: "granted",
    mic: { available: true },
    speech: { available: true },
    dictation: null,
    capturing: false,
    busyElsewhere: false,
    onToggle: () => {},
    ...overrides,
  };
}

interface MountedTerminal {
  host: HTMLElement;
  text: (testID: string) => string;
  attr: (testID: string, name: string) => string | null;
  find: (testID: string) => HTMLElement | null;
  press: (testID: string) => void;
  rerender: (props?: Partial<React.ComponentProps<typeof TerminalSessionScreen>>) => void;
  unmount: () => void;
}

function mountTerminal(props: Partial<React.ComponentProps<typeof TerminalSessionScreen>> = {}): MountedTerminal {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);

  const initialProps = {
    title: "session s-tui",
    cwd: "/alpha",
    status: "live-tui" as const,
    promptAccess: "granted" as const,
    tui: tuiSessionFor(emptyConsole([]), "s-tui"),
    load: { phase: "ready" as const, generation: 0, error: null },
    connection: "connected" as const,
    onBack: () => {},
    onLoadEarlier: () => {},
    onSubmit: () => {},
    ...props,
  };

  const render = (p: typeof initialProps) => {
    act(() => {
      root.render(
        <WithOmpTheme>
          <TerminalSessionScreen {...p} />
        </WithOmpTheme>,
      );
    });
  };

  render(initialProps);

  return {
    host,
    text: testID => host.querySelector(`[data-testid="${testID}"]`)?.textContent ?? "",
    attr: (testID, name) => host.querySelector(`[data-testid="${testID}"]`)?.getAttribute(name) ?? null,
    find: testID => host.querySelector(`[data-testid="${testID}"]`),
    press: testID => {
      act(() => {
        const el = (host.querySelector(`[data-testid="${testID}-toggle"]`) ??
          host.querySelector(`[data-testid="${testID}"]`)) as HTMLElement | null;
        el?.click();
      });
    },
    rerender: overrides => {
      render({ ...initialProps, ...overrides });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

describe("terminal session voice controls", () => {
  describe("microphone gating on terminal session", () => {
    test("a missing prompt scope disables the mic control with reason, never hides it", () => {
      const m = mountTerminal({
        voice: readyVoice({ access: "missing" }),
      });
      try {
        expect(m.find("terminal-composer-mic")).not.toBeNull();
        expect(m.attr("terminal-composer-mic", "aria-disabled")).toBe("true");
        expect(m.attr("terminal-composer-mic", "aria-label")).toContain("prompt scope");
        expect(m.attr("terminal-composer-mic", "aria-label")).toContain("Pair it again");
        expect(m.text("terminal-composer-mic-status")).toContain("prompt scope");
      } finally {
        m.unmount();
      }
    });

    test("a platform that cannot capture disables the mic control and names the gap", () => {
      const reason = "Voice input is unavailable on web: no module.";
      const m = mountTerminal({
        voice: readyVoice({ mic: { available: false, reason } }),
      });
      try {
        expect(m.find("terminal-composer-mic")).not.toBeNull();
        expect(m.attr("terminal-composer-mic", "aria-disabled")).toBe("true");
        expect(m.attr("terminal-composer-mic", "aria-label")).toContain(reason);
        expect(m.text("terminal-composer-mic-status")).toContain(reason);
      } finally {
        m.unmount();
      }
    });

    test("a microphone busy in another session disables the mic control with refusal", () => {
      const m = mountTerminal({
        voice: readyVoice({ busyElsewhere: true }),
      });
      try {
        expect(m.find("terminal-composer-mic")).not.toBeNull();
        expect(m.attr("terminal-composer-mic", "aria-disabled")).toBe("true");
        expect(m.attr("terminal-composer-mic", "aria-label")).toContain("already open in another session");
        expect(m.text("terminal-composer-mic-status")).toContain("already open in another session");
      } finally {
        m.unmount();
      }
    });

    test("pressing the ready mic starts capture via onToggle", () => {
      let toggled = false;
      const m = mountTerminal({
        voice: readyVoice({
          onToggle: () => {
            toggled = true;
          },
        }),
      });
      try {
        expect(m.find("terminal-composer-mic")).not.toBeNull();
        expect(m.attr("terminal-composer-mic", "aria-disabled")).not.toBe("true");
        m.press("terminal-composer-mic");
        expect(toggled).toBe(true);
      } finally {
        m.unmount();
      }
    });

    test("recording state shows recording indicator and live dictation text", () => {
      const m = mountTerminal({
        voice: readyVoice({
          capturing: true,
          dictation: { text: "build the app", final: false },
        }),
      });
      try {
        expect(m.text("terminal-composer-mic-status")).toContain("Recording");
        expect(m.text("terminal-composer-dictation")).toContain("build the app");
        expect(m.text("terminal-composer-dictation")).toContain("...");
      } finally {
        m.unmount();
      }
    });
  });

  describe("settled dictation submission", () => {
    test("a settled dictation submits through the terminal prompt path", () => {
      const submitted: string[] = [];
      const m = mountTerminal({
        onSubmit: text => {
          submitted.push(text);
        },
        voice: readyVoice({
          dictation: { text: "steer the terminal", final: true },
        }),
      });
      try {
        expect(m.text("terminal-composer-dictation")).toBe("steer the terminal");
        expect(submitted).toEqual(["steer the terminal"]);
      } finally {
        m.unmount();
      }
    });
  });

  describe("narration control in header", () => {
    test("narration control appears in terminal header with unavailable state", () => {
      const reason = "Narration is unavailable on web: this build has no OmpctlNarration text-to-speech module.";
      const unavailableSpeech: NarrationSpeech = {
        availability: { available: false, reason },
        speak: async () => {},
        stop: async () => {},
      };
      const m = mountTerminal({
        narrationSpeech: unavailableSpeech,
      });
      try {
        const toggle = m.find("session-narration-toggle");
        expect(toggle).not.toBeNull();
        expect(m.attr("session-narration-toggle", "aria-disabled")).toBe("true");
        expect(m.text("session-narration-status")).toContain("Narration unavailable");
        expect(m.text("session-narration-reason")).toBe(reason);
      } finally {
        m.unmount();
      }
    });

    test("narration control toggles on when available", () => {
      const speech = new MockNarrationSpeech();
      const m = mountTerminal({
        narrationSpeech: speech,
      });
      try {
        const toggle = m.find("session-narration-toggle");
        expect(toggle).not.toBeNull();
        expect(m.text("session-narration-status")).toContain("Narration off");
        m.press("session-narration-toggle");
        expect(m.text("session-narration-status")).toContain("Narration on");
      } finally {
        m.unmount();
      }
    });
    test("enabled narration speaks assistant prose from terminal history and reply", async () => {
      const speech = new MockNarrationSpeech();
      const m = mountTerminal({
        narrationSpeech: speech,
      });
      try {
        m.press("session-narration-toggle");
        expect(m.text("session-narration-status")).toContain("Narration on");

        const tuiWithReply = {
          ...tuiSessionFor(emptyConsole([]), "s-tui"),
          history: [
            { role: "assistant" as const, text: "Build completed successfully.", at: "2026-09-08T00:00:00.000Z" },
          ],
          reply: "All tests green.",
        };
        m.rerender({ tui: tuiWithReply, narrationSpeech: speech });

        await act(async () => {
          await Promise.resolve();
          await Promise.resolve();
        });

        expect(speech.spoken).toEqual(["Build completed successfully.", "All tests green."]);
      } finally {
        m.unmount();
      }
    });


    test("spoken prose renders the say surface in terminal log", () => {
      const m = mountTerminal({
        spoken: "Three tests passing.",
      });
      try {
        expect(m.find("transcript-say")).not.toBeNull();
        expect(m.text("transcript-say")).toContain("Three tests passing.");
      } finally {
        m.unmount();
      }
    });
  });
});
