/**
 * The pair screen and the connections screen are one flow — pairing hands
 * back to the chooser, "Add connection" hands forward to pair — and three
 * defects let them read as two apps: two primary-button treatments, two
 * content gutters, and an unknown metric that rendered as a bare `--`, a
 * shape this design reserves for values. Each test below pins one of the
 * three and fails if the divergence is restored.
 *
 * Styles are audited through `StyleSheet.getSheet().textContent`, the same
 * react-native-web extension `fleet-screen.test.tsx` and
 * `safe-screen.test.tsx` cast onto: static `StyleSheet` values compile to
 * atomic CSS classes whose declarations live in the sheet, not in the
 * markup, so reading the element alone would see class names and no values.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectionList } from "../src/platform/connection.ts";

// Dynamic on purpose, the same way `pair-screen.test.tsx` loads its screen:
// bun evaluates a file's whole static import graph before its body runs, so
// static imports of the screens would pull the real `react-native` in before
// `./rnw.ts` could substitute it, and the real DOM globals before happy-dom
// is registered.
const { ConnectionSwitcherScreen } = await import("../src/screens/ConnectionSwitcherScreen.tsx");
const { PairScreen } = await import("../src/screens/PairScreen.tsx");
const { StatusReadout } = await import("../src/components/StatusReadout.tsx");
const { StyleSheet } = await import("react-native");
const { space, signal } = await import("../src/design/tokens.ts");

/** RNW exposes this stylesheet API at runtime but not in its TypeScript surface. */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const connections: ConnectionList = {
  activeId: "local",
  connections: [
    {
      id: "local",
      label: "Local",
      connection: { transport: "direct", url: "ws://127.0.0.1:7777/v1/socket", token: "tok_local", scopes: [] },
    },
  ],
};

/**
 * The declarations an element actually carries, read out of the sheet by the
 * classes on its markup. RNW's atomic sheet gives each declaration one class,
 * so a property appears at most once per element.
 */
function declarationsFor(el: Element): Map<string, string> {
  const classes = el.className.split(/\s+/).filter(Boolean);
  const out = new Map<string, string>();
  for (const rule of rnwStyleSheet.getSheet().textContent.split("\n")) {
    if (!classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule))) continue;
    for (const declaration of rule.matchAll(/([a-z-]+):\s*([^;]+);/gi)) {
      const property = declaration[1];
      const value = declaration[2];
      if (property === undefined || value === undefined) continue;
      out.set(property.toLowerCase(), value.trim());
    }
  }
  return out;
}

/** The six-digit hex of a token as the rgba() RNW's compiler serialises it to. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},1.00)`;
}

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

function mountSwitcher(): Mounted {
  return mount(
    <ConnectionSwitcherScreen
      canInvite={false}
      connections={connections}
      onAdd={() => {}}
      onBack={() => {}}
      onInvite={() => {}}
      onSelect={() => {}}
      onSettings={() => {}}
    />,
  );
}

function mountPair(): Mounted {
  return mount(<PairScreen onPair={() => {}} onScan={() => {}} />);
}

function byTestID(host: HTMLElement, testID: string): HTMLElement {
  const element = host.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`no ${testID} rendered`);
  return element;
}

/**
 * The SafeScreen content view: the shell takes the testID and the system
 * insets, the caller's style — including the screen's design padding — lands
 * on its only child.
 */
function contentView(host: HTMLElement, testID: string): HTMLElement {
  const content = byTestID(host, testID).firstElementChild;
  if (!(content instanceof HTMLElement)) throw new Error(`${testID} has no content view`);
  return content;
}

/**
 * The pair screen's Connect control only takes the primary fill once the
 * form can produce a connection, so a treatment comparison has to get there
 * first. Drives the rendered `onChange` the way `pair-screen.test.tsx` does:
 * the native-setter-and-event route never reaches React under happy-dom.
 */
function armPairForm(host: HTMLElement): void {
  const endpoint = byTestID(host, "pair-endpoint");
  const token = byTestID(host, "pair-token");
  if (!(endpoint instanceof HTMLInputElement) || !(token instanceof HTMLInputElement)) {
    throw new Error("pair fields did not render as inputs");
  }
  act(() => {
    typeInto(endpoint, "hub.example.com");
    typeInto(token, `${"a".repeat(64)}.tok_abc`);
  });
}

function typeInto(input: HTMLInputElement, value: string): void {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input: the change path cannot be driven");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
  input.value = value;
  props.onChange({
    target: input,
    currentTarget: input,
    nativeEvent: { text: value },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

describe("pair and connections draw from one design", () => {
  test("one primary-button treatment: the same fill on both screens' primary act", () => {
    const pair = mountPair();
    armPairForm(pair.host);
    const switcher = mountSwitcher();
    try {
      const submitFill = declarationsFor(byTestID(pair.host, "pair-submit")).get("background-color");
      const addFill = declarationsFor(byTestID(switcher.host, "add-connection")).get("background-color");
      // The filled swatch the rest of the app already uses, not the ghost
      // outline that read as one more text field.
      expect(submitFill).toBe(rgb(signal.sage));
      expect(addFill).toBe(rgb(signal.sage));
      expect(submitFill).toBe(addFill);
    } finally {
      pair.unmount();
      switcher.unmount();
    }
  });

  test("one content gutter: both screens pad their content by the same token", () => {
    const pair = mountPair();
    const switcher = mountSwitcher();
    try {
      const pairGutter = declarationsFor(contentView(pair.host, "pair")).get("padding");
      const switcherGutter = declarationsFor(contentView(switcher.host, "connection-switcher")).get("padding");
      expect(pairGutter).toBe(`${space.loose}px`);
      expect(switcherGutter).toBe(`${space.loose}px`);
      expect(pairGutter).toBe(switcherGutter);
    } finally {
      pair.unmount();
      switcher.unmount();
    }
  });

  test("an unknown metric says what is missing and why, and the row stays", () => {
    const readout = mount(<StatusReadout state="connected" attempt={0} usage={null} clearances={0} />);
    try {
      for (const testID of ["status-context", "status-spend"]) {
        const reading = byTestID(readout.host, testID);
        expect(reading.textContent).not.toBe("--");
        expect(reading.textContent).toContain("not reported");
      }
      // Absence is stated, not hidden: both meter rows keep their labels.
      expect(readout.host.textContent).toContain("context");
      expect(readout.host.textContent).toContain("spend");
    } finally {
      readout.unmount();
    }
  });

  test("a reported metric still renders as a number, not as the absence wording", () => {
    const readout = mount(
      <StatusReadout
        state="connected"
        attempt={0}
        usage={{ used: 42_000, size: 200_000, costAmount: 1.5, costCurrency: "USD" }}
        clearances={0}
      />,
    );
    try {
      expect(byTestID(readout.host, "status-context").textContent).toBe("42k/200k");
      expect(byTestID(readout.host, "status-spend").textContent).not.toContain("not reported");
    } finally {
      readout.unmount();
    }
  });
});
