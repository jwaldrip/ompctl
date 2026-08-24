/**
 * Where a composer keeps the controls that belong to the prompt.
 *
 * The defect this pins is a placement one, and placement is invisible to
 * every other kind of check. Until 2026-08-24 the attachment control sat in a
 * band *above* the text field, the microphone sat in a band above that, and
 * send sat beside the field. Three controls belonging to one act, spread down
 * three horizontal bands, none of them where a person who has used any other
 * composer would reach for it. Every unit test passed the whole time: the
 * callbacks fired, the testIDs resolved, and nothing could see that the
 * paperclip was nowhere near the lower-left corner it belongs in.
 *
 * So the rules held here are structural rather than behavioural, and they are
 * held for both composers, because a second arrangement of one control is a
 * second convention:
 *
 *  - the words come first, and the gestures come after them, inside the same
 *    surface;
 *  - the gestures are ONE row, whose two ends are apart;
 *  - the paperclip is at that row's left end, and everything that acts on
 *    what was typed is grouped at its right end;
 *  - the send becoming an interrupt does not move the paperclip, because a
 *    control that migrates when the turn state changes teaches nothing.
 *
 * Layout is asserted against the stylesheet react-native-web actually emits,
 * not against the source text of a StyleSheet block: a rule that is written
 * and never rendered is exactly the failure this file exists to catch.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { MAX_PROMPT_IMAGES, type PromptImage } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageAttachmentPicker, PickedAttachments } from "../src/platform/attachments.ts";

// Dynamic on purpose, the same reason every rendering test here does it: these
// modules import "react-native", and a static import is hoisted above
// `./rnw.ts`'s `mock.module` call, so the real native module table would be
// resolved before the web substitution is registered.
const { Composer } = await import("../src/components/Composer.tsx");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { TerminalSessionScreen } = await import("../src/screens/TerminalSessionScreen.tsx");
const { EMPTY_SESSION } = await import("../src/session/model.ts");
const { emptyConsole, tuiSessionFor } = await import("../src/console/state.ts");
const { StyleSheet } = await import("react-native");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Mounted {
  host: HTMLElement;
  root: Root;
  /** The element under this testID, or a thrown error naming what is missing. */
  need(testID: string): HTMLElement;
  /** Present or absent, without throwing, for the cases that assert absence. */
  find(testID: string): HTMLElement | null;
  /** True when the first testID's element comes before the second's in document order. */
  precedes(first: string, second: string): boolean;
  press(testID: string): void;
  unmount(): void;
}

