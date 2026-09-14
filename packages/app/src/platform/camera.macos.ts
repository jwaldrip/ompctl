/**
 * The macOS target's camera hardware seam.
 *
 * VisionCamera has no macOS native module. Scanning on macOS uses our own
 * native AVFoundation module (OmpctlCamera), which exposes AVCaptureSession
 * QR detection directly to React Native.
 */

import type { ComponentType } from "react";
import { createElement, useCallback, useEffect, useState } from "react";
import type { NativeModule } from "react-native";
import * as ReactNative from "react-native";
import { NativeEventEmitter, NativeModules, Platform, View } from "react-native";
import type {
  CameraAvailability,
  CameraDeviceInfo,
  CameraHooks,
  CameraSeam,
  CameraViewfinderProps,
  Code,
} from "./camera.ts";

export type {
  CameraAvailability,
  CameraDeviceInfo,
  CameraHooks,
  CameraSeam,
  CameraViewfinderProps,
  Code,
  VisionCameraExports,
} from "./camera.ts";

export interface OmpctlCameraNativeModule {
  hasCamera?: boolean | (() => Promise<boolean>);
  hasPermission?: boolean;
  permissionStatus?: string;
  checkPermission?: () => Promise<string>;
  requestPermission: () => Promise<boolean>;
  getAvailableDevices?: () => Promise<Array<{ id: string; name: string }>>;
  startSession?: () => Promise<void>;
  startSessionWithDevice: (deviceId: string | null) => Promise<void>;
  stopSession: () => Promise<void>;
  addListener(eventName: string, listener: (data: unknown) => void): { remove(): void };
  removeListeners?(count: number): void;
}

export interface CameraSeamOptions {
  hasCamera?: boolean;
  hasPermission?: boolean;
  permissionStatus?: string;
  devices?: Array<{ id: string; name: string }>;
}

/**
 * Safely inspects the host's native module registries for OmpctlCamera
 * without throwing on unsupported runtimes or missing symbols.
 */
export function probeCameraModule(): OmpctlCameraNativeModule | undefined {
  if (Platform.OS !== "macos") return undefined;
  const host = globalThis as {
    __turboModuleProxy?: (name: string) => unknown;
    nativeModuleProxy?: Record<string, unknown>;
  };
  try {
    const turbo = host.__turboModuleProxy?.("OmpctlCamera");
    if (turbo !== null && turbo !== undefined) {
      return turbo as unknown as OmpctlCameraNativeModule;
    }
    if (host.nativeModuleProxy?.OmpctlCamera !== undefined) {
      return host.nativeModuleProxy.OmpctlCamera as unknown as OmpctlCameraNativeModule;
    }
  } catch {
    // Suppress lookup errors
  }
  try {
    const native = (NativeModules as Readonly<Record<string, unknown>>).OmpctlCamera;
    if (native !== null && native !== undefined) {
      return native as unknown as OmpctlCameraNativeModule;
    }
  } catch {
    // Suppress lookup errors
  }
  return undefined;
}

export async function loadVisionCamera(): Promise<undefined> {
  return undefined;
}

function withEventStream(native: OmpctlCameraNativeModule): OmpctlCameraNativeModule {
  try {
    const testSub = native.addListener("test_probe", () => {});
    if (testSub && typeof testSub.remove === "function") {
      testSub.remove();
      return native;
    }
  } catch {
    // Fall back to NativeEventEmitter wrapping
  }
  const emitter = new NativeEventEmitter(native as unknown as NativeModule);
  return {
    ...native,
    addListener: (eventName, listener) => emitter.addListener(eventName, listener),
  };
}

function resolveNativePreviewComponent(): ComponentType<{ style?: unknown; testID?: string }> | null {
  try {
    const rn = ReactNative as unknown as {
      requireNativeComponent?: (name: string) => ComponentType<{ style?: unknown; testID?: string }>;
    };
    if (typeof rn.requireNativeComponent === "function") {
      return rn.requireNativeComponent("OmpctlCameraPreview");
    }
  } catch {
    // Fall back to plain View in environments without native AppKit views
  }
  return null;
}
const NativePreviewComponent = resolveNativePreviewComponent();

function determineAvailability(
  rawModule: OmpctlCameraNativeModule | undefined,
  options?: CameraSeamOptions,
): CameraAvailability {
  if (rawModule === undefined) {
    return {
      available: false,
      reason: "Scanning is unavailable on macOS: this build has no camera scanner module.",
    };
  }

  const hasCamera = options?.hasCamera ?? (typeof rawModule.hasCamera === "boolean" ? rawModule.hasCamera : true);
  if (!hasCamera) {
    return {
      available: false,
      reason: "Scanning is unavailable on macOS: no camera was found on this Mac.",
    };
  }

  const isDenied =
    options?.permissionStatus === "denied" ||
    (options?.hasPermission === false && options?.permissionStatus === undefined) ||
    rawModule.permissionStatus === "denied";

  if (isDenied) {
    return {
      available: false,
      reason: "Scanning is unavailable on macOS: camera permission was denied.",
    };
  }

  return { available: true };
}

