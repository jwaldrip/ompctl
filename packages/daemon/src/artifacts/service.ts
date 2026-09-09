/**
 * Artifact serving service: range requests, byte ceiling enforcement, and
 * session artifact enumeration.
 */

import type { Dirent, Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ArtifactReference } from "@ompd/core";
import { subagentDirFor } from "../sessions/subagents.ts";
import { ArtifactRefusal } from "./roots.ts";
import { sniffFileHead } from "./sniff.ts";

/**
 * Default byte ceiling: 100 MiB.
 * An artifact larger than this is refused with file_too_large rather than
 * streaming an unbounded blob that would exhaust daemon or phone memory.
 */
export const DEFAULT_ARTIFACT_BYTE_CEILING = 100 * 1024 * 1024;

export interface ServeOptions {
  byteCeiling?: number;
}

/**
 * Serve an artifact file with range request support and byte ceiling enforcement.
 */
export async function serveArtifactFile(
  realPath: string,
  rangeHeader: string | null,
  options: ServeOptions = {},
): Promise<Response> {
  const maxBytes = options.byteCeiling ?? DEFAULT_ARTIFACT_BYTE_CEILING;

  let st: Stats;
  try {
    st = await stat(realPath);
  } catch {
    throw new ArtifactRefusal("not_found", `${realPath} does not exist`);
  }

  if (!st.isFile()) {
    throw new ArtifactRefusal("not_a_file", `${realPath} is not a regular file`);
  }

  if (st.size > maxBytes) {
    throw new ArtifactRefusal("file_too_large", `file size ${st.size} bytes exceeds ceiling of ${maxBytes} bytes`);
  }

  const contentType = await sniffFileHead(realPath);

  // No range header: full 200 response.
  if (!rangeHeader) {
    return new Response(Bun.file(realPath), {
      status: 200,
      headers: {
        "content-type": contentType,
        "content-length": String(st.size),
        "accept-ranges": "bytes",
      },
    });
  }

  // Parse Range header.
  if (!rangeHeader.startsWith("bytes=")) {
    throw new ArtifactRefusal("bad_range", "range header must specify bytes unit");
  }

  const spec = rangeHeader.slice("bytes=".length).trim();
  const total = st.size;

  let start: number;
  let end: number;

  if (spec.startsWith("-")) {
    // Suffix range: -N means last N bytes.
    const suffix = parseInt(spec.slice(1), 10);
    if (Number.isNaN(suffix) || suffix <= 0) {
      throw new ArtifactRefusal("bad_range", "invalid range suffix");
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    const parts = spec.split("-");
    const firstStr = parts[0] ?? "";
    const secondStr = parts[1] ?? "";

    start = parseInt(firstStr, 10);
    if (Number.isNaN(start) || start < 0) {
      throw new ArtifactRefusal("bad_range", "invalid range start");
    }

    if (secondStr.length > 0) {
      end = parseInt(secondStr, 10);
      if (Number.isNaN(end) || end < 0) {
        throw new ArtifactRefusal("bad_range", "invalid range end");
      }
    } else {
      end = total - 1;
    }
  }

  if (total === 0 || start >= total || start > end) {
    const refusal = new ArtifactRefusal("range_not_satisfiable", "requested range not satisfiable");
    return new Response(JSON.stringify({ error: refusal.code, message: refusal.message }), {
      status: 416,
      headers: {
        "content-type": "application/json",
        "content-range": `bytes */${total}`,
      },
    });
  }

  const boundedEnd = Math.min(end, total - 1);
  const sliceLength = boundedEnd - start + 1;
  const slice = Bun.file(realPath).slice(start, boundedEnd + 1);

  return new Response(slice, {
    status: 206,
    headers: {
      "content-type": contentType,
      "content-range": `bytes ${start}-${boundedEnd}/${total}`,
      "content-length": String(sliceLength),
      "accept-ranges": "bytes",
    },
  });
}

/**
 * Enumerate artifacts produced by an agent session.
 *
 * Walks the session's artifact directory (<sessionsRoot>/<group>/<stamp>_<id>/)
 * up to 2 directories deep. Discovers subagent reports (<Name>.md), images,
 * documents, and other output artifacts, while omitting raw JSONL transcripts
 * and bash execution logs.
 */
export async function listSessionArtifacts(sessionFilePath: string, sessionId: string): Promise<ArtifactReference[]> {
  const artifactDir = subagentDirFor(sessionFilePath);
  const artifacts: ArtifactReference[] = [];

  await walkArtifactDir(artifactDir, artifactDir, sessionId, artifacts, 0);

  // Newest first by mtime ISO.
  artifacts.sort((a, b) => {
    const timeA = a.updatedAt ?? "";
    const timeB = b.updatedAt ?? "";
    const cmp = timeB.localeCompare(timeA);
    if (cmp !== 0) return cmp;
    return a.name.localeCompare(b.name);
  });

  return artifacts;
}

async function walkArtifactDir(
  rootDir: string,
  currentDir: string,
  sessionId: string,
  out: ArtifactReference[],
  depth: number,
): Promise<void> {
  if (depth > 2) return;

  let dirents: Dirent[];
  try {
    dirents = await readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents) {
    const fullPath = join(currentDir, dirent.name);

    if (dirent.isDirectory()) {
      if (!dirent.name.startsWith(".")) {
        await walkArtifactDir(rootDir, fullPath, sessionId, out, depth + 1);
      }
      continue;
    }

    if (!dirent.isFile()) continue;
    if (dirent.name.startsWith(".")) continue;

    // Filter out raw JSONL transcripts and command logs
    if (dirent.name.endsWith(".jsonl")) continue;
    if (dirent.name.endsWith(".bash-original.log") || dirent.name.endsWith(".bash.log")) continue;
    if (dirent.name.endsWith(".tombstone")) continue;

    let st: Stats;
    try {
      st = await stat(fullPath);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }

    const contentType = await sniffFileHead(fullPath);
    const relPath = relative(rootDir, fullPath);

    out.push({
      id: relPath,
      path: fullPath,
      name: dirent.name,
      contentType,
      byteSize: st.size,
      origin: "session",
      sessionId,
      updatedAt: st.mtime.toISOString(),
    });
  }
}
