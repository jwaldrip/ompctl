/**
 * Does the composer rebuilt on `ComposerPrimitive` still hold #131's contract?
 *
 * #131 was two defects, not one. The first was layout: the gestures belong in
 * one row under the words. The second was weight, and no layout assertion could
 * see it: a hairline rectangle for the field nested inside a hairline rectangle
 * for the composer, beside a boxed paperclip and three more equally boxed
 * widgets. Correct row, and the surface still read as a terminal control panel
 * rather than a message box.
 *
 * Rebuilding on a library is exactly where that regresses, because the library
 * supplies the controls and knows nothing about the rule. So every claim below
 * is read from the stylesheet react-native-web actually emitted, and every
 * expected value is derived from a design token rather than typed in as a
 * colour, so a token change moves the assertion with it.
 *
 * The other half of what is proven here is that the two-state action is the
 * *runtime's* claim rather than a prop. `OmpComposer` takes no `busy` and no
 * `onCancel`: every test below changes only the external store, and the control
 * that appears is whatever the runtime derived from it. That is the thing worth
 * a test, because a `busy` prop and a `thread.isRunning` read look identical on
 * screen and only one of them cannot drift from the daemon.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { AppendMessage, ExternalStoreAdapter } from "@assistant-ui/core";
import { MAX_PROMPT_IMAGES, type PromptImage } from "@ompd/core/contracts";
import type React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageAttachmentPicker, PickedAttachments } from "../src/platform/attachments.ts";

// Dynamic on purpose, the same reason every rendering test here does it: these
// modules import "react-native", and a static import is hoisted above
// `./rnw.ts`'s `mock.module` call, so the real native module table would be
// resolved before the web substitution is registered.
const { AssistantRuntimeProvider } = await import("@assistant-ui/react-native");
const { useOmpRuntime } = await import("../src/assistant/runtime.ts");
const { OmpComposer } = await import("../src/assistant/OmpComposer.tsx");
const { ground, radius, signal } = await import("../src/design/tokens.ts");
const { rhythm } = await import("../src/design/rhythm.ts");
const { WithOmpTheme } = await import("./theme.tsx");
const { StyleSheet } = await import("react-native");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// The store, and the composer standing on it
// ---------------------------------------------------------------------------

interface StoreOptions {
  /** A turn is in flight. Drives `thread.isRunning` and nothing else. */
  running?: boolean;
  /** This device cannot steer at all: no link, dead session, refused pane. */
  offline?: boolean;
  /** It may type, but the send is refused: a missing prompt scope. */
  sendRefused?: boolean;
  /**
   * Whether this surface can stop a running turn. Absent `onCancel` is what
   * makes `capabilities.cancel` false, which is the terminal composer's case.
   */
  cancellable?: boolean;
  /** Every message the runtime dispatched, in order. */
  dispatched?: AppendMessage[];
  /** How many times the runtime was asked to cancel. */
  cancels?: { count: number };
}

function store(options: StoreOptions = {}): ExternalStoreAdapter {
  const base: ExternalStoreAdapter = {
    messages: [],
    isRunning: options.running ?? false,
    isDisabled: options.offline ?? false,
    isSendDisabled: options.sendRefused ?? false,
    onNew: async message => {
      options.dispatched?.push(message);
    },
  };
  if (options.cancellable === false) return base;
  return {
    ...base,
    onCancel: async () => {
      if (options.cancels !== undefined) options.cancels.count += 1;
    },
  };
}

/**
 * A microphone with nothing to complain about: available, in scope, free, and
 * able to answer out loud. The idle case is the one the composer must stay
 * silent about, so it is the default.
 */
const READY_VOICE = {
  access: "granted",
  mic: { available: true },
  speech: { available: true },
  dictation: null,
  capturing: false,
  busyElsewhere: false,
  onToggle: () => {},
} as const;

const LIVE_PICKER: ImageAttachmentPicker = {
  availability: { available: true },
  pick: async (): Promise<PickedAttachments> => ({ images: [], refused: [] }),
};

function Composed(props: {
  store: ExternalStoreAdapter;
  composer?: Partial<React.ComponentProps<typeof OmpComposer>>;
}): React.JSX.Element {
  const runtime = useOmpRuntime(props.store);
  return (
    // The composer reads its colours off `useOmpTheme()` and its controls are
    // Paper's, so the provider is part of the surface under test rather than
    // scaffolding: without it Paper's own components fall back to Material's
    // palette, which is the one thing #131 must never render.
    <WithOmpTheme>
      <AssistantRuntimeProvider runtime={runtime}>
        <OmpComposer
          prefix="composer"
          picker={LIVE_PICKER}
          placeholder="Say something to this agent"
          sendLabel="Send"
          voice={{ ...READY_VOICE }}
          model="claude-opus-5 high"
          onOpenConfig={() => {}}
          {...props.composer}
        />
      </AssistantRuntimeProvider>
    </WithOmpTheme>
  );
}

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

