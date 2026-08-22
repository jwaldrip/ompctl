/**
 * The photo picker seam, driven by canned picker responses.
 *
 * The library is never launched here. What is under test is everything
 * between the OS handing back an asset and the wire accepting it, which is
 * where this seam was losing images: an iPhone names a JPEG `image/jpg`, the
 * wire spells it `image/jpeg`, and the mismatch used to end in a `continue`
 * that attached nothing and said nothing. A press that produces neither a
 * chip nor a sentence is indistinguishable from a dead button, so every
 * refusal here is asserted as words an operator could act on, not merely as
 * an absent image.
 *
 * The sizes are real measurements rather than round numbers: 1,691,036 is
 * what a 1206x2622 iOS screenshot encodes to as a PNG at the old 1600 pixel
 * setting, which is the case that first went missing.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { MAX_PROMPT_IMAGE_BASE64_CHARS, PROMPT_IMAGE_REFUSAL_REASONS } from "@ompd/core/contracts";
import type { ImageLibraryOptions, ImagePickerResponse } from "react-native-image-picker";
import type { ImageAttachmentPicker } from "../src/platform/attachments.ts";

// Loaded after `./rnw.ts` on purpose, and this is the one thing a static
// import cannot express: the seam imports `react-native-image-picker`, whose
// native module table resolves at import time and is a ReferenceError under
// bun, so the module has to be evaluated after `rnw.ts` has installed the
// stub. A static import would hoist above it. The type import above is
// erased, so it costs no evaluation.
const { createImageAttachmentPicker } = await import("../src/platform/attachments.ts");

/** Comfortably inside the ceiling, and valid base64, which the wire checks. */
const FITS = "A".repeat(1000);

/** A real 1206x2622 iOS screenshot, resized to a 1600 pixel edge and kept as PNG. */
const REAL_SCREENSHOT_PNG_CHARS = 1_691_036;

/** One canned picker response, plus whatever options the seam asked for. */
function scripted(response: ImagePickerResponse): { picker: ImageAttachmentPicker; asked: ImageLibraryOptions[] } {
  const asked: ImageLibraryOptions[] = [];
  const picker = createImageAttachmentPicker(async options => {
    asked.push(options);
    return response;
  });
  return { picker, asked };
}

describe("picking images for a prompt", () => {
  test("a JPEG picked on an iPhone attaches, under the spelling the wire uses", async () => {
    // iOS builds the type as `image/` plus a sniffed extension, so a photo
    // arrives as `image/jpg`. That is not in `PROMPT_IMAGE_MIME_TYPES`, and
    // before the seam translated it every iPhone photo was silently dropped.
    const { picker } = scripted({
      assets: [{ base64: FITS, type: "image/jpg", fileName: "IMG_0042.JPG" }],
    });

    const picked = await picker.pick(4);

    expect(picked.refused).toEqual([]);
    expect(picked.images).toEqual([{ data: FITS, mimeType: "image/jpeg" }]);
  });

  test("the picker is asked for a budget the measurements support", async () => {
    const { picker, asked } = scripted({ didCancel: true });

    await picker.pick(3);

    expect(asked).toHaveLength(1);
    const options = asked[0];
    expect(options?.includeBase64).toBe(true);
    // The room left on this prompt, so the OS multi-select cannot hand back a
    // batch the wire would refuse on arrival.
    expect(options?.selectionLimit).toBe(3);
    // Measured, not hoped: 1400 pixels at 0.7 encodes a real 4032x4032
    // photograph to 157,344 base64 characters and a real 1206x2622
    // screenshot to 169,996, both inside the ceiling. The 1600 and 0.8 this
    // replaces measured 392,660 characters on that screenshot, over the
    // ceiling by 42,660, which is the defect this asserts against.
    expect(options?.maxWidth ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1400);
    expect(options?.maxHeight ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1400);
    expect(options?.quality ?? 1).toBeLessThanOrEqual(0.7);
  });

  test("an image over the ceiling is refused with what it measured, and nothing is attached", async () => {
    const { picker } = scripted({
      assets: [
        {
          base64: "A".repeat(REAL_SCREENSHOT_PNG_CHARS),
          type: "image/png",
          fileName: "screenshot.png",
        },
      ],
    });

    const picked = await picker.pick(4);

    expect(picked.images).toEqual([]);
    expect(picked.refused).toHaveLength(1);
    const said = picked.refused[0] ?? "";
    expect(said).toContain("screenshot.png");
    // The measurement and the ceiling, because "too large" without a number
    // leaves nobody knowing whether to crop a little or give up.
    expect(said).toContain("1.3 MB");
    expect(said).toContain("263 KB");
    // And why the quality lever did not save it, which is the difference
    // between retrying the same screenshot forever and attaching a photo.
    expect(said).toContain("PNG is stored losslessly");
  });

  test("a format the wire cannot carry is refused by name", async () => {
    const { picker } = scripted({
      assets: [{ base64: FITS, type: "image/bmp", fileName: "scan.bmp" }],
    });

    const picked = await picker.pick(4);

    expect(picked.images).toEqual([]);
    expect(picked.refused).toEqual([`scan.bmp was not attached: ${PROMPT_IMAGE_REFUSAL_REASONS.bad_mime}`]);
  });

  test("an asset the picker returned no data for is named rather than skipped", async () => {
    const { picker } = scripted({
      assets: [{ type: "image/png", fileName: "live-photo.png" }],
    });

    const picked = await picker.pick(4);

    expect(picked.images).toEqual([]);
    expect(picked.refused).toEqual(["live-photo.png was not attached: the picker returned no image data for it."]);
  });

  test("a batch attaches what fits and names what does not", async () => {
    const { picker } = scripted({
      assets: [
        { base64: FITS, type: "image/png", fileName: "small.png" },
        {
          base64: "A".repeat(MAX_PROMPT_IMAGE_BASE64_CHARS + 1),
          type: "image/jpg",
          fileName: "huge.jpg",
        },
      ],
    });

    const picked = await picker.pick(4);

    expect(picked.images).toEqual([{ data: FITS, mimeType: "image/png" }]);
    expect(picked.refused).toHaveLength(1);
    expect(picked.refused[0]).toContain("huge.jpg");
  });

  test("assets past the room this prompt has left are named rather than truncated", async () => {
    const { picker } = scripted({
      assets: [
        { base64: FITS, type: "image/png", fileName: "first.png" },
        { base64: FITS, type: "image/png", fileName: "second.png" },
      ],
    });

    const picked = await picker.pick(1);

    expect(picked.images).toHaveLength(1);
    expect(picked.refused).toEqual([`second.png was not attached: ${PROMPT_IMAGE_REFUSAL_REASONS.too_many}`]);
  });

  test("a cancelled pick is not a refusal", async () => {
    const { picker } = scripted({ didCancel: true });

    expect(await picker.pick(4)).toEqual({ images: [], refused: [] });
  });

  test("a build without the native module names the missing capability", async () => {
    const picker = createImageAttachmentPicker(undefined);

    expect(picker.availability.available).toBe(false);
    const reason = picker.availability.available ? "" : picker.availability.reason;
    expect(reason).toContain("no photo picker module");
    // A pick that resolved empty here would look exactly like a cancel.
    expect(picker.pick(4)).rejects.toThrow("no photo picker is available on this platform");
  });
});
