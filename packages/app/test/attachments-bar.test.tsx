/**
 * The attachments band, on a build that cannot pick and on one that can.
 *
 * Two failures this guards, and both look identical from the outside if the
 * band stays quiet: a target whose native picker is missing, and a pick the
 * wire refused. In either case the operator presses a button and no image
 * appears, so the band has to say which one happened. The unavailable case
 * keeps the control on screen, disabled, naming the capability, because a
 * vanished button reads as a vanished feature and gives nobody a way to tell
 * "this build cannot" apart from "that image was too big".
 *
 * Driven through `Composer`, which is the only thing that lays the band out.
 * The band is one state in two positions now, the paperclip in the composer's
 * action row and the chips and the sentence above it, so mounting the halves
 * on their own would prove a wiring this app does not ship. Where the pick
 * landed is read off the chips, which is what an operator actually sees.
 * `composer-actions.test.tsx` owns where the two positions are.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { PromptImage } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ImageAttachmentPicker, PickedAttachments } from "../src/platform/attachments.ts";

// Same reason as `attachments-pick.test.ts`: the seam pulls in
// `react-native-image-picker`, which resolves its native module table at
// import time, so it can only be evaluated after `rnw.ts` installs the stub.
const { createImageAttachmentPicker } = await import("../src/platform/attachments.ts");
const { Composer } = await import("../src/components/Composer.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  host: HTMLElement;
  root: Root;
  /** How many times the control actually reached the picker. */
  picks: number;
  /** The images this prompt now carries, read off the chips the operator sees. */
  chips(): number;
  status(): string;
  press(): Promise<void>;
  unmount(): void;
}

function mount(picker: ImageAttachmentPicker): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let picks = 0;

  const counted: ImageAttachmentPicker = {
    availability: picker.availability,
    pick: async room => {
      picks += 1;
      return picker.pick(room);
    },
  };

  act(() => {
    root.render(
      <Composer
        prefix="composer"
        picker={counted}
        enabled
        placeholder="Say something to this agent"
        sendLabel="Send"
        busy={false}
        onSubmit={() => {}}
      />,
    );
  });

  const mounted: Mounted = {
    host,
    root,
    get picks() {
      return picks;
    },
    chips: () => host.querySelectorAll('[data-testid^="composer-attachment-"]:not([data-testid*="remove"])').length,
    status: () => host.querySelector('[data-testid="composer-attach-status"]')?.textContent ?? "",
    press: async () => {
      const control = host.querySelector('[data-testid="composer-attach"]') as HTMLElement | null;
      if (control === null) throw new Error("the attach control is not on screen");
      await act(async () => {
        control.click();
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
  return mounted;
}

describe("the attachments band", () => {
  test("a build with no picker keeps the control and names the missing capability", async () => {
    const mounted = mount(createImageAttachmentPicker(undefined));
    try {
      // The control is still there. Removing it would leave the operator
      // with no way to learn that this build cannot attach at all.
      const control = mounted.host.querySelector('[data-testid="composer-attach"]');
      expect(control).not.toBeNull();
      expect(control?.getAttribute("aria-disabled")).toBe("true");
      expect(mounted.status()).toContain("no photo picker module");

      await mounted.press();

      // Pressing it reaches nothing and changes nothing, and the reason is
      // still on screen rather than replaced by a failure from a picker that
      // was never supposed to be called.
      expect(mounted.picks).toBe(0);
      expect(mounted.chips()).toBe(0);
      expect(mounted.status()).toContain("no photo picker module");
    } finally {
      mounted.unmount();
    }
  });

  test("a refusal from the seam reaches the operator instead of vanishing", async () => {
    const refusal =
      "screenshot.png was not attached: it is 1.3 MB after resizing, and one image can carry at most 263 KB.";
    const mounted = mount({
      availability: { available: true },
      pick: async (): Promise<PickedAttachments> => ({ images: [], refused: [refusal] }),
    });
    try {
      await mounted.press();

      expect(mounted.picks).toBe(1);
      expect(mounted.chips()).toBe(0);
      expect(mounted.status()).toBe(refusal);
    } finally {
      mounted.unmount();
    }
  });

  test("a partial batch attaches what fit and still says what did not", async () => {
    const fits: PromptImage = { data: "AAAA", mimeType: "image/png" };
    const mounted = mount({
      availability: { available: true },
      pick: async (): Promise<PickedAttachments> => ({
        images: [fits],
        refused: ["huge.jpg was not attached: it is 1.3 MB after resizing, and one image can carry at most 263 KB."],
      }),
    });
    try {
      await mounted.press();

      // The success must not swallow the refusal: an operator who picked two
      // images and got one chip has to be told which one did not make it.
      expect(mounted.chips()).toBe(1);
      expect(mounted.status()).toContain("huge.jpg");
    } finally {
      mounted.unmount();
    }
  });
});