function mount(element: React.JSX.Element): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });

  const find = (testID: string): HTMLElement | null => host.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  const need = (testID: string): HTMLElement => {
    const found = find(testID);
    if (found === null) throw new Error(`no ${testID} on screen`);
    return found;
  };

  return {
    host,
    root,
    need,
    find,
    precedes: (first, second) => {
      // Document order over the whole subtree: "above" in a column layout is
      // exactly "earlier in the tree", and reading it from the tree needs no
      // geometry a headless DOM cannot supply.
      const all = [...host.querySelectorAll<HTMLElement>("*")];
      return all.indexOf(need(first)) < all.indexOf(need(second));
    },
    press: testID => {
      const target = need(testID);
      act(() => {
        target.click();
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/**
 * `getSheet` is a react-native-web extension the package's own web build
 * publishes and its types do not: static StyleSheet values compile to atomic
 * classes whose declarations live in one injected sheet rather than in the
 * markup. Same cast `terminal-session.test.tsx` makes, for the same reason.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/** Every emitted declaration that addresses one element's own classes. */
function renderedStyle(element: HTMLElement): string {
  const classes = element.className.split(/\s+/).filter(name => name.length > 0);
  return rnwStyleSheet
    .getSheet()
    .textContent.split("\n")
    .filter(rule => classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule)))
    .join("\n");
}

/** The testIDs of one element's direct children, in order. */
function childIDs(element: HTMLElement): (string | null)[] {
  return [...element.children].map(child => child.getAttribute("data-testid"));
}

const LIVE_PICKER: ImageAttachmentPicker = {
  availability: { available: true },
  pick: async (): Promise<PickedAttachments> => ({ images: [], refused: [] }),
};

function composer(overrides: Partial<React.ComponentProps<typeof Composer>> = {}): React.JSX.Element {
  return (
    <Composer
      prefix="composer"
      picker={LIVE_PICKER}
      enabled
      placeholder="Say something to this agent"
      sendLabel="Send"
      busy={false}
      onSubmit={() => {}}
      {...overrides}
    />
  );
}

/**
 * The agent log, mounted whole. The composer's placement is a claim about the
 * screen a person actually opens, so the screen is what renders it: a claim
 * proved only against the component in isolation would survive a screen that
 * never puts it on the tree.
 */
function sessionScreen(overrides: Partial<React.ComponentProps<typeof SessionScreen>> = {}): React.JSX.Element {
  return (
    <SessionScreen
      agent={{
        id: "agt_probe",
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
      {...overrides}
    />
  );
}

function terminalScreen(): React.JSX.Element {
  return (
    <TerminalSessionScreen
      title="session s-tui"
      cwd="/alpha"
      status="live-tui"
      promptAccess="granted"
      tui={tuiSessionFor(emptyConsole([]), "s-tui")}
      load={{ phase: "ready", generation: 0, error: null }}
      connection="connected"
      onBack={() => {}}
      onLoadEarlier={() => {}}
      onSubmit={() => {}}
    />
  );
}

/**
 * Every composer this app renders, by the prefix its controls carry. A new
 * one that does not appear here is a placement nobody is checking, which is
 * how the band above the field survived as long as it did.
 */
const COMPOSERS: ReadonlyArray<{ what: string; prefix: string; mount: () => Mounted }> = [
  { what: "the agent log's composer", prefix: "composer", mount: () => mount(sessionScreen()) },
  { what: "the terminal composer", prefix: "terminal-composer", mount: () => mount(terminalScreen()) },
];

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

describe("a composer puts its gestures in one row under the words", () => {
  for (const { what, prefix, mount: open } of COMPOSERS) {
    test(`${what} lays the field out above the action row, inside one surface`, () => {
      const m = open();
      try {
        const surface = m.need(`${prefix}-surface`);
        expect(surface.contains(m.need(`${prefix}-input`))).toBe(true);
        expect(surface.contains(m.need(`${prefix}-actions`))).toBe(true);
        // The words first. A row of gestures above the field is the defect
        // this whole file exists for.
        expect(m.precedes(`${prefix}-input`, `${prefix}-actions`)).toBe(true);
      } finally {
        m.unmount();
      }
    });

    test(`${what} keeps the paperclip at the row's left end and send at its right`, () => {
      const m = open();
      try {
        const row = m.need(`${prefix}-actions`);
        // Two ends and nothing between them: the row's own children are the
        // two groups, so no control can be dropped in loose and drift.
        expect(childIDs(row)).toEqual([`${prefix}-actions-left`, `${prefix}-actions-right`]);
        expect(m.need(`${prefix}-actions-left`).contains(m.need(`${prefix}-attach`))).toBe(true);
        expect(m.need(`${prefix}-actions-right`).contains(m.need(`${prefix}-send`))).toBe(true);
        expect(m.precedes(`${prefix}-attach`, `${prefix}-send`)).toBe(true);
      } finally {
        m.unmount();
      }
    });

    test(`${what} renders that row as one row with its ends apart`, () => {
      const m = open();
      try {
        // Read from the sheet react-native-web emitted, so a StyleSheet entry
        // that is written but never applied fails here rather than passing on
        // the strength of its own source text.
        const row = renderedStyle(m.need(`${prefix}-actions`));
        expect(row).toContain("flex-direction:row");
        expect(row).toContain("justify-content:space-between");
        // Both ends are rows too, so a group with two controls in it lays them
        // side by side rather than stacking them into a 88-point column.
        expect(renderedStyle(m.need(`${prefix}-actions-left`))).toContain("flex-direction:row");
        expect(renderedStyle(m.need(`${prefix}-actions-right`))).toContain("flex-direction:row");
      } finally {
        m.unmount();
      }
    });

    test(`${what} gives the paperclip a finger-sized target and says what it does`, () => {
      const m = open();
      try {
        const attach = m.need(`${prefix}-attach`);
        // 44 points is the floor on iOS and iPadOS, and the paperclip carries
        // no visible label, so the square itself is the whole target.
        const style = renderedStyle(attach);
        expect(style).toContain("min-height:44px");
        expect(style).toContain("min-width:44px");
        // An icon-only control has to name itself, and it must name what the
        // picker really offers rather than what a paperclip usually implies.
        expect(attach.getAttribute("aria-label")).toBe("Attach an image to this prompt");
      } finally {
        m.unmount();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Grouping on the right
// ---------------------------------------------------------------------------

describe("everything that acts on the prompt is grouped at the row's right end", () => {
  test("the agent log's microphone, config, and send share the one group, in that order", () => {
    const m = mount(sessionScreen());
    try {
      const right = m.need("composer-actions-right");
      expect(childIDs(right)).toEqual(["session-open-config", "composer-mic", "composer-send"]);
      // And nothing belonging to the row is left outside it: the microphone
      // used to be a band of its own two levels up the tree.
      expect(m.need("composer-actions").contains(m.need("composer-mic"))).toBe(true);
    } finally {
      m.unmount();
    }
  });

  test("the microphone's prose stays out of the row, between the words and it", () => {
    const m = mount(sessionScreen());
    try {
      // A refusal is a sentence and the row is 44 points of controls, so the
      // status lives in the column above the row, never in it.
      expect(m.need("composer-actions").contains(m.need("composer-mic-status"))).toBe(false);
      expect(m.precedes("composer-input", "composer-mic-status")).toBe(true);
      expect(m.precedes("composer-mic-status", "composer-actions")).toBe(true);
    } finally {
      m.unmount();
    }
  });

  test("a terminal has no interrupt, so its right group is send alone", () => {
    const m = mount(terminalScreen());
    try {
      expect(childIDs(m.need("terminal-composer-actions-right"))).toEqual(["terminal-composer-send"]);
      expect(m.find("terminal-composer-cancel")).toBeNull();
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The turn changing state must not move anything
// ---------------------------------------------------------------------------

describe("the send becoming an interrupt moves nothing else", () => {
  test("Stop takes send's place in the right group and the paperclip stays put", () => {
    const m = mount(composer({ busy: true, onCancel: () => {} }));
    try {
      expect(childIDs(m.need("composer-actions-right"))).toEqual(["composer-cancel"]);
      expect(m.find("composer-send")).toBeNull();
      // The whole point: a control that migrates when the turn state changes
      // teaches an operator nothing they can rely on.
      expect(childIDs(m.need("composer-actions-left"))).toEqual(["composer-attach"]);
      expect(m.precedes("composer-attach", "composer-cancel")).toBe(true);
    } finally {
      m.unmount();
    }
  });

  test("a busy agent still lets an image be attached, because the next prompt is being composed", () => {
    const m = mount(composer({ busy: true, onCancel: () => {} }));
    try {
      expect(m.need("composer-attach").getAttribute("aria-disabled")).not.toBe("true");
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The control still does its job from its new place
// ---------------------------------------------------------------------------

describe("the paperclip is the same picker it always was", () => {
  test("pressing it reaches the platform picker once, and the pick becomes a removable chip", async () => {
    const picked: PromptImage = { data: "AAAA", mimeType: "image/png" };
    let picks = 0;
    // Sentinel rather than null so the assertion below reads a number the
    // picker was actually handed, never an untouched default that happens to
    // match.
    let room = -1;
    const m = mount(
      composer({
        picker: {
          availability: { available: true },
          pick: async seats => {
            picks += 1;
            room = seats;
            return { images: [picked], refused: [] };
          },
        },
      }),
    );
    try {
      await act(async () => {
        m.need("composer-attach").click();
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      });

      // The seam is reached exactly once, and told how many seats are left,
      // which is the contract the picker's multi-select depends on.
      expect(picks).toBe(1);
      expect(room).toBe(MAX_PROMPT_IMAGES);
      // The chip is what an operator sees for a pick that landed, and it can
      // be taken back off.
      expect(m.find("composer-attachment-0")).not.toBeNull();
      m.press("composer-attachment-remove-0");
      expect(m.find("composer-attachment-0")).toBeNull();
    } finally {
      m.unmount();
    }
  });

  test("a build with no picker keeps the paperclip in the row, disabled, with the reason above it", () => {
    const m = mount(
      composer({
        picker: {
          availability: { available: false, reason: "this build has no photo picker module" },
          pick: async () => {
            throw new Error("unreachable");
          },
        },
      }),
    );
    try {
      // Still in the row, still at its left end: a vanished button reads as a
      // vanished feature.
      expect(childIDs(m.need("composer-actions-left"))).toEqual(["composer-attach"]);
      expect(m.need("composer-attach").getAttribute("aria-disabled")).toBe("true");
      expect(m.need("composer-attach-status").textContent).toContain("no photo picker module");
      expect(m.need("composer-actions").contains(m.need("composer-attach-status"))).toBe(false);
    } finally {
      m.unmount();
    }
  });
});
