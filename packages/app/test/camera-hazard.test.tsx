/**
 * Proves that camera availability is a safe value and that the module-scope
 * import hazard is eliminated.
 *
 * The mobile camera module throws at import time when no native CameraView
 * exists. Unsupported platforms use explicit seams so the import never runs.
 *
 * This test verifies that:
 * 1. The generic probe safely returns undefined when CameraView is absent.
 * 2. The camera seam carries an honest refusal without throwing.
 * 3. ScanScreen mounts safely and renders the refusal view without throwing.
 * 4. macOS and web export explicit unavailable seams.
 */

import "./rnw.ts";
import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { createCameraSeam, probeCameraModule } = await import("../src/platform/camera.ts");
const { ScanScreen } = await import("../src/screens/ScanScreen.tsx");
describe("Camera module-scope hazard elimination", () => {
  test("probeCameraModule returns undefined when NativeModules.CameraView is absent", () => {
    // Under happy-dom / test host without CameraView
    const probed = probeCameraModule();
    expect(probed).toBeUndefined();
  });

  test("createCameraSeam creates a named unavailable state when module is absent", () => {
    const seam = createCameraSeam(undefined, "macos");
    expect(seam.availability.available).toBe(false);
    if (!seam.availability.available) {
      expect(seam.availability.reason).toBe(
        "Scanning is unavailable on macOS: this build has no camera scanner module.",
      );
    }
  });

  test("ScanScreen mounts cleanly without throwing when camera is unavailable", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const unavailableSeam = createCameraSeam(undefined, "macos");

    let cancelled = false;
    expect(() => {
      act(() => {
        root.render(
          <ScanScreen
            camera={unavailableSeam}
            onCancel={() => {
              cancelled = true;
            }}
            onScanned={() => {}}
          />,
        );
      });
    }).not.toThrow();

    const noDevice = host.querySelector('[data-testid="scan-no-device"]');
    expect(noDevice).not.toBeNull();
    expect(noDevice?.textContent).toContain(
      "Scanning is unavailable on macOS: this build has no camera scanner module.",
    );

    act(() => {
      (host.querySelector('[data-testid="scan-cancel"]') as HTMLElement)?.click();
    });
    expect(cancelled).toBe(true);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});

describe("macOS build camera exclusion", () => {
  test("macOS camera seam refuses scanning without importing VisionCamera", async () => {
    const macCamera = await import("../src/platform/camera.macos.ts");
    expect(macCamera.cameraAvailability).toEqual({
      available: false,
      reason: "Scanning is unavailable on macOS: this build has no camera scanner module.",
    });
    expect(macCamera.probeCameraModule()).toBeUndefined();
    expect(await macCamera.loadVisionCamera()).toBeUndefined();
  });
});
describe("Web build camera exclusion", () => {
  test("web camera seam exports honest refusal without native module", async () => {
    const webCamera = await import("../src/platform/camera.web.ts");
    expect(webCamera.cameraAvailability.available).toBe(false);
    if (!webCamera.cameraAvailability.available) {
      expect(webCamera.cameraAvailability.reason).toContain("unavailable on web");
    }
    expect(webCamera.probeCameraModule()).toBeUndefined();
    expect(await webCamera.loadVisionCamera()).toBeUndefined();
  });
});
