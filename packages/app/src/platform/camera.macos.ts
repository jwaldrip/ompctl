/**
 * The macOS target's camera seam.
 *
 * VisionCamera has no macOS native module. This file makes Metro resolve an
 * explicit refusal instead of probing a partial native registry and loading
 * the iOS camera package.
 */

import type { CameraAvailability, CameraSeam } from "./camera.ts";

export type {
  CameraAvailability,
  CameraHooks,
  CameraSeam,
  CameraViewfinderProps,
  Code,
  VisionCameraExports,
} from "./camera.ts";

export const cameraAvailability: CameraAvailability = {
  available: false,
  reason: "Scanning is unavailable on macOS: this build has no camera scanner module.",
};

export const cameraSeam: CameraSeam = {
  availability: cameraAvailability,
};

export function createCameraSeam(): CameraSeam {
  return cameraSeam;
}

export function probeCameraModule(): undefined {
  return undefined;
}

export async function loadVisionCamera(): Promise<undefined> {
  return undefined;
}
