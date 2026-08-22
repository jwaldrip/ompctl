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
 * there for why the web build names its absence rather than shipping the
 * library's DOM path.
 */

import {
  MAX_PROMPT_IMAGE_BASE64_CHARS,
  MAX_PROMPT_IMAGES,
  PROMPT_IMAGE_REFUSAL_REASONS,
  type PromptImage,
  type PromptImageRefusal,
  parsePromptImages,
} from "@ompd/core/contracts";
import { type ImageLibraryOptions, type ImagePickerResponse, launchImageLibrary } from "react-native-image-picker";

/** Same shape as the memo voice seam: a named state, never a silent absence. */
export type AttachmentAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

/**
 * What one pick gesture produced.
 *
 * Two lists rather than one, because an image the wire cannot carry is not
 * the same event as an image the operator did not choose. Dropping the
 * refusals would leave a press that returns nothing and explains nothing,
 * which reads as a broken button rather than as an image too big to send.
 */
export interface PickedAttachments {
  /** The images that fit, in pick order. */
  readonly images: PromptImage[];
  /** One readable sentence per image that cannot ride, in pick order. */
  readonly refused: string[];
}

/**
 * The one operation the composer needs: pick images from the device library.
 * `room` is how many more images this prompt can still take, so the picker's
 * own multi-select cannot hand back a batch the wire would immediately refuse.
 */
export interface ImageAttachmentPicker {
  readonly availability: AttachmentAvailability;
  pick(room: number): Promise<PickedAttachments>;
}

/** The library's launch function, injectable so tests never open a real picker. */
export type LaunchImageLibrary = (options: ImageLibraryOptions) => Promise<ImagePickerResponse>;

/**
 * What the picker is asked to produce, and what that does and does not
 * guarantee.
 *
 * Two levers, and they are not equal. `maxWidth`/`maxHeight` always bite:
 * both platforms scale an image to fit inside that box and never enlarge it
 * (`ImagePickerUtils.mm`'s `resizeImage`, `Utils.java`'s
 * `getImageDimensBasedOnConstraints`). `quality` bites for JPEG only. iOS
 * re-encodes a jpg through `UIImageJPEGRepresentation(quality)` but a png
 * through `UIImagePNGRepresentation`, which is lossless and ignores it
 * (`ImagePickerManager.mm`'s `mapImageToAsset`); Android hands a png to
 * `Bitmap.CompressFormat.PNG`, which ignores quality for the same reason;
 * and a gif on iOS is neither resized nor re-encoded at all. A phone
 * screenshot is a png, so for the most common attachment there is, dimension
 * is the whole story and quality is inert.
 *
 * These numbers are measured, not hoped. Against a real 4032x4032 photograph
 * and a real 1206x2622 iOS screenshot, 1400 pixels at quality 0.7 encodes to
 * 157,344 and 169,996 base64 characters, both inside
 * `MAX_PROMPT_IMAGE_BASE64_CHARS`. The 1600 and 0.8 this replaces measured
 * 392,660 characters on a real screenshot, over the ceiling by 42,660, so
 * the setting that was supposed to keep the common case safe was the one
 * that refused it.
 *
 * None of that is a guarantee, and this file no longer claims one: a JPEG's
 * size follows the picture rather than its dimensions, and the same
 * screenshot kept as a png fits at no legible size. There is no second pass
 * to fix that with. `launchCamera` and `launchImageLibrary` are the whole of
 * the library's surface (`src/index.ts`, and its turbo spec has the same two
 * methods), both present the OS picker, and both apply these options only to
 * the pass they run, so re-encoding what came back would mean asking the
 * operator to choose the photo a second time. So the budget is measured here
 * against what actually arrived, and whatever still does not fit is refused
 * by name.
 */
const PICK_OPTIONS: ImageLibraryOptions = {
  mediaType: "photo",
  includeBase64: true,
  maxWidth: 1400,
  maxHeight: 1400,
  quality: 0.7,
  // HEIC is not a MIME the agent accepts; "compatible" asks iOS to hand back
  // JPEG instead, and Android reads the same option to decide whether to keep
  // its own HEIC conversion on, so a default iPhone photo does not become a
  // refusal on either platform.
  assetRepresentationMode: "compatible",
};

/**
 * The library's spelling of a format, in the wire's vocabulary.
 *
 * iOS names the type by sniffing the first byte and appending the extension
 * it maps to, so every JPEG picked there arrives as `image/jpg`
 * (`ImagePickerManager.mm` sets `image/` plus `ImagePickerUtils.getFileType`,
 * which answers `jpg`). `PROMPT_IMAGE_MIME_TYPES` spells that format
 * `image/jpeg` and the daemon refuses anything else, so before this map every
 * photo picked on an iPhone was refused over the spelling of its name.
 * Android reads the real type from the content resolver and already says
 * `image/jpeg`. The quirk belongs at the platform seam, so that the wire's
 * vocabulary can stay exact.
 */
const MIME_ALIASES: Readonly<Record<string, string>> = { "image/jpg": "image/jpeg" };

/**
 * What to call one refused image, in a sentence a person reads.
 *
 * Android hands back the library's real display name, which is the best
 * label there is. iOS hands back nothing of the sort: PHPicker gives no
 * original filename, so the library invents one from a UUID
 * (`getImageFileName` in `ImagePickerManager.mm`), and a device pick really
 * does arrive as `526F90EE-1BD6-48A8-B9FA-B468104A80D9.png`. Reciting that
 * at an operator names nothing. Position is what they can actually match
 * against, because the chips beside this notice are positional too.
 */
