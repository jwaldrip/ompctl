/**
 * The Git providers service (GitHub and GitLab).
 *
 * Implements:
 * 1. RFC 8628 OAuth 2.0 Device Authorization Grant for phone-friendly login
 *    without redirect URLs, universal links, or local loopback servers.
 * 2. Repository browsing with pagination and filtering for accounts with
 *    many repositories.
 * 3. Token provisioning for authenticated git clones without exposing
 *    credentials in URLs, command-line arguments, or client frames.
 */

import { join } from "node:path";
import type { SecretVault, VaultBackend } from "../mcpauth/types.ts";
import { openVault } from "../mcpauth/vault.ts";
import { ProviderStore } from "./store.ts";
import {
  type DeviceCodeResponse,
  type DevicePollResponse,
  type GitProvider,
  type ProviderConnectionStatus,
  type ProviderGrantRecord,
  ProviderRefusal,
  type ProviderRepo,
  type ProviderReposRequest,
  type ProviderReposResult,
  type ProviderStatusMap,
} from "./types.ts";

export interface ProvidersServiceOptions {
  home: string;
  vault?: SecretVault;
  vaultBackend?: VaultBackend;
  store?: ProviderStore;
  fetchImpl?: typeof fetch;
  githubBaseUrl?: string;
  githubApiUrl?: string;
  gitlabBaseUrl?: string;
  githubClientId?: string;
  gitlabClientId?: string;
  onLog?: (line: string) => void;
}

const DEFAULT_GITHUB_CLIENT_ID = "Iv1.802871b6354446b7";
const DEFAULT_GITLAB_CLIENT_ID = "ompctl_daemon";

export class ProvidersService {
  readonly #store: ProviderStore;
  readonly #fetchImpl: typeof fetch;
  readonly #githubBaseUrl: string;
  readonly #githubApiUrl: string;
  readonly #gitlabBaseUrl: string;
  readonly #githubClientId: string;
  readonly #gitlabClientId: string;
  readonly #onLog: (line: string) => void;

  constructor(opts: ProvidersServiceOptions) {
    this.#fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.#githubBaseUrl = opts.githubBaseUrl ?? "https://github.com";
    this.#githubApiUrl = opts.githubApiUrl ?? (opts.githubBaseUrl ? opts.githubBaseUrl : "https://api.github.com");
    this.#gitlabBaseUrl = opts.gitlabBaseUrl ?? "https://gitlab.com";
    this.#githubClientId = opts.githubClientId ?? process.env.OMPD_GITHUB_CLIENT_ID ?? DEFAULT_GITHUB_CLIENT_ID;
    this.#gitlabClientId = opts.gitlabClientId ?? process.env.OMPD_GITLAB_CLIENT_ID ?? DEFAULT_GITLAB_CLIENT_ID;
    this.#onLog = opts.onLog ?? (() => {});

    if (opts.store) {
      this.#store = opts.store;
    } else {
      const vault = opts.vault ?? openVault(opts.home, opts.vaultBackend ? { backend: opts.vaultBackend } : {});
      this.#store = new ProviderStore(join(opts.home, "providers.db"), vault);
    }
  }

  get store(): ProviderStore {
    return this.#store;
  }

  status(): ProviderStatusMap {
    const gh = this.#store.get("github");
    const gl = this.#store.get("gitlab");

    return {
      github: this.#toStatus(gh),
      gitlab: this.#toStatus(gl),
    };
  }

