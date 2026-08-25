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
import { act, type ComponentProps, createContext, type JSX, type ReactNode } from "react";
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
// Dynamic for the reason every import in this file is: bun binds a file's whole
// static import graph before its body runs, and `theme.tsx` reaches
// react-native-paper, which reaches react-native. A static import would pull the
// real one in before `./rnw.ts` substitutes react-native-web for it.
const { rhythm } = await import("../src/design/rhythm.ts");
const { WithOmpTheme } = await import("./theme.tsx");

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
          load={{ phase: "ready", generation: 0, error: null }}
          context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
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
          load={{ phase: "ready", generation: 0, error: null }}
          context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
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
        load={{ phase: "ready", generation: 0, error: null }}
        context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
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

/**
 * "Spacing looks off."
 *
 * It was, and this is the measurement that says so. The session shell is one
 * column of bands, and every band had its own idea of where content starts:
 * the header 12, the narration band 12, the readout 16, the composer's dock
 * 12, the withheld and watch-only and resume bands 12, the loading panel 32,
 * and the working row nothing at all -- flush against the screen edge. Five
 * different left edges down one column. No single number looks wrong on its
 * own, which is why the report was "off" rather than "the header is 4 short".
 *
 * So this asserts the CLASS rather than any one band: every horizontal inset
 * in the shell is the same value, and that value is `rhythm.gutter`. Both
 * halves matter. Equality alone would pass a column that agreed on 12, and
 * the token alone would pass a column where one band was still 32.
 *
 * Read out of the rendered sheet, never out of the source, so a band that
 * stops paying -- or pays twice by nesting inside another that pays -- fails
 * here rather than reading fine in the file.
 */
