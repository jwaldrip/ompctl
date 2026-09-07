/**
 * The agent config screen, over a fake socket client.
 *
 * The screen's whole job is one `agent_config_read` and one
 * `agent_config_write` per change, answered by `agent_config` events (or an
 * `error` naming the refusal), so the harness is a canned client: a recorder
 * that answers from a script. What these hold is the behaviour the daemon's
 * contract actually promises: options grouped with the model first, the exact
 * write frame the daemon accepts, refusals named on screen rather than
 * swallowed, scope-missing controls disabled beside their reason, one change
 * in flight at a time, and the same screen on a hub pairing as on a direct
 * one, because the socket is the one road every pairing has. The
 * optimistic-update ban is asserted the hard way: the Current marker moves
 * only after the daemon's answer arrives.
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { AgentId } from "@ompd/core/contracts";
import type { AgentConfigEvent, ClientErrorEvent } from "@ompd/core/ompd-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Connection } from "../src/platform/connection.ts";

// Dynamic on purpose, the same reason every screen test in this directory
// is: a static import of a screen resolves `react-native` before `./rnw.ts`
// has had a chance to substitute it with react-native-web.
const { AgentConfigScreen } = await import("../src/screens/AgentConfigScreen.tsx");
const { SessionScreen } = await import("../src/screens/SessionScreen.tsx");
const { EMPTY_SESSION } = await import("../src/session/model.ts");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const DIRECT: Connection = {
  transport: "direct",
  url: "ws://127.0.0.1:7777/v1/socket",
  token: "tok_config",
  scopes: ["read", "prompt"],
};

const HUB: Connection = {
  transport: "hub",
  hubUrl: "wss://hub.ompctl.ai/v1/socket",
  daemonId: "dmn_probe",
  token: "tok_config",
  scopes: ["read", "prompt"],
};

const AGENT = "agt_probe" as AgentId;

/**
 * The config a daemon serves for one live session. The options mirror what
 * the daemon's own fake host reports `omp acp` sends: a mode, a model, and a
 * thinking level, every one of them settable over the socket.
 */
function config(modeValue = "default", modelValue = "anthropic/claude-opus-5"): AgentConfigEvent {
  return {
    agentId: AGENT,
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: modeValue,
        options: [
          { value: "default", name: "Default", description: "Standard ACP headless mode" },
          { value: "plan", name: "Plan", description: "Read-only planning mode" },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: modelValue,
        options: [
          { value: "anthropic/claude-opus-5", name: "Claude Opus 5" },
          { value: "openai/gpt-5.4", name: "GPT-5.4" },
          { value: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        ],
      },
      {
        id: "thinking",
        name: "Thinking",
        category: "thinking",
        type: "select",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
        ],
      },
    ],
  };
}

/** The daemon's model list at its real size: 194 choices on 2026-09-07. */
function wideConfig(): AgentConfigEvent {
  const base = config();
  const model = base.configOptions.find(option => option.id === "model");
  if (model === undefined) throw new Error("fixture has no model option");
  model.options = Array.from({ length: 194 }, (_, i) => ({
    value: `vendor-${i % 7}/model-${String(i).padStart(3, "0")}${i % 9 === 0 ? "-haiku" : ""}`,
    name: `Model ${i}${i % 9 === 0 ? " Haiku" : ""}`,
  }));
  model.currentValue = model.options[0]?.value ?? "";
  return base;
}

interface Recorded {
  t: "agent_config_read" | "agent_config_write";
  agentId: AgentId;
  optionId?: string;
  value?: string;
}

/**
 * A client that records what the screen sends and answers from a script.
 * `reply` returns the event to emit, or a promise of one (so a test can hold
 * an answer back), or nothing to leave the screen waiting.
 */
class CannedClient {
  readonly sent: Recorded[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(
    private readonly reply: (
      frame: Recorded,
    ) => AgentConfigEvent | ClientErrorEvent | Promise<AgentConfigEvent | ClientErrorEvent> | undefined,
  ) {}
  readAgentConfig(agentId: AgentId): void {
    this.dispatch({ t: "agent_config_read", agentId });
  }
  writeAgentConfig(agentId: AgentId, optionId: string, value: string): void {
    this.dispatch({ t: "agent_config_write", agentId, optionId, value });
  }
  on(event: string, listener: (event: never) => void): () => void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as (event: unknown) => void);
    this.listeners.set(event, list);
    return () => {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        current.filter(l => l !== listener),
      );
    };
  }
  emit(event: "agent_config" | "error", payload: AgentConfigEvent | ClientErrorEvent): void {
    act(() => {
      for (const listener of this.listeners.get(event) ?? []) listener(payload);
    });
  }
  private dispatch(frame: Recorded): void {
    this.sent.push(frame);
    const answer = this.reply(frame);
    if (answer === undefined) return;
    void Promise.resolve(answer).then(event => {
      this.emit("configOptions" in event ? "agent_config" : "error", event);
    });
  }
  writes(): Recorded[] {
    return this.sent.filter(frame => frame.t === "agent_config_write");
  }
  reads(): Recorded[] {
    return this.sent.filter(frame => frame.t === "agent_config_read");
  }
}

