/**
 * The camera hardware seam: where QR scanning capability comes from.
 *
 * react-native-vision-camera is an optional native module: its podspec is
 * iOS-only and its Gradle build is Android-only. macOS, Windows, and web targets
 * have no native CameraView implementation, and importing the library at module
 * scope throws a CameraRuntimeError immediately when NativeModules.CameraView is
 * null.
 *
 * This seam follows the attachments pattern: a probe resolves the native
 * module without throwing, and camera availability is a value carried to callers
 * so platforms without a camera report their named refusal rather than crashing
 * on route evaluation.
 */

import type { ComponentType } from "react";
import { NativeModules, Platform } from "react-native";
import type { Code } from "react-native-vision-camera";

export type { Code };

export type CameraAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

export interface CameraDeviceInfo {
  readonly id: string;
  readonly label: string;
  readonly position?: "back" | "front" | "external" | "unspecified";
  readonly rawDevice?: unknown;
}

export interface CameraViewfinderProps {
  style?: unknown;
  device: unknown;
  isActive: boolean;
  codeScanner: unknown;
  testID?: string;
}

export interface CameraHooks {
  useCameraPermission: () => {
    hasPermission: boolean;
    requestPermission: () => Promise<boolean>;
  };
  useCameraDevice: (position: "back" | "front") => unknown;
  useCameraDevices?: () => CameraDeviceInfo[];
  useCodeScanner: (options: { codeTypes: string[]; onCodeScanned: (codes: Code[]) => void }) => unknown;
}

export interface VisionCameraExports {
  Camera: ComponentType<CameraViewfinderProps> & {
    getAvailableCameraDevices?: () => Array<{ id: string; name?: string; position?: "back" | "front" | "external" }>;
  };
  useCameraPermission: () => {
    hasPermission: boolean;
    requestPermission: () => Promise<boolean>;
  };
  useCameraDevice: (position: "back" | "front") => unknown;
  useCameraDevices?: () => Array<{ id: string; name?: string; position?: "back" | "front" | "external" }>;
  useCodeScanner: (options: { codeTypes: string[]; onCodeScanned: (codes: Code[]) => void }) => unknown;
}

export interface CameraSeam {
  readonly availability: CameraAvailability;
  readonly loadModule?: () => Promise<VisionCameraExports | undefined>;
  readonly Camera?: ComponentType<CameraViewfinderProps>;
  readonly hooks?: CameraHooks;
}

export const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  ios: "iOS",
  android: "Android",
  web: "web",
  macos: "macOS",
  windows: "Windows",
};

/**
 * Whether the camera's native module is linked in this binary.
 *
 * Like probeImagePickerModule in attachments.ts: safely inspects the host's
 * TurboModule and native module registries without throwing.
 */
export function probeCameraModule(): unknown {
  if (Platform.OS === "web") return undefined;
  const host = globalThis as {
    __turboModuleProxy?: (name: string) => unknown;
    nativeModuleProxy?: Record<string, unknown>;
    RN$Bridgeless?: boolean;
    RN$TurboInterop?: boolean;
    RN$UnifiedNativeModuleProxy?: boolean;
  };
  try {
    const turbo = host.__turboModuleProxy?.("CameraView");
    if (turbo !== null && turbo !== undefined) return turbo;
    const legacyServed =
      host.RN$Bridgeless !== true || host.RN$TurboInterop === true || host.RN$UnifiedNativeModuleProxy === true;
    if (legacyServed && host.nativeModuleProxy?.CameraView !== undefined) {
      return host.nativeModuleProxy.CameraView;
    }
  } catch {
    // A host whose proxy refuses the name is a host without the module.
  }
  try {
    const native = (NativeModules as Readonly<Record<string, unknown>>).CameraView;
    if (native !== null && native !== undefined) return native;
  } catch {
    // Suppress
  }
  return undefined;
}

let cachedModule: VisionCameraExports | null = null;

/**
 * Load vision-camera exports dynamically only after the native module
 * has been proven present.
 *
 * Using dynamic import ensures that bundlers and runtimes do not evaluate
 * react-native-vision-camera at module evaluation time when the native module
 * is missing.
 */
export async function loadVisionCamera(): Promise<VisionCameraExports | undefined> {
  if (probeCameraModule() === undefined) return undefined;
  if (cachedModule !== null) return cachedModule;
  try {
    const mod = await import("react-native-vision-camera");
    cachedModule = mod as unknown as VisionCameraExports;
    return cachedModule;
  } catch {
    return undefined;
  }
}

/**
 * Bind camera scanning to an optional native module.
 */
function createVisionCameraDevicesHook(rawModule: VisionCameraExports): () => CameraDeviceInfo[] {
  if (typeof rawModule.useCameraDevices === "function") {
    const useDevices = rawModule.useCameraDevices;
    return () => {
      const list = useDevices();
      return Array.isArray(list)
        ? list.map(d => ({
            id: d.id,
            label: d.name ?? (d.position ? `${d.position.charAt(0).toUpperCase() + d.position.slice(1)} Camera` : d.id),
            position: d.position,
            rawDevice: d,
          }))
        : [];
    };
  }

  const useDevice = rawModule.useCameraDevice;
  return () => {
    const back = useDevice("back");
    const front = useDevice("front");
    const devices: CameraDeviceInfo[] = [];
    if (back) {
      const backObj = back as { id?: string; name?: string };
      devices.push({
        id: backObj.id ?? "back",
        label: backObj.name ?? "Back Camera",
        position: "back",
        rawDevice: back,
      });
    }
    if (front) {
      const frontObj = front as { id?: string; name?: string };
      const frontId = frontObj.id ?? "front";
      if (!devices.some(d => d.id === frontId)) {
        devices.push({
          id: frontId,
          label: frontObj.name ?? "Front Camera",
          position: "front",
          rawDevice: front,
        });
      }
    }
    return devices;
  };
}

export function createCameraSeam(
  rawModule: VisionCameraExports | undefined,
  platform: string = Platform.OS,
): CameraSeam {
  if (rawModule === undefined) {
    const name = PLATFORM_NAMES[platform] ?? platform;
    return {
      availability: {
        available: false,
        reason: `Scanning is unavailable on ${name}: this build has no camera scanner module.`,
      },
      loadModule: loadVisionCamera,
    };
  }
  return {
    availability: { available: true },
    Camera: rawModule.Camera,
    hooks: {
      useCameraPermission: rawModule.useCameraPermission,
      useCameraDevice: rawModule.useCameraDevice,
      useCameraDevices: createVisionCameraDevicesHook(rawModule),
      useCodeScanner: rawModule.useCodeScanner,
    },
    loadModule: async () => rawModule,
  };
}

const probed = probeCameraModule();

export const cameraAvailability: CameraAvailability =
  probed !== undefined
    ? { available: true }
    : {
        available: false,
        reason: `Scanning is unavailable on ${PLATFORM_NAMES[Platform.OS] ?? Platform.OS}: this build has no camera scanner module.`,
      };

export const cameraSeam: CameraSeam = {
  availability: cameraAvailability,
  loadModule: loadVisionCamera,
};
