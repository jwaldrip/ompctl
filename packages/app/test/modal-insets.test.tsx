/**
 * System safe-area insets inside Modals on a phone.
 *
 * A React Native Modal renders in a fresh full-screen window: no ancestor has
 * paid safe-area insets there. Sheets and full-screen modals must read raw insets
 * via useSafeAreaInsets and add them on top of design padding so controls clear
 * the home indicator and sensor housing in portrait and landscape.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserSession, BrowserState } from "../src/session/browser.ts";
import { EMPTY_BROWSER } from "../src/session/browser.ts";
import { resetSafeAreaInsets, resetWindowSize, setSafeAreaInsets, setWindowSize } from "./rnw.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Dynamic on purpose, the same reason the screen tests do it: these modules
// import "react-native", which would resolve before `./rnw.ts`'s
// `mock.module` call could substitute it.
const { ResumeNudge } = await import("../src/components/ResumeNudge.tsx");
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { ProjectPicker } = await import("../src/components/ProjectPicker.tsx");
const { AttachmentBlock } = await import("../src/components/rich/AttachmentBlock.tsx");
const { space } = await import("../src/design/tokens.ts");

const PORTRAIT_NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };
const LANDSCAPE_NOTCH = { top: 0, right: 59, bottom: 21, left: 59 };

const NOW = Date.parse("2026-03-01T00:00:00.000Z");

const TEST_SESSION: BrowserSession = {
  id: "session-old-1",
  title: "Old session with high message count",
  cwd: "/Users/op/dev/src/github.com/op/alpha",
  status: "dormant",
  createdAt: "2026-02-01T00:00:00.000Z",
  lastActiveAt: "2026-02-26T00:00:00.000Z",
  messageCount: 500,
  sizeBytes: 1024,
};

const SHORT_SESSION: BrowserSession = {
  id: "session-short-1",
  title: "Short cleanup candidate",
  cwd: "/Users/op/dev/src/github.com/op/beta",
  status: "dormant",
  createdAt: "2026-02-05T00:00:00.000Z",
  lastActiveAt: "2026-02-06T00:00:00.000Z",
  messageCount: 1,
  sizeBytes: 256,
};

const TEST_BROWSER_STATE: BrowserState = {
  ...EMPTY_BROWSER,
  sessions: [SHORT_SESSION],
};

const PICKER_SESSIONS: BrowserSession[] = [TEST_SESSION];

function padding(element: Element | null): { top: string; bottom: string; left: string; right: string } {
  if (!(element instanceof HTMLElement)) throw new Error("expected an HTMLElement");
  return {
    top: element.style.paddingTop || element.style.getPropertyValue("padding-top"),
    bottom: element.style.paddingBottom || element.style.getPropertyValue("padding-bottom"),
    left: element.style.paddingLeft || element.style.getPropertyValue("padding-left"),
    right: element.style.paddingRight || element.style.getPropertyValue("padding-right"),
  };
}

afterEach(() => {
  resetSafeAreaInsets();
  resetWindowSize();
  // Clear any mounted elements in document.body
  document.body.innerHTML = "";
});

describe("ResumeNudge phone sheet insets", () => {
  test("sheet adds bottom inset and horizontal insets in portrait", () => {
    setWindowSize(390, 844);
    setSafeAreaInsets(PORTRAIT_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <ResumeNudge
            session={TEST_SESSION}
            onStartFresh={() => {}}
            onResumeAnyway={() => {}}
            onClose={() => {}}
            now={NOW}
          />,
        );
      });

      const sheet = document.querySelector('[data-testid="resume-nudge-sheet"]');
      expect(sheet).not.toBeNull();
      const pad = padding(sheet);
      expect(pad.bottom).toBe(`${space.loose + PORTRAIT_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${space.wide + PORTRAIT_NOTCH.left}px`);
      expect(pad.right).toBe(`${space.wide + PORTRAIT_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("sheet clears home indicator and side insets in landscape", () => {
    setWindowSize(844, 390);
    setSafeAreaInsets(LANDSCAPE_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <ResumeNudge
            session={TEST_SESSION}
            onStartFresh={() => {}}
            onResumeAnyway={() => {}}
            onClose={() => {}}
            now={NOW}
          />,
        );
      });

      const sheet = document.querySelector('[data-testid="resume-nudge-sheet"]');
      expect(sheet).not.toBeNull();
      const pad = padding(sheet);
      expect(pad.bottom).toBe(`${space.loose + LANDSCAPE_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${space.wide + LANDSCAPE_NOTCH.left}px`);
      expect(pad.right).toBe(`${space.wide + LANDSCAPE_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe("FleetScreen ephemeral review sheet insets", () => {
  test("footer clears home indicator in portrait", () => {
    setWindowSize(390, 844);
    setSafeAreaInsets(PORTRAIT_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <FleetScreen
            browser={TEST_BROWSER_STATE}
            onSort={() => {}}
            onToggleGroup={() => {}}
            onToggleGrouped={() => {}}
            onToggleArchived={() => {}}
            onOpen={() => {}}
            onArchive={() => {}}
            onUnarchive={() => {}}
            onDelete={() => {}}
            deleteAccess="granted"
            link={{ connection: "connected", attempt: 0, indexed: true }}
            now={NOW}
          />,
        );
      });

      const trigger = host.querySelector('[data-testid="ephemeral-review-trigger"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      act(() => {
        trigger.click();
      });

      const footer = document.querySelector('[data-testid="ephemeral-review-footer"]');
      expect(footer).not.toBeNull();
      const pad = padding(footer);
      expect(pad.bottom).toBe(`${space.wide + PORTRAIT_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${space.wide + PORTRAIT_NOTCH.left}px`);
      expect(pad.right).toBe(`${space.wide + PORTRAIT_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("header, toolbar, row, and footer clear left/right insets in landscape", () => {
    setWindowSize(844, 390);
    setSafeAreaInsets(LANDSCAPE_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <FleetScreen
            browser={TEST_BROWSER_STATE}
            onSort={() => {}}
            onToggleGroup={() => {}}
            onToggleGrouped={() => {}}
            onToggleArchived={() => {}}
            onOpen={() => {}}
            onArchive={() => {}}
            onUnarchive={() => {}}
            onDelete={() => {}}
            deleteAccess="granted"
            link={{ connection: "connected", attempt: 0, indexed: true }}
            now={NOW}
          />,
        );
      });

      const trigger = host.querySelector('[data-testid="ephemeral-review-trigger"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      act(() => {
        trigger.click();
      });

      const footer = document.querySelector('[data-testid="ephemeral-review-footer"]');
      expect(footer).not.toBeNull();
      const footerPad = padding(footer);
      expect(footerPad.bottom).toBe(`${space.wide + LANDSCAPE_NOTCH.bottom}px`);
      expect(footerPad.left).toBe(`${space.wide + LANDSCAPE_NOTCH.left}px`);
      expect(footerPad.right).toBe(`${space.wide + LANDSCAPE_NOTCH.right}px`);

      const header = document.querySelector('[data-testid="ephemeral-review-header"]');
      expect(header).not.toBeNull();
      const headerPad = padding(header);
      expect(headerPad.left).toBe(`${space.wide + LANDSCAPE_NOTCH.left}px`);
      expect(headerPad.right).toBe(`${space.wide + LANDSCAPE_NOTCH.right}px`);

      const toolbar = document.querySelector('[data-testid="ephemeral-review-toolbar"]');
      expect(toolbar).not.toBeNull();
      const toolbarPad = padding(toolbar);
      expect(toolbarPad.left).toBe(`${space.wide + LANDSCAPE_NOTCH.left}px`);
      expect(toolbarPad.right).toBe(`${space.wide + LANDSCAPE_NOTCH.right}px`);

      const row = document.querySelector(`[data-testid="ephemeral-item-${SHORT_SESSION.id}"]`);
      expect(row).not.toBeNull();
      const rowPad = padding(row);
      expect(rowPad.left).toBe(`${space.wide + LANDSCAPE_NOTCH.left}px`);
      expect(rowPad.right).toBe(`${space.wide + LANDSCAPE_NOTCH.right}px`);

      // Sheet top clearance: sheet maxHeight leaves the sheet top clear of top inset
      const sheet = document.querySelector('[data-testid="ephemeral-review-sheet"]') as HTMLElement;
      expect(sheet).not.toBeNull();
      const maxH = parseFloat(sheet.style.maxHeight);
      expect(390 - maxH).toBeGreaterThanOrEqual(LANDSCAPE_NOTCH.top);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe("ProjectPicker phone sheet insets", () => {
  test("sheet pays bottom inset in portrait", () => {
    setWindowSize(390, 844);
    setSafeAreaInsets(PORTRAIT_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(<ProjectPicker sessions={PICKER_SESSIONS} selectedProject={null} onSelectProject={() => {}} />);
      });

      const trigger = host.querySelector('[data-testid="project-picker-trigger"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      act(() => {
        trigger.click();
      });

      const sheet = document.querySelector('[data-testid="project-picker-sheet"]');
      expect(sheet).not.toBeNull();
      const pad = padding(sheet);
      expect(pad.bottom).toBe(`${PORTRAIT_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${PORTRAIT_NOTCH.left}px`);
      expect(pad.right).toBe(`${PORTRAIT_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("sheet clears side insets and home indicator in landscape", () => {
    setWindowSize(844, 390);
    setSafeAreaInsets(LANDSCAPE_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(<ProjectPicker sessions={PICKER_SESSIONS} selectedProject={null} onSelectProject={() => {}} />);
      });

      const trigger = host.querySelector('[data-testid="project-picker-trigger"]') as HTMLElement;
      expect(trigger).not.toBeNull();
      act(() => {
        trigger.click();
      });

      const sheet = document.querySelector('[data-testid="project-picker-sheet"]');
      expect(sheet).not.toBeNull();
      const pad = padding(sheet);
      expect(pad.bottom).toBe(`${LANDSCAPE_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${LANDSCAPE_NOTCH.left}px`);
      expect(pad.right).toBe(`${LANDSCAPE_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});

describe("AttachmentBlock full modal insets", () => {
  test("full-size modal content clears all four insets in portrait", () => {
    setWindowSize(390, 844);
    setSafeAreaInsets(PORTRAIT_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <AttachmentBlock
            ref={{ uri: "https://example.com/shot.png", mime: "image/png", name: "shot.png", bytes: 1024 }}
          />,
        );
      });

      const imgBtn = host.querySelector('[data-testid="attachment-image"]') as HTMLElement;
      expect(imgBtn).not.toBeNull();
      act(() => {
        imgBtn.click();
      });

      const full = document.querySelector('[data-testid="attachment-full"]');
      expect(full).not.toBeNull();
      const pad = padding(full);
      expect(pad.top).toBe(`${space.loose + PORTRAIT_NOTCH.top}px`);
      expect(pad.bottom).toBe(`${space.loose + PORTRAIT_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${space.loose + PORTRAIT_NOTCH.left}px`);
      expect(pad.right).toBe(`${space.loose + PORTRAIT_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("full-size modal content clears all four insets in landscape", () => {
    setWindowSize(844, 390);
    setSafeAreaInsets(LANDSCAPE_NOTCH);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <AttachmentBlock
            ref={{ uri: "https://example.com/shot.png", mime: "image/png", name: "shot.png", bytes: 1024 }}
          />,
        );
      });

      const imgBtn = host.querySelector('[data-testid="attachment-image"]') as HTMLElement;
      expect(imgBtn).not.toBeNull();
      act(() => {
        imgBtn.click();
      });

      const full = document.querySelector('[data-testid="attachment-full"]');
      expect(full).not.toBeNull();
      const pad = padding(full);
      expect(pad.top).toBe(`${space.loose + LANDSCAPE_NOTCH.top}px`);
      expect(pad.bottom).toBe(`${space.loose + LANDSCAPE_NOTCH.bottom}px`);
      expect(pad.left).toBe(`${space.loose + LANDSCAPE_NOTCH.left}px`);
      expect(pad.right).toBe(`${space.loose + LANDSCAPE_NOTCH.right}px`);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
