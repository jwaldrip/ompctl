/**
 * Stateful in-memory HTTP mirror for Google Cloud Resource Manager v1 and GitHub Actions/Pages API.
 * Accurately implements official REST contracts, bearer token authentication,
 * etags, liens pagination, and project lifecycle transitions.
 */

import type { HttpTransport } from "./types.ts";

export interface LoggedRequest {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

export interface MirrorWorkflowRun {
  id: number;
  name: string;
  path: string;
  head_branch: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  updated_at: string;
}

export interface MirrorConfig {
  projectId?: string;
  projectNumber?: string;
  lifecycleState?: "ACTIVE" | "DELETE_REQUESTED";
  expectedBearerToken?: string;
  initialPermissions?: string[];
  initialBindings?: Array<{ role: string; members: string[]; condition?: Record<string, unknown> }>;
  initialLiens?: Array<{ name: string; reason: string; parent: string }>;
  liensPageSize?: number;
  initialPagesPublished?: boolean;
  initialWorkflowRuns?: MirrorWorkflowRun[];

  // Failure simulation switches
  failGetProject?: { status: number; body: unknown };
  failTestIam?: { status: number; body: unknown };
  failGetIamPolicy?: { status: number; body: unknown };
  failSetIamPolicy?: { status: number; body: unknown };
  simulateEtagMismatch?: boolean;
  grantNotEffective?: boolean;
  failLiens?: { status: number; body: unknown };
  failPagesDelete?: { status: number; body: unknown };
  failPagesGet?: { status: number; body: unknown };
  failProjectDelete?: { status: number; body: unknown };
  failRunsGet?: { status: number; body: unknown };
}

export class StatefulHttpMirror implements HttpTransport {
  public projectId: string;
  public projectNumber: string;
  public lifecycleState: "ACTIVE" | "DELETE_REQUESTED";
  public expectedBearerToken: string;
  public permissions: Set<string>;
  public iamPolicy: {
    version: number;
    etag: string;
    bindings: Array<{ role: string; members: string[]; condition?: Record<string, unknown> }>;
  };
  public liens: Array<{ name: string; reason: string; parent: string }>;
  public liensPageSize: number;
  public pagesPublished: boolean;
  public workflowRuns: MirrorWorkflowRun[];
  public requestLog: LoggedRequest[] = [];
  public config: MirrorConfig;

  constructor(config: MirrorConfig = {}) {
    this.config = config;
    this.projectId = config.projectId ?? "ompctl";
    this.projectNumber = config.projectNumber ?? "782181616134";
    this.lifecycleState = config.lifecycleState ?? "ACTIVE";
    this.expectedBearerToken = config.expectedBearerToken ?? "valid-gcp-token";
    this.permissions = new Set(config.initialPermissions ?? []);
    this.iamPolicy = {
      version: 3,
      etag: "BwY12345678=",
      bindings: config.initialBindings ?? [
        {
          role: "roles/resourcemanager.projectIamAdmin",
          members: ["serviceAccount:ompctl-deployer@ompctl.iam.gserviceaccount.com"],
        },
        {
          role: "roles/owner",
          members: ["user:jason@waldrip.net"],
        },
        {
          role: "roles/viewer",
          members: ["user:auditor@example.com"],
          condition: {
            title: "expires_2027",
            expression: "request.time < timestamp('2027-01-01T00:00:00Z')",
          },
        },
      ],
    };
    this.liens = config.initialLiens ?? [];
    this.liensPageSize = config.liensPageSize ?? 100;
    this.pagesPublished = config.initialPagesPublished ?? true;
    this.workflowRuns = config.initialWorkflowRuns ?? [];
  }

