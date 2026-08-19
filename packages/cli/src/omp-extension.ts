/**
 * The omp side of `ompd install`: put the bridge extension where omp will find
 * it, so a live terminal session shows up on the phone with no extra step.
 *
 * omp auto-discovers extension modules from the active agent directory's
 * `extensions/`, one level deep: a `<name>/index.ts` is picked up with nothing
 * declared anywhere. That is the whole reason this is a directory with an
 * `index.ts` rather than a loose file -- a directory names the thing in
 * `omp --no-extensions` diagnostics and in `disabledExtensions`, and it gives
 * uninstall something unambiguous to remove.
 *
 * The refusal at the target mirrors `install`'s refusal at the plist path and
 * `self-install`'s at the binary path, for the same reason and by the same
 * discipline: a marker, checked without ever executing the file that is there.
 * Someone else's `ompd-bridge/index.ts` is not ours to overwrite, and an
 * extension is code omp will run in every session, so guessing wrong here is
 * worse than guessing wrong about a plist.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OMP_BRIDGE_SOURCE } from "./omp-bridge-source.ts";

/**
 * Proof that ompd wrote an extension, and the exact counterpart of
 * `PLIST_MARKER`: present in every copy this CLI writes, absent from anything
 * it did not, and cheap to check by reading the head of one small file.
 */
export const EXTENSION_MARKER = "OMPD_MANAGED_EXTENSION";

/** The directory omp discovers the bridge under, inside `extensions/`. */
export const EXTENSION_DIR_NAME = "ompd-bridge";

/**
 * The active omp agent directory.
 *
 * `PI_CODING_AGENT_DIR` is honoured because omp honours it: extension
 * discovery reads the active agent directory, so writing to `~/.omp/agent`
 * when omp is running out of somewhere else installs the bridge where nothing
 * will ever load it. Profiles (`omp --profile x`) move the directory too, and
 * this CLI cannot know which profile a future session will use; that is a
 * documented limit, not something to guess at.
 */
export function agentDir(env: Record<string, string | undefined>): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured !== undefined && configured.length > 0) return configured;
  return join(env.HOME ?? homedir(), ".omp", "agent");
}

/** Where the bridge's module lives once installed. */
export function bridgeExtensionPath(env: Record<string, string | undefined>): string {
  return join(agentDir(env), "extensions", EXTENSION_DIR_NAME, "index.ts");
}

/**
 * The file as it is written: a header that says what this is and who wrote it,
 * then the extension source byte for byte.
 *
 * The header is what makes the marker check meaningful, and it is addressed to
 * whoever finds this file six months from now wondering what put an extension
 * in their agent directory.
 */
export function renderBridgeExtension(): string {
  return `// ${EXTENSION_MARKER}
//
// Written by \`ompd install\`. It registers this omp session with the local
// ompd daemon so the session shows up as drivable on a paired phone, and it
// does nothing at all when no daemon is running.
//
// Edits here are lost on the next \`ompd install\`; \`ompd uninstall\` removes
// this file. The original lives in ompd's own packages/omp-extension.

${OMP_BRIDGE_SOURCE}`;
}

/** Null when nothing is there; otherwise whether ompd wrote it. */
export function inspectBridgeExtension(path: string): { ours: boolean } | null {
  if (!existsSync(path)) return null;
  try {
    return { ours: readFileSync(path, "utf8").includes(EXTENSION_MARKER) };
  } catch {
    // Unreadable is not ours: refusing is the only safe answer about a file
    // whose contents cannot be checked.
    return { ours: false };
  }
}

export type ExtensionInstall =
  | { kind: "installed"; path: string }
  | { kind: "reinstalled"; path: string }
  | { kind: "foreign"; path: string };

/**
 * Write the extension, or refuse.
 *
 * Idempotent by construction: one path, one file, rewritten in place, so
 * installing twice leaves exactly one copy and no stale sibling from an
 * earlier version of the name.
 */
export function installBridgeExtension(env: Record<string, string | undefined>): ExtensionInstall {
  const path = bridgeExtensionPath(env);
  const existing = inspectBridgeExtension(path);
  if (existing !== null && !existing.ours) return { kind: "foreign", path };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderBridgeExtension());
  return existing === null ? { kind: "installed", path } : { kind: "reinstalled", path };
}

export type ExtensionRemoval =
  | { kind: "removed"; path: string }
  | { kind: "absent"; path: string }
  | { kind: "foreign"; path: string };

/**
 * Remove exactly what install wrote.
 *
 * The module file, then its directory only when the removal left it empty. A
 * directory someone else has put a file in is theirs now, and deleting it to
 * tidy up after ourselves would take their work with it.
 */
export function removeBridgeExtension(env: Record<string, string | undefined>): ExtensionRemoval {
  const path = bridgeExtensionPath(env);
  const existing = inspectBridgeExtension(path);
  if (existing === null) return { kind: "absent", path };
  if (!existing.ours) return { kind: "foreign", path };

  rmSync(path);
  const dir = dirname(path);
  try {
    // `rmSync` refuses a directory without `recursive`, and recursive is
    // exactly what must not happen here: this removes an empty directory or
    // nothing at all.
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // A directory that cannot be listed or removed is left alone; the module
    // it held is gone, which is what uninstalling the bridge means.
  }
  return { kind: "removed", path };
}

/** The refusal, as the lines an operator can act on. */
export function foreignExtensionMessage(path: string): string[] {
  return [
    `${path} exists and ompd did not write it.`,
    `  It carries no ${EXTENSION_MARKER} marker, so overwriting it would clobber an`,
    "  extension omp already runs in every session. Move or remove it yourself, then",
    "  run this again.",
  ];
}
