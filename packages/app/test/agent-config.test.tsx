/**
 * The agent config screen, over a fake HTTP daemon.
 *
 * The screen's whole job is one GET and one POST against
 * `/v1/agents/:id/config`, so the harness is `globalThis.fetch`: a recorder
 * that answers from a script. What these hold is the behaviour the daemon's
 * contract actually promises: options grouped with the model first, a POST
 * body the daemon accepts, refusals named on screen rather than swallowed,
 * scope-missing controls disabled beside their reason, and one change in
 * flight at a time. The optimistic-update ban is asserted the hard way: the
 * Current marker moves only after the daemon's answer arrives.
 */

import "./rnw.ts";

import { afterEach, describe, expect, test } from "bun:test";
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

const CONFIG_URL = "http://127.0.0.1:7777/v1/agents/agt_probe/config";

/**
 * The config a daemon serves for one live session. The two options mirror
 * what the daemon's own fake host reports `omp acp` sends: a mode the route
 * can set, and a model it can only read back.
 */
function config(modeValue: string): unknown {
  return {
    agentId: "agt_probe",
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
        currentValue: "anthropic/claude-opus-5",
        options: [
          { value: "anthropic/claude-opus-5", name: "Claude Opus 5" },
          { value: "openai/gpt-5.4", name: "GPT-5.4" },
        ],
      },
    ],
  };
}

interface Recorded {
  method: string;
  url: string;
  body: string | null;
  authorization: string | null;
}

/** Answers every fetch from `reply`, recording the calls for assertions. */
function serve(reply: (call: Recorded) => Response | Promise<Response>): Recorded[] {
  const calls: Recorded[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const call: Recorded = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? init.body : null,
      authorization: headers.get("Authorization"),
    };
    calls.push(call);
    return reply(call);
  }) as unknown as typeof fetch;
  return calls;
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

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
  unmount: () => void;
}

