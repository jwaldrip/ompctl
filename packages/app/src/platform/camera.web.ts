/**
 * The web target's camera seam.
 *
 * Web has no native camera module linked, and react-native-web does not export
 * requireNativeComponent. This file ensures that Vite and web resolvers never
 * attempt to load react-native-vision-camera or include it in the module graph.
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
  reason: "Scanning is unavailable on web: this build has no camera scanner module.",
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