/**
 * Bind macOS camera scanning to the OmpctlCamera native module.
 */
export function createCameraSeam(
  rawModule: OmpctlCameraNativeModule | undefined = probeCameraModule(),
  options?: CameraSeamOptions,
): CameraSeam {
  const availability = determineAvailability(rawModule, options);
  if (!availability.available || rawModule === undefined) {
    return {
      availability,
    };
  }

  const activeModule = withEventStream(rawModule);

  const Camera: ComponentType<CameraViewfinderProps> = ({ style, isActive, codeScanner, testID, device }) => {
    const selectedDeviceId =
      device !== null && typeof device === "object" && "id" in device && typeof device.id === "string"
        ? device.id
        : undefined;

    useEffect(() => {
      if (isActive) {
        const targetDeviceId = selectedDeviceId && selectedDeviceId !== "default" ? selectedDeviceId : null;
        void activeModule.startSessionWithDevice(targetDeviceId).catch(() => {});
        return () => {
          void activeModule.stopSession().catch(() => {});
        };
      }
    }, [isActive, selectedDeviceId]);

    useEffect(() => {
      const scanner = codeScanner as { onCodeScanned?: (codes: Code[]) => void } | undefined;
      if (!scanner?.onCodeScanned) return;

      const sub = activeModule.addListener("onCodeScanned", (event: unknown) => {
        if (!isActive) return;
        let codes: Code[] = [];
        if (Array.isArray(event)) {
          codes = event as Code[];
        } else if (event && typeof event === "object" && "codes" in event) {
          const container = event as { codes: unknown };
          if (Array.isArray(container.codes)) {
            codes = container.codes as Code[];
          }
        }
        if (codes.length > 0) {
          scanner.onCodeScanned?.(codes);
        }
      });

      return () => {
        sub.remove();
      };
    }, [codeScanner, isActive]);

    const TargetView = (NativePreviewComponent ?? View) as ComponentType<{ style?: unknown; testID?: string }>;
    return createElement(TargetView, { style, testID });
  };

  const hooks: CameraHooks = {
    useCameraPermission: () => {
      const [hasPermission, setHasPermission] = useState<boolean>(() => {
        if (options?.hasPermission !== undefined) return options.hasPermission;
        if (typeof activeModule.hasPermission === "boolean") return activeModule.hasPermission;
        return true;
      });

      const requestPermission = useCallback(async () => {
        try {
          const granted = await activeModule.requestPermission();
          setHasPermission(granted);
          return granted;
        } catch {
          setHasPermission(false);
          return false;
        }
      }, []);

      return { hasPermission, requestPermission };
    },

    useCameraDevice: (_position: "back" | "front") => {
      const hasCam =
        options?.hasCamera ?? (typeof activeModule.hasCamera === "boolean" ? activeModule.hasCamera : true);
      if (!hasCam) return undefined;
      return {
        id: "default",
        name: "Mac Camera",
        position: "back" as const,
      };
    },
    useCameraDevices: () => {
      const [devices, setDevices] = useState<CameraDeviceInfo[]>(() => {
        if (options?.devices !== undefined) {
          return options.devices.map((d, index) => ({
            id: d.id,
            label: d.name && d.name.trim().length > 0 ? d.name : `Camera ${index + 1}`,
            position: "unspecified" as const,
          }));
        }
        const hasCam =
          options?.hasCamera ?? (typeof activeModule.hasCamera === "boolean" ? activeModule.hasCamera : true);
        if (!hasCam) return [];
        return [{ id: "default", label: "Mac Camera", position: "unspecified" as const }];
      });

      useEffect(() => {
        if (options?.devices !== undefined) {
          setDevices(
            options.devices.map((d, index) => ({
              id: d.id,
              label: d.name && d.name.trim().length > 0 ? d.name : `Camera ${index + 1}`,
              position: "unspecified" as const,
            })),
          );
          return;
        }

        let active = true;

        const refresh = () => {
          if (typeof activeModule.getAvailableDevices === "function") {
            void activeModule
              .getAvailableDevices()
              .then(list => {
                if (!active) return;
                if (Array.isArray(list) && list.length > 0) {
                  setDevices(
                    list.map((d, index) => ({
                      id: d.id,
                      label: d.name && d.name.trim().length > 0 ? d.name : `Camera ${index + 1}`,
                      position: "unspecified" as const,
                    })),
                  );
                } else {
                  setDevices([]);
                }
              })
              .catch(() => {});
          }
        };

        refresh();

        const sub = activeModule.addListener("onCameraDevicesChanged", () => {
          refresh();
        });

        return () => {
          active = false;
          sub.remove();
        };
      }, []);

      return devices;
    },

    useCodeScanner: (opts: { codeTypes: string[]; onCodeScanned: (codes: Code[]) => void }) => {
      return opts;
    },
  };

  return {
    availability,
    Camera,
    hooks,
  };
}

const probedModule = probeCameraModule();

export const cameraAvailability: CameraAvailability = determineAvailability(probedModule);

export const cameraSeam: CameraSeam = createCameraSeam(probedModule);
