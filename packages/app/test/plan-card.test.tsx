import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { resetWindowSize, setWindowSize } from "./rnw.ts";

const { PlanCard, splitPlanMessage } = await import("../src/components/PlanCard.tsx");

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

  test("the plan scrolls inside a third of the window, the question and the decision outside it", () => {
    // The shape OMP sends, measured 2026-09-08: the question, a blank line,
    // then the whole plan as markdown. Rendered raw and unbounded it stood
    // 810 points tall on a phone with the buttons past the bottom edge.
    setWindowSize(390, 844);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const body = Array.from({ length: 30 }, (_, i) => `- Step ${i + 1}: do the thing`).join("\n");
    const message = `Approve plan "readme" and start implementation?\n\n# Add a README\n\n## Context\n\nThe directory holds \`package.json\`.\n\n${body}`;
    const plan = [{ content: "Write README.md", priority: "medium" as const, status: "pending" as const }];
    act(() => {
      root.render(
        <PlanCard
          canApprove
          onRespond={() => {}}
          plan={plan}
          review={{ requestId: "pln_long", message, choices: ["Approve and execute", "Refine plan"] }}
        />,
      );
    });
    const region = host.querySelector('[data-testid="plan-review-plan"]') as HTMLElement;
    expect(region).not.toBeNull();
    // The plan is in the region, rendered as markdown rather than raw text,
    // and the steps sit under it in the same region.
    expect(region.textContent).toContain("Step 30: do the thing");
    expect(region.textContent).not.toContain("# Add a README");
    expect(region.textContent).toContain("Add a README");
    expect(region.querySelector('[data-testid="plan-review-steps"]')?.textContent).toContain("Write README.md");
    // The region is what scrolls, capped at a third of the window.
    expect(region.style.maxHeight).toBe(`${Math.round(844 * 0.34)}px`);
    expect(getComputedStyle(region).overflowY).toBe("auto");
    // The question and the decision are outside it, so neither scrolls away.
    expect(region.textContent).not.toContain("start implementation?");
    expect(host.textContent).toContain('Approve plan "readme" and start implementation?');
    const approve = host.querySelector('[data-testid="plan-approve"]') as HTMLElement;
    expect(region.contains(approve)).toBe(false);
    act(() => root.unmount());
    host.remove();
    resetWindowSize();
  });

  test("a message with no blank line is all question", () => {
    expect(splitPlanMessage("Approve this plan?")).toEqual({ question: "Approve this plan?", plan: "" });
    expect(splitPlanMessage("Approve?\n\n# Plan\n\nbody")).toEqual({ question: "Approve?", plan: "# Plan\n\nbody" });
  });
});
