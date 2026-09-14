/**
 * Bridge contract tests for macOS camera capture.
 *
 * Verifies that:
 * 1. OmpctlCamera.m method declarations are parsed into their exact JavaScript names and arities.
 * 2. Promise methods strip the trailing resolver and rejecter blocks from their JS arity.
 * 3. camera.macos.ts satisfies the OmpctlCamera.m contract with zero violations.
 * 4. Re-introducing the argument-count mismatch (passing deviceId to startSession) fails.
 * 5. Re-introducing the interface mismatch (declaring startSession with parameters) fails.
 * 6. Runtime proxy stubs intercept invalid calls and throw before reaching bridge execution.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createBridgeCheckedStub,
  parseObjcBridgeDeclarations,
  verifyBridgeContract,
} from "../scripts/check-macos-camera-bridge.ts";

const appRoot = resolve(import.meta.dirname, "..");
const mPath = resolve(appRoot, "macos/ompd-macOS/OmpctlCamera.m");
const tsPath = resolve(appRoot, "src/platform/camera.macos.ts");

describe("macOS Camera Bridge Contract", () => {
  test("parses every RCT_EXTERN_METHOD in OmpctlCamera.m with exact JS name and arity", () => {
    const mSource = readFileSync(mPath, "utf8");
    const methods = parseObjcBridgeDeclarations(mSource);

    expect(methods.has("hasCamera")).toBe(true);
    expect(methods.get("hasCamera")?.jsArity).toBe(0);
    expect(methods.get("hasCamera")?.isPromise).toBe(true);

    expect(methods.has("getAvailableDevices")).toBe(true);
    expect(methods.get("getAvailableDevices")?.jsArity).toBe(0);
    expect(methods.get("getAvailableDevices")?.isPromise).toBe(true);

    expect(methods.has("checkPermission")).toBe(true);
    expect(methods.get("checkPermission")?.jsArity).toBe(0);
    expect(methods.get("checkPermission")?.isPromise).toBe(true);

    expect(methods.has("requestPermission")).toBe(true);
    expect(methods.get("requestPermission")?.jsArity).toBe(0);
    expect(methods.get("requestPermission")?.isPromise).toBe(true);

    // startSession is a zero-arg promise method
    expect(methods.has("startSession")).toBe(true);
    expect(methods.get("startSession")?.jsArity).toBe(0);
    expect(methods.get("startSession")?.isPromise).toBe(true);

    // startSessionWithDevice accepts one argument: deviceId (nullable NSString)
    expect(methods.has("startSessionWithDevice")).toBe(true);
    expect(methods.get("startSessionWithDevice")?.jsArity).toBe(1);
    expect(methods.get("startSessionWithDevice")?.isPromise).toBe(true);

    expect(methods.has("stopSession")).toBe(true);
    expect(methods.get("stopSession")?.jsArity).toBe(0);
    expect(methods.get("stopSession")?.isPromise).toBe(true);

    expect(methods.has("addListener")).toBe(true);
    expect(methods.get("addListener")?.jsArity).toBe(1);
    expect(methods.get("addListener")?.isPromise).toBe(false);
    expect(methods.has("removeListeners")).toBe(true);
    expect(methods.get("removeListeners")?.jsArity).toBe(1);
    expect(methods.get("removeListeners")?.isPromise).toBe(false);
  });

  test("camera.macos.ts satisfies the OmpctlCamera.m bridge contract", () => {
    const mSource = readFileSync(mPath, "utf8");
    const tsSource = readFileSync(tsPath, "utf8");
    const report = verifyBridgeContract(mSource, tsSource);

    expect(report.violations).toEqual([]);
    expect(report.passed).toBe(true);
  });

  test("detects and rejects call-site arity mismatch when deviceId is passed to startSession", () => {
    const mSource = readFileSync(mPath, "utf8");
    // Synthetic source simulating the PR #222 regression at the call site
    const brokenTsSource = `
      export interface OmpctlCameraNativeModule {
        startSessionWithDevice: (deviceId: string | null) => Promise<void>;
        stopSession: () => Promise<void>;
      }
      function run(activeModule: OmpctlCameraNativeModule, selectedDeviceId?: string) {
        void activeModule.startSession(selectedDeviceId === "default" ? undefined : selectedDeviceId);
      }
    `;

    const report = verifyBridgeContract(mSource, brokenTsSource);
    expect(report.passed).toBe(false);
    const callMismatch = report.violations.find(v => v.kind === "call-site-mismatch" && v.method === "startSession");
    expect(callMismatch).toBeDefined();
    expect(callMismatch?.message).toContain("OmpctlCamera.m declares JS arity 0");
  });

  test("detects and rejects interface mismatch when startSession allows parameters in TypeScript", () => {
    const mSource = readFileSync(mPath, "utf8");
    // Synthetic source simulating the interface describing a method signature the bridge lacks
    const brokenTsSource = `
      export interface OmpctlCameraNativeModule {
        startSession: (deviceId?: string) => Promise<void>;
      }
    `;

    const report = verifyBridgeContract(mSource, brokenTsSource);
    expect(report.passed).toBe(false);
    const ifaceMismatch = report.violations.find(v => v.kind === "interface-mismatch" && v.method === "startSession");
    expect(ifaceMismatch).toBeDefined();
    expect(ifaceMismatch?.message).toContain("accepts up to 1 argument(s), but OmpctlCamera.m declares JS arity 0");
  });

  test("detects and rejects call-site arity mismatch when addListener is called with 2 arguments", () => {
    const mSource = readFileSync(mPath, "utf8");
    const brokenTsSource = `
      export interface OmpctlCameraNativeModule {
        addListener?: (eventName: string) => void;
      }
      function subscribe(activeModule: OmpctlCameraNativeModule) {
        activeModule.addListener("onCodeScanned", () => {});
      }
    `;

    const report = verifyBridgeContract(mSource, brokenTsSource);
    expect(report.passed).toBe(false);
    const callMismatch = report.violations.find(v => v.kind === "call-site-mismatch" && v.method === "addListener");
    expect(callMismatch).toBeDefined();
    expect(callMismatch?.message).toContain("passes 2 argument(s), but OmpctlCamera.m declares JS arity 1");
  });

  test("detects and rejects interface mismatch when addListener declares two arguments in TypeScript", () => {
    const mSource = readFileSync(mPath, "utf8");
    const brokenTsSource = `
      export interface OmpctlCameraNativeModule {
        addListener(eventName: string, listener: (data: unknown) => void): { remove(): void };
      }
    `;

    const report = verifyBridgeContract(mSource, brokenTsSource);
    expect(report.passed).toBe(false);
    const ifaceMismatch = report.violations.find(v => v.kind === "interface-mismatch" && v.method === "addListener");
    expect(ifaceMismatch).toBeDefined();
    expect(ifaceMismatch?.message).toContain("accepts 2 argument(s), but OmpctlCamera.m declares JS arity 1");
  });

  test("detects native call-site mismatch when native.addListener is probed with two arguments", () => {
    const mSource = readFileSync(mPath, "utf8");
    const brokenTsSource = `
      export interface OmpctlCameraNativeModule {
        addListener?: (eventName: string) => void;
      }
      function probe(native: OmpctlCameraNativeModule) {
        native.addListener("test_probe", () => {});
      }
    `;

    const report = verifyBridgeContract(mSource, brokenTsSource);
    expect(report.passed).toBe(false);
    const callMismatch = report.violations.find(v => v.kind === "call-site-mismatch" && v.method === "addListener");
    expect(callMismatch).toBeDefined();
    expect(callMismatch?.message).toContain("Call site native.addListener");
    expect(callMismatch?.message).toContain("passes 2 argument(s), but OmpctlCamera.m declares JS arity 1");
  });

  test("createBridgeCheckedStub proxy intercepts arity violations before native dispatch", async () => {
    const startSessionHistory: unknown[][] = [];
    const startSessionWithDeviceHistory: Array<string | null> = [];

    const rawStub = {
      startSession: async () => {
        startSessionHistory.push([]);
      },
      startSessionWithDevice: async (deviceId: string | null) => {
        startSessionWithDeviceHistory.push(deviceId);
      },
      addListener: (_eventName: string) => {},
    };

    const guardedStub = createBridgeCheckedStub(rawStub);

    // startSessionWithDevice with 1 argument is valid
    await guardedStub.startSessionWithDevice("built-in-camera");
    expect(startSessionWithDeviceHistory).toEqual(["built-in-camera"]);

    await guardedStub.startSessionWithDevice(null);
    expect(startSessionWithDeviceHistory).toEqual(["built-in-camera", null]);

    // startSession with 0 arguments is valid
    await guardedStub.startSession();
    expect(startSessionHistory).toEqual([[]]);

    // startSession called with an argument throws immediately with the NSRangeException explanation
    expect(() => {
      const untyped = guardedStub as { startSession: (arg: string) => Promise<void> };
      untyped.startSession("unsupported-device-id");
    }).toThrow(/Native bridge contract violation: OmpctlCamera.startSession expects 0 arguments/);

    // addListener called with 2 arguments throws immediately
    expect(() => {
      const untyped = guardedStub as unknown as { addListener: (event: string, cb: () => void) => void };
      untyped.addListener("onCodeScanned", () => {});
    }).toThrow(/Native bridge contract violation: OmpctlCamera.addListener expects 1 argument\(s\)/);
  });
});
