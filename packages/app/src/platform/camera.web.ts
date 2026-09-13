/**
 * The web target's camera seam.
 *
 * Implements camera scanning in the browser using the web platform's standard
 * APIs: navigator.mediaDevices.getUserMedia for the video stream and the native
 * BarcodeDetector API (available in Chromium browsers) for QR decoding.
 *
 * Browsers lacking BarcodeDetector (Safari desktop, Firefox) report an honest
 * refusal naming the browser requirement rather than presenting a broken
 * viewfinder that can never decode.
 */

import type { ComponentType } from "react";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { StyleSheet, View } from "react-native";
import { ground } from "../design/tokens.ts";
import type { CameraAvailability, CameraSeam, CameraViewfinderProps, Code, VisionCameraExports } from "./camera.ts";

export type {
  CameraAvailability,
  CameraHooks,
  CameraSeam,
  CameraViewfinderProps,
  Code,
  VisionCameraExports,
} from "./camera.ts";

export interface DetectedBarcode {
  readonly rawValue?: string;
  readonly value?: string;
  readonly format?: string;
}

export interface BarcodeDetectorInstance {
  detect(image: unknown): Promise<DetectedBarcode[]>;
}

export interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
}

export interface WebCameraOptions {
  isSecureContext?: boolean;
  mediaDevices?: {
    getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  } | null;
  BarcodeDetector?: BarcodeDetectorConstructor | null;
  devices?: Array<{ deviceId?: string; kind: string; label?: string }>;
  permissionState?: "granted" | "denied" | "prompt";
}

/**
 * Probes whether the web environment supports camera scanning.
 * Each unavailable condition returns a distinct reason.
 */
export function probeWebCameraAvailability(options?: WebCameraOptions): CameraAvailability {
  const isSecure =
    options?.isSecureContext ??
    (typeof window !== "undefined"
      ? (window.isSecureContext ??
        (window.location?.hostname === "localhost" || window.location?.hostname === "127.0.0.1"))
      : false);

  if (!isSecure) {
    return {
      available: false,
      reason: "Scanning is unavailable on web: camera access requires a secure context (HTTPS or localhost).",
    };
  }

  const mediaDevices =
    options?.mediaDevices !== undefined
      ? options.mediaDevices
      : typeof navigator !== "undefined"
        ? navigator.mediaDevices
        : undefined;

  if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
    return {
      available: false,
      reason: "Scanning is unavailable on web: this browser does not support media device camera access.",
    };
  }

  const detector =
    options?.BarcodeDetector !== undefined
      ? options.BarcodeDetector
      : typeof globalThis !== "undefined" && "BarcodeDetector" in globalThis
        ? (globalThis as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector
        : undefined;

  if (!detector || typeof detector !== "function") {
    return {
      available: false,
      reason: "Scanning is unavailable on web: BarcodeDetector is not supported (Chrome, Edge, or Chromium required).",
    };
  }

  if (options?.devices !== undefined && options.devices.filter(d => d.kind === "videoinput").length === 0) {
    return {
      available: false,
      reason: "Scanning is unavailable on web: no camera device was found on this machine.",
    };
  }

  if (options?.permissionState === "denied") {
    return {
      available: false,
      reason: "Scanning is unavailable on web: camera permission was denied. Allow camera access in browser settings.",
    };
  }

  return { available: true };
}

function setVideoSrcObject(video: HTMLVideoElement | null, stream: MediaStream | null): void {
  if (!video) return;
  try {
    video.srcObject = stream;
  } catch {
    try {
      Object.defineProperty(video, "srcObject", {
        value: stream,
        writable: true,
        configurable: true,
      });
    } catch {
      // Ignore if property cannot be redefined
    }
  }
}

