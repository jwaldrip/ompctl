/**
 * Tests for artifact viewers:
 * - Image viewer (fit, zoom, pan)
 * - Video viewer (play, scrub, range requests)
 * - Code and text viewer (monospace, line numbers, virtualization for large files)
 * - Diff viewer (unified diff with added and removed lines)
 * - HTML viewer (sandboxed render with network disabled, open in browser)
 * - Fallback viewer (type, size, open and share options)
 * - Artifact file tray (multiple files, routing to viewers)
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";

const { WithOmpTheme } = await import("./theme.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface Mounted {
  host: HTMLElement;
  unmount: () => void;
}

function mount(element: ReactElement): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return {
    host,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

function themed(element: ReactElement): Mounted {
  return mount(<WithOmpTheme>{element}</WithOmpTheme>);
}

describe("Artifact Viewers", () => {
  test("ImageViewer renders image with zoom and fit controls", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { ImageViewer } = await import("../src/artifacts/ImageViewer.tsx");
    const fixture = {
      id: "art-1",
      path: "artifacts/screen.png",
      name: "screen.png",
      kind: "image" as const,
      contentType: "image/png",
      byteSize: 102400,
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    };
    const { host, unmount } = themed(<ImageViewer artifact={fixture} />);
    try {
      expect(host.querySelector('[data-testid="image-viewer"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="image-zoom-in"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="image-zoom-out"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="image-zoom-reset"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="image-viewer-image"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("VideoViewer renders player with playback, scrub bar, and range request support", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { VideoViewer } = await import("../src/artifacts/VideoViewer.tsx");
    const fixture = {
      id: "art-2",
      path: "artifacts/demo.mp4",
      name: "demo.mp4",
      kind: "video" as const,
      contentType: "video/mp4",
      byteSize: 2048576,
      url: "https://example.com/demo.mp4",
    };
    const { host, unmount } = themed(<VideoViewer artifact={fixture} />);
    try {
      expect(host.querySelector('[data-testid="video-viewer"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="video-player"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="video-play-button"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="video-scrubber"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="video-range-indicator"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("CodeTextViewer renders monospace code with line numbers and virtualizes large files", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { CodeTextViewer } = await import("../src/artifacts/CodeTextViewer.tsx");
    // Generate a 20,000 line file fixture
    const lines = Array.from({ length: 20000 }, (_, i) => `const line${i + 1} = ${i + 1};`);
    const fixture = {
      id: "art-3",
      path: "artifacts/large.ts",
      name: "large.ts",
      kind: "code" as const,
      contentType: "text/typescript",
      content: lines.join("\n"),
      byteSize: 500000,
    };
    const { host, unmount } = themed(<CodeTextViewer artifact={fixture} />);
    try {
      expect(host.querySelector('[data-testid="code-text-viewer"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="code-line-numbers"]')).not.toBeNull();
      // It must not render all 20,000 lines in the DOM at once
      const renderedLines = host.querySelectorAll('[data-testid="code-line-item"]');
      expect(renderedLines.length).toBeGreaterThan(0);
      expect(renderedLines.length).toBeLessThan(500);
      // Total lines indicator is present
      const lineCount = host.querySelector('[data-testid="code-line-count"]');
      expect(lineCount?.textContent).toContain("20,000");
    } finally {
      unmount();
    }
  });

  test("DiffViewer renders unified diff with legible added and removed lines", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { DiffViewer } = await import("../src/artifacts/DiffViewer.tsx");
    const diffText = [
      "--- a/index.ts",
      "+++ b/index.ts",
      "@@ -1,3 +1,3 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ].join("\n");
    const fixture = {
      id: "art-4",
      path: "artifacts/patch.diff",
      name: "patch.diff",
      kind: "diff" as const,
      contentType: "text/x-diff",
      content: diffText,
      byteSize: diffText.length,
    };
    const { host, unmount } = themed(<DiffViewer artifact={fixture} />);
    try {
      expect(host.querySelector('[data-testid="diff-viewer"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="diff-added-line"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="diff-removed-line"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("HtmlViewer renders sandboxed frame with network access disabled and browser escape hatch", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { HtmlViewer, getSandboxedHtmlPolicy } = await import("../src/artifacts/HtmlViewer.tsx");
    const htmlContent = "<html><body><h1>Report</h1></body></html>";
    const fixture = {
      id: "art-5",
      path: "artifacts/report.html",
      name: "report.html",
      kind: "html" as const,
      contentType: "text/html",
      content: htmlContent,
      byteSize: htmlContent.length,
      url: "https://example.com/artifacts/report.html",
    };
    const policy = getSandboxedHtmlPolicy(htmlContent);
    // Verified security policy: CSP with default-src 'none', connect-src 'none'
    expect(policy.csp).toContain("default-src 'none'");
    expect(policy.csp).toContain("connect-src 'none'");
    expect(policy.originWhitelist).toEqual(["about:blank"]);
    expect(policy.allowNetworkAccess).toBe(false);

    const { host, unmount } = themed(<HtmlViewer artifact={fixture} />);
    try {
      expect(host.querySelector('[data-testid="html-viewer"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="html-viewer-frame"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="html-open-external-button"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("FallbackViewer renders honest fallback naming type and size with open and share options", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { FallbackViewer } = await import("../src/artifacts/FallbackViewer.tsx");
    const fixture = {
      id: "art-6",
      path: "artifacts/archive.bin",
      name: "archive.bin",
      kind: "fallback" as const,
      contentType: "application/octet-stream",
      byteSize: 10485760, // 10 MB
    };
    const { host, unmount } = themed(<FallbackViewer artifact={fixture} />);
    try {
      expect(host.querySelector('[data-testid="fallback-viewer"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="fallback-filename"]')?.textContent).toContain("archive.bin");
      expect(host.querySelector('[data-testid="fallback-type"]')?.textContent).toContain("application/octet-stream");
      expect(host.querySelector('[data-testid="fallback-size"]')?.textContent).toContain("10.0 MB");
      expect(host.querySelector('[data-testid="fallback-open-button"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="fallback-share-button"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("ArtifactFileTray lists multiple files and routes each to the right viewer", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { ArtifactFileTray } = await import("../src/artifacts/ArtifactFileTray.tsx");
    const artifacts = [
      { id: "1", path: "screen.png", name: "screen.png", kind: "image" as const, contentType: "image/png" },
      { id: "2", path: "demo.mp4", name: "demo.mp4", kind: "video" as const, contentType: "video/mp4" },
      { id: "3", path: "main.ts", name: "main.ts", kind: "code" as const, contentType: "text/typescript" },
      { id: "4", path: "report.html", name: "report.html", kind: "html" as const, contentType: "text/html" },
      {
        id: "5",
        path: "data.bin",
        name: "data.bin",
        kind: "fallback" as const,
        contentType: "application/octet-stream",
      },
    ];
    let selected: unknown = null;
    const { host, unmount } = themed(
      <ArtifactFileTray
        artifacts={artifacts}
        onSelectArtifact={item => {
          selected = item;
        }}
      />,
    );
    try {
      expect(host.querySelector('[data-testid="artifact-file-tray"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="artifact-tray-item-screen.png"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="artifact-tray-item-report.html"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="artifact-tray-item-data.bin"]')).not.toBeNull();

      // Trigger selection
      const htmlItem = host.querySelector('[data-testid="artifact-tray-item-report.html"]') as HTMLElement;
      act(() => {
        htmlItem.click();
      });
      expect(selected).toEqual(artifacts[3]);
    } finally {
      unmount();
    }
  });

  test("ArtifactViewerScreen routes to correct viewer for artifact kind", async () => {
    // Dynamic import because rnw.ts mocks react-native before component imports.
    const { ArtifactViewerScreen } = await import("../src/artifacts/ArtifactViewerScreen.tsx");
    const htmlFixture = {
      id: "art-h",
      path: "test.html",
      name: "test.html",
      kind: "html" as const,
      contentType: "text/html",
      content: "<p>Hello</p>",
    };
    const { host, unmount } = themed(<ArtifactViewerScreen artifact={htmlFixture} onBack={() => {}} />);
    try {
      expect(host.querySelector('[data-testid="artifact-viewer-screen"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="html-viewer"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });

  test("BrowseScreen enables opening files and routes to onOpenFile", async () => {
    const { BrowseScreen } = await import("../src/screens/BrowseScreen.tsx");
    const { EMPTY_REMOTE_START } = await import("../src/remote/model.ts");
    let openedFile: unknown = null;
    let openedPath = "";

    const state = {
      ...EMPTY_REMOTE_START,
      path: "my-project",
      entries: [
        { name: "src", kind: "dir" as const },
        { name: "report.html", kind: "file" as const },
        { name: "notes.txt", kind: "file" as const },
      ],
    };
    const { host, unmount } = themed(
      <BrowseScreen
        onBack={() => {}}
        onCloneHere={() => {}}
        onDismissClone={() => {}}
        onDismissNotice={() => {}}
        onOpenChild={() => {}}
        onOpenFile={(entry, path) => {
          openedFile = entry;
          openedPath = path;
        }}
        onOpenPath={() => {}}
        onRefresh={() => {}}
        onStartHere={() => {}}
        onUp={() => {}}
        state={state}
      />,
    );
    try {
      const fileEntry = host.querySelector('[data-testid="browse-entry-report.html"]') as HTMLElement;
      expect(fileEntry).not.toBeNull();
      act(() => {
        fileEntry.click();
      });
      expect(openedFile).toEqual({ name: "report.html", kind: "file" });
      expect(openedPath).toBe("my-project/report.html");
    } finally {
      unmount();
    }
  });

  test("fetchArtifactContent seam handles content and range options", async () => {
    const { fetchArtifactContent, setArtifactFetchSeam, resetArtifactFetchSeam } = await import(
      "../src/artifacts/fetchSeam.ts"
    );

    // Inline content artifact
    const inlineArtifact = {
      id: "inline-1",
      path: "inline.txt",
      name: "inline.txt",
      kind: "text" as const,
      contentType: "text/plain",
      content: "Hello from inline content",
    };

    const inlineRes = await fetchArtifactContent(inlineArtifact);
    expect(inlineRes.data).toBe("Hello from inline content");
    expect(inlineRes.contentType).toBe("text/plain");

    // Custom seam for range request
    let receivedRange: { start: number; end?: number } | undefined;
    setArtifactFetchSeam(async (_art, opts) => {
      receivedRange = opts?.range;
      return {
        data: "slice data",
        contentType: "video/mp4",
        sizeBytes: 1024,
        rangeHonored: true,
      };
    });

    try {
      const rangeRes = await fetchArtifactContent(
        {
          id: "vid-1",
          path: "demo.mp4",
          name: "demo.mp4",
          kind: "video",
          contentType: "video/mp4",
        },
        { range: { start: 0, end: 1023 } },
      );
      expect(receivedRange).toEqual({ start: 0, end: 1023 });
      expect(rangeRes.rangeHonored).toBe(true);
    } finally {
      resetArtifactFetchSeam();
    }
  });
});
