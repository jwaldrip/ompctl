/**
 * Which directories a remote device may read artifact bytes from, and the
 * security boundary protecting the host machine.
 *
 * What a phone may and may not reach through the artifact bytes route, and why:
 *
 * The daemon runs as the local operator with access to their entire disk. A
 * paired phone holding read scope can view session progress, transcripts, and
 * artifacts, but must never become an unconfined filesystem exfiltration tool.
 *
 * Two classes of roots are permitted:
 *
 * 1. Session artifact directories (<sessionsRoot>/<group>/<stamp>_<sessionId>/
 *    and <sessionsRoot>). These are directories created specifically by OMP
 *    to hold session outputs, subagent transcripts, final markdown reports,
 *    and tool logs. A phone with read scope is already entitled to read
 *    transcripts for any session on this machine; allowing it to read the
 *    files the session produced in its artifact folder is the exact purpose
 *    of this feature.
 *
 * 2. Operator-browsed roots (the roots configured for the daemon's filesystem
 *    subsystem, matching what BrowseScreen and fs_list browse today). This
 *    follows the exact same boundary that BrowseScreen and fs_list enforce
 *    today. If an operator has explicitly configured directories (such as
 *    workspace folders or project checkouts) as browsable, the phone can
 *    reach files located strictly within those configured roots.
 *
 * What a phone CANNOT reach:
 * - Any path outside the configured browse roots and session artifact roots
 *   (for example /etc, user SSH keys, cloud credentials, or arbitrary system
 *   and personal files).
 * - Traversal attempts (such as ../../etc/passwd): all paths are resolved
 *   with realpath before containment is checked against the resolved allow list.
 * - Symlinks pointing outside: a symlink inside an allowed root that targets
 *   an outside path (such as a link pointing to /etc/shadow) is resolved to
 *   its real destination before checking containment, and is refused with
 *   out_of_roots.
 * - Non-existent paths: refused with not_found.
 * - Directories: refused with not_a_file.
 * - Files exceeding the byte ceiling: refused with file_too_large so huge
 *   files cannot exhaust daemon or phone memory.
 */

import type { Stats } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { getSessionsDir } from "@oh-my-pi/pi-utils";

export type ArtifactRefusalCode =
  | "no_roots"
  | "out_of_roots"
  | "not_found"
  | "not_a_file"
  | "bad_path"
  | "file_too_large"
  | "bad_range"
  | "range_not_satisfiable";

/**
 * A refusal with an error code and HTTP status code.
 */
export class ArtifactRefusal extends Error {
  readonly code: ArtifactRefusalCode;
  readonly status: number;

  constructor(code: ArtifactRefusalCode, message: string) {
    super(message);
    this.name = "ArtifactRefusal";
    this.code = code;
    this.status = statusForCode(code);
  }
}

function statusForCode(code: ArtifactRefusalCode): number {
  switch (code) {
    case "not_found":
      return 404;
    case "out_of_roots":
      return 403;
    case "file_too_large":
      return 413;
    case "range_not_satisfiable":
      return 416;
    case "bad_path":
    case "not_a_file":
    case "bad_range":
    case "no_roots":
      return 400;
  }
}

/**
 * Test whether real is a root or lives under one.
 * Both sides must be realpath resolved beforehand.
 */
export function inside(roots: readonly string[], real: string): boolean {
  return roots.some(root => real === root || real.startsWith(root + sep));
}

/**
 * Resolve and deduplicate configured roots.
 */
export async function resolveAllowedRoots(configuredRoots: readonly string[]): Promise<string[]> {
  const seen = new Set<string>();
  for (const candidate of configuredRoots) {
    if (typeof candidate !== "string" || candidate.length === 0 || !isAbsolute(candidate)) continue;
    try {
      const real = await realpath(candidate);
      const info = await stat(real);
      if (info.isDirectory()) seen.add(real);
    } catch {
      // Missing or unreadable root skipped.
    }
  }
  return [...seen];
}

/**
 * Resolve an artifact path and verify that it strictly lands within allowed roots.
 */
export async function verifyArtifactPath(path: string, allowedRoots: readonly string[]): Promise<string> {
  if (typeof path !== "string" || path.length === 0) {
    throw new ArtifactRefusal("bad_path", "a path is required");
  }
  if (path.includes("\0")) {
    throw new ArtifactRefusal("bad_path", "a path may not contain a NUL");
  }
  if (!isAbsolute(path)) {
    throw new ArtifactRefusal("bad_path", `${path} is not an absolute path`);
  }
  if (allowedRoots.length === 0) {
    throw new ArtifactRefusal("no_roots", "no allowed artifact roots configured");
  }

  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new ArtifactRefusal("not_found", `${path} does not exist`);
  }

  if (!inside(allowedRoots, real)) {
    throw new ArtifactRefusal("out_of_roots", `${path} resolves outside allowed roots`);
  }

  let info: Stats;
  try {
    info = await stat(real);
  } catch {
    throw new ArtifactRefusal("not_found", `${path} does not exist`);
  }

  if (!info.isFile()) {
    throw new ArtifactRefusal("not_a_file", `${path} is not a regular file`);
  }

  return real;
}

/**
 * Default sessions root directory used by OMP.
 */
export function getDefaultSessionsDir(): string {
  return getSessionsDir();
}
