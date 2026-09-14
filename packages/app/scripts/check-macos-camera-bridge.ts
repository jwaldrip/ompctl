#!/usr/bin/env bun
/**
 * Verifies that the TypeScript macOS camera module agrees with the native
 * Objective-C bridge declarations in OmpctlCamera.m.
 *
 * In React Native macOS/iOS, bridge dispatch extracts arguments using the
 * parameter count declared by RCT_EXTERN_METHOD. If JavaScript passes an
 * unexpected number of arguments (such as passing a device ID to a zero-arg
 * startSession promise), the bridge throws an NSRangeException on argument
 * unpacking and terminates the application.
 *
 * This check runs on Linux in CI without requiring Xcode or a macOS runtime.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface NativeBridgeParam {
  readonly type: string;
  readonly name: string;
}

export interface NativeBridgeMethod {
  readonly jsName: string;
  readonly isPromise: boolean;
  readonly jsArity: number;
  readonly paramCount: number;
  readonly params: readonly NativeBridgeParam[];
  readonly rawDeclaration: string;
}

export interface TsInterfaceMethod {
  readonly name: string;
  readonly minArity: number;
  readonly maxArity: number;
  readonly line: number;
}

export interface ActiveModuleCall {
  readonly method: string;
  readonly argCount: number;
  readonly line: number;
  readonly argsText: string;
}

export interface BridgeViolation {
  readonly kind: "interface-mismatch" | "call-site-mismatch" | "missing-bridge-method";
  readonly method: string;
  readonly message: string;
  readonly line?: number;
}

export interface BridgeCheckReport {
  readonly methods: ReadonlyMap<string, NativeBridgeMethod>;
  readonly interfaceMethods: ReadonlyMap<string, TsInterfaceMethod>;
  readonly callSites: readonly ActiveModuleCall[];
  readonly violations: readonly BridgeViolation[];
  readonly passed: boolean;
}

/**
 * Parses RCT_EXTERN_METHOD declarations from Objective-C companion files.
 */
export function parseObjcBridgeDeclarations(source: string): Map<string, NativeBridgeMethod> {
  const markerRegex = /\bRCT_EXTERN_METHOD\s*\(/g;
  const methods = new Map<string, NativeBridgeMethod>();

  for (const match of source.matchAll(markerRegex)) {
    const matchIndex = match.index ?? 0;
    let depth = 1;
    let curr = matchIndex + match[0].length;
    while (curr < source.length && depth > 0) {
      if (source[curr] === "(") depth++;
      else if (source[curr] === ")") depth--;
      curr++;
    }
    const body = source
      .slice(matchIndex + match[0].length, curr - 1)
      .replace(/\s+/g, " ")
      .trim();
    const firstColon = body.indexOf(":");
    let jsName = "";
    const params: NativeBridgeParam[] = [];

    if (firstColon === -1) {
      jsName = body;
    } else {
      jsName = body.slice(0, firstColon).trim();
      const paramRegex = /:\s*\(([^)]+)\)\s*([a-zA-Z0-9_]*)/g;
      for (const pMatch of body.matchAll(paramRegex)) {
        params.push({
          type: (pMatch[1] ?? "").trim(),
          name: (pMatch[2] ?? "").trim(),
        });
      }
    }

    const isPromise =
      params.length >= 2 &&
      (params[params.length - 2]?.type.includes("RCTPromiseResolveBlock") ?? false) &&
      (params[params.length - 1]?.type.includes("RCTPromiseRejectBlock") ?? false);

    const jsArity = isPromise ? params.length - 2 : params.length;

    methods.set(jsName, {
      jsName,
      isPromise,
      jsArity,
      paramCount: params.length,
      params,
      rawDeclaration: body,
    });
  }

  return methods;
}

/**
 * Extracts method signatures on OmpctlCameraNativeModule from camera.macos.ts.
 */