export function WebCameraViewfinder({
  style,
  isActive,
  codeScanner,
  testID,
  options,
}: CameraViewfinderProps & { options?: WebCameraOptions }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const scannerOptions =
    codeScanner !== null && typeof codeScanner === "object" && "onCodeScanned" in codeScanner
      ? (codeScanner as { onCodeScanned?: (codes: Code[]) => void })
      : undefined;
  const onCodeScanned = scannerOptions?.onCodeScanned;

  useEffect(() => {
    if (!isActive) {
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
      setVideoSrcObject(videoRef.current, null);
      return;
    }

    let cancelled = false;
    const constraints: MediaStreamConstraints = {
      video: { facingMode: "environment" },
      audio: false,
    };

    const startStream = async () => {
      try {
        const mediaDevices =
          options?.mediaDevices !== undefined
            ? options.mediaDevices
            : typeof navigator !== "undefined"
              ? navigator.mediaDevices
              : undefined;

        if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") return;
        const stream = await mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          setVideoSrcObject(videoRef.current, stream);
          void videoRef.current.play().catch(() => {});
        }
      } catch {
        // Stream request rejected or cancelled
      }
    };

    void startStream();

    return () => {
      cancelled = true;
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
      setVideoSrcObject(videoRef.current, null);
    };
  }, [isActive, options]);

  useEffect(() => {
    if (!isActive || !onCodeScanned) return;

    const DetectorClass =
      options?.BarcodeDetector !== undefined
        ? options.BarcodeDetector
        : typeof globalThis !== "undefined" && "BarcodeDetector" in globalThis
          ? (globalThis as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector
          : undefined;

    if (!DetectorClass) return;

    let detector: BarcodeDetectorInstance;
    try {
      detector = new DetectorClass({ formats: ["qr_code"] });
    } catch {
      try {
        detector = new DetectorClass();
      } catch {
        return;
      }
    }

    let scanning = true;
    let busy = false;
    let timerId: number | null = null;
    let rafId: number | null = null;

    const detectFrame = async () => {
      if (!scanning) return;
      const video = videoRef.current;
      if (video && !busy) {
        const hasFrame =
          video.readyState >= 2 || (video.videoWidth > 0 && video.videoHeight > 0) || video.srcObject !== null;

        if (hasFrame) {
          busy = true;
          try {
            const results = await detector.detect(video);
            if (scanning && results && results.length > 0) {
              const codes: Code[] = results.map(b => {
                const raw =
                  b && typeof b === "object"
                    ? "rawValue" in b && typeof b.rawValue === "string"
                      ? b.rawValue
                      : "value" in b && typeof b.value === "string"
                        ? b.value
                        : undefined
                    : undefined;
                return { value: raw, type: "qr" };
              });
              onCodeScanned(codes);
            }
          } catch {
            // Frame read or decode failure, continue
          } finally {
            busy = false;
          }
        }
      }

      if (scanning) {
        timerId = setTimeout(() => {
          if (scanning) {
            if (typeof requestAnimationFrame === "function") {
              rafId = requestAnimationFrame(detectFrame);
            } else {
              void detectFrame();
            }
          }
        }, 100) as unknown as number;
      }
    };

    if (typeof requestAnimationFrame === "function") {
      rafId = requestAnimationFrame(detectFrame);
    } else {
      timerId = setTimeout(detectFrame, 50) as unknown as number;
    }

    return () => {
      scanning = false;
      if (rafId !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(rafId);
      }
      clearTimeout(timerId as number);
    };
  }, [isActive, onCodeScanned, options]);

  return createElement(
    View,
    { style: [styles.container, style as StyleProp<ViewStyle>], testID },
    createElement("video", {
      ref: videoRef,
      autoPlay: true,
      playsInline: true,
      muted: true,
      style: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
      },
    }),
  );
}

