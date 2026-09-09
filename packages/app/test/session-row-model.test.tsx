import "./rnw.ts";

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { BrowserSession } from "../src/session/browser.ts";

const { SessionRow } = await import("../src/components/SessionRow.tsx");

const BASE_SESSION: BrowserSession = {
  id: "sess-test-1",
  title: "Test Session",
  cwd: "/Users/dev/project",
  status: "dormant",
  createdAt: "2026-08-11T01:11:48.090Z",
  lastActiveAt: "2026-08-11T02:11:48.090Z",
  messageCount: 5,
  sizeBytes: 1024,
};

describe("SessionRow model and role rendering", () => {
  test("renders model and role when both present", () => {
    const session: BrowserSession = {
      ...BASE_SESSION,
      id: "sess-with-role",
      model: "anthropic/claude-opus-5",
      role: "slow",
    };
    const html = renderToStaticMarkup(
      <SessionRow
        session={session}
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(html).toContain('data-testid="session-model-sess-with-role"');
    expect(html).toContain("claude-opus-5");
    expect(html).toContain("model");
    expect(html).toContain('data-testid="session-role-sess-with-role"');
    expect(html).toContain("slow");
    expect(html).toContain("role");
  });

  test("renders model and omits role when role is absent", () => {
    const session: BrowserSession = {
      ...BASE_SESSION,
      id: "sess-no-role",
      model: "google-antigravity/gemini-3.8-flash",
      role: null,
    };
    const html = renderToStaticMarkup(
      <SessionRow
        session={session}
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(html).toContain('data-testid="session-model-sess-no-role"');
    expect(html).toContain("gemini-3.8-flash");
    expect(html).toContain("model");
    expect(html).not.toContain('data-testid="session-role-sess-no-role"');
    expect(html).not.toContain("default");
  });

  test("renders genuine absence as unknown model when model is absent", () => {
    const session: BrowserSession = {
      ...BASE_SESSION,
      id: "sess-no-model",
      model: null,
      role: null,
    };
    const html = renderToStaticMarkup(
      <SessionRow
        session={session}
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(html).toContain('data-testid="session-model-sess-no-model"');
    expect(html).toContain("unknown");
    expect(html).toContain("model");
    expect(html).not.toContain('data-testid="session-role-sess-no-model"');
  });

  test("truncates long model identifiers deliberately without pushing other readings", () => {
    const session: BrowserSession = {
      ...BASE_SESSION,
      id: "sess-long-model",
      model: "custom-provider/extremely-long-custom-model-identifier-here",
      role: "task",
    };
    const html = renderToStaticMarkup(
      <SessionRow
        session={session}
        onOpen={() => {}}
        onArchive={() => {}}
        onUnarchive={() => {}}
        onDelete={() => {}}
        deleteAccess="granted"
      />,
    );
    expect(html).toContain('data-testid="session-model-sess-long-model"');
    // Provider is stripped and base name longer than 24 chars is bounded with ellipsis
    expect(html).toContain("extremely-long-custom-m…");
    expect(html).toContain("model");
    expect(html).toContain('data-testid="session-role-sess-long-model"');
    expect(html).toContain("task");
    expect(html).toContain("role");
  });
});
