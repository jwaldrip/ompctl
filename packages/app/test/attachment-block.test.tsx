import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

import type { AttachmentRef } from "../src/components/rich/blocks.ts";
// Dynamic on purpose: ./rnw.ts must finish registering its react-native mock
// before the component module is evaluated, and every render test here leans
// on that same ordering.
const { AttachmentBlock } = await import("../src/components/rich/AttachmentBlock.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The fake network. happy-dom never fetches, so RNW's ImageLoader would sit
 * silent and no load or failure could ever be observed. Rather than mock
 * `Image` away, the shim below answers through the same callbacks the real
 * loader assigns, the same discipline `scanCode` uses to drive the camera
 * stub: the component under test runs its production code path untouched.
 */
const answers = new Map<string, { width: number; height: number } | null>();

/** Answer a uri with dimensions, the way a completed fetch would. */
function serveImage(uri: string, width: number, height: number): void {
  answers.set(uri, { width, height });
}

/** Drop a uri, the way a dead route on cellular would. */
function dropImage(uri: string): void {
  answers.set(uri, null);
}

afterEach(() => {
  answers.clear();
});

/**
 * RNW's ImageLoader assigns onload and onerror to a `new window.Image()` and
 * then sets src. Patching the src setter on happy-dom's own prototype lets a
 * test fire those handlers with whatever payload the platform would have
 * delivered, without the component ever knowing a test is present.
 */
type LoaderImage = {
  onload: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

const imagePrototype = Object.getPrototypeOf(new Image()) as object;
let holder: object | null = imagePrototype;
let originalSet: ((value: string) => void) | undefined;
while (holder !== null) {
  const descriptor = Object.getOwnPropertyDescriptor(holder, "src");
  if (descriptor?.set !== undefined) {
    originalSet = descriptor.set;
    Object.defineProperty(holder, "src", {
      ...descriptor,
      set(value: string) {
        descriptor.set?.call(this, value);
        const served = answers.get(value);
        if (served === undefined) return;
        const loaderImage = this as unknown as LoaderImage;
        // A microtask keeps the resulting state update inside the next act
        // flush, exactly where a real decode callback would land it.
        queueMicrotask(() => {
          if (served === null) {
            loaderImage.onerror?.(new Event("error"));
          } else {
            loaderImage.onload?.({ target: { naturalWidth: served.width, naturalHeight: served.height } });
          }
        });
      },
    });
    break;
  }
  holder = Object.getPrototypeOf(holder);
}
if (originalSet === undefined) {
  throw new Error("happy-dom's Image exposes no src setter for the test to drive");
}

function renderAttachment(ref: AttachmentRef) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(<AttachmentBlock ref={ref} />);
  });
  return { host, root };
}

