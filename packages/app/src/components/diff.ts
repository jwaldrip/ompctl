/**
 * Line diff and hunking for unified diff rendering.
 *
 * Implements Myers line diff with prefix and suffix trimming, followed by
 * hunk generation with bounded context around changed sections. No external
 * dependencies.
 */

/** Lines of unchanged context around each hunk. Rationale: matches git diff standard. */
export const CONTEXT_LINES = 3;

export type DiffOpType = "context" | "added" | "deleted";

export interface DiffOp {
  type: DiffOpType;
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffOp[];
}

/**
 * Splits text into lines, handling CRLF and preserving line counts.
 * If text ends with a newline, the trailing empty string is omitted so the
 * final line is not counted as an extra blank line.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  if (text.endsWith("\r\n")) {
    return text.slice(0, -2).split("\r\n");
  }
  if (text.endsWith("\n")) {
    return text.slice(0, -1).split("\n");
  }
  return text.split(/\r?\n/);
}

/**
 * Computes a line-by-line unified diff of oldText vs newText.
 * Uses Myers diff over the trimmed middle between common prefix and suffix.
 */
export function computeLineDiff(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);

  const rawOps: DiffOp[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (let i = 0; i < prefix; i += 1) {
    const text = a[i];
    if (text !== undefined) {
      rawOps.push({
        type: "context",
        text,
        oldLine: oldLine,
        newLine: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  const midOps = myers(midA, midB);
  for (let i = 0; i < midOps.length; i += 1) {
    const op = midOps[i];
    if (op === undefined) continue;
    if (op.type === "context") {
      rawOps.push({
        type: "context",
        text: op.text,
        oldLine: oldLine,
        newLine: newLine,
      });
      oldLine += 1;
      newLine += 1;
    } else if (op.type === "deleted") {
      rawOps.push({
        type: "deleted",
        text: op.text,
        oldLine: oldLine,
      });
      oldLine += 1;
    } else {
      rawOps.push({
        type: "added",
        text: op.text,
        newLine: newLine,
      });
      newLine += 1;
    }
  }

  for (let i = a.length - suffix; i < a.length; i += 1) {
    const text = a[i];
    if (text !== undefined) {
      rawOps.push({
        type: "context",
        text,
        oldLine: oldLine,
        newLine: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  return rawOps;
}

function myers(a: readonly string[], b: readonly string[]): Array<{ type: DiffOpType; text: string }> {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map(text => ({ type: "added" as const, text }));
  if (m === 0) return a.map(text => ({ type: "deleted" as const, text }));

  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(new Int32Array(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[max + k - 1]! < v[max + k + 1]!)) {
        x = v[max + k + 1]!;
      } else {
        x = v[max + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, a, b, d, k);
      }
    }
  }

  return [...a.map(text => ({ type: "deleted" as const, text })), ...b.map(text => ({ type: "added" as const, text }))];
}

function backtrack(
  trace: Int32Array[],
  a: readonly string[],
  b: readonly string[],
  d: number,
  k: number,
): Array<{ type: DiffOpType; text: string }> {
  const max = a.length + b.length;
  let currentK = k;
  let currentX = a.length;
  let currentY = b.length;
  const script: Array<{ type: DiffOpType; text: string }> = [];

  for (let step = d; step > 0; step -= 1) {
    const v = trace[step];
    if (v === undefined) continue;
    const prevK =
      currentK === -step || (currentK !== step && v[max + currentK - 1]! < v[max + currentK + 1]!)
        ? currentK + 1
        : currentK - 1;
    const prevX = v[max + prevK]!;
    const prevY = prevX - prevK;

    while (currentX > prevX && currentY > prevY) {
      currentX -= 1;
      currentY -= 1;
      const text = a[currentX];
      if (text !== undefined) {
        script.push({ type: "context", text });
      }
    }

    if (currentX > prevX) {
      currentX -= 1;
      const text = a[currentX];
      if (text !== undefined) {
        script.push({ type: "deleted", text });
      }
    } else if (currentY > prevY) {
      currentY -= 1;
      const text = b[currentY];
      if (text !== undefined) {
        script.push({ type: "added", text });
      }
    }
    currentK = prevK;
  }

  while (currentX > 0 && currentY > 0) {
    currentX -= 1;
    currentY -= 1;
    const text = a[currentX];
    if (text !== undefined) {
      script.push({ type: "context", text });
    }
  }

  script.reverse();
  return script;
}

/**
 * Groups diff operations into hunks with context lines around changes.
 * Overlapping context intervals are merged into a single contiguous hunk.
 */
export function buildHunks(ops: readonly DiffOp[], contextLines = CONTEXT_LINES): DiffHunk[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    if (op !== undefined && op.type !== "context") {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) {
    return [];
  }

  const intervals: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < changeIndices.length; i += 1) {
    const idx = changeIndices[i];
    if (idx === undefined) continue;
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    const last = intervals[intervals.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      intervals.push({ start, end });
    }
  }

  return intervals.map(interval => {
    const lines = ops.slice(interval.start, interval.end + 1);
    let oldStart = 0;
    let oldLines = 0;
    let newStart = 0;
    let newLines = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      if (line.type === "context") {
        if (oldStart === 0 && line.oldLine !== undefined) oldStart = line.oldLine;
        if (newStart === 0 && line.newLine !== undefined) newStart = line.newLine;
        oldLines += 1;
        newLines += 1;
      } else if (line.type === "deleted") {
        if (oldStart === 0 && line.oldLine !== undefined) oldStart = line.oldLine;
        oldLines += 1;
      } else if (line.type === "added") {
        if (newStart === 0 && line.newLine !== undefined) newStart = line.newLine;
        newLines += 1;
      }
    }

    if (oldStart === 0) oldStart = oldLines > 0 ? 1 : 0;
    if (newStart === 0) newStart = newLines > 0 ? 1 : 0;

    const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
    return {
      oldStart,
      oldLines,
      newStart,
      newLines,
      header,
      lines,
    };
  });
}