function useWebCameraPermission(options?: WebCameraOptions) {
  const [hasPermission, setHasPermission] = useState<boolean>(() => {
    if (options?.permissionState === "granted") return true;
    if (options?.permissionState === "denied") return false;
    return false;
  });

  useEffect(() => {
    if (options?.permissionState !== undefined) {
      setHasPermission(options.permissionState === "granted");
      return;
    }
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return;
    let active = true;
    void navigator.permissions
      .query({ name: "camera" as PermissionName })
      .then(status => {
        if (!active) return;
        setHasPermission(status.state === "granted");
        status.onchange = () => {
          if (active) setHasPermission(status.state === "granted");
        };
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [options?.permissionState]);

  const requestPermission = useCallback(async () => {
    try {
      const mediaDevices =
        options?.mediaDevices !== undefined
          ? options.mediaDevices
          : typeof navigator !== "undefined"
            ? navigator.mediaDevices
            : undefined;

      if (!mediaDevices || typeof mediaDevices.getUserMedia !== "function") {
        setHasPermission(false);
        return false;
      }
      const stream = await mediaDevices.getUserMedia({ video: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      setHasPermission(true);
      return true;
    } catch {
      setHasPermission(false);
      return false;
    }
  }, [options?.mediaDevices]);

  return { hasPermission, requestPermission };
}

function useWebCameraDevice(position: "back" | "front", options?: WebCameraOptions) {
  const [device, setDevice] = useState<unknown>(() => {
    if (options?.devices !== undefined) {
      const matching = options.devices.filter(d => d.kind === "videoinput");
      return matching.length > 0 ? { id: matching[0]?.deviceId || "web-camera", position } : undefined;
    }
    return { id: "web-camera", position };
  });

  useEffect(() => {
    if (options?.devices !== undefined) {
      const matching = options.devices.filter(d => d.kind === "videoinput");
      setDevice(matching.length > 0 ? { id: matching[0]?.deviceId || "web-camera", position } : undefined);
      return;
    }
    const mediaDevices =
      options?.mediaDevices !== undefined
        ? options.mediaDevices
        : typeof navigator !== "undefined"
          ? navigator.mediaDevices
          : undefined;

    if (!mediaDevices?.enumerateDevices) return;

    let active = true;
    void mediaDevices
      .enumerateDevices()
      .then(devices => {
        if (!active) return;
        const videoDevices = devices.filter(d => d.kind === "videoinput");
        if (videoDevices.length === 0) {
          setDevice(undefined);
        } else {
          setDevice({ id: videoDevices[0]?.deviceId || "web-camera", position });
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [position, options]);

  return device;
}

function useWebCodeScanner(options: { codeTypes: string[]; onCodeScanned: (codes: Code[]) => void }) {
  return options;
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
    backgroundColor: ground.base,
  },
});

export const cameraAvailability: CameraAvailability = probeWebCameraAvailability();

export function createCameraSeam(rawModuleOrOptions?: VisionCameraExports | WebCameraOptions): CameraSeam {
  if (rawModuleOrOptions && "Camera" in rawModuleOrOptions && "useCameraPermission" in rawModuleOrOptions) {
    const rawModule = rawModuleOrOptions as VisionCameraExports;
    return {
      availability: { available: true },
      Camera: rawModule.Camera,
      hooks: {
        useCameraPermission: rawModule.useCameraPermission,
        useCameraDevice: rawModule.useCameraDevice,
        useCodeScanner: rawModule.useCodeScanner,
      },
    };
  }

  const options = rawModuleOrOptions as WebCameraOptions | undefined;
  const availability = probeWebCameraAvailability(options);

  if (!availability.available) {
    return {
      availability,
    };
  }

  const Camera: ComponentType<CameraViewfinderProps> = props =>
    createElement(WebCameraViewfinder, { ...props, options });

  return {
    availability,
    Camera,
    hooks: {
      useCameraPermission: () => useWebCameraPermission(options),
      useCameraDevice: pos => useWebCameraDevice(pos, options),
      useCodeScanner: useWebCodeScanner,
    },
  };
}

export const cameraSeam: CameraSeam = createCameraSeam();

export function probeCameraModule(): undefined {
  return undefined;
}

export async function loadVisionCamera(): Promise<undefined> {
  return undefined;
}
