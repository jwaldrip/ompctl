/**
 * RepositoryPicker, rendered.
 *
 * Verifies that:
 * - the picker lists repositories with details (name, owner, description, branch, visibility)
 * - search filters the repositories list
 * - the picker falls back to URL entry when no provider is connected
 */

import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import type { ProviderRepo } from "@ompd/core/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

// rnw.ts registers react-native-web mocks before react-native components evaluate
const { RepositoryPicker } = await import("../src/components/ProjectPicker.tsx");

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sampleRepos: ProviderRepo[] = [
  {
    id: "1",
    name: "alpha-tool",
    owner: "jasonw",
    fullName: "jasonw/alpha-tool",
    description: "An automated helper",
    defaultBranch: "main",
    isPrivate: false,
    lastPushedAt: "2026-03-01T12:00:00Z",
    cloneUrl: "https://github.com/jasonw/alpha-tool.git",
    sshUrl: "git@github.com:jasonw/alpha-tool.git",
  },
  {
    id: "2",
    name: "beta-service",
    owner: "jasonw",
    fullName: "jasonw/beta-service",
    description: "Background worker daemon",
    defaultBranch: "main",
    isPrivate: true,
    lastPushedAt: "2026-03-02T15:30:00Z",
    cloneUrl: "https://github.com/jasonw/beta-service.git",
    sshUrl: "git@github.com:jasonw/beta-service.git",
  },
];

describe("repository picker rendered surface", () => {
  test("the picker lists repositories", () => {
    const html = renderToStaticMarkup(
      <RepositoryPicker connected={true} repos={sampleRepos} inline={true} onSelectRepo={() => {}} />,
    );

    expect(html).toContain('data-testid="repo-picker-item-alpha-tool"');
    expect(html).toContain("alpha-tool");
    expect(html).toContain("An automated helper");
    expect(html).toContain("public");

    expect(html).toContain('data-testid="repo-picker-item-beta-service"');
    expect(html).toContain("beta-service");
    expect(html).toContain("Background worker daemon");
    expect(html).toContain("private");
  });

  test("filters repositories by query", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      act(() => {
        root.render(
          <RepositoryPicker
            connected={true}
            repos={sampleRepos}
            inline={true}
            initialQuery="beta"
            onSelectRepo={() => {}}
          />,
        );
      });

      expect(document.querySelector('[data-testid="repo-picker-item-beta-service"]')).not.toBeNull();
      expect(document.querySelector('[data-testid="repo-picker-item-alpha-tool"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });

  test("falls back to URL entry when no provider is connected", () => {
    const html = renderToStaticMarkup(
      <RepositoryPicker connected={false} repos={[]} inline={true} onSelectUrl={() => {}} />,
    );

    expect(html).toContain('data-testid="repo-picker-url-input"');
    expect(html).toContain('data-testid="repo-picker-url-submit"');
    expect(html).toContain("git@github.com");
  });
});
