/**
 * The web build's answer to "pick an image for this prompt": not yet, by
 * name.
 *
 * The library this seam wraps does ship a web implementation, but it is a
 * file input reached through DOM the rest of this app never touches, and
 * shipping it here would mean claiming a capability nothing has verified on
 * this target. An honest named refusal today is worth more than an untested
 * control that might work: the operator sees exactly what is missing, on
 * which build, and a web picker can land later as its own verified slice.
 *
 * This is `.web.ts`, resolved the same way Metro resolves `.ios.tsx` and
 * Vite resolves it per `vite.config.ts`'s `resolve.extensions`, so a caller
 * importing `./attachments` gets this file's answer on the web target and
 * never loads the native library at all.
 */

import type { ImageAttachmentPicker, PickedAttachments } from "./attachments.ts";

export type { AttachmentAvailability, ImageAttachmentPicker, PickedAttachments } from "./attachments.ts";

export const imageAttachmentPicker: ImageAttachmentPicker = {
  availability: {
    available: false,
    reason: "Image attachments are unavailable on the web build: no photo picker is wired for this target yet.",
  },
  pick: async (): Promise<PickedAttachments> => {
    throw new Error("no photo picker is available on this platform");
  },
};
