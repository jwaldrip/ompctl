/**
 * Content type sniffing from raw magic bytes.
 *
 * The contract forbids trusting the filename: an agent or operator naming an
 * image "output.bin" or an html artifact "report.dat" must still be handed to
 * the viewer with its real MIME type, and a file with an image extension that
 * holds text or an exploit must never masquerade as an image.
 *
 * When no known signature matches, this falls back strictly to
 * "application/octet-stream" (or text/plain for valid text), never to a type
 * inferred from the file path.
 */

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: false });

/**
 * Sniff the MIME content type from the leading bytes of a file.
 */
export function sniffContentType(bytes: Uint8Array): string {
  const len = bytes.length;
  if (len === 0) return "application/octet-stream";

  // 1. Binary image formats.
  if (
    len >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    len >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  if (
    len >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    len >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }

  if (len >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return "image/bmp";
  }

  if (len >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x00) {
    return "image/x-icon";
  }

  if (
    len >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }

  // 2. Video formats.
  if (
    len >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
    if (brand.startsWith("qt")) return "video/quicktime";
    return "video/mp4";
  }

  if (len >= 8 && bytes[4] === 0x6d && bytes[5] === 0x6f && bytes[6] === 0x6f && bytes[7] === 0x76) {
    return "video/quicktime";
  }

  if (len >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const limit = Math.min(len, 64);
    for (let i = 4; i < limit - 3; i++) {
      if (bytes[i] === 0x77 && bytes[i + 1] === 0x65 && bytes[i + 2] === 0x62 && bytes[i + 3] === 0x6d) {
        return "video/webm";
      }
    }
    return "video/x-matroska";
  }

  // 3. Audio formats.
  if (len >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return "audio/ogg";
  }

  if (len >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg";
  }

  if (len >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x18) !== 0x08) {
    return "audio/mpeg";
  }

  if (
    len >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return "audio/wav";
  }

  if (len >= 4 && bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return "audio/flac";
  }

  // 4. Binary documents and archives.
  if (len >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
    return "application/pdf";
  }

  if (len >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "application/zip";
  }

  if (len >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "application/gzip";
  }

  if (len >= 4 && bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
    return "application/wasm";
  }

  // 5. Distinguish text from arbitrary binary data.
  const checkLimit = Math.min(len, 1024);
  for (let i = 0; i < checkLimit; i++) {
    const b = bytes[i]!;
    if (b === 0x00 || b < 0x09 || (b > 0x0d && b < 0x20)) {
      return "application/octet-stream";
    }
  }

  // 6. Text formats (HTML, SVG, JSON, Markdown, XML, plain text).
  const text = TEXT_DECODER.decode(bytes).trim();
  if (text.length === 0) return "text/plain; charset=utf-8";

  const lower = text.toLowerCase();

  // SVG: starts with XML declaration or <svg, or root SVG tag.
  if (lower.startsWith("<svg") || (lower.startsWith("<?xml") && lower.includes("<svg"))) {
    return "image/svg+xml";
  }

  // HTML: starts with doctype or html/head/body/script tag.
  if (
    lower.startsWith("<!doctype html") ||
    lower.startsWith("<html") ||
    lower.startsWith("<head") ||
    lower.startsWith("<body")
  ) {
    return "text/html; charset=utf-8";
  }

  // XML.
  if (lower.startsWith("<?xml")) {
    return "application/xml";
  }

  // JSON.
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    try {
      JSON.parse(text);
      return "application/json";
    } catch {
      // Not valid complete JSON; continue to markdown/text checks.
    }
  }

  // Markdown: starts with markdown header, list marker, or frontmatter.
  if (isMarkdown(text)) {
    return "text/markdown; charset=utf-8";
  }

  return "text/plain; charset=utf-8";
}

/**
 * Sniff content type by reading the first 8 KB of a file.
 */
export async function sniffFileHead(filePath: string): Promise<string> {
  try {
    const file = Bun.file(filePath);
    const slice = await file.slice(0, 8192).arrayBuffer();
    return sniffContentType(new Uint8Array(slice));
  } catch {
    return "application/octet-stream";
  }
}

function isMarkdown(text: string): boolean {
  if (text.startsWith("# ") || text.startsWith("## ") || text.startsWith("### ") || text.startsWith("---")) {
    return true;
  }
  const lines = text.split("\n", 10);
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("# ") ||
      trimmed.startsWith("## ") ||
      trimmed.startsWith("### ") ||
      trimmed.startsWith("- ") ||
      trimmed.startsWith("* ") ||
      trimmed.startsWith("> ") ||
      trimmed.startsWith("```")
    ) {
      return true;
    }
  }
  return false;
}