  async startDeviceAuth(provider: GitProvider): Promise<DeviceCodeResponse> {
    if (provider === "github") {
      const url = `${this.#githubBaseUrl}/login/device/code`;
      const res = await this.#fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.#githubClientId,
          scope: "repo",
        }).toString(),
      });

      if (!res.ok) {
        throw new ProviderRefusal("auth_failed", `GitHub device code request failed: ${res.status}`);
      }

      const body = (await res.json()) as {
        device_code?: string;
        user_code?: string;
        verification_uri?: string;
        expires_in?: number;
        interval?: number;
      };

      if (!body.device_code || !body.user_code || !body.verification_uri) {
        throw new ProviderRefusal("auth_failed", "GitHub returned malformed device code response");
      }

      return {
        provider: "github",
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri,
        expiresIn: body.expires_in ?? 900,
        interval: body.interval ?? 5,
      };
    }

    const url = `${this.#gitlabBaseUrl}/oauth/authorize_device`;
    const res = await this.#fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.#gitlabClientId,
        scope: "read_api read_repository",
      }).toString(),
    });

    if (!res.ok) {
      throw new ProviderRefusal("auth_failed", `GitLab device code request failed: ${res.status}`);
    }

    const body = (await res.json()) as {
      device_code?: string;
      user_code?: string;
      verification_uri?: string;
      expires_in?: number;
      interval?: number;
    };

    if (!body.device_code || !body.user_code || !body.verification_uri) {
      throw new ProviderRefusal("auth_failed", "GitLab returned malformed device code response");
    }

    return {
      provider: "gitlab",
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUri: body.verification_uri,
      expiresIn: body.expires_in ?? 300,
      interval: body.interval ?? 5,
    };
  }

  async pollDeviceAuth(provider: GitProvider, deviceCode: string): Promise<DevicePollResponse> {
    if (provider === "github") {
      const url = `${this.#githubBaseUrl}/login/oauth/access_token`;
      const res = await this.#fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: this.#githubClientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
      });

      const body = (await res.json()) as {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };

      if (body.error) {
        if (body.error === "authorization_pending") return { provider: "github", status: "pending" };
        if (body.error === "slow_down") return { provider: "github", status: "slow_down" };
        if (body.error === "expired_token") {
          return { provider: "github", status: "expired", error: body.error_description ?? "Device code expired" };
        }
        if (body.error === "access_denied") {
          return { provider: "github", status: "denied", error: body.error_description ?? "Access denied by user" };
        }
        return { provider: "github", status: "denied", error: body.error_description ?? body.error };
      }

      if (!body.access_token) {
        return { provider: "github", status: "pending" };
      }

      const userRes = await this.#fetchImpl(`${this.#githubApiUrl}/user`, {
        headers: {
          Authorization: `Bearer ${body.access_token}`,
          Accept: "application/json",
          "User-Agent": "ompctl-daemon",
        },
      });

      let username = "github-user";
      if (userRes.ok) {
        const user = (await userRes.json()) as { login?: string };
        if (user.login) username = user.login;
      }

      this.#store.save({
        provider: "github",
        username,
        scopes: body.scope ?? "repo",
        secrets: { accessToken: body.access_token },
      });

      return { provider: "github", status: "authorized", username };
    }

    const url = `${this.#gitlabBaseUrl}/oauth/token`;
    const res = await this.#fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: this.#gitlabClientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
    });

    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };

    if (body.error) {
      if (body.error === "authorization_pending") return { provider: "gitlab", status: "pending" };
      if (body.error === "slow_down") return { provider: "gitlab", status: "slow_down" };
      if (body.error === "expired_token") {
        return { provider: "gitlab", status: "expired", error: body.error_description ?? "Device code expired" };
      }
      if (body.error === "access_denied") {
        return { provider: "gitlab", status: "denied", error: body.error_description ?? "Access denied by user" };
      }
      return { provider: "gitlab", status: "denied", error: body.error_description ?? body.error };
    }

    if (!body.access_token) {
      return { provider: "gitlab", status: "pending" };
    }

    const userRes = await this.#fetchImpl(`${this.#gitlabBaseUrl}/api/v4/user`, {
      headers: {
        Authorization: `Bearer ${body.access_token}`,
        Accept: "application/json",
      },
    });

    let username = "gitlab-user";
    if (userRes.ok) {
      const user = (await userRes.json()) as { username?: string };
      if (user.username) username = user.username;
    }

    this.#store.save({
      provider: "gitlab",
      username,
      scopes: body.scope ?? "read_api read_repository",
      expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
      secrets: {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
      },
    });

    return { provider: "gitlab", status: "authorized", username };
  }

  async listRepos(req: ProviderReposRequest): Promise<ProviderReposResult> {
    const grant = this.#store.load(req.provider);
    if (!grant) {
      throw new ProviderRefusal("not_connected", `${req.provider} is not connected`);
    }

    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
      throw new ProviderRefusal(
        "credential_expired",
        `${req.provider} credential has expired; re-authorization required`,
      );
    }

    const page = req.page ?? 1;
    const perPage = req.perPage ?? 30;

    if (req.provider === "github") {
      const params = new URLSearchParams({
        sort: "updated",
        direction: "desc",
        page: String(page),
        per_page: String(perPage),
        affiliation: "owner,collaborator,organization_member",
      });
      if (req.query) {
        params.set("query", req.query);
      }

      const res = await this.#fetchImpl(`${this.#githubApiUrl}/user/repos?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${grant.secrets.accessToken}`,
          Accept: "application/json",
          "User-Agent": "ompctl-daemon",
        },
      });

      if (res.status === 401) {
        throw new ProviderRefusal("credential_expired", "GitHub credential has expired; re-authorization required");
      }
      if (!res.ok) {
        throw new ProviderRefusal("api_error", `GitHub API error: ${res.status}`);
      }

      const raw = (await res.json()) as Array<{
        id: number | string;
        name: string;
        full_name?: string;
        owner?: { login?: string };
        description?: string | null;
        default_branch?: string;
        private?: boolean;
        pushed_at?: string | null;
        clone_url?: string;
        ssh_url?: string;
      }>;

      let repos: ProviderRepo[] = raw.map(item => ({
        id: String(item.id),
        name: item.name,
        owner: item.owner?.login ?? "",
        fullName: item.full_name ?? `${item.owner?.login ?? ""}/${item.name}`,
        description: item.description ?? null,
        defaultBranch: item.default_branch ?? "main",
        isPrivate: Boolean(item.private),
        lastPushedAt: item.pushed_at ?? null,
        cloneUrl: item.clone_url ?? `https://github.com/${item.full_name ?? item.name}.git`,
        sshUrl: item.ssh_url,
      }));

      if (req.query && req.query.trim().length > 0) {
        const q = req.query.trim().toLowerCase();
        repos = repos.filter(
          r =>
            r.name.toLowerCase().includes(q) ||
            r.fullName.toLowerCase().includes(q) ||
            (r.description?.toLowerCase().includes(q) ?? false),
        );
      }

      const linkHeader = res.headers.get("Link") ?? "";
      const hasMore = linkHeader.includes('rel="next"') || repos.length >= perPage;

      return {
        provider: "github",
        page,
        hasMore,
        repos,
      };
    }

    // GitLab
    const params = new URLSearchParams({
      membership: "true",
      order_by: "last_activity_at",
      sort: "desc",
      page: String(page),
      per_page: String(perPage),
    });
    if (req.query) {
      params.set("search", req.query);
    }

    const res = await this.#fetchImpl(`${this.#gitlabBaseUrl}/api/v4/projects?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${grant.secrets.accessToken}`,
        Accept: "application/json",
      },
    });

    if (res.status === 401) {
      throw new ProviderRefusal("credential_expired", "GitLab credential has expired; re-authorization required");
    }
    if (!res.ok) {
      throw new ProviderRefusal("api_error", `GitLab API error: ${res.status}`);
    }

    const raw = (await res.json()) as Array<{
      id: number | string;
      name: string;
      path_with_namespace?: string;
      namespace?: { path?: string; name?: string };
      description?: string | null;
      default_branch?: string;
      visibility?: string;
      last_activity_at?: string | null;
      http_url_to_repo?: string;
      ssh_url_to_repo?: string;
    }>;

    let repos: ProviderRepo[] = raw.map(item => ({
      id: String(item.id),
      name: item.name,
      owner: item.namespace?.path ?? item.namespace?.name ?? "",
      fullName: item.path_with_namespace ?? item.name,
      description: item.description ?? null,
      defaultBranch: item.default_branch ?? "main",
      isPrivate: item.visibility === "private",
      lastPushedAt: item.last_activity_at ?? null,
      cloneUrl: item.http_url_to_repo ?? "",
      sshUrl: item.ssh_url_to_repo,
    }));

    if (req.query && req.query.trim().length > 0) {
      const q = req.query.trim().toLowerCase();
      repos = repos.filter(
        r =>
          r.name.toLowerCase().includes(q) ||
          r.fullName.toLowerCase().includes(q) ||
          (r.description?.toLowerCase().includes(q) ?? false),
      );
    }

    const linkHeader = res.headers.get("Link") ?? "";
    const hasMore = linkHeader.includes('rel="next"') || repos.length >= perPage;

    return {
      provider: "gitlab",
      page,
      hasMore,
      repos,
    };
  }

  tokenFor(provider: GitProvider): string | undefined {
    const grant = this.#store.load(provider);
    if (!grant) return undefined;
    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) return undefined;
    return grant.secrets.accessToken;
  }

  tokenForUrl(url: string): { provider: GitProvider; token: string; username: string } | undefined {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host === "github.com" || host.endsWith(".github.com")) {
        const token = this.tokenFor("github");
        if (token) return { provider: "github", token, username: "x-access-token" };
      }
      if (host === "gitlab.com" || host.endsWith(".gitlab.com")) {
        const token = this.tokenFor("gitlab");
        if (token) return { provider: "gitlab", token, username: "oauth2" };
      }
    } catch {
      // Not a standard URL, might be an SCP-style URL like git@github.com:...
      if (url.includes("github.com")) {
        const token = this.tokenFor("github");
        if (token) return { provider: "github", token, username: "x-access-token" };
      }
      if (url.includes("gitlab.com")) {
        const token = this.tokenFor("gitlab");
        if (token) return { provider: "gitlab", token, username: "oauth2" };
      }
    }
    return undefined;
  }

  disconnect(provider: GitProvider): boolean {
    return this.#store.remove(provider);
  }

  #toStatus(grant: ProviderGrantRecord | undefined): ProviderConnectionStatus {
    if (!grant) return { connected: false };
    if (grant.expiresAt !== undefined && grant.expiresAt <= Date.now()) {
      return { connected: false, username: grant.username };
    }
    return {
      connected: true,
      username: grant.username,
      scopes: grant.scopes.split(" "),
      updatedAt: grant.updatedAt,
    };
  }
}