function open(options: StoreOptions = {}, composer: Partial<React.ComponentProps<typeof OmpComposer>> = {}): Mounted {
  return mount(<Composed store={store(options)} composer={composer} />);
}

/**
 * `getSheet` is a react-native-web extension the package's own web build
 * publishes and its types do not: static StyleSheet values compile to atomic
 * classes whose declarations live in one injected sheet rather than in the
 * markup. Same cast the other composer tests make, for the same reason.
 */
const rnwStyleSheet = StyleSheet as unknown as { getSheet: () => { textContent: string } };

/**
 * Everything one element's own style actually says, from both places
 * react-native-web puts it.
 *
 * Only `StyleSheet.create` values are compiled into the atomic sheet.
 * Anything built at render time -- which is every colour, now that the
 * composer reads them off `useOmpTheme()` -- is written to the element's own
 * `style` attribute instead. Reading the sheet alone made this "what did the
 * element render statically", which is not the claim any test here makes. The
 * inline half is whitespace-stripped so `background-color: rgba(36, 33, 27,
 * 1.00)` matches the sheet's own `background-color:rgba(36,33,27,1.00)`.
 */
function renderedStyle(element: HTMLElement): string {
  const classes = element.className.split(/\s+/).filter(name => name.length > 0);
  const fromSheet = rnwStyleSheet
    .getSheet()
    .textContent.split("\n")
    .filter(rule => classes.some(name => new RegExp(`\\.${name}(?=$|[\\s.#\\[:{])`).test(rule)))
    .join("\n");
  return `${fromSheet}\n${(element.getAttribute("style") ?? "").replace(/\s+/g, "")}`;
}

/** Every element inside `root` whose own rules contain `declaration`. */
function inside(root: HTMLElement, declaration: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("*")].filter(element => renderedStyle(element).includes(declaration));
}

/** What a testID says about an element, for a readable failure. */
function idsOf(elements: HTMLElement[]): (string | null)[] {
  return elements.map(element => element.getAttribute("data-testid"));
}

