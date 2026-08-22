/**
 * SafeScreen must keep design padding and add system insets, never trade one
 * for the other. A phone with a notch that lost its design padding is how a
 * form ends up jammed against the status bar on one edge and the home
 * indicator on the other.
 *
 * It must also survive being nested: the same screen is pushed on a phone,
 * where its own shell is the outermost thing on screen, and embedded in a
 * tablet's detail pane, where a shell above has already padded the window.
 */

import "./rnw.ts";

import { describe, expect, mock, test } from "bun:test";
import { act, createContext, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

// Known insets, set before SafeScreen is imported so the module sees them.
// The shape mirrors ./rnw.ts's mock rather than stubbing two exports: this
// file also stands alone, and @react-navigation/elements links named exports
// (initialWindowMetrics among them) from this module at load time.
const INSETS = { top: 47, right: 0, bottom: 34, left: 0 };
const FRAME = { x: 0, y: 0, width: 390, height: 844 };
mock.module("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children?: ReactNode }) => children ?? null,
  SafeAreaView: ({ children }: { children?: ReactNode }) => children ?? null,
  SafeAreaInsetsContext: createContext(INSETS),
  SafeAreaFrameContext: createContext(FRAME),
  initialWindowMetrics: { frame: FRAME, insets: INSETS },
  useSafeAreaInsets: () => INSETS,
}));

const { StyleSheet, Text } = await import("react-native");
const { SafeScreen } = await import("../src/design/SafeScreen.tsx");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { EMPTY_SESSION } = await import("../src/session/model.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function cssPadding(el: Element | null): { top: string; bottom: string; left: string; right: string } {
  if (!(el instanceof HTMLElement)) throw new Error("expected an HTMLElement");
  // RNW writes padding as inline style on the native host node.
  const style = el.style;
  return {
    top: style.paddingTop || style.getPropertyValue("padding-top"),
    bottom: style.paddingBottom || style.getPropertyValue("padding-bottom"),
    left: style.paddingLeft || style.getPropertyValue("padding-left"),
    right: style.paddingRight || style.getPropertyValue("padding-right"),
  };
}

/**
 * `getSheet` is a react-native-web extension, the same unchecked cast
 * `fleet-screen.test.tsx` makes: static StyleSheet values compile to atomic
 * classes whose declarations live here rather than in the markup.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/** The sheet rules addressing any of these classes, scoped so a declaration on some other element cannot satisfy an assertion. */
function sheetRulesFor(classes: readonly string[]): string {
  return rnwStyleSheet
    .getSheet()
    .textContent.split("\n")
    .filter(rule => classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule)))
    .join("\n");
}

