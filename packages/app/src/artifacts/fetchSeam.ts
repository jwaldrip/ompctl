/**
 * The fetch seam for retrieving artifact bytes and content.
 *
 * Wire all artifact viewers to this seam. The integrator points this at the
 * daemon route GET /v1/artifacts/bytes?path=<url_encoded_path>.
 */

import type { ArtifactItem } from "./types.ts";

export interface ArtifactFetchOptions {
  range?: { start: number; end?: number };
  signal?: AbortSignal;
  headers?: Record<string, string>;
  token?: string;
  daemonRoot?: string;
}

export interface ArtifactFetchResult {
  data: string | ArrayBuffer | Uint8Array;
  contentType: string;
  sizeBytes?: number;
  rangeHonored: boolean;
}

export type ArtifactFetchSeam = (
  artifact: ArtifactItem,
  options?: ArtifactFetchOptions,
) => Promise<ArtifactFetchResult>;

/**
 * Default implementation fetching from local inline content or remote route.
 */
export const defaultArtifactFetchSeam: ArtifactFetchSeam = async (artifact, options) => {
  if (artifact.content !== undefined) {
    return {
      data: artifact.content,
      contentType: artifact.contentType || "text/plain",
      sizeBytes: artifact.byteSize ?? artifact.content.length,
      rangeHonored: options?.range !== undefined,
    };
  }

  const root = options?.daemonRoot ?? "";
  const url =
    artifact.url ??
    `${root}/v1/artifacts/bytes?path=${encodeURIComponent(artifact.path)}`;

  const headers = new Headers(options?.headers);
  if (options?.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  if (options?.range) {
    const rangeHeader = `bytes=${options.range.start}-${options.range.end ?? ""}`;
    headers.set("Range", rangeHeader);
  }

  const res = await fetch(url, {
    headers,
    signal: options?.signal,
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch artifact bytes: ${res.status} ${res.statusText}`);
  }

  const rangeHonored = res.status === 206 || res.headers.has("Content-Range");
  const contentType = res.headers.get("Content-Type") ?? artifact.contentType ?? "application/octet-stream";
  const lengthHeader = res.headers.get("Content-Length");
  const sizeBytes = lengthHeader ? Number.parseInt(lengthHeader, 10) : artifact.byteSize;

  const isText =
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("javascript") ||
    contentType.includes("typescript") ||
    contentType.includes("xml");

  const data = isText ? await res.text() : await res.arrayBuffer();

  return {
    data,
    contentType,
    sizeBytes,
    rangeHonored,
  };
};

let activeArtifactFetchSeam: ArtifactFetchSeam = defaultArtifactFetchSeam;

export function setArtifactFetchSeam(seam: ArtifactFetchSeam): void {
  activeArtifactFetchSeam = seam;
}

export function resetArtifactFetchSeam(): void {
  activeArtifactFetchSeam = defaultArtifactFetchSeam;
}

export function getArtifactFetchSeam(): ArtifactFetchSeam {
  return activeArtifactFetchSeam;
}

/**
 * Main fetch function called by all artifact viewers.
 */
export async function fetchArtifactContent(
  artifact: ArtifactItem,
  options?: ArtifactFetchOptions,
): Promise<ArtifactFetchResult> {
  return activeArtifactFetchSeam(artifact, options);
}
