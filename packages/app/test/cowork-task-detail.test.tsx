import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import type { Task } from "../src/cowork/types.ts";

const { TaskDetail } = await import("../src/components/TaskDetail.tsx");
const { CoworkScreen } = await import("../src/screens/CoworkScreen.tsx");
const { EMPTY_TASKS, reduceTasks } = await import("../src/cowork/tasks.ts");

const FAILED_TASK: Task = {
  id: "t_failed",
  title: "Build container",
  prompt: "bun run build",
  agentId: "agt_1",
  state: "failed",
  result: "command failed: exit 1",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  labels: {},
};

describe("TaskDetail failed state and retry", () => {
  test("shows error under Failed in oxide and offers Retry which resubmits the prompt", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    let retried = false;
    act(() => {
      root.render(
        <TaskDetail
          task={FAILED_TASK}
          onOpenSession={() => {}}
          onRetry={() => {
            retried = true;
          }}
        />,
      );
    });

    // Renders error under "Failed" label, not "Result" in plain ink
    const failedSection = host.querySelector('[data-testid="task-detail-failed"]');
    expect(failedSection).not.toBeNull();
    expect(failedSection?.textContent).toContain("Failed");
    expect(failedSection?.textContent).toContain("command failed: exit 1");
    expect(host.querySelector('[data-testid="task-detail-result"]')).toBeNull();

    // Offers Retry button
    const retryBtn = host.querySelector('[data-testid="task-detail-retry"]') as HTMLElement;
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toContain("Retry");

    act(() => {
      retryBtn.click();
    });
    expect(retried).toBe(true);

    root.unmount();
    host.remove();
  });

  test("CoworkScreen resubmits the prompt through onStartTask on retry", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const startedTasks: Array<{ title: string; prompt: string }> = [];
    const tasksState = reduceTasks(EMPTY_TASKS, { t: "upsert", task: FAILED_TASK });

    act(() => {
      root.render(
        <CoworkScreen
          tasks={tasksState}
          skills={[]}
          connectors={[]}
          onStartTask={input => startedTasks.push({ title: input.title, prompt: input.prompt })}
          onInvokeSkill={() => {}}
          onOpenSession={() => {}}
        />,
      );
    });

    // Select the failed task
    const taskCard = host.querySelector(`[data-testid="task-${FAILED_TASK.id}"]`) as HTMLElement;
    expect(taskCard).not.toBeNull();
    act(() => {
      taskCard.click();
    });

    // Retry button is available in detail view
    const retryBtn = host.querySelector('[data-testid="task-detail-retry"]') as HTMLElement;
    expect(retryBtn).not.toBeNull();

    act(() => {
      retryBtn.click();
    });

    expect(startedTasks).toEqual([{ title: FAILED_TASK.title, prompt: FAILED_TASK.prompt }]);

    root.unmount();
    host.remove();
  });

  test("CoworkScreen preserves the failed task's agentId on retry rather than silently dropping it", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const startedTasks: Array<{ title: string; prompt: string; agentId?: string }> = [];
    const tasksState = reduceTasks(EMPTY_TASKS, { t: "upsert", task: FAILED_TASK });

    act(() => {
      root.render(
        <CoworkScreen
          tasks={tasksState}
          skills={[]}
          connectors={[]}
          onStartTask={input => startedTasks.push(input as unknown as { title: string; prompt: string; agentId?: string })}
          onInvokeSkill={() => {}}
          onOpenSession={() => {}}
        />,
      );
    });

    const taskCard = host.querySelector(`[data-testid="task-${FAILED_TASK.id}"]`) as HTMLElement;
    act(() => {
      taskCard.click();
    });

    const retryBtn = host.querySelector('[data-testid="task-detail-retry"]') as HTMLElement;
    act(() => {
      retryBtn.click();
    });

    expect(startedTasks[0]?.agentId).toBe(FAILED_TASK.agentId);

    root.unmount();
    host.remove();
  });
});
