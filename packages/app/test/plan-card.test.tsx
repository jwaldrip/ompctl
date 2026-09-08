import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

const { PlanCard } = await import("../src/components/PlanCard.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function renderCard(onRespond: (requestId: string, choice: "Approve and execute" | "Refine plan") => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(
      <PlanCard
        canApprove
        onRespond={onRespond}
        plan={[{ content: "Inspect the live path", priority: "high", status: "pending" }]}
        review={{
          requestId: "pln_review",
          message: 'Approve plan "Inspect the live path"?',
          choices: ["Approve and execute", "Refine plan"],
        }}
      />,
    );
  });
  return { host, root };
}

describe("PlanCard", () => {
  test("approving returns OMP's exact execution choice", () => {
    const responses: Array<[string, string]> = [];
    const { host, root } = renderCard((requestId, choice) => responses.push([requestId, choice]));

    expect(host.textContent).toContain("Approve and execute");
    expect(host.textContent).toContain("Refine plan");
    act(() => {
      (host.querySelector('[data-testid="plan-approve"]') as HTMLElement).click();
    });
    expect(responses).toEqual([["pln_review", "Approve and execute"]]);

    act(() => root.unmount());
    host.remove();
  });

  test("refining returns OMP's exact refine choice", () => {
    const responses: Array<[string, string]> = [];
    const { host, root } = renderCard((requestId, choice) => responses.push([requestId, choice]));

    act(() => {
      (host.querySelector('[data-testid="plan-refine"]') as HTMLElement).click();
    });
    expect(responses).toEqual([["pln_review", "Refine plan"]]);

    act(() => root.unmount());
    host.remove();
  });

  test("a pending todo list with no review to answer draws no card", () => {
    // Observed 2026-09-08: a session that was merely working carried a
    // disabled "plan review" above its transcript for the whole run. The
    // context band shows the todos; this card is the question.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <PlanCard
          canApprove
          onRespond={() => {}}
          plan={[
            { content: "Run bun test and capture failure", priority: "high", status: "pending" },
            { content: "Read failing test", priority: "high", status: "completed" },
          ]}
          review={null}
        />,
      );
    });
    expect(host.querySelector('[data-testid="plan-review"]')).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  test("a long plan scrolls inside a quarter of the window, the question and the decision outside it", () => {
    setWindowSize(390, 844);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const plan = Array.from({ length: 40 }, (_, i) => ({
      content: `Step ${i + 1}`,
      priority: "medium" as const,
      status: "pending" as const,
    }));
    act(() => {
      root.render(
        <PlanCard
          canApprove
          onRespond={() => {}}
          plan={plan}
          review={{
            requestId: "pln_long",
            message: "Approve this plan?",
            choices: ["Approve and execute", "Refine plan"],
          }}
        />,
      );
    });
    const steps = host.querySelector('[data-testid="plan-review-steps"]') as HTMLElement;
    expect(steps).not.toBeNull();
    expect(steps.textContent).toContain("Step 40");
    // The step list is the scrolling region, capped at a quarter of the window.
    expect(steps.style.maxHeight).toBe(`${Math.round(844 * 0.25)}px`);
    expect(getComputedStyle(steps).overflowY).toBe("auto");
    // The decision is outside that region, so it is never scrolled away.
    const approve = host.querySelector('[data-testid="plan-approve"]') as HTMLElement;
    expect(steps.contains(approve)).toBe(false);
    expect(host.textContent).toContain("Approve this plan?");
    act(() => root.unmount());
    host.remove();
    resetWindowSize();
  });
});