async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  });
}

interface Mounted {
  el: (testID: string) => Element | null;
  press: (testID: string) => void;
  type?: (testID: string, text: string) => void;
  unmount: () => void;
}

function mountConfig(connection: Connection, client: CannedClient, grantedScopes?: readonly string[]): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <AgentConfigScreen
        agentId={AGENT}
        agentName="probe"
        connection={connection}
        grantedScopes={grantedScopes}
        client={client}
        onBack={() => {}}
      />,
    );
  });
  return {
    el: testID => host.querySelector(`[data-testid="${testID}"]`),
    press: testID => {
      const target = host.querySelector(`[data-testid="${testID}"]`);
      if (target === null) throw new Error(`no ${testID} control rendered`);
      act(() => {
        (target as HTMLElement).click();
      });
    },
    type: (testID, text) => {
      const target = host.querySelector(`[data-testid="${testID}"]`);
      if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) {
        throw new Error(`no ${testID} input rendered`);
      }
      act(() => {
        const key = Object.keys(target).find(name => name.startsWith("__reactProps$"));
        const props = key === undefined ? undefined : Reflect.get(target, key);
        const onChange = props?.onChange;
        if (typeof onChange !== "function") throw new Error("the rendered input has no onChange handler");
        target.value = text;
        onChange({ target, currentTarget: target, nativeEvent: { text }, persist: () => {} });
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      host.remove();
    },
  };
}

/**
 * `aria-disabled` and a native `disabled` property are both legitimate ways
 * an interactive control can say it is off; this file has no stake in which
 * one `Pressable` chooses, only in whether the operator reads the row as
 * inert. Same helper, same reasoning as `pair-screen.test.tsx`.
 */
function readsDisabled(el: Element | null): boolean {
  if (el?.getAttribute("aria-disabled") === "true") return true;
  return el !== null && Reflect.get(el, "disabled") === true;
}

/**
 * The row a option's Current marker sits on. Found through the marker rather
 * than through whichever attribute RNW uses for selected state, because the
 * marker is the thing the operator actually reads. The marker itself carries
 * no `agent-config-choice-` testID, so `closest` walks past it to the row.
 */
function currentRow(m: Mounted, optionId: string): string | null {
  return (
    m
      .el(`agent-config-current-${optionId}`)
      ?.closest(`[data-testid^="agent-config-choice-${optionId}-"]`)
      ?.getAttribute("data-testid") ?? null
  );
}

// ---------------------------------------------------------------------------
// What renders
// ---------------------------------------------------------------------------

