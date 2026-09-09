/**
 * Types and kind detection for artifact viewers.
 *
 * Artifacts represent files produced by an agent session or located on the
 * daemon filesystem (code, diffs, images, videos, HTML reports, and raw data).
 */

import type { FsEntry } from "@ompd/core/contracts";

export type ArtifactKind = "image" | "video" | "code" | "text" | "diff" | "html" | "fallback";

export interface ArtifactReference {
  id: string;
  path: string;
  name: string;
  contentType: string;
  byteSize?: number;
  origin?: "session" | "browse";
  sessionId?: string;
  updatedAt?: number;
}

export interface ArtifactItem {
  id: string;
  path: string;
  name: string;
  kind: ArtifactKind;
  contentType: string;
  byteSize?: number;
  url?: string;
  content?: string;
  oldContent?: string;
  newContent?: string;
  origin?: "session" | "browse";
  sessionId?: string;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

const IMAGE_EXTENSIONS: Record<string, true> = {
  png: true,
  jpg: true,
  jpeg: true,
  gif: true,
  webp: true,
  svg: true,
  bmp: true,
  ico: true,
};

const VIDEO_EXTENSIONS: Record<string, true> = {
  mp4: true,
  webm: true,
  mov: true,
  mkv: true,
  m4v: true,
  avi: true,
};

const HTML_EXTENSIONS: Record<string, true> = {
  html: true,
  htm: true,
};

const DIFF_EXTENSIONS: Record<string, true> = {
  diff: true,
  patch: true,
};

const CODE_EXTENSIONS: Record<string, true> = {
  ts: true,
  tsx: true,
  js: true,
  jsx: true,
  json: true,
  py: true,
  rb: true,
  rs: true,
  go: true,
  c: true,
  cpp: true,
  h: true,
  hpp: true,
  css: true,
  scss: true,
  yaml: true,
  yml: true,
  toml: true,
  sh: true,
  bash: true,
  zsh: true,
  sql: true,
  swift: true,
  kt: true,
  java: true,
  zig: true,
  lua: true,
  xml: true,
};

const TEXT_EXTENSIONS: Record<string, true> = {
  txt: true,
  md: true,
  markdown: true,
  log: true,
  env: true,
  csv: true,
  tsv: true,
};

export function getFileExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1 || dot === filename.length - 1) return "";
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * Detect the viewer kind from a file name and optional MIME content type.
 */
export function detectArtifactKind(name: string, contentType?: string): ArtifactKind {
  const lowerType = contentType?.toLowerCase() ?? "";
  const ext = getFileExtension(name);

  if (lowerType.startsWith("image/") || IMAGE_EXTENSIONS[ext]) {
    return "image";
  }
  if (lowerType.startsWith("video/") || VIDEO_EXTENSIONS[ext]) {
    return "video";
  }
  if (lowerType.includes("text/html") || HTML_EXTENSIONS[ext]) {
    return "html";
  }
  if (lowerType.includes("text/x-diff") || lowerType.includes("text/x-patch") || DIFF_EXTENSIONS[ext]) {
    return "diff";
  }
  if (CODE_EXTENSIONS[ext]) {
    return "code";
  }
  if (lowerType.startsWith("text/") || TEXT_EXTENSIONS[ext]) {
    return "text";
  }
  return "fallback";
}

/**
 * Convert an ArtifactReference into a client ArtifactItem.
 */
export function artifactItemFromReference(ref: ArtifactReference, content?: string): ArtifactItem {
  return {
    id: ref.id,
    path: ref.path,
    name: ref.name,
    kind: detectArtifactKind(ref.name, ref.contentType),
    contentType: ref.contentType,
    byteSize: ref.byteSize,
    origin: ref.origin,
    sessionId: ref.sessionId,
    updatedAt: ref.updatedAt,
    content,
  };
}

/**
 * Convert an FsEntry from directory browsing into an ArtifactItem.
 */
export function artifactItemFromFsEntry(entry: FsEntry, parentPath: string): ArtifactItem {
  const fullPath = parentPath === "" ? entry.name : `${parentPath}/${entry.name}`;
  return {
    id: fullPath,
    path: fullPath,
    name: entry.name,
    kind: detectArtifactKind(entry.name),
    contentType: "application/octet-stream",
    origin: "browse",
  };
}

/**
 * Format byte count into human-readable representation.
 */
export function formatByteSize(bytes?: number): string {
  if (bytes === undefined || Number.isNaN(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