describe("one gutter, every band of the session shell", () => {
  const AGENT = {
    id: "agt_test",
    name: "probe",
    state: "busy" as const,
    host: { kind: "local" as const, id: "1", spec: { kind: "local" as const } },
    cwd: "/tmp/some/project",
    createdAt: new Date(0).toISOString(),
    lastActiveAt: new Date(0).toISOString(),
    labels: {},
  };

  const VOICE = {
    access: "unknown" as const,
    mic: { available: false, reason: "no microphone in this test" },
    speech: { available: false, reason: "no playback in this test" },
    dictation: null,
    capturing: false,
    busyElsewhere: false,
    onToggle: () => {},
  };

  /**
   * The shell under the real theme. Wrapped, because Paper's own components
   * inside it read their colours and metrics from the provider; unwrapped they
   * would render Material's, and a gutter measured off a Material metric would
   * prove nothing about this app.
   */
  function shell(overrides: Partial<ComponentProps<typeof SessionScreen>> = {}): JSX.Element {
    return (
      <WithOmpTheme>
        <SessionScreen
          agent={AGENT}
          session={EMPTY_SESSION}
          load={{ phase: "ready", generation: 0, error: null }}
          context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
          connection="connected"
          attempt={0}
          voice={VOICE}
          spoken={null}
          fleetClearances={0}
          canApprove
          onBack={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
          {...overrides}
        />
      </WithOmpTheme>
    );
  }

  interface Frame {
    host: HTMLElement;
    unmount: () => void;
  }

  function render(node: JSX.Element): Frame {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(node);
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

  /**
   * The horizontal padding one element carries, out of the rendered sheet.
   *
   * RNW compiles a static `paddingHorizontal` into an atomic class whose rule
   * declares `padding-left` and `padding-right`, and every View also carries a
   * base class declaring `padding: 0px`. The sheet is in precedence order, so
   * the last declaration of a property is the one that applies -- the same
   * last-wins read `pair-connections-consistency.test.tsx` makes. An inline
   * declaration beats both, which is how RNW writes a value computed at render.
   */
  function ownInset(el: HTMLElement): { left: number; right: number } {
    const classes = el.className.split(/\s+/).filter(Boolean);
    let left = 0;
    let right = 0;
    for (const rule of rnwStyleSheet.getSheet().textContent.split("\n")) {
      if (!classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule))) continue;
      for (const declaration of rule.matchAll(/(padding(?:-left|-right)?):\s*([-\d.]+)px/gi)) {
        const property = declaration[1]?.toLowerCase();
        const value = Number(declaration[2]);
        if (property === "padding") {
          left = value;
          right = value;
        } else if (property === "padding-left") left = value;
        else if (property === "padding-right") right = value;
      }
    }
    const inlineLeft = el.style.paddingLeft || el.style.padding;
    const inlineRight = el.style.paddingRight || el.style.padding;
    if (inlineLeft !== "") left = Number.parseFloat(inlineLeft);
    if (inlineRight !== "") right = Number.parseFloat(inlineRight);
    return { left, right };
  }

  /**
   * How far a band's content sits from the screen edge: its own inset plus
   * every ancestor's, up to the mount point.
   *
   * Measured this way on purpose, rather than per band, because the two ways a
   * column loses its rhythm are opposites and a single-layer read catches only
   * one of them. A band can stop paying -- the working row did, and sat flush
   * against the edge while the header was inset. And two layers can both pay:
   * the list's content container pays the gutter, so a row inside it that pays
   * one too sits at 32. Summing sees both, and it is also the only number that
   * corresponds to anything an operator can see.
   */
  function inset(el: HTMLElement, root: HTMLElement): { left: number; right: number } {
    let left = 0;
    let right = 0;
    for (let node: HTMLElement | null = el; node !== null && node !== root; node = node.parentElement) {
      const own = ownInset(node);
      left += own.left;
      right += own.right;
    }
    return { left, right };
  }

  /** Every band in one frame, named by what an operator would call it. */
  function bands(host: HTMLElement, wanted: Record<string, string>): Map<string, HTMLElement> {
    const found = new Map<string, HTMLElement>();
    for (const [name, testID] of Object.entries(wanted)) {
      const el = host.querySelector(`[data-testid="${testID}"]`);
      if (!(el instanceof HTMLElement)) throw new Error(`${name} (${testID}) did not render, so its inset is unproven`);
      found.set(name, el);
    }
    return found;
  }

  /**
   * Every measured band, as one readable object, so a failure names the band
   * that drifted and the value it drifted to rather than just "16 !== 12".
   */
  function insets(found: Map<string, HTMLElement>, root: HTMLElement): Record<string, string> {
    return Object.fromEntries(
      [...found].map(([name, el]) => {
        const { left, right } = inset(el, root);
        return [name, left === right ? `${left}` : `${left}/${right}`];
      }),
    );
  }

  function allGutter(found: Map<string, HTMLElement>, root: HTMLElement): void {
    const expected = Object.fromEntries([...found.keys()].map(name => [name, `${rhythm.gutter}`]));
    expect(insets(found, root)).toEqual(expected);
  }

  test("a working session: header, narration, readout and the working row start at one x", () => {
    const frame = render(shell({ reduceMotion: true }));
    try {
      allGutter(
        bands(frame.host, {
          header: "session-head",
          narration: "session-narration",
          readout: "status-readout",
          // The one that paid nothing at all before this, so the working row
          // sat flush against the screen edge under an inset prompt. It still
          // pays nothing: the list's content container is what pays for it now,
          // and the sum is what proves the row lands where the prose does.
          "working row": "session-activity",
        }),
        frame.host,
      );
    } finally {
      frame.unmount();
    }
  });

  test("the working row lands exactly where the transcript's own rows do", () => {
    // The row's whole claim is that it IS the next agent row. Two rows that
    // agree with the header but not with each other would still pass the sums
    // above, so this pins the one relationship that makes the claim true.
    const frame = render(shell({ reduceMotion: true }));
    try {
      const row = frame.host.querySelector('[data-testid="session-activity"]');
      if (!(row instanceof HTMLElement)) throw new Error("the working row did not render");
      // Its own padding is zero, because the container pays. A row that starts
      // paying again is the 32-point indent this catches.
      expect(ownInset(row)).toEqual({ left: 0, right: 0 });
      expect(inset(row, frame.host)).toEqual({ left: rhythm.gutter, right: rhythm.gutter });
    } finally {
      frame.unmount();
    }
  });

  test("the composer's dock starts at the same x as the header above it", () => {
    // Measured on the dock rather than on `session-composer-safe`, because the
    // pad band deliberately pays no gutter: whichever of the four things can
    // fill that slot brings its own, so they share one left edge instead of
    // nesting two. The dock is the composer's own band, the parent of its
    // surface, and it is the one that has to agree with the header.
    const frame = render(shell());
    try {
      const surface = frame.host.querySelector('[data-testid="composer-surface"]');
      if (!(surface instanceof HTMLElement)) throw new Error("the composer did not render");
      const dock = surface.parentElement;
      if (dock === null) throw new Error("the composer surface has no dock band");
      expect(inset(dock, frame.host)).toEqual({ left: rhythm.gutter, right: rhythm.gutter });
      // And the pad band around it pays nothing of its own, or the dock would
      // sit at 32 while the header sat at 16.
      const pad = frame.host.querySelector('[data-testid="session-composer-safe"]');
      if (!(pad instanceof HTMLElement)) throw new Error("the composer pad band did not render");
      expect(ownInset(pad)).toEqual({ left: 0, right: 0 });
    } finally {
      frame.unmount();
    }
  });

  test("a session still arriving: the waiting panel and the withheld controls agree with the chrome", () => {
    const frame = render(shell({ load: { phase: "loading", generation: 1, error: null } }));
    try {
      allGutter(
        bands(frame.host, {
          header: "session-head",
          narration: "session-narration",
          readout: "status-readout",
          "loading panel": "session-loading",
          "withheld controls": "session-actions-withheld",
        }),
        frame.host,
      );
    } finally {
      frame.unmount();
    }
  });

  test("a refused session and a dropped link keep the gutter their transcript would have had", () => {
    for (const load of [
      { phase: "failed" as const, generation: 1, error: "refused" },
      { phase: "stalled" as const, generation: 1, error: null },
    ]) {
      const frame = render(shell({ load }));
      try {
        allGutter(
          bands(frame.host, {
            panel: load.phase === "failed" ? "session-load-failed" : "session-load-stalled",
            "withheld controls": "session-actions-withheld",
          }),
          frame.host,
        );
      } finally {
        frame.unmount();
      }
    }
  });

  test("a view-only guest's band sits where the composer would have", () => {
    const frame = render(shell({ watchOnly: "You joined this terminal to watch." }));
    try {
      allGutter(bands(frame.host, { "watch-only band": "session-watch-only" }), frame.host);
    } finally {
      frame.unmount();
    }
  });

  test("a stopped agent's resume band sits there too", () => {
    const frame = render(shell({ agent: { ...AGENT, state: "stopped" }, onResume: () => {} }));
    try {
      const button = frame.host.querySelector('[data-testid="session-resume"]');
      if (!(button instanceof HTMLElement)) throw new Error("the resume control did not render");
      const band = button.parentElement;
      if (band === null) throw new Error("the resume control has no band");
      expect(inset(band, frame.host)).toEqual({ left: rhythm.gutter, right: rhythm.gutter });
    } finally {
      frame.unmount();
    }
  });

  test("the gutter is one token, so no band can be right by accident", () => {
    // The sums above would all still pass if every band moved to 12 together.
    // This is the half that pins WHICH value they agree on, and it fails the
    // moment a band is written as a literal that happens to match today's
    // `gutter` and then stops matching when the token moves.
    const frame = render(shell({ reduceMotion: true }));
    try {
      const header = frame.host.querySelector('[data-testid="session-head"]');
      if (!(header instanceof HTMLElement)) throw new Error("the header did not render");
      expect(inset(header, frame.host).left).toBe(rhythm.gutter);
      expect(rhythm.gutter).toBe(16);
    } finally {
      frame.unmount();
    }
  });
});