const rgba = (hex: string): string => {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},1.00)`;
};

/**
 * Drives the primitive's `TextInput` through the same `onChange` the DOM would,
 * which is the only way to move a controlled RN field from a test. Copied in
 * shape from `composer-submit.test.tsx`, which drives the shipped field for its
 * own reason.
 */
function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  if (typeof props.onChange !== "function") throw new Error("the rendered input has no onChange handler");
  (input as HTMLTextAreaElement).value = value;
  props.onChange({
    target: input,
    currentTarget: input,
    nativeEvent: { text: value },
    preventDefault: () => {},
    stopPropagation: () => {},
  });
}

/** One macrotask, so a picker promise and the store notification it causes land. */
async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}

const PIXEL: PromptImage = { data: "AAAA", mimeType: "image/png" };

// ---------------------------------------------------------------------------
// One surface
// ---------------------------------------------------------------------------

describe("the composer is one rounded box and nothing inside it is a second one", () => {
  test("the surface owns the fill, the only border, and the object radius", () => {
    const m = open();
    try {
      const surface = renderedStyle(m.need("composer-surface"));
      expect(surface).toContain(`background-color:${rgba(ground.raised)}`);
      expect(surface).toContain("border-top-width:1px");
      expect(surface).toContain(`border-top-left-radius:${radius.surface}px`);
    } finally {
      m.unmount();
    }
  });

  test("no descendant of the surface draws a border at all", () => {
    const m = open();
    try {
      // Every element inside, not the three the original proof happened to
      // name: the library supplies the controls now, so a hairline arriving on
      // one of them is precisely the regression this has to catch. `Composer`
      // fails this the moment the field gets its edge back, which is the defect
      // #131 exists to have fixed.
      expect(idsOf(inside(m.need("composer-surface"), "border-top-width:1px"))).toEqual([]);
    } finally {
      m.unmount();
    }
  });

  test("the field is borderless, transparent, and side-padded by the surface", () => {
    const m = open();
    try {
      const field = renderedStyle(m.need("composer-input"));
      expect(field).toContain("border-top-width:0px");
      // Transparent, so the surface's own fill runs behind the words.
      expect(field).toContain("background-color:rgba(0,0,0,0.00)");
      // Side padding belongs to the surface. A field that pads itself sits
      // inset from the container's edge and reads as a nested control.
      expect(field).toContain("padding-left:0px");
      // Still grows: the reason the row sits under the words rather than beside
      // them is that the words are allowed to take the height.
      expect(field).toContain("max-height:140px");
    } finally {
      m.unmount();
    }
  });

  test("an empty composer is the field and the row, with no band between them", () => {
    const m = open();
    try {
      expect(m.find("composer-attachments")).toBeNull();
      expect(m.find("composer-mic-status")).toBeNull();
      expect([...m.need("composer-surface").children]).toHaveLength(2);
    } finally {
      m.unmount();
    }
  });

  test("a chip is the one object inside the surface allowed an edge, at the control radius", async () => {
    const m = open(
      {},
      { picker: { availability: { available: true }, pick: async () => ({ images: [PIXEL], refused: [] }) } },
    );
    try {
      await act(async () => {
        m.need("composer-attach").click();
        await settle();
      });
      // The band's arrival does not license a second box anywhere else: the
      // chip is the only bordered descendant, and it wears the control radius
      // rather than the surface's.
      expect(idsOf(inside(m.need("composer-surface"), "border-top-width:1px"))).toEqual(["composer-attachment-0"]);
      expect(renderedStyle(m.need("composer-attachment-0"))).toContain(`border-top-left-radius:${radius.control}px`);
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The air around it, in the vocabulary the whole app spends
// ---------------------------------------------------------------------------

/**
 * The report was "spacing looks off", and the composer is where it was most
 * visible: the dock paid 12 horizontally while the header and the readout
 * above it paid 16, so the message box started four points left of everything
 * it sat under, on every screen that renders one.
 *
 * Both numbers below are read off the sheet react-native-web actually emitted
 * and both are named against `rhythm`, never typed in. A literal that happens
 * to equal today's value passes nothing here: move `gutter` or `dockPad` and
 * this fails until the dock follows, which is the whole point of a scale whose
 * entries are jobs.
 */
describe("the composer's dock spends the app's spacing vocabulary", () => {
  test("the surface is inset by the screen gutter and floats above the edge by the dock pad", () => {
    const m = open();
    try {
      // The dock is the view that pays the margin around the box, so the
      // surface's own inset from the screen edge is its padding.
      const dock = renderedStyle(m.need("composer-dock"));
      expect(dock).toContain(`padding-left:${rhythm.gutter}px`);
      expect(dock).toContain(`padding-right:${rhythm.gutter}px`);
      // Deliberately snug rather than a full gutter: the home indicator
      // already reserves its own space below this.
      expect(dock).toContain(`padding-bottom:${rhythm.dockPad}px`);
      // And it really is the box's parent, so the inset above is the one the
      // surface pays rather than some other view's.
      expect(m.need("composer-dock").contains(m.need("composer-surface"))).toBe(true);
    } finally {
      m.unmount();
    }
  });

  test("the bands stacked inside the surface are one rowGapTight apart", () => {
    const m = open();
    try {
      // A chip band, a refusal and the action row all belong to the words
      // above them, which is the job `rowGapTight` names.
      expect(renderedStyle(m.need("composer-surface"))).toContain(`gap:${rhythm.rowGapTight}px`);
    } finally {
      m.unmount();
    }
  });

  test("every control in the action row clears the 44-point floor", () => {
    const m = open({ running: true }, { voice: { ...READY_VOICE } });
    try {
      // The interrupt, not the send, because a turn is in flight: the two wear
      // one geometry and this is the half the idle cases never see.
      for (const id of ["composer-attach", "composer-mic", "session-open-config", "composer-cancel"]) {
        const control = renderedStyle(m.need(id));
        const floor = `${rhythm.minTarget}px`;
        expect(control.includes(`height:${floor}`) || control.includes(`min-height:${floor}`)).toBe(true);
      }
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// One emphasis
// ---------------------------------------------------------------------------

describe("one filled control, three ghosts", () => {
  test("the paperclip, the microphone and the model are targets without cages", () => {
    const m = open();
    try {
      for (const id of ["composer-attach", "composer-mic", "session-open-config"]) {
        const control = renderedStyle(m.need(id));
        expect(control).toContain(`border-top-left-radius:${radius.control}px`);
        expect(control).not.toContain("border-top-width:1px");
        // No fill of its own. react-native-web's base view class declares a
        // transparent background for every View, so the check is for the two
        // fills that would make a ghost compete with send, not for the absence
        // of the property.
        expect(control).not.toContain(`background-color:${rgba(ground.active)}`);
        expect(control).not.toContain(`background-color:${rgba(signal.sage)}`);
      }
    } finally {
      m.unmount();
    }
  });

  test("send is the only round control on the surface, and it is filled", () => {
    const m = open();
    try {
      const pills = inside(m.need("composer-surface"), `border-top-left-radius:${radius.pill}px`);
      expect(idsOf(pills)).toEqual(["composer-send"]);
      // Held, because nothing has been typed: visible, unmistakably not ready,
      // and still filled rather than vanished.
      expect(renderedStyle(m.need("composer-send"))).toContain(`background-color:${rgba(ground.active)}`);
    } finally {
      m.unmount();
    }
  });

  test("a draft turns the send disc accent-filled and nothing else changes weight", () => {
    const m = open();
    try {
      act(() => {
        typeInto(m.need("composer-input"), "ready to go");
      });
      expect(renderedStyle(m.need("composer-send"))).toContain(`background-color:${rgba(signal.sage)}`);
      expect(renderedStyle(m.need("composer-attach"))).not.toContain(`background-color:${rgba(signal.sage)}`);
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The two-state action, from the runtime
// ---------------------------------------------------------------------------

describe("the action is send or interrupt, and the runtime decides which", () => {
  test("idle, it is a send", () => {
    const m = open();
    try {
      expect(m.find("composer-send")).not.toBeNull();
      expect(m.find("composer-cancel")).toBeNull();
    } finally {
      m.unmount();
    }
  });

  test("a turn in flight on a surface that can stop it replaces send with the interrupt", () => {
    const cancels = { count: 0 };
    // The only thing that changed is the store. `OmpComposer` was passed no
    // `busy` and no `onCancel`, so this can only have come from
    // `composer.canCancel`, which is the runtime's own
    // `capabilities.cancel && isRunning`.
    const m = open({ running: true, cancels });
    try {
      expect(m.find("composer-send")).toBeNull();
      const stop = m.need("composer-cancel");
      // Same geometry in the same slot, so no control moves when a turn starts.
      const geometry = renderedStyle(stop);
      expect(geometry).toContain(`border-top-left-radius:${radius.pill}px`);
      expect(geometry).toContain("width:44px");
      // Filled in the failure colour rather than boxed in it.
      expect(geometry).toContain(`background-color:${rgba(signal.oxide)}`);
      // And it really is wired to the store's cancel.
      m.press("composer-cancel");
      expect(cancels.count).toBe(1);
    } finally {
      m.unmount();
    }
  });

  test("a turn in flight on a surface that cannot stop it keeps the send a send", () => {
    // No `onCancel` on the store, which is what makes `capabilities.cancel`
    // false. Prompting mid-turn here is a steer, not a second instruction, so
    // holding the send would refuse the one thing the operator can still do.
    // The library's own send predicate holds every send while the thread is
    // running; this passing is the proof that the explicit gate overrides it.
    const m = open({ running: true, cancellable: false });
    try {
      expect(m.find("composer-cancel")).toBeNull();
      const send = m.need("composer-send");
      act(() => {
        typeInto(m.need("composer-input"), "steer it");
      });
      expect(send.getAttribute("aria-disabled")).not.toBe("true");
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

describe("what the operator composed is what the runtime dispatches", () => {
  test("typing then pressing send reaches the store's onNew with that text", async () => {
    const dispatched: AppendMessage[] = [];
    const m = open({ dispatched });
    try {
      act(() => {
        typeInto(m.need("composer-input"), "pineapple-aui-nonce");
      });
      await act(async () => {
        m.need("composer-send").click();
        await settle();
      });

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.role).toBe("user");
      expect(dispatched[0]?.content).toEqual([{ type: "text", text: "pineapple-aui-nonce" }]);
      // Cleared with the words, by the runtime rather than by this component.
      expect((m.need("composer-input") as HTMLTextAreaElement).value).toBe("");
    } finally {
      m.unmount();
    }
  });

  test("an image-only prompt is as sendable as a text-only one, and the image rides out", async () => {
    const dispatched: AppendMessage[] = [];
    const m = open(
      { dispatched },
      { picker: { availability: { available: true }, pick: async () => ({ images: [PIXEL], refused: [] }) } },
    );
    try {
      await act(async () => {
        m.need("composer-attach").click();
        await settle();
      });
      // Nothing typed. The send is live anyway, which is only true because the
      // image landed in the runtime's own composer: `canSend` reads
      // `composer.isEmpty`, which reads `composer.attachments`.
      expect(m.need("composer-send").getAttribute("aria-disabled")).not.toBe("true");

      await act(async () => {
        m.need("composer-send").click();
        await settle();
      });

      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.content).toEqual([]);
      expect(dispatched[0]?.attachments).toHaveLength(1);
      expect(dispatched[0]?.attachments?.[0]).toMatchObject({
        type: "image",
        contentType: "image/png",
        content: [{ type: "image", image: "data:image/png;base64,AAAA" }],
      });
      // The chips clear with the words, and by the runtime rather than by this
      // component: a prompt that has gone is not still carrying anything.
      expect(m.find("composer-attachment-0")).toBeNull();
      expect(m.need("composer-send").getAttribute("aria-disabled")).toBe("true");
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

describe("the paperclip is the same picker it always was", () => {
  test("pressing it reaches the platform seam once, and the pick becomes a removable chip", async () => {
    let picks = 0;
    // Sentinel rather than null so the assertion below reads a number the
    // picker was actually handed, never an untouched default that matches.
    let room = -1;
    const m = open(
      {},
      {
        picker: {
          availability: { available: true },
          pick: async seats => {
            picks += 1;
            room = seats;
            return { images: [PIXEL], refused: [] };
          },
        },
      },
    );
    try {
      await act(async () => {
        m.need("composer-attach").click();
        await settle();
      });

      // The seam is reached exactly once, and told how many seats are left,
      // which is the contract the picker's multi-select depends on.
      expect(picks).toBe(1);
      expect(room).toBe(MAX_PROMPT_IMAGES);
      expect(m.find("composer-attachment-0")).not.toBeNull();
      expect(m.need("composer-attachment-remove-0").getAttribute("aria-label")).toBe("Remove image 1");

      await act(async () => {
        m.need("composer-attachment-remove-0").click();
        await settle();
      });
      expect(m.find("composer-attachment-0")).toBeNull();
      // And the runtime agrees the prompt is empty again, so the send goes
      // back to held. A chip removed from the view but left in the store would
      // pass the line above and fail this one.
      expect(m.need("composer-send").getAttribute("aria-disabled")).toBe("true");
    } finally {
      m.unmount();
    }
  });

  test("removing one of several leaves the rest in order, renumbered", async () => {
    const three: PromptImage[] = [
      { data: "AAAA", mimeType: "image/png" },
      { data: "BBBB", mimeType: "image/jpeg" },
      { data: "CCCC", mimeType: "image/webp" },
    ];
    const m = open(
      {},
      { picker: { availability: { available: true }, pick: async () => ({ images: three, refused: [] }) } },
    );
    try {
      await act(async () => {
        m.need("composer-attach").click();
        await settle();
      });
      expect(m.find("composer-attachment-2")).not.toBeNull();

      await act(async () => {
        m.need("composer-attachment-remove-0").click();
        await settle();
      });

      // Two left, at positions 0 and 1, and the survivors are the second and
      // third images in their original order. This is the assertion the whole
      // add-and-remove path lives or dies on: the runtime's attachments are
      // rebuilt wholesale on every change, so a reconcile that dropped the
      // wrong one, reversed them, or renumbered them out of step would pass
      // every count and fail this.
      expect(m.find("composer-attachment-2")).toBeNull();
      const thumbs = [...m.host.querySelectorAll<HTMLImageElement>("[data-testid^='composer-attachment-'] img")];
      expect(thumbs).toHaveLength(2);
      expect(thumbs.map(thumb => thumb.getAttribute("src"))).toEqual([
        "data:image/jpeg;base64,BBBB",
        "data:image/webp;base64,CCCC",
      ]);
    } finally {
      m.unmount();
    }
  });

  test("a prompt carrying every image the wire allows holds the paperclip and says why", async () => {
    const full: PromptImage[] = Array.from({ length: MAX_PROMPT_IMAGES }, (_, at) => ({
      data: `AAA${at}`,
      mimeType: "image/png",
    }));
    let picks = 0;
    const m = open(
      {},
      {
        picker: {
          availability: { available: true },
          pick: async () => {
            picks += 1;
            return { images: full, refused: [] };
          },
        },
      },
    );
    try {
      await act(async () => {
        m.need("composer-attach").click();
        await settle();
      });
      expect(picks).toBe(1);
      // The count budget binds against what the runtime actually holds, which
      // is only true because the band's `images` are derived from
      // `composer.attachments` rather than from a second local list.
      expect(m.need("composer-attach").getAttribute("aria-disabled")).toBe("true");
      expect(m.need("composer-attach-status").textContent).toContain("all the images the wire allows");
      m.press("composer-attach");
      expect(picks).toBe(1);
    } finally {
      m.unmount();
    }
  });

  test("a build with no picker keeps the paperclip in the row, disabled, with the reason above it", () => {
    const m = open(
      {},
      {
        picker: {
          availability: { available: false, reason: "this build has no photo picker module" },
          pick: async () => {
            throw new Error("unreachable");
          },
        },
      },
    );
    try {
      // Still in the row, still at its left end: a vanished button reads as a
      // vanished feature.
      expect(m.need("composer-actions-left").contains(m.need("composer-attach"))).toBe(true);
      expect(m.need("composer-attach").getAttribute("aria-disabled")).toBe("true");
      expect(m.need("composer-attach-status").textContent).toContain("no photo picker module");
      // The sentence lives above the row, not in it: a refusal is prose, not a
      // 44-point control.
      expect(m.need("composer-actions").contains(m.need("composer-attach-status"))).toBe(false);
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// The two gates are different
// ---------------------------------------------------------------------------

describe("a refused send is not a taken-away field", () => {
  test("a missing prompt scope leaves the field usable, refuses the send, and says why", () => {
    const m = open(
      { sendRefused: true },
      { refusal: "This device does not hold the prompt scope. Pair it again with prompt access." },
    );
    try {
      const input = m.need("composer-input") as HTMLTextAreaElement;
      // Usable: the operator can compose the prompt they are about to be told
      // they may not send.
      expect(input.readOnly).toBe(false);
      expect(input.disabled).toBe(false);
      act(() => {
        typeInto(input, "let me in");
      });
      // Refused anyway, and the refusal is on screen rather than left to a
      // press that does nothing.
      expect(m.need("composer-send").getAttribute("aria-disabled")).toBe("true");
      expect(m.need("composer-refusal").textContent).toContain("does not hold the prompt scope");
    } finally {
      m.unmount();
    }
  });

  test("no link takes the field away, which is the gate the refusal is not", () => {
    // The contrast that makes the assertion above mean something: `isDisabled`
    // is a different gate from `isSendDisabled`, and the field is where they
    // differ. `ComposerPrimitive.Input` reads neither on its own.
    const m = open({ offline: true }, { placeholder: "No link" });
    try {
      const input = m.need("composer-input") as HTMLTextAreaElement;
      expect(input.readOnly || input.disabled).toBe(true);
      expect(m.need("composer-send").getAttribute("aria-disabled")).toBe("true");
      // The microphone names the same refusal rather than disappearing.
      expect(m.need("composer-mic-status").textContent).toContain("No link");
      expect(m.need("composer-mic").getAttribute("aria-disabled")).toBe("true");
    } finally {
      m.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// Chrome is not content
// ---------------------------------------------------------------------------

describe("nothing sits on this surface permanently to explain a control", () => {
  test("an idle microphone on a healthy link says nothing on screen", () => {
    const m = open();
    try {
      expect(m.find("composer-mic-status")).toBeNull();
      expect(m.host.textContent ?? "").not.toContain("Tap to speak");
      // The control is still there and still named; only the sentence left. It
      // is the microphone's accessibility hint now, which react-native-web has
      // nowhere to put, so it is read off the device tree in the simulator
      // proof instead.
      expect(m.need("composer-mic").getAttribute("aria-label")).toBe("Speak to this agent");
    } finally {
      m.unmount();
    }
  });

  test("a live dictation appears while there is one, and the model control names the model", () => {
    const m = open({}, { voice: { ...READY_VOICE, capturing: true, dictation: { text: "ship it", final: false } } });
    try {
      expect(m.need("composer-dictation").textContent).toContain("ship it");
      expect(m.need("composer-mic-status").textContent).toContain("Recording");
      expect(m.need("session-model-label").textContent).toBe("claude-opus-5 high");
    } finally {
      m.unmount();
    }
  });

  test("told no model, the control names the surface it opens rather than inventing one", () => {
    const m = open({}, { model: null });
    try {
      expect(m.need("session-model-label").textContent).toBe("Config");
      expect(m.need("session-open-config").getAttribute("aria-label")).toBe("Open this session's mode and model");
    } finally {
      m.unmount();
    }
  });
});
