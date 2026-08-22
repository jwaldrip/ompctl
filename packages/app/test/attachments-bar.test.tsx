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
const { AttachmentsBar } = await import("../src/components/AttachmentsBar.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  host: HTMLElement;
  root: Root;
  /** What the band has been told the prompt now carries. */
  images: PromptImage[][];
  /** How many times the control actually reached the picker. */
  picks: number;
  status(): string;
  press(): Promise<void>;
  unmount(): void;
}

function mount(picker: ImageAttachmentPicker, carried: PromptImage[] = []): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const images: PromptImage[][] = [];
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
      <AttachmentsBar
        picker={counted}
        images={carried}
        onImages={next => {
          images.push(next);
        }}
        enabled
        prefix="composer"
      />,
    );
  });

  const mounted: Mounted = {
    host,
    root,
    images,
    get picks() {
      return picks;
    },
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
      expect(mounted.images).toEqual([]);
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
      expect(mounted.images).toEqual([]);
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
      expect(mounted.images).toEqual([[fits]]);
      expect(mounted.status()).toContain("huge.jpg");
    } finally {
      mounted.unmount();
    }
  });
});
