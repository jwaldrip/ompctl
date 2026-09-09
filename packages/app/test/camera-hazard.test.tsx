/**
 * Proves that camera availability is a safe value and that the module-scope
 * import hazard is eliminated.
 *
 * On origin/main, `ScanScreen.tsx` statically imported `react-native-vision-camera`.
 * When run on platforms without CameraView (macOS, Windows, web),
 * `NativeCameraModule.ts` throws `system/camera-module-not-found` at module
 * evaluation time before any component-level guard can run.
 *
 * This test verifies that:
 * 1. The probe safely returns undefined when NativeModules.CameraView is absent.
 * 2. The camera seam carries an honest refusal without throwing.
 * 3. ScanScreen mounts safely and renders the refusal view without throwing.
 */

import "./rnw.ts";
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

  test("Vite extension resolution picks camera.web.ts over camera.ts", async () => {
    const { createServer } = await import("vite");
    const { default: config } = await import("../vite.config.ts");
    const server = await createServer({
      ...config,
      root: resolve(import.meta.dirname, ".."),
      server: { middlewareMode: true },
    });
    try {
      const resolved = await server.pluginContainer.resolveId("./src/platform/camera", undefined, { isEntry: true });
      expect(resolved?.id).toContain("camera.web.ts");
    } finally {
      await server.close();
    }
  });

  test("built web bundle contains zero react-native-vision-camera identifiers", async () => {
    const distAssets = resolve(import.meta.dirname, "../dist/assets");
    let bundleCode = "";
    if (existsSync(distAssets)) {
      const jsFiles = readdirSync(distAssets).filter(f => f.endsWith(".js"));
      for (const f of jsFiles) {
        bundleCode += `${readFileSync(join(distAssets, f), "utf8")}\n`;
      }
    }
    if (!bundleCode) {
      const { build } = await import("vite");
      const { default: config } = await import("../vite.config.ts");
      const result = await build({
        ...config,
        root: resolve(import.meta.dirname, ".."),
        logLevel: "silent",
        build: { write: false, sourcemap: false },
      });
      const outputs = Array.isArray(result) ? result : [result];
      const chunks = outputs.flatMap(out => ("output" in out ? out.output : []));
      bundleCode = chunks.map(chunk => ("code" in chunk ? chunk.code : "")).join("\n");
    }

    expect(bundleCode.length).toBeGreaterThan(0);
    expect(bundleCode.includes("NativeCameraView")).toBe(false);
    expect(bundleCode.includes("CameraViewManager")).toBe(false);
    expect(bundleCode.includes("react-native-vision-camera")).toBe(false);
  });
});
