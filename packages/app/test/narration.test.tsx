import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { Agent } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Entry, SessionState } from "../src/session/model.ts";
import { EMPTY_SESSION } from "../src/session/model.ts";
// These modules import React Native. Loading them after rnw.ts is what makes
// this test exercise the web target instead of Bun trying to load native code.

const { createDeviceNarrationSpeech, SessionNarrator } = await import("../src/voice/narration.ts");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const AGENT: Agent = {
  id: "agt_narration",
  name: "road companion",
  state: "busy",
  host: { kind: "local", id: "1", spec: { kind: "local" } },
  cwd: "/work",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastActiveAt: "2026-01-01T00:00:00.000Z",
  labels: {},
};

class RecordingSpeech {
  readonly availability = { available: true } as const;
  readonly spoken: string[] = [];
  stopCalls = 0;
  hold: Promise<void> | null = null;

  async speak(text: string): Promise<void> {
    this.spoken.push(text);
    await this.hold;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

function assistant(text: string, streaming = true): Entry {
  return { kind: "assistant", id: "answer", text, streaming, thought: false };
}

function session(entries: readonly Entry[]): SessionState {
  return { ...EMPTY_SESSION, entries };
}

describe("session narration", () => {
  test("reads each completed part of a growing reply exactly once", async () => {
    const speech = new RecordingSpeech();
    const narrator = new SessionNarrator(speech);

    expect(narrator.start([])).toBe(true);
    narrator.update([assistant("The first sentence.")]);
    narrator.update([assistant("The first sentence. The second sentence.")]);
    narrator.update([assistant("The first sentence. The second sentence.")]);
    await narrator.whenIdle();

    expect(speech.spoken).toEqual(["The first sentence.", "The second sentence."]);
  });

  test("turning narration off stops the current speech and drops queued reply text", async () => {
    const speech = new RecordingSpeech();
    const release = Promise.withResolvers<void>();
    speech.hold = release.promise;
    const narrator = new SessionNarrator(speech);

    narrator.start([]);
    narrator.update([assistant("First part. Second part.")]);
    await Promise.resolve();
    await Promise.resolve();
    expect(speech.spoken).toEqual(["First part."]);

    narrator.stop();
    expect(speech.stopCalls).toBe(1);
    release.resolve();
    await narrator.whenIdle();

    narrator.update([assistant("First part. Second part. Third part.")]);
    await narrator.whenIdle();
    expect(speech.spoken).toEqual(["First part."]);
  });

  test("reads assistant prose but never tool, system, user, or thought rows", async () => {
    const speech = new RecordingSpeech();
    const narrator = new SessionNarrator(speech);
    const rows: Entry[] = [
      { kind: "tool", id: "tool", toolKind: "execute", title: "Run tests", status: "completed", input: null, output: "done", locations: [] },
      { kind: "unknown", id: "system", label: "system notice", payload: { text: "Do not say this." } },
      { kind: "user", id: "user", text: "Do not echo me." },
      { kind: "assistant", id: "thought", text: "Private reasoning.", streaming: true, thought: true },
      assistant("This is the answer."),
    ];

    narrator.start([]);
    narrator.update(rows);
    await narrator.whenIdle();

    expect(speech.spoken).toEqual(["This is the answer."]);
  });

  test("the session control shows its unavailable reason instead of enabling", () => {
    const reason = "Narration is unavailable on web: this build has no OmpctlNarration text-to-speech module.";
    const unavailableSpeech = {
      availability: { available: false, reason } as const,
      speak: async () => {},
      stop: async () => {},
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <SessionScreen
          agent={AGENT}
          session={EMPTY_SESSION}
          connection="connected"
          attempt={0}
          canApprove
          spoken={null}
          fleetClearances={0}
          onBack={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
          narrationSpeech={unavailableSpeech}
        />,
      );
    });

    const toggle = host.querySelector('[data-testid="session-narration-toggle"]') as HTMLElement | null;
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-disabled")).toBe("true");
    expect(host.querySelector('[data-testid="session-narration-status"]')?.textContent).toContain("Narration unavailable");
    expect(host.querySelector('[data-testid="session-narration-reason"]')?.textContent).toBe(reason);

    act(() => root.unmount());
    host.remove();
  });

  test("the session toggle enables the streaming narration pipeline and shows that it is on", async () => {
    const speech = new RecordingSpeech();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const draw = (value: SessionState): void => {
      act(() => {
        root.render(
          <SessionScreen
            agent={AGENT}
            session={value}
            connection="connected"
            attempt={0}
            canApprove
            spoken={null}
            fleetClearances={0}
            onBack={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            onDecide={() => {}}
            onDecidePlan={() => {}}
            narrationSpeech={speech}
          />,
        );
      });
    };

    draw(EMPTY_SESSION);
    const toggle = host.querySelector('[data-testid="session-narration-toggle"]') as HTMLButtonElement | null;
    if (toggle === null) throw new Error("narration toggle is missing");
    act(() => toggle.click());
    expect(host.querySelector('[data-testid="session-narration-status"]')?.textContent).toContain("Narration on");

    draw(session([assistant("Keep going.")]));
    draw(session([assistant("Keep going. I am with you.")]));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(speech.spoken).toEqual(["Keep going.", "I am with you."]);

    act(() => root.unmount());
    host.remove();
  });

  test("one native module supplies the complete speech seam", async () => {
    const calls: string[] = [];
    const speech = createDeviceNarrationSpeech("ios", {
      speak: async text => {
        calls.push(`speak:${text}`);
      },
      stop: async () => {
        calls.push("stop");
      },
    });

    expect(speech.availability.available).toBe(true);
    await speech.speak("Road ready.");
    await speech.stop();
    expect(calls).toEqual(["speak:Road ready.", "stop"]);
  });

  test("names the missing native seam for iOS, Android, and web", () => {
    for (const [platform, name] of [
      ["ios", "iOS"],
      ["android", "Android"],
      ["web", "web"],
    ] as const) {
      const speech = createDeviceNarrationSpeech(platform, undefined);
      expect(speech.availability.available).toBe(false);
      if (speech.availability.available) throw new Error("missing module reported available");
      expect(speech.availability.reason).toContain(name);
      expect(speech.availability.reason).toContain("OmpctlNarration");
    }
  });
});
