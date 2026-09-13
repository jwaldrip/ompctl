// Run under preload-react.ts: RNW's module substitution must precede the screens.
import "./rnw.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { act, cloneElement } from "react";
import { createRoot } from "react-dom/client";
import { EMPTY_REMOTE_START } from "../src/remote/model.ts";
import { EMPTY_BROWSER } from "../src/session/browser.ts";
import { resetSafeAreaInsets, setSafeAreaInsets, setWindowSize } from "./rnw.ts";

// These modules import react-native, so static imports would bypass rnw.ts.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");
const { BrowseScreen } = await import("../src/screens/BrowseScreen.tsx");
const { ProjectPicker } = await import("../src/components/ProjectPicker.tsx");
const { Keyboard } = await import("react-native");
const keyboardListeners = new Set<(event: { endCoordinates: { height: number } }) => void>();
const addKeyboardListener = Keyboard.addListener;
Reflect.set(
  Keyboard,
  "addListener",
  (name: string, listener: (event: { endCoordinates: { height: number } }) => void) => {
    if (name === "keyboardWillShow") keyboardListeners.add(listener);
    return { remove: () => keyboardListeners.delete(listener) };
  },
);

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const out = process.env.OMPCTL_RENDER_DIR;
if (!out) throw new Error("OMPCTL_RENDER_DIR must name the output directory");
mkdirSync(out, { recursive: true });
// Keep the shipped font binaries and scrollbar rules, rather than measuring a system fallback.
const appCss = readFileSync(join(import.meta.dir, "../index.html"), "utf8").match(/<style>([\s\S]*?)<\/style>/)?.[1];
if (appCss === undefined) throw new Error("The app has no web stylesheet");
const documentCss = appCss.replace(
  /url\("\/src\/design\/fonts\/([^"]+)"\)/g,
  (_match, file: string) =>
    'url("data:font/ttf;base64,' +
    readFileSync(join(import.meta.dir, "../src/design/fonts", file)).toString("base64") +
    '")',
);
const session = {
  id: "work",
  title: "Repair the build",
  cwd: "/work/project",
  status: "dormant" as const,
  createdAt: "2026-09-01T00:00:00Z",
  lastActiveAt: "2026-09-01T00:00:00Z",
  messageCount: 5,
  sizeBytes: 1000,
};
const state = {
  ...EMPTY_REMOTE_START,
  listed: true,
  path: "/work",
  parent: null,
  roots: ["/work"],
  entries: [
    { name: "project", kind: "dir" as const, gitRepo: true },
    { name: "archive", kind: "dir" as const },
  ],
};
const noop = () => {};

for (const [width, height] of [
  [390, 844],
  [1024, 768],
] as const) {
  setWindowSize(width, height);
  setSafeAreaInsets({ top: width === 390 ? 47 : 0, bottom: width === 390 ? 34 : 0, left: 0, right: 0 });
  const frames: [string, ReactNode][] = [
    [
      "no-matches",
      <FleetScreen
        key="no-matches"
        browser={{ ...EMPTY_BROWSER, sessions: [session], query: "not-here" }}
        link={{ connection: "connected", indexed: true, attempt: 0 }}
        deleteAccess="granted"
        onSort={noop}
        onToggleGroup={noop}
        onToggleGrouped={noop}
        onToggleArchived={noop}
        onOpen={noop}
        onArchive={noop}
        onUnarchive={noop}
        onDelete={noop}
        onNewSession={noop}
        onSetQuery={noop}
        onSetProject={noop}
      />,
    ],
    [
      "project-picker",
      <ProjectPicker
        key="project-picker"
        sessions={[session, { ...session, id: "other", cwd: "/work/another-project" }]}
        selectedProject={null}
        mode="start"
        open
        onSelectProject={noop}
        onClose={noop}
        onBrowseFolders={noop}
      />,
    ],
    [
      "new-session",
      <BrowseScreen
        key="new-session"
        state={state}
        onOpenChild={noop}
        onOpenPath={noop}
        onUp={noop}
        onRefresh={noop}
        onStartHere={noop}
        onCloneHere={noop}
        onDismissNotice={noop}
        onDismissClone={noop}
        onBack={noop}
      />,
    ],
    [
      "bound-folder",
      <BrowseScreen
        key="bound-folder"
        state={state}
        onBindFolder={noop}
        onOpenChild={noop}
        onOpenPath={noop}
        onUp={noop}
        onRefresh={noop}
        onStartHere={noop}
        onCloneHere={noop}
        onDismissNotice={noop}
        onDismissClone={noop}
        onBack={noop}
      />,
    ],
  ];
  const fleet = frames[0]?.[1] as ReactElement<ComponentProps<typeof FleetScreen>>;
  frames.push(
    [
      "archived-only",
      cloneElement(fleet, { browser: { ...EMPTY_BROWSER, sessions: [{ ...session, status: "archived" }] } }),
    ],
    ["empty-library", cloneElement(fleet, { browser: EMPTY_BROWSER })],
  );
  if (width === 390) {
    for (const [name, node] of frames.slice(1, 4)) frames.push([name + "-keyboard", node]);
  }
  for (const [name, node] of frames) {
    const host = document.createElement("div");
    host.id = "frame";
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(node));
    if (name.endsWith("-keyboard"))
      act(() => {
        for (const listener of keyboardListeners) listener({ endCoordinates: { height: 300 } });
      });
    const css = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules].map(rule => rule.cssText)).join("\n");
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}-${width}</title>
<style>${css}</style><style>${documentCss}</style><style>html,body{margin:0!important;padding:0!important;background:#0a0c10}#frame{width:${width}px;height:${height}px;display:flex;flex-direction:column}#frame>*{flex:1;min-height:0}</style>
</head><body>${document.body.innerHTML}</body></html>`;
    writeFileSync(join(out, `${name}-${width}.html`), html);
    console.log(`${name}-${width}: ${width}x${height}`);
    act(() => root.unmount());
    host.remove();
  }
}
Keyboard.addListener = addKeyboardListener;
resetSafeAreaInsets();
