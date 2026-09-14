/**
 * Tests for the native macOS camera seam and QR scan flow.
 *
 * Verifies that:
 * 1. A decoded value reaches onScanned through the seam with the native module stubbed.
 * 2. Distinct unavailable reasons are reported: no scanner module, no camera, permission denied.
 * 3. The camera capture session is started on mount and torn down on unmount.
 * 4. Pausing scanning during confirmation halts the session; rejecting resumes it.
 * 5. In-screen permission request and missing-hardware fallbacks behave as expected.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import type { PairingBundle } from "@ompd/core/pairing";
import { encodePairingBundle } from "@ompd/core/pairing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createBridgeCheckedStub } from "../scripts/check-macos-camera-bridge.ts";
import type { CameraSeam } from "../src/platform/camera.ts";
import type { Connection } from "../src/platform/connection.ts";
import { resetCameraMock } from "./rnw.ts";

const { ScanScreen } = await import("../src/screens/ScanScreen.tsx");
const macCamera = await import("../src/platform/camera.macos.ts");
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

afterEach(resetCameraMock);

const VALID_BUNDLE: PairingBundle = {
  v: 1,
  label: "Mac Mini Studio",
  connection: {
    transport: "direct",
    url: "ws://10.4.1.221:7777/v1/socket",
    token: "valid-direct-token",
    scopes: ["read", "prompt"],
  },
};

interface Harness {
  host: HTMLElement;
  scanned: Array<{ connection: Connection; label: string }>;
  cancelled: number;
  unmount: () => void;
}

function mountScanScreen(camera: CameraSeam): Harness {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const scanned: Array<{ connection: Connection; label: string }> = [];
  let cancelled = 0;

  act(() => {
    root.render(
      <ScanScreen
        camera={camera}
        onCancel={() => {
          cancelled += 1;
        }}
        onScanned={(connection, label) => {
          scanned.push({ connection, label });
        }}
      />,
    );
  });

  return {
    host,
    scanned,
    cancelled,
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

interface StubNativeModule {
  hasCamera: boolean;
  hasPermission: boolean;
  permissionStatus: string;
  startSessionCalls: number;
  startSessionWithDeviceCalls: number;
  lastDeviceIdStarted: string | null | undefined;
  stopSessionCalls: number;
  requestPermissionCalls: number;
  listeners: Record<string, Set<(data: unknown) => void>>;
  checkPermission: () => Promise<string>;
  requestPermission: () => Promise<boolean>;
  startSession: () => Promise<void>;
  startSessionWithDevice?: (deviceId: string | null) => Promise<void>;
  stopSession: () => Promise<void>;
  addListener: (event: string, listener: (data: unknown) => void) => { remove: () => void };
  emit: (event: string, data: unknown) => void;
}

function createStubNativeModule(overrides?: Partial<StubNativeModule>): StubNativeModule {
  const listeners: Record<string, Set<(data: unknown) => void>> = {};
  const stub: StubNativeModule = {
    hasCamera: true,
    hasPermission: true,
    permissionStatus: "authorized",
    startSessionCalls: 0,
    stopSessionCalls: 0,
    requestPermissionCalls: 0,
    listeners,
    checkPermission: async () => stub.permissionStatus,
    requestPermission: async () => {
      stub.requestPermissionCalls += 1;
      stub.hasPermission = true;
      return true;
    },
    startSession: async () => {
      stub.startSessionCalls += 1;
    },
    startSessionWithDeviceCalls: 0,
    lastDeviceIdStarted: undefined,
    startSessionWithDevice: async (deviceId: string | null) => {
      stub.startSessionWithDeviceCalls += 1;
      stub.lastDeviceIdStarted = deviceId;
      stub.startSessionCalls += 1;
    },
    stopSession: async () => {
      stub.stopSessionCalls += 1;
    },
    addListener: (event: string, listener: (data: unknown) => void) => {
      listeners[event] = listeners[event] ?? new Set();
      listeners[event].add(listener);
      return {
        remove: () => {
          listeners[event]?.delete(listener);
        },
      };
    },
    emit: (event: string, data: unknown) => {
      listeners[event]?.forEach(fn => {
        fn(data);
      });
    },
    ...overrides,
  };
  return createBridgeCheckedStub(stub);
}

describe("macOS QR Scanner: end to end through the seam", () => {
  test("decoded QR value reaches onScanned with native module stubbed", () => {
    const stub = createStubNativeModule();
    const seam = macCamera.createCameraSeam(stub);

    const h = mountScanScreen(seam);
    expect(el(h.host, "scan-camera")).not.toBeNull();
    expect(el(h.host, "scan-no-device")).toBeNull();

    // Emit a valid pairing bundle through the native module event stream
    const encoded = encodePairingBundle(VALID_BUNDLE);
    act(() => {
      stub.emit("onCodeScanned", [{ type: "qr", value: encoded }]);
    });

    // Confirmation card appears
    const confirmCard = el(h.host, "scan-confirm");
    expect(confirmCard).not.toBeNull();
    expect(confirmCard?.textContent).toContain("Pair with Mac Mini Studio?");

    // Accept pairing
    act(() => {
      el(h.host, "scan-confirm-accept")?.click();
    });

    expect(h.scanned).toHaveLength(1);
    expect(h.scanned[0]?.label).toBe("Mac Mini Studio");
    expect(h.scanned[0]?.connection).toEqual(VALID_BUNDLE.connection);

    h.unmount();
  });

  test("session is started on mount and torn down on unmount", () => {
    const stub = createStubNativeModule();
    const seam = macCamera.createCameraSeam(stub);

    const h = mountScanScreen(seam);
    expect(stub.startSessionCalls).toBe(1);
    expect(stub.stopSessionCalls).toBe(0);

    h.unmount();
    expect(stub.stopSessionCalls).toBe(1);
  });

  test("pausing during confirmation card stops the session, rejecting resumes it", () => {
    const stub = createStubNativeModule();
    const seam = macCamera.createCameraSeam(stub);

    const h = mountScanScreen(seam);
    expect(stub.startSessionCalls).toBe(1);
    expect(stub.stopSessionCalls).toBe(0);

    // Emit a valid pairing bundle
    const encoded = encodePairingBundle(VALID_BUNDLE);
    act(() => {
      stub.emit("onCodeScanned", [{ type: "qr", value: encoded }]);
    });

    // Confirmation card appears, isActive becomes false: session should be stopped
    expect(el(h.host, "scan-confirm")).not.toBeNull();
    expect(stub.stopSessionCalls).toBe(1);

    // Decline/cancel pairing: isActive becomes true again: session should be restarted
    act(() => {
      el(h.host, "scan-confirm-cancel")?.click();
    });
    expect(el(h.host, "scan-confirm")).toBeNull();
    expect(stub.startSessionCalls).toBe(2);

    h.unmount();
    expect(stub.stopSessionCalls).toBe(2);
  });

  test("reports distinct unavailable reasons: no module, no camera, permission denied", () => {
    // 1. Missing native module
    const noModuleSeam = macCamera.createCameraSeam(undefined);
    expect(noModuleSeam.availability).toEqual({
      available: false,
      reason: "Scanning is unavailable on macOS: this build has no camera scanner module.",
    });

    // 2. Native module present but no camera device
    const noCamStub = createStubNativeModule({ hasCamera: false });
    const noCameraSeam = macCamera.createCameraSeam(noCamStub, { hasCamera: false });
    expect(noCameraSeam.availability).toEqual({
      available: false,
      reason: "Scanning is unavailable on macOS: no camera was found on this Mac.",
    });

    // Mounting with no camera renders the honest refusal reason
    const hNoCam = mountScanScreen(noCameraSeam);
    const noCamEl = el(hNoCam.host, "scan-no-device");
    expect(noCamEl).not.toBeNull();
    expect(noCamEl?.textContent).toContain("no camera was found on this Mac.");
    hNoCam.unmount();

    // 3. Native module present but permission denied
    const deniedStub = createStubNativeModule({ hasPermission: false, permissionStatus: "denied" });
    const deniedSeam = macCamera.createCameraSeam(deniedStub, {
      hasPermission: false,
      permissionStatus: "denied",
    });
    expect(deniedSeam.availability).toEqual({
      available: false,
      reason: "Scanning is unavailable on macOS: camera permission was denied.",
    });

    // Mounting with denied permission renders the honest refusal reason
    const hDenied = mountScanScreen(deniedSeam);
    const deniedEl = el(hDenied.host, "scan-no-device");
    expect(deniedEl).not.toBeNull();
    expect(deniedEl?.textContent).toContain("camera permission was denied.");
    hDenied.unmount();
  });

  test("requests permission in-screen when camera is available but unprompted", async () => {
    const stub = createStubNativeModule({ hasPermission: false, permissionStatus: "notDetermined" });
    const seam = macCamera.createCameraSeam(stub, { hasPermission: false, permissionStatus: "notDetermined" });

    const h = mountScanScreen(seam);
    expect(el(h.host, "scan-permission")).not.toBeNull();

    await act(async () => {
      el(h.host, "scan-request-permission")?.click();
    });

    expect(stub.requestPermissionCalls).toBe(1);
    expect(el(h.host, "scan-camera")).not.toBeNull();

    h.unmount();
  });

  test("scan session start passes device id through startSessionWithDevice and never passes arguments to startSession", () => {
    const startSessionArgs: unknown[][] = [];
    const startSessionWithDeviceArgs: Array<string | null> = [];

    const stub = createStubNativeModule({
      startSession: async (...args: unknown[]) => {
        startSessionArgs.push(args);
      },
      startSessionWithDevice: async (deviceId: string | null) => {
        startSessionWithDeviceArgs.push(deviceId);
      },
    });

    const seam = macCamera.createCameraSeam(stub);
    const Camera = seam.Camera;
    expect(Camera).toBeDefined();
    if (!Camera) throw new Error("Camera component is undefined");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <Camera isActive={true} device={{ id: "external-usb-camera", label: "USB Cam", position: "back" }} />,
      );
    });

    // Bridge contract: startSessionWithDevice must receive the device id,
    // and startSession must not receive any arguments.
    expect(startSessionWithDeviceArgs).toEqual(["external-usb-camera"]);
    expect(startSessionArgs).toEqual([]);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
