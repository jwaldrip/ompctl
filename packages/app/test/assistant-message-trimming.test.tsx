import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { appendPrompt, EMPTY_SESSION } from "../src/session/model.ts";
import { READY_LOAD } from "../src/console/state.ts";
import type { Agent } from "@ompd/core/contracts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("item 7: assistant-ui repository must drop omitted ids when entries are trimmed", () => {
  test("after 2,001 prompts, trimmed prompt-0 is dropped from the runtime repository", async () => {
    // Dynamic import on purpose: bun evaluates static imports before ./rnw.ts can substitute react-native-web
    const { useOmpAssistantRuntime } = await import("../src/assistant/OmpThread.tsx");

    let session = EMPTY_SESSION;
    for (let i = 0; i <= 2000; i++) {
      session = appendPrompt(session, `prompt ${i}`);
    }
    // Reducer dropped prompt-0 and kept 2,000 entries
    expect(session.entries).toHaveLength(2000);
    expect(session.entries[0]?.id).toBe("prompt-1");
    expect(session.entries.some(e => e.id === "prompt-0")).toBe(false);

    let runtimeHandle: any = null;
    function Probe({ currentSession }: { currentSession: typeof session }) {
      runtimeHandle = useOmpAssistantRuntime({
        agent: { id: "a1", name: "Agent 1", state: "idle" } as unknown as Agent,
        session: currentSession,
        connection: "connected",
        load: READY_LOAD,
        promptAccess: "granted",
        canApprove: false,
        onSubmit: () => {},
        onCancel: () => {},
        onDecide: () => {},
        onDecidePlan: () => {},
      });
      return null;
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    // Initial mount with first prompt
    let initialSession = appendPrompt(EMPTY_SESSION, "prompt 0");
    act(() => {
      root.render(createElement(Probe, { currentSession: initialSession }));
    });

    expect(runtimeHandle.threads.main.getMessageById("user:prompt-0")).toBeDefined();

    // Now update to the trimmed session (2,000 entries, prompt-0 is gone)
    act(() => {
      root.render(createElement(Probe, { currentSession: session }));
    });

    let prompt0Message: unknown = null;
    try {
      prompt0Message = runtimeHandle.threads.main.getMessageById("user:prompt-0");
    } catch {
      prompt0Message = undefined;
    }
    const exported = runtimeHandle.threads.main.export();
    expect(prompt0Message).toBeUndefined();
    expect(exported.messages).toHaveLength(2000);

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