  async fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const urlStr = typeof input === "string" ? input : input.toString();
    const parsedUrl = new URL(urlStr);
    const method = (init?.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};

    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((v, k) => {
          headers[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [k, v] of init.headers) {
          headers[k.toLowerCase()] = v;
        }
      } else {
        for (const [k, v] of Object.entries(init.headers)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
    }

    let parsedBody: unknown;
    if (init?.body && typeof init.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }

    this.requestLog.push({
      method,
      url: urlStr,
      body: parsedBody,
      headers,
    });

    const pathname = parsedUrl.pathname;
    const isGoogle = parsedUrl.hostname === "cloudresourcemanager.googleapis.com";
    const isGithub = parsedUrl.hostname === "api.github.com";

    // Enforce Authentication for Google Cloud endpoints
    if (isGoogle) {
      const authHeader = headers["authorization"] || "";
      if (!authHeader.startsWith("Bearer ") || authHeader.slice(7).trim().length === 0) {
        return new Response(
          JSON.stringify({
            error: {
              code: 401,
              message: "Request had invalid authentication credentials. Expected OAuth 2 access token.",
              status: "UNAUTHENTICATED",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // Enforce Authentication for GitHub endpoints
    if (isGithub) {
      const authHeader = headers["authorization"] || "";
      if (!authHeader.startsWith("Bearer ") || authHeader.slice(7).trim().length === 0) {
        return new Response(
          JSON.stringify({ message: "Requires authentication" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // 1. GET /v1/projects/:projectId
    if (method === "GET" && pathname === `/v1/projects/${this.projectId}`) {
      if (this.config.failGetProject) {
        return new Response(JSON.stringify(this.config.failGetProject.body), {
          status: this.config.failGetProject.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          projectId: this.projectId,
          projectNumber: this.projectNumber,
          lifecycleState: this.lifecycleState,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. POST /v1/projects/:projectId:testIamPermissions
    if (method === "POST" && pathname === `/v1/projects/${this.projectId}:testIamPermissions`) {
      if (this.config.failTestIam) {
        return new Response(JSON.stringify(this.config.failTestIam.body), {
          status: this.config.failTestIam.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const requested = ((parsedBody as { permissions?: string[] })?.permissions ?? []);
      const granted = requested.filter((p) => this.permissions.has(p));
      return new Response(
        JSON.stringify({
          permissions: granted,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 3. POST /v1/projects/:projectId:getIamPolicy
    if (method === "POST" && pathname === `/v1/projects/${this.projectId}:getIamPolicy`) {
      if (this.config.failGetIamPolicy) {
        return new Response(JSON.stringify(this.config.failGetIamPolicy.body), {
          status: this.config.failGetIamPolicy.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(this.iamPolicy), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. POST /v1/projects/:projectId:setIamPolicy
    if (method === "POST" && pathname === `/v1/projects/${this.projectId}:setIamPolicy`) {
      if (this.config.failSetIamPolicy) {
        return new Response(JSON.stringify(this.config.failSetIamPolicy.body), {
          status: this.config.failSetIamPolicy.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      const bodyObj = parsedBody as {
        policy?: {
          version?: number;
          etag?: string;
          bindings?: Array<{ role: string; members: string[]; condition?: Record<string, unknown> }>;
        };
      };
      const newPolicy = bodyObj?.policy;
      if (this.config.simulateEtagMismatch || (newPolicy?.etag && newPolicy.etag !== this.iamPolicy.etag)) {
        return new Response(
          JSON.stringify({
            error: {
              code: 409,
              message: "Concurrent policy modification etag mismatch",
              status: "ABORTED",
            },
          }),
          { status: 409, headers: { "Content-Type": "application/json" } }
        );
      }

      if (newPolicy) {
        this.iamPolicy = {
          version: newPolicy.version ?? this.iamPolicy.version,
          etag: `etag-${Date.now()}`,
          bindings: newPolicy.bindings ?? [],
        };
        const hasDeleterRole = this.iamPolicy.bindings.some(
          (b) =>
            b.role === "roles/resourcemanager.projectDeleter" &&
            b.members.includes("serviceAccount:ompctl-deployer@ompctl.iam.gserviceaccount.com")
        );
        if (hasDeleterRole && !this.config.grantNotEffective) {
          this.permissions.add("resourcemanager.projects.delete");
        }
      }

      return new Response(JSON.stringify(this.iamPolicy), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. GET /v1/liens?parent=projects/:projectNumber (Official Resource Manager v1 liens.list contract)
    if (method === "GET" && pathname === "/v1/liens") {
      if (this.config.failLiens) {
        return new Response(JSON.stringify(this.config.failLiens.body), {
          status: this.config.failLiens.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const parent = parsedUrl.searchParams.get("parent");
      if (!parent || parent !== `projects/${this.projectNumber}`) {
        return new Response(
          JSON.stringify({
            error: {
              code: 400,
              message: `Field 'parent' is required and must match 'projects/${this.projectNumber}'. Got: '${parent}'`,
              status: "INVALID_ARGUMENT",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      const pageToken = parsedUrl.searchParams.get("pageToken");
      const startIndex = pageToken ? parseInt(pageToken, 10) || 0 : 0;
      const pageItems = this.liens.slice(startIndex, startIndex + this.liensPageSize);
      const nextIndex = startIndex + this.liensPageSize;
      const nextPageToken = nextIndex < this.liens.length ? String(nextIndex) : undefined;

      return new Response(
        JSON.stringify({
          liens: pageItems,
          nextPageToken,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 6. DELETE /repos/jwaldrip/ompctl/pages
    if (method === "DELETE" && pathname === "/repos/jwaldrip/ompctl/pages") {
      if (this.config.failPagesDelete) {
        return new Response(JSON.stringify(this.config.failPagesDelete.body), {
          status: this.config.failPagesDelete.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      this.pagesPublished = false;
      return new Response(null, { status: 204 });
    }

    // 7. GET /repos/jwaldrip/ompctl/pages
    if (method === "GET" && pathname === "/repos/jwaldrip/ompctl/pages") {
      if (this.config.failPagesGet) {
        return new Response(JSON.stringify(this.config.failPagesGet.body), {
          status: this.config.failPagesGet.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!this.pagesPublished) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          url: "https://ompctl.ai/",
          status: "built",
          cname: "ompctl.ai",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 8. GET /repos/jwaldrip/ompctl/actions/runs
    if (method === "GET" && pathname === "/repos/jwaldrip/ompctl/actions/runs") {
      if (this.config.failRunsGet) {
        return new Response(JSON.stringify(this.config.failRunsGet.body), {
          status: this.config.failRunsGet.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      const statusFilter = parsedUrl.searchParams.get("status");
      let matchedRuns = this.workflowRuns;
      if (statusFilter) {
        matchedRuns = matchedRuns.filter((r) => r.status === statusFilter);
      }

      return new Response(
        JSON.stringify({
          total_count: matchedRuns.length,
          workflow_runs: matchedRuns,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 9. GET /repos/jwaldrip/ompctl/actions/runs/:runId
    const runMatch = pathname.match(/^\/repos\/jwaldrip\/ompctl\/actions\/runs\/(\d+)$/);
    if (method === "GET" && runMatch) {
      const runId = parseInt(runMatch[1], 10);
      const run = this.workflowRuns.find((r) => r.id === runId);
      if (!run) {
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(run), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 10. DELETE /v1/projects/:projectId
    if (method === "DELETE" && pathname === `/v1/projects/${this.projectId}`) {
      if (this.config.failProjectDelete) {
        return new Response(JSON.stringify(this.config.failProjectDelete.body), {
          status: this.config.failProjectDelete.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      this.lifecycleState = "DELETE_REQUESTED";
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({ error: `Not found on mirror: ${method} ${pathname}` }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }
}
