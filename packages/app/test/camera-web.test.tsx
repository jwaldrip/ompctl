/**
 * Proves the web camera seam:
 * 1. A decoded QR value reaches onScanned through the seam, driving the decode
 *    path with a stubbed detector and stubbed getUserMedia rather than calling
 *    the handler directly.
 * 2. Each unavailable condition reports its own distinguishable reason:
 *    no secure context, no camera, permission denied, and no decoder.
 * 3. Media tracks are stopped on unmount (and when isActive goes false).
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { PairingBundle } from "@ompd/core/pairing";
import { encodePairingBundle } from "@ompd/core/pairing";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CameraSeam } from "../src/platform/camera.ts";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose: bun evaluates a file's whole static import graph before
// its body runs, so static imports would load real react-native before rnw.ts stubs it.
const { createCameraSeam } = await import("../src/platform/camera.web.ts");
const { ScanScreen } = await import("../src/screens/ScanScreen.tsx");
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const VALID_BUNDLE: PairingBundle = {
  v: 1,
  label: "Jason's Mac",
  connection: {
    transport: "direct",
    url: "ws://10.4.1.221:7777/v1/socket",
    token: "tok_abc",
    scopes: ["read", "prompt"],
  },
};

interface Harness {
  host: HTMLElement;
  scanned: Array<{ connection: Connection; label: string }>;
  cancelled: number;
  unmount: () => void;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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
    get cancelled() {
      return cancelled;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  } as Harness;
}

function el(host: HTMLElement, testID: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testID}"]`);
}

function createMockTrack() {
  let stopped = false;
  return {
    kind: "video",
    get readyState() {
      return stopped ? "ended" : "live";
    },
    stop() {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
  };
}
function createMockStream(track: { stop: () => void }): MediaStream {
  const stream = typeof MediaStream !== "undefined" ? new MediaStream() : ({} as MediaStream);
  (stream as unknown as { getTracks: () => unknown[] }).getTracks = () => [track];
  (stream as unknown as { getVideoTracks: () => unknown[] }).getVideoTracks = () => [track];
  return stream;
}

describe("Web Camera Seam: decode through seam", () => {
  test("decoded QR code from stubbed detector reaches onScanned through the seam", async () => {
    const rawQr = encodePairingBundle(VALID_BUNDLE);
    const track = createMockTrack();
    const mockStream = createMockStream(track);

    let detectorDetectCalled = false;
    class StubBarcodeDetector {
      async detect() {
        detectorDetectCalled = true;
        return [{ rawValue: rawQr, format: "qr_code" }];
      }
    }

    const mockMediaDevices = {
      getUserMedia: async () => mockStream,
      enumerateDevices: async () => [
        { deviceId: "cam-1", kind: "videoinput", label: "FaceTime HD Camera" } as MediaDeviceInfo,
      ],
    };

    const seam = createCameraSeam({
      isSecureContext: true,
      mediaDevices: mockMediaDevices,
      BarcodeDetector: StubBarcodeDetector,
      devices: [{ deviceId: "cam-1", kind: "videoinput" }],
      permissionState: "granted",
    });

    expect(seam.availability.available).toBe(true);

    const h = mountScanScreen(seam);
    expect(el(h.host, "scan-camera")).not.toBeNull();

    // Allow decode loop tick to run
    await act(async () => {
      await delay(150);
    });

    expect(detectorDetectCalled).toBe(true);
    // Confirm confirmation card appears
    const confirm = el(h.host, "scan-confirm");
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("Jason's Mac");

    // Click confirm to pair
    act(() => {
      el(h.host, "scan-confirm-accept")?.click();
    });

    expect(h.scanned).toEqual([{ connection: VALID_BUNDLE.connection, label: "Jason's Mac" }]);
    h.unmount();
  });
});

describe("Web Camera Seam: unavailable conditions report distinguishable reasons", () => {
  test("each unavailable condition reports its own distinguishable reason", () => {
    const noSecureContext = createCameraSeam({
      isSecureContext: false,
      mediaDevices: { getUserMedia: async () => ({}) as MediaStream },
      BarcodeDetector: class {
        async detect() {
          return [];
        }
      },
      devices: [{ kind: "videoinput" }],
      permissionState: "granted",
    });
    expect(noSecureContext.availability.available).toBe(false);
    const reasonSecure = (noSecureContext.availability as { reason: string }).reason;
    expect(reasonSecure.toLowerCase()).toContain("secure context");

    const noDecoder = createCameraSeam({
      isSecureContext: true,
      mediaDevices: { getUserMedia: async () => ({}) as MediaStream },
      BarcodeDetector: null,
      devices: [{ kind: "videoinput" }],
      permissionState: "granted",
    });
    expect(noDecoder.availability.available).toBe(false);
    const reasonDecoder = (noDecoder.availability as { reason: string }).reason;
    expect(reasonDecoder.toLowerCase()).toContain("barcodedetector");

    const noCamera = createCameraSeam({
      isSecureContext: true,
      mediaDevices: { getUserMedia: async () => ({}) as MediaStream },
      BarcodeDetector: class {
        async detect() {
          return [];
        }
      },
      devices: [],
      permissionState: "granted",
    });
    expect(noCamera.availability.available).toBe(false);
    const reasonNoCamera = (noCamera.availability as { reason: string }).reason;
    expect(reasonNoCamera.toLowerCase()).toContain("no camera");

    const permissionDenied = createCameraSeam({
      isSecureContext: true,
      mediaDevices: { getUserMedia: async () => ({}) as MediaStream },
      BarcodeDetector: class {
        async detect() {
          return [];
        }
      },
      devices: [{ kind: "videoinput" }],
      permissionState: "denied",
    });
    expect(permissionDenied.availability.available).toBe(false);
    const reasonPermission = (permissionDenied.availability as { reason: string }).reason;
    expect(reasonPermission.toLowerCase()).toContain("permission");
    expect(reasonPermission.toLowerCase()).toContain("denied");

    // All four reasons must be distinct from one another
    const reasons = [reasonSecure, reasonDecoder, reasonNoCamera, reasonPermission];
    const unique = new Set(reasons);
    expect(unique.size).toBe(4);
  });
});

describe("Web Camera Seam: media track cleanup on unmount", () => {
  test("media tracks are stopped when the component unmounts", async () => {
    const track = createMockTrack();
    const mockStream = createMockStream(track);

    const mockMediaDevices = {
      getUserMedia: async () => mockStream,
      enumerateDevices: async () => [
        { deviceId: "cam-1", kind: "videoinput", label: "FaceTime HD Camera" } as MediaDeviceInfo,
      ],
    };

    const seam = createCameraSeam({
      isSecureContext: true,
      mediaDevices: mockMediaDevices,
      BarcodeDetector: class {
        async detect() {
          return [];
        }
      },
      devices: [{ deviceId: "cam-1", kind: "videoinput" }],
      permissionState: "granted",
    });

    const h = mountScanScreen(seam);
    expect(el(h.host, "scan-camera")).not.toBeNull();

    await act(async () => {
      await delay(50);
    });

    expect(track.stopped).toBe(false);

    // Unmount the component
    h.unmount();

    expect(track.stopped).toBe(true);
  });

  test("media tracks are stopped when isActive goes false", async () => {
    const track = createMockTrack();
    const mockStream = createMockStream(track);

    const rawQr = encodePairingBundle(VALID_BUNDLE);
    class StubBarcodeDetector {
      async detect() {
        return [{ rawValue: rawQr, format: "qr_code" }];
      }
    }

    const seam = createCameraSeam({
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: async () => mockStream,
        enumerateDevices: async () => [{ deviceId: "cam-1", kind: "videoinput" } as MediaDeviceInfo],
      },
      BarcodeDetector: StubBarcodeDetector,
      devices: [{ deviceId: "cam-1", kind: "videoinput" }],
      permissionState: "granted",
    });

    const h = mountScanScreen(seam);

    // Let decode loop detect the code, which causes ScanScreen to set pending !== null
    // thereby setting isActive={false} on Camera
    await act(async () => {
      await delay(150);
    });

    expect(el(h.host, "scan-confirm")).not.toBeNull();
    // Track must be stopped when isActive goes false!
    expect(track.stopped).toBe(true);

    h.unmount();
  });
});