function labelFor(fileName: string | undefined, position: number, picked: number): string {
  const generated = fileName === undefined || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\.\w+$/i.test(fileName);
  if (!generated) return fileName;
  return picked > 1 ? `Image ${position + 1}` : "That image";
}

/** base64 carries 3 bytes in every 4 characters, so this reads the wire's unit back as bytes. */
function humanSize(base64Chars: number): string {
  const bytes = (base64Chars * 3) / 4;
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.round(bytes / 1000)} KB`;
}

/**
 * Why one image is not riding, in words an operator can act on.
 *
 * The size case gets the measurement rather than the rule, because "too
 * large" without a number leaves nobody knowing whether to crop a little or
 * give up. A png also gets told why the picker's quality setting did not
 * save it, since that is the difference between an operator retrying with
 * the same screenshot forever and one attaching a photo instead.
 */
function refusalSentence(name: string, mimeType: string, base64Chars: number, refusal: PromptImageRefusal): string {
  if (refusal !== "too_large") return `${name} was not attached: ${PROMPT_IMAGE_REFUSAL_REASONS[refusal]}`;
  const lossless =
    mimeType === "image/png"
      ? " A PNG is stored losslessly, so the picker's quality setting cannot shrink it: crop it, or attach a photo rather than a screenshot."
      : "";
  return `${name} was not attached: it is ${humanSize(base64Chars)} after resizing, and one image can carry at most ${humanSize(MAX_PROMPT_IMAGE_BASE64_CHARS)}.${lossless}`;
}

/**
 * Whether the picker's native module is linked.
 *
 * This used to read `globalThis.__turboModuleProxy` and stop there, on the
 * theory that the new architecture hangs its whole module table off that
 * proxy. Run on a real iOS build, that is wrong. React Native 0.81
 * bridgeless reports `__turboModuleProxy` as `undefined`, `RN$Bridgeless`
 * and `RN$UnifiedNativeModuleProxy` as true, and the module itself present
 * at `nativeModuleProxy.ImagePicker`. The old probe therefore answered "no
 * picker" on the one platform this feature was written for, so the control
 * was disabled on every iPhone with the module sitting right there.
 *
 * What is mirrored here is the pair of roads `TurboModuleRegistry` walks in
 * `Libraries/TurboModule/TurboModuleRegistry.js`: the turbo proxy first, then
 * the legacy table, which bridgeless still answers from while the runtime
 * says the unified proxy is in play. `NativeModules` is `nativeModuleProxy`
 * whenever that global exists (`Libraries/BatchedBridge/NativeModules.js`),
 * which on a device it does.
 *
 * Mirrored rather than imported, and that is a real cost worth naming: this
 * seam has to agree with a registry it does not call. The alternative is
 * worse. `react-native` exposes `TurboModuleRegistry` through a CommonJS
 * getter that bun's module lexer cannot see, so a static named import is a
 * load-time `SyntaxError` under `bun test` even though Metro resolves it
 * fine, and the deep path pulls in the bridge at import time. Reading
 * globals is the one form that costs nothing on a host that has none of
 * them. A missing module is `undefined`, the named-unavailable state, not an
 * error to guess about.
 */
export function probeImagePickerModule(): unknown {
  // `globalThis` carries no type for React Native's module plumbing, and a
  // host outside React Native has none of these properties at all.
  const host = globalThis as {
    __turboModuleProxy?: (name: string) => unknown;
    nativeModuleProxy?: Record<string, unknown>;
    RN$Bridgeless?: boolean;
    RN$TurboInterop?: boolean;
    RN$UnifiedNativeModuleProxy?: boolean;
  };
  try {
    const turbo = host.__turboModuleProxy?.("ImagePicker");
    if (turbo !== null && turbo !== undefined) return turbo;
    const legacyServed =
      host.RN$Bridgeless !== true || host.RN$TurboInterop === true || host.RN$UnifiedNativeModuleProxy === true;
    if (legacyServed) return host.nativeModuleProxy?.ImagePicker ?? undefined;
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
      if (response.didCancel) return { images: [], refused: [] };
      if (response.errorCode !== undefined) {
        throw new Error(`the photo picker refused: ${response.errorCode}`);
      }

      const images: PromptImage[] = [];
      const refused: string[] = [];
      const seats = Math.max(0, Math.min(MAX_PROMPT_IMAGES, room));
      const assets = response.assets ?? [];
      for (const [position, asset] of assets.entries()) {
        const name = labelFor(asset.fileName, position, assets.length);
        // An asset without base64 (a video, a picker quirk) cannot be sent as
        // an empty block: that is a turn the agent would spend on a decode
        // error. It is named here rather than skipped, because a chip that
        // never appears is indistinguishable from a press that did nothing.
        if (typeof asset.base64 !== "string" || asset.base64.length === 0) {
          refused.push(`${name} was not attached: the picker returned no image data for it.`);
          continue;
        }
        if (images.length >= seats) {
          refused.push(`${name} was not attached: ${PROMPT_IMAGE_REFUSAL_REASONS.too_many}`);
          continue;
        }
        const raw = (asset.type ?? "").toLowerCase();
        const mimeType = MIME_ALIASES[raw] ?? raw;
        const checked = parsePromptImages([{ data: asset.base64, mimeType }]);
        if (checked.ok) {
          images.push(...checked.images);
          continue;
        }
        refused.push(refusalSentence(name, mimeType, asset.base64.length, checked.refusal));
      }
      return { images, refused };
    },
  };
}

const probed = probeImagePickerModule();

/** The picker every platform gets: live where the module links, named otherwise. */
export const imageAttachmentPicker: ImageAttachmentPicker = createImageAttachmentPicker(
  probed === undefined ? undefined : launchImageLibrary,
);
