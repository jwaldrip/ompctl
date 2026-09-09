/**
 * The Windows target's camera seam.
 *
 * Windows has no native camera module linked. This file ensures that Metro
 * for Windows resolves this stub rather than evaluating native vision-camera.
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
  reason: "Scanning is unavailable on Windows: this build has no camera scanner module.",
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