/** Let every queued load, error, and decode callback run to completion. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

const shotUri = "https://hub.ompctl.ai/files/shot.png";

describe("AttachmentBlock", () => {
  test("a png the daemon typed renders inline, not as a file row", async () => {
    serveImage(shotUri, 800, 600);
    const { host, root } = renderAttachment({ uri: shotUri, mime: "image/png", name: "shot.png", bytes: 2048 });

    const shown = host.querySelector(`img[src="${shotUri}"]`);
    expect(shown).not.toBeNull();
    expect(shown?.getAttribute("alt")).toBe("shot.png");
    expect(host.querySelector('[data-testid="attachment-file"]')).toBeNull();

    await settle();
    expect(host.querySelector('[data-testid="attachment-failed"]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a zip is named as a file with its type and size, never as a broken frame", () => {
    const uri = "https://hub.ompctl.ai/files/logs.zip";
    const { host, root } = renderAttachment({ uri, mime: "application/zip", name: "logs.zip", bytes: 4096 });

    expect(host.querySelector('[data-testid="attachment-file"]')).not.toBeNull();
    expect(host.textContent).toContain("logs.zip");
    expect(host.textContent).toContain("application/zip");
    expect(host.textContent).toContain("4.0 KB");
    expect(host.querySelector(`img[src="${uri}"]`)).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("an svg is an image mime RN cannot rasterize, so it stays a file row", () => {
    const uri = "https://hub.ompctl.ai/files/diagram.svg";
    const { host, root } = renderAttachment({ uri, mime: "image/svg+xml", name: "diagram.svg", bytes: null });

    expect(host.querySelector('[data-testid="attachment-file"]')).not.toBeNull();
    expect(host.textContent).toContain("image/svg+xml");
    expect(host.querySelector(`img[src="${uri}"]`)).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a null mime with an image extension on the name is inferred and displayed", async () => {
    // The uri deliberately carries no extension; only the name says png.
    const uri = "https://hub.ompctl.ai/files/9ac3f2";
    serveImage(uri, 800, 600);
    const { host, root } = renderAttachment({ uri, mime: null, name: "screenshot.png", bytes: null });

    expect(host.querySelector(`img[src="${uri}"]`)).not.toBeNull();

    await settle();
    expect(host.querySelector('[data-testid="attachment-failed"]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a null mime with an image extension only on the uri is still inferred", () => {
    const uri = "https://hub.ompctl.ai/files/chart.webp";
    const { host, root } = renderAttachment({ uri, mime: null, name: "latest chart", bytes: null });

    expect(host.querySelector(`img[src="${uri}"]`)).not.toBeNull();
    expect(host.querySelector('[data-testid="attachment-file"]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("a null mime with no usable extension stays a file row rather than guessing", () => {
    const uri = "https://hub.ompctl.ai/files/9ac3f2";
    const { host, root } = renderAttachment({ uri, mime: null, name: "blob-ref", bytes: 512 });

    expect(host.querySelector('[data-testid="attachment-file"]')).not.toBeNull();
    expect(host.querySelector(`img[src="${uri}"]`)).toBeNull();
    expect(host.textContent).toContain("blob-ref");
    expect(host.textContent).toContain("512 B");
    expect(host.textContent).not.toContain("image/");

    act(() => root.unmount());
    host.remove();
  });

  test("a dropped fetch says so and offers a retry that goes back through the load path", async () => {
    const uri = "https://hub.ompctl.ai/files/flaky.png";
    dropImage(uri);
    const { host, root } = renderAttachment({ uri, mime: "image/png", name: "flaky.png", bytes: 1024 });

    await settle();
    expect(host.querySelector('[data-testid="attachment-failed"]')).not.toBeNull();
    expect(host.textContent).toContain("Could not load");
    expect(host.textContent).toContain("Try again");
    expect(host.querySelector(`img[src="${uri}"]`)).toBeNull();

    // The network heals; retrying must actually fetch again, not restore hope.
    serveImage(uri, 800, 600);
    act(() => {
      (host.querySelector('[data-testid="attachment-retry"]') as HTMLElement).click();
    });
    await settle();
    expect(host.querySelector('[data-testid="attachment-failed"]')).toBeNull();
    expect(host.querySelector(`img[src="${uri}"]`)).not.toBeNull();

    act(() => root.unmount());
    host.remove();
  });

  test("tapping the inline image opens it full size and tapping anywhere closes", async () => {
    serveImage(shotUri, 1200, 900);
    const { host, root } = renderAttachment({ uri: shotUri, mime: "image/png", name: "panel.png", bytes: null });
    await settle();

    // RNW portals a Modal into document.body, so the overlay lives outside host.
    expect(document.querySelector('[data-testid="attachment-full"]')).toBeNull();
    act(() => {
      (host.querySelector('[data-testid="attachment-image"]') as HTMLElement).click();
    });

    const overlay = document.querySelector('[data-testid="attachment-full"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.querySelector(`img[src="${shotUri}"]`)).not.toBeNull();
    expect(overlay?.textContent).toContain("panel.png");

    act(() => {
      (overlay as HTMLElement).click();
    });
    expect(document.querySelector('[data-testid="attachment-full"]')).toBeNull();

    act(() => root.unmount());
    host.remove();
  });
});
