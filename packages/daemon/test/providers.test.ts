/**
 * Provider repository listing, auth status, and cloning.
 *
 * Tests against a fake provider endpoint without hitting real GitHub/GitLab:
 * - listing pages and filters
 * - an expired credential surfacing as a named refusal rather than an empty list
 * - clone refusing a non-empty destination by name
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { Filesystem } from "../src/filesystem/index.ts";
import { ProviderRefusal, type ProviderRepo, ProvidersService } from "../src/providers/index.ts";

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("providers daemon service", () => {
  let fakeServer: Server<unknown> | undefined;
  let fakeBaseUrl: string;

  const sampleRepos: ProviderRepo[] = [
    {
      id: "1",
      name: "alpha-tool",
      owner: "jasonw",
      fullName: "jasonw/alpha-tool",
      description: "First tool",
      defaultBranch: "main",
      isPrivate: false,
      lastPushedAt: "2026-03-01T10:00:00Z",
      cloneUrl: "https://github.com/jasonw/alpha-tool.git",
      sshUrl: "git@github.com:jasonw/alpha-tool.git",
    },
    {
      id: "2",
      name: "beta-service",
      owner: "jasonw",
      fullName: "jasonw/beta-service",
      description: "Second service",
      defaultBranch: "main",
      isPrivate: true,
      lastPushedAt: "2026-03-02T12:00:00Z",
      cloneUrl: "https://github.com/jasonw/beta-service.git",
      sshUrl: "git@github.com:jasonw/beta-service.git",
    },
    {
      id: "3",
      name: "gamma-cli",
      owner: "jasonw",
      fullName: "jasonw/gamma-cli",
      description: "Third CLI tool",
      defaultBranch: "master",
      isPrivate: false,
      lastPushedAt: "2026-03-03T15:00:00Z",
      cloneUrl: "https://github.com/jasonw/gamma-cli.git",
      sshUrl: "git@github.com:jasonw/gamma-cli.git",
    },
  ];

  beforeEach(() => {
    fakeServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const authHeader = req.headers.get("Authorization");

        if (url.pathname === "/expired/user/repos") {
          return Response.json({ message: "Bad credentials" }, { status: 401 });
        }

        if (url.pathname === "/user/repos") {
          if (!authHeader || !authHeader.includes("valid_token")) {
            return Response.json({ message: "Requires authentication" }, { status: 401 });
          }
          const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
          const perPage = Number.parseInt(url.searchParams.get("per_page") ?? "2", 10);
          const query = url.searchParams.get("query")?.toLowerCase();

          let filtered = sampleRepos;
          if (query) {
            filtered = filtered.filter(
              r =>
                r.name.toLowerCase().includes(query) ||
                r.fullName.toLowerCase().includes(query) ||
                (r.description?.toLowerCase().includes(query) ?? false),
            );
          }

          const start = (page - 1) * perPage;
          const end = start + perPage;
          const items = filtered.slice(start, end).map(r => ({
            id: Number.parseInt(r.id, 10),
            name: r.name,
            full_name: r.fullName,
            owner: { login: r.owner },
            description: r.description,
            default_branch: r.defaultBranch,
            private: r.isPrivate,
            pushed_at: r.lastPushedAt,
            clone_url: r.cloneUrl,
            ssh_url: r.sshUrl,
          }));

          return Response.json(items, {
            headers: {
              "Content-Type": "application/json",
              Link:
                end < filtered.length
                  ? `<${url.origin}/user/repos?page=${page + 1}&per_page=${perPage}>; rel="next"`
                  : "",
            },
          });
        }

        return new Response("Not found", { status: 404 });
      },
    });
    fakeBaseUrl = `http://127.0.0.1:${fakeServer.port}`;
  });

  afterEach(() => {
    fakeServer?.stop();
  });

  test("lists repositories with pagination and text filtering", async () => {
    const home = tempDir("providers-home-");
    const service = new ProvidersService({
      home,
      githubBaseUrl: fakeBaseUrl,
      vaultBackend: "file",
    });

    // Seed a valid credential
    await service.store.save({
      provider: "github",
      username: "jasonw",
      scopes: "repo",
      secrets: { accessToken: "valid_token" },
      expiresAt: Date.now() + 3_600_000,
    });

    // Page 1
    const page1 = await service.listRepos({
      provider: "github",
      page: 1,
      perPage: 2,
    });
    expect(page1.page).toBe(1);
    expect(page1.hasMore).toBe(true);
    expect(page1.repos).toHaveLength(2);
    expect(page1.repos[0]?.name).toBe("alpha-tool");
    expect(page1.repos[1]?.name).toBe("beta-service");

    // Page 2
    const page2 = await service.listRepos({
      provider: "github",
      page: 2,
      perPage: 2,
    });
    expect(page2.page).toBe(2);
    expect(page2.hasMore).toBe(false);
    expect(page2.repos).toHaveLength(1);
    expect(page2.repos[0]?.name).toBe("gamma-cli");

    // Filter by query "beta"
    const filtered = await service.listRepos({
      provider: "github",
      query: "beta",
    });
    expect(filtered.repos).toHaveLength(1);
    expect(filtered.repos[0]?.name).toBe("beta-service");
  });

  test("surfaces an expired credential as a named refusal rather than an empty list", async () => {
    const home = tempDir("providers-home-");
    const service = new ProvidersService({
      home,
      githubBaseUrl: fakeBaseUrl,
      vaultBackend: "file",
    });

    // Case 1: Expiry timestamp in the past
    await service.store.save({
      provider: "github",
      username: "jasonw",
      scopes: "repo",
      secrets: { accessToken: "old_token" },
      expiresAt: Date.now() - 60_000,
    });

    let refusal: ProviderRefusal | undefined;
    try {
      await service.listRepos({ provider: "github" });
    } catch (err) {
      if (err instanceof ProviderRefusal) refusal = err;
    }

    expect(refusal).toBeDefined();
    expect(refusal?.code).toBe("credential_expired");
    expect(refusal?.message).toContain("expired");

    // Case 2: Server answers 401 Bad credentials
    const service401 = new ProvidersService({
      home: tempDir("providers-home-401-"),
      githubBaseUrl: `${fakeBaseUrl}/expired`,
      vaultBackend: "file",
    });

    await service401.store.save({
      provider: "github",
      username: "jasonw",
      scopes: "repo",
      secrets: { accessToken: "bad_token" },
    });

    let refusal401: ProviderRefusal | undefined;
    try {
      await service401.listRepos({ provider: "github" });
    } catch (err) {
      if (err instanceof ProviderRefusal) refusal401 = err;
    }

    expect(refusal401).toBeDefined();
    expect(refusal401?.code).toBe("credential_expired");
  });

  test("clone refuses a non-empty destination by name", async () => {
    const root = tempDir("fs-clone-root-");
    const taken = join(root, "my-repo");
    mkdirSync(taken);
    writeFileSync(join(taken, "existing-file.txt"), "important data\n");

    const fs = new Filesystem({ roots: [root] });

    let errMessage = "";
    try {
      await fs.clone(
        {
          url: "https://github.com/jasonw/my-repo.git",
          parent: root,
          name: "my-repo",
        },
        () => {},
      );
    } catch (err) {
      errMessage = err instanceof Error ? err.message : String(err);
    }

    expect(errMessage).toContain(taken);
    expect(errMessage).toContain("already exists");
    // Leaves it untouched
    expect(await Bun.file(join(taken, "existing-file.txt")).text()).toBe("important data\n");
  });
});
