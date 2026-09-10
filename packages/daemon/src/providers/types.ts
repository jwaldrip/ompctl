/**
 * The contract for Git provider integrations (GitHub and GitLab).
 *
 * Provides repository listing, device-friendly authentication, and credential
 * persistence without exposing secrets to client applications or the hub.
 */

import type {
  GitProvider,
  ProviderConnectionStatus,
  ProviderRepo,
  ProviderStatusMap,
} from "../../../core/src/contracts.ts";

export type { GitProvider, ProviderConnectionStatus, ProviderRepo, ProviderStatusMap };

export type ProviderRefusalCode = "credential_expired" | "not_connected" | "api_error" | "bad_request" | "auth_failed";

export class ProviderRefusal extends Error {
  readonly code: ProviderRefusalCode;

  constructor(code: ProviderRefusalCode, message: string) {
    super(message);
    this.name = "ProviderRefusal";
    this.code = code;
  }
}

export interface ProviderGrantRecord {
  provider: GitProvider;
  username: string;
  scopes: string;
  expiresAt?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderGrantSecrets {
  accessToken: string;
  refreshToken?: string;
}

export interface LoadedProviderGrant extends ProviderGrantRecord {
  secrets: ProviderGrantSecrets;
}

export interface ProviderGrantInput {
  provider: GitProvider;
  username: string;
  scopes: string;
  expiresAt?: number;
  secrets: ProviderGrantSecrets;
}

export interface DeviceCodeResponse {
  provider: GitProvider;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DevicePollResponse {
  provider: GitProvider;
  status: "authorized" | "pending" | "slow_down" | "expired" | "denied";
  username?: string;
  error?: string;
}

export interface ProviderReposRequest {
  provider: GitProvider;
  page?: number;
  perPage?: number;
  query?: string;
}

export interface ProviderReposResult {
  provider: GitProvider;
  page: number;
  hasMore: boolean;
  repos: ProviderRepo[];
}
