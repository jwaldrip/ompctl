import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getAgentDir, MAIN_CONFIG_FILENAMES } from "@oh-my-pi/pi-utils";
import type { PolicyMode } from "@ompd/core";
import { YAML } from "bun";
import type { OmpdConfig } from "./daemon.ts";

export type OmpApprovalMode = "always-ask" | "write" | "yolo";
export type PolicyModeSource = "override" | "file" | "omp" | "default";

export interface OmpApprovalResolveOptions {
  agentDir?: string;
  cwd?: string;
  configFiles?: string[];
}

export interface LoadConfigOptions extends OmpApprovalResolveOptions {
  ompAgentDir?: string;
}

/**
 * Resolve a dotted config key (e.g. `tools.approvalMode`) against a parsed YAML
 * record, accepting both nested form (`tools: { approvalMode: "yolo" }`) and flat
 * literal-dot key (`"tools.approvalMode": "yolo"`). Nested wins when both are present.
 */
function readDottedString(record: unknown, dottedKey: string): string | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) return undefined;
  let current: unknown = record;
  for (const segment of dottedKey.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      current = undefined;
      break;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string") return current;
  const flat = (record as Record<string, unknown>)[dottedKey];
  return typeof flat === "string" ? flat : undefined;
}

export function resolveAgentDir(customDir?: string): string {
  if (customDir) return path.resolve(customDir);
  if (process.env.PI_CODING_AGENT_DIR) return path.resolve(process.env.PI_CODING_AGENT_DIR);
  if (process.env.PI_CONFIG_DIR) return path.join(homedir(), process.env.PI_CONFIG_DIR, "agent");
  try {
    return getAgentDir();
  } catch {
    return path.join(homedir(), ".omp", "agent");
  }
}

/**
 * Synchronously reads the operator's OMP `tools.approvalMode` directly from YAML config
 * files, matching OMP's own precedence:
 *   1. Config overlays (passed files or `PI_CONFIG_FILES`)
 *   2. Project-level config (`.omp/config.yml` / `.omp/config.yaml`)
 *   3. Global-level config (`<agentDir>/config.yml` / `<agentDir>/config.yaml`)
 *
 * This synchronous resolver is required because `loadConfig`, `new Ompd()`, and the
 * CLI/daemon boot path are strictly synchronous, while OMP's `Settings.loadReadOnly`
 * export is async-only.
 */
export function resolveOmpApprovalModeSync(options: OmpApprovalResolveOptions = {}): OmpApprovalMode | undefined {
  const candidateFiles: string[] = [];

  // 1. Config overlays
  const overlayFiles = options.configFiles ?? process.env.PI_CONFIG_FILES?.split(path.delimiter).filter(Boolean) ?? [];
  for (const file of overlayFiles) {
    candidateFiles.push(path.resolve(options.cwd ?? process.cwd(), file));
  }

  // 2. Project config
  const cwd = options.cwd ?? process.cwd();
  for (const filename of MAIN_CONFIG_FILENAMES) {
    candidateFiles.push(path.join(cwd, ".omp", filename));
  }

  // 3. Global config
  const agentDir = resolveAgentDir(options.agentDir);
  for (const filename of MAIN_CONFIG_FILENAMES) {
    candidateFiles.push(path.join(agentDir, filename));
  }

  for (const filePath of candidateFiles) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed: unknown = YAML.parse(raw);
        const mode = readDottedString(parsed, "tools.approvalMode");
        if (mode === "yolo" || mode === "write" || mode === "always-ask") {
          return mode;
        }
      }
    } catch {
      // Unreadable or malformed files are ignored in search of the next layer.
    }
  }

  return undefined;
}

/**
 * Reuses OMP's own Settings resolver from `@oh-my-pi/pi-coding-agent/config/settings`
 * to resolve the operator's configured `tools.approvalMode` asynchronously.
 */
export async function resolveOmpApprovalMode(
  options: OmpApprovalResolveOptions = {},
): Promise<OmpApprovalMode | undefined> {
  try {
    const s = await Settings.loadReadOnly({
      agentDir: resolveAgentDir(options.agentDir),
      cwd: options.cwd,
      configFiles: options.configFiles,
    });
    if (s.isConfigured("tools.approvalMode")) {
      const mode = s.get("tools.approvalMode");
      if (mode === "yolo" || mode === "write" || mode === "always-ask") {
        return mode;
      }
    }
  } catch {
    // If settings fail to load, treat as unreadable/absent.
  }
  return undefined;
}

/**
 * Maps OMP's `tools.approvalMode` to ompd's `policyMode`:
 *   - "yolo" -> "trusted"
 *   - "write" -> "standard"
 *   - "always-ask" -> "strict"
 */
export function approvalModeToPolicyMode(mode: string | undefined): PolicyMode {
  // If OMP's setting cannot be read, or is absent entirely, keep today's "standard".
  // Absence is not an instruction, and ompd is reachable over a network while a TUI
  // has a human at the keyboard; a fresh machine must not silently become "trusted"
  // just because OMP's schema default is "yolo".
  switch (mode) {
    case "yolo":
      return "trusted";
    case "write":
      return "standard";
    case "always-ask":
      return "strict";
    default:
      return "standard";
  }
}

/**
 * Determines the effective policyMode and its provenance source.
 */
export function determinePolicyMode(
  fromFileMode: PolicyMode | undefined,
  overridesMode: PolicyMode | undefined,
  ompOptions: OmpApprovalResolveOptions = {},
): { policyMode: PolicyMode; source: PolicyModeSource } {
  if (overridesMode !== undefined) {
    return { policyMode: overridesMode, source: "override" };
  }
  if (fromFileMode !== undefined) {
    return { policyMode: fromFileMode, source: "file" };
  }

  const ompMode = resolveOmpApprovalModeSync(ompOptions);
  if (ompMode !== undefined) {
    return { policyMode: approvalModeToPolicyMode(ompMode), source: "omp" };
  }

  return { policyMode: "standard", source: "default" };
}

/**
 * Returns the derivation source for policyMode given a home directory and optional overrides.
 */
export function getPolicyModeSource(
  home: string,
  overrides: Partial<OmpdConfig> = {},
  options: LoadConfigOptions = {},
): PolicyModeSource {
  const pathOnDisk = path.join(home, "config.json");
  let fromFile: Partial<OmpdConfig> = {};
  if (fs.existsSync(pathOnDisk)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(pathOnDisk, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        fromFile = parsed as Partial<OmpdConfig>;
      }
    } catch {}
  }
  return determinePolicyMode(fromFile.policyMode, overrides.policyMode, {
    agentDir: options.ompAgentDir ?? options.agentDir,
    cwd: options.cwd,
    configFiles: options.configFiles,
  }).source;
}