function mountConfig(connection: Connection, grantedScopes?: readonly string[]): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <AgentConfigScreen
        agentId="agt_probe"
        agentName="probe"
        connection={connection}
        grantedScopes={grantedScopes}
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
    serve(() => Response.json(config("default")));
    const m = mountConfig(DIRECT);
    await settle();

    expect(m.el("agent-config-group-model")).not.toBeNull();
    expect(m.el("agent-config-group-mode")).not.toBeNull();
    // The model is the headline: it must sit above the mode, not after it.
    const model = m.el("agent-config-group-model");
    const mode = m.el("agent-config-group-mode");
    expect((model?.compareDocumentPosition(mode as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-default");
    expect(currentRow(m, "model")).toBe("agent-config-choice-model-anthropic/claude-opus-5");
    m.unmount();
  });

  test("a model choice reads as inert beside the reason this route cannot set it", async () => {
    serve(() => Response.json(config("default")));
    const m = mountConfig(DIRECT);
    await settle();

    const other = m.el("agent-config-choice-model-openai/gpt-5.4");
    expect(readsDisabled(other)).toBe(true);
    // Present and named, not hidden: the operator learns what the screen
    // will not do from the screen itself.
    expect(m.el("agent-config-option-model-reason")?.textContent).toContain("mode only");
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// What a selection does
// ---------------------------------------------------------------------------

describe("changing the mode", () => {
  test("POSTs the exact body the daemon accepts and reflects its answer", async () => {
    const calls = serve(call =>
      call.method === "POST" ? Response.json(config("plan")) : Response.json(config("default")),
    );
    const m = mountConfig(DIRECT);
    await settle();

    m.press("agent-config-choice-mode-plan");
    await settle();

    const post = calls.find(call => call.method === "POST");
    expect(post).toBeDefined();
    expect(post?.url).toBe(CONFIG_URL);
    expect(post?.authorization).toBe("Bearer tok_config");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ modeId: "plan" });

    // The daemon's answer, not the tap, moved the marker.
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-plan");
    m.unmount();
  });

  test("a refusal names itself, keeps the daemon's last answer, and retries the same change", async () => {
    let refuse = true;
    const calls = serve(call => {
      if (call.method === "POST" && refuse) {
        return Response.json({ error: "forbidden" }, { status: 403 });
      }
      // The read answers the session as it stands, default mode; only a
      // POST the daemon accepts answers plan. A GET already sitting on
      // "plan" would leave nothing to change and the refusal untestable.
      return Response.json(config(call.method === "POST" ? "plan" : "default"));
    });
    const m = mountConfig(DIRECT);
    await settle();

    m.press("agent-config-choice-mode-plan");
    await settle();

    const failure = m.el("agent-config-post-failure");
    expect(failure?.textContent).toContain("prompt scope");
    // Not optimistic: the daemon never confirmed the change, so nothing moved.
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-default");

    refuse = false;
    m.press("agent-config-post-retry");
    await settle();

    expect(m.el("agent-config-post-failure")).toBeNull();
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-plan");
    // The retry re-sent the same body, not a fresh read.
    expect(calls.filter(call => call.method === "POST")).toHaveLength(2);
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ modeId: "plan" });
    m.unmount();
  });

  test("one change at a time: taps while a POST is out change nothing", async () => {
    let release: ((response: Response) => void) | undefined;
    const calls = serve(call => {
      if (call.method === "POST") {
        return new Promise<Response>(resolve => {
          release = resolve;
        });
      }
      return Response.json(config("default"));
    });
    const m = mountConfig(DIRECT);
    await settle();

    m.press("agent-config-choice-mode-plan");
    await settle();
    expect(m.el("agent-config-pending")).not.toBeNull();
    // The old value still stands while the change is out.
    expect(currentRow(m, "mode")).toBe("agent-config-choice-mode-default");

    m.press("agent-config-choice-mode-plan");
    m.press("agent-config-choice-mode-default");
    await settle();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);

    release?.(Response.json(config("plan")));
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
    const calls = serve(() => Response.json(config("default")));
    const m = mountConfig(DIRECT, ["read"]);
    await settle();

    const plan = m.el("agent-config-choice-mode-plan");
    expect(readsDisabled(plan)).toBe(true);
    expect(m.el("agent-config-option-mode-reason")?.textContent).toContain("prompt scope");

    m.press("agent-config-choice-mode-plan");
    await settle();
    expect(calls.filter(call => call.method === "POST")).toHaveLength(0);
    m.unmount();
  });

  test("a pairing the daemon says holds no read scope is told so before anything is fetched", async () => {
    const calls = serve(() => Response.json(config("default")));
    const m = mountConfig(DIRECT, ["prompt"]);
    await settle();

    expect(m.el("agent-config-unreachable")?.textContent).toContain("read");
    expect(calls).toHaveLength(0);
    m.unmount();
  });

  test("a hub pairing names the missing road rather than guessing at one", async () => {
    const calls = serve(() => {
      throw new Error("no HTTP may leave this screen behind a hub");
    });
    const m = mountConfig(HUB);
    await settle();

    expect(m.el("agent-config-unreachable")?.textContent).toContain("hub");
    expect(calls).toHaveLength(0);
    m.unmount();
  });
});

// ---------------------------------------------------------------------------
// The read itself
// ---------------------------------------------------------------------------

describe("reading the config", () => {
  test("a load failure is named and its retry asks again", async () => {
    let down = true;
    serve(() =>
      down ? Response.json({ error: "config_unavailable" }, { status: 503 }) : Response.json(config("default")),
    );
    const m = mountConfig(DIRECT);
    await settle();

    const failure = m.el("agent-config-load-failure");
    expect(failure?.textContent).toContain("no config surface");

    down = false;
    m.press("agent-config-load-retry");
    await settle();

    expect(m.el("agent-config-load-failure")).toBeNull();
    expect(m.el("agent-config-choice-mode-default")).not.toBeNull();
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