export function parseTsInterfaceMethods(
  source: string,
  interfaceName = "OmpctlCameraNativeModule",
): Map<string, TsInterfaceMethod> {
  const marker = new RegExp(`\\binterface\\s+${interfaceName}\\s*\\{`);
  const match = marker.exec(source);
  const methods = new Map<string, TsInterfaceMethod>();
  if (!match) return methods;

  const openBrace = match.index + match[0].length - 1;
  let depth = 1;
  let curr = openBrace + 1;
  while (curr < source.length && depth > 0) {
    if (source[curr] === "{") depth++;
    else if (source[curr] === "}") depth--;
    curr++;
  }
  const body = source.slice(openBrace + 1, curr - 1);
  const lines = body.split("\n");
  const startLine = source.slice(0, openBrace).split("\n").length;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("/*")) continue;

    // Match property or method declarations
    const nameMatch = /^([a-zA-Z0-9_]+)\??\s*(\(|:\s*\()/.exec(line);
    if (!nameMatch?.[1]) continue;
    const name = nameMatch[1];
    const openParen = line.indexOf("(", nameMatch[0].length - 1);
    if (openParen === -1) continue;

    let pDepth = 1;
    let pCurr = openParen + 1;
    while (pCurr < line.length && pDepth > 0) {
      if (line[pCurr] === "(") pDepth++;
      else if (line[pCurr] === ")") pDepth--;
      pCurr++;
    }
    const paramsText = line.slice(openParen + 1, pCurr - 1).trim();

    let minArity = 0;
    let maxArity = 0;
    if (paramsText.length > 0) {
      const parts: string[] = [];
      let d = 0;
      let start = 0;
      for (let j = 0; j < paramsText.length; j++) {
        const ch = paramsText[j];
        if (ch === "(" || ch === "{" || ch === "[") d++;
        else if (ch === ")" || ch === "}" || ch === "]") d--;
        else if (ch === "," && d === 0) {
          parts.push(paramsText.slice(start, j).trim());
          start = j + 1;
        }
      }
      parts.push(paramsText.slice(start).trim());
      maxArity = parts.length;
      minArity = parts.filter(p => !p.includes("?") && !p.includes("=")).length;
    }

    methods.set(name, {
      name,
      minArity,
      maxArity,
      line: startLine + i,
    });
  }

  return methods;
}

/**
 * Locates all activeModule.<method>(...) invocations in camera.macos.ts.
 */