describe("the options a session offers", () => {
  test("render grouped, the model ahead of the mode, the current choice marked", async () => {
    const client = new CannedClient(() => config("default"));
    const m = mountConfig(DIRECT, client);
    await settle();

    expect(client.reads()).toHaveLength(1);
    expect(m.el("agent-config-group-model")).not.toBeNull();
    expect(m.el("agent-config-group-mode")).not.toBeNull();
    expect(m.el("agent-config-group-thinking")).not.toBeNull();
    // The model is the headline: it must sit above the mode, not after it.
    const model = m.el("agent-config-group-model");
    const mode = m.el("agent-config-group-mode");
    expect((model?.compareDocumentPosition(mode as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-default");
    expect(currentRow(m, "model")).toBe("agent-config-choice-model-anthropic/claude-opus-5");
    expect(currentRow(m, "thinking")).toBe("agent-config-choice-thinking-medium");
    m.unmount();
  });

  test("a hub pairing renders the same pickers, because the socket is the road every pairing has", async () => {
    // Before 2026-09-07 this screen read config over HTTP and told a hub
    // pairing it had no road; the portal at app.ompctl.ai is a hub pairing.
    const client = new CannedClient(() => config("default"));
    const m = mountConfig(HUB, client);
    await settle();

    expect(m.el("agent-config-unreachable")).toBeNull();
    expect(client.reads()).toHaveLength(1);
    expect(m.el("agent-config-choice-model-openai/gpt-5.4")).not.toBeNull();
    expect(m.el("agent-config-choice-thinking-high")).not.toBeNull();
    m.unmount();
  });

  test("choosing a model sends the write and the daemon's answer moves the marker", async () => {
    const client = new CannedClient(frame =>
      frame.t === "agent_config_write" ? config("default", "openai/gpt-5.4") : config("default"),
    );
    const m = mountConfig(DIRECT, client);
    await settle();

    const gpt = m.el("agent-config-choice-model-openai/gpt-5.4");
    expect(readsDisabled(gpt)).toBe(false);
    expect(m.el("agent-config-option-model-reason")).toBeNull();

    m.press("agent-config-choice-model-openai/gpt-5.4");
    await settle();

    expect(client.writes()).toEqual([
      { t: "agent_config_write", agentId: AGENT, optionId: "model", value: "openai/gpt-5.4" },
    ]);
    expect(currentRow(m, "model")).toBe("agent-config-choice-model-openai/gpt-5.4");
    m.unmount();
  });

  test("the model filter narrows a list the daemon's size to what was typed", async () => {
    const client = new CannedClient(() => wideConfig());
    const m = mountConfig(DIRECT, client);
    await settle();

    const before = document.querySelectorAll('[data-testid^="agent-config-choice-model-"]').length;
    expect(before).toBe(194);

    m.type?.("agent-config-filter-model", "haiku");
    await settle();

    const rows = [...document.querySelectorAll('[data-testid^="agent-config-choice-model-"]')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(194);
    for (const row of rows) {
      expect(row.getAttribute("data-testid")?.toLowerCase()).toContain("haiku");
    }
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// What a selection does
// ---------------------------------------------------------------------------

describe("changing the mode", () => {
  test("sends the exact frame the daemon accepts and reflects its answer", async () => {
    const client = new CannedClient(frame => (frame.t === "agent_config_write" ? config("plan") : config("default")));
    const m = mountConfig(DIRECT, client);
    await settle();

    m.press("agent-config-choice-mode-plan");
    await settle();

    expect(client.writes()).toEqual([{ t: "agent_config_write", agentId: AGENT, optionId: "mode", value: "plan" }]);
    // The daemon's answer, not the tap, moved the marker.
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-plan");
    m.unmount();
  });

  test("a refusal names itself, keeps the daemon's last answer, and retries the same change", async () => {
    let refuse = true;
    const client = new CannedClient(frame => {
      if (frame.t === "agent_config_write" && refuse) {
        return { agentId: AGENT, code: "unauthorized", message: "prompt scope required" };
      }
      // The read answers the session as it stands, default mode; only a
      // write the daemon accepts answers plan.
      return config(frame.t === "agent_config_write" ? "plan" : "default");
    });
    const m = mountConfig(DIRECT, client);
    await settle();

    m.press("agent-config-choice-mode-plan");
    await settle();

    const failure = m.el("agent-config-post-failure");
    expect(failure?.textContent).toContain("prompt scope");
    expect(m.el("agent-config-option-mode-error")?.textContent).toContain("prompt scope required");
    // Not optimistic: the daemon never confirmed the change, so nothing moved.
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-default");

    refuse = false;
    m.press("agent-config-post-retry");
    await settle();

    expect(m.el("agent-config-post-failure")).toBeNull();
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-plan");
    // The retry re-sent the same frame, not a fresh read.
    expect(client.writes()).toHaveLength(2);
    expect(client.writes()[1]).toEqual({ t: "agent_config_write", agentId: AGENT, optionId: "mode", value: "plan" });
    m.unmount();
  });

  test("one change at a time: taps while a write is out change nothing", async () => {
    let release: ((event: AgentConfigEvent) => void) | undefined;
    const client = new CannedClient(frame => {
      if (frame.t === "agent_config_write") {
        return new Promise<AgentConfigEvent>(resolve => {
          release = resolve;
        });
      }
      return config("default");
    });
    const m = mountConfig(DIRECT, client);
    await settle();

    m.press("agent-config-choice-mode-plan");
    await settle();
    expect(m.el("agent-config-pending")).not.toBeNull();
    // The old value still stands while the change is out.
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-default");

    m.press("agent-config-choice-mode-plan");
    m.press("agent-config-choice-mode-default");
    await settle();
    expect(client.writes()).toHaveLength(1);

    release?.(config("plan"));
    await settle();
    expect(m.el("agent-config-pending")).toBeNull();
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-plan");
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// Scope honesty: a control the pairing cannot use is present, inert, and
// says why. Hidden controls teach the operator the feature does not exist.
// ---------------------------------------------------------------------------

describe("what the pairing is allowed to do", () => {
  test("a pairing the daemon says holds no prompt scope renders the change disabled with its reason", async () => {
    const client = new CannedClient(() => config("default"));
    const m = mountConfig(DIRECT, client, ["read"]);
    await settle();

    const plan = m.el("agent-config-choice-mode-plan");
    expect(readsDisabled(plan)).toBe(true);
    expect(m.el("agent-config-option-mode-reason")?.textContent).toContain("prompt scope");

    m.press("agent-config-choice-mode-plan");
    await settle();
    expect(client.writes()).toHaveLength(0);
    m.unmount();
  });

  test("a pairing the daemon says holds no read scope is told so before anything is asked", async () => {
    const client = new CannedClient(() => config("default"));
    const m = mountConfig(DIRECT, client, ["prompt"]);
    await settle();

    expect(m.el("agent-config-unreachable")?.textContent).toContain("read");
    expect(client.sent).toHaveLength(0);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// The read itself
// ---------------------------------------------------------------------------

describe("reading the config", () => {
  test("a load failure is named and its retry asks again", async () => {
    let down = true;
    const client = new CannedClient(() =>
      down ? { agentId: AGENT, code: "config_unavailable", message: "no config surface" } : config("default"),
    );
    const m = mountConfig(DIRECT, client);
    await settle();

    const failure = m.el("agent-config-load-failure");
    expect(failure?.textContent).toContain("no config surface");

    down = false;
    m.press("agent-config-load-retry");
    await settle();

    expect(m.el("agent-config-load-failure")).toBeNull();
    expect(m.el("agent-config-choice-mode-default")).not.toBeNull();
    expect(client.reads()).toHaveLength(2);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// The way in: an open session offers its config from its own header
// ---------------------------------------------------------------------------

describe("the entry point", () => {
  function mountSession(onOpenConfig?: () => void): Mounted {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <SessionScreen
          agent={{
            id: "agt_probe",
            name: "probe",
            state: "idle",
            host: { kind: "local", id: "1", spec: { kind: "local" } },
            cwd: "/tmp",
            createdAt: new Date(0).toISOString(),
            lastActiveAt: new Date(0).toISOString(),
            labels: {},
          }}
          session={EMPTY_SESSION}
          load={{ phase: "ready", generation: 0, error: null }}
          context={{ agents: [], origin: "owned", onOpenSubagent: () => {} }}
          connection="connected"
          attempt={0}
          voice={{
            access: "unknown",
            mic: { available: false, reason: "no microphone in this test" },
            speech: { available: false, reason: "no playback in this test" },
            dictation: null,
            capturing: false,
            busyElsewhere: false,
            onToggle: () => {},
          }}
          spoken={null}
          fleetClearances={0}
          canApprove
          onBack={() => {}}
          onOpenConfig={onOpenConfig}
          onSubmit={() => {}}
          onCancel={() => {}}
          onDecide={() => {}}
          onDecidePlan={() => {}}
        />,
      );
    });
    return {
      el: testID => host.querySelector(`[data-testid="${testID}"]`),
      press: testID => {
        const target = host.querySelector(`[data-testid="${testID}"]`);
        if (target === null) throw new Error(`no ${testID} control rendered`);
        act(() => {
          (target as HTMLElement).click();
        });
      },
      unmount: () => {
        act(() => {
          root.unmount();
        });
        host.remove();
      },
    };
  }

  test("an open session carries a Config control that opens this agent's screen", () => {
    let opened = 0;
    const m = mountSession(() => {
      opened += 1;
    });

    const control = m.el("session-open-config");
    expect(control).not.toBeNull();
    // Assistive tech must hear the destination, not just an icon.
    const accessible = control?.getAttribute("aria-label") ?? "";
    expect(accessible.toLowerCase()).toContain("mode");
    m.press("session-open-config");
    expect(opened).toBe(1);
    m.unmount();
  });

  test("without a destination the control is absent, and nothing else changes", () => {
    const m = mountSession();
    expect(m.el("session-open-config")).toBeNull();
    expect(m.el("session-back")).not.toBeNull();
    m.unmount();
  });
});