describe("SafeScreen", () => {
  test("outer shell takes the system insets; inner content keeps design padding", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <SafeScreen testID="shell" style={{ padding: 16 }}>
          <Text testID="inner">content</Text>
        </SafeScreen>,
      );
    });

    const shell = host.querySelector('[data-testid="shell"]');
    expect(shell).not.toBeNull();
    const shellPad = cssPadding(shell);
    // System insets alone on the outer shell.
    expect(shellPad.top).toBe("47px");
    expect(shellPad.bottom).toBe("34px");
    expect(shellPad.left).toBe("0px");
    expect(shellPad.right).toBe("0px");

    // Design padding lives on the inner content node, the shell's first child.
    const content = shell?.firstElementChild ?? null;
    expect(content).not.toBeNull();
    const contentPad = cssPadding(content);
    expect(contentPad.top).toBe("16px");
    expect(contentPad.bottom).toBe("16px");
    expect(contentPad.left).toBe("16px");
    expect(contentPad.right).toBe("16px");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("session back control is labeled Sessions and returns to the bay", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    let backed = 0;

    act(() => {
      root.render(
        <SessionScreen
          agent={{
            id: "agt_test",
            name: "probe",
            state: "idle",
            host: { kind: "local", id: "1", spec: { kind: "local" } },
            cwd: "/tmp",
            createdAt: new Date(0).toISOString(),
            lastActiveAt: new Date(0).toISOString(),
            labels: {},
          }}
          session={EMPTY_SESSION}
          connection="connected"
          attempt={0}
          voice={{
            access: "unknown",
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
          onBack={() => {
            backed += 1;
          }}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
        />,
      );
    });

    const label = host.querySelector('[data-testid="session-back-label"]');
    expect(label?.textContent).toBe("Sessions");
    const back = host.querySelector('[data-testid="session-back"]') as HTMLElement | null;
    expect(back).not.toBeNull();
    // Assistive tech must hear the destination, not just "back".
    const accessible = back?.getAttribute("aria-label") ?? back?.getAttribute("accessibilityLabel") ?? "";
    expect(accessible.toLowerCase()).toContain("sessions");
    act(() => {
      back?.click();
    });
    expect(backed).toBe(1);

    // Bottom safe inset is on the composer chrome, not lost to KeyboardAvoidingView.
    const composerSafe = host.querySelector('[data-testid="session-composer-safe"]');
    expect(composerSafe).not.toBeNull();
    const composerPad = cssPadding(composerSafe);
    expect(composerPad.bottom).toBe("34px");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("a closed session still offers the way back", () => {
    // `stopped` is the contract's clean-exit state: the transcript is kept
    // but no further work can proceed. A person landing here is done with
    // this session, so the back control is the one thing the screen must not
    // lose; the screen renders one path, and this pins that no conditional
    // grows around its header later.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <SessionScreen
          agent={{
            id: "agt_test",
            name: "probe",
            state: "stopped",
            host: { kind: "local", id: "1", spec: { kind: "local" } },
            cwd: "/tmp",
            createdAt: new Date(0).toISOString(),
            lastActiveAt: new Date(0).toISOString(),
            labels: {},
          }}
          session={EMPTY_SESSION}
          connection="connected"
          attempt={0}
          voice={{
            access: "unknown",
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
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
        />,
      );
    });

    const back = host.querySelector('[data-testid="session-back"]');
    expect(back).not.toBeNull();
    const label = host.querySelector('[data-testid="session-back-label"]');
    expect(label?.textContent).toBe("Sessions");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("a nested shell does not pay the bottom inset an ancestor already paid", () => {
    // The raw insets read the same wherever the screen sits, and the
    // ancestor's padding already stops the nested content above the home
    // indicator, so a nested shell paying again is the double count that
    // floated the tablet's composer an inset above the list beside it.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <SafeScreen testID="outer">
          <SafeScreen testID="inner">
            <Text testID="deep">content</Text>
          </SafeScreen>
        </SafeScreen>,
      );
    });

    expect(cssPadding(host.querySelector('[data-testid="outer"]')).bottom).toBe("34px");
    expect(cssPadding(host.querySelector('[data-testid="inner"]')).bottom).toBe("0px");

    act(() => {
      root.unmount();
    });
    host.remove();
  });

  test("a composer under a paid shell pays nothing, and alone it pays on a surface-coloured view", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const screen = (
      <SessionScreen
        agent={{
          id: "agt_test",
          name: "probe",
          state: "idle",
          host: { kind: "local", id: "1", spec: { kind: "local" } },
          cwd: "/tmp",
          createdAt: new Date(0).toISOString(),
          lastActiveAt: new Date(0).toISOString(),
          labels: {},
        }}
        session={EMPTY_SESSION}
        connection="connected"
        attempt={0}
        voice={{
          access: "unknown",
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
        onSubmit={() => {}}
        onCancel={() => {}}
        onDecide={() => {}}
        onDecidePlan={() => {}}
      />
    );

    // Nested under a shell that paid: the composer drops its own bottom
    // inset entirely, which is what lines it up with the list beside it.
    act(() => {
      root.render(<SafeScreen testID="outer">{screen}</SafeScreen>);
    });
    expect(cssPadding(host.querySelector('[data-testid="session-composer-safe"]')).bottom).toBe("0px");

    // Standing alone: the inset is paid, and the payer is the composer's
    // own surface. A transparent wrapper paying the pad is exactly the
    // strip of the shell's base colour below the message box the operator
    // reported on the tablet, so the payer's own background is asserted,
    // found by walking up from the field to whoever pays the inset.
    act(() => {
      root.render(screen);
    });
    expect(cssPadding(host.querySelector('[data-testid="session-composer-safe"]')).bottom).toBe("34px");
    const field = host.querySelector('[data-testid="composer-input"]');
    let payer: Element | null = field;
    while (payer !== null && (payer as HTMLElement).style.paddingBottom !== "34px") {
      payer = payer.parentElement;
    }
    expect(payer).not.toBeNull();
    // RNW compiles static StyleSheet values into its sheet rather than
    // inline style, so the payer's colour is read from the rules its own
    // classes select: ground.surface, which is the composer's surface.
    const rules = sheetRulesFor([...(payer?.classList ?? [])]);
    expect(rules).toMatch(/background-color:\s*rgba\(28,\s*26,\s*22,/);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