export function parseActiveModuleCalls(source: string): ActiveModuleCall[] {
  const callRegex = /\bactiveModule\.([a-zA-Z0-9_]+)\s*\(/g;
  const calls: ActiveModuleCall[] = [];

  for (const match of source.matchAll(callRegex)) {
    const matchIndex = match.index ?? 0;
    const method = match[1] ?? "";
    const openParen = matchIndex + match[0].length - 1;
    let depth = 1;
    let curr = openParen + 1;
    let inString = false;
    let stringChar = "";

    while (curr < source.length && depth > 0) {
      const ch = source[curr];
      if (inString) {
        if (ch === stringChar && source[curr - 1] !== "\\") inString = false;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        inString = true;
        stringChar = ch;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
      }
      curr++;
    }

    const argsText = source.slice(openParen + 1, curr - 1).trim();
    let argCount = 0;

    if (argsText.length > 0) {
      argCount = 1;
      let d = 0;
      let inStr = false;
      let sChar = "";
      for (let i = 0; i < argsText.length; i++) {
        const c = argsText[i];
        if (inStr) {
          if (c === sChar && argsText[i - 1] !== "\\") inStr = false;
        } else if (c === '"' || c === "'" || c === "`") {
          inStr = true;
          sChar = c;
        } else if (c === "(" || c === "[" || c === "{") {
          d++;
        } else if (c === ")" || c === "]" || c === "}") {
          d--;
        } else if (c === "," && d === 0) {
          argCount++;
        }
      }
    }

    const line = source.slice(0, matchIndex).split("\n").length;
    calls.push({ method, argCount, line, argsText });
  }

  return calls;
}

/**
 * Validates TypeScript module declarations and call sites against OmpctlCamera.m.
 */
export function verifyBridgeContract(mSource: string, tsSource: string): BridgeCheckReport {
  const methods = parseObjcBridgeDeclarations(mSource);
  const interfaceMethods = parseTsInterfaceMethods(tsSource);
  const callSites = parseActiveModuleCalls(tsSource);
  const violations: BridgeViolation[] = [];

  // 1. Check TypeScript interface definitions against declared native methods
  for (const [name, tsMethod] of interfaceMethods) {
    // addListener on withEventStream is augmented to return an event subscription in JS
    if (name === "addListener") continue;

    const nativeMethod = methods.get(name);
    if (!nativeMethod) {
      violations.push({
        kind: "missing-bridge-method",
        method: name,
        line: tsMethod.line,
        message: `TypeScript interface declares method "${name}", but OmpctlCamera.m has no matching RCT_EXTERN_METHOD`,
      });
      continue;
    }

    // A method expecting 0 JS arguments must not accept arguments in TypeScript
    if (nativeMethod.jsArity === 0 && tsMethod.maxArity > 0) {
      violations.push({
        kind: "interface-mismatch",
        method: name,
        line: tsMethod.line,
        message: `TypeScript interface for "${name}" accepts up to ${tsMethod.maxArity} argument(s), but OmpctlCamera.m declares JS arity 0. Passing arguments to a zero-arity bridge method causes an NSRangeException crash.`,
      });
    }
    // A method expecting N JS arguments must accept at least N arguments
    if (nativeMethod.jsArity > 0 && tsMethod.maxArity < nativeMethod.jsArity) {
      violations.push({
        kind: "interface-mismatch",
        method: name,
        line: tsMethod.line,
        message: `TypeScript interface for "${name}" only accepts ${tsMethod.maxArity} argument(s), but OmpctlCamera.m declares JS arity ${nativeMethod.jsArity}.`,
      });
    }
  }

  // 2. Check call sites in camera.macos.ts
  for (const call of callSites) {
    // addListener on activeModule is called through the wrapped event stream
    if (call.method === "addListener") continue;

    const nativeMethod = methods.get(call.method);
    if (!nativeMethod) {
      violations.push({
        kind: "missing-bridge-method",
        method: call.method,
        line: call.line,
        message: `Call site calls activeModule.${call.method}(), but OmpctlCamera.m declares no such method.`,
      });
      continue;
    }

    if (nativeMethod.jsArity !== call.argCount) {
      violations.push({
        kind: "call-site-mismatch",
        method: call.method,
        line: call.line,
        message: `Call site activeModule.${call.method}(${call.argsText}) passes ${call.argCount} argument(s), but OmpctlCamera.m declares JS arity ${nativeMethod.jsArity}.`,
      });
    }
  }

  return {
    methods,
    interfaceMethods,
    callSites,
    violations,
    passed: violations.length === 0,
  };
}

/**
 * Wraps a native module stub in a Proxy that asserts every call obeys OmpctlCamera.m.
 */
export function createBridgeCheckedStub<T extends object>(
  stub: T,
  bridgeMethods?: ReadonlyMap<string, NativeBridgeMethod>,
): T {
  const declarations =
    bridgeMethods ??
    (() => {
      try {
        const defaultMPath = resolve(import.meta.dirname, "../macos/ompd-macOS/OmpctlCamera.m");
        return parseObjcBridgeDeclarations(readFileSync(defaultMPath, "utf8"));
      } catch {
        return new Map<string, NativeBridgeMethod>();
      }
    })();

  return new Proxy(stub, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || typeof orig !== "function") {
        return orig;
      }

      // Allow test-only helper methods and event emitter subscriptions
      if (prop === "emit" || prop === "listeners" || prop === "addListener") {
        return orig;
      }

      return (...args: unknown[]) => {
        const decl = declarations.get(prop);
        if (decl !== undefined) {
          if (decl.jsArity === 0 && args.length > 0) {
            throw new Error(
              `Native bridge contract violation: OmpctlCamera.${prop} expects 0 arguments (per OmpctlCamera.m), but was called with ${args.length} argument(s): [${args.map(a => JSON.stringify(a)).join(", ")}]. In React Native, this mismatch causes an NSRangeException crash.`,
            );
          }
          if (decl.jsArity > 0 && args.length !== decl.jsArity) {
            throw new Error(
              `Native bridge contract violation: OmpctlCamera.${prop} expects ${decl.jsArity} argument(s) (per OmpctlCamera.m), but was called with ${args.length} argument(s): [${args.map(a => JSON.stringify(a)).join(", ")}].`,
            );
          }
        }
        return (orig as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

function main(): void {
  const appRoot = resolve(import.meta.dirname, "..");
  const mPath = resolve(appRoot, "macos/ompd-macOS/OmpctlCamera.m");
  const tsPath = resolve(appRoot, "src/platform/camera.macos.ts");

  const mSource = readFileSync(mPath, "utf8");
  const tsSource = readFileSync(tsPath, "utf8");

  const report = verifyBridgeContract(mSource, tsSource);

  console.log("Objective-C RCT_EXTERN_METHOD bridge declarations in OmpctlCamera.m:");
  for (const [name, info] of report.methods) {
    const kind = info.isPromise ? "Promise" : "Callback/Normal";
    console.log(`  - ${name} (JS arity: ${info.jsArity}, ${kind}, declared native params: ${info.paramCount})`);
  }

  if (!report.passed) {
    console.error(`\nFound ${report.violations.length} bridge contract violation(s):`);
    for (const v of report.violations) {
      const loc = v.line ? ` line ${v.line}:` : "";
      console.error(`  [${v.kind}]${loc} ${v.message}`);
    }
    process.exit(1);
  }

  console.log(`\nOK: macOS camera bridge contract verified (${report.methods.size} methods checked, 0 violations).`);
}
if (import.meta.main || process.argv[1]?.endsWith("check-macos-camera-bridge.ts")) {
  main();
}
