/**
 * Persistent camera choice preference for the QR pairing scanner.
 *
 * Saves and restores the chosen camera device ID across launches.
 * Reuses the same storage seam as connection.ts and view-prefs.ts:
 * AsyncStorage on native, localStorage on web.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

export const CAMERA_PREFS_KEY = "ompd.scan.camera";

export interface CameraPrefs {
  readonly deviceId: string | null;
}

export const DEFAULT_CAMERA_PREFS: CameraPrefs = {
  deviceId: null,
};

export function coerceCameraPrefs(value: unknown): CameraPrefs {
  if (typeof value !== "object" || value === null) return DEFAULT_CAMERA_PREFS;
  const raw = value as Record<string, unknown>;
  const deviceId = typeof raw.deviceId === "string" && raw.deviceId.trim().length > 0 ? raw.deviceId.trim() : null;
  return { deviceId };
}

export async function loadCameraPrefs(): Promise<CameraPrefs> {
  try {
    const raw = await AsyncStorage.getItem(CAMERA_PREFS_KEY);
    if (raw === null) return DEFAULT_CAMERA_PREFS;
    return coerceCameraPrefs(JSON.parse(raw));
  } catch {
    return DEFAULT_CAMERA_PREFS;
  }
}

export async function saveCameraPrefs(prefs: CameraPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(CAMERA_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Failure to persist UI preferences is non-fatal.
  }
}
