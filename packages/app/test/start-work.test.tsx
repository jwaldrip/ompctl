import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { BrowserState } from "../src/session/browser.ts";
import { EMPTY_BROWSER } from "../src/session/browser.ts";

// The RNW substitution must load before a screen imports react-native.
const { FleetScreen } = await import("../src/screens/FleetScreen.tsx");

declare global { var IS_REACT_ACT_ENVIRONMENT: boolean | undefined; }
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SESSION = {
  id: "work", title: "Repair the build", cwd: "/work/project", status: "dormant" as const,
  createdAt: "2026-09-01T00:00:00Z", lastActiveAt: "2026-09-01T00:00:00Z", messageCount: 5, sizeBytes: 1000,
};

function mount(initial: Partial<BrowserState>) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let state: BrowserState = { ...EMPTY_BROWSER, sessions: [SESSION], ...initial };
  let browsed = false;
  const update = (patch: Partial<BrowserState>) => { state = { ...state, ...patch }; render(); };
  const render = () => root.render(
    <FleetScreen browser={state} link={{ connection: "connected", indexed: true, attempt: 0 }}
      deleteAccess="granted" onSort={() => {}} onToggleGroup={() => {}} onToggleGrouped={() => {}}
      onToggleArchived={() => update({ showArchived: !state.showArchived })}
      onSetQuery={query => update({ query })} onSetProject={project => update({ project })}
      onOpen={() => {}} onArchive={() => {}} onUnarchive={() => {}} onDelete={() => {}} onNewSession={() => {}}
      onBrowseFolders={() => { browsed = true; }} />,
  );
  act(render);
  const find = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  return {
    find,
    get state() { return state; },
    get browsed() { return browsed; },
    click(id: string) { const el = find(id); expect(el).not.toBeNull(); act(() => el?.click()); },
    close() { act(() => root.unmount()); host.remove(); },
  };
}

describe("return to work from Sessions", () => {
  test("a failed search offers recovery without claiming the daemon has no sessions", () => {
    const h = mount({ query: "missing", project: "/work/project" });
    try {
      expect(h.find("fleet-no-matches")).not.toBeNull();
      expect(h.find("fleet-empty")).toBeNull();
      h.click("fleet-reset-filters");
      expect(h.state.query).toBe("");
      expect(h.state.project).toBeNull();
      expect(h.find("fleet-no-matches")).toBeNull();
      expect(h.find("session-row-work")).not.toBeNull();
    } finally { h.close(); }
  });

  test("an archive-only library offers its existing sessions instead of a CLI dead end", () => {
    const h = mount({ sessions: [{ ...SESSION, status: "archived" }] });
    try {
      expect(h.find("fleet-archived-only")).not.toBeNull();
      h.click("fleet-show-archived");
      expect(h.state.showArchived).toBe(true);
      expect(h.find("session-row-work")).not.toBeNull();
    } finally { h.close(); }
  });

  test("Browse folders leaves the recent-project picker for the start-session route", () => {
    const h = mount({});
    try {
      h.click("sessions-new");
      h.click("project-picker-browse-folders");
      expect(h.browsed).toBe(true);
      expect(h.find("project-picker-search")).toBeNull();
      expect(h.find("folder-picker-screen")).toBeNull();
    } finally { h.close(); }
  });
});
