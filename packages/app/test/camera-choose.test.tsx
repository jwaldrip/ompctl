/**
 * Proves camera selection across web, macOS, and vision-camera seams:
 * 1. Selecting a different camera changes the device actually captured from (asserting on requested constraint/deviceId).
 * 2. Switching tears down the previous session so the first camera stops.
 * 3. Runtime device list updates are reflected, and gone devices fall back to an available camera.
 * 4. Single-camera setups omit the picker control to avoid noise.
 * 5. Camera preference persistence restores choices and coerces untrusted storage values.
 */

import "./rnw.ts";

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CameraSeam } from "../src/platform/camera.ts";
import { resetCameraMock } from "./rnw.ts";

/**
 * An in-memory store rather than the real package, matching `view-prefs.test.ts`
 * and `secrets.test.ts`. Importing the real module worked on this machine and
 * failed on CI with `AsyncStorage.clear is not a function`, because the harness
 * there supplies a partial module. Owning the fake removes the dependency on
 * whichever shape the environment happens to provide, and gives the reset a
 * `Map` to clear instead of an API call that may not exist.
 */
function makeFakeAsyncStorage() {
  const store = new Map<string, string>();
  return {
    store,
    module: {
      default: {
        getItem: (key: string) => Promise.resolve(store.get(key) ?? null),
        setItem: (key: string, value: string) => {
          store.set(key, value);
          return Promise.resolve();
        },
        removeItem: (key: string) => {
          store.delete(key);
          return Promise.resolve();
        },
      },
    },
  };
}

const fakeAsyncStorage = makeFakeAsyncStorage();
mock.module("@react-native-async-storage/async-storage", () => fakeAsyncStorage.module);

// Dynamic imports so the mock above is registered before anything reads storage.
const { createCameraSeam: createVisionSeam } = await import("../src/platform/camera.ts");
const { createCameraSeam: createWebSeam } = await import("../src/platform/camera.web.ts");
const { createCameraSeam: createMacSeam } = await import("../src/platform/camera.macos.ts");
const { ScanScreen } = await import("../src/screens/ScanScreen.tsx");
const { coerceCameraPrefs, loadCameraPrefs, saveCameraPrefs } = await import("../src/platform/camera-prefs.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  resetCameraMock();
  fakeAsyncStorage.store.clear();
});

interface Harness {
  host: HTMLElement;
  unmount: () => void;
}

