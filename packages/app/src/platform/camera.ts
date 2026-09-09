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

import { NativeModules, Platform } from "react-native";
import type { ComponentType } from "react";
import type { Code } from "react-native-vision-camera";

export type { Code };

export type CameraAvailability = { readonly available: true } | { readonly available: false; readonly reason: string };

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
  useCodeScanner: (options: { codeTypes: string[]; onCodeScanned: (codes: Code[]) => void }) => unknown;
}

export interface VisionCameraExports {
  Camera: ComponentType<CameraViewfinderProps>;
  useCameraPermission: () => {
    hasPermission: boolean;
    requestPermission: () => Promise<boolean>;
  };
  useCameraDevice: (position: "back" | "front") => unknown;
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
