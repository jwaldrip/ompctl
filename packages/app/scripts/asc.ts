#!/usr/bin/env bun
/**
 * App Store Connect API helper for TestFlight builds.
 *
 * Implements JWT ES256 authentication using WebCrypto (Bun native).
 * Embeds no secrets: reads the API key and issuer ID from environment
 * variables or standard local key locations (~/.private_keys, ~/.appstoreconnect).
 *
 * Usage:
 *   bun scripts/asc.ts builds             # list recent builds and states
 *   bun scripts/asc.ts assign <build_id>  # assign build to internal beta group
 *   bun scripts/asc.ts nonexempt <id>     # mark non-exempt encryption false
 *   bun scripts/asc.ts group                            # inspect beta group builds
 *   bun scripts/asc.ts wait-assign <number> <platform>  # wait and publish to the group
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME || "";
function requireEnv(name: "OMPD_ASC_KEY_ID" | "OMPD_APP_ID" | "OMPD_BETA_GROUP_ID"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveIssuerId(): string {
  if (process.env.OMPD_ASC_ISSUER_ID) {
    return process.env.OMPD_ASC_ISSUER_ID.trim();
  }
  const candidate = join(HOME, ".private_keys", "asc_issuer_id");
  if (existsSync(candidate)) {
    return readFileSync(candidate, "utf8").trim();
  }
  throw new Error("Missing ASC issuer ID. Set OMPD_ASC_ISSUER_ID or ~/.private_keys/asc_issuer_id");
}

function resolveKeyPath(keyId: string): string {
  if (process.env.OMPD_ASC_KEY_PATH && existsSync(process.env.OMPD_ASC_KEY_PATH)) {
    return process.env.OMPD_ASC_KEY_PATH;
  }
  const candidates = [
    join(HOME, ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`),
    join(HOME, ".private_keys", `AuthKey_${keyId}.p8`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`Missing ASC private key AuthKey_${keyId}.p8. Set OMPD_ASC_KEY_PATH or place in ~/.private_keys/`);
}

function b64url(b: Uint8Array | string): string {
  const buf = typeof b === "string" ? Buffer.from(b, "utf8") : Buffer.from(b);
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function createToken(): Promise<string> {
  const issuer = resolveIssuerId();
  const keyId = requireEnv("OMPD_ASC_KEY_ID");
  const keyPath = resolveKeyPath(keyId);
  const pem = readFileSync(keyPath, "utf8");
  const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const p = b64url(
    JSON.stringify({
      iss: issuer,
      iat: now,
      exp: now + 900,
      aud: "appstoreconnect-v1",
    }),
  );
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

interface AscHttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface AscRequestDeps {
  fetcher(url: string, init: RequestInit): Promise<AscHttpResponse>;
  token(): Promise<string>;
  sleep(ms: number): Promise<void>;
}

function retryDelayMs(response: AscHttpResponse | undefined, attempt: number): number {
  const retryAfter = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60000);
  return Math.min(1500 * 2 ** attempt, 30000);
}

export async function requestWithRetry(
  method: string,
  path: string,
  body: unknown,
  deps: AscRequestDeps,
): Promise<{ status: number; json: any }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    const token = await deps.token();
    let response: AscHttpResponse | undefined;
    try {
      response = await deps.fetcher(`https://api.appstoreconnect.apple.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const retryable = response.status === 401 || response.status === 429 || response.status >= 500;
      if (retryable && attempt < 5) {
        await deps.sleep(retryDelayMs(response, attempt));
        continue;
      }
      let json: any = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = text;
        }
      }
      return { status: response.status, json };
    } catch (error) {
      lastError = error;
      if (attempt === 5) throw error;
      await deps.sleep(retryDelayMs(response, attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ASC request failed after retries");
}

async function call(method: string, path: string, body?: unknown) {
  return requestWithRetry(method, path, body, {
    fetcher: (url, init) => fetch(url, init),
    token: createToken,
    sleep: Bun.sleep,
  });
}

export type ApplePlatform = "IOS" | "MAC_OS";

interface BuildResource {
  id: string;
  attributes: {
    version: string;
    processingState: string;
    usesNonExemptEncryption?: boolean | null;
    uploadedDate?: string;
  };
  relationships?: { preReleaseVersion?: { data?: { id?: string } } };
}

interface BuildsResponse {
  data: BuildResource[];
  included?: Array<{ id: string; attributes?: { platform?: ApplePlatform } }>;
}

export function selectBuildByPlatform(
  response: BuildsResponse,
  buildNumber: string,
  platform: ApplePlatform,
): BuildResource | undefined {
  const platforms = new Map(response.included?.map(item => [item.id, item.attributes?.platform]));
  let selected: BuildResource | undefined;
  let selectedAt = Number.NEGATIVE_INFINITY;
  for (const build of response.data) {
    const preReleaseId = build.relationships?.preReleaseVersion?.data?.id;
    if (
      build.attributes.version !== buildNumber ||
      preReleaseId === undefined ||
      platforms.get(preReleaseId) !== platform
    ) {
      continue;
    }
    const uploadedAt = Date.parse(build.attributes.uploadedDate ?? "");
    const timestamp = Number.isNaN(uploadedAt) ? Number.NEGATIVE_INFINITY : uploadedAt;
    if (selected === undefined || timestamp > selectedAt) {
      selected = build;
      selectedAt = timestamp;
    }
  }
  return selected;
}

export function groupBuildPagePath(groupId: string, next: string): string {
  const url = new URL(next);
  if (
    url.origin !== "https://api.appstoreconnect.apple.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== `/v1/betaGroups/${groupId}/builds`
  ) {
    throw new Error("ASC returned an invalid tester-group pagination link");
  }
  return `${url.pathname}${url.search}`;
}

async function groupHasBuild(groupId: string, buildId: string): Promise<boolean> {
  let path: string | undefined = `/v1/betaGroups/${groupId}/builds?limit=200&fields[builds]=version,processingState`;
  while (path) {
    const res = await call("GET", path);
    if (res.status !== 200) throw new Error(`group builds returned ${res.status}: ${JSON.stringify(res.json)}`);
    if ((res.json.data as Array<{ id: string }>).some(build => build.id === buildId)) return true;
    const next = res.json.links?.next;
    path = typeof next === "string" && next !== "" ? groupBuildPagePath(groupId, next) : undefined;
  }
  return false;
}

export function assignmentResponseAccepted(status: number): boolean {
  return status === 204 || status === 409;
}

export function buildStateCanProgress(state: string | undefined): boolean {
  return state === undefined || state === "PROCESSING" || state === "VALID";
}

async function ensureAssigned(buildId: string): Promise<void> {
  const groupId = requireEnv("OMPD_BETA_GROUP_ID");
  const waitMs = Number(process.env.OMPD_ASC_ASSIGN_WAIT_MS ?? "300000");
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error("OMPD_ASC_ASSIGN_WAIT_MS must be a positive number");
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    if (await groupHasBuild(groupId, buildId)) return;
    const res = await call("POST", `/v1/betaGroups/${groupId}/relationships/builds`, {
      data: [{ type: "builds", id: buildId }],
    });
    if (!assignmentResponseAccepted(res.status)) {
      throw new Error(`assign returned ${res.status}: ${JSON.stringify(res.json)}`);
    }
    await Bun.sleep(5000);
  }
  throw new Error(`build ${buildId} was not visible in tester group after assignment`);
}

async function lookupBuild(buildNumber: string, platform: ApplePlatform): Promise<BuildResource | undefined> {
  const appId = requireEnv("OMPD_APP_ID");
  const res = await call(
    "GET",
    `/v1/builds?filter[app]=${appId}&filter[version]=${buildNumber}&sort=-uploadedDate&limit=20&include=preReleaseVersion&fields[builds]=version,processingState,usesNonExemptEncryption,uploadedDate,preReleaseVersion&fields[preReleaseVersions]=platform,version`,
  );
  if (res.status !== 200) throw new Error(`build lookup returned ${res.status}: ${JSON.stringify(res.json)}`);
  return selectBuildByPlatform(res.json as BuildsResponse, buildNumber, platform);
}

async function waitForBuildAndAssign(buildNumber: string, platform: ApplePlatform): Promise<void> {
  const waitMs = Number(process.env.OMPD_ASC_BUILD_WAIT_MS ?? "3600000");
  if (!Number.isFinite(waitMs) || waitMs <= 0) throw new Error("OMPD_ASC_BUILD_WAIT_MS must be a positive number");
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const build = await lookupBuild(buildNumber, platform);
    const state = build?.attributes.processingState;
    if (!buildStateCanProgress(state)) {
      throw new Error(`build ${buildNumber} for ${platform} ended in ${state}`);
    }
    if (build?.attributes.processingState === "VALID") {
      if (build.attributes.usesNonExemptEncryption !== false) {
        const patched = await call("PATCH", `/v1/builds/${build.id}`, {
          data: { type: "builds", id: build.id, attributes: { usesNonExemptEncryption: false } },
        });
        if (patched.status !== 200) {
          throw new Error(`nonexempt returned ${patched.status}: ${JSON.stringify(patched.json)}`);
        }
      }
      await ensureAssigned(build.id);
      console.log(`ready_assigned build=${buildNumber} platform=${platform} id=${build.id}`);
      return;
    }
    console.log(
      `waiting build=${buildNumber} platform=${platform} state=${build?.attributes.processingState ?? "missing"}`,
    );
    await Bun.sleep(15000);
  }
  throw new Error(`timed out waiting for build ${buildNumber} on ${platform}`);
}

async function main(): Promise<void> {
  const [cmd, arg, platformArg] = process.argv.slice(2);
  if (!cmd || cmd === "--help" || cmd === "help") {
    console.log("Usage: bun scripts/asc.ts <builds|assign|group|nonexempt|find-build|wait-assign> [args]");
    return;
  }

  if (cmd === "builds") {
    const appId = requireEnv("OMPD_APP_ID");
    const res = await call(
      "GET",
      `/v1/builds?filter[app]=${appId}&sort=-uploadedDate&limit=5&fields[builds]=version,processingState,usesNonExemptEncryption,uploadedDate,expired`,
    );
    if (res.status !== 200) throw new Error(`builds returned ${res.status}: ${JSON.stringify(res.json)}`);
    for (const b of res.json.data) {
      console.log(
        `${b.id} build=${b.attributes.version} state=${b.attributes.processingState} nonexempt=${b.attributes.usesNonExemptEncryption} uploaded=${b.attributes.uploadedDate}`,
      );
    }
  } else if (cmd === "assign") {
    if (!arg) throw new Error("Missing build ID for assign");
    await ensureAssigned(arg);
    console.log("assign 204");
  } else if (cmd === "nonexempt") {
    if (!arg) throw new Error("Missing build ID for nonexempt");
    const res = await call("PATCH", `/v1/builds/${arg}`, {
      data: { type: "builds", id: arg, attributes: { usesNonExemptEncryption: false } },
    });
    console.log(`nonexempt ${res.status}`);
    if (res.status !== 200) throw new Error(`nonexempt returned ${res.status}`);
  } else if (cmd === "group") {
    const groupId = requireEnv("OMPD_BETA_GROUP_ID");
    const res = await call("GET", `/v1/betaGroups/${groupId}/builds?limit=5&fields[builds]=version,processingState`);
    if (res.status !== 200) throw new Error(`group returned ${res.status}: ${JSON.stringify(res.json)}`);
    const list = res.json.data.map(
      (b: { id: string; attributes: { version: string; processingState: string } }) =>
        `${b.id} build=${b.attributes.version} ${b.attributes.processingState}`,
    );
    console.log(res.status, JSON.stringify(list));
  } else if (cmd === "find-build") {
    if (!arg) throw new Error("Missing build number for find-build");
    if (platformArg !== "IOS" && platformArg !== "MAC_OS") {
      throw new Error("find-build platform must be IOS or MAC_OS");
    }
    const build = await lookupBuild(arg, platformArg);
    if (build) {
      console.log(
        `build_present build=${arg} platform=${platformArg} id=${build.id} state=${build.attributes.processingState}`,
      );
    } else {
      console.log(`build_missing build=${arg} platform=${platformArg}`);
      process.exitCode = 3;
    }
  } else if (cmd === "wait-assign") {
    if (!arg) throw new Error("Missing build number for wait-assign");
    if (platformArg !== "IOS" && platformArg !== "MAC_OS") {
      throw new Error("wait-assign platform must be IOS or MAC_OS");
    }
    await waitForBuildAndAssign(arg, platformArg);
  } else {
    throw new Error(`Unknown command: ${cmd}`);
  }
}

if (import.meta.main) await main();
