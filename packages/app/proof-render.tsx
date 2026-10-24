/**
 * Scratch visual rig: the real `Console` over a canned socket, rendered through
 * the same `react-native` -> `react-native-web` substitution the web build
 * makes, then serialized (DOM plus the stylesheet react-native-web generated)
 * so a real browser can paint the states a daemon only reaches through timing.
 * Untracked, deleted once the frames are captured.
 */

import "./test/rnw.ts";

import { copyFileSync, mkdirSync } from "node:fs";
import type { OmpdClient } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection, ConnectionList } from "./src/platform/connection.ts";

const { Console } = await import("./src/console/Console.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTION: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_rig",
  scopes: ["read", "prompt", "approve", "manage"],
};
const CONNECTIONS: ConnectionList = {
  activeId: "local",
  connections: [{ id: "local", label: "Studio Mac", connection: CONNECTION }],
};

class RigClient {
  readonly connectionState = "connected";
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  emit(name: string, event: unknown): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  on(name: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(name) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(name, list);
    return () => {
      this.listeners.set(
        name,
        (this.listeners.get(name) ?? []).filter(entry => entry !== listener),
      );
    };
  }
  start(): void {}
  close(): void {}
  reconnectNow(): void {}
  attach(): void {}
  listSessions(): void {}
  sessionHistory(): void {}
  sessionTail(): void {}
  sessionPrompt(): void {}
  resumeSession(): void {}
  openCollab(): void {}
  leaveCollab(): void {}
  deleteSessions(): void {}
  prompt(): void {}
  cancel(): void {}
  decide(): void {}
  decidePlan(): void {}
  registerWebView(): void {}
  unregisterWebView(): void {}
  webViewResult(): void {}
  sendAudio(): void {}
  endAudio(): void {}
  readSkills(): void {}
  readConnectors(): void {}
  readTasks(): void {}
  createTask(): void {}
  cancelTask(): void {}
  listDirectory(): void {}
  createAgent(): void {}
}

const DORMANT = {
  id: "sess_dormant",
  title: "ompctl session view",
  cwd: "/Users/jwaldrip/dev/src/github.com/jwaldrip/ompctl",
  cwdScope: "home",
  flattenedDir: "-Users-jwaldrip-dev-src-github-com-jwaldrip-ompctl",
  status: "dormant",
  createdAt: "2026-08-20T00:00:00.000Z",
  lastActivityAt: "2026-08-22T00:00:00.000Z",
  messageCount: 119,
  byteSize: 4_200_000,
  archived: false,
};

const OUT = `${import.meta.dir}/proof-frames`;
const FONTS = ["Archivo-Regular", "Archivo-Medium", "Archivo-SemiBold", "IBMPlexMono-Regular", "IBMPlexMono-Medium"];
mkdirSync(`${OUT}/fonts`, { recursive: true });
for (const font of FONTS) {
  copyFileSync(`${import.meta.dir}/src/design/fonts/${font}.ttf`, `${OUT}/fonts/${font}.ttf`);
}
const FACES = FONTS.map(
  name => `@font-face{font-family:"${name}";src:url("./fonts/${name}.ttf") format("truetype");}`,
).join("\n");

const client = new RigClient();
const host = document.createElement("div");
document.body.appendChild(host);
const root = createRoot(host);

act(() => {
  root.render(
    <Console
      connection={CONNECTION}
      daemonLabel="Studio Mac"
      connections={CONNECTIONS}
      onAddConnection={() => {}}
      onSelectConnection={() => {}}
      onUnpair={() => {}}
      createClient={() => client as unknown as OmpdClient}
    />,
  );
});

function el(testID: string): HTMLElement | null {
  const found = host.querySelector(`[data-testid="${testID}"]`);
  return found instanceof HTMLElement ? found : null;
}

function press(testID: string): void {
  const target = el(testID);
  if (target === null) throw new Error(`no ${testID} control rendered`);
  act(() => {
    target.click();
  });
}

const frames: string[] = [];
function capture(file: string, caption: string): void {
  const styles = [...document.querySelectorAll("style")].map(node => node.outerHTML).join("\n");
  Bun.write(
    `${OUT}/${file}`,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<style>${FACES}
html,body{margin:0;background:#0d0c0a;color:#cfc9bd;font-family:system-ui,sans-serif}
#caption{padding:10px 14px;font-size:13px}
#frame{width:390px;height:844px;margin:0 14px 14px;display:flex;border:1px solid #3a352e}
#frame > div{display:flex;flex:1}
</style>
${styles}
</head><body>
<div id="caption">${caption}</div>
<div id="frame">${host.innerHTML}</div>
</body></html>`,
  );
  frames.push(file);
  console.log(`${file}  ${caption}`);
}

act(() => {
  client.emit("status", { state: "connected", attempt: 0 });
  client.emit("sessions", { sessions: [DORMANT] });
});
capture("0-list.html", "0. the fleet: one dormant session, 119 messages");

press("session-open-sess_dormant");
act(() => {
  client.emit("session_opened", { sessionId: "sess_dormant", agentId: "agt_resumed" });
});
console.log("   session-gone:", el("session-gone") !== null, "| transcript-loading:", el("transcript-loading") !== null);
capture("1-resume-window.html", "1. resume answered, the first page is still being read");

act(() => {
  client.emit("session_history", {
    agentId: "agt_resumed",
    sessionId: "sess_dormant",
    entries: [
      { kind: "user", id: "h1", text: "Fix the three session view defects.", at: "" },
      {
        kind: "assistant",
        id: "h2",
        text: "The first one decides how much of the rest matters.",
        thought: false,
        at: "",
      },
    ],
    nextBefore: null,
  });
});
console.log("   transcript-loading after the page:", el("transcript-loading") !== null);
capture("2-page-landed.html", "2. the first history page landed");

press("session-back");
press("open-menu");
press("open-cowork");
act(() => {
  client.emit("tasks", {
    tasks: [
      {
        id: "t_stale",
        title: "Audit the deleted session",
        prompt: "read the transcript",
        agentId: "agt_stale",
        state: "running",
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:10:00.000Z",
        labels: {},
      },
    ],
  });
});
press("task-t_stale");
press("task-detail-open-session");
console.log("   session-gone:", el("session-gone") !== null, "| session-gone-back:", el("session-gone-back") !== null);
capture("3-gone.html", "3. a session nothing vouches for, carrying the way back");

press("session-gone-back");
console.log("   fleet-list after the back control:", el("fleet-list") !== null);
capture("4-back-on-list.html", "4. the back control landed on the list");

Bun.write(
  `${OUT}/index.html`,
  `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>session view frames</title>
<style>html,body{margin:0;background:#0d0c0a;color:#cfc9bd;font-family:system-ui,sans-serif}
.row{display:flex;flex-wrap:wrap}iframe{width:420px;height:920px;border:0}</style></head><body>
${frames.map(file => `<iframe src="./${file}"></iframe>`).join("\n")}
</body></html>`,
);
console.log(`\nframes at ${OUT}/index.html`);