function mountScanScreen(camera: CameraSeam): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<ScanScreen camera={camera} onCancel={() => {}} onScanned={() => {}} />);
  });
  return {
    host,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function el(host: HTMLElement, testID: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testID}"]`);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

class StubBarcodeDetector {
  async detect() {
    return [];
  }
}

function createMockTrack() {
  let stopped = false;
  return {
    get stopped() {
      return stopped;
    },
    stop: () => {
      stopped = true;
    },
  };
}

function createMockStream(track: { stop: () => void }): MediaStream {
  return {
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
}

describe("Camera selection: device choice and capture surface", () => {
  test("web seam captures from chosen deviceId rather than hardcoding videoDevices[0]", async () => {
    const track1 = createMockTrack();
    const stream1 = createMockStream(track1);
    const track2 = createMockTrack();
    const stream2 = createMockStream(track2);

    const requestedConstraints: MediaStreamConstraints[] = [];
    const mockMediaDevices = {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        requestedConstraints.push(constraints);
        const video = constraints.video as { deviceId?: { exact?: string } } | undefined;
        if (video?.deviceId?.exact === "usb-cam-2") {
          return stream2;
        }
        return stream1;
      },
      enumerateDevices: async () => [
        { deviceId: "builtin-1", kind: "videoinput", label: "FaceTime HD Camera" } as MediaDeviceInfo,
        { deviceId: "usb-cam-2", kind: "videoinput", label: "Studio Display Camera" } as MediaDeviceInfo,
      ],
    };

    const seam = createWebSeam({
      isSecureContext: true,
      BarcodeDetector: StubBarcodeDetector,
      mediaDevices: mockMediaDevices,
      devices: [
        { deviceId: "builtin-1", kind: "videoinput", label: "FaceTime HD Camera" },
        { deviceId: "usb-cam-2", kind: "videoinput", label: "Studio Display Camera" },
      ],
      permissionState: "granted",
    });

    const h = mountScanScreen(seam);
    await act(async () => {
      await delay(50);
    });

    // Picker must be present for multi-camera setup
    const picker = el(h.host, "scan-camera-selector");
    expect(picker).not.toBeNull();

    // Select second camera
    const secondOption = el(h.host, "scan-camera-option-usb-cam-2");
    expect(secondOption).not.toBeNull();

    act(() => {
      secondOption?.click();
    });

    await act(async () => {
      await delay(50);
    });

    // Check that second camera was requested with exact deviceId constraint
    const hasSecondCamConstraint = requestedConstraints.some(c => {
      const v = c.video as { deviceId?: { exact?: string } } | undefined;
      return v?.deviceId?.exact === "usb-cam-2";
    });
    expect(hasSecondCamConstraint).toBe(true);

    // And previous stream track was stopped
    expect(track1.stopped).toBe(true);

    h.unmount();
  });

  test("macOS seam starts session with chosen deviceId and tears down previous session", async () => {
    const sessionHistory: Array<{ action: "start" | "stop"; deviceId?: string }> = [];

    const stub = {
      hasPermission: true,
      hasCamera: true,
      permissionStatus: "authorized",
      startSession: async (deviceId?: string) => {
        sessionHistory.push({ action: "start", deviceId });
      },
      stopSession: async () => {
        sessionHistory.push({ action: "stop" });
      },
      requestPermission: async () => true,
      addListener: () => ({ remove: () => {} }),
      getAvailableDevices: async () => [
        { id: "built-in", name: "FaceTime HD Camera" },
        { id: "studio-display", name: "Studio Display Camera" },
      ],
    };

    const seam = createMacSeam(stub as unknown as Parameters<typeof createMacSeam>[0], {
      devices: [
        { id: "built-in", name: "FaceTime HD Camera" },
        { id: "studio-display", name: "Studio Display Camera" },
      ],
    });

    const h = mountScanScreen(seam);
    await act(async () => {
      await delay(50);
    });

    expect(el(h.host, "scan-camera-selector")).not.toBeNull();

    // Switch to studio display camera
    const studioOption = el(h.host, "scan-camera-option-studio-display");
    expect(studioOption).not.toBeNull();

    act(() => {
      studioOption?.click();
    });

    await act(async () => {
      await delay(50);
    });

    // Switching must call stopSession then startSession with new deviceId
    const lastStopIndex = sessionHistory.findLastIndex(s => s.action === "stop");
    const lastStartIndex = sessionHistory.findLastIndex(s => s.action === "start");
    expect(lastStopIndex).toBeGreaterThan(-1);
    expect(lastStartIndex).toBeGreaterThan(lastStopIndex);
    expect(sessionHistory[lastStartIndex]?.deviceId).toBe("studio-display");

    h.unmount();
  });

  test("single camera case omits picker control", async () => {
    const seam = createWebSeam({
      isSecureContext: true,
      BarcodeDetector: StubBarcodeDetector,
      mediaDevices: {
        getUserMedia: async () => createMockStream(createMockTrack()),
        enumerateDevices: async () => [
          { deviceId: "only-one", kind: "videoinput", label: "FaceTime HD Camera" } as MediaDeviceInfo,
        ],
      },
      devices: [{ deviceId: "only-one", kind: "videoinput", label: "FaceTime HD Camera" }],
      permissionState: "granted",
    });

    const h = mountScanScreen(seam);
    await act(async () => {
      await delay(50);
    });

    // No picker when only one camera exists
    expect(el(h.host, "scan-camera-selector")).toBeNull();
    // But camera is active
    expect(el(h.host, "scan-camera")).not.toBeNull();

    h.unmount();
  });

  test("disappeared camera falls back to available camera without leaving dead viewfinder", async () => {
    // Start with a remembered device that no longer exists
    await saveCameraPrefs({ deviceId: "disconnected-usb-camera" });

    const requestedConstraints: MediaStreamConstraints[] = [];
    const seam = createWebSeam({
      isSecureContext: true,
      BarcodeDetector: StubBarcodeDetector,
      mediaDevices: {
        getUserMedia: async (constraints: MediaStreamConstraints) => {
          requestedConstraints.push(constraints);
          return createMockStream(createMockTrack());
        },
        enumerateDevices: async () => [
          { deviceId: "fallback-cam", kind: "videoinput", label: "Built-in Camera" } as MediaDeviceInfo,
        ],
      },
      devices: [{ deviceId: "fallback-cam", kind: "videoinput", label: "Built-in Camera" }],
      permissionState: "granted",
    });

    const h = mountScanScreen(seam);
    await act(async () => {
      await delay(50);
    });

    // Viewfinder must still mount and render
    expect(el(h.host, "scan-camera")).not.toBeNull();
    // It should have fallen back to the available camera rather than failing on the missing one
    const usedFallback = requestedConstraints.some(c => {
      const v = c.video as { deviceId?: { exact?: string } } | undefined;
      return v?.deviceId?.exact === "fallback-cam" || (c.video && !v?.deviceId?.exact);
    });
    expect(usedFallback).toBe(true);

    h.unmount();
  });
  test("runtime device change updates device list and unplugging active camera falls back", async () => {
    type Listener = () => void;
    const listeners = new Set<Listener>();
    let currentDevices = [
      { deviceId: "cam-a", kind: "videoinput", label: "Camera A" } as MediaDeviceInfo,
      { deviceId: "cam-b", kind: "videoinput", label: "Camera B" } as MediaDeviceInfo,
    ];

    const requestedConstraints: MediaStreamConstraints[] = [];
    const mockMediaDevices = {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        requestedConstraints.push(constraints);
        return createMockStream(createMockTrack());
      },
      enumerateDevices: async () => currentDevices,
      addEventListener: (type: string, listener: unknown) => {
        if (type === "devicechange") listeners.add(listener as Listener);
      },
      removeEventListener: (type: string, listener: unknown) => {
        if (type === "devicechange") listeners.delete(listener as Listener);
      },
    };

    const seam = createWebSeam({
      isSecureContext: true,
      BarcodeDetector: StubBarcodeDetector,
      mediaDevices: mockMediaDevices,
      permissionState: "granted",
    });

    const h = mountScanScreen(seam);
    await act(async () => {
      await delay(50);
    });

    // Both cameras present initially
    expect(el(h.host, "scan-camera-option-cam-a")).not.toBeNull();
    expect(el(h.host, "scan-camera-option-cam-b")).not.toBeNull();

    // Select camera B
    act(() => {
      el(h.host, "scan-camera-option-cam-b")?.click();
    });
    await act(async () => {
      await delay(50);
    });

    // Now simulate unplugging camera B: only Camera A remains
    currentDevices = [{ deviceId: "cam-a", kind: "videoinput", label: "Camera A" } as MediaDeviceInfo];
    await act(async () => {
      for (const listener of listeners) {
        listener();
      }
      await delay(50);
    });

    // Camera B is gone, now only 1 camera remains so picker hides to avoid single-option noise
    expect(el(h.host, "scan-camera-selector")).toBeNull();
    // And camera viewfinder is still alive, falling back to camera A
    expect(el(h.host, "scan-camera")).not.toBeNull();

    const lastConstraint = requestedConstraints.at(-1);
    const video = lastConstraint?.video as { deviceId?: { exact?: string } } | undefined;
    expect(video?.deviceId?.exact).toBe("cam-a");

    h.unmount();
  });

  test("vision-camera seam exposes front and back cameras and passes selected device to Camera", async () => {
    const mountedDevices: unknown[] = [];
    const mockVision = {
      Camera: (props: { device: unknown }) => {
        mountedDevices.push(props.device);
        return <div data-testid="scan-camera" />;
      },
      useCameraPermission: () => ({
        hasPermission: true,
        requestPermission: async () => true,
      }),
      useCameraDevice: (position: "back" | "front") => ({
        id: `phone-${position}`,
        name: `${position === "back" ? "Back" : "Front"} Camera`,
        position,
      }),
      useCodeScanner: (opts: unknown) => opts,
    };

    const seam = createVisionSeam(mockVision as unknown as Parameters<typeof createVisionSeam>[0]);
    const h = mountScanScreen(seam);
    await act(async () => {
      await delay(50);
    });

    // Both back and front cameras should appear in selector
    expect(el(h.host, "scan-camera-option-phone-back")).not.toBeNull();
    expect(el(h.host, "scan-camera-option-phone-front")).not.toBeNull();

    // Initially back camera is active
    const firstDevice = mountedDevices.at(-1) as { id?: string } | undefined;
    expect(firstDevice?.id).toBe("phone-back");

    // Switch to front camera
    act(() => {
      el(h.host, "scan-camera-option-phone-front")?.click();
    });
    await act(async () => {
      await delay(50);
    });

    // Now front camera is active and passed to Camera component
    const switchedDevice = mountedDevices.at(-1) as { id?: string } | undefined;
    expect(switchedDevice?.id).toBe("phone-front");

    h.unmount();
  });

  test("camera preferences persistence: restores valid choice and coerces corrupted payload", async () => {
    expect(coerceCameraPrefs(null)).toEqual({ deviceId: null });
    expect(coerceCameraPrefs({})).toEqual({ deviceId: null });
    expect(coerceCameraPrefs({ deviceId: 1234 })).toEqual({ deviceId: null });
    expect(coerceCameraPrefs({ deviceId: "   " })).toEqual({ deviceId: null });
    expect(coerceCameraPrefs({ deviceId: "studio-cam" })).toEqual({ deviceId: "studio-cam" });

    await saveCameraPrefs({ deviceId: "my-saved-camera" });
    const loaded = await loadCameraPrefs();
    expect(loaded.deviceId).toBe("my-saved-camera");
  });
});
