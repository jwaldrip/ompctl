/**
 * The photo library seam: where a prompt's images come from.
 *
 * React Native ships no image picker, and nothing else this app installs is
 * one: `react-native-vision-camera` is a camera surface (capture, permissions,
 * and a UI this app would have to build and verify itself), and the webview,
 * view-shot, and QR libraries are unrelated. `react-native-image-picker` is
 * the community module for exactly this gesture: it presents the OS photo
 * picker (PHPicker on iOS, the Android Photo Picker), needs no photo-library
 * permission for selection, converts HEIC to JPEG when asked, and can hand
 * back base64, which is the wire's own shape.
 *
 * The seam exists because "present in the bundle" and "usable here" are
 * different facts. The library links on iOS and Android; a target where its
 * native module is absent (macOS and Windows today) must say so by name
 * rather than render a button that throws when pressed. Availability is
 * probed through the same lookup the library itself uses, so the seam cannot
 * claim a module the next call would miss.
 *
 * `attachments.web.ts` is this file's counterpart for the web target; see
import { MAX_PROMPT_IMAGES, parsePromptImages, type PromptImage } from "@ompd/core/contracts";
import { launchImageLibrary, type ImageLibraryOptions, type ImagePickerResponse } from "react-native-image-picker";

/** Same shape as the memo voice seam: a named state, never a silent absence. */
export type AttachmentAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * The one operation the composer needs: pick images from the device library.
 * `room` is how many more images this prompt can still take, so the picker's
 * own multi-select cannot hand back a batch the wire would immediately refuse.
 */
export interface ImageAttachmentPicker {
  readonly availability: AttachmentAvailability;
  pick(room: number): Promise<PromptImage[]>;
}

/** The library's launch function, injectable so tests never open a real picker. */
export type LaunchImageLibrary = (options: ImageLibraryOptions) => Promise<ImagePickerResponse>;

/**
 * Picking options chosen to land under the wire budgets on their own: a
 * 1600-pixel edge and 0.8 quality re-encodes a phone photo to a few hundred
 * kilobytes, well inside `MAX_PROMPT_IMAGE_BASE64_CHARS`. The ceiling is
 * still enforced by bytes on both ends, because "usually small enough" is
 * not a budget.
 */
const PICK_OPTIONS: ImageLibraryOptions = {
  mediaType: "photo",
  includeBase64: true,
  maxWidth: 1600,
  maxHeight: 1600,
  quality: 0.8,
  // HEIC is not a MIME the agent accepts; "compatible" asks iOS to hand back
  // JPEG instead, so a default iPhone screenshot does not become a refusal.
  assetRepresentationMode: "compatible",
};

/**
 * Whether the picker's native module is linked. Every native target this app
 * ships runs the new architecture (`RCTNewArchEnabled`), where the module
 * table hangs off the turbo proxy the library itself dispatches through, so
 * that proxy is the probe. `react-native` is deliberately not imported here:
 * react-native-web does not export `TurboModuleRegistry`, and a binding that
 * is missing on one host is a load-time crash there. A missing module is
 * `undefined`, the named-unavailable state, not an error to guess about.
 */
export function probeImagePickerModule(): unknown {
  const proxy = (globalThis as { __turboModuleProxy?: (name: string) => unknown }).__turboModuleProxy;
  try {
    const turbo = proxy?.("ImagePicker");
    if (turbo !== null && turbo !== undefined) return turbo;
  } catch {
    // A host whose proxy refuses the name is a host without the module.
  }
  return undefined;
}

/**
 * Bind picking to one optional native module, memo-voice style: unavailable
 * is a named state with a refusal that throws, never a press that does
 * nothing.
 */
export function createImageAttachmentPicker(launch: LaunchImageLibrary | undefined): ImageAttachmentPicker {
  if (launch === undefined) {
    return {
      availability: {
        available: false,
        reason: "Image attachments are unavailable here: this build has no photo picker module.",
      },
      // Never reached from the composer, which renders the unavailable state
      // first. Rejecting keeps the seam honest for a caller that probes late:
      // a pick that never returns would hang a composer, not quiet it.
      pick: async () => {
        throw new Error("no photo picker is available on this platform");
      },
    };
  }

  return {
    availability: { available: true },
    pick: async room => {
      const response = await launch({ ...PICK_OPTIONS, selectionLimit: Math.max(1, room) });
      if (response.didCancel) return [];
      if (response.errorCode !== undefined) {
        throw new Error(`the photo picker refused: ${response.errorCode}`);
      }
      // Assets without base64 (a video, a picker quirk) are skipped by name
      // rather than sent as empty data: an empty image block is a turn the
      // agent would spend on a decode error.
      const images: PromptImage[] = [];
      for (const asset of response.assets ?? []) {
        if (typeof asset.base64 !== "string" || asset.base64.length === 0) continue;
        const mimeType = (asset.type ?? "").toLowerCase();
        const checked = parsePromptImages([{ data: asset.base64, mimeType }]);
        if (checked.ok) images.push(...checked.images);
      }
      return images.slice(0, Math.max(0, Math.min(MAX_PROMPT_IMAGES, room)));
    },
  };
}

const probed = probeImagePickerModule();

/** The picker every platform gets: live where the module links, named otherwise. */
export const imageAttachmentPicker: ImageAttachmentPicker = createImageAttachmentPicker(
  probed === undefined ? undefined : launchImageLibrary,
);
