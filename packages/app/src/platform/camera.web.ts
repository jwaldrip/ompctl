/**
 * The web target's camera seam.
 *
 * Web has no native camera module linked. This file ensures that Vite and
 * web resolvers never attempt to load react-native-vision-camera.
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
export { createCameraSeam, probeCameraModule } from "./camera.ts";

export const cameraAvailability: CameraAvailability = {
  available: false,
  reason: "Scanning is unavailable on web: this build has no camera scanner module.",
};

export const cameraSeam: CameraSeam = {
  availability: cameraAvailability,
};
