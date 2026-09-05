import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { MessageNotSentError } from "@assistant-ui/core";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ompStore } from "../src/assistant/adapter.ts";
import { EMPTY_SESSION } from "../src/session/model.ts";
import type { Agent } from "@ompd/core/contracts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function typeInto(input: HTMLElement, value: string): void {
  const key = Object.keys(input).find(name => name.startsWith("__reactProps$"));
  if (key === undefined) throw new Error("no React props on the rendered input");
  const props = Reflect.get(input, key) as { onChange?: (event: unknown) => void };
  act(() => {
    (input as HTMLInputElement).value = value;
    props.onChange?.({
      target: input,
      currentTarget: input,
      nativeEvent: { text: value },
      preventDefault: () => {},
      stopPropagation: () => {},
    });
  });
}

describe("item 4: offline prompt must reject with MessageNotSentError to restore composer draft", () => {
  test("adapter.onNew rejects with MessageNotSentError when onSubmit returns false", async () => {
    let submitted = false;
    const store = ompStore({
      agent: { id: "a1", name: "Agent 1", state: "idle" } as unknown as Agent,
      session: EMPTY_SESSION,
      load: { phase: "ready", generation: 1, error: null },
      connection: "connected",
      promptAccess: "granted",
      canApprove: false,
      onSubmit: async () => {
        submitted = true;
        // Action reports message was not sent (e.g. offline or missing prompt scope)
        return false;
      },
      onCancel: () => {},
      onDecide: () => {},
      onDecidePlan: () => {},
    });

    let caughtError: unknown = null;
    try {
      await store.onNew({
        content: [{ type: "text", text: "unsent words" }],
      });
    } catch (err) {
      caughtError = err;
    }

    expect(submitted).toBe(true);
    // Pre-fix failure: caughtError is null because onNew returns Promise<void> without throwing!
    expect(caughtError).toBeInstanceOf(MessageNotSentError);
  });

  test("Composer keeps draft text when onSubmit returns false", async () => {
    // Dynamic import on purpose: bun evaluates static imports before ./rnw.ts can substitute react-native-web
    const { Composer } = await import("../src/components/Composer.tsx");
    const { imageAttachmentPicker } = await import("../src/platform/attachments.ts");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    let submitCount = 0;
    act(() => {
      root.render(
        createElement(Composer, {
          prefix: "terminal-composer",
          picker: imageAttachmentPicker,
          enabled: true,
          busy: false,
          placeholder: "Type message",
          sendLabel: "Send",
          onSubmit: () => {
            submitCount++;
            return false;
          },
        }),
      );
    });

    const input = host.querySelector('[data-testid="terminal-composer-input"]') as HTMLInputElement | HTMLTextAreaElement;
    expect(input).not.toBeNull();

    // Type text into the field
    typeInto(input, "unsent words");
    expect(input.value).toBe("unsent words");

    // Click send
    const sendButton = host.querySelector('[data-testid="terminal-composer-send"]') as HTMLElement;
    expect(sendButton).not.toBeNull();
    await act(async () => {
      sendButton.click();
    });

    expect(submitCount).toBe(1);
    // Pre-fix failure: input.value is cleared to "" even when onSubmit returns false!
    expect(input.value).toBe("unsent words");

    act(() => {
      root.unmount();
    });
    host.remove();
  });
});
