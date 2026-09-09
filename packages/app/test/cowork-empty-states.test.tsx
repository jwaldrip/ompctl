import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import type { ConnectorSummary } from "../src/cowork/types.ts";

// Dynamic import: react-native must be substituted with react-native-web via rnw.ts first.
const { SkillsView, ConnectorsView, PluginsView } = await import("../src/components/CoworkCatalogueViews.tsx");
const { TaskSidebar } = await import("../src/components/TaskSidebar.tsx");

describe("Cowork empty catalogue and sidebar absence states", () => {
  test("empty skills view says 'No skills installed' and never '0 skills'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(<SkillsView skills={[]} onInvoke={() => {}} />);
    });

    const count = host.querySelector('[data-testid="skills-count"]');
    expect(count).not.toBeNull();
    expect(count?.textContent).toBe("No skills installed");
    expect(count?.textContent).not.toContain("0 skills");

    root.unmount();
    host.remove();
  });

  test("empty connectors view says 'No connectors installed' and never '0 connectors'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(<ConnectorsView connectors={[]} />);
    });

    const count = host.querySelector('[data-testid="connectors-count"]');
    expect(count).not.toBeNull();
    expect(count?.textContent).toBe("No connectors installed");
    expect(count?.textContent).not.toContain("0 connectors");

    root.unmount();
    host.remove();
  });

  test("empty plugins view says 'No plugins installed' and never '0 plugins'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(<PluginsView skills={[]} connectors={[]} />);
    });

    const count = host.querySelector('[data-testid="plugins-count"]');
    expect(count).not.toBeNull();
    expect(count?.textContent).toBe("No plugins installed");
    expect(count?.textContent).not.toContain("0 plugins");

    root.unmount();
    host.remove();
  });

  test("task sidebar with no tasks says 'No tasks' and never '0 tasks'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <TaskSidebar
          tasks={{ inFlight: [], recent: [] }}
          skills={[]}
          selectedTaskId={null}
          onSelectTask={() => {}}
          onStartTask={() => {}}
        />,
      );
    });

    const count = host.querySelector('[data-testid="task-sidebar-count"]');
    expect(count).not.toBeNull();
    expect(count?.textContent).toBe("No tasks");
    expect(count?.textContent).not.toContain("0 tasks");

    root.unmount();
    host.remove();
  });

  test("PluginGroupCard omits zero counts", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    const connectors: ConnectorSummary[] = [
      { name: "github", connected: true, status: "connected", providerName: "Plugin A", pluginName: "plugin-a" },
    ];

    act(() => {
      root.render(<PluginsView skills={[]} connectors={connectors} />);
    });

    const groupCard = host.querySelector('[data-testid="plugin-group-plugin-a"]');
    expect(groupCard).not.toBeNull();
    // Only connectors count rendered, zero skills omitted
    expect(groupCard?.textContent).toContain("1 connector");
    expect(groupCard?.textContent).not.toContain("0 skills");

    root.unmount();
    host.remove();
  });

  test("refused skills view shows refusal notice, head says 'Skills unavailable', and never 'No skills installed'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <SkillsView
          skills={[]}
          onInvoke={() => {}}
          status="refused"
          refusal="skills_read requires read scope"
        />,
      );
    });

    const refused = host.querySelector('[data-testid="cowork-skills-refused"]');
    expect(refused).not.toBeNull();
    expect(refused?.textContent).toContain("skills_read requires read scope");

    const count = host.querySelector('[data-testid="skills-count"]');
    expect(count?.textContent).toBe("Skills unavailable");
    expect(host.textContent).not.toContain("No skills installed");

    root.unmount();
    host.remove();
  });

  test("refused connectors view shows refusal notice, head says 'Connectors unavailable', and never 'No connectors installed'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <ConnectorsView
          connectors={[]}
          status="refused"
          refusal="connectors_read requires read scope"
        />,
      );
    });

    const refused = host.querySelector('[data-testid="cowork-connectors-refused"]');
    expect(refused).not.toBeNull();
    expect(refused?.textContent).toContain("connectors_read requires read scope");

    const count = host.querySelector('[data-testid="connectors-count"]');
    expect(count?.textContent).toBe("Connectors unavailable");
    expect(host.textContent).not.toContain("No connectors installed");

    root.unmount();
    host.remove();
  });

  test("refused plugins view shows refusal notice and names what failed", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <PluginsView
          skills={[]}
          connectors={[]}
          skillsRefusal="skills catalogue failed"
        />,
      );
    });

    const refused = host.querySelector('[data-testid="cowork-plugins-refused"]');
    expect(refused).not.toBeNull();
    expect(refused?.textContent).toContain("Skills: skills catalogue failed");

    const count = host.querySelector('[data-testid="plugins-count"]');
    expect(count?.textContent).toBe("Plugins unavailable");
    expect(host.textContent).not.toContain("No plugins installed");

    root.unmount();
    host.remove();
  });

  test("refused task sidebar shows refusal notice, head says 'Tasks unavailable', and never 'No tasks'", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        <TaskSidebar
          tasks={{ inFlight: [], recent: [] }}
          skills={[]}
          selectedTaskId={null}
          onSelectTask={() => {}}
          onStartTask={() => {}}
          status="refused"
          refusal="tasks_read requires read scope"
        />,
      );
    });

    const refused = host.querySelector('[data-testid="cowork-tasks-refused"]');
    expect(refused).not.toBeNull();
    expect(refused?.textContent).toContain("tasks_read requires read scope");

    const count = host.querySelector('[data-testid="task-sidebar-count"]');
    expect(count?.textContent).toBe("Tasks unavailable");
    expect(host.textContent).not.toContain("No tasks");

    root.unmount();
    host.remove();
  });
});
